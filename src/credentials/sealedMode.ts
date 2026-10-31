// Opt-in sealed credential flow: resolve the helper, hand it the rendered
// config and keys, and report the result on the next startup. Plaintext stays
// the default; nothing here runs unless the user invokes the command or turns
// the setting on.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { catalogStore } from '../catalog/store';
import {
  providerIdForConfigGroup,
  providerToSealedConfig,
  readConfig,
  userConfigPath,
  writeConfig,
  type ConfigFile,
  type ConfigGroup,
} from '../config';
import { isSealableProviderId, sealedApiKeyPlaceholder, sealedSecretId } from '../groupMatch';
import { Logger } from '../utils/logger';
import { checkSealedPreflight, type SealedPreflight } from './preflight';

export const HELPER_RESULT_FILENAME = 'copilot-provider-bridge-sealed-result.json';
const HELPER_ASSET = 'credential-helper-win32-x64.exe';
const HELPER_RELEASE_URL =
  'https://github.com/thejjw/copilot-provider-bridge/releases/latest/download/' + HELPER_ASSET;
/** SHA-256 of the release asset built from `helper/` (cargo build --release). */
export const PINNED_HELPER_SHA256 =
  'ab60ff4b321bd51dfe289101a9d925f7904816965199c6d13fc8c2012991750c';

const CONFIG_NAMESPACE = 'copilotProviderBridge';

interface ApplyPayload {
  op: 'apply';
  userDir: string;
  config: string;
  configSha256: string;
  secrets: Record<string, string>;
  relaunch?: boolean;
}

interface DeletePayload {
  op: 'delete';
  userDir: string;
  ids: string[];
}

export interface SealedHelperResult {
  ok: boolean;
  op: string;
  error?: string;
  updated?: string[];
  removed?: string[];
  relaunched?: boolean;
}

/** Live editor values for the pure preflight gate. */
export function currentSealedPreflight(): SealedPreflight {
  return checkSealedPreflight({
    platform: process.platform,
    arch: process.arch,
    remoteName: vscode.env.remoteName,
    appRoot: vscode.env.appRoot,
  });
}

/** True when the user opted into sealed credentials. */
export function isSealedCredentialStorage(): boolean {
  return (
    vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<string>('credentialStorage', 'plaintext') ===
    'sealed'
  );
}

/** Absolute path of the helper's result file for the default profile. */
export function helperResultPath(): string {
  return path.join(path.dirname(userConfigPath()), 'globalStorage', HELPER_RESULT_FILENAME);
}

/** Convert an existing plaintext group to the sealed shape, preserving its models. */
export function sealExistingGroup(group: ConfigGroup, providerId: string, key: string): ConfigGroup {
  return {
    ...group,
    apiKey: sealedApiKeyPlaceholder(providerId),
    models: group.models.map((model) => {
      if (!model.requestHeaders) return model;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(model.requestHeaders)) {
        headers[name] = key ? value.split(key).join('${apiKey}') : value;
      }
      return { ...model, requestHeaders: headers };
    }),
  };
}

/** Replace matching groups and append the rest, preserving unrelated groups. */
export function mergeSealedGroups(cfg: ConfigFile, groups: ConfigGroup[]): ConfigFile {
  const next = [...cfg];
  for (const group of groups) {
    const id = providerIdForConfigGroup(group);
    const index = id ? next.findIndex((candidate) => providerIdForConfigGroup(candidate) === id) : -1;
    if (index >= 0) next[index] = group;
    else next.push(group);
  }
  return next;
}

/** Render the sealed file and hand it to the helper after an acknowledgement. */
export async function applySealedUpdate(
  context: vscode.ExtensionContext,
  cfg: ConfigFile,
  groups: ConfigGroup[],
  secrets: Record<string, string>,
  relaunch = false
): Promise<void> {
  const preflight = currentSealedPreflight();
  if (!preflight.ok) throw new Error(preflight.reason);

  const next = mergeSealedGroups(cfg, groups);
  await ensureConfigFile();
  const currentText = await fs.readFile(userConfigPath(), 'utf8');
  const configText = JSON.stringify(next, null, 2) + '\n';
  const helperPath = await resolveHelper(context);

  await launchHelper(helperPath, {
    op: 'apply',
    userDir: path.dirname(userConfigPath()),
    config: configText,
    configSha256: createHash('sha256').update(currentText, 'utf8').digest('hex'),
    secrets,
    relaunch,
  });
  Logger.info(`Sealed credential helper accepted ${groups.length} provider group(s); waiting for editor exit.`);
}

/** Build sealed groups for every catalog provider that has an extension secret. */
export async function collectSealableProviders(
  context: vscode.ExtensionContext
): Promise<{ groups: ConfigGroup[]; secrets: Record<string, string>; skipped: string[] }> {
  const cfg = await readConfig();
  const groups: ConfigGroup[] = [];
  const secrets: Record<string, string> = {};
  const skipped: string[] = [];

  for (const provider of catalogStore.get().providers) {
    const key = await context.secrets.get(`copilot-provider-bridge.${provider.id}.apiKey`);
    if (!key) {
      skipped.push(provider.name);
      continue;
    }
    if (!isSealableProviderId(provider.id)) {
      skipped.push(provider.name);
      continue;
    }
    secrets[provider.id] = key;
    const index = cfg.findIndex((group) => providerIdForConfigGroup(group) === provider.id);
    groups.push(
      index >= 0
        ? sealExistingGroup(cfg[index], provider.id, key)
        : providerToSealedConfig(provider, provider.models)
    );
  }
  return { groups, secrets, skipped };
}

/** Read and consume the helper outcome from the previous session. */
export async function reportSealedCredentialResult(context: vscode.ExtensionContext): Promise<void> {
  let result: SealedHelperResult;
  try {
    const raw = await fs.readFile(helperResultPath(), 'utf8');
    result = JSON.parse(raw) as SealedHelperResult;
  } catch {
    return;
  }
  await fs.unlink(helperResultPath()).catch(() => undefined);

  if (result.op !== 'apply') return;
  if (result.ok) {
    await vscode.workspace
      .getConfiguration(CONFIG_NAMESPACE)
      .update('credentialStorage', 'sealed', vscode.ConfigurationTarget.Global);
    const count = result.updated?.length ?? 0;
    void vscode.window.showInformationMessage(
      `Copilot Provider Bridge: sealed ${count} API key${count === 1 ? '' : 's'} into VS Code's encrypted storage.`
    );
  } else {
    void vscode.window.showWarningMessage(
      `Copilot Provider Bridge: sealing failed. Keys remain in chatLanguageModels.json. ${result.error ?? ''}`.trim()
    );
  }
}

/** Queue deletion of sealed rows; the helper waits for the editor to exit. */
export async function queueSealedSecretDeletion(
  context: vscode.ExtensionContext,
  providerIds: string[]
): Promise<void> {
  if (!isSealedCredentialStorage() || providerIds.length === 0) return;
  const ids = providerIds.filter(isSealableProviderId).map(sealedSecretId);
  if (ids.length === 0) return;
  try {
    const helperPath = await resolveHelper(context);
    await launchHelper(helperPath, { op: 'delete', userDir: path.dirname(userConfigPath()), ids });
  } catch (err) {
    Logger.warn('Could not queue sealed credential deletion', err);
  }
}

async function ensureConfigFile(): Promise<void> {
  try {
    await fs.access(userConfigPath());
  } catch {
    await writeConfig([]);
  }
}

async function resolveHelper(context: vscode.ExtensionContext): Promise<string> {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configuredPath = (config.get<string>('credentialHelper.path', '') ?? '').trim();
  const configuredSha = (config.get<string>('credentialHelper.sha256', '') ?? '').trim().toLowerCase();
  if (configuredPath) {
    if (!configuredSha) {
      throw new Error(
        'Set copilotProviderBridge.credentialHelper.sha256 when using a custom helper path.'
      );
    }
    await verifyFileHash(configuredPath, configuredSha);
    return configuredPath;
  }

  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, HELPER_ASSET);
  try {
    await verifyFileHash(target, PINNED_HELPER_SHA256);
    return target;
  } catch {
    // Missing or stale download: fetch the pinned release asset.
  }

  const response = await fetch(HELPER_RELEASE_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Could not download the credential helper (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256Buffer(bytes);
  if (actual !== PINNED_HELPER_SHA256) {
    throw new Error('Downloaded credential helper failed the SHA-256 check.');
  }
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, target);
  await fs.unlink(`${target}:Zone.Identifier`).catch(() => undefined);
  return target;
}

async function verifyFileHash(file: string, expected: string): Promise<void> {
  const bytes = await fs.readFile(file);
  const actual = sha256Buffer(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${file}.`);
  }
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Spawn detached, wait for the acknowledgement line, then release the child. */
function launchHelper(helperPath: string, payload: ApplyPayload | DeletePayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error('The credential helper did not acknowledge the request.'));
    }, 15_000);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      cleanup();
      try {
        const ack = JSON.parse(line) as { ok?: boolean; error?: string };
        if (ack.ok) {
          child.unref();
          resolve();
        } else {
          reject(new Error(ack.error ?? 'The credential helper rejected the request.'));
        }
      } catch {
        reject(new Error('The credential helper returned an unreadable acknowledgement.'));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`The credential helper exited before acknowledging (code ${code ?? 'unknown'}).`));
    };

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
    child.stdin.end(JSON.stringify(payload) + '\n');
  });
}
