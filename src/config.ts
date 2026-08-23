// Read/write chatLanguageModels.json. Lives at <user-data-dir>/User/chatLanguageModels.json
// for user-scoped BYOK (the location Custom Endpoint writes to without a GitHub sign-in).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EXTENSION_MARKER, type Provider, type ProviderId, type ProviderModel } from './providers';
import { Logger } from './utils/logger';
import { catalogStore } from './catalog/store';

/** A single model entry inside a provider's `models` array. */
export interface ConfigModel {
  id: string;
  name: string;
  url: string;
  apiType: 'messages' | 'chat-completions';
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: 'messages' | 'chat-completions' | 'responses';
  /** Model-level custom headers (e.g. Authorization: Bearer <key>). */
  requestHeaders?: Record<string, string>;
}

/** A provider group entry at the top of the chatLanguageModels.json array. */
export interface ConfigGroup {
  name: string;
  vendor: 'customendpoint';
  apiType: 'messages' | 'chat-completions';
  apiKey: string; // Real key or `${input:<name>}` placeholder
  models: ConfigModel[];
}

/** Top-level shape of chatLanguageModels.json. */
export type ConfigFile = ConfigGroup[];

// Marker we use to recognize groups we wrote. Defined in providers.ts (pure module);
// re-exported here for the existing config-layer consumers.
export { EXTENSION_MARKER };
// Path helpers moved to utils/userPaths.ts (shared with the catalog store).
import { userConfigPath } from './utils/userPaths';
export { userConfigPath };

/** Read the current config file safely. Strips UTF-8 BOM, returns [] if absent or empty, rethrows syntax errors. */
export async function readConfig(): Promise<ConfigFile> {
  const file = userConfigPath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const clean = raw.replace(/^\uFEFF/, '').trim();
    if (!clean) return [];
    const parsed = JSON.parse(clean) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    Logger.error(`Failed to parse ${file}: ${(err as Error).message}`);
    throw err;
  }
}

/** Atomically write the config file. Creates parent dir if missing. */
export async function writeConfig(cfg: ConfigFile): Promise<void> {
  const file = userConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/** Build a ConfigModel entry for one provider model. */
export function modelToConfig(p: Provider, m: ProviderModel, apiKey?: string): ConfigModel {
  const model: ConfigModel = {
    id: m.id,
    name: m.name,
    url: m.url ?? p.endpointUrl,
    apiType: m.apiType ?? p.apiType,
    toolCalling: m.toolCalling,
    vision: m.vision,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
  };
  if (m.thinking !== undefined) {
    model.thinking = m.thinking;
  }
  if (m.supportsReasoningEffort && m.supportsReasoningEffort.length > 0) {
    model.supportsReasoningEffort = m.supportsReasoningEffort;
  }
  if (m.reasoningEffortFormat) {
    model.reasoningEffortFormat = m.reasoningEffortFormat;
  }
  const rawHeaders = m.requestHeaders ?? p.requestHeaders;
  if (rawHeaders && Object.keys(rawHeaders).length > 0) {
    const headers: Record<string, string> = { ...rawHeaders };
    if (apiKey) {
      for (const k of Object.keys(headers)) {
        headers[k] = headers[k].replace('${apiKey}', apiKey);
      }
    }
    model.requestHeaders = headers;
  }
  return model;
}

/** Build a full ConfigGroup for one provider. */
export function providerToConfig(p: Provider, models: ProviderModel[], apiKey?: string): ConfigGroup {
  return {
    name: p.name,
    vendor: 'customendpoint',
    apiType: p.apiType,
    apiKey: apiKey ?? `\${input:${p.secretInput}}`,
    models: models.map((m) => modelToConfig(p, m, apiKey)),
  };
}

/** Find the index of the group we previously wrote for `providerId`, or -1. */
export function findGroupIndex(cfg: ConfigFile, providerId: ProviderId): number {
  return cfg.findIndex(
    (g) =>
      g.apiKey.includes(`${EXTENSION_MARKER}${providerId}.`) ||
      catalogStore.get().providers.some((p) => p.id === providerId && g.name === p.name)
  );
}

/** Returns true if any group in the file was written by this extension. */
export function hasAnyBridgeGroup(cfg: ConfigFile): boolean {
  return cfg.some((g) => g.apiKey.includes(EXTENSION_MARKER) || catalogStore.get().providers.some((p) => g.name === p.name));
}
