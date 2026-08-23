import * as vscode from 'vscode';
import type { Provider } from '../providers';
import { catalogStore } from '../catalog/store';
import { findGroupIndex, providerToConfig, readConfig, writeConfig, userConfigPath } from '../config';
import { mergeMcpConfig, type McpPreset } from '../mcpCatalog';
import { readMcpFile, userMcpConfigPath, workspaceMcpConfigPath, writeMcpFile } from './addMcp';
import { Logger } from '../utils/logger';

/** Validate an API key against a provider's live endpoint. */
export async function validateProviderKey(
  provider: Provider,
  key: string
): Promise<{ ok: boolean; message?: string }> {
  try {
    const testModel = provider.models[0];
    if (!testModel) return { ok: true };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(provider.requestHeaders ?? {}),
      ...(testModel.requestHeaders ?? {}),
    };

    // Replace ${apiKey} placeholder with real key
    for (const k of Object.keys(headers)) {
      headers[k] = headers[k].replace('${apiKey}', key);
    }

    const payload = {
      model: testModel.id,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(testModel.url ?? provider.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      return { ok: true };
    }

    const errText = await res.text();
    let parsedMsg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(errText) as {
        error?: { message?: string; status?: string };
        msg?: string;
        message?: string;
      };
      parsedMsg = j.error?.message ?? j.msg ?? j.message ?? j.error?.status ?? parsedMsg;
    } catch {
      parsedMsg = errText ? errText.substring(0, 150) : parsedMsg;
    }

    if (provider.id === 'openrouter' && (parsedMsg.includes('Key limit exceeded') || res.status === 403)) {
      parsedMsg = `OpenRouter key limit is $0.00 or exceeded. Manage credit limits at https://openrouter.ai/settings/keys (or click 'Skip Provider').`;
    } else if (provider.id === 'gemini' && (res.status === 429 || parsedMsg.includes('RESOURCE_EXHAUSTED'))) {
      parsedMsg = `Google AI Studio quota / rate limit reached (HTTP 429). Check your Google AI Studio plan/billing or click 'Skip Provider'.`;
    }

    return { ok: false, message: parsedMsg };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * First-Time Setup / Quickstart Wizard:
 *   1. Pick which coding plan providers to enable (Z.ai, DeepSeek, MiniMax, Kimi, Qwen, Gemini, OpenRouter, NVIDIA).
 *   2. Prompt for API keys immediately for each selected provider with live validation.
 *   3. Configure models in chatLanguageModels.json ONLY for validated/confirmed providers.
 *   4. Pick companion MCP tools grouped by the validated providers.
 *   5. Select MCP target (User Profile vs Workspace Folder).
 *   6. Safely merge and write both configuration files.
 */
export async function quickSetupCommand(context?: vscode.ExtensionContext): Promise<void> {
  Logger.info('Running Copilot Provider Bridge Quick Setup Wizard...');

  // Step 1: Select Providers
  const providerPicks = await vscode.window.showQuickPick(
    catalogStore.get().providers.map((p) => ({
      label: p.name,
      description: `${p.models.length} verified model${p.models.length === 1 ? '' : 's'} (${p.apiType})`,
      detail: p.description,
      picked: true,
      provider: p,
    })),
    {
      title: 'Copilot Provider Bridge: Quick Setup (1/3) - Select Providers',
      placeHolder: 'Choose which providers you have subscriptions/keys for (Enter to confirm)',
      ignoreFocusOut: true,
      canPickMany: true,
    }
  );
  if (!providerPicks || providerPicks.length === 0) return;

  const selectedProviders: Provider[] = providerPicks.map((p) => p.provider);
  Logger.debug(`Selected ${selectedProviders.length} providers for setup`);

  // Step 2: Prompt and Validate API Keys for each selected provider
  const validatedProviders: Provider[] = [];
  const validatedKeys = new Map<string, string>();
  for (let i = 0; i < selectedProviders.length; i++) {
    const p = selectedProviders[i];
    let keyValidated = false;

    while (!keyValidated) {
      const secretKey = `copilot-provider-bridge.${p.id}.apiKey`;
      const existingSecret = context ? await context.secrets.get(secretKey) : undefined;
      const existingEnv = process.env[`${p.id.toUpperCase()}_API_KEY`];
      const existingKey = existingSecret ?? existingEnv;

      const inputKey = await vscode.window.showInputBox({
        title: `Copilot Provider Bridge Setup: API Key for ${p.name} (${i + 1}/${selectedProviders.length})`,
        prompt: existingKey
          ? `Detected existing key (${Logger.maskSecret(existingKey)}). Press Enter to test & keep, or enter new key:`
          : `Enter your API key for ${p.name} (Leave empty to skip & disable this provider):`,
        placeHolder: existingKey ? '•••••••••••• (press Enter to keep existing key)' : 'Enter API key (or leave empty to skip)...',
        password: true,
        ignoreFocusOut: true,
      });

      if (inputKey === undefined) {
        // User pressed Esc on input box - ask if they want to cancel wizard or skip this provider
        const cancelChoice = await vscode.window.showQuickPick(
          [
            { label: `Skip ${p.name}`, description: 'Do not configure this provider, proceed with remaining setup', action: 'skip' },
            { label: 'Cancel Setup Wizard', description: 'Abort entire setup process', action: 'abort' },
          ],
          { title: `Setup: Skipped ${p.name}` }
        );
        if (cancelChoice?.action === 'abort' || !cancelChoice) {
          Logger.info('User cancelled setup wizard.');
          return;
        }
        break; // skip this provider
      }

      const keyToUse = inputKey.trim() || existingKey;

      if (!keyToUse) {
        Logger.info(`No API key entered for ${p.name} -- skipping provider.`);
        void vscode.window.showInformationMessage(`Skipped ${p.name} (no API key provided).`);
        break;
      }

      // Live validation probe
      const validation = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Validating ${p.name} API key...`,
          cancellable: false,
        },
        () => validateProviderKey(p, keyToUse)
      );

      if (validation.ok) {
        if (context) {
          await context.secrets.store(secretKey, keyToUse);
        }
        Logger.info(`[Setup] ${p.name}: API key validated successfully.`);
        validatedProviders.push(p);
        validatedKeys.set(p.id, keyToUse);
        keyValidated = true;
      } else {
        Logger.warn(`[Setup] ${p.name} validation failed: ${validation.message}`);
        const retryChoice = await vscode.window.showWarningMessage(
          `Validation failed for ${p.name}: ${validation.message}. What would you like to do?`,
          { modal: true },
          'Try Key Again',
          'Save Anyway',
          'Skip Provider'
        );

        if (retryChoice === 'Save Anyway') {
          if (context) {
            await context.secrets.store(secretKey, keyToUse);
          }
          validatedProviders.push(p);
          validatedKeys.set(p.id, keyToUse);
          keyValidated = true;
        } else if (retryChoice === 'Skip Provider' || !retryChoice) {
          Logger.info(`Skipping ${p.name} after failed validation.`);
          break;
        }
      }
    }
  }

  if (validatedProviders.length === 0) {
    void vscode.window.showWarningMessage(
      'No providers were configured (all providers were skipped or lacked valid keys). Run Quick Setup anytime from the Command Palette.'
    );
    return;
  }

  // Step 3: Configure models in chatLanguageModels.json for VALIDATED providers only
  const cfg = await readConfig();
  let totalModelsAdded = 0;

  for (const p of validatedProviders) {
    const key = validatedKeys.get(p.id);
    const group = providerToConfig(p, p.models, key);
    const existingIdx = findGroupIndex(cfg, p.id);
    if (existingIdx >= 0) {
      cfg[existingIdx] = group;
    } else {
      cfg.push(group);
    }
    totalModelsAdded += p.models.length;
  }
  await writeConfig(cfg);
  Logger.info(`Configured ${totalModelsAdded} models in chatLanguageModels.json for ${validatedProviders.length} validated providers`);
  // Step 4: Check for companion MCP tools for validated providers
  const companionMcpPresets: McpPreset[] = [];
  for (const p of validatedProviders) {
    const presets = catalogStore.get().mcpPresets.filter((preset) => preset.providerId === p.id);
    companionMcpPresets.push(...presets);
  }

  let mcpInstalledCount = 0;
  if (companionMcpPresets.length > 0) {
    // Show grouped QuickPick for MCP tools
    const mcpPicks = await vscode.window.showQuickPick(
      companionMcpPresets.map((preset) => {
        const prov = validatedProviders.find((p) => p.id === preset.providerId);
        return {
          label: preset.name,
          description: `[${prov?.name ?? preset.providerId}] ${preset.server.type === 'http' ? '$(cloud) HTTP SSE' : '$(terminal) stdio'}`,
          detail: preset.description,
          picked: true,
          preset,
        };
      }),
      {
        title: 'Copilot Provider Bridge: Quick Setup (2/3) - Select Companion MCP Tools',
        placeHolder: 'Choose companion MCP tools to install (or deselect all to skip)',
        ignoreFocusOut: true,
        canPickMany: true,
      }
    );

    if (mcpPicks && mcpPicks.length > 0) {
      const selectedMcp = mcpPicks.map((p) => p.preset);

      // Step 5: Choose Target for MCP config
      const wsPath = workspaceMcpConfigPath();
      const targetOptions = [
        {
          label: '$(globe) User Profile (Global)',
          description: userMcpConfigPath(),
          detail: 'Available across all workspaces on this machine.',
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
        title: 'Copilot Provider Bridge: Quick Setup (3/3) - Choose MCP Target File',
        placeHolder: 'Where should the mcp.json configuration be saved?',
        ignoreFocusOut: true,
      });

      if (targetPick) {
        const existingMcp = await readMcpFile(targetPick.path);
        const mergedMcp = mergeMcpConfig(existingMcp, selectedMcp);
        await writeMcpFile(targetPick.path, mergedMcp);
        mcpInstalledCount = selectedMcp.length;
        Logger.info(`Installed ${mcpInstalledCount} MCP servers into ${targetPick.path}`);
      }
    }
  }

  if (context) {
    await context.globalState.update('copilotProviderBridge.hasRunSetup', true);
    await context.globalState.update('copilotProviderBridge.hasPromptedSetup', true);
    void vscode.commands.executeCommand('copilot-provider-bridge.refreshUsage');
  }

  const msg =
    `Setup complete! Configured ${totalModelsAdded} model${totalModelsAdded === 1 ? '' : 's'} across ${validatedProviders.length} provider${validatedProviders.length === 1 ? '' : 's'}` +
    (mcpInstalledCount > 0 ? ` and ${mcpInstalledCount} companion MCP server${mcpInstalledCount === 1 ? '' : 's'}.` : '.') +
    ` All models are ready to use in Copilot Chat immediately.`;

  void vscode.window.showInformationMessage(
    msg,
    'Reveal chatLanguageModels.json'
  ).then(async (action) => {
    if (action === 'Reveal chatLanguageModels.json') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(userConfigPath()));
    }
  });
}
