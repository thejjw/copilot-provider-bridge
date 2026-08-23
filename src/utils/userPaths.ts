// User-profile path helpers shared by the BYOK config layer and the catalog
// store. Extracted into its own module so both can import it without creating
// a circular dependency between config.ts and catalog/store.ts.

import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Detect "Code" vs "Code - Insiders" from the running editor's appRoot. */
function codeFlavor(): string {
  return /-insiders/i.test(vscode.env.appRoot) ? 'Code - Insiders' : 'Code';
}

/** Path to the user-scoped chatLanguageModels.json for the current platform. */
export function userConfigPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    return path.join(base, codeFlavor(), 'User', 'chatLanguageModels.json');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', codeFlavor(), 'User', 'chatLanguageModels.json');
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, codeFlavor(), 'User', 'chatLanguageModels.json');
}

/** Directory containing chatLanguageModels.json (the VS Code user settings dir). */
export function userSettingsDir(): string {
  return path.dirname(userConfigPath());
}
