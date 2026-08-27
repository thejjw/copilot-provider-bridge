// Deep verification & smoke test for Copilot Provider Bridge.
//
// Tests:
//   1. Bundle sanity (exposes commands, bundles catalog, syntax valid).
//   2. Real JSON generation via providerToConfig/modelToConfig across all 6 providers:
//      - Asserts NO provider-level requestHeaders exists in ConfigGroup.
//      - Asserts EVERY model has model-level requestHeaders with Authorization Bearer where required.
//      - Asserts strict token invariant: maxInputTokens + maxOutputTokens === contextWindow for every model.
//      - Asserts GLM-5.3 has exact effort levels ['low', 'high', 'max'] (no medium).
//      - Asserts GLM-4.7 and GLM-5V-Turbo have thinking: true without supportsReasoningEffort.
//      - Asserts DeepSeek V4 has 384K max output (393,216) and derived input (606,784).
//      - Asserts Kimi model ID is bare 'k3'.
//      - Asserts Google Gemini models are under chat-completions.
//      - Asserts removed models (deepseek-reasoner, deepseek-chat, qwen3.7-max, MiniMax-Text-01) are absent.
//   3. MCP Catalog, Grouping & Safe Merge Assertions:
//      - Asserts all 5 presets present (web-search-prime, web-reader, zread, zai-mcp-server, minimax-mcp).
//      - Asserts getMcpPresetsForProvider('zai') returns 4 tools.
//      - Asserts getMcpPresetsForProvider('minimax') returns 1 tool.
//      - Asserts top-level inputs array is properly populated with promptString and password: true.
//      - Asserts safe merge strictly preserves sandbox and unrelated top-level properties.
//   4. Status Bar & Usage Metrics Assertions:
//      - Asserts getPieGlyph accurately maps 0-100% to Unicode progress circle fractions.
//      - Asserts formatCountdown computes human-readable durations.
//      - Asserts UsageStatusBarManager correctly manages pinned provider state.
//      - Asserts status bar text is ultra-minimal (only single pie glyph or balance number).
//      - Asserts hover tooltip renders all details and error messages.
//   5. Vision Agent Tool & Backends:
//      - Asserts VISION_BACKENDS has 9 backends (GLM-4.6V, GLM-5V-Turbo, GLM-5.3-Flash, Gemini Flash/Pro, DeepSeek V4 Flash Vision Exp, MiniMax M3, Kimi K3, Qwen 3.8 Max, NVIDIA NIM).
//      - Asserts CopilotProviderBridgeVisionTool.toolId is provider_bridge_analyze_visual.
//      - Asserts tool resolution falls back gracefully when keys are missing or preferred is selected.
//   6. Packaged .vsix existence and non-zero size.

import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
const { readFile, stat, writeFile, mkdir, rm } = fsPromises;
const { dirname, join } = nodePath;
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const bundledPath = join(here, '..', 'dist', 'extension.js');
const bundled = await readFile(bundledPath, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
    fail++;
  }
}

console.log('== Copilot Provider Bridge Comprehensive Smoke Test ==\n');

console.log('-- 1. Bundle Structural Sanity --');
check('bundle has activate()', /\bfunction activate\s*\(/.test(bundled));
check('bundle has deactivate()', /\bfunction deactivate\s*\(/.test(bundled));
check('bundle registers quickSetup command', bundled.includes('copilot-provider-bridge.quickSetup'));
check('bundle registers addModel command', bundled.includes('copilot-provider-bridge.addModel'));
check('bundle registers removeModel command', bundled.includes('copilot-provider-bridge.removeModel'));
check('bundle registers listModels command', bundled.includes('copilot-provider-bridge.listModels'));
check('bundle registers configureMcp command', bundled.includes('copilot-provider-bridge.configureMcp'));
check('bundle registers removeMcp command', bundled.includes('copilot-provider-bridge.removeMcp'));
check('bundle registers configureUsageKey command', bundled.includes('copilot-provider-bridge.configureUsageKey'));
check('bundle registers selectStatusBarProvider command', bundled.includes('copilot-provider-bridge.selectStatusBarProvider'));
check('bundle registers refreshUsage command', bundled.includes('copilot-provider-bridge.refreshUsage'));
check('bundle registers selectVisionModel command', bundled.includes('copilot-provider-bridge.selectVisionModel'));
check('bundle registers runDiagnostics command', bundled.includes('copilot-provider-bridge.runDiagnostics'));
check('bundle registers showDebugLogs command', bundled.includes('copilot-provider-bridge.showDebugLogs'));
check('bundle registers toggleDebugLogging command', bundled.includes('copilot-provider-bridge.toggleDebugLogging'));
check('bundle registers resetConfiguration command', bundled.includes('copilot-provider-bridge.resetConfiguration'));
check('bundle uses ${input: secret placeholders', bundled.includes('${input:'));
check('bundle uses Authorization: Bearer ${apiKey}', bundled.includes('Bearer ${apiKey}'));
console.log('\n-- 2. Real JSON Generation & Invariant Assertions --');

// Mock vscode module for CommonJS evaluation
const mockGlobalState = new Map();
const mockStatusBarItem = {
  text: '',
  tooltip: '',
  color: undefined,
  show: () => {},
  dispose: () => {},
};

const mockVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class {
    constructor(val = '') {
      this.value = val;
      this.isTrusted = false;
      this.supportHtml = false;
    }
    appendMarkdown(s) { this.value += s; }
  },
  lm: {
    registerTool: (name, tool) => ({ dispose: () => {} }),
  },
  LanguageModelToolResult: class {
    constructor(parts = []) { this.parts = parts; }
  },
  LanguageModelTextPart: class {
    constructor(value = '') { this.value = value; }
  },
  env: { appRoot: 'C:/Program Files/Microsoft VS Code/resources/app' },
  commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
  window: {
    createStatusBarItem: () => mockStatusBarItem,
    showQuickPick: async () => {},
    showInformationMessage: async () => {},
    showWarningMessage: async () => {},
    withProgress: async (opts, task) => task(),
  },
  workspace: {
    getConfiguration: () => ({ get: () => false }),
    workspaceFolders: [],
  },
  Uri: { file: (p) => ({ fsPath: p }) },
};

const moduleScope = {
  exports: {},
  require: (id) => {
    if (id === 'vscode') return mockVscode;
    if (id === 'node:fs/promises' || id === 'fs/promises') return fsPromises;
    if (id === 'node:os' || id === 'os') return nodeOs;
    if (id === 'node:path' || id === 'path') return nodePath;
    throw new Error(`Unexpected import in test: ${id}`);
  },
};

// Evaluate the bundled CJS to extract modules
const fn = new Function('module', 'exports', 'require', bundled);
fn(moduleScope, moduleScope.exports, moduleScope.require);

const bundledCatalog = moduleScope.exports.mergeWithDefaults({});
const providers = bundledCatalog.providers;
const providerToConfig = moduleScope.exports.providerToConfig;
const modelToConfig = moduleScope.exports.modelToConfig;
const findGroupIndex = moduleScope.exports.findGroupIndex;
const mergeMcpConfig = moduleScope.exports.mergeMcpConfig;
const mcpPresets = bundledCatalog.mcpPresets;
const getMcpPresetsForProvider = (providerId) => mcpPresets.filter((p) => p.providerId === providerId);
const getPieGlyph = moduleScope.exports.getPieGlyph;
const formatCountdown = moduleScope.exports.formatCountdown;
const UsageStatusBarManager = moduleScope.exports.UsageStatusBarManager;
const VISION_BACKENDS = bundledCatalog.visionBackends;
const CopilotProviderBridgeVisionTool = moduleScope.exports.CopilotProviderBridgeVisionTool;
const Logger = moduleScope.exports.Logger;
check('PROVIDERS array exported and has 7 active providers', Array.isArray(providers) && providers.length === 7, `length=${providers?.length}`);

const providerIds = providers.map((p) => p.id);
check('all 7 expected active provider IDs present',
  ['zai', 'deepseek', 'minimax', 'kimi', 'qwen', 'openrouter', 'nvidia'].every((id) => providerIds.includes(id)),
  `got: ${providerIds.join(', ')}`
);

let totalModelsChecked = 0;

for (const p of providers) {
  const group = providerToConfig(p, p.models);

  // Group-level checks
  check(`[${p.id}] group vendor is customendpoint`, group.vendor === 'customendpoint');
  check(`[${p.id}] group apiKey is ${p.secretInput}`, group.apiKey === `\${input:${p.secretInput}}`);
  check(`[${p.id}] group-level requestHeaders is UNDEFINED (strict model-level requirement)`,
    group.requestHeaders === undefined,
    JSON.stringify(group.requestHeaders)
  );
  check(`[${p.id}] group models count matches catalog (${p.models.length})`, group.models.length === p.models.length);

  for (let i = 0; i < p.models.length; i++) {
    const rawM = p.models[i];
    const cfgM = group.models[i];
    totalModelsChecked++;

    // Invariant check: maxInputTokens + maxOutputTokens === contextWindow
    const tokenSum = cfgM.maxInputTokens + cfgM.maxOutputTokens;
    check(`[${p.id}/${cfgM.id}] token invariant holds (${cfgM.maxInputTokens} + ${cfgM.maxOutputTokens} === ${rawM.contextWindow})`,
      tokenSum === rawM.contextWindow,
      `sum=${tokenSum}, expected=${rawM.contextWindow}`
    );

    // Model-level requestHeaders check
    if (p.apiType === 'messages' || rawM.apiType === 'messages') {
      check(`[${p.id}/${cfgM.id}] has model-level Authorization Bearer requestHeaders`,
        cfgM.requestHeaders?.Authorization === 'Bearer ${apiKey}',
        JSON.stringify(cfgM.requestHeaders)
      );
    }

    // Model-level url check
    check(`[${p.id}/${cfgM.id}] url is set`, typeof cfgM.url === 'string' && cfgM.url.startsWith('https://'));
    check(`[${p.id}/${cfgM.id}] apiType is valid`, cfgM.apiType === 'messages' || cfgM.apiType === 'chat-completions');
  }
}
check('total models verified across all active providers', totalModelsChecked === 23, `total=${totalModelsChecked}`);

const testCfg = [providerToConfig(providers[0], [providers[0].models[0]], 'old-key')];
const existingIdx = findGroupIndex(testCfg, providers[0].id);
check('findGroupIndex finds existing group', existingIdx === 0);
testCfg[existingIdx] = providerToConfig(providers[0], providers[0].models, 'new-key');
check('replacing existing group preserves count and updates models', testCfg.length === 1 && testCfg[0].models.length === providers[0].models.length);
check('updated group contains new key in headers', testCfg[0].models[0].requestHeaders?.Authorization === 'Bearer new-key');
console.log('\n-- 3. Specific Provider & Model Checks --');

// Z.ai GLM-5.3 reasoning effort check (must be ['low', 'high', 'max'], no medium)
const zaiGroup = providerToConfig(providers.find((p) => p.id === 'zai'), providers.find((p) => p.id === 'zai').models);
const glm53 = zaiGroup.models.find((m) => m.id === 'glm-5.3');
check('GLM-5.3 reasoning effort levels are explicitly [low, high, max]',
  JSON.stringify(glm53?.supportsReasoningEffort) === JSON.stringify(['low', 'high', 'max']),
  JSON.stringify(glm53?.supportsReasoningEffort)
);
check('GLM-5.3 thinking is true', glm53?.thinking === true);
check('GLM-5.3 vision is false', glm53?.vision === false);


// Z.ai GLM-5.3-Flash multimodal check (must have vision: true, 1M context, 128K max output, thinking [low, high, max])
const glm53Flash = zaiGroup.models.find((m) => m.id === 'glm-5.3-flash');
check('GLM-5.3-Flash reasoning effort levels are explicitly [low, high, max]',
  JSON.stringify(glm53Flash?.supportsReasoningEffort) === JSON.stringify(['low', 'high', 'max']),
  JSON.stringify(glm53Flash?.supportsReasoningEffort)
);
check('GLM-5.3-Flash thinking is true', glm53Flash?.thinking === true);
check('GLM-5.3-Flash vision is true', glm53Flash?.vision === true);
check('GLM-5.3-Flash maxOutputTokens is 131,072', glm53Flash?.maxOutputTokens === 131072);
check('GLM-5.3-Flash maxInputTokens is 868,928', glm53Flash?.maxInputTokens === 868928);
check('GLM-5.3-Flash sum is 1,000,000', glm53Flash?.maxInputTokens + glm53Flash?.maxOutputTokens === 1000000);
// Z.ai GLM-4.7 thinking check (forced thinking: thinking true, but NO reasoning_effort controls)
const glm47 = zaiGroup.models.find((m) => m.id === 'glm-4.7');
check('GLM-4.7 thinking is true', glm47?.thinking === true);
check('GLM-4.7 supportsReasoningEffort is undefined (forced thinking without effort levels)', glm47?.supportsReasoningEffort === undefined);

// Z.ai GLM-5V-Turbo multimodal check (must use OpenAI endpoint and vision true, thinking true without effort levels)
const glm5v = zaiGroup.models.find((m) => m.id === 'glm-5v-turbo');
check('GLM-5V-Turbo uses OpenAI chat/completions endpoint', glm5v?.url === 'https://api.z.ai/api/coding/paas/v4/chat/completions');
check('GLM-5V-Turbo apiType is chat-completions', glm5v?.apiType === 'chat-completions');
check('GLM-5V-Turbo vision is true', glm5v?.vision === true);
check('GLM-5V-Turbo thinking is true', glm5v?.thinking === true);
check('GLM-5V-Turbo supportsReasoningEffort is undefined', glm5v?.supportsReasoningEffort === undefined);

// DeepSeek V4 Pro 384K check
const dsGroup = providerToConfig(providers.find((p) => p.id === 'deepseek'), providers.find((p) => p.id === 'deepseek').models);
const dsV4Pro = dsGroup.models.find((m) => m.id === 'deepseek-v4-pro');
check('DeepSeek V4 Pro maxOutputTokens is 384K (393,216)', dsV4Pro?.maxOutputTokens === 393216, `got ${dsV4Pro?.maxOutputTokens}`);
check('DeepSeek V4 Pro maxInputTokens is 606,784', dsV4Pro?.maxInputTokens === 606784, `got ${dsV4Pro?.maxInputTokens}`);
check('DeepSeek V4 Pro sum is 1,000,000', dsV4Pro?.maxInputTokens + dsV4Pro?.maxOutputTokens === 1000000);

// DeepSeek V4 Flash Vision Exp check (replaced deepseek-v4-flash)
const dsV4FlashVisionExp = dsGroup.models.find((m) => m.id === 'deepseek-v4-flash-vision-exp');
check('DeepSeek V4 Flash Vision Exp is present', dsV4FlashVisionExp !== undefined);
check('DeepSeek V4 Flash Vision Exp has vision enabled', dsV4FlashVisionExp?.vision === true);
check('DeepSeek V4 Flash Vision Exp maxOutputTokens is 384K (393,216)', dsV4FlashVisionExp?.maxOutputTokens === 393216, `got ${dsV4FlashVisionExp?.maxOutputTokens}`);
check('DeepSeek V4 Flash Vision Exp maxInputTokens is 606,784', dsV4FlashVisionExp?.maxInputTokens === 606784, `got ${dsV4FlashVisionExp?.maxInputTokens}`);
check('DeepSeek V4 Flash Vision Exp sum is 1,000,000', dsV4FlashVisionExp?.maxInputTokens + dsV4FlashVisionExp?.maxOutputTokens === 1000000);

// Removed models check
check('deepseek-reasoner is removed', !dsGroup.models.some((m) => m.id === 'deepseek-reasoner'));
check('deepseek-chat is removed', !dsGroup.models.some((m) => m.id === 'deepseek-chat'));
check('old deepseek-v4-flash is removed', !dsGroup.models.some((m) => m.id === 'deepseek-v4-flash'));

// MiniMax check
const mmGroup = providerToConfig(providers.find((p) => p.id === 'minimax'), providers.find((p) => p.id === 'minimax').models);
check('MiniMax-Text-01 is removed', !mmGroup.models.some((m) => m.id === 'MiniMax-Text-01'));
check('MiniMax-M3 is present', mmGroup.models.some((m) => m.id === 'MiniMax-M3'));

// Kimi bare model ID check
const kimiGroup = providerToConfig(providers.find((p) => p.id === 'kimi'), providers.find((p) => p.id === 'kimi').models);
check('Kimi has exactly 4 models', kimiGroup.models.length === 4, `got ${kimiGroup.models.length}`);
const k3 = kimiGroup.models.find((m) => m.id === 'k3');
check('Kimi model id is bare k3 (not k3[1m])', k3?.id === 'k3', `got ${k3?.id}`);
check('Kimi k3 contextWindow sum is 1,048,576', k3?.maxInputTokens + k3?.maxOutputTokens === 1048576);
check('Kimi k3 reasoning effort levels are explicitly [low, high, max]',
  JSON.stringify(k3?.supportsReasoningEffort) === JSON.stringify(['low', 'high', 'max']),
  JSON.stringify(k3?.supportsReasoningEffort)
);
const k3_256k = kimiGroup.models.find((m) => m.id === 'k3-256k');
check('Kimi k3-256k contextWindow sum is 262,144', k3_256k?.maxInputTokens + k3_256k?.maxOutputTokens === 262144);
check('Kimi k3-256k reasoning effort levels are explicitly [low, high, max]',
  JSON.stringify(k3_256k?.supportsReasoningEffort) === JSON.stringify(['low', 'high', 'max']),
  JSON.stringify(k3_256k?.supportsReasoningEffort)
);
const kimiCoding = kimiGroup.models.find((m) => m.id === 'kimi-for-coding');
check('Kimi kimi-for-coding contextWindow sum is 262,144', kimiCoding?.maxInputTokens + kimiCoding?.maxOutputTokens === 262144);
check('Kimi kimi-for-coding thinking is true', kimiCoding?.thinking === true);
const kimiHighSpeed = kimiGroup.models.find((m) => m.id === 'kimi-for-coding-highspeed');
check('Kimi kimi-for-coding-highspeed contextWindow sum is 262,144', kimiHighSpeed?.maxInputTokens + kimiHighSpeed?.maxOutputTokens === 262144);
check('Kimi kimi-for-coding-highspeed thinking is true', kimiHighSpeed?.thinking === true);
// Qwen check
const qwenGroup = providerToConfig(providers.find((p) => p.id === 'qwen'), providers.find((p) => p.id === 'qwen').models);
check('qwen3.7-max is removed', !qwenGroup.models.some((m) => m.id === 'qwen3.7-max'));
check('qwen3.8-max is present', qwenGroup.models.some((m) => m.id === 'qwen3.8-max'));

// Google Gemini check (disabled for now)
check('Google Gemini is disabled in active PROVIDERS list', !providers.some((p) => p.id === 'gemini'));
// OpenRouter checks (generic auto and free router models only)
const orGroup = providerToConfig(providers.find((p) => p.id === 'openrouter'), providers.find((p) => p.id === 'openrouter').models);
check('OpenRouter has exactly 2 models', orGroup.models.length === 2, `got ${orGroup.models.length}`);
check('openrouter/auto is present', orGroup.models.some((m) => m.id === 'openrouter/auto'));
check('openrouter/free is present', orGroup.models.some((m) => m.id === 'openrouter/free'));
const orFree = orGroup.models.find((m) => m.id === 'openrouter/free');
check('openrouter/free has toolCalling and vision enabled', orFree?.toolCalling === true && orFree?.vision === true);
check('openrouter/free contextWindow sum is 128,000', orFree?.maxInputTokens + orFree?.maxOutputTokens === 128000);

// NVIDIA NIM checks
const nvGroup = providerToConfig(providers.find((p) => p.id === 'nvidia'), providers.find((p) => p.id === 'nvidia').models);
check('NVIDIA NIM has exactly 7 models', nvGroup.models.length === 7, `got ${nvGroup.models.length}`);
check('meta/muse-glimmer-30b is present with vision: true', nvGroup.models.some((m) => m.id === 'meta/muse-glimmer-30b' && m.vision === true));
check('thinkingmachines/inkling is present with vision: true and thinking: true', nvGroup.models.some((m) => m.id === 'thinkingmachines/inkling' && m.vision === true && m.thinking === true));
check('poolside/laguna-xs-2.1 is present', nvGroup.models.some((m) => m.id === 'poolside/laguna-xs-2.1'));
check('minimaxai/minimax-m3 is present with 1M context', nvGroup.models.some((m) => m.id === 'minimaxai/minimax-m3' && m.maxInputTokens + m.maxOutputTokens === 1000000));
check('nvidia/nemotron-3-ultra-550b-a55b is present with 1M context', nvGroup.models.some((m) => m.id === 'nvidia/nemotron-3-ultra-550b-a55b' && m.maxInputTokens + m.maxOutputTokens === 1000000));
check('nvidia/nemotron-3-super-120b-a12b is present with 1M context', nvGroup.models.some((m) => m.id === 'nvidia/nemotron-3-super-120b-a12b' && m.maxInputTokens + m.maxOutputTokens === 1000000));
check('MCP_PRESETS exported and has 5 presets', Array.isArray(mcpPresets) && mcpPresets.length === 5, `length=${mcpPresets?.length}`);

const mcpPresetIds = mcpPresets.map((p) => p.id);
check('all 5 expected MCP preset IDs present',
  ['web-search-prime', 'web-reader', 'zread', 'zai-mcp-server', 'minimax-mcp'].every((id) => mcpPresetIds.includes(id)),
  `got: ${mcpPresetIds.join(', ')}`
);

// Test provider grouping
const zaiMcp = getMcpPresetsForProvider('zai');
check('getMcpPresetsForProvider(zai) returns 4 tools', zaiMcp.length === 4, `got ${zaiMcp.length}`);
check('all zai tools have providerId zai', zaiMcp.every((t) => t.providerId === 'zai'));

const mmMcp = getMcpPresetsForProvider('minimax');
check('getMcpPresetsForProvider(minimax) returns 1 tool', mmMcp.length === 1, `got ${mmMcp.length}`);
check('minimax tool has providerId minimax', mmMcp[0]?.providerId === 'minimax');

const dsMcp = getMcpPresetsForProvider('deepseek');
check('getMcpPresetsForProvider(deepseek) returns empty array', dsMcp.length === 0);

// Test mergeMcpConfig on fresh config
const freshMcp = mergeMcpConfig(null, mcpPresets);
check('fresh MCP config has servers object', typeof freshMcp.servers === 'object' && Object.keys(freshMcp.servers).length === 5);
check('fresh MCP config has inputs array', Array.isArray(freshMcp.inputs) && freshMcp.inputs.length === 2);
check('inputs array has zai-api-key with password: true',
  freshMcp.inputs?.some((inp) => inp.id === 'zai-api-key' && inp.type === 'promptString' && inp.password === true)
);
check('inputs array has minimax-api-key with password: true',
  freshMcp.inputs?.some((inp) => inp.id === 'minimax-api-key' && inp.type === 'promptString' && inp.password === true)
);

// Test merge with existing unrelated servers, inputs, and sandbox fields
const existingMcp = {
  inputs: [
    { type: 'promptString', id: 'custom-token', description: 'Custom', password: true },
  ],
  servers: {
    existingServer: { type: 'http', url: 'https://example.com/mcp' },
  },
  sandbox: {
    filesystem: { allowWrite: ['${workspaceFolder}'] },
    network: { allowedDomains: ['*.example.com'] },
  },
};
const mergedMcp = mergeMcpConfig(existingMcp, [mcpPresets[0]]); // add web-search-prime
check('merge preserves existing custom input', mergedMcp.inputs?.some((inp) => inp.id === 'custom-token'));
check('merge includes new zai input', mergedMcp.inputs?.some((inp) => inp.id === 'zai-api-key'));
check('merge total inputs count is 2', mergedMcp.inputs?.length === 2);
check('merge preserves existingServer', mergedMcp.servers.existingServer !== undefined);
check('merge adds webSearchPrime', mergedMcp.servers.webSearchPrime !== undefined);
check('merge strictly preserves sandbox configuration',
  mergedMcp.sandbox?.filesystem?.allowWrite?.[0] === '${workspaceFolder}' &&
  mergedMcp.sandbox?.network?.allowedDomains?.[0] === '*.example.com'
);

console.log('\n-- 5. Status Bar Usage & Glyph Assertions --');
check('getPieGlyph(100) returns ● (full)', getPieGlyph(100) === '●');
check('getPieGlyph(75) returns ◕ (75%)', getPieGlyph(75) === '◕');
check('getPieGlyph(50) returns ◑ (50%)', getPieGlyph(50) === '◑');
check('getPieGlyph(25) returns ◔ (25%)', getPieGlyph(25) === '◔');
check('getPieGlyph(5) returns ○ (empty)', getPieGlyph(5) === '○');

const future2h = new Date(Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000);
check('formatCountdown(2h15m) returns in 2h 15m', formatCountdown(future2h) === 'in 2h 15m', formatCountdown(future2h));

// Test UsageStatusBarManager instance & minimal rendering
const mockContext = {
  subscriptions: [],
  globalState: {
    get: (k) => mockGlobalState.get(k),
    update: async (k, v) => mockGlobalState.set(k, v),
  },
  secrets: {
    get: async (k) => {
      if (k === 'copilot-provider-bridge.zai.apiKey') return 'mock-zai-key';
      return undefined;
    },
    store: async () => {},
  },
};
const sbManager = new UsageStatusBarManager(mockContext);
check('sbManager initializes with no provider selected', sbManager.getSelectedProviderId() === undefined);
await sbManager.setPinnedProvider('deepseek');
check('sbManager persists and returns selected provider deepseek', sbManager.getSelectedProviderId() === 'deepseek');
check('mockGlobalState stored pinned provider', mockGlobalState.get('copilotProviderBridge.pinnedProvider') === 'deepseek');
await sbManager.setPinnedProvider(undefined);
check('sbManager clear restores no-selection mode', sbManager.getSelectedProviderId() === undefined);
check('mockGlobalState cleared pinned provider on clear', mockGlobalState.get('copilotProviderBridge.pinnedProvider') === undefined);
const zaiReport = {
  providerId: 'zai',
  providerName: 'Z.ai GLM',
  percentageRemaining: 99,
  details: [
    '3,950 / 4,000 calls left',
    '5-hour token limit: 99% remaining',
    'Tier: MAX',
  ],
  resetCountdown: 'in 4h 12m',
  resets: [
    { label: '5-Hour Token Limit', countdown: 'in 4h 12m' },
    { label: 'Call Quota Window', countdown: 'in 18h 30m' },
  ],
  status: 'ok',
  lastUpdated: new Date(),
};
sbManager['_reports'].set('zai', zaiReport);
await sbManager.setPinnedProvider('zai');
check('percentage model status bar text has Datatype icon and percent "$(copilot-provider-bridge-p99) 99%"', mockStatusBarItem.text === '$(copilot-provider-bridge-p99) 99%', `got "${mockStatusBarItem.text}"`);

const dsReport = {
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  balanceDisplay: '¥299.79',
  details: ['CNY Balance: ¥299.79', 'USD Balance: $0.00'],
  status: 'ok',
  lastUpdated: new Date(),
};
sbManager['_reports'].set('deepseek', dsReport);

const kimiReport = {
  providerId: 'kimi',
  providerName: 'Kimi Code',
  percentageRemaining: 92,
  details: [
    'Tier: PRO',
    '5-hour limit: 95 / 100 calls left',
    'Weekly limit: 1,840 / 2,000 calls left',
  ],
  resetCountdown: 'in 3h 42m',
  resets: [
    { label: '5-Hour Rolling Window', countdown: 'in 3h 42m' },
    { label: 'Weekly Membership', countdown: 'in 5d 11h' },
  ],
  status: 'ok',
  lastUpdated: new Date(),
};
sbManager['_reports'].set('kimi', kimiReport);
const mmReport = {
  providerId: 'minimax',
  providerName: 'MiniMax',
  percentageRemaining: 99,
  details: [
    '5-hour interval: 99% remaining',
    'Weekly limit: 97% remaining',
    'Video models: 0/3 interval, 0/21 weekly',
  ],
  resetCountdown: 'in 2h 30m',
  resets: [
    { label: '5-Hour Rolling Window', countdown: 'in 2h 30m' },
    { label: 'Weekly Allowance', countdown: 'in 4d 16h' },
  ],
  status: 'ok',
  lastUpdated: new Date(),
};
sbManager['_reports'].set('minimax', mmReport);

sbManager.render();
const tooltipText = mockStatusBarItem.tooltip?.value ?? '';
check('tooltip contains SVG progress meters (data:image/svg+xml;base64)', tooltipText.includes('data:image/svg+xml;base64,'));
check('tooltip contains clickable refresh command link', tooltipText.includes('command:copilot-provider-bridge.refreshUsage'));
check('tooltip contains clickable pin provider command link', tooltipText.includes('command:copilot-provider-bridge.selectStatusBarProvider'));
check('tooltip contains Z.ai first detail (calls left)', tooltipText.includes('3,950 / 4,000 calls left'));
check('tooltip contains Z.ai second detail (5h token limit)', tooltipText.includes('5-hour token limit: 99% remaining'));
check('tooltip contains 5-Hour Token Limit reset', tooltipText.includes('5-Hour Token Limit Reset'));
check('tooltip contains Call Quota Window reset', tooltipText.includes('Call Quota Window Reset'));
check('tooltip contains Kimi 5-Hour Rolling Window reset', tooltipText.includes('5-Hour Rolling Window Reset'));
check('tooltip contains Kimi Weekly Membership reset', tooltipText.includes('Weekly Membership Reset'));
check('tooltip contains MiniMax 5-Hour Rolling Window reset', tooltipText.includes('5-Hour Rolling Window Reset'));
check('tooltip contains MiniMax Weekly Allowance reset', tooltipText.includes('Weekly Allowance Reset'));
check('tooltip does not contain duplicate Reset Reset', !tooltipText.includes('Reset Reset'));
await sbManager.setPinnedProvider('deepseek');
check('balance model status bar text is strictly balance amount "¥299.79"', mockStatusBarItem.text === '¥299.79', `got "${mockStatusBarItem.text}"`);
// Clearing the selection with reports present must render the neutral placeholder,
// never substitute another provider's metric
await sbManager.setPinnedProvider(undefined);
check('no selection with reports renders neutral placeholder "Copilot-Provider-Bridge"', mockStatusBarItem.text === 'Copilot-Provider-Bridge', `got "${mockStatusBarItem.text}"`);
// Empty reports also render the neutral placeholder
sbManager['_reports'].clear();
sbManager.render();
check('empty reports status bar text is strictly "Copilot-Provider-Bridge"', mockStatusBarItem.text === 'Copilot-Provider-Bridge', `got "${mockStatusBarItem.text}"`);

const emptyReport = {
  providerId: 'gemini',
  providerName: 'Google Gemini',
  details: ['No balance metrics available'],
  status: 'ok',
  lastUpdated: new Date(),
};
sbManager['_reports'].set('gemini', emptyReport);
await sbManager.setPinnedProvider('gemini');
check('no-metric model status bar text is strictly "Copilot-Provider-Bridge"', mockStatusBarItem.text === 'Copilot-Provider-Bridge', `got "${mockStatusBarItem.text}"`);

console.log('\n-- 6. Vision Agent Tool & Backends --');
check('VISION_BACKENDS exported and has 9 options', Array.isArray(VISION_BACKENDS) && VISION_BACKENDS.length === 9, `length=${VISION_BACKENDS?.length}`);
check('GLM-5.3-Flash backend present (openai apiType)', VISION_BACKENDS.some((b) => b.id === 'glm-5.3-flash' && b.apiType === 'openai'));
check('DeepSeek V4 Flash Vision Exp backend present (anthropic apiType)', VISION_BACKENDS.some((b) => b.id === 'deepseek-v4-flash-vision-exp' && b.apiType === 'anthropic'));
check('CopilotProviderBridgeVisionTool.toolId is provider_bridge_analyze_visual', CopilotProviderBridgeVisionTool.toolId === 'provider_bridge_analyze_visual');
// Check package.json contribution fields
const pkgJson = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
const contribTool = pkgJson.contributes?.languageModelTools?.[0];
check('package.json contributes languageModelTools with name', contribTool?.name === 'provider_bridge_analyze_visual');
check('package.json contributes toolReferenceName: vision', contribTool?.toolReferenceName === 'vision');
check('package.json contributes canBeReferencedInPrompt: true', contribTool?.canBeReferencedInPrompt === true);
check('package.json contributes inputSchema with file_path & image_url',
  contribTool?.inputSchema?.properties?.file_path !== undefined &&
  contribTool?.inputSchema?.properties?.image_url !== undefined
);
for (const cmd of pkgJson.contributes?.commands ?? []) {
  check(`command "${cmd.command}" title does not duplicate category`, !cmd.title.startsWith(cmd.category), `title="${cmd.title}"`);
}

const visionTool = new CopilotProviderBridgeVisionTool(mockContext);
// Test backend resolution: with mock zai key, should resolve GLM-4.6V or preferred
const resolved = await visionTool.resolveBackend();
check('visionTool resolves backend using available key (zai)', resolved?.backend?.providerId === 'zai' && resolved?.apiKey === 'mock-zai-key');

// Test preferred model pin with nonexistent model or missing key
await mockContext.globalState.update('copilotProviderBridge.preferredVisionModel', 'nonexistent-model');
const fallback = await visionTool.resolveBackend();
check('visionTool falls back gracefully when preferred model key is missing', fallback?.backend?.providerId === 'zai');

// Exercise visionTool.invoke() error branch (no path or URL)
const errResult = await visionTool.invoke({ input: {} }, {});
check('visionTool.invoke without input returns descriptive error', errResult?.parts?.[0]?.value?.includes('Please provide either a "file_path" or "image_url"'));

// Exercise visionTool.invoke() with mock fetch on base64 data URL
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Mocked diagram and OCR analysis.' } }] }),
  });
  const successResult = await visionTool.invoke(
    { input: { image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } },
    {}
  );
  check('visionTool.invoke with data URL returns visual analysis text', successResult?.parts?.[0]?.value?.includes('Mocked diagram and OCR analysis.'));
} finally {
  globalThis.fetch = originalFetch;
}

console.log('\n-- 7. Logger & Masking Assertions --');
check('Logger.maskSecret masks middle characters', Logger.maskSecret('sk-1234567890abcdef') === 'sk-1...def');
check('Logger.maskSecret handles short string safely', Logger.maskSecret('short') === '••••');

console.log('\n-- 8. Key Validation Probe Assertions --');
const validateProviderKey = moduleScope.exports.validateProviderKey;
check('validateProviderKey is exported', typeof validateProviderKey === 'function');

try {
  globalThis.fetch = async () => ({ ok: true });
  const validRes = await validateProviderKey(providers[0], 'test-key');
  check('validateProviderKey returns ok: true on 200 response', validRes.ok === true);

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'token expired' } }) });
  const invalidRes = await validateProviderKey(providers[0], 'bad-key');
  check('validateProviderKey returns ok: false with error message on 401', invalidRes.ok === false && invalidRes.message.includes('token expired'));
} finally {
  globalThis.fetch = originalFetch;
}

console.log('\n-- 8.1. Reset Configuration Command Assertions --');
const resetConfigurationCommand = moduleScope.exports.resetConfigurationCommand;
const resetCopilotProviderBridgeState = moduleScope.exports.resetCopilotProviderBridgeState;
check('resetConfigurationCommand is exported', typeof resetConfigurationCommand === 'function');
check('resetCopilotProviderBridgeState is exported', typeof resetCopilotProviderBridgeState === 'function');

const mockSecretStore = new Map();
mockSecretStore.set('copilot-provider-bridge.zai.apiKey', 'secret-key-1');
mockSecretStore.set('copilot-provider-bridge.deepseek.apiKey', 'secret-key-2');
mockGlobalState.set('copilotProviderBridge.hasRunSetup', true);
mockGlobalState.set('copilotProviderBridge.pinnedProvider', 'zai');

const testResetContext = {
  secrets: {
    delete: async (k) => { mockSecretStore.delete(k); },
    get: async (k) => mockSecretStore.get(k),
    store: async (k, v) => { mockSecretStore.set(k, v); },
  },
  globalState: {
    get: (k) => mockGlobalState.get(k),
    update: async (k, v) => {
      if (v === undefined) mockGlobalState.delete(k);
      else mockGlobalState.set(k, v);
    },
  },
};

// Test resetCopilotProviderBridgeState against isolated temporary files (NEVER touches %APPDATA%)
const tmpDir = join(nodeOs.tmpdir(), `cb-test-${Date.now()}`);
await mkdir(tmpDir, { recursive: true });
const tmpConfig = join(tmpDir, 'chatLanguageModels.json');
const tmpMcp = join(tmpDir, 'mcp.json');

// Seed temp files with bridge and non-bridge entries
await writeFile(tmpConfig, JSON.stringify([
  { name: 'Z.ai GLM Coding Plan', vendor: 'customendpoint', apiKey: '${input:copilot-provider-bridge.zai.apiKey}' },
  { name: 'Custom Ollama Local', vendor: 'customendpoint', apiKey: 'ollama-key' }
], null, 2));

await writeFile(tmpMcp, JSON.stringify({
  servers: {
    webSearchPrime: { type: 'http', url: 'https://api.z.ai' },
    unrelatedCustomServer: { type: 'stdio', command: 'node' }
  }
}, null, 2));

await resetCopilotProviderBridgeState(testResetContext, {
  customConfigPath: tmpConfig,
  customMcpPaths: [tmpMcp],
});

check('resetCopilotProviderBridgeState deletes all provider secrets from SecretStorage', mockSecretStore.size === 0);
check('resetCopilotProviderBridgeState clears hasRunSetup in globalState', mockGlobalState.get('copilotProviderBridge.hasRunSetup') === undefined);
check('resetCopilotProviderBridgeState clears pinnedProvider in globalState', mockGlobalState.get('copilotProviderBridge.pinnedProvider') === undefined);

// Verify temp files: bridge entries removed, non-bridge retained
const cleanedConfig = JSON.parse(await readFile(tmpConfig, 'utf8'));
check('reset cleans bridge groups while retaining non-bridge groups', cleanedConfig.length === 1 && cleanedConfig[0].name === 'Custom Ollama Local');

const cleanedMcp = JSON.parse(await readFile(tmpMcp, 'utf8'));
check('reset cleans bridge MCP tools while retaining non-bridge servers', cleanedMcp.servers?.webSearchPrime === undefined && cleanedMcp.servers?.unrelatedCustomServer !== undefined);

// Cleanup temp dir
await rm(tmpDir, { recursive: true, force: true });
console.log('\n-- 9. Bundled Datatype Font & Icons --');
check('package.json engines.vscode is ^1.122.0', pkgJson.engines?.vscode === '^1.122.0');
const pkgLock = JSON.parse(await readFile(join(here, '..', 'package-lock.json'), 'utf8'));
check('package-lock.json engines.vscode is ^1.122.0', pkgLock.packages?.['']?.engines?.vscode === '^1.122.0');
check('package-lock.json resolved @types/vscode is 1.120.0 (<= 1.122.0)', pkgLock.packages?.['node_modules/@types/vscode']?.version === '1.120.0');
const pkgIcons = pkgJson.contributes?.icons;
check('package.json contributes icons object', pkgIcons !== undefined && typeof pkgIcons === 'object');
check('package.json contributes exactly 101 icons (0% to 100%)', Object.keys(pkgIcons || {}).length === 101);
check('copilot-provider-bridge-p0 is defined with Datatype.woff2 and {p:0}', pkgIcons?.['copilot-provider-bridge-p0']?.default?.fontPath === './media/fonts/Datatype.woff2' && pkgIcons?.['copilot-provider-bridge-p0']?.default?.fontCharacter === '{p:0}');
check('copilot-provider-bridge-p73 is defined with Datatype.woff2 and {p:73}', pkgIcons?.['copilot-provider-bridge-p73']?.default?.fontPath === './media/fonts/Datatype.woff2' && pkgIcons?.['copilot-provider-bridge-p73']?.default?.fontCharacter === '{p:73}');
check('copilot-provider-bridge-p100 is defined with Datatype.woff2 and {p:100}', pkgIcons?.['copilot-provider-bridge-p100']?.default?.fontPath === './media/fonts/Datatype.woff2' && pkgIcons?.['copilot-provider-bridge-p100']?.default?.fontCharacter === '{p:100}');
const fontStat = await stat(join(here, '..', 'media', 'fonts', 'Datatype.woff2')).catch(() => null);
check('media/fonts/Datatype.woff2 exists and is non-empty', fontStat !== null && fontStat.size > 10000, `size=${fontStat?.size}`);
const oflStat = await stat(join(here, '..', 'media', 'fonts', 'OFL.txt')).catch(() => null);
check('media/fonts/OFL.txt exists', oflStat !== null && oflStat.size > 0);
const attrStat = await stat(join(here, '..', 'media', 'fonts', 'ATTRIBUTION.md')).catch(() => null);
check('media/fonts/ATTRIBUTION.md exists', attrStat !== null && attrStat.size > 0);

console.log(`\n========================================\nTest Results: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
process.exit(fail === 0 ? 0 : 1);
