// User-editable provider catalog (<userData>/User/copilot-provider-bridge.jsonc).
// Pure node module: JSONC parsing, schema validation, field derivation, and
// template serialization. Deliberately no `vscode` import so unit tests run
// in plain node.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Provider, ProviderModel } from '../providers';
import type { McpInputDefinition, McpPreset, McpServerDefinition } from '../mcpCatalog';
import type { VisionBackendOption } from '../tools/visionTool';

export const CATALOG_FILE_NAME = 'copilot-provider-bridge.jsonc';
export const CATALOG_SCHEMA_VERSION = 1;

const SECRET_INPUT_PREFIX = 'copilot-provider-bridge.';
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const API_TYPES = new Set(['messages', 'chat-completions']);
const REASONING_FORMATS = new Set(['messages', 'chat-completions', 'responses']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);
const MCP_SERVER_TYPES = new Set(['http', 'stdio', 'sse']);
const VISION_API_TYPES = new Set(['openai', 'anthropic']);

export interface CatalogError {
  /** Location in the file, e.g. `providers[2].models[0].contextWindow` or `line 4, column 7`. */
  path: string;
  message: string;
}

/** Sections actually present in the file; absent keys fall back to bundled defaults. */
export interface CatalogFileSections {
  providers?: Provider[];
  visionBackends?: VisionBackendOption[];
  mcpPresets?: McpPreset[];
}

export type CatalogLoadResult =
  | { status: 'absent' }
  | { status: 'ok'; sections: CatalogFileSections; warnings: string[] }
  | { status: 'error'; errors: CatalogError[] };

/** Absolute catalog-file path for a user settings dir (the dir holding chatLanguageModels.json). */
export function catalogPathFor(userSettingsDir: string): string {
  return path.join(userSettingsDir, CATALOG_FILE_NAME);
}

const err = (path: string, message: string): CatalogError => ({ path, message });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function asPositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.min(Math.max(offset, 0), text.length);
  let line = 1;
  let lastLf = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastLf = i;
    }
  }
  return { line, column: clamped - lastLf };
}

function validateRequestHeaders(v: unknown, at: string, errors: CatalogError[]): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) {
    errors.push(err(at, 'must be an object of header name -> template string'));
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string') {
      errors.push(err(`${at}.${key}`, 'header values must be strings'));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Validate one model entry; derives maxInputTokens from the BYOK invariant when omitted. */
function validateModel(raw: unknown, at: string, seenModelIds: Set<string>, errors: CatalogError[]): ProviderModel | undefined {
  if (!isObj(raw)) {
    errors.push(err(at, 'model entry must be an object'));
    return undefined;
  }
  let ok = true;
  const id = asNonEmptyString(raw.id);
  if (!id) {
    errors.push(err(`${at}.id`, 'required non-empty string'));
    ok = false;
  } else if (seenModelIds.has(id)) {
    errors.push(err(`${at}.id`, `duplicate model id "${id}" within provider`));
    ok = false;
  } else {
    seenModelIds.add(id);
  }

  const name = asNonEmptyString(raw.name);
  if (!name) {
    errors.push(err(`${at}.name`, 'required non-empty string'));
    ok = false;
  }

  for (const field of ['toolCalling', 'vision'] as const) {
    if (typeof raw[field] !== 'boolean') {
      errors.push(err(`${at}.${field}`, 'required boolean'));
      ok = false;
    }
  }

  const contextWindow = asPositiveInt(raw.contextWindow);
  if (contextWindow === undefined) {
    errors.push(err(`${at}.contextWindow`, 'required positive integer (total context window in tokens)'));
    ok = false;
  }
  const maxOutputTokens = asPositiveInt(raw.maxOutputTokens);
  if (maxOutputTokens === undefined) {
    errors.push(err(`${at}.maxOutputTokens`, 'required positive integer'));
    ok = false;
  }

  // BYOK invariant: maxInputTokens + maxOutputTokens <= contextWindow.
  let maxInputTokens: number | undefined;
  if (contextWindow !== undefined && maxOutputTokens !== undefined) {
    maxInputTokens = contextWindow - maxOutputTokens;
    if (maxInputTokens <= 0) {
      errors.push(err(at, `maxOutputTokens (${maxOutputTokens}) must be smaller than contextWindow (${contextWindow})`));
      ok = false;
      maxInputTokens = undefined;
    }
  }
  if (raw.maxInputTokens !== undefined) {
    const explicit = asPositiveInt(raw.maxInputTokens);
    if (explicit === undefined) {
      errors.push(err(`${at}.maxInputTokens`, 'must be a positive integer when provided'));
      ok = false;
    } else if (maxInputTokens !== undefined && explicit !== maxInputTokens) {
      errors.push(
        err(`${at}.maxInputTokens`, `explicit value ${explicit} contradicts contextWindow - maxOutputTokens = ${maxInputTokens}; omit the field to auto-derive`)
      );
      ok = false;
    } else {
      maxInputTokens = explicit;
    }
  }

  if (raw.thinking !== undefined && typeof raw.thinking !== 'boolean') {
    errors.push(err(`${at}.thinking`, 'must be a boolean when provided'));
    ok = false;
  }

  if (raw.supportsReasoningEffort !== undefined) {
    const levels = raw.supportsReasoningEffort;
    if (!Array.isArray(levels) || levels.some((l) => typeof l !== 'string' || !EFFORT_LEVELS.has(l))) {
      errors.push(err(`${at}.supportsReasoningEffort`, `must be an array drawn from low/medium/high/max`));
      ok = false;
    }
  }

  if (raw.reasoningEffortFormat !== undefined && (!REASONING_FORMATS.has(raw.reasoningEffortFormat as string))) {
    errors.push(err(`${at}.reasoningEffortFormat`, 'must be one of messages/chat-completions/responses'));
    ok = false;
  }

  if (raw.url !== undefined && asNonEmptyString(raw.url) === undefined) {
    errors.push(err(`${at}.url`, 'model-level URL override must be a non-empty string when provided'));
    ok = false;
  }

  if (raw.apiType !== undefined && (!API_TYPES.has(raw.apiType as string))) {
    errors.push(err(`${at}.apiType`, 'must be "messages" or "chat-completions"'));
    ok = false;
  }

  const requestHeaders = validateRequestHeaders(raw.requestHeaders, `${at}.requestHeaders`, errors);

  if (!ok || id === undefined || name === undefined || contextWindow === undefined || maxOutputTokens === undefined || maxInputTokens === undefined) {
    return undefined;
  }
  return {
    id,
    name,
    toolCalling: raw.toolCalling as boolean,
    vision: raw.vision as boolean,
    contextWindow,
    maxOutputTokens,
    maxInputTokens,
    thinking: raw.thinking as boolean | undefined,
    supportsReasoningEffort: raw.supportsReasoningEffort as string[] | undefined,
    reasoningEffortFormat: raw.reasoningEffortFormat as ProviderModel['reasoningEffortFormat'],
    url: asNonEmptyString(raw.url),
    apiType: raw.apiType as ProviderModel['apiType'],
    requestHeaders,
  };
}

/** Validate the providers section; returns undefined when absent. Partial results on error. */
function validateProviders(raw: unknown, errors: CatalogError[]): Provider[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(err('providers', 'must be a non-empty array when present'));
    return undefined;
  }
  const out: Provider[] = [];
  const seenProviderIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const at = `providers[${i}]`;
    if (!isObj(entry)) {
      errors.push(err(at, 'provider entry must be an object'));
      continue;
    }
    let ok = true;

    const id = asNonEmptyString(entry.id);
    if (!id) {
      errors.push(err(`${at}.id`, 'required non-empty string'));
      ok = false;
    } else if (!PROVIDER_ID_PATTERN.test(id)) {
      errors.push(err(`${at}.id`, `"${id}" may only contain letters, digits, "_" and "-" (it becomes part of the secret input name)`));
      ok = false;
    } else if (seenProviderIds.has(id)) {
      errors.push(err(`${at}.id`, `duplicate provider id "${id}"`));
      ok = false;
    } else {
      seenProviderIds.add(id);
    }

    const name = asNonEmptyString(entry.name);
    if (!name) {
      errors.push(err(`${at}.name`, 'required non-empty string'));
      ok = false;
    }

    const endpointUrl = asNonEmptyString(entry.endpointUrl);
    if (!endpointUrl) {
      errors.push(err(`${at}.endpointUrl`, 'required non-empty URL string'));
      ok = false;
    }

    if (entry.apiType === undefined || (!API_TYPES.has(entry.apiType as string))) {
      errors.push(err(`${at}.apiType`, 'required, must be "messages" or "chat-completions"'));
      ok = false;
    }

    const description = asNonEmptyString(entry.description) ?? '';

    const secretInput = asNonEmptyString(entry.secretInput) ?? `${SECRET_INPUT_PREFIX}${id ?? `providers[${i}]`}.apiKey`;
    const requestHeaders = validateRequestHeaders(entry.requestHeaders, `${at}.requestHeaders`, errors);

    const models: ProviderModel[] = [];
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      errors.push(err(`${at}.models`, 'required non-empty array of model entries'));
      ok = false;
    } else {
      const seenModelIds = new Set<string>();
      for (let j = 0; j < entry.models.length; j++) {
        const model = validateModel(entry.models[j], `${at}.models[${j}]`, seenModelIds, errors);
        if (model) models.push(model);
      }
    }

    if (ok && id && name && endpointUrl) {
      out.push({
        id,
        name,
        description,
        endpointUrl,
        apiType: entry.apiType as Provider['apiType'],
        secretInput,
        requestHeaders: requestHeaders ?? { Authorization: 'Bearer ${apiKey}' },
        models,
      });
    }
  }
  return out;
}

/** Validate the visionBackends section; providerIds must exist in the effective providers. */
function validateVisionBackends(raw: unknown, effectiveProviderIds: ReadonlySet<string>, errors: CatalogError[]): VisionBackendOption[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(err('visionBackends', 'must be an array when present'));
    return undefined;
  }
  const out: VisionBackendOption[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const at = `visionBackends[${i}]`;
    if (!isObj(entry)) {
      errors.push(err(at, 'vision backend entry must be an object'));
      continue;
    }
    let ok = true;

    const id = asNonEmptyString(entry.id);
    if (!id) {
      errors.push(err(`${at}.id`, 'required non-empty string'));
      ok = false;
    } else if (seenIds.has(id)) {
      errors.push(err(`${at}.id`, `duplicate vision backend id "${id}"`));
      ok = false;
    } else {
      seenIds.add(id);
    }

    const requiredStrings = ['name', 'description', 'model', 'endpointUrl'] as const;
    for (const field of requiredStrings) {
      if (asNonEmptyString(entry[field]) === undefined) {
        errors.push(err(`${at}.${field}`, 'required non-empty string'));
        ok = false;
      }
    }

    const providerId = asNonEmptyString(entry.providerId);
    if (!providerId) {
      errors.push(err(`${at}.providerId`, 'required non-empty string'));
      ok = false;
    } else if (!effectiveProviderIds.has(providerId)) {
      errors.push(err(`${at}.providerId`, `"${providerId}" does not match any provider in the effective providers section`));
      ok = false;
    }

    if (entry.apiType === undefined || (!VISION_API_TYPES.has(entry.apiType as string))) {
      errors.push(err(`${at}.apiType`, 'required, must be "openai" or "anthropic"'));
      ok = false;
    }

    if (!ok) continue;
    out.push({
      id: id!,
      name: entry.name as string,
      providerId: providerId!,
      description: entry.description as string,
      model: entry.model as string,
      endpointUrl: entry.endpointUrl as string,
      apiType: entry.apiType as VisionBackendOption['apiType'],
    });
  }
  return out;
}

function validateMcpInputs(raw: unknown, at: string, errors: CatalogError[]): McpInputDefinition[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(err(at, 'must be an array of promptString inputs'));
    return undefined;
  }
  const out: McpInputDefinition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const inputAt = `${at}[${i}]`;
    if (
      !isObj(entry) ||
      entry.type !== 'promptString' ||
      asNonEmptyString(entry.id) === undefined ||
      asNonEmptyString(entry.description) === undefined ||
      entry.password !== true
    ) {
      errors.push(err(inputAt, 'must be { type: "promptString", id, description, password: true }'));
      continue;
    }
    out.push({
      type: 'promptString',
      id: entry.id as string,
      description: entry.description as string,
      password: true,
    });
  }
  // An empty inputs array is valid: stdio tools may need no key prompt at all.
  return out;
}

function validateMcpServer(raw: unknown, at: string, errors: CatalogError[]): McpServerDefinition | undefined {
  if (!isObj(raw)) {
    errors.push(err(at, 'server definition must be an object'));
    return undefined;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !MCP_SERVER_TYPES.has(type)) {
    errors.push(err(`${at}.type`, 'must be one of http/stdio/sse'));
    return undefined;
  }
  const def: McpServerDefinition = { type: type as McpServerDefinition['type'] };
  let ok = true;

  if (type === 'http' || type === 'sse') {
    const url = asNonEmptyString(raw.url);
    if (!url) {
      errors.push(err(`${at}.url`, `required for ${type} servers`));
      ok = false;
    } else {
      def.url = url;
    }
  }
  if (type === 'stdio') {
    const command = asNonEmptyString(raw.command);
    if (!command) {
      errors.push(err(`${at}.command`, 'required for stdio servers'));
      ok = false;
    } else {
      def.command = command;
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        errors.push(err(`${at}.args`, 'must be an array of strings'));
        ok = false;
      } else {
        def.args = raw.args as string[];
      }
    }
  }
  const headers = validateRequestHeaders(raw.headers, `${at}.headers`, errors);
  if (headers) def.headers = headers;
  if (raw.env !== undefined) {
    const env = validateRequestHeaders(raw.env, `${at}.env`, errors);
    if (env) def.env = env;
  }
  return ok ? def : undefined;
}

/** Validate the mcpPresets section; providerIds must exist in the effective providers. */
function validateMcpPresets(raw: unknown, effectiveProviderIds: ReadonlySet<string>, errors: CatalogError[]): McpPreset[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(err('mcpPresets', 'must be an array when present'));
    return undefined;
  }
  const out: McpPreset[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const at = `mcpPresets[${i}]`;
    if (!isObj(entry)) {
      errors.push(err(at, 'MCP preset entry must be an object'));
      continue;
    }
    let ok = true;

    const id = asNonEmptyString(entry.id);
    if (!id) {
      errors.push(err(`${at}.id`, 'required non-empty string'));
      ok = false;
    } else if (seenIds.has(id)) {
      errors.push(err(`${at}.id`, `duplicate MCP preset id "${id}"`));
      ok = false;
    } else {
      seenIds.add(id);
    }

    for (const field of ['name', 'description', 'serverKey'] as const) {
      if (asNonEmptyString(entry[field]) === undefined) {
        errors.push(err(`${at}.${field}`, 'required non-empty string'));
        ok = false;
      }
    }

    const providerId = asNonEmptyString(entry.providerId);
    if (!providerId) {
      errors.push(err(`${at}.providerId`, 'required non-empty string'));
      ok = false;
    } else if (!effectiveProviderIds.has(providerId)) {
      errors.push(err(`${at}.providerId`, `"${providerId}" does not match any provider in the effective providers section`));
      ok = false;
    }

    const inputs = validateMcpInputs(entry.inputs, `${at}.inputs`, errors);
    if (!inputs) {
      ok = false;
    }

    const server = validateMcpServer(entry.server, `${at}.server`, errors);
    if (!server) {
      ok = false;
    }

    if (!ok) continue;
    out.push({
      id: id!,
      name: entry.name as string,
      description: entry.description as string,
      providerId: providerId!,
      serverKey: entry.serverKey as string,
      inputs: inputs!,
      server: server!,
    });
  }
  return out;
}

/**
 * Read, parse, and validate the catalog file.
 * `fallbackProviderIds` are used for cross-section checks when the file has no
 * providers section (vision backends / MCP presets then reference bundled providers).
 */
export async function readCatalogFile(filePath: string, fallbackProviderIds: readonly string[]): Promise<CatalogLoadResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent' };
    throw e;
  }
  // Tolerate a UTF-8 BOM written by some Windows editors.
  text = text.replace(/^\uFEFF/, '').trim();
  if (text.length === 0) return { status: 'absent' };

  const parseErrors: ParseError[] = [];
  const root: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0 || root === undefined) {
    return {
      status: 'error',
      errors: parseErrors.map((pe) => {
        const pos = offsetToLineCol(text, pe.offset ?? 0);
        return err(`line ${pos.line}, column ${pos.column}`, `JSON syntax error (jsonc-parser code ${pe.error})`);
      }),
    };
  }
  if (!isObj(root)) {
    return { status: 'error', errors: [err('<root>', 'catalog file must contain a JSON object with $version/providers/visionBackends/mcpPresets keys')] };
  }

  const warnings: string[] = [];
  if (root.$version !== undefined && root.$version !== CATALOG_SCHEMA_VERSION) {
    warnings.push(`$version ${JSON.stringify(root.$version)} is not recognized by this release (expected ${CATALOG_SCHEMA_VERSION}); loading anyway.`);
  }
  const knownTopLevel = new Set(['$version', 'providers', 'visionBackends', 'mcpPresets']);
  for (const key of Object.keys(root)) {
    if (!knownTopLevel.has(key)) warnings.push(`Unknown top-level key "${key}" was ignored.`);
  }

  const errors: CatalogError[] = [];
  const providers = validateProviders(root.providers, errors);
  // Cross-section references resolve against the file's own providers when it
  // replaces the section, otherwise against the bundled defaults.
  const effectiveProviderIds = new Set(providers ? providers.map((p) => p.id) : fallbackProviderIds);

  const visionBackends = validateVisionBackends(root.visionBackends, effectiveProviderIds, errors);
  const mcpPresets = validateMcpPresets(root.mcpPresets, effectiveProviderIds, errors);

  if (errors.length > 0) return { status: 'error', errors };
  return {
    status: 'ok',
    sections: { providers, visionBackends, mcpPresets },
    warnings,
  };
}

/**
 * Serialize the commented JSONC customization template users start from.
 * The body is plain JSON; all documentation lives in the header comment block.
 */
export function serializeCatalogTemplate(data: { providers: Provider[]; visionBackends: VisionBackendOption[]; mcpPresets: McpPreset[] }): string {
  const header = [
    '// Copilot Provider Bridge - user-editable provider catalog.',
    '//',
    '// While this file exists it overrides the extension\'s bundled defaults.',
    '// Each top-level section fully replaces the defaults for that section;',
    '// delete a section (or the whole file) to fall back to bundled defaults.',
    '// The file is watched - save to apply changes without restarting VS Code.',
    '//',
    '// Tips:',
    '// - "id" is a provider\'s stable identity. Renaming name/description is safe.',
    '//   Keep built-in ids (zai, deepseek, minimax, kimi, qwen, openrouter,',
    '//   nvidia) unchanged to keep usage/quota tracking working for them;',
    '//   custom providers serve models but have no usage fetcher.',
    '// - maxInputTokens is derived as contextWindow - maxOutputTokens when omitted.',
    '// - secretInput defaults to copilot-provider-bridge.<id>.apiKey. API keys are',
    '//   never stored here; they live in SecretStorage / chatLanguageModels.json.',
    '// - After updating the extension, run "Copilot Provider Bridge: Migrate',
    '//   Catalog" to rebase this file onto the newest verified defaults (your',
    '//   current file is backed up automatically).',
    '',
  ].join('\n');
  const body = JSON.stringify(
    {
      $version: CATALOG_SCHEMA_VERSION,
      providers: data.providers,
      visionBackends: data.visionBackends,
      mcpPresets: data.mcpPresets,
    },
    null,
    2
  );
  return `${header}${body}\n`;
}
