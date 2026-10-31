// One-time cleanup of bridge-authored MCP entries from VS Code `mcp.json` files.
// Deliberately free of `vscode` and `Logger` imports so the JSONC surgery can be
// unit tested in plain node.

import * as fs from 'node:fs/promises';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser/lib/esm/main.js';
import { matchesPresetServer, type McpPreset } from './mcpCatalog';

export interface LegacyCleanupResult {
  /** Preset ids whose server entry was removed from the file. */
  removedPresetIds: string[];
  /** Whether the file was rewritten. */
  changed: boolean;
}

const BOM = '\uFEFF';
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' };
const PARSE_OPTIONS = { allowTrailingComma: true, allowEmptyContent: true };

/** Parse JSONC, throwing on syntax errors so callers can log and retry next activation. */
function parseStrict(text: string, filePath: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, PARSE_OPTIONS);
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Failed to parse ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  return value;
}

/**
 * Remove bridge preset servers (and their now-unreferenced `inputs` entries)
 * from a single `mcp.json`-format file. Only the VS Code `servers` shape is
 * handled; `mcpServers` and all unrelated properties are left untouched.
 *
 * `requireMatch` (default true) requires the entry to still have the preset's
 * transport shape; reset passes false to remove known keys regardless.
 */
export async function cleanupLegacyMcpFile(
  filePath: string,
  presets: readonly McpPreset[],
  options?: { requireMatch?: boolean }
): Promise<LegacyCleanupResult> {
  const requireMatch = options?.requireMatch ?? true;

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removedPresetIds: [], changed: false };
    }
    throw err;
  }

  const hadBom = raw.startsWith(BOM);
  let text = hadBom ? raw.slice(1) : raw;

  const root = parseStrict(text, filePath);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { removedPresetIds: [], changed: false };
  }

  const removedPresetIds: string[] = [];
  let changed = false;

  // Server removals: re-parse before planning each one because applyEdits shifts offsets.
  for (const preset of presets) {
    const doc = parse(text, [], PARSE_OPTIONS) as { servers?: unknown } | undefined;
    const servers = doc?.servers;
    if (typeof servers !== 'object' || servers === null) continue;
    const entry = (servers as Record<string, unknown>)[preset.serverKey];
    if (entry === undefined) continue;
    if (requireMatch && !matchesPresetServer(entry, preset)) continue;
    text = applyEdits(text, modify(text, ['servers', preset.serverKey], undefined, { formattingOptions: FORMATTING }));
    removedPresetIds.push(preset.id);
    changed = true;
  }

  // Input removals: only drop a prompt definition once nothing references it anymore.
  const inputIds = [...new Set(presets.flatMap((p) => p.inputs.map((i) => i.id)))];
  for (const inputId of inputIds) {
    if (text.includes(`\${input:${inputId}}`)) continue;

    const before = parse(text, [], PARSE_OPTIONS) as { inputs?: unknown } | undefined;
    if (!Array.isArray(before?.inputs)) continue;

    // Descending order keeps the remaining indexes valid across repeated edits.
    for (let i = before.inputs.length - 1; i >= 0; i--) {
      const item = before.inputs[i] as { id?: unknown } | null;
      if (item?.id !== inputId) continue;
      text = applyEdits(text, modify(text, ['inputs', i], undefined, { formattingOptions: FORMATTING }));
      changed = true;
    }

    const after = parse(text, [], PARSE_OPTIONS) as { inputs?: unknown } | undefined;
    if (Array.isArray(after?.inputs) && after.inputs.length === 0) {
      text = applyEdits(text, modify(text, ['inputs'], undefined, { formattingOptions: FORMATTING }));
    }
  }

  if (!changed) return { removedPresetIds, changed: false };

  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, (hadBom ? BOM : '') + text, 'utf8');
  await fs.rename(tmp, filePath);
  return { removedPresetIds, changed: true };
}
