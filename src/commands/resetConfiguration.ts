// Reset command for Copilot Provider Bridge.
// Clears all extension secrets in SecretStorage, resets globalState,
// removes Bridge provider groups from chatLanguageModels.json,
// and removes the extension-managed MCP presets plus their legacy mcp.json entries.

import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { providerIdForConfigGroup, readConfig, writeConfig, userConfigPath } from '../config';
import { queueSealedSecretDeletion } from '../credentials/sealedMode';
import { catalogStore } from '../catalog/store';
import { cleanupLegacyMcpFile } from '../mcpLegacy';
import {
  MCP_MIGRATION_STATE_KEY,
  MCP_PRESET_IDS_STATE_KEY,
  refreshBridgeMcpServers,
} from '../mcpServerProvider';
import { userMcpConfigPath, workspaceMcpConfigPaths } from '../utils/userPaths';
import { Logger } from '../utils/logger';

export interface ResetOptions {
  customConfigPath?: string;
  customMcpPaths?: string[];
}

/** Core reset logic that operates on explicit paths (or defaults to production user paths). */
export async function resetCopilotProviderBridgeState(
  context: vscode.ExtensionContext,
  options?: ResetOptions
): Promise<{ clearedSecretsCount: number }> {
  Logger.info('=== Starting Copilot Provider Bridge State Reset ===');

  // 1. Clear Extension Secrets
  let clearedSecretsCount = 0;
  for (const p of catalogStore.get().providers) {
    const secretKey = `copilot-provider-bridge.${p.id}.apiKey`;
    await context.secrets.delete(secretKey);
    clearedSecretsCount++;
  }
  Logger.info(`Cleared ${clearedSecretsCount} API keys from Extension SecretStorage.`);

  // 2. Clear globalState keys
  await context.globalState.update('copilotProviderBridge.hasRunSetup', undefined);
  await context.globalState.update('copilotProviderBridge.hasPromptedSetup', undefined);
  await context.globalState.update('copilotProviderBridge.pinnedProvider', undefined);
  await context.globalState.update('copilotProviderBridge.preferredVisionModel', undefined);
  await context.globalState.update(MCP_PRESET_IDS_STATE_KEY, undefined);
  await context.globalState.update(MCP_MIGRATION_STATE_KEY, undefined);
  Logger.info('Cleared Copilot Provider Bridge globalState entries.');

  // 3. Remove Bridge provider groups from chatLanguageModels.json
  const targetConfig = options?.customConfigPath ?? userConfigPath();
  try {
    const raw = await fs.readFile(targetConfig, 'utf8').catch(() => null);
    if (raw) {
      const clean = raw.replace(/^\uFEFF/, '').trim();
      if (clean) {
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((g) => providerIdForConfigGroup(g) === undefined);
          await fs.writeFile(targetConfig, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
          Logger.info(`Cleaned chatLanguageModels.json at ${targetConfig}`);
        }
      }
    }
  } catch (err) {
    Logger.warn(`Could not clean config file ${targetConfig}`, err);
  }

  // 4. Remove extension-managed MCP presets and their legacy mcp.json entries
  const targetMcpPaths = options?.customMcpPaths ?? [userMcpConfigPath(), ...workspaceMcpConfigPaths()];
  for (const p of targetMcpPaths) {
    try {
      const result = await cleanupLegacyMcpFile(p, catalogStore.get().mcpPresets, { requireMatch: false });
      if (result.changed) Logger.info(`Cleaned legacy MCP entries from ${p}`);
    } catch (err) {
      Logger.warn(`Could not clean MCP file ${p}`, err);
    }
  }
  refreshBridgeMcpServers();

  // Sealed rows outlive the JSON groups; queue their deletion for editor exit.
  await queueSealedSecretDeletion(
    context,
    catalogStore.get().providers.map((provider) => provider.id)
  );

  return { clearedSecretsCount };
}

export async function resetConfigurationCommand(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Are you sure you want to reset Copilot Provider Bridge? This will clear all API keys stored in extension SecretStorage, remove bridge model groups from chatLanguageModels.json, and remove companion MCP servers.',
    { modal: true },
    'Reset Bridge Configuration',
    'Cancel'
  );

  if (confirm !== 'Reset Bridge Configuration') {
    return;
  }

  // Offer to also delete the user-editable provider catalog file (if present).
  let catalogDeleted = false;
  try {
    await fs.access(catalogStore.filePath());
    const deleteCatalog = await vscode.window.showWarningMessage(
      'A provider catalog customization file was found. Also delete it so the bundled defaults are restored?',
      { modal: true },
      'Delete Catalog File'
    );
    if (deleteCatalog === 'Delete Catalog File') {
      await fs.rm(catalogStore.filePath());
      await catalogStore.reload();
      catalogDeleted = true;
      Logger.info('Provider catalog customization file deleted during reset.');
    }
  } catch {
    // No catalog file present (or already gone) - nothing to offer.
  }

  await resetCopilotProviderBridgeState(context);

  // Refresh status bar
  void vscode.commands.executeCommand('copilot-provider-bridge.refreshUsage');

  const action = await vscode.window.showInformationMessage(
    `Copilot Provider Bridge extension configuration and secrets have been cleared.${catalogDeleted ? ' Provider catalog file deleted; bundled defaults restored.' : ''}`,
    'Run Quick Setup Now',
    'Reveal chatLanguageModels.json'
  );

  if (action === 'Run Quick Setup Now') {
    await vscode.commands.executeCommand('copilot-provider-bridge.quickSetup');
  } else if (action === 'Reveal chatLanguageModels.json') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(userConfigPath()));
  }
}
