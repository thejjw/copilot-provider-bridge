import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mergeMcpConfig, type McpConfigFile, type McpPreset } from '../mcpCatalog';
import { catalogStore } from '../catalog/store';
import { Logger } from '../utils/logger';

function codeFlavor(): string {
  return /-insiders/i.test(vscode.env.appRoot) ? 'Code - Insiders' : 'Code';
}

/** Get the path to user profile mcp.json. */
export function userMcpConfigPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    return path.join(base, codeFlavor(), 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', codeFlavor(), 'User', 'mcp.json');
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, codeFlavor(), 'User', 'mcp.json');
}

/** Get the workspace .vscode/mcp.json path if a workspace is open. */
export function workspaceMcpConfigPath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return path.join(folders[0].uri.fsPath, '.vscode', 'mcp.json');
}

/** Read an mcp.json file safely. Strips BOM, returns null on ENOENT, rethrows parse errors. */
export async function readMcpFile(filePath: string): Promise<McpConfigFile | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const clean = content.replace(/^\uFEFF/, '').trim();
    if (!clean) return { servers: {} };
    const parsed = JSON.parse(clean) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'servers' in parsed) {
      return parsed as McpConfigFile;
    }
    return { servers: {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    Logger.error(`Failed to parse ${filePath}: ${(err as Error).message}`);
    throw err;
  }
}

/** Write an mcp.json file atomically. */
export async function writeMcpFile(filePath: string, config: McpConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

/** Command: Copilot Provider Bridge: Configure MCP Tools */
export async function configureMcpCommand(): Promise<void> {
  const wsPath = workspaceMcpConfigPath();
  const targetOptions = [
    {
      label: '$(globe) User Profile (Global)',
      description: userMcpConfigPath(),
      detail: 'Available across all workspaces and projects on this machine.',
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
    title: 'Copilot Provider Bridge - Configure MCP Tools: Select Target',
    placeHolder: 'Where would you like to install the MCP tool configuration?',
    ignoreFocusOut: true,
  });
  if (!targetPick) return;

  const presetPicks = await vscode.window.showQuickPick(
    catalogStore.get().mcpPresets.map((preset) => ({
      label: preset.name,
      description: preset.server.type === 'http' ? '$(cloud) HTTP SSE' : '$(terminal) stdio CLI',
      detail: preset.description,
      picked: true,
      preset,
    })),
    {
      title: 'Copilot Provider Bridge - Select MCP Tools to Install',
      placeHolder: 'Choose one or more MCP server presets (Enter to confirm)',
      ignoreFocusOut: true,
      canPickMany: true,
    }
  );
  if (!presetPicks || presetPicks.length === 0) return;

  const selectedPresets: McpPreset[] = presetPicks.map((p) => p.preset);
  const targetFile = targetPick.path;

  const existingConfig = await readMcpFile(targetFile);
  const updatedConfig = mergeMcpConfig(existingConfig, selectedPresets);
  await writeMcpFile(targetFile, updatedConfig);

  const action = await vscode.window.showInformationMessage(
    `Installed ${selectedPresets.length} MCP server${selectedPresets.length === 1 ? '' : 's'} into mcp.json. ` +
      `When Copilot Chat starts the server, enter the requested API key once.`,
    'Open mcp.json',
    'Reveal in OS'
  );

  if (action === 'Open mcp.json') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFile));
    await vscode.window.showTextDocument(doc);
  } else if (action === 'Reveal in OS') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetFile));
  }
}
