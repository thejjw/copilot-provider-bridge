import * as vscode from 'vscode';
import { hasAnyBridgeGroup, providerIdForConfigGroup, readConfig } from '../config';

/** Show every model this extension has installed in a QuickPick with a details view. */
export async function listModelsCommand(): Promise<void> {
  const cfg = await readConfig();

  if (!hasAnyBridgeGroup(cfg)) {
    void vscode.window.showInformationMessage(
      'Copilot Provider Bridge: no managed provider groups installed. Run "Add Model" to get started.',
    );
    return;
  }

  const items = cfg
    .filter((g) => providerIdForConfigGroup(g) !== undefined)
    .flatMap((g) =>
      g.models.map((m) => ({
        label: m.name,
        description: g.name,
        detail: `${m.url}  -  id: ${m.id}  -  tools: ${m.toolCalling ? 'yes' : 'no'}  -  vision: ${m.vision ? 'yes' : 'no'}`,
      })),
    );

  void vscode.window.showQuickPick(items, {
    title: 'Copilot Provider Bridge - Installed Models',
    placeHolder: `${items.length} model${items.length === 1 ? '' : 's'} across managed providers`,
    ignoreFocusOut: true,
  });
}
