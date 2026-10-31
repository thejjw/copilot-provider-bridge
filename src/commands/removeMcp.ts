// Remove installed MCP presets from the extension-managed set (no file access).

import * as vscode from 'vscode';
import { catalogStore } from '../catalog/store';
import {
  getInstalledPresetIds,
  refreshBridgeMcpServers,
  setInstalledPresetIds,
} from '../mcpServerProvider';

/** Command: Copilot Provider Bridge: Remove MCP Server */
export async function removeMcpCommand(context: vscode.ExtensionContext): Promise<void> {
  const installed = getInstalledPresetIds(context);
  if (installed.length === 0) {
    void vscode.window.showInformationMessage(
      'No MCP servers are currently managed by Copilot Provider Bridge. Run Configure MCP Tools to add some.'
    );
    return;
  }

  const byId = new Map(catalogStore.get().mcpPresets.map((preset) => [preset.id, preset]));
  const picks = await vscode.window.showQuickPick(
    installed.map((id) => {
      const preset = byId.get(id);
      return {
        label: preset?.name ?? id,
        description: preset?.server.type === 'http' ? '$(cloud) HTTP' : '$(terminal) stdio',
        detail: preset?.description,
        id,
      };
    }),
    {
      title: 'Copilot Provider Bridge: Remove MCP Server',
      placeHolder: 'Select the MCP servers to remove (Enter to confirm, Esc to cancel)',
      ignoreFocusOut: true,
      canPickMany: true,
    }
  );
  if (!picks || picks.length === 0) return;

  const removed = new Set(picks.map((pick) => pick.id));
  await setInstalledPresetIds(
    context,
    installed.filter((id) => !removed.has(id))
  );
  refreshBridgeMcpServers();
  void vscode.window.showInformationMessage(`Removed ${removed.size} MCP server(s).`);
}
