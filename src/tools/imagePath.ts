// Pure image-path resolution for the vision tool (no vscode import, so vitest can load it).
//
// Agent-harness sessions can run in their own worktree and the Agents window may have no
// folder open, while the stable tool API does not expose the session's working directory.
// A relative path is therefore only a best-effort guess against the first workspace folder.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ImagePathResult = { ok: true; absPath: string } | { ok: false; error: string };

/** Message returned whenever a relative path cannot be resolved to an existing file. */
export function absolutePathRequiredMessage(filePath: string): string {
  return (
    `Error: could not find image "${filePath}" relative to the workspace. ` +
    'Agent sessions may run in a different working directory (e.g. a git worktree) or without an open folder; ' +
    'call this tool again with an absolute file path.'
  );
}

/**
 * Resolve `filePath` to an existing absolute path. Absolute paths pass through unchanged
 * (read errors surface later); relative paths are tried against `workspaceRoot` and fail
 * with an "absolute path required" message when there is no root or no such file.
 */
export async function resolveImagePath(filePath: string, workspaceRoot: string | undefined): Promise<ImagePathResult> {
  if (path.isAbsolute(filePath)) return { ok: true, absPath: filePath };
  if (!workspaceRoot) return { ok: false, error: absolutePathRequiredMessage(filePath) };
  const candidate = path.join(workspaceRoot, filePath);
  try {
    await fs.access(candidate);
    return { ok: true, absPath: candidate };
  } catch {
    return { ok: false, error: absolutePathRequiredMessage(filePath) };
  }
}
