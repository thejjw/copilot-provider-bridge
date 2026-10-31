// Pure environment gate for sealed credentials. Kept free of `vscode` so the
// matrix is unit-testable; callers supply the live editor values.

export interface SealedPreflightInput {
  platform: NodeJS.Platform;
  arch: string;
  remoteName?: string;
  appRoot: string;
}

export type SealedPreflight = { ok: true } | { ok: false; reason: string };

/** Sealing is supported only on local stable Code, Windows x64. */
export function checkSealedPreflight(input: SealedPreflightInput): SealedPreflight {
  if (input.platform !== 'win32') {
    return { ok: false, reason: 'Sealed credentials are supported on Windows only.' };
  }
  if (input.arch !== 'x64') {
    return { ok: false, reason: 'Sealed credentials require 64-bit Windows (x64).' };
  }
  if (input.remoteName) {
    return {
      ok: false,
      reason: 'Sealed credentials are unavailable in remote windows; the secret database is on the remote host.',
    };
  }
  if (/insiders/i.test(input.appRoot)) {
    return { ok: false, reason: 'Sealed credentials are not supported on VS Code Insiders.' };
  }
  return { ok: true };
}
