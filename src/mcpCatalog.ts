// Catalog of verified MCP server presets grouped by coding-plan provider.
// Supports both HTTP SSE servers (Z.ai Web Search, Web Reader, zread)
// and stdio servers (Z.ai MCP Server, MiniMax MCP).

import type { ProviderId } from './providers';

export interface McpInputDefinition {
  type: 'promptString';
  id: string;
  description: string;
  password: true;
}

export interface McpServerDefinition {
  type: 'http' | 'stdio' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  providerId: ProviderId;
  serverKey: string;
  inputs: McpInputDefinition[];
  server: McpServerDefinition;
}

export const MCP_INPUT_ZAI: McpInputDefinition = {
  type: 'promptString',
  id: 'zai-api-key',
  description: 'Z.ai API Key for MCP tools',
  password: true,
};

export const MCP_INPUT_MINIMAX: McpInputDefinition = {
  type: 'promptString',
  id: 'minimax-api-key',
  description: 'MiniMax API Key for MCP tools',
  password: true,
};

/** All verified MCP server presets, explicitly associated with their provider. */
export const MCP_PRESETS: McpPreset[] = [
  // --- Z.ai Group ---
  {
    id: 'web-search-prime',
    name: 'Z.ai Web Search Prime',
    description: 'Real-time web search capability via Z.ai HTTP MCP.',
    providerId: 'zai',
    serverKey: 'webSearchPrime',
    inputs: [MCP_INPUT_ZAI],
    server: {
      type: 'http',
      url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
      headers: {
        Authorization: 'Bearer ${input:zai-api-key}',
      },
    },
  },
  {
    id: 'web-reader',
    name: 'Z.ai Web Reader',
    description: 'Convert web URLs into markdown/text via Z.ai HTTP MCP.',
    providerId: 'zai',
    serverKey: 'webReader',
    inputs: [MCP_INPUT_ZAI],
    server: {
      type: 'http',
      url: 'https://api.z.ai/api/mcp/web_reader/mcp',
      headers: {
        Authorization: 'Bearer ${input:zai-api-key}',
      },
    },
  },
  {
    id: 'zread',
    name: 'Z.ai zread (GitHub Doc/Repo Search)',
    description: 'Search documentation, issues, and code repositories via Z.ai HTTP MCP.',
    providerId: 'zai',
    serverKey: 'zread',
    inputs: [MCP_INPUT_ZAI],
    server: {
      type: 'http',
      url: 'https://api.z.ai/api/mcp/zread/mcp',
      headers: {
        Authorization: 'Bearer ${input:zai-api-key}',
      },
    },
  },
  {
    id: 'zai-mcp-server',
    name: 'Z.ai MCP Server (Vision & Image OCR)',
    description: 'Image analysis, diagram understanding, and text extraction via stdio npm package @z_ai/mcp-server.',
    providerId: 'zai',
    serverKey: 'zaiMcpServer',
    inputs: [MCP_INPUT_ZAI],
    server: {
      type: 'stdio',
      command: process.platform === 'win32' ? 'cmd.exe' : 'npx',
      args: process.platform === 'win32'
        ? ['/c', 'npx', '-y', '@z_ai/mcp-server']
        : ['-y', '@z_ai/mcp-server'],
      env: {
        Z_AI_API_KEY: '${input:zai-api-key}',
        Z_AI_MODE: 'ZAI',
      },
    },
  },

  // --- MiniMax Group ---
  {
    id: 'minimax-mcp',
    name: 'MiniMax Coding Plan MCP',
    description: 'MiniMax web search and image understanding via stdio uvx minimax-coding-plan-mcp.',
    providerId: 'minimax',
    serverKey: 'minimaxMcp',
    inputs: [MCP_INPUT_MINIMAX],
    server: {
      type: 'stdio',
      command: 'uvx',
      args: ['--with', 'mcp<2.0.0', 'minimax-coding-plan-mcp', '-y'],
      env: {
        MINIMAX_API_KEY: '${input:minimax-api-key}',
        MINIMAX_API_HOST: 'https://api.minimax.io',
      },
    },
  },
];

/** Get all companion MCP presets available for a given provider. */
export function getMcpPresetsForProvider(providerId: ProviderId): McpPreset[] {
  return MCP_PRESETS.filter((p) => p.providerId === providerId);
}

/** A preset server definition with every `${input:...}` placeholder replaced by a concrete value. */
export type ResolvedMcpServer =
  | { kind: 'http'; url: string; headers: Record<string, string> }
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> };

const INPUT_PLACEHOLDER = /\$\{input:([^}]+)\}/g;

/** Replace every `${input:<id>}` in `value`, recording ids that have no supplied value. */
function substituteInputs(value: string, values: Record<string, string>, unresolved: Set<string>): string {
  return value.replace(INPUT_PLACEHOLDER, (_match, id: string) => {
    const supplied = values[id];
    if (supplied === undefined) {
      unresolved.add(id);
      return '';
    }
    return supplied;
  });
}

/**
 * Resolve a preset into a concrete server definition by substituting the values
 * captured for its declared inputs. Throws when the preset is structurally
 * invalid or an input id has no supplied value.
 */
export function resolvePresetServer(preset: McpPreset, values: Record<string, string>): ResolvedMcpServer {
  const server = preset.server;
  const unresolved = new Set<string>();

  if (server.type === 'http' || server.type === 'sse') {
    if (!server.url) throw new Error(`MCP preset "${preset.id}" is type ${server.type} but has no url.`);
    const headers: Record<string, string> = {};
    for (const [name, template] of Object.entries(server.headers ?? {})) {
      headers[name] = substituteInputs(template, values, unresolved);
    }
    if (unresolved.size > 0) {
      throw new Error(`MCP preset "${preset.id}" references unresolved input(s): ${[...unresolved].join(', ')}`);
    }
    return { kind: 'http', url: server.url, headers };
  }

  if (!server.command) throw new Error(`MCP preset "${preset.id}" is type stdio but has no command.`);
  const env: Record<string, string> = {};
  for (const [name, template] of Object.entries(server.env ?? {})) {
    env[name] = substituteInputs(template, values, unresolved);
  }
  if (unresolved.size > 0) {
    throw new Error(`MCP preset "${preset.id}" references unresolved input(s): ${[...unresolved].join(', ')}`);
  }
  return {
    kind: 'stdio',
    command: server.command,
    args: (server.args ?? []).map((arg) => substituteInputs(arg, values, unresolved)),
    env,
  };
}

/** Normalize the transport name: VS Code treats `sse` as an HTTP-family transport. */
function transportOf(type: unknown): string | undefined {
  if (type === 'sse') return 'http';
  return typeof type === 'string' ? type : undefined;
}

/**
 * Whether a raw `mcp.json` server entry has the same transport shape as a preset.
 * Headers and env are ignored so credentials customized in the file still match.
 */
export function matchesPresetServer(raw: unknown, preset: McpPreset): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const entry = raw as Record<string, unknown>;
  const presetType = transportOf(preset.server.type);
  if (transportOf(entry.type) !== presetType) return false;

  if (presetType === 'http') {
    return typeof entry.url === 'string' && entry.url === preset.server.url;
  }
  if (presetType === 'stdio') {
    if (entry.command !== preset.server.command) return false;
    const rawArgs = Array.isArray(entry.args) ? entry.args : [];
    const presetArgs = preset.server.args ?? [];
    return rawArgs.length === presetArgs.length && rawArgs.every((a, i) => a === presetArgs[i]);
  }
  return false;
}

/** Deduplicate preset ids while keeping first-seen order. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Compute the next installed-preset id list. `replace` uses the selection as the
 * whole set (an empty selection clears everything); `merge` unions old and new.
 */
export function computeNextPresetIds(
  installed: readonly string[],
  selected: readonly string[],
  mode: 'replace' | 'merge'
): string[] {
  return mode === 'replace' ? dedupe(selected) : dedupe([...installed, ...selected]);
}
