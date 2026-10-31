// Unit tests for the pure preset-selection helper that drives install/remove.
// Runs in plain node via vitest (mcpCatalog.ts has no vscode import).

import { describe, expect, it } from 'vitest';
import { computeNextPresetIds } from '../src/mcpCatalog';

describe('computeNextPresetIds', () => {
  it('replace keeps only the selected ids, ignoring the previous install set', () => {
    expect(computeNextPresetIds(['web-reader', 'zread'], ['zread'], 'replace')).toEqual(['zread']);
  });

  it('replace with an empty selection clears everything', () => {
    expect(computeNextPresetIds(['web-reader', 'zread'], [], 'replace')).toEqual([]);
  });

  it('merge unions old and selected ids without duplicates', () => {
    expect(computeNextPresetIds(['web-reader'], ['web-reader', 'zread', 'zread'], 'merge')).toEqual([
      'web-reader',
      'zread',
    ]);
  });
});
