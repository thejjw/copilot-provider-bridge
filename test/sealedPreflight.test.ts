// Unit tests for the pure sealed-credential environment gate.

import { describe, expect, it } from 'vitest';
import { checkSealedPreflight } from '../src/credentials/preflight';

const BASE = {
  platform: 'win32' as const,
  arch: 'x64',
  appRoot: 'C:/Program Files/Microsoft VS Code',
};

describe('checkSealedPreflight', () => {
  it('accepts local stable Code on Windows x64', () => {
    expect(checkSealedPreflight(BASE)).toEqual({ ok: true });
  });

  it('rejects other platforms and architectures', () => {
    expect(checkSealedPreflight({ ...BASE, platform: 'darwin' }).ok).toBe(false);
    expect(checkSealedPreflight({ ...BASE, platform: 'linux' }).ok).toBe(false);
    expect(checkSealedPreflight({ ...BASE, arch: 'arm64' }).ok).toBe(false);
  });

  it('rejects remote windows and Insiders', () => {
    expect(checkSealedPreflight({ ...BASE, remoteName: 'ssh-remote' }).ok).toBe(false);
    expect(checkSealedPreflight({ ...BASE, appRoot: 'C:/Program Files/Microsoft VS Code Insiders' }).ok).toBe(false);
  });
});
