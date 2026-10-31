// Unit tests for the pure group-identity matcher. No vscode import here.

import { describe, expect, it } from 'vitest';
import {
  SEALED_SECRET_PREFIX,
  providerIdForGroup,
  providerIdFromApiKey,
  sealedApiKeyPlaceholder,
  sealedSecretId,
} from '../src/groupMatch';

const PROVIDERS = [
  { id: 'zai', name: 'Z.ai GLM Coding Plan' },
  { id: 'custom-plan', name: 'Custom Plan' },
];

describe('sealed ids', () => {
  it('builds the stable core-vault id and placeholder', () => {
    expect(SEALED_SECRET_PREFIX).toBe('chat.lm.secret.cpb-');
    expect(sealedSecretId('zai')).toBe('chat.lm.secret.cpb-zai');
    expect(sealedApiKeyPlaceholder('zai')).toBe('${input:chat.lm.secret.cpb-zai}');
  });
});

describe('providerIdFromApiKey', () => {
  it('recognizes the plaintext marker', () => {
    expect(providerIdFromApiKey('${input:copilot-provider-bridge.zai.apiKey}')).toBe('zai');
  });

  it('recognizes the sealed placeholder', () => {
    expect(providerIdFromApiKey('${input:chat.lm.secret.cpb-zai}')).toBe('zai');
  });

  it('rejects literal keys and core-minted ids', () => {
    expect(providerIdFromApiKey('sk-live-secret')).toBeUndefined();
    expect(providerIdFromApiKey('${input:chat.lm.secret.3f9a2c}')).toBeUndefined();
    expect(providerIdFromApiKey('')).toBeUndefined();
  });
});

describe('providerIdForGroup', () => {
  it('prefers the marker over the display name', () => {
    expect(
      providerIdForGroup(
        { name: 'Renamed By User', apiKey: '${input:chat.lm.secret.cpb-custom-plan}' },
        PROVIDERS,
      ),
    ).toBe('custom-plan');
  });

  it('falls back to the catalog display name for literal-key groups', () => {
    expect(providerIdForGroup({ name: 'Custom Plan', apiKey: 'sk-live-secret' }, PROVIDERS)).toBe(
      'custom-plan',
    );
  });

  it('returns undefined for unrelated groups', () => {
    expect(providerIdForGroup({ name: 'Someone Else', apiKey: 'sk-live-secret' }, PROVIDERS)).toBeUndefined();
  });
});
