// Reset command for Copilot Provider Bridge.
// Clears all extension secrets in SecretStorage, resets globalState,
// removes Bridge provider groups from chatLanguageModels.json,
// and removes companion MCP servers from mcp.json.

import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { readConfig, writeConfig, userConfigPath } from '../config';
import { catalogStore } from '../catalog/store';
import { readMcpFile, userMcpConfigPath, workspaceMcpConfigPath, writeMcpFile } from './addMcp';
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
          const filtered = parsed.filter(
            (g) =>
              !g.apiKey?.includes('copilot-provider-bridge.') &&
              !catalogStore.get().providers.some((p) => g.name === p.name)
          );
          await fs.writeFile(targetConfig, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
          Logger.info(`Cleaned chatLanguageModels.json at ${targetConfig}`);
        }
      }
    }
  } catch (err) {
    Logger.warn(`Could not clean config file ${targetConfig}`, err);
  }

  // 4. Remove companion MCP servers from user and workspace mcp.json
  const targetMcpPaths = options?.customMcpPaths ?? [
    userMcpConfigPath(),
    ...(workspaceMcpConfigPath() ? [workspaceMcpConfigPath()!] : []),
  ];

  const effectivePresets = catalogStore.get().mcpPresets;
  const knownMcpKeys = new Set(effectivePresets.map((p) => p.serverKey));
  const knownInputIds = new Set(effectivePresets.flatMap((p) => p.inputs.map((i) => i.id)));

  for (const p of targetMcpPaths) {
    try {
      const mcpCfg = await readMcpFile(p);
      if (mcpCfg) {
        let changed = false;
        const newServers = { ...mcpCfg.servers };
        for (const k of Object.keys(newServers)) {
          if (knownMcpKeys.has(k)) {
            delete newServers[k];
            changed = true;
          }
        }
        let newInputs = mcpCfg.inputs ? [...mcpCfg.inputs] : undefined;
        if (newInputs) {
          const beforeLen = newInputs.length;
          newInputs = newInputs.filter((i) => !knownInputIds.has(i.id));
          if (newInputs.length !== beforeLen) {
            changed = true;
          }
        }
        if (changed) {
          mcpCfg.servers = newServers;
          if (newInputs && newInputs.length > 0) {
            mcpCfg.inputs = newInputs;
          } else {
            delete mcpCfg.inputs;
          }
          await writeMcpFile(p, mcpCfg);
          Logger.info(`Cleaned companion MCP servers from ${p}`);
        }
      }
    } catch (err) {
      Logger.warn(`Could not clean MCP file ${p}`, err);
    }
  }

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
