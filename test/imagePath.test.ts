// Unit tests for vision-tool image path resolution (pure module, no vscode import).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImagePath } from '../src/tools/imagePath';

describe('resolveImagePath', () => {
  it('passes absolute paths through unchanged', async () => {
    const abs = path.resolve(os.tmpdir(), 'whatever.png');
    expect(await resolveImagePath(abs, undefined)).toEqual({ ok: true, absPath: abs });
  });

  it('asks for an absolute path when no workspace folder is open', async () => {
    const result = await resolveImagePath('shot.png', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/absolute file path/);
  });

  it('resolves an existing relative path and rejects a missing one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpb-image-path-test-'));
    try {
      await fs.writeFile(path.join(dir, 'shot.png'), 'x');
      expect(await resolveImagePath('shot.png', dir)).toEqual({ ok: true, absPath: path.join(dir, 'shot.png') });
      const missing = await resolveImagePath('nope.png', dir);
      expect(missing.ok).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
