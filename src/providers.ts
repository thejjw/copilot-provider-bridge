// Provider catalog for VS Code Copilot BYOK (Custom Endpoint).
// All limits, endpoints, and reasoning parameters are verified against
// official documentation and live API probes against active subscription keys.
//
// Invariant (per VS Code BYOK specification):
//   maxInputTokens = contextWindow - maxOutputTokens (maxInputTokens + maxOutputTokens <= contextWindow)

/**
 * Ids with built-in behavior beyond serving models (usage/quota fetchers,
 * diagnostics key checks). Custom catalog entries get arbitrary string ids.
 */
export type KnownProviderId = 'zai' | 'deepseek' | 'minimax' | 'kimi' | 'qwen' | 'gemini' | 'openrouter' | 'nvidia';

/** Any provider id from the catalog - built-in or user-defined. */
export type ProviderId = string;

/** Marker prefix used in secretInput names and chatLanguageModels.json groups we wrote. */
export const EXTENSION_MARKER = 'copilot-provider-bridge.';

export interface ProviderModel {
  /** Wire-format model id (sent to upstream API). */
  id: string;
  /** Display name in VS Code model picker. */
  name: string;
  /** Tool calling / function calling support. */
  toolCalling: boolean;
  /** Image / multimodal input support. */
  vision: boolean;
  /** Total context window size in tokens. */
  contextWindow: number;
  /** Max input tokens (derived as contextWindow - maxOutputTokens). */
  maxInputTokens: number;
  /** Max generation tokens allowed by model. */
  maxOutputTokens: number;
  /** Whether the model supports thinking / reasoning. */
  thinking?: boolean;
  /** Supported reasoning effort levels in VS Code model picker (e.g. ['low', 'high', 'max']). */
  supportsReasoningEffort?: string[];
  /** Wire format for reasoning effort ('messages' | 'chat-completions' | 'responses'). */
  reasoningEffortFormat?: 'messages' | 'chat-completions' | 'responses';
  /** Model-level URL override (e.g. if a multimodal variant uses OpenAI endpoint). */
  url?: string;
  /** Model-level API type override. */
  apiType?: 'messages' | 'chat-completions';
  /** Model-level request headers override. */
  requestHeaders?: Record<string, string>;
}

export interface Provider {
  id: ProviderId;
  name: string;
  description: string;
  /** Base endpoint URL. */
  endpointUrl: string;
  /** Default API protocol. */
  apiType: 'messages' | 'chat-completions';
  /** Suffix used in ${input:...} placeholder, e.g. copilot-provider-bridge.zai.apiKey. */
  secretInput: string;
  /** Custom authentication headers (e.g. Authorization: Bearer ${apiKey}). */
  requestHeaders?: Record<string, string>;
  models: ProviderModel[];
}

/** Verified provider catalog. Order determines QuickPick display order. */
export const PROVIDERS: Provider[] = [
  {
    id: 'zai',
    name: 'Z.ai GLM Coding Plan',
    description: 'Z.ai GLM-5.3 (1M) / GLM-4.7 / GLM-5V-Turbo via Coding Plan endpoints.',
    endpointUrl: 'https://api.z.ai/api/anthropic/v1/messages',
    apiType: 'messages',
    secretInput: 'copilot-provider-bridge.zai.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'glm-5.3',
        name: 'GLM 5.3 (1M)',
        toolCalling: true,
        vision: false,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        maxInputTokens: 868_928,
        thinking: true,
        // Z.ai reasoning_effort is supported on GLM-5.3 with only low, high, max (no medium)
        supportsReasoningEffort: ['low', 'high', 'max'],
        reasoningEffortFormat: 'messages',
      },
      {
        id: 'glm-4.7',
        name: 'GLM 4.7',
        toolCalling: true,
        vision: false,
        contextWindow: 202_752,
        maxOutputTokens: 65_535,
        maxInputTokens: 137_217,
        // GLM-4.7 uses forced thinking by default but does not support reasoning_effort controls
        thinking: true,
      },
      {
        id: 'glm-5v-turbo',
        name: 'GLM 5V Turbo (Vision)',
        toolCalling: true,
        vision: true,
        url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
        apiType: 'chat-completions',
        contextWindow: 202_752,
        maxOutputTokens: 131_072,
        maxInputTokens: 71_680,
        thinking: true,
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek V4 Pro / Flash Vision Exp (1M, 384K Out).',
    endpointUrl: 'https://api.deepseek.com/anthropic/v1/messages',
    apiType: 'messages',
    secretInput: 'copilot-provider-bridge.deepseek.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro (1M, 384K Out)',
        toolCalling: true,
        vision: false,
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        maxInputTokens: 606_784,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'messages',
      },
      {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision Exp (1M, 384K Out)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        maxInputTokens: 606_784,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'messages',
      },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax M3 (1M Context + Vision) via MiniMax Anthropic endpoint.',
    endpointUrl: 'https://api.minimax.io/anthropic/v1/messages',
    apiType: 'messages',
    secretInput: 'copilot-provider-bridge.minimax.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'MiniMax-M3',
        name: 'MiniMax M3 (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        maxInputTokens: 868_928,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'messages',
      },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi Code Plan',
    description: 'Kimi K3 (1M Context + Vision) via Kimi Coding Anthropic endpoint.',
    endpointUrl: 'https://api.kimi.com/coding/v1/messages',
    apiType: 'messages',
    secretInput: 'copilot-provider-bridge.kimi.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
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
      {
        id: 'k3-256k',
        name: 'Kimi K3 256K (Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        maxInputTokens: 196_608,
        thinking: true,
        supportsReasoningEffort: ['low', 'high', 'max'],
        reasoningEffortFormat: 'messages',
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi K2.7 Code (256K Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        maxInputTokens: 196_608,
        thinking: true,
      },
      {
        id: 'kimi-for-coding-highspeed',
        name: 'Kimi K2.7 Code HighSpeed (6x Speed)',
        toolCalling: true,
        vision: true,
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        maxInputTokens: 196_608,
        thinking: true,
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen Token Plan',
    description: 'Qwen 3.8 Max (1M) / Qwen 3.7 Plus (256K) via Alibaba Cloud Token Plan Anthropic App.',
    endpointUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages',
    apiType: 'messages',
    secretInput: 'copilot-provider-bridge.qwen.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'qwen3.8-max',
        name: 'Qwen 3.8 Max (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        maxInputTokens: 868_928,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'messages',
      },
      {
        id: 'qwen3.7-plus',
        name: 'Qwen 3.7 Plus (256K Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        maxInputTokens: 229_376,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'messages',
      },
      {
        id: 'qwen3.6-flash',
        name: 'Qwen 3.6 Flash (128K)',
        toolCalling: true,
        vision: false,
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        maxInputTokens: 111_616,
        thinking: false,
      },
    ],
  },
  /*
  // Google Gemini (Disabled for now - requires active Google AI Studio billing quota for Gemini 3 generation)
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini 3.7 / 2.5 Pro & Flash via Google AI Studio API (requires active project quota).',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiType: 'chat-completions',
    secretInput: 'copilot-provider-bridge.gemini.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash-Lite (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-flash-latest',
        name: 'Gemini Flash Latest (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-pro-latest',
        name: 'Gemini Pro Latest (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'gemini-flash-lite-latest',
        name: 'Gemini Flash-Lite Latest (1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        maxInputTokens: 983_040,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
    ],
  },
  */
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter Free Models Router (zero-cost) & Auto Router (intelligent model selection).',
    endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiType: 'chat-completions',
    secretInput: 'copilot-provider-bridge.openrouter.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
      'HTTP-Referer': 'https://github.com/thejjw/copilot-provider-bridge',
      'X-Title': 'Copilot Provider Bridge',
    },
    models: [
      {
        id: 'openrouter/free',
        name: 'OpenRouter Free (Zero-Cost Router)',
        toolCalling: true,
        vision: true,
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        maxInputTokens: 111_616,
      },
      {
        id: 'openrouter/auto',
        name: 'OpenRouter Auto (Intelligent Router)',
        toolCalling: true,
        vision: true,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        maxInputTokens: 183_616,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'NVIDIA NIM Inference endpoints for Nemotron, Laguna, Inkling, Muse Glimmer, GLM & MiniMax.',
    endpointUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiType: 'chat-completions',
    secretInput: 'copilot-provider-bridge.nvidia.apiKey',
    requestHeaders: {
      Authorization: 'Bearer ${apiKey}',
    },
    models: [
      {
        id: 'meta/muse-glimmer-30b',
        name: 'Muse Glimmer 30B (Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        maxInputTokens: 114_688,
      },
      {
        id: 'z-ai/glm-5.2',
        name: 'GLM 5.2 (NVIDIA NIM)',
        toolCalling: true,
        vision: false,
        contextWindow: 128_000,
        maxOutputTokens: 65_536,
        maxInputTokens: 62_464,
        thinking: true,
      },
      {
        id: 'thinkingmachines/inkling',
        name: 'Inkling (Vision & Reasoning)',
        toolCalling: true,
        vision: true,
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        maxInputTokens: 114_688,
        thinking: true,
      },
      {
        id: 'poolside/laguna-xs-2.1',
        name: 'Laguna XS 2.1 (Coding)',
        toolCalling: true,
        vision: false,
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        maxInputTokens: 229_376,
      },
      {
        id: 'minimaxai/minimax-m3',
        name: 'MiniMax M3 (NVIDIA NIM 1M Vision)',
        toolCalling: true,
        vision: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        maxInputTokens: 868_928,
        thinking: true,
        supportsReasoningEffort: ['low', 'medium', 'high'],
        reasoningEffortFormat: 'chat-completions',
      },
      {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        name: 'Nemotron 3 Ultra 550B (1M)',
        toolCalling: true,
        vision: false,
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        maxInputTokens: 934_464,
        thinking: true,
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        name: 'Nemotron 3 Super 120B (1M)',
        toolCalling: true,
        vision: false,
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        maxInputTokens: 934_464,
        thinking: true,
      },
    ],
  },
];
