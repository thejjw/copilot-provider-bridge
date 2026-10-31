// Unit tests for the legacy mcp.json cleanup and preset resolution.
// Uses temp files (never the real user profile) and plain node via vitest:
// mcpLegacy.ts and mcpCatalog.ts deliberately avoid importing vscode.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { cleanupLegacyMcpFile } from '../src/mcpLegacy';
import { MCP_PRESETS, resolvePresetServer, type McpPreset } from '../src/mcpCatalog';

const WEB_SEARCH_URL = 'https://api.z.ai/api/mcp/web_search_prime/mcp';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpb-mcp-legacy-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeJsonc(dir: string, contents: string): Promise<string> {
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

const BRIDGE_FILE = `{
  // bridge-authored entry plus unrelated configuration
  "servers": {
    "webSearchPrime": {
      "type": "http",
      "url": "${WEB_SEARCH_URL}",
      "headers": { "Authorization": "Bearer \${input:zai-api-key}" }
    },
    "myOwnServer": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  },
  "inputs": [
    { "type": "promptString", "id": "zai-api-key", "description": "Z.ai", "password": true },
    { "type": "promptString", "id": "custom-token", "description": "Custom", "password": true }
  ]
}
`;

describe('cleanupLegacyMcpFile', () => {
  it('removes a matching bridge server and its now-unused input only', async () => {
    await withTempDir(async (dir) => {
      const file = await writeJsonc(dir, BRIDGE_FILE);
      const result = await cleanupLegacyMcpFile(file, MCP_PRESETS);

      expect(result.changed).toBe(true);
      expect(result.removedPresetIds).toEqual(['web-search-prime']);

      // The file keeps its comment, so read it back as JSONC.
      const after = parse(await fs.readFile(file, 'utf8')) as {
        servers: Record<string, unknown>;
        inputs?: { id: string }[];
      };
      expect(after.servers.webSearchPrime).toBeUndefined();
      expect(after.servers.myOwnServer).toBeDefined();
      expect(after.inputs?.map((i) => i.id)).toEqual(['custom-token']);
    });
  });

  it('preserves JSONC comments and a leading BOM', async () => {
    await withTempDir(async (dir) => {
      const file = await writeJsonc(dir, '\uFEFF' + BRIDGE_FILE);
      await cleanupLegacyMcpFile(file, MCP_PRESETS);

      const text = await fs.readFile(file, 'utf8');
      expect(text.startsWith('\uFEFF')).toBe(true);
      expect(text).toContain('// bridge-authored entry plus unrelated configuration');
      expect(text).not.toContain('webSearchPrime');
    });
  });

  it('keeps a customized entry when requireMatch is true and removes it when false', async () => {
    const customized = `{
  "servers": {
    "webSearchPrime": { "type": "http", "url": "https://self-hosted.example/mcp" }
  }
}
`;
    await withTempDir(async (dir) => {
      const strict = await writeJsonc(dir, customized);
      const kept = await cleanupLegacyMcpFile(strict, MCP_PRESETS, { requireMatch: true });
      expect(kept.changed).toBe(false);
      expect(kept.removedPresetIds).toEqual([]);
      expect(JSON.parse(await fs.readFile(strict, 'utf8')).servers.webSearchPrime).toBeDefined();

      const loose = await writeJsonc(dir, customized);
      const removed = await cleanupLegacyMcpFile(loose, MCP_PRESETS, { requireMatch: false });
      expect(removed.changed).toBe(true);
      expect(removed.removedPresetIds).toEqual(['web-search-prime']);
      expect(JSON.parse(await fs.readFile(loose, 'utf8')).servers.webSearchPrime).toBeUndefined();
    });
  });

  it('treats an empty or whitespace-only file as no change', async () => {
    await withTempDir(async (dir) => {
      const file = await writeJsonc(dir, '  \n\t\n');
      expect(await cleanupLegacyMcpFile(file, MCP_PRESETS)).toEqual({ removedPresetIds: [], changed: false });
    });
  });

  it('reports no change for a missing file', async () => {
    await withTempDir(async (dir) => {
      const result = await cleanupLegacyMcpFile(path.join(dir, 'absent.json'), MCP_PRESETS);
      expect(result).toEqual({ removedPresetIds: [], changed: false });
    });
  });
});

describe('resolvePresetServer', () => {
  it('substitutes HTTP headers and stdio env from the input map', () => {
    const http = resolvePresetServer(MCP_PRESETS[0], { 'zai-api-key': 'zai-secret' });
    expect(http).toEqual({
      kind: 'http',
      url: WEB_SEARCH_URL,
      headers: { Authorization: 'Bearer zai-secret' },
    });

    const minimax = MCP_PRESETS.find((p) => p.id === 'minimax-mcp');
    expect(minimax).toBeDefined();
    const stdio = resolvePresetServer(minimax as McpPreset, { 'minimax-api-key': 'mm-secret' });
    expect(stdio).toEqual({
      kind: 'stdio',
      command: 'uvx',
      args: ['--with', 'mcp<2.0.0', 'minimax-coding-plan-mcp', '-y'],
      env: { MINIMAX_API_KEY: 'mm-secret', MINIMAX_API_HOST: 'https://api.minimax.io' },
    });
  });

  it('gives each declared input its own value', () => {
    const twoInputs: McpPreset = {
      id: 'two-inputs',
      name: 'Two Inputs',
      description: 'custom preset declaring two inputs',
      providerId: 'zai',
      serverKey: 'twoInputs',
      inputs: [
        { type: 'promptString', id: 'first-key', description: 'First', password: true },
        { type: 'promptString', id: 'second-key', description: 'Second', password: true },
      ],
      server: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-First': '${input:first-key}', 'X-Second': '${input:second-key}' },
      },
    };

    expect(resolvePresetServer(twoInputs, { 'first-key': 'a', 'second-key': 'b' })).toEqual({
      kind: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-First': 'a', 'X-Second': 'b' },
    });
  });

  it('substitutes stdio args and reports ids that appear only there', () => {
    const argsPreset: McpPreset = {
      id: 'args-input',
      name: 'Args Input',
      description: 'stdio preset whose placeholder lives in args',
      providerId: 'zai',
      serverKey: 'argsInput',
      inputs: [{ type: 'promptString', id: 'args-key', description: 'Args', password: true }],
      server: { type: 'stdio', command: 'node', args: ['--key', '${input:args-key}'], env: {} },
    };

    expect(resolvePresetServer(argsPreset, { 'args-key': 'abc' })).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['--key', 'abc'],
      env: {},
    });
    expect(() => resolvePresetServer(argsPreset, {})).toThrow(/args-key/);
  });

  it('throws listing the unresolved input id', () => {
    expect(() => resolvePresetServer(MCP_PRESETS[0], {})).toThrow(/zai-api-key/);
  });
});
