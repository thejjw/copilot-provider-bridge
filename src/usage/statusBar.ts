// Status bar manager for Copilot Provider Bridge.
// Displays a minimal single-provider badge (dynamic pie glyph + percent, or balance number)
// for the user's explicitly selected provider. There is intentionally no "auto-select":
// VS Code exposes no API to observe which chat model is active, so any automatic choice
// would be a misleading guess. Unpinned state renders a neutral placeholder.

import * as vscode from 'vscode';
import type { ProviderId } from '../providers';
import {
  fetchDeepseekUsage,
  fetchKimiUsage,
  fetchMinimaxUsage,
  fetchOpenrouterUsage,
  fetchZaiUsage,
} from './fetchers';
import { getDatatypeIcon, getPieGlyph, type UsageReport, type UsageStatus } from './types';
import { readConfig } from '../config';
import { catalogStore } from '../catalog/store';
import { Logger } from '../utils/logger';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Render a crisp SVG progress bar as a data URI for Markdown tooltips. */
export function renderSvgProgressBar(
  percent: number,
  status: UsageStatus,
  width = 100,
  height = 8
): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const fillWidth = Math.round((clamped / 100) * width);
  const color =
    status === 'critical' || clamped <= 15
      ? '#f43f5e' // Rose red
      : status === 'low' || clamped <= 35
      ? '#f59e0b' // Amber
      : '#10b981'; // Emerald green
  const bg = '#3f3f46'; // Zinc-700 track

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${height / 2}" fill="${bg}"/><rect width="${fillWidth}" height="${height}" rx="${height / 2}" fill="${color}"/></svg>`;
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

export class UsageStatusBarManager {
  private readonly _statusBarItem: vscode.StatusBarItem;
  private readonly _reports = new Map<ProviderId, UsageReport>();
  private _pollTimer?: NodeJS.Timeout;
  private _pinnedProviderId?: ProviderId;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._statusBarItem = vscode.window.createStatusBarItem(
      'copilot-provider-bridge.usage',
      vscode.StatusBarAlignment.Right,
      99
    );
    this._statusBarItem.name = 'Copilot Provider Bridge: Plan Usage';
    this._statusBarItem.command = 'copilot-provider-bridge.selectStatusBarProvider';

    // Restore previously pinned provider from globalState, if any
    const savedPin = this.context.globalState.get<ProviderId>('copilotProviderBridge.pinnedProvider');
    if (savedPin) {
      this._pinnedProviderId = savedPin;
    }
  }

  /** Initialize status bar, load keys, and start background polling. */
  async start(): Promise<void> {
    this._statusBarItem.show();
    this.render();

    // Initial background query
    await this.refresh();

    // Periodic polling
    this._pollTimer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);

    this.context.subscriptions.push({
      dispose: () => {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._statusBarItem.dispose();
      },
    });
  }

  /** Explicitly select which provider badge appears on the status bar (pass undefined to clear and show the neutral placeholder). */
  async setPinnedProvider(providerId?: ProviderId): Promise<void> {
    this._pinnedProviderId = providerId;
    await this.context.globalState.update('copilotProviderBridge.pinnedProvider', providerId);
    this.render();
  }

  /** Interactive QuickPick to let the user choose which provider's badge appears, clear the selection, or manage keys. */
  async selectProviderInteractive(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { providerId?: ProviderId; action?: string }> = [];

    const selectedId = this.getSelectedProviderId();

    // Option 1: Clear selection -> neutral placeholder badge
    items.push({
      label: '$(circle-slash) No Provider Selected (Neutral Badge)',
      description: selectedId === undefined ? '(Currently Active)' : 'Clear selection',
      detail: 'Show a neutral badge. Pick a provider below to display its quota in the status bar.',
      action: 'clear',
    });

    if (this._reports.size > 0) {
      items.push({ label: 'Configured Providers', kind: vscode.QuickPickItemKind.Separator });
    }

    for (const report of this._reports.values()) {
      const isSelected = report.providerId === selectedId;
      const metric =
        report.percentageRemaining !== undefined
          ? `${getPieGlyph(report.percentageRemaining)} ${report.percentageRemaining}% remaining`
          : report.balanceDisplay
          ? `Balance: ${report.balanceDisplay}`
          : 'Active';

      const reset = report.resetCountdown ? ` · Reset ${report.resetCountdown}` : '';
      const statusIcon =
        report.status === 'ok' ? '🟢' : report.status === 'low' ? '🟡' : report.status === 'critical' ? '🔴' : '⚠️';

      items.push({
        label: `${statusIcon} ${report.providerName}`,
        description: isSelected ? '📌 (Shown in Status Bar)' : undefined,
        detail: `${metric}${reset}`,
        providerId: report.providerId,
      });
    }

    items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });

    items.push({
      label: '$(refresh) Refresh All Quotas Now',
      description: 'Query live API usage endpoints immediately',
      action: 'refresh',
    });

    items.push({
      label: '$(key) Configure Usage API Keys',
      description: 'Add or update API keys used for live quota polling',
      action: 'configureKeys',
    });

    items.push({
      label: '$(pulse) Run Connectivity Diagnostics',
      description: 'Test all endpoints, headers, and secret keys',
      action: 'diagnostics',
    });

    const choice = await vscode.window.showQuickPick(items, {
      title: 'Copilot Provider Bridge: Status Bar Badge Provider',
      placeHolder: 'Select which provider quota to show in the status bar',
    });

    if (!choice) return;

    if (choice.action === 'clear') {
      await this.setPinnedProvider(undefined);
      void vscode.window.showInformationMessage('Status bar badge cleared. Select a provider anytime to pin its quota.');
      return;
    }

    if (choice.action === 'refresh') {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing Copilot Provider Bridge plan quotas & balances...',
          cancellable: false,
        },
        () => this.refresh()
      );
      void vscode.window.showInformationMessage('Copilot Provider Bridge: Plan quotas refreshed.');
      return;
    }

    if (choice.action === 'configureKeys') {
      await vscode.commands.executeCommand('copilot-provider-bridge.configureUsageKey');
      return;
    }

    if (choice.action === 'diagnostics') {
      await vscode.commands.executeCommand('copilot-provider-bridge.runDiagnostics');
      return;
    }

    if (choice.providerId) {
      await this.setPinnedProvider(choice.providerId);
      void vscode.window.showInformationMessage(`Pinned ${choice.label} to status bar.`);
    }
  }

  /** Get the explicitly selected provider ID, or undefined when no provider is selected (neutral badge). */
  getSelectedProviderId(): ProviderId | undefined {
    return this._pinnedProviderId;
  }

  /** Query all configured provider usage endpoints in parallel. */
  async refresh(): Promise<void> {
    try {
      const config = await readConfig();

      // Match config groups to providers by the bridge marker embedded in the apiKey
      // (e.g. "${input:copilot-provider-bridge.kimi.apiKey}"), falling back to the exact
      // catalog display name. Substring name matching was dropped: it false-positives on
      // user-created groups that merely mention a provider name.
      const findGroup = (providerId: string) => {
        // Marker prefix first (stable identity), then exact display name from the
        // effective catalog so user-renamed providers still match after a rename.
        const marker = `copilot-provider-bridge.${providerId}.`;
        const displayName = catalogStore.get().providers.find((p) => p.id === providerId)?.name;
        return config.find(
          (g) => g.apiKey.includes(marker) || (displayName !== undefined && g.name === displayName)
        );
      };

      const zaiGroup = findGroup('zai');
      const dsGroup = findGroup('deepseek');
      const mmGroup = findGroup('minimax');
      const kimiGroup = findGroup('kimi');
      const orGroup = findGroup('openrouter');
      const nvidiaGroup = findGroup('nvidia');

      const zaiKey =
        (await this.context.secrets.get('copilot-provider-bridge.zai.apiKey')) ??
        process.env.ZAI_API_KEY ??
        (zaiGroup && !zaiGroup.apiKey.startsWith('${input:') ? zaiGroup.apiKey : undefined);

      const dsKey =
        (await this.context.secrets.get('copilot-provider-bridge.deepseek.apiKey')) ??
        process.env.DEEPSEEK_API_KEY ??
        (dsGroup && !dsGroup.apiKey.startsWith('${input:') ? dsGroup.apiKey : undefined);

      const mmKey =
        (await this.context.secrets.get('copilot-provider-bridge.minimax.apiKey')) ??
        process.env.MINIMAX_API_KEY ??
        (mmGroup && !mmGroup.apiKey.startsWith('${input:') ? mmGroup.apiKey : undefined);

      const kimiKey =
        (await this.context.secrets.get('copilot-provider-bridge.kimi.apiKey')) ??
        process.env.KIMI_API_KEY ??
        (kimiGroup && !kimiGroup.apiKey.startsWith('${input:') ? kimiGroup.apiKey : undefined);

      const orKey =
        (await this.context.secrets.get('copilot-provider-bridge.openrouter.apiKey')) ??
        process.env.OPENROUTER_API_KEY ??
        (orGroup && !orGroup.apiKey.startsWith('${input:') ? orGroup.apiKey : undefined);

      const fetchers: Array<Promise<UsageReport | null>> = [];

      if (zaiKey || zaiGroup) {
        fetchers.push(
          zaiKey
            ? fetchZaiUsage(zaiKey)
            : Promise.resolve({
                providerId: 'zai',
                providerName: 'Z.ai GLM Coding Plan',
                details: ['API Key not yet configured for live balance query.'],
                status: 'error',
                lastUpdated: new Date(),
              })
        );
      }

      if (dsKey || dsGroup) {
        fetchers.push(
          dsKey
            ? fetchDeepseekUsage(dsKey)
            : Promise.resolve({
                providerId: 'deepseek',
                providerName: 'DeepSeek',
                details: ['API Key not yet configured for live balance query.'],
                status: 'error',
                lastUpdated: new Date(),
              })
        );
      }

      if (mmKey || mmGroup) {
        fetchers.push(
          mmKey
            ? fetchMinimaxUsage(mmKey)
            : Promise.resolve({
                providerId: 'minimax',
                providerName: 'MiniMax',
                details: ['API Key not yet configured for live balance query.'],
                status: 'error',
                lastUpdated: new Date(),
              })
        );
      }

      if (kimiKey || kimiGroup) {
        fetchers.push(
          kimiKey
            ? fetchKimiUsage(kimiKey)
            : Promise.resolve({
                providerId: 'kimi',
                providerName: 'Kimi Code Plan',
                details: ['API Key not yet configured for live balance query.'],
                status: 'error',
                lastUpdated: new Date(),
              })
        );
      }

      if (orKey || orGroup) {
        fetchers.push(
          orKey
            ? fetchOpenrouterUsage(orKey)
            : Promise.resolve({
                providerId: 'openrouter',
                providerName: 'OpenRouter',
                details: ['API Key not yet configured for live balance query.'],
                status: 'error',
                lastUpdated: new Date(),
              })
        );
      }

      // NVIDIA NIM has no public quota endpoint; surface a configured stub so the
      // provider still appears in the dashboard and can be pinned to the status bar.
      if (nvidiaGroup) {
        fetchers.push(
          Promise.resolve({
            providerId: 'nvidia',
            providerName: 'NVIDIA NIM',
            details: ['Usage quota API not available for NVIDIA NIM.'],
            status: 'ok',
            lastUpdated: new Date(),
          })
        );
      }

      const results = await Promise.allSettled(fetchers);

      for (const res of results) {
        if (res.status === 'fulfilled' && res.value) {
          this._reports.set(res.value.providerId, res.value);
        }
      }
    } catch (err) {
      Logger.error(`Error refreshing usage reports: ${(err as Error).message}`);
    }

    this.render();
  }

  /** Render the minimal status bar text and rich Markdown tooltip. */
  render(): void {
    const selectedId = this.getSelectedProviderId();
    const active = selectedId !== undefined ? this._reports.get(selectedId) : undefined;

    // Neutral placeholder when nothing is selected, or the selected provider has no
    // usable metric. Never substitutes another provider: the badge only ever shows
    // what the user explicitly chose.
    const metricText =
      active?.percentageRemaining !== undefined
        ? `${getDatatypeIcon(active.percentageRemaining)} ${active.percentageRemaining}%`
        : active?.balanceDisplay ?? undefined;

    if (!metricText) {
      this._statusBarItem.text = 'Copilot-Provider-Bridge';
      this._statusBarItem.color = undefined;
    } else {
      this._statusBarItem.text = metricText;
      if (active!.status === 'critical') {
        this._statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      } else if (active!.status === 'low') {
        this._statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      } else {
        this._statusBarItem.color = undefined;
      }
    }

    // Build Polished Markdown Tooltip covering ALL active providers
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    if (this._reports.size === 0) {
      md.appendMarkdown(`### ⚡ Copilot Provider Bridge — Plan Quotas & Balances\n\n`);
      md.appendMarkdown(`*No usage API keys configured yet.*\n\n`);
      md.appendMarkdown(
        `[🔑 Configure Usage Keys](command:copilot-provider-bridge.configureUsageKey) | [🚀 Quick Setup](command:copilot-provider-bridge.quickSetup)`
      );
      this._statusBarItem.tooltip = md;
      return;
    }

    const hasSelection = selectedId !== undefined;
    const modeLabel = hasSelection ? `Selected: ${active?.providerName ?? selectedId}` : 'No Provider Selected';

    md.appendMarkdown(`### ⚡ Copilot Provider Bridge — Quotas & Balances *(${modeLabel})*\n\n`);
    md.appendMarkdown(
      `[🔄 Refresh](command:copilot-provider-bridge.refreshUsage) | [📌 ${hasSelection ? 'Change / Clear Selection' : 'Select Provider'}](command:copilot-provider-bridge.selectStatusBarProvider) | [🔑 Keys](command:copilot-provider-bridge.configureUsageKey) | [🩺 Diagnostics](command:copilot-provider-bridge.runDiagnostics)\n\n`
    );

    if (!hasSelection) {
      md.appendMarkdown(
        `*The status bar badge only shows a provider you explicitly select. Click the badge to choose one.*\n\n`
      );
    }

    md.appendMarkdown(`| Provider | Remaining / Balance | Meter | Reset | Status |\n`);
    md.appendMarkdown(`| :--- | :--- | :---: | :--- | :---: |\n`);

    for (const report of this._reports.values()) {
      const isReportSelected = report.providerId === selectedId;
      const name = isReportSelected ? `**📌 ${report.providerName}**` : `**${report.providerName}**`;

      const value =
        report.percentageRemaining !== undefined
          ? `**${report.percentageRemaining}%**`
          : `**${report.balanceDisplay ?? 'Active'}**`;

      const meter =
        report.percentageRemaining !== undefined
          ? `![${report.percentageRemaining}%](${renderSvgProgressBar(report.percentageRemaining, report.status, 90, 8)})`
          : '`Balance`';

      let reset = '—';
      if (report.resets && report.resets.length > 1) {
        reset = report.resets
          .map((r) => `${r.label.replace(' Window', '').replace(' Limit', '').replace(' Reset', '')}: ${r.countdown}`)
          .join(' · ');
      } else if (report.resetCountdown) {
        reset = `🔄 ${report.resetCountdown}`;
      }

      const statusIcon =
        report.status === 'ok'
          ? '🟢 Normal'
          : report.status === 'low'
          ? '🟡 Low'
          : report.status === 'critical'
          ? '🔴 Critical'
          : '⚪ Error';

      md.appendMarkdown(`| ${name} | ${value} | ${meter} | ${reset} | ${statusIcon} |\n`);
    }

    // Detailed per-provider breakdowns
    md.appendMarkdown(`\n---\n`);
    for (const report of this._reports.values()) {
      const isReportSelected = report.providerId === selectedId;
      const header = isReportSelected
        ? `#### 📌 ${report.providerName} *(Shown in Status Bar)*\n`
        : `#### ${report.providerName}\n`;
      md.appendMarkdown(header);

      if (report.errorMessage) {
        md.appendMarkdown(`- ⚠️ Error: \`${report.errorMessage}\`\n`);
      }

      for (const detail of report.details) {
        md.appendMarkdown(`- ${detail}\n`);
      }
      if (report.resets && report.resets.length > 0) {
        for (const r of report.resets) {
          const label = r.label.endsWith('Reset') ? r.label : `${r.label} Reset`;
          md.appendMarkdown(`- ⏳ **${label}**: **${r.countdown}**\n`);
        }
      } else if (report.resetCountdown) {
        md.appendMarkdown(`- ⏳ **Next Reset**: **${report.resetCountdown}**\n`);
      }
      md.appendMarkdown(`\n`);
    }

    const lastTime = (active ?? this._reports.values().next().value)?.lastUpdated.toLocaleTimeString();
    md.appendMarkdown(
      `---\n*Auto-refreshes every 5m · Click status bar to select a provider badge${lastTime ? ` · Updated ${lastTime}` : ''}*`
    );

    this._statusBarItem.tooltip = md;
  }

  /** Get all cached reports. */
  getReports(): Map<ProviderId, UsageReport> {
    return new Map(this._reports);
  }
}
