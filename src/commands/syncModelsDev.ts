// Command to check models.dev for updated/new models and optionally import or preview them.
// Respects the existing catalog store and never blindly overwrites user configuration.

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { catalogStore } from '../catalog/store';
import {
  fetchModelsDevApi,
  compareProviderModels,
  KNOWN_MODELS_DEV_MAPPINGS,
  type ProviderDiffReport,
  type ModelDiffComparison,
} from '../catalog/modelsDevSync';
import {
  CATALOG_FILE_NAME,
  CATALOG_SCHEMA_VERSION,
  serializeCatalogTemplate,
} from '../catalog/catalogFile';
import { Logger } from '../utils/logger';
import type { Provider, ProviderModel } from '../providers';

interface ProviderQuickPickItem extends vscode.QuickPickItem {
  providerId: string;
  modelsDevSlug: string;
  modelIdPrefix?: string;
}

/**
 * Command: Copilot Provider Bridge: Check for Updated Models (models.dev)
 */
export async function checkModelsDevCommand(): Promise<void> {
  const effective = catalogStore.get();
  const currentProviders = effective.providers;

  // Build provider options from known mappings
  const items: ProviderQuickPickItem[] = KNOWN_MODELS_DEV_MAPPINGS.map((m) => {
    const existing = currentProviders.find((p) => p.id === m.providerId);
    return {
      label: existing ? `$(server) ${existing.name}` : `$(cloud) ${m.providerId}`,
      description: `models.dev: ${m.modelsDevSlug}`,
      detail: existing ? `${existing.models.length} model(s) currently configured` : 'Not configured in catalog',
      providerId: m.providerId,
      modelsDevSlug: m.modelsDevSlug,
      modelIdPrefix: m.modelIdPrefix,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select Provider to Check against models.dev',
    placeHolder: 'Pick a provider to query live models, context windows, and limits',
  });

  if (!selected) {
    return;
  }

  let report: ProviderDiffReport;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking models.dev for ${selected.label}...`,
      cancellable: false,
    },
    async () => {
      const apiData = await fetchModelsDevApi();
      const providerData = apiData[selected.modelsDevSlug];
      if (!providerData) {
        throw new Error(`Provider slug "${selected.modelsDevSlug}" was not found in models.dev.`);
      }

      const existingProvider = currentProviders.find((p) => p.id === selected.providerId);
      const existingModels = existingProvider ? existingProvider.models : [];

      report = compareProviderModels(existingModels, providerData.models || {}, {
        providerId: selected.providerId,
        modelsDevSlug: selected.modelsDevSlug,
        modelIdPrefix: selected.modelIdPrefix,
      });
      report.providerName = existingProvider ? existingProvider.name : providerData.name;
    }
  );

  await showDiffAndImportOptions(report!, currentProviders);
}

interface ModelSelectQuickPickItem extends vscode.QuickPickItem {
  modelComparison: ModelDiffComparison;
}

async function showDiffAndImportOptions(
  report: ProviderDiffReport,
  currentProviders: Provider[]
): Promise<void> {
  const totalChanges = report.newModels.length + report.modifiedModels.length;

  if (totalChanges === 0) {
    void vscode.window.showInformationMessage(
      `All models for ${report.providerName || report.providerId} are up-to-date with models.dev (${report.identicalModels.length} identical).`
    );
    return;
  }

  const summary = `${report.newModels.length} new model(s), ${report.modifiedModels.length} modified limit(s) found on models.dev.`;
  const action = await vscode.window.showInformationMessage(
    `${report.providerName || report.providerId}: ${summary}`,
    'Review & Import to Catalog',
    'View JSON Preview',
    'Cancel'
  );

  if (action === 'View JSON Preview') {
    await previewDiffInEditor(report);
    return;
  }

  if (action !== 'Review & Import to Catalog') {
    return;
  }

  // Allow user to select which new models to add
  const pickItems: ModelSelectQuickPickItem[] = [];

  for (const nm of report.newModels) {
    const cost = nm.cost?.input !== undefined ? ` | $${nm.cost.input}/$${nm.cost.output} per 1M` : '';
    pickItems.push({
      label: `$(plus) ${nm.modelId}`,
      description: `[New] ctx: ${nm.suggested.contextWindow.toLocaleString()}, out: ${nm.suggested.maxOutputTokens.toLocaleString()}${cost}`,
      detail: `Vision: ${nm.suggested.vision ? 'Yes' : 'No'}, Tool Calling: ${nm.suggested.toolCalling ? 'Yes' : 'No'}`,
      picked: true,
      modelComparison: nm,
    });
  }

  for (const mod of report.modifiedModels) {
    const changeDesc = (mod.changes || []).map((c) => `${String(c.field)}: ${String(c.oldValue)} -> ${String(c.newValue)}`).join(', ');
    pickItems.push({
      label: `$(edit) ${mod.modelId}`,
      description: `[Update] ${changeDesc}`,
      detail: `Update token limits to match models.dev`,
      picked: false,
      modelComparison: mod,
    });
  }

  const chosen = await vscode.window.showQuickPick(pickItems, {
    title: 'Select Models to Import/Update in copilot-provider-bridge.jsonc',
    canPickMany: true,
  });

  if (!chosen || chosen.length === 0) {
    return;
  }

  await applyImportToCatalogFile(report.providerId, chosen.map((c) => c.modelComparison), currentProviders);
}

/**
 * Open an untitled document with formatted diff report
 */
async function previewDiffInEditor(report: ProviderDiffReport): Promise<void> {
  const content = {
    providerId: report.providerId,
    modelsDevSlug: report.modelsDevSlug,
    newModels: report.newModels.map((m) => ({
      model: m.suggested,
      cost: m.cost,
    })),
    modifiedModels: report.modifiedModels.map((m) => ({
      modelId: m.modelId,
      current: m.existing,
      suggested: m.suggested,
      changes: m.changes,
    })),
  };

  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(content, null, 2),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

/**
 * Safely merge chosen models into user's copilot-provider-bridge.jsonc
 */
async function applyImportToCatalogFile(
  providerId: string,
  chosen: ModelDiffComparison[],
  currentProviders: Provider[]
): Promise<void> {
  const filePath = catalogStore.filePath();
  const effective = catalogStore.get();

  // Clone existing providers from effective catalog
  const providersCopy: Provider[] = JSON.parse(JSON.stringify(currentProviders));
  let targetProvider = providersCopy.find((p) => p.id === providerId);

  if (!targetProvider) {
    vscode.window.showErrorMessage(`Provider "${providerId}" not found in current catalog.`);
    return;
  }

  for (const item of chosen) {
    const existingIndex = targetProvider.models.findIndex((m) => m.id === item.modelId);
    if (existingIndex >= 0) {
      // Update limits of existing model
      targetProvider.models[existingIndex] = {
        ...targetProvider.models[existingIndex],
        contextWindow: item.suggested.contextWindow,
        maxInputTokens: item.suggested.maxInputTokens,
        maxOutputTokens: item.suggested.maxOutputTokens,
        vision: item.suggested.vision,
        toolCalling: item.suggested.toolCalling,
      };
    } else {
      // Append new model
      targetProvider.models.push(item.suggested);
    }
  }

  // Prepare full catalog data
  const templateStr = serializeCatalogTemplate({
    providers: providersCopy,
    visionBackends: effective.visionBackends,
    mcpPresets: effective.mcpPresets,
  });

  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, templateStr, 'utf8');
  await fs.rename(tmp, filePath);

  await catalogStore.reload();

  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });

  void vscode.window.showInformationMessage(
    `Successfully imported ${chosen.length} model update(s) into ${CATALOG_FILE_NAME}.`
  );
}
