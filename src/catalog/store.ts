// Effective-catalog store: merges the optional user-editable catalog file over
// the bundled defaults, watches the file for changes, and exposes the merged
// view plus a change event. All consumers read the catalog through this store
// instead of importing the bundled constants directly.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { userConfigPath } from '../config';
import { Logger } from '../utils/logger';
import { DEFAULT_MCP_PRESETS, DEFAULT_PROVIDERS, DEFAULT_VISION_BACKENDS } from './defaults';
import {
  CATALOG_FILE_NAME,
  catalogPathFor,
  readCatalogFile,
  type CatalogError,
  type CatalogFileSections,
} from './catalogFile';

export interface EffectiveCatalog {
  providers: typeof DEFAULT_PROVIDERS;
  visionBackends: typeof DEFAULT_VISION_BACKENDS;
  mcpPresets: typeof DEFAULT_MCP_PRESETS;
  /** 'file' when at least one section is overridden by the user's catalog file. */
  source: 'defaults' | 'file';
}

/** Fill absent sections from the bundled defaults (whole-section replacement). */
export function mergeWithDefaults(sections: CatalogFileSections): EffectiveCatalog {
  return {
    providers: sections.providers ?? DEFAULT_PROVIDERS,
    visionBackends: sections.visionBackends ?? DEFAULT_VISION_BACKENDS,
    mcpPresets: sections.mcpPresets ?? DEFAULT_MCP_PRESETS,
    source:
      sections.providers || sections.visionBackends || sections.mcpPresets
        ? 'file'
        : 'defaults',
  };
}

export interface ReloadOutcome {
  ok: boolean;
  errors?: CatalogError[];
}

class CatalogStore {
  private current: EffectiveCatalog = mergeWithDefaults({});
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the effective catalog changed (file saved, created, or deleted). */
  readonly onDidChange = this.emitter.event;
  private debounce?: NodeJS.Timeout;

  /** Current effective catalog (defaults overlaid with validated file sections). */
  get(): EffectiveCatalog {
    return this.current;
  }

  /** Absolute path of the user-editable catalog file (public seam for catalog commands). */
  filePath(): string {
    return catalogPathFor(path.dirname(userConfigPath()));
  }

  /** Re-read the catalog file. On errors the last-good catalog is kept. */
  async reload(): Promise<ReloadOutcome> {
    let result;
    try {
      result = await readCatalogFile(this.filePath(), DEFAULT_PROVIDERS.map((p) => p.id));
    } catch (e) {
      Logger.error('Failed to read catalog file', e);
      return { ok: false, errors: [{ path: this.filePath(), message: String(e) }] };
    }

    if (result.status === 'absent') {
      if (this.current.source !== 'defaults') Logger.info('Catalog file removed - reverting to bundled defaults.');
      this.current = mergeWithDefaults({});
      this.emitter.fire();
      return { ok: true };
    }

    if (result.status === 'error') {
      Logger.warn(
        'Catalog file has errors - keeping last-good catalog',
        result.errors.map((e) => `${e.path}: ${e.message}`)
      );
      return { ok: false, errors: result.errors };
    }

    for (const w of result.warnings) Logger.warn(`Catalog file: ${w}`);
    this.current = mergeWithDefaults(result.sections);
    const c = this.current;
    Logger.info(
      `Catalog loaded from file: ${c.providers.length} providers / ${c.providers.reduce((n, p) => n + p.models.length, 0)} models / ${c.visionBackends.length} vision backends / ${c.mcpPresets.length} MCP presets`
    );
    this.emitter.fire();
    return { ok: true };
  }

  /** Resolve the file path, register the watcher, and perform the initial load. */
  async init(context: vscode.ExtensionContext): Promise<void> {
    const dir = path.dirname(userConfigPath());
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), CATALOG_FILE_NAME)
    );
    const schedule = (): void => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        void this.reload();
      }, 300);
    };
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    // Deletion falls back to bundled defaults via reload()'s ENOENT handling.
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher, this.emitter);
    await this.reload();
  }
}

/** Singleton store shared by all commands, tools, and the status bar. */
export const catalogStore = new CatalogStore();
