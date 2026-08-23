// Extension entry. Registers commands, manages status bar usage display, tools, diagnostics, and provides first-time setup prompt.

import * as vscode from 'vscode';
import { addModelCommand } from './commands/addProvider';
import { removeModelCommand } from './commands/removeProvider';
import { listModelsCommand } from './commands/listProviders';
import { configureMcpCommand } from './commands/addMcp';
import { removeMcpCommand } from './commands/removeMcp';
import { quickSetupCommand } from './commands/setup';
import { configureUsageKeyCommand } from './commands/configureUsageKey';
import { selectVisionModelCommand } from './commands/selectVisionModel';
import { runDiagnosticsCommand } from './commands/diagnostics';
import { UsageStatusBarManager } from './usage/statusBar';
import { resetConfigurationCommand } from './commands/resetConfiguration';
import { CopilotProviderBridgeVisionTool } from './tools/visionTool';
import { catalogStore } from './catalog/store';
import { Logger } from './utils/logger';

export { catalogStore, mergeWithDefaults, type EffectiveCatalog } from './catalog/store';
export { CATALOG_FILE_NAME, CATALOG_SCHEMA_VERSION, type CatalogFileSections } from './catalog/catalogFile';
export {
  modelToConfig,
  providerToConfig,
  readConfig,
  writeConfig,
  findGroupIndex,
  hasAnyBridgeGroup,
  userConfigPath,
  type ConfigModel,
  type ConfigGroup,
  type ConfigFile,
} from './config';
export {
  mergeMcpConfig,
  type McpPreset,
  type McpConfigFile,
  type McpInputDefinition,
  type McpServerDefinition,
} from './mcpCatalog';
export { quickSetupCommand, validateProviderKey } from './commands/setup';
export { configureUsageKeyCommand } from './commands/configureUsageKey';
export { selectVisionModelCommand } from './commands/selectVisionModel';
export { runDiagnosticsCommand } from './commands/diagnostics';
export { UsageStatusBarManager } from './usage/statusBar';
export { resetConfigurationCommand, resetCopilotProviderBridgeState } from './commands/resetConfiguration';
export { getPieGlyph, formatCountdown, type UsageReport } from './usage/types';
export { CopilotProviderBridgeVisionTool, type VisionBackendOption } from './tools/visionTool';
export { VISION_BACKENDS } from './tools/visionBackends';
export { Logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext): void {
  // Initialize Logger
  Logger.initialize(context);
  Logger.debug('Activating Copilot Provider Bridge extension...');

  // Load the user-editable catalog (falls back to bundled defaults) and start watching it.
  void catalogStore.init(context);

  // Initialize status bar usage manager
  const statusBarManager = new UsageStatusBarManager(context);
  void statusBarManager.start();

  // Register built-in Vision Agent LanguageModelTool
  if (typeof vscode.lm?.registerTool === 'function') {
    const visionTool = new CopilotProviderBridgeVisionTool(context);
    context.subscriptions.push(vscode.lm.registerTool(CopilotProviderBridgeVisionTool.toolId, visionTool));
    Logger.debug(`Registered LanguageModelTool: ${CopilotProviderBridgeVisionTool.toolId}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-provider-bridge.quickSetup', () => quickSetupCommand(context)),
    vscode.commands.registerCommand('copilot-provider-bridge.addModel', () => addModelCommand(context)),
    vscode.commands.registerCommand('copilot-provider-bridge.removeModel', removeModelCommand),
    vscode.commands.registerCommand('copilot-provider-bridge.listModels', listModelsCommand),
    vscode.commands.registerCommand('copilot-provider-bridge.configureMcp', configureMcpCommand),
    vscode.commands.registerCommand('copilot-provider-bridge.removeMcp', removeMcpCommand),
    vscode.commands.registerCommand('copilot-provider-bridge.configureUsageKey', (providerId) =>
      configureUsageKeyCommand(context, providerId)
    ),
    vscode.commands.registerCommand('copilot-provider-bridge.selectStatusBarProvider', () =>
      statusBarManager.selectProviderInteractive()
    ),
    vscode.commands.registerCommand('copilot-provider-bridge.refreshUsage', () => statusBarManager.refresh()),
    vscode.commands.registerCommand('copilot-provider-bridge.selectVisionModel', () => selectVisionModelCommand(context)),
    vscode.commands.registerCommand('copilot-provider-bridge.runDiagnostics', () => runDiagnosticsCommand(context)),
    vscode.commands.registerCommand('copilot-provider-bridge.showDebugLogs', () => Logger.showChannel()),
    vscode.commands.registerCommand('copilot-provider-bridge.toggleDebugLogging', async () => {
      const enabled = await Logger.toggleDebugLogging();
      void vscode.window.showInformationMessage(
        `Copilot Provider Bridge: Debug logging ${enabled ? 'ENABLED' : 'DISABLED'}.`
      );
    }),
    vscode.commands.registerCommand('copilot-provider-bridge.resetConfiguration', () =>
      resetConfigurationCommand(context)
    ),
  );

  // Check if first-time setup prompt has already been shown, dismissed, or completed
  const hasPrompted = context.globalState.get<boolean>('copilotProviderBridge.hasPromptedSetup');
  const hasRun = context.globalState.get<boolean>('copilotProviderBridge.hasRunSetup');

  if (!hasPrompted && !hasRun) {
    // Mark as prompted immediately so dismissing or choosing 'Later' does not prompt on every restart
    void context.globalState.update('copilotProviderBridge.hasPromptedSetup', true);
    void vscode.window
      .showInformationMessage(
        'Welcome to Copilot Provider Bridge! Would you like to run the Quick Setup to configure your coding plan models and companion MCP tools?',
        'Run Quick Setup',
        'Later'
      )
      .then((choice) => {
        if (choice === 'Run Quick Setup') {
          void quickSetupCommand(context);
        }
      });
  }

  Logger.info('Copilot Provider Bridge extension activated successfully.');
}

export function deactivate(): void {
  // No-op. VS Code disposes subscriptions on deactivate.
}
