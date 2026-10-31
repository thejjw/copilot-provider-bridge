// Unit tests for sealed rendering and matcher consumers in the config layer.
// `vscode` is mocked because config.ts reaches catalogStore, which imports it
// only for types and lazily created events.

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { appRoot: 'C:/Program Files/Microsoft VS Code' },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined }),
  },
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
}));

import {
  findGroupIndex,
  hasAnyBridgeGroup,
  providerIdForConfigGroup,
  providerToConfig,
  providerToSealedConfig,
} from '../src/config';
import { catalogStore } from '../src/catalog/store';

const provider = catalogStore.get().providers.find((p) => p.id === 'zai')!;
const models = provider.models.slice(0, 1);

describe('sealed rendering', () => {
  it('writes the pointer and leaves ${apiKey} unsubstituted', () => {
    const group = providerToSealedConfig(provider, models);
    expect(group.apiKey).toBe('${input:chat.lm.secret.cpb-zai}');
    expect(group.models[0].requestHeaders?.Authorization).toBe('Bearer ${apiKey}');
  });

  it('never emits a key, even when one is passed', () => {
    const group = providerToConfig(provider, models, 'sk-live-do-not-write', { sealed: true });
    const json = JSON.stringify(group);
    expect(json).not.toContain('sk-live-do-not-write');
    expect(group.apiKey).toBe('${input:chat.lm.secret.cpb-zai}');
  });

  it('keeps literal-key rendering unchanged', () => {
    const group = providerToConfig(provider, models, 'sk-live-plaintext');
    expect(group.apiKey).toBe('sk-live-plaintext');
    expect(group.models[0].requestHeaders?.Authorization).toBe('Bearer sk-live-plaintext');
  });
});

describe('sealed recognition', () => {
  it('sees a sealed-only file as a bridge file', () => {
    const cfg = [providerToSealedConfig(provider, models)];
    expect(providerIdForConfigGroup(cfg[0])).toBe('zai');
    expect(findGroupIndex(cfg, 'zai')).toBe(0);
    expect(hasAnyBridgeGroup(cfg)).toBe(true);
  });

  it('recognizes a sealed group renamed by the user', () => {
    const group = { ...providerToSealedConfig(provider, models), name: 'My Renamed Plan' };
    expect(findGroupIndex([group], 'zai')).toBe(0);
  });

  it('still recognizes plaintext groups', () => {
    const cfg = [providerToConfig(provider, models, 'sk-live-plaintext')];
    expect(hasAnyBridgeGroup(cfg)).toBe(true);
    expect(findGroupIndex(cfg, 'zai')).toBe(0);
  });

  it('ignores unrelated groups', () => {
    const cfg = [
      {
        name: 'Unrelated',
        vendor: 'customendpoint' as const,
        apiType: 'messages' as const,
        apiKey: 'sk-live-other',
        models: [],
      },
    ];
    expect(hasAnyBridgeGroup(cfg)).toBe(false);
    expect(findGroupIndex(cfg, 'zai')).toBe(-1);
  });
});
