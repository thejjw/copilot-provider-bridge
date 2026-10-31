// Extension-managed MCP server registration.
//
// The bridge presets are resolved at runtime from SecretStorage (or the
// `<PROVIDER>_API_KEY` environment fallback) and handed to VS Code through
// `lm.registerMcpServerDefinitionProvider`. No `mcp.json` writes and no
// `${input:...}` prompts, so the same servers are available in Copilot chat and
// in agent-host sessions (which exclude interactive-input servers).

import * as vscode from 'vscode';
import { catalogStore } from './catalog/store';
import { computeNextPresetIds, resolvePresetServer, type McpPreset } from './mcpCatalog';
import { cleanupLegacyMcpFile } from './mcpLegacy';
import { EXTENSION_MARKER } from './providers';
import { Logger } from './utils/logger';
import { userMcpConfigPath, workspaceMcpConfigPaths } from './utils/userPaths';

/** Contribution id; must match `contributes.mcpServerDefinitionProviders[0].id`. */
export const MCP_PROVIDER_ID = 'copilot-provider-bridge-mcp';

/** globalState key holding the ids of presets the user installed. */
export const MCP_PRESET_IDS_STATE_KEY = 'copilotProviderBridge.mcpPresetIds';

/** globalState flag marking the one-time legacy `mcp.json` migration as complete. */
export const MCP_MIGRATION_STATE_KEY = 'copilotProviderBridge.mcpPresetMigration';

/** Definition version reported to VS Code; bump to force a tool refresh. */
const DEFINITION_VERSION = '1';

/** SecretStorage key holding a provider's API key. */
export function secretKeyForProvider(providerId: string): string {
  return `${EXTENSION_MARKER}${providerId}.apiKey`;
}

/** Provider API key from SecretStorage, falling back to `<PROVIDER>_API_KEY` in the environment. */
export async function providerKeyFor(
  context: vscode.ExtensionContext,
  providerId: string
): Promise<string | undefined> {
  return (await context.secrets.get(secretKeyForProvider(providerId))) ?? process.env[`${providerId.toUpperCase()}_API_KEY`];
}

/** Whether a preset cannot be resolved without an API key. */
export function presetNeedsKey(preset: McpPreset): boolean {
  return preset.inputs.length > 0 || JSON.stringify(preset.server).includes('${input:');
}

/** Installed preset ids, filtered to the current catalog and returned in catalog order. */
export function getInstalledPresetIds(context: vscode.ExtensionContext): string[] {
  const stored = context.globalState.get<unknown>(MCP_PRESET_IDS_STATE_KEY);
  if (!Array.isArray(stored)) return [];
  const installed = new Set(stored.filter((id): id is string => typeof id === 'string'));
  return catalogStore
    .get()
    .mcpPresets.filter((preset) => installed.has(preset.id))
    .map((preset) => preset.id);
}

/** Persist the installed preset set, dropping ids the current catalog no longer defines. */
export async function setInstalledPresetIds(context: vscode.ExtensionContext, ids: readonly string[]): Promise<string[]> {
  const known = new Set(catalogStore.get().mcpPresets.map((preset) => preset.id));
  const filtered = [...new Set(ids)].filter((id) => known.has(id));
  await context.globalState.update(MCP_PRESET_IDS_STATE_KEY, filtered);
  return filtered;
}

/** Providers already warned about in this session, so a missing key logs once. */
const warnedProviders = new Set<string>();

/** Build the concrete MCP server definitions for every installed preset. */
export async function buildMcpServerDefinitions(
  context: vscode.ExtensionContext,
  token?: vscode.CancellationToken
): Promise<vscode.McpServerDefinition[]> {
  const catalog = new Map(catalogStore.get().mcpPresets.map((preset) => [preset.id, preset]));
  const definitions: vscode.McpServerDefinition[] = [];

  for (const id of getInstalledPresetIds(context)) {
    if (token?.isCancellationRequested) break;
    const preset = catalog.get(id);
    if (!preset) continue;

    const key = await providerKeyFor(context, preset.providerId);
    if (presetNeedsKey(preset) && !key) {
      if (!warnedProviders.has(preset.providerId)) {
        warnedProviders.add(preset.providerId);
        Logger.warn(
          `MCP preset "${preset.name}" needs an API key for provider "${preset.providerId}"; run Configure MCP Tools to add it.`
        );
      }
      continue;
    }

    try {
      const values = Object.fromEntries(preset.inputs.map((input) => [input.id, key ?? '']));
      const resolved = resolvePresetServer(preset, values);
      if (resolved.kind === 'http') {
        definitions.push(
          new vscode.McpHttpServerDefinition(
            preset.name,
            vscode.Uri.parse(resolved.url),
            resolved.headers,
            DEFINITION_VERSION
          )
        );
      } else {
        definitions.push(
          new vscode.McpStdioServerDefinition(
            preset.name,
            resolved.command,
            resolved.args,
            resolved.env,
            DEFINITION_VERSION
          )
        );
      }
    } catch (err) {
      Logger.warn(`Skipping MCP preset "${preset.name}": ${(err as Error).message}`);
    }
  }
  return definitions;
}

/** Provider that owns the extension-managed MCP server set. */
class BridgeMcpServerProvider implements vscode.McpServerDefinitionProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Fires when installed presets, provider keys, or the catalog change. */
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  /** Called eagerly by VS Code; must not prompt the user. */
  provideMcpServerDefinitions(token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    return buildMcpServerDefinitions(this.context, token);
  }

  /** Signal VS Code that the definition set changed. */
  refresh(): void {
    this.emitter.fire();
  }

  /** Release the change event. */
  dispose(): void {
    this.emitter.dispose();
  }
}

let activeProvider: BridgeMcpServerProvider | undefined;

/** Register the bridge MCP server definition provider and keep it in sync with state. */
export function registerBridgeMcpServerProvider(context: vscode.ExtensionContext): vscode.Disposable {
  const provider = new BridgeMcpServerProvider(context);
  activeProvider = provider;

  const registration = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider);
  const catalogSub = catalogStore.onDidChange(() => provider.refresh());
  const secretsSub = context.secrets.onDidChange((e) => {
    if (e.key.startsWith(EXTENSION_MARKER)) provider.refresh();
  });

  return new vscode.Disposable(() => {
    if (activeProvider === provider) activeProvider = undefined;
    secretsSub.dispose();
    catalogSub.dispose();
    registration.dispose();
    provider.dispose();
  });
}

/** Ask VS Code to re-query the provider. */
export function refreshBridgeMcpServers(): void {
  activeProvider?.refresh();
}

/**
 * One-time migration: remove bridge-authored entries from the legacy `mcp.json`
 * files and adopt them as extension-managed presets. The completion flag is only
 * written when every file succeeded, so a transient failure retries next activation.
 */
export async function migrateLegacyMcpServers(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(MCP_MIGRATION_STATE_KEY)) return;

  const presets = catalogStore.get().mcpPresets;
  const migrated = new Set<string>(getInstalledPresetIds(context));
  const failures: string[] = [];

  for (const filePath of [userMcpConfigPath(), ...workspaceMcpConfigPaths()]) {
    try {
      const result = await cleanupLegacyMcpFile(filePath, presets, { requireMatch: true });
      for (const id of result.removedPresetIds) migrated.add(id);
      if (result.changed) Logger.info(`Migrated legacy MCP entries from ${filePath}`);
    } catch (err) {
      failures.push(filePath);
      Logger.warn(`Could not migrate MCP file ${filePath}`, err);
    }
  }

  const added = migrated.size - getInstalledPresetIds(context).length;
  if (added > 0) {
    const next = computeNextPresetIds(getInstalledPresetIds(context), [...migrated], 'merge');
    await setInstalledPresetIds(context, next);
    refreshBridgeMcpServers();
    void vscode.window
      .showInformationMessage(
        `Migrated ${added} legacy MCP server(s) to extension-managed registration.`,
        'Configure MCP Tools'
      )
      .then((action) => {
        if (action === 'Configure MCP Tools') {
          void vscode.commands.executeCommand('copilot-provider-bridge.configureMcp');
        }
      });
  }

  if (failures.length === 0) {
    await context.globalState.update(MCP_MIGRATION_STATE_KEY, true);
  }
}
