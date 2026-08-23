// Command to select/pin which multimodal model backend powers the built-in Vision Agent tool.

import * as vscode from 'vscode';
import { catalogStore } from '../catalog/store';
import type { VisionBackendOption } from '../tools/visionBackends';

export async function selectVisionModelCommand(context: vscode.ExtensionContext): Promise<void> {
  const currentId = context.globalState.get<string>('copilotProviderBridge.preferredVisionModel');

  const items = await Promise.all(
    catalogStore.get().visionBackends.map(async (b) => {
      const isPinned = b.id === currentId;
      const key =
        (await context.secrets.get(`copilot-provider-bridge.${b.providerId}.apiKey`)) ??
        process.env[`${b.providerId.toUpperCase()}_API_KEY`];
      const status = key ? '$(check) Key configured' : '$(warning) No key found';

      return {
        label: `${isPinned ? '$(pinned) ' : '$(eye) '}${b.name}`,
        description: `[${b.providerId.toUpperCase()}] ${status}`,
        detail: b.description,
        backend: b,
      };
    })
  );

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Copilot Provider Bridge: Select Vision Agent Model',
    placeHolder: 'Choose which multimodal model powers automatic visual analysis for text-only coding models',
    ignoreFocusOut: true,
  });

  if (!pick) return;

  await context.globalState.update('copilotProviderBridge.preferredVisionModel', pick.backend.id);
  void vscode.window.showInformationMessage(
    `Pinned "${pick.backend.name}" as the Vision Agent backend. When text-only models (like GLM-5.3 or DeepSeek V4 Pro) need visual analysis, this model will be invoked.`
  );
}
