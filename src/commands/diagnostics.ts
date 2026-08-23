// Diagnostics and connectivity tester for Copilot Provider Bridge.
// Validates chatLanguageModels.json, tests live API endpoints, measures latency,
// and outputs a detailed diagnostic report to the Output Channel.

import * as vscode from 'vscode';
import type { ProviderId } from '../providers';
import { catalogStore } from '../catalog/store';
import { readConfig } from '../config';
import { Logger } from '../utils/logger';

export async function runDiagnosticsCommand(context: vscode.ExtensionContext): Promise<void> {
  Logger.showChannel();
  Logger.info('=== Starting Copilot Provider Bridge Diagnostics & Connectivity Test ===');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Running Copilot Provider Bridge Diagnostics...',
      cancellable: false,
    },
    async (progress) => {
      // 1. Inspect chatLanguageModels.json
      progress.report({ message: 'Inspecting chatLanguageModels.json...' });
      const cfg = await readConfig();
      Logger.info(`Found ${cfg.length} provider groups in chatLanguageModels.json`);

      if (cfg.length === 0) {
        Logger.warn('No provider groups configured in chatLanguageModels.json! Run Quick Setup or Add Model first.');
      }

      // 2. Inspect configured keys in SecretStorage and environment
      progress.report({ message: 'Checking API keys in SecretStorage & Environment...' });
      const keyMap = new Map<ProviderId, string>();

      for (const p of catalogStore.get().providers) {
        const secretKey = `copilot-provider-bridge.${p.id}.apiKey`;
        const secretVal = await context.secrets.get(secretKey);
        const envVal = process.env[`${p.id.toUpperCase()}_API_KEY`];
        const resolved = secretVal ?? envVal;

        if (resolved) {
          keyMap.set(p.id, resolved);
          Logger.info(`[Key Check] ${p.name}: Present (${Logger.maskSecret(resolved)}) via ${secretVal ? 'SecretStorage' : 'Environment'}`);
        } else {
          Logger.warn(`[Key Check] ${p.name}: No API key found in SecretStorage or Environment.`);
        }
      }

      // 3. Test active model endpoints
      progress.report({ message: 'Testing live model endpoints...' });
      let passCount = 0;
      let failCount = 0;

      for (const group of cfg) {
        const prov = catalogStore.get().providers.find((p) => group.apiKey.includes(`copilot-provider-bridge.${p.id}.`));
        const provId = prov?.id;
        const apiKey = provId ? keyMap.get(provId) : undefined;

        Logger.info(`\n--- Testing Provider Group: "${group.name}" (vendor: ${group.vendor}, apiType: ${group.apiType}) ---`);

        if (!apiKey) {
          Logger.error(`Cannot test "${group.name}" because no API key is available in SecretStorage/Environment.`);
          failCount += group.models.length;
          continue;
        }

        for (const m of group.models) {
          const startTime = Date.now();
          try {
            Logger.debug(`Probing model "${m.name}" (${m.id}) at ${m.url}...`);

            let res: Response;
            if (m.apiType === 'chat-completions') {
              res = await fetch(m.url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: m.id,
                  messages: [{ role: 'user', content: 'Say OK' }],
                  max_tokens: 5,
                }),
              });
            } else {
              // Anthropic Messages
              res = await fetch(m.url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: m.id,
                  messages: [{ role: 'user', content: 'Say OK' }],
                  max_tokens: 5,
                }),
              });
            }

            const latencyMs = Date.now() - startTime;

            if (res.ok) {
              Logger.info(`[PASS] ${m.name} (${m.id}) -> HTTP ${res.status} in ${latencyMs}ms`);
              passCount++;
            } else {
              let errBody = await res.text();
              // Proactively sanitize any reflected keys from error responses
              for (const key of keyMap.values()) {
                if (key && key.length > 5) {
                  errBody = errBody.replaceAll(key, Logger.maskSecret(key));
                }
              }
              Logger.error(`[FAIL] ${m.name} (${m.id}) -> HTTP ${res.status} in ${latencyMs}ms\nResponse Body: ${errBody}`);
              failCount++;
            }
          } catch (err) {
            const latencyMs = Date.now() - startTime;
            Logger.error(`[FAIL] ${m.name} (${m.id}) -> Network/Fetch Error in ${latencyMs}ms`, err);
            failCount++;
          }
        }
      }

      Logger.info(`\n=== Diagnostics Complete: ${passCount} Passed, ${failCount} Failed ===\n`);
    }
  );

  void vscode.window.showInformationMessage('Copilot Provider Bridge Diagnostics finished. See Output Channel for details.');
}
