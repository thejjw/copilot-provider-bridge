// Commands for the user-editable provider catalog file:
//   - Customize Catalog      (snapshot bundled defaults into the file)
//   - Open Catalog File      (reveal it, optionally creating it)
//   - Reload Catalog         (force a re-read)
//   - Reset Catalog          (delete it -> back to bundled defaults)
//   - Migrate Catalog        (rebase onto newest defaults with a backup)

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { serializeCatalogTemplate } from '../catalog/catalogFile';
import { DEFAULT_MCP_PRESETS, DEFAULT_PROVIDERS, DEFAULT_VISION_BACKENDS } from '../catalog/defaults';
import { catalogStore } from '../catalog/store';
import { Logger } from '../utils/logger';

/** Number of timestamped backups retained by migrate/customize flows. */
const BACKUP_KEEP = 3;
const BACKUP_NAME_PATTERN = /^copilot-provider-bridge\.backup-\d{8}-\d{6}\.jsonc$/;

async function catalogFileExists(): Promise<boolean> {
  try {
    await fs.access(catalogStore.filePath());
    return true;
  } catch {
    return false;
  }
}

function catalogUri(): vscode.Uri {
  return vscode.Uri.file(catalogStore.filePath());
}

/** Reveal the catalog file in the editor (column One unless requested otherwise). */
async function revealCatalogFile(viewColumn = vscode.ViewColumn.One): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(catalogUri());
  await vscode.window.showTextDocument(doc, { viewColumn });
}

/**
 * Byte-copy the current catalog file next to itself as
 * copilot-provider-bridge.backup-<yyyyMMdd-HHmmss>.jsonc and prune old backups.
 * The name deliberately does not match the watcher's exact-file pattern.
 */
async function backupCatalogFile(): Promise<string | undefined> {
  const file = catalogStore.filePath();
  const dir = path.dirname(file);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupPath = path.join(dir, `copilot-provider-bridge.backup-${stamp}.jsonc`);
  await fs.copyFile(file, backupPath);
  Logger.info(`Catalog backed up to ${backupPath}`);

  try {
    const backups = (await fs.readdir(dir))
      .filter((name) => BACKUP_NAME_PATTERN.test(name))
      .sort()
      .reverse();
    for (const stale of backups.slice(BACKUP_KEEP)) {
      await fs.rm(path.join(dir, stale));
      Logger.debug(`Pruned old catalog backup ${stale}`);
    }
  } catch (err) {
    Logger.warn(`Could not prune catalog backups`, err);
  }
  return backupPath;
}

/** Atomically write a fresh customization template from the bundled defaults. */
async function writeFreshTemplate(): Promise<void> {
  const file = catalogStore.filePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = serializeCatalogTemplate({
    providers: DEFAULT_PROVIDERS,
    visionBackends: DEFAULT_VISION_BACKENDS,
    mcpPresets: DEFAULT_MCP_PRESETS,
  });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
}

function formatErrorList(errors: { path: string; message: string }[]): string {
  return errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
}

/** Command: Copilot Provider Bridge: Customize Provider Catalog */
export async function customizeCatalogCommand(): Promise<void> {
  if (await catalogFileExists()) {
    const overwrite = await vscode.window.showWarningMessage(
      'A provider catalog customization file already exists. Overwrite it with the current bundled defaults? Your existing file will be backed up.',
      { modal: true },
      'Overwrite'
    );
    if (overwrite !== 'Overwrite') return;
    await backupCatalogFile();
  }
  await writeFreshTemplate();
  await catalogStore.reload();
  await revealCatalogFile();
  void vscode.window.showInformationMessage(
    'Provider catalog created from bundled defaults. Edit and save the file to customize providers, models, vision backends, and MCP presets.'
  );
}

/** Command: Copilot Provider Bridge: Open Provider Catalog File */
export async function openCatalogFileCommand(): Promise<void> {
  if (await catalogFileExists()) {
    await revealCatalogFile();
    return;
  }
  const create = await vscode.window.showInformationMessage(
    'No provider catalog customization file exists yet. Create one from the bundled defaults?',
    'Create from Defaults'
  );
  if (create === 'Create from Defaults') await customizeCatalogCommand();
}

/** Command: Copilot Provider Bridge: Reload Provider Catalog */
export async function reloadCatalogCommand(): Promise<void> {
  const outcome = await catalogStore.reload();
  if (outcome.ok) {
    const c = catalogStore.get();
    void vscode.window.showInformationMessage(
      `Provider catalog reloaded (${c.source === 'file' ? 'from file' : 'bundled defaults'}): ${c.providers.length} providers, ${c.visionBackends.length} vision backends, ${c.mcpPresets.length} MCP presets.`
    );
  } else if (outcome.errors && outcome.errors.length > 0) {
    Logger.error(`Catalog reload failed:\n${formatErrorList(outcome.errors)}`);
    const choice = await vscode.window.showWarningMessage(
      'Provider catalog file has errors - keeping the last-good catalog. See the Output Channel for details.',
      'Open File',
      'Open Log'
    );
    if (choice === 'Open File') await revealCatalogFile();
    else if (choice === 'Open Log') Logger.showChannel();
  }
}

/** Command: Copilot Provider Bridge: Reset Provider Catalog to Defaults */
export async function resetCatalogCommand(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Delete the provider catalog customization file and revert to the bundled defaults?',
    { modal: true },
    'Delete & Reset'
  );
  if (confirm !== 'Delete & Reset') return;
  try {
    await fs.rm(catalogStore.filePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      Logger.error('Failed to delete catalog file', err);
      void vscode.window.showErrorMessage('Could not delete the provider catalog file. See the Output Channel.');
      return;
    }
  }
  await catalogStore.reload();
  void vscode.window.showInformationMessage('Provider catalog deleted. Bundled defaults are active again.');
}

/**
 * Command: Copilot Provider Bridge: Migrate Provider Catalog
 * Backs up the current file, regenerates a fresh template from the newest
 * bundled defaults, opens both side-by-side, and switches the effective
 * catalog to the fresh defaults. Porting user edits is deliberately manual.
 */
export async function migrateCatalogCommand(): Promise<void> {
  if (!(await catalogFileExists())) {
    const create = await vscode.window.showInformationMessage(
      'No provider catalog customization file exists, so there is nothing to migrate. Create one from the bundled defaults?',
      'Create from Defaults'
    );
    if (create === 'Create from Defaults') await customizeCatalogCommand();
    return;
  }

  const backupPath = await backupCatalogFile();
  await writeFreshTemplate();
  await catalogStore.reload();

  const c = catalogStore.get();
  void vscode.window.showInformationMessage(
    `Catalog migrated to the newest built-in defaults (${c.providers.length} providers). Your previous file was kept as ${path.basename(backupPath ?? '')} - port your customizations over manually.`
  );

  if (backupPath) {
    const backupDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(backupPath));
    await vscode.window.showTextDocument(backupDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
  }
  await revealCatalogFile(vscode.ViewColumn.Two);
}

/**
 * Warn once per extension version when a catalog file predates the update.
 * The globalState version stamp doubles as the dismissal flag; storing the new
 * version happens unconditionally so the notice fires only on real updates.
 */
export async function runCatalogUpgradeNotice(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = String(context.extension.packageJSON.version ?? '');
  const lastVersion = context.globalState.get<string>('copilotProviderBridge.lastVersion');
  await context.globalState.update('copilotProviderBridge.lastVersion', currentVersion);

  if (!lastVersion || lastVersion === currentVersion) return;
  if (!(await catalogFileExists())) return;

  Logger.info(`Extension updated ${lastVersion} -> ${currentVersion} with an existing catalog file.`);
  const choice = await vscode.window.showWarningMessage(
    `Copilot Provider Bridge was updated (${lastVersion} -> ${currentVersion}). Your provider catalog file remains fully in effect, but it was customized against older built-in defaults - newer verified models/endpoints are not included.`,
    'Migrate Catalog…',
    'Open File'
  );
  if (choice === 'Open File') await revealCatalogFile();
  else if (choice === 'Migrate Catalog…') await migrateCatalogCommand();
}
