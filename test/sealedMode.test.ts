// Unit tests for converting and merging sealed groups.

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { appRoot: 'C:/Program Files/Microsoft VS Code', remoteName: undefined },
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

import { mergeSealedGroups, sealExistingGroup } from '../src/credentials/sealedMode';
import type { ConfigGroup } from '../src/config';

const PLAINTEXT: ConfigGroup = {
  name: 'Z.ai GLM Coding Plan',
  vendor: 'customendpoint',
  apiType: 'messages',
  apiKey: 'sk-live-zai',
  models: [
    {
      id: 'glm-5.3',
      name: 'GLM 5.3',
      url: 'https://api.z.ai/api/anthropic/v1/messages',
      apiType: 'messages',
      toolCalling: true,
      vision: false,
      maxInputTokens: 100,
      maxOutputTokens: 10,
      requestHeaders: { Authorization: 'Bearer sk-live-zai' },
    },
  ],
};

describe('sealExistingGroup', () => {
  it('removes the key from apiKey and headers and preserves models', () => {
    const sealed = sealExistingGroup(PLAINTEXT, 'zai', 'sk-live-zai');
    expect(sealed.apiKey).toBe('${input:chat.lm.secret.cpb-zai}');
    expect(sealed.models[0].requestHeaders?.Authorization).toBe('Bearer ${apiKey}');
    expect(JSON.stringify(sealed)).not.toContain('sk-live-zai');
    expect(sealed.models[0].id).toBe('glm-5.3');
  });
});

describe('mergeSealedGroups', () => {
  it('replaces the matching group and keeps unrelated entries', () => {
    const unrelated: ConfigGroup = {
      name: 'Other Plan',
      vendor: 'customendpoint',
      apiType: 'chat-completions',
      apiKey: 'sk-live-other',
      models: [],
    };
    const sealed = sealExistingGroup(PLAINTEXT, 'zai', 'sk-live-zai');
    const merged = mergeSealedGroups([PLAINTEXT, unrelated], [sealed]);
    expect(merged).toHaveLength(2);
    expect(merged[0].apiKey).toBe('${input:chat.lm.secret.cpb-zai}');
    expect(merged[1]).toEqual(unrelated);
  });

  it('appends a new provider group', () => {
    const sealed = {
      ...sealExistingGroup(PLAINTEXT, 'kimi', 'sk-live-zai'),
      name: 'Kimi',
    };
    const merged = mergeSealedGroups([PLAINTEXT], [sealed]);
    expect(merged).toHaveLength(2);
    expect(merged[1].name).toBe('Kimi');
  });
});
