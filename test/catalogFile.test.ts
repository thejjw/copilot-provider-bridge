// Unit tests for the pure catalog-file layer: JSONC parsing, validation,
// derivation, section semantics, and template round-tripping. Runs in plain
// node via vitest (no vscode import anywhere in catalogFile.ts).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CATALOG_FILE_NAME,
  catalogPathFor,
  readCatalogFile,
  serializeCatalogTemplate,
} from '../src/catalog/catalogFile';

const FALLBACK_PROVIDER_IDS = ['zai', 'deepseek', 'kimi'];

const MINIMAL_PROVIDER = {
  id: 'zai',
  name: 'Z.ai GLM Coding Plan',
  endpointUrl: 'https://api.z.ai/api/anthropic/v1/messages',
  apiType: 'messages',
  models: [
    {
      id: 'glm-5.3',
      name: 'GLM 5.3 (1M)',
      toolCalling: true,
      vision: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
  ],
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpb-catalog-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeCatalog(dir: string, contents: string): Promise<string> {
  const file = catalogPathFor(dir);
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

describe('catalogPathFor', () => {
  it('joins the user settings dir with the fixed file name', () => {
    expect(catalogPathFor('C:\\Users\\x\\Code\\User')).toBe(path.join('C:\\Users\\x\\Code\\User', CATALOG_FILE_NAME));
  });
});

describe('absent handling', () => {
  it('returns absent when the file does not exist', async () => {
    await withTempDir(async (dir) => {
      expect(await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS)).toEqual({ status: 'absent' });
    });
  });

  it('treats a BOM-prefixed empty file as absent', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, '\uFEFF\n');
      expect(await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS)).toEqual({ status: 'absent' });
    });
  });
});

describe('syntax errors', () => {
  it('reports JSONC syntax errors with line and column', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, '{\n  "providers": [\n    { oops }\n  ]\n}');
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].path).toMatch(/line 3, column \d+/);
        expect(result.errors[0].message).toContain('JSON syntax error');
      }
    });
  });
});

describe('providers validation and derivation', () => {
  it('accepts a minimal provider with comments and trailing commas, deriving defaults', async () => {
    await withTempDir(async (dir) => {
      const providerJson = JSON.stringify(MINIMAL_PROVIDER, null, 2)
        .split('\n')
        .join('\n    ');
      await writeCatalog(
        dir,
        `{
  // Bridge catalog - minimal valid customization.
  "$version": 1,
  "providers": [
    ${providerJson},
  ],
}`
      );
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const p = result.sections.providers![0];
      expect(p.secretInput).toBe('copilot-provider-bridge.zai.apiKey');
      expect(p.requestHeaders).toEqual({ Authorization: 'Bearer ${apiKey}' });
      expect(p.models[0].maxInputTokens).toBe(1_000_000 - 131_072);
      expect(result.sections.visionBackends).toBeUndefined();
      expect(result.sections.mcpPresets).toBeUndefined();
    });
  });

  it('rejects an explicit maxInputTokens that contradicts the invariant', async () => {
    await withTempDir(async (dir) => {
      const provider = structuredClone(MINIMAL_PROVIDER) as typeof MINIMAL_PROVIDER & { models: Array<Record<string, unknown>> };
      provider.models[0].maxInputTokens = 42;
      await writeCatalog(dir, JSON.stringify({ $version: 1, providers: [provider] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.errors.some((e) => e.path.endsWith('.maxInputTokens') && /contradicts/.test(e.message))).toBe(true);
      }
    });
  });

  it('rejects duplicate provider ids and duplicate model ids within a provider', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, JSON.stringify({ $version: 1, providers: [MINIMAL_PROVIDER, { ...MINIMAL_PROVIDER, name: 'Other' }] }));
      let result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.errors.some((e) => /duplicate provider id/.test(e.message))).toBe(true);

      const dupModel = structuredClone(MINIMAL_PROVIDER);
      dupModel.models.push({ ...dupModel.models[0], name: 'Clone' });
      await writeCatalog(dir, JSON.stringify({ $version: 1, providers: [dupModel] }));
      result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.errors.some((e) => /duplicate model id/.test(e.message))).toBe(true);
    });
  });

  it('rejects provider ids outside [A-Za-z0-9_-]', async () => {
    await withTempDir(async (dir) => {
      const provider = structuredClone(MINIMAL_PROVIDER) as typeof MINIMAL_PROVIDER & { id: string };
      provider.id = 'my provider!';
      await writeCatalog(dir, JSON.stringify({ $version: 1, providers: [provider] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.errors.some((e) => e.path.endsWith('.id') && /letters, digits/.test(e.message))).toBe(true);
    });
  });

  it('rejects an empty providers section', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, serializeCatalogTemplate({ providers: [], visionBackends: [], mcpPresets: [] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.errors.some((e) => e.path === 'providers')).toBe(true);
    });
  });
});

describe('cross-section checks', () => {
  const backend = {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    description: 'Vision',
    model: 'glm-4.6v',
    endpointUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    providerId: 'zai',
    apiType: 'openai',
  };

  it('accepts backends referencing bundled providers when no providers section exists', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, JSON.stringify({ $version: 1, visionBackends: [backend] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.sections.visionBackends).toHaveLength(1);
    });
  });

  it('rejects backends referencing providers removed by an overriding providers section', async () => {
    await withTempDir(async (dir) => {
      const custom = structuredClone(MINIMAL_PROVIDER) as typeof MINIMAL_PROVIDER & { id: string };
      custom.id = 'my-proxy';
      await writeCatalog(dir, JSON.stringify({ $version: 1, providers: [custom], visionBackends: [backend] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.errors.some((e) => e.path.includes('visionBackends[0].providerId'))).toBe(true);
      }
    });
  });
});

describe('version and unknown keys', () => {
  it('warns but loads on unrecognized $version and ignores unknown top-level keys', async () => {
    await withTempDir(async (dir) => {
      await writeCatalog(dir, JSON.stringify({ $version: 99, futureThing: 1, providers: [MINIMAL_PROVIDER] }));
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.warnings.some((w) => w.includes('$version'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('futureThing'))).toBe(true);
      }
    });
  });
});

describe('template round-trip', () => {
  const sections = {
    providers: [
      {
        id: 'kimi',
        name: 'Kimi Code Plan',
        description: 'Kimi coding plan',
        endpointUrl: 'https://api.kimi.com/coding/v1/messages',
        requestHeaders: { Authorization: 'Bearer ${apiKey}' },
        apiType: 'messages',
        secretInput: 'copilot-provider-bridge.kimi.apiKey',
        models: [
          {
            id: 'k3',
            name: 'Kimi K3 (1M Vision)',
            toolCalling: true,
            vision: true,
            contextWindow: 1_048_576,
            maxOutputTokens: 131_072,
            maxInputTokens: 917_504,
            thinking: true,
            supportsReasoningEffort: ['low', 'high', 'max'],
            reasoningEffortFormat: 'messages',
          },
        ],
      },
    ],
    visionBackends: [
      {
        id: 'k3-vision',
        name: 'Kimi K3 Vision',
        providerId: 'kimi',
        description: 'Multimodal',
        model: 'k3',
        endpointUrl: 'https://api.kimi.com/coding/v1/messages',
        apiType: 'anthropic',
      },
    ],
    mcpPresets: [
      {
        id: 'web-search-prime',
        name: 'Web Search Prime',
        description: 'Z.ai web search MCP',
        providerId: 'kimi',
        serverKey: 'webSearchPrime',
        inputs: [{ type: 'promptString', id: 'copilot-provider-bridge.zai.apiKey', description: 'Z.ai API Key', password: true }],
        server: { type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp' },
      },
    ],
  };

  it('produces a commented file that validates to exactly the sections it was built from', async () => {
    await withTempDir(async (dir) => {
      const template = serializeCatalogTemplate(sections);
      expect(template.startsWith('// Copilot Provider Bridge')).toBe(true);

      await writeCatalog(dir, template);
      const result = await readCatalogFile(catalogPathFor(dir), []);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const actual = JSON.parse(JSON.stringify(result.sections));
      const expected = JSON.parse(JSON.stringify(sections));
      expect(actual.providers).toEqual(expected.providers);
      expect(actual.visionBackends).toEqual(expected.visionBackends);
      expect(actual.mcpPresets).toEqual(expected.mcpPresets);
    });
  });

  it('keeps a stdio preset without url and an http preset without command valid, including empty inputs', async () => {
    await withTempDir(async (dir) => {
      const template = serializeCatalogTemplate({
        providers: [MINIMAL_PROVIDER],
        visionBackends: [],
        mcpPresets: [
          {
            id: 'stdio-tool',
            name: 'Stdio Tool',
            description: 'stdio server preset',
            providerId: 'zai',
            serverKey: 'stdioTool',
            inputs: [],
            server: { type: 'stdio', command: 'npx', args: ['-y', '@z_ai/mcp-server'] },
          },
          {
            id: 'http-tool',
            name: 'HTTP Tool',
            description: 'http server preset',
            providerId: 'zai',
            serverKey: 'httpTool',
            inputs: [{ type: 'promptString', id: 'copilot-provider-bridge.zai.apiKey', description: 'Z.ai API Key', password: true }],
            server: { type: 'http', url: 'https://api.z.ai/api/mcp/web_search_prime/mcp' },
          },
        ],
      });
      await writeCatalog(dir, template);
      const result = await readCatalogFile(catalogPathFor(dir), FALLBACK_PROVIDER_IDS);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.sections.mcpPresets).toHaveLength(2);
    });
  });
});
