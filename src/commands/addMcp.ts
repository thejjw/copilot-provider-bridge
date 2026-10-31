// MCP preset installation commands, backed by globalState instead of mcp.json.
// The presets themselves are resolved at runtime by mcpServerProvider.ts.

import * as vscode from 'vscode';
import { catalogStore } from '../catalog/store';
import { computeNextPresetIds, type McpPreset } from '../mcpCatalog';
import {
  getInstalledPresetIds,
  presetNeedsKey,
  providerKeyFor,
  refreshBridgeMcpServers,
  secretKeyForProvider,
  setInstalledPresetIds,
} from '../mcpServerProvider';
import { Logger } from '../utils/logger';

/**
 * Make sure every keyed preset has an API key available, prompting once per
 * provider. Keyless presets are always kept; providers the user declines are
 * dropped from the returned set.
 */
export async function ensureMcpKeys(
  context: vscode.ExtensionContext,
  presets: readonly McpPreset[]
): Promise<McpPreset[]> {
  const keyless = presets.filter((preset) => !presetNeedsKey(preset));
  const keyedByProvider = new Map<string, McpPreset[]>();
  for (const preset of presets) {
    if (!presetNeedsKey(preset)) continue;
    const group = keyedByProvider.get(preset.providerId) ?? [];
    group.push(preset);
    keyedByProvider.set(preset.providerId, group);
  }

  const kept: McpPreset[] = [...keyless];
  for (const [providerId, group] of keyedByProvider) {
    if ((await providerKeyFor(context, providerId)) !== undefined) {
      kept.push(...group);
      continue;
    }

    const providerName = catalogStore.get().providers.find((p) => p.id === providerId)?.name ?? providerId;
    const input = await vscode.window.showInputBox({
      title: `Copilot Provider Bridge: API Key for ${providerName}`,
      prompt: `Required for ${group.length} MCP tool(s). Stored in SecretStorage.`,
      password: true,
      ignoreFocusOut: true,
    });

    const key = input?.trim();
    if (!key) {
      Logger.warn(`No API key entered for ${providerName}; skipping ${group.length} MCP server(s).`);
      continue;
    }
    await context.secrets.store(secretKeyForProvider(providerId), key);
    kept.push(...group);
  }
  return kept;
}

/**
 * Install (or set) the extension-managed MCP presets. Prompts for missing keys
 * first, then persists the resulting id list and asks VS Code to re-query.
 * Returns the number of presets actually installed.
 */
export async function installMcpPresets(
  context: vscode.ExtensionContext,
  presets: readonly McpPreset[],
  mode: 'replace' | 'merge'
): Promise<number> {
  const ready = await ensureMcpKeys(context, presets);
  const installed = getInstalledPresetIds(context);
  const next = computeNextPresetIds(
    installed,
    ready.map((preset) => preset.id),
    mode
  );
  const persisted = await setInstalledPresetIds(context, next);
  refreshBridgeMcpServers();
  Logger.info(`MCP presets now configured (${mode}): ${persisted.join(', ') || 'none'}`);
  return persisted.length;
}

/** Command: Copilot Provider Bridge: Configure MCP Tools */
export async function configureMcpCommand(context: vscode.ExtensionContext): Promise<void> {
  const installed = new Set(getInstalledPresetIds(context));
  const picks = await vscode.window.showQuickPick(
    catalogStore.get().mcpPresets.map((preset) => ({
      label: preset.name,
      description: preset.server.type === 'http' ? '$(cloud) HTTP' : '$(terminal) stdio',
      detail: preset.description,
      picked: installed.has(preset.id),
      preset,
    })),
    {
      title: 'Copilot Provider Bridge: Configure MCP Tools',
      placeHolder: 'Choose one or more MCP server presets (Enter to confirm)',
      ignoreFocusOut: true,
      canPickMany: true,
    }
  );
  if (!picks) return;

  const count = await installMcpPresets(
    context,
    picks.map((pick) => pick.preset),
    'replace'
  );
  void vscode.window.showInformationMessage(
    `Configured ${count} MCP server(s). Available in chat and Copilot agent sessions; keys are stored in SecretStorage.`
  );
}
