// Unit tests for the models.dev sync and mapping engine.
// Verifies filter rules (chat only, non-zero limits), BYOK token invariant derivation,
// model diff comparison, and provider mapping.

import { describe, expect, it } from 'vitest';
import {
  isChatModel,
  mapModelsDevToProviderModel,
  compareProviderModels,
  type ModelsDevModel,
} from '../src/catalog/modelsDevSync';
import type { ProviderModel } from '../src/providers';

describe('isChatModel filter', () => {
  it('accepts valid text-in text-out models with context > 0', () => {
    const valid: ModelsDevModel = {
      id: 'glm-5.3',
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1000000, output: 131072 },
    };
    expect(isChatModel(valid)).toBe(true);
  });

  it('accepts multimodal models with text input and output', () => {
    const multimodal: ModelsDevModel = {
      id: 'MiniMax-M3',
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      limit: { context: 1048576, output: 512000 },
    };
    expect(isChatModel(multimodal)).toBe(true);
  });

  it('rejects image-only generation models (e.g. wan2.7-image)', () => {
    const imageGen: ModelsDevModel = {
      id: 'wan2.7-image',
      modalities: { input: ['text'], output: ['image'] },
      limit: { context: 8192, output: 0 },
    };
    expect(isChatModel(imageGen)).toBe(false);
  });

  it('rejects video models with context=0 or output=0 (e.g. happyhorse-1.1)', () => {
    const videoGen: ModelsDevModel = {
      id: 'happyhorse-1.1-t2v',
      modalities: { input: ['text'], output: ['video'] },
      limit: { context: 0, output: 0 },
    };
    expect(isChatModel(videoGen)).toBe(false);
  });

  it('rejects models missing limit or modalities', () => {
    expect(isChatModel({ id: 'dummy' })).toBe(false);
    expect(isChatModel({ id: 'dummy', limit: { context: 1000, output: 0 } })).toBe(false);
  });
});

describe('mapModelsDevToProviderModel', () => {
  it('correctly maps fields and enforces BYOK invariant', () => {
    const raw: ModelsDevModel = {
      id: 'test-model',
      name: 'Test Model 1',
      tool_call: true,
      reasoning: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1000000, output: 100000 },
    };

    const mapped = mapModelsDevToProviderModel(raw);
    expect(mapped.id).toBe('test-model');
    expect(mapped.name).toBe('Test Model 1');
    expect(mapped.toolCalling).toBe(true);
    expect(mapped.vision).toBe(true);
    expect(mapped.contextWindow).toBe(1000000);
    expect(mapped.maxOutputTokens).toBe(100000);
    expect(mapped.maxInputTokens).toBe(900000);
    expect(mapped.maxInputTokens + mapped.maxOutputTokens).toBe(mapped.contextWindow);
    expect(mapped.thinking).toBe(true);
    expect(mapped.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
  });

  it('safeguards against maxOutputTokens >= contextWindow', () => {
    const raw: ModelsDevModel = {
      id: 'bad-limits',
      limit: { context: 100000, output: 100000 },
      modalities: { input: ['text'], output: ['text'] },
    };

    const mapped = mapModelsDevToProviderModel(raw);
    expect(mapped.maxOutputTokens).toBe(50000);
    expect(mapped.maxInputTokens).toBe(50000);
    expect(mapped.maxInputTokens + mapped.maxOutputTokens).toBe(mapped.contextWindow);
  });

  it('preserves baseOverrides when provided', () => {
    const raw: ModelsDevModel = {
      id: 'custom-model',
      limit: { context: 200000, output: 50000 },
      modalities: { input: ['text'], output: ['text'] },
    };

    const mapped = mapModelsDevToProviderModel(raw, {
      name: 'My Custom Display Name',
      reasoningEffortFormat: 'messages',
    });

    expect(mapped.name).toBe('My Custom Display Name');
    expect(mapped.reasoningEffortFormat).toBe('messages');
  });
});

describe('compareProviderModels', () => {
  const existing: ProviderModel[] = [
    {
      id: 'existing-identical',
      name: 'Identical Model',
      toolCalling: true,
      vision: false,
      contextWindow: 1000000,
      maxInputTokens: 868928,
      maxOutputTokens: 131072,
    },
    {
      id: 'existing-modified',
      name: 'Modified Model',
      toolCalling: true,
      vision: false,
      contextWindow: 200000,
      maxInputTokens: 150000,
      maxOutputTokens: 50000,
    },
    {
      id: 'local-only-model',
      name: 'Local Only',
      toolCalling: true,
      vision: false,
      contextWindow: 128000,
      maxInputTokens: 112000,
      maxOutputTokens: 16000,
    },
  ];

  const modelsDevEntries: Record<string, ModelsDevModel> = {
    'existing-identical': {
      id: 'existing-identical',
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1000000, output: 131072 },
    },
    'existing-modified': {
      id: 'existing-modified',
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1000000, output: 131072 }, // modified from 200K
    },
    'new-model': {
      id: 'new-model',
      name: 'Brand New Model',
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 500000, output: 64000 },
      cost: { input: 0.5, output: 1.5 },
    },
    'filtered-non-chat': {
      id: 'filtered-non-chat',
      modalities: { input: ['text'], output: ['image'] },
      limit: { context: 4096, output: 0 },
    },
  };

  it('correctly classifies identical, modified, new, and unmatched models', () => {
    const report = compareProviderModels(existing, modelsDevEntries, {
      providerId: 'test-provider',
      modelsDevSlug: 'test-slug',
    });

    expect(report.identicalModels.length).toBe(1);
    expect(report.identicalModels[0].modelId).toBe('existing-identical');

    expect(report.modifiedModels.length).toBe(1);
    expect(report.modifiedModels[0].modelId).toBe('existing-modified');
    expect(report.modifiedModels[0].changes?.some((c) => c.field === 'contextWindow')).toBe(true);

    expect(report.newModels.length).toBe(1);
    expect(report.newModels[0].modelId).toBe('new-model');
    expect(report.newModels[0].suggested.vision).toBe(true);
    expect(report.newModels[0].cost?.input).toBe(0.5);

    expect(report.unmatchedExistingModelIds).toEqual(['local-only-model']);
  });

  it('filters by modelIdPrefix when configured', () => {
    const report = compareProviderModels([], modelsDevEntries, {
      modelIdPrefix: 'new-',
    });

    expect(report.newModels.length).toBe(1);
    expect(report.newModels[0].modelId).toBe('new-model');
  });
});
