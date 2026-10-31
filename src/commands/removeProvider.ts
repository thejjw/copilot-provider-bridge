import * as vscode from 'vscode';
import { hasAnyBridgeGroup, providerIdForConfigGroup, readConfig, writeConfig } from '../config';

/**
 * Remove a previously-added bridge group from chatLanguageModels.json.
 * Refuses to remove groups that weren't created by this extension (the apiKey
 * placeholder contains the `copilot-provider-bridge.` marker).
 */
export async function removeModelCommand(): Promise<void> {
  const cfg = await readConfig();

  if (!hasAnyBridgeGroup(cfg)) {
    void vscode.window.showInformationMessage(
      'Copilot Provider Bridge: no managed provider groups found. Use "Add Model" first.',
    );
    return;
  }

  const picks = cfg
    .map((g, i) => ({ group: g, index: i }))
    .filter(({ group }) => providerIdForConfigGroup(group) !== undefined)
    .map(({ group, index }) => ({
      label: group.name,
      description: `${group.models.length} model${group.models.length === 1 ? '' : 's'}`,
      detail: group.models.map((m) => m.name).join(', '),
      index,
    }));

  const pick = await vscode.window.showQuickPick(picks, {
    title: 'Copilot Provider Bridge - Remove Model',
    placeHolder: 'Choose a provider group to remove',
    ignoreFocusOut: true,
  });
  if (!pick) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove "${pick.label}" from chatLanguageModels.json? The API key remains in VS Code secret storage but will no longer be referenced.`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;

  cfg.splice(pick.index, 1);
  await writeConfig(cfg);

  void vscode.window.showInformationMessage(
    `Copilot Provider Bridge: removed "${pick.label}". Restart VS Code for the change to take effect.`,
  );
}
