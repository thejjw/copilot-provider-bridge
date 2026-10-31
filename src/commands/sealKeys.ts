import * as vscode from 'vscode';
import { readConfig } from '../config';
import {
  applySealedUpdate,
  collectSealableProviders,
  currentSealedPreflight,
} from '../credentials/sealedMode';
import { Logger } from '../utils/logger';

/**
 * Optional, opt-in command: move Custom Endpoint keys into core's encrypted
 * storage and replace the JSON values with pointers. The helper finishes after
 * VS Code exits; the next startup reports the outcome.
 */
export async function sealModelKeysCommand(context: vscode.ExtensionContext): Promise<void> {
  const preflight = currentSealedPreflight();
  if (!preflight.ok) {
    void vscode.window.showWarningMessage(`Copilot Provider Bridge: ${preflight.reason}`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    'Seal API keys (optional): each provider key is moved out of chatLanguageModels.json into the same encrypted storage VS Code uses for "Update API Key". The file keeps only a pointer. ' +
      'This protects the file, its backups, and an editor opened on it, but a process running as the same Windows user can still decrypt the stored key. ' +
      'Windows x64 stable Code only. An unsigned helper may trigger SmartScreen once. VS Code must be closed for the helper to finish.',
    { modal: true },
    'Seal Keys'
  );
  if (confirm !== 'Seal Keys') return;

  try {
    const { groups, secrets, skipped } = await collectSealableProviders(context);
    if (groups.length === 0) {
      void vscode.window.showWarningMessage(
        'Copilot Provider Bridge: no provider keys were found in extension SecretStorage. Run Quick Setup or Configure Usage API Key first.'
      );
      return;
    }

    const cfg = await readConfig();
    await applySealedUpdate(context, cfg, groups, secrets);
    const skippedNote = skipped.length > 0 ? ` Skipped (no stored key): ${skipped.join(', ')}.` : '';
    void vscode.window.showInformationMessage(
      `Copilot Provider Bridge: sealing started for ${groups.length} provider${groups.length === 1 ? '' : 's'}. ` +
        `Quit VS Code now; the helper will finish and report the result on the next launch.${skippedNote}`
    );
  } catch (err) {
    Logger.error('Sealing failed', err);
    void vscode.window.showErrorMessage(`Copilot Provider Bridge: sealing failed. ${(err as Error).message}`);
  }
}
