import * as vscode from 'vscode';
import { catalogStore } from '../catalog/store';
import type { Provider, ProviderModel } from '../providers';
import {
  findGroupIndex,
  providerToConfig,
  readConfig,
  userConfigPath,
  writeConfig,
} from '../config';
import { readMcpFile, userMcpConfigPath, workspaceMcpConfigPath, writeMcpFile } from './addMcp';
import { validateProviderKey } from './setup';
import { Logger } from '../utils/logger';
import { mergeMcpConfig } from '../mcpCatalog';

/**
 * Multi-step add flow:
 *   1. QuickPick provider
 *   2. Prompt for API key and validate it live
 *   3. QuickPick one or more models from that provider
 *   4. Merge or replace the provider group in chatLanguageModels.json
 *   5. If companion MCP tools exist for this provider, offer to install them into mcp.json
 *   6. Show confirmation
 */
export async function addModelCommand(context?: vscode.ExtensionContext): Promise<void> {
  const providerPick = await vscode.window.showQuickPick(
    catalogStore.get().providers.map((p) => ({
      label: p.name,
      description: `${p.models.length} model${p.models.length === 1 ? '' : 's'} (${p.apiType})`,
      detail: p.description,
      provider: p,
    })),
    {
      title: 'Copilot Provider Bridge - Add Model: Select Provider',
      placeHolder: 'Choose a coding-plan provider',
      ignoreFocusOut: true,
    }
  );
  if (!providerPick) return;
  const provider: Provider = providerPick.provider;

  Logger.debug(`Selected provider: ${provider.name} (${provider.id})`);
  // Prompt and validate API key
  let keyValidated = false;
  let keyToUse: string | undefined;
  const secretKey = `copilot-provider-bridge.${provider.id}.apiKey`;

  while (!keyValidated && context) {
    const existingSecret = await context.secrets.get(secretKey);
    const existingEnv = process.env[`${provider.id.toUpperCase()}_API_KEY`];
    const existingKey = existingSecret ?? existingEnv;

    const inputKey = await vscode.window.showInputBox({
      title: `Copilot Provider Bridge: API Key for ${provider.name}`,
      prompt: existingKey
        ? `Detected existing key (${Logger.maskSecret(existingKey)}). Press Enter to test & keep, or enter new key:`
        : `Enter your ${provider.name} API key (stored securely in SecretStorage):`,
      placeHolder: existingKey ? '•••••••••••• (press Enter to keep existing key)' : 'Enter API key...',
      password: true,
      ignoreFocusOut: true,
    });

    if (inputKey === undefined) return; // user cancelled
    keyToUse = inputKey.trim() || existingKey;

    if (!keyToUse) {
      const skipChoice = await vscode.window.showWarningMessage(
        `No API key entered for ${provider.name}. Save placeholder anyway?`,
        'Save Placeholder',
        'Cancel'
      );
      if (skipChoice !== 'Save Placeholder') return;
      break;
    }

    const currentKey = keyToUse;
    const validation = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Validating ${provider.name} API key...`,
        cancellable: false,
      },
      () => validateProviderKey(provider, currentKey)
    );
    if (validation.ok) {
      await context.secrets.store(secretKey, keyToUse);
      Logger.info(`[Add Model] ${provider.name}: API key validated successfully.`);
      keyValidated = true;
    } else {
      Logger.warn(`[Add Model] ${provider.name} validation failed: ${validation.message}`);
      const retryChoice = await vscode.window.showWarningMessage(
        `Validation failed for ${provider.name}: ${validation.message}. What would you like to do?`,
        { modal: true },
        'Try Key Again',
        'Save Anyway',
        'Cancel'
      );

      if (retryChoice === 'Save Anyway') {
        await context.secrets.store(secretKey, keyToUse);
        keyValidated = true;
      } else if (retryChoice !== 'Try Key Again') {
        return;
      }
    }
  }

  const modelPick = await vscode.window.showQuickPick(
    provider.models.map((m) => ({
      label: m.name,
      description: m.id,
      detail: `tools: ${m.toolCalling ? 'yes' : 'no'}  |  vision: ${m.vision ? 'yes' : 'no'}  |  thinking: ${m.thinking ? (m.supportsReasoningEffort?.join('/') ?? 'yes') : 'no'}  |  ctx: ${m.contextWindow.toLocaleString()} (in: ${m.maxInputTokens.toLocaleString()} / out: ${m.maxOutputTokens.toLocaleString()})`,
      picked: true,
      model: m,
    })),
    {
      title: `Copilot Provider Bridge - ${provider.name}: Select Models`,
      placeHolder: 'Choose one or more models to add (Enter to confirm)',
      ignoreFocusOut: true,
      canPickMany: true,
    }
  );
  if (!modelPick || modelPick.length === 0) return;
  const models: ProviderModel[] = modelPick.map((p) => p.model);

  // Merge into the existing file. If we already wrote a group for this provider, replace it.
  const cfg = await readConfig();
  const idx = findGroupIndex(cfg, provider.id);
  const group = providerToConfig(provider, models, keyToUse);
  if (idx >= 0) cfg[idx] = group;
  else cfg.push(group);

  await writeConfig(cfg);
  Logger.info(`Wrote ${models.length} models for ${provider.name} to chatLanguageModels.json`);

  if (context) {
    void vscode.commands.executeCommand('copilot-provider-bridge.refreshUsage');
  }

  // Step A: Check for companion MCP tools for this provider
  const companionPresets = catalogStore.get().mcpPresets.filter((preset) => preset.providerId === provider.id);
  if (companionPresets.length > 0) {
    const mcpChoice = await vscode.window.showQuickPick(
      [
        {
          label: `$(plug) Install Companion MCP Tools (${companionPresets.length} tools)`,
          description: companionPresets.map((p) => p.name).join(', '),
          action: 'install',
        },
        {
          label: '$(arrow-right) Skip MCP Tools',
          description: 'Proceed without adding MCP servers',
          action: 'skip',
        },
      ],
      {
        title: `Copilot Provider Bridge - Companion MCP Tools for ${provider.name}`,
        placeHolder: 'Would you like to install companion MCP servers for this provider?',
      }
    );

    if (mcpChoice?.action === 'install') {
      const wsPath = workspaceMcpConfigPath();
      const targetOptions = [
        {
          label: '$(globe) User Profile (Global)',
          description: userMcpConfigPath(),
          detail: 'Available across all workspaces.',
          path: userMcpConfigPath(),
        },
      ];
      if (wsPath) {
        targetOptions.push({
          label: '$(folder) Current Workspace Folder',
          description: wsPath,
          detail: 'Available only in this workspace (.vscode/mcp.json).',
          path: wsPath,
        });
      }

      const targetPick = await vscode.window.showQuickPick(targetOptions, {
        title: `Copilot Provider Bridge - Choose MCP Target File`,
        placeHolder: 'Select target mcp.json file',
        ignoreFocusOut: true,
      });

      if (targetPick) {
        const existingMcp = await readMcpFile(targetPick.path);
        const mergedMcp = mergeMcpConfig(existingMcp, companionPresets);
        await writeMcpFile(targetPick.path, mergedMcp);
        Logger.info(`Installed ${companionPresets.length} companion MCP tools for ${provider.name} into ${targetPick.path}`);
      }
    }
  }

  const msg = `Added ${provider.name} (${models.length} model${models.length === 1 ? '' : 's'}) to chatLanguageModels.json. All models are ready to use in Copilot Chat immediately.`;
  void vscode.window.showInformationMessage(
    msg,
    'Reveal chatLanguageModels.json'
  ).then(async (action) => {
    if (action === 'Reveal chatLanguageModels.json') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(userConfigPath()));
    }
  });
}
