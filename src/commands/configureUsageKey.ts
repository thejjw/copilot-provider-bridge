// Command to securely store and verify provider API keys in extension SecretStorage
// for live quota tracking, balance display, and usage polling.

import * as vscode from 'vscode';
import type { ProviderId } from '../providers';
import { catalogStore } from '../catalog/store';
import { USAGE_SUPPORTED_IDS } from '../usage/fetchers';
import {
  fetchDeepseekUsage,
  fetchKimiUsage,
  fetchMinimaxUsage,
  fetchOpenrouterUsage,
  fetchZaiUsage,
} from '../usage/fetchers';
import type { UsageReport } from '../usage/types';

/**
 * Configure API key for a specific provider in extension SecretStorage.
 * Verifies the key with a live probe before saving.
 */
export async function configureUsageKeyCommand(
  context: vscode.ExtensionContext,
  preselectedProviderId?: ProviderId
): Promise<void> {
  let providerId = preselectedProviderId;

  if (!providerId) {
    const supportedProviders = catalogStore.get().providers.filter((p) =>
      (USAGE_SUPPORTED_IDS as readonly string[]).includes(p.id)
    );

    const pick = await vscode.window.showQuickPick(
      supportedProviders.map((p) => ({
        label: p.name,
        description: p.id,
        detail: `Configure key for ${p.name} usage, quota, and balance tracking`,
        providerId: p.id,
      })),
      {
        title: 'Copilot Provider Bridge: Configure Usage API Key',
        placeHolder: 'Select provider to configure usage API key',
        ignoreFocusOut: true,
      }
    );
    if (!pick) return;
    providerId = pick.providerId;
  }

  const secretKey = `copilot-provider-bridge.${providerId}.apiKey`;
  const existingKey =
    (await context.secrets.get(secretKey)) ??
    process.env[`${providerId.toUpperCase()}_API_KEY`];

  const provider = catalogStore.get().providers.find((p) => p.id === providerId);
  const providerName = provider?.name ?? providerId;

  const input = await vscode.window.showInputBox({
    title: `Copilot Provider Bridge: API Key for ${providerName}`,
    prompt: `Enter API key to enable live quota tracking and status bar display for ${providerName}`,
    placeHolder: existingKey ? '•••••••••••••••••••• (leave empty to keep current key)' : 'Enter API key...',
    password: true,
    ignoreFocusOut: true,
  });

  if (input === undefined) return; // user cancelled

  const newKey = input.trim();

  // If user submitted empty string and a key exists, keep existing; if no key exists, notify
  if (!newKey) {
    if (!existingKey) {
      void vscode.window.showWarningMessage(`No API key entered for ${providerName}.`);
    }
    return;
  }

  // Probe the key against provider's usage API
  const probePromise = async (): Promise<UsageReport> => {
    switch (providerId) {
      case 'zai':
        return await fetchZaiUsage(newKey);
      case 'deepseek':
        return await fetchDeepseekUsage(newKey);
      case 'minimax':
        return await fetchMinimaxUsage(newKey);
      case 'kimi':
        return await fetchKimiUsage(newKey);
      case 'openrouter':
        return await fetchOpenrouterUsage(newKey);
      default:
        return {
          providerId: providerId as ProviderId,
          providerName,
          status: 'ok' as const,
          details: [],
          lastUpdated: new Date(),
        };
    }
  };

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Verifying API key with ${providerName}...`,
      cancellable: false,
    },
    () => probePromise()
  );

  if (report.status === 'error') {
    const choice = await vscode.window.showWarningMessage(
      `Could not verify usage API for ${providerName} (${report.errorMessage ?? 'Request failed'}). Save anyway?`,
      'Save Anyway',
      'Cancel'
    );
    if (choice !== 'Save Anyway') return;
  }

  // Store in extension SecretStorage
  await context.secrets.store(secretKey, newKey);

  void vscode.window.showInformationMessage(
    `Saved API key for ${providerName}. Live quota tracking is now active in the status bar.`
  );

  // Trigger immediate status bar refresh
  await vscode.commands.executeCommand('copilot-provider-bridge.refreshUsage');
}
