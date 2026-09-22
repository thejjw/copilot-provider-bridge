// Mapping and diff engine for syncing models from https://models.dev
// Pure Node/TS module with zero vscode dependencies to enable CLI scripting and unit testing.

import type { ProviderModel } from '../providers';

export interface ModelsDevModelLimit {
  context?: number;
  output?: number;
}

export interface ModelsDevModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModelModalities {
  input?: string[];
  output?: string[];
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  release_date?: string;
  last_updated?: string;
  modalities?: ModelsDevModelModalities;
  limit?: ModelsDevModelLimit;
  cost?: ModelsDevModelCost;
}

export interface ModelsDevProviderEntry {
  id: string;
  name?: string;
  api?: string;
  doc?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
}

export interface ModelsDevApiResponse {
  [providerSlug: string]: ModelsDevProviderEntry;
}

export interface ProviderSlugMapping {
  /** Target copilot-provider-bridge provider id (e.g. 'zai', 'minimax') */
  providerId: string;
  /** models.dev provider slug (e.g. 'zai-coding-plan') */
  modelsDevSlug: string;
  /** Optional filter for model IDs (e.g. only 'qwen' models from alibaba-token-plan) */
  modelIdPrefix?: string;
  /** Optional regex filter */
  modelIdRegex?: RegExp;
}

export const KNOWN_MODELS_DEV_MAPPINGS: ProviderSlugMapping[] = [
  {
    providerId: 'zai',
    modelsDevSlug: 'zai-coding-plan',
  },
  {
    providerId: 'minimax',
    modelsDevSlug: 'minimax-coding-plan',
  },
  {
    providerId: 'kimi',
    modelsDevSlug: 'kimi-code-plan-cn',
  },
  {
    providerId: 'qwen',
    modelsDevSlug: 'alibaba-token-plan',
    modelIdPrefix: 'qwen',
  },
  {
    providerId: 'deepseek',
    modelsDevSlug: 'deepseek',
  },
  {
    providerId: 'openrouter',
    modelsDevSlug: 'openrouter',
  },
  {
    providerId: 'nvidia',
    modelsDevSlug: 'nvidia',
  },
];

export interface ModelDiffComparison {
  status: 'new' | 'modified' | 'identical';
  modelId: string;
  existing?: ProviderModel;
  suggested: ProviderModel;
  changes?: {
    field: keyof ProviderModel;
    oldValue: unknown;
    newValue: unknown;
  }[];
  cost?: ModelsDevModelCost;
}

export interface ProviderDiffReport {
  providerId: string;
  modelsDevSlug: string;
  providerName?: string;
  newModels: ModelDiffComparison[];
  modifiedModels: ModelDiffComparison[];
  identicalModels: ModelDiffComparison[];
  unmatchedExistingModelIds: string[];
}

/**
 * Filter out non-chat / media-only models (e.g., image generation or text-to-video with context 0).
 * Valid chat/coding models must have text in both input and output modalities and context > 0.
 */
export function isChatModel(raw: ModelsDevModel): boolean {
  const inputMods = raw.modalities?.input ?? [];
  const outputMods = raw.modalities?.output ?? [];
  const context = raw.limit?.context ?? 0;
  const output = raw.limit?.output ?? 0;

  if (context <= 0 || output <= 0) {
    return false;
  }
  if (!inputMods.includes('text') || !outputMods.includes('text')) {
    return false;
  }
  return true;
}

/**
 * Map a models.dev model into a VS Code Copilot BYOK ProviderModel.
 * Preserves the BYOK invariant: maxInputTokens = contextWindow - maxOutputTokens.
 */
export function mapModelsDevToProviderModel(
  raw: ModelsDevModel,
  baseOverrides?: Partial<ProviderModel>
): ProviderModel {
  const context = raw.limit?.context ?? 128000;
  let maxOutput = raw.limit?.output ?? 16384;

  // Safeguard: output must never exceed context
  if (maxOutput >= context) {
    maxOutput = Math.floor(context / 2);
  }

  const maxInputTokens = context - maxOutput;
  const inputMods = raw.modalities?.input ?? [];
  const hasVision = inputMods.includes('image');
  const toolCalling = raw.tool_call ?? true;
  const thinking = raw.reasoning ?? false;

  const model: ProviderModel = {
    id: raw.id,
    name: raw.name ?? raw.id,
    toolCalling,
    vision: hasVision,
    contextWindow: context,
    maxInputTokens,
    maxOutputTokens: maxOutput,
  };

  if (thinking) {
    model.thinking = true;
    model.supportsReasoningEffort = ['low', 'medium', 'high'];
  }

  if (baseOverrides) {
    return {
      ...model,
      ...baseOverrides,
      // Recalculate maxInputTokens in case contextWindow or maxOutputTokens were overridden
      maxInputTokens: (baseOverrides.contextWindow ?? model.contextWindow) - (baseOverrides.maxOutputTokens ?? model.maxOutputTokens),
    };
  }

  return model;
}

/**
 * Compare models for a specific provider between current catalog and models.dev.
 */
export function compareProviderModels(
  existingModels: readonly ProviderModel[],
  modelsDevEntries: Record<string, ModelsDevModel>,
  options?: {
    modelIdPrefix?: string;
    modelIdRegex?: RegExp;
    providerId?: string;
    modelsDevSlug?: string;
  }
): ProviderDiffReport {
  const newModels: ModelDiffComparison[] = [];
  const modifiedModels: ModelDiffComparison[] = [];
  const identicalModels: ModelDiffComparison[] = [];
  const existingMap = new Map<string, ProviderModel>();

  for (const m of existingModels) {
    existingMap.set(m.id, m);
  }

  const seenExistingIds = new Set<string>();

  for (const [rawId, rawModel] of Object.entries(modelsDevEntries)) {
    // Check prefix / regex filter
    if (options?.modelIdPrefix && !rawId.toLowerCase().startsWith(options.modelIdPrefix.toLowerCase())) {
      continue;
    }
    if (options?.modelIdRegex && !options.modelIdRegex.test(rawId)) {
      continue;
    }
    if (!isChatModel(rawModel)) {
      continue;
    }

    const existing = existingMap.get(rawId);
    if (!existing) {
      newModels.push({
        status: 'new',
        modelId: rawId,
        suggested: mapModelsDevToProviderModel(rawModel),
        cost: rawModel.cost,
      });
      continue;
    }

    seenExistingIds.add(rawId);

    // Check for changes in key fields
    const suggested = mapModelsDevToProviderModel(rawModel, {
      // Preserve existing display names or thinking configuration if already customized
      name: existing.name,
      supportsReasoningEffort: existing.supportsReasoningEffort,
      reasoningEffortFormat: existing.reasoningEffortFormat,
      url: existing.url,
      apiType: existing.apiType,
      requestHeaders: existing.requestHeaders,
    });

    const changes: ModelDiffComparison['changes'] = [];
    if (existing.contextWindow !== suggested.contextWindow) {
      changes.push({ field: 'contextWindow', oldValue: existing.contextWindow, newValue: suggested.contextWindow });
      changes.push({ field: 'maxInputTokens', oldValue: existing.maxInputTokens, newValue: suggested.maxInputTokens });
    }
    if (existing.maxOutputTokens !== suggested.maxOutputTokens) {
      changes.push({ field: 'maxOutputTokens', oldValue: existing.maxOutputTokens, newValue: suggested.maxOutputTokens });
      if (!changes.some((c) => c.field === 'maxInputTokens')) {
        changes.push({ field: 'maxInputTokens', oldValue: existing.maxInputTokens, newValue: suggested.maxInputTokens });
      }
    }
    if (existing.vision !== suggested.vision) {
      changes.push({ field: 'vision', oldValue: existing.vision, newValue: suggested.vision });
    }
    if (existing.toolCalling !== suggested.toolCalling) {
      changes.push({ field: 'toolCalling', oldValue: existing.toolCalling, newValue: suggested.toolCalling });
    }

    if (changes.length > 0) {
      modifiedModels.push({
        status: 'modified',
        modelId: rawId,
        existing,
        suggested,
        changes,
        cost: rawModel.cost,
      });
    } else {
      identicalModels.push({
        status: 'identical',
        modelId: rawId,
        existing,
        suggested,
        cost: rawModel.cost,
      });
    }
  }

  const unmatchedExistingModelIds = existingModels
    .map((m) => m.id)
    .filter((id) => !seenExistingIds.has(id));

  return {
    providerId: options?.providerId ?? 'unknown',
    modelsDevSlug: options?.modelsDevSlug ?? 'unknown',
    newModels,
    modifiedModels,
    identicalModels,
    unmatchedExistingModelIds,
  };
}

/**
 * Fetch models.dev api.json.
 */
export async function fetchModelsDevApi(timeoutMs = 15000): Promise<ModelsDevApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://models.dev/api.json', {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'copilot-provider-bridge/models-dev-sync',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch models.dev API: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as ModelsDevApiResponse;
  } finally {
    clearTimeout(timer);
  }
}
