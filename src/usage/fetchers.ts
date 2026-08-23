// HTTP fetchers for provider plan usage, quota limits, and account balances.

import type { KnownProviderId } from '../providers';
import { formatCountdown, type QuotaResetInfo, type UsageReport, type UsageStatus } from './types';

/**
 * Provider ids with built-in usage behavior (a real quota/balance fetcher, or
 * the intentional NVIDIA stub). Custom catalog ids never get usage tracking;
 * single source of truth for the usage-key picker, polling, and diagnostics.
 */
export const USAGE_SUPPORTED_IDS: readonly KnownProviderId[] = ['zai', 'deepseek', 'minimax', 'kimi', 'openrouter', 'nvidia'];

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch Z.ai GLM Coding Plan usage (5-hour token quota & time limits). */
export async function fetchZaiUsage(apiKey: string): Promise<UsageReport> {
  try {
    const res = await fetchWithTimeout('https://api.z.ai/api/monitor/usage/quota/limit', {
      Authorization: apiKey,
      Accept: 'application/json',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      success?: boolean;
      data?: {
        limits?: Array<{
          type?: string;
          usage?: number;
          remaining?: number;
          percentage?: number;
          nextResetTime?: number;
        }>;
        level?: string;
      };
    };

    const limits = data.data?.limits ?? [];
    const timeLimit = limits.find((l) => l.type === 'TIME_LIMIT');
    const tokenLimit = limits.find((l) => l.type === 'TOKENS_LIMIT');

    // Z.ai percentage represents percentage USED, so remaining = 100 - percentage
    const tokenPctUsed = tokenLimit?.percentage ?? 0;
    const tokenPctRemaining = Math.max(0, 100 - tokenPctUsed);

    const details: string[] = [];
    if (timeLimit && timeLimit.remaining !== undefined && timeLimit.usage !== undefined) {
      details.push(`${timeLimit.remaining.toLocaleString()} / ${timeLimit.usage.toLocaleString()} calls left`);
    }
    if (tokenLimit) {
      details.push(`5-hour token limit: ${tokenPctRemaining}% remaining`);
    }
    if (data.data?.level) {
      details.push(`Tier: ${data.data.level.toUpperCase()}`);
    }

    const resets: QuotaResetInfo[] = [];

    if (tokenLimit?.nextResetTime && tokenLimit.nextResetTime > Date.now()) {
      const d = new Date(tokenLimit.nextResetTime);
      resets.push({
        label: '5-Hour Token Limit',
        countdown: formatCountdown(d),
        targetDate: d,
      });
    }

    if (timeLimit?.nextResetTime && timeLimit.nextResetTime > Date.now()) {
      const d = new Date(timeLimit.nextResetTime);
      resets.push({
        label: 'Call Quota Window',
        countdown: formatCountdown(d),
        targetDate: d,
      });
    }

    // Sort by nearest reset
    resets.sort((a, b) => (a.targetDate?.getTime() ?? 0) - (b.targetDate?.getTime() ?? 0));

    const primaryReset = resets[0];

    const status: UsageStatus =
      tokenPctRemaining <= 10 ? 'critical' : tokenPctRemaining <= 25 ? 'low' : 'ok';

    return {
      providerId: 'zai',
      providerName: 'Z.ai GLM',
      percentageRemaining: tokenPctRemaining,
      details,
      nextResetTime: primaryReset?.targetDate,
      resetCountdown: primaryReset?.countdown,
      resets: resets.length > 0 ? resets : undefined,
      status,
      lastUpdated: new Date(),
    };
  } catch (err) {
    return {
      providerId: 'zai',
      providerName: 'Z.ai GLM',
      details: ['Failed to fetch usage metrics'],
      status: 'error',
      lastUpdated: new Date(),
      errorMessage: (err as Error).message,
    };
  }
}

/** Fetch DeepSeek user balance. */
export async function fetchDeepseekUsage(apiKey: string): Promise<UsageReport> {
  try {
    const res = await fetchWithTimeout('https://api.deepseek.com/user/balance', {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };

    const details: string[] = [];
    let primaryDisplay: string | undefined;

    const infos = data.balance_infos ?? [];
    for (const info of infos) {
      const cur = info.currency ?? 'USD';
      const bal = info.total_balance ?? '0.00';
      const symbol = cur === 'CNY' ? '¥' : '$';
      details.push(`${cur} Balance: ${symbol}${bal}`);
      if (parseFloat(bal) > 0 || !primaryDisplay) {
        primaryDisplay = `${symbol}${bal}`;
      }
    }

    return {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      balanceDisplay: primaryDisplay ?? '$0.00',
      details,
      status: data.is_available === false ? 'critical' : 'ok',
      lastUpdated: new Date(),
    };
  } catch (err) {
    return {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      details: ['Failed to fetch balance'],
      status: 'error',
      lastUpdated: new Date(),
      errorMessage: (err as Error).message,
    };
  }
}

/** Fetch MiniMax token plan remaining quota and burn rates. */
export async function fetchMinimaxUsage(apiKey: string): Promise<UsageReport> {
  try {
    const res = await fetchWithTimeout('https://www.minimax.io/v1/token_plan/remains', {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      model_remains?: Array<{
        model_name?: string;
        current_interval_remaining_percent?: number;
        current_weekly_remaining_percent?: number;
        current_interval_total_count?: number;
        current_interval_usage_count?: number;
        current_weekly_total_count?: number;
        current_weekly_usage_count?: number;
        start_time?: number;
        end_time?: number;
        remains_time?: number;
        weekly_start_time?: number;
        weekly_end_time?: number;
        weekly_remains_time?: number;
      }>;
    };

    const general = data.model_remains?.find((m) => m.model_name === 'general') ?? data.model_remains?.[0];
    const pct = general?.current_interval_remaining_percent ?? 100;
    const weeklyPct = general?.current_weekly_remaining_percent;

    const details: string[] = [];
    if (pct !== undefined) {
      if (general?.current_interval_total_count && general.current_interval_total_count > 0) {
        details.push(
          `5-hour limit: ${pct}% remaining (${general.current_interval_usage_count ?? 0} / ${general.current_interval_total_count} calls)`
        );
      } else {
        details.push(`5-hour interval: ${pct}% remaining`);
      }
    }

    if (weeklyPct !== undefined) {
      if (general?.current_weekly_total_count && general.current_weekly_total_count > 0) {
        details.push(
          `Weekly limit: ${weeklyPct}% remaining (${general.current_weekly_usage_count ?? 0} / ${general.current_weekly_total_count} calls)`
        );
      } else {
        details.push(`Weekly limit: ${weeklyPct}% remaining`);
      }
    }

    // Check for auxiliary model quotas (e.g. video)
    const video = data.model_remains?.find((m) => m.model_name === 'video');
    if (video) {
      if (
        (video.current_interval_total_count !== undefined && video.current_interval_total_count > 0) ||
        (video.current_weekly_total_count !== undefined && video.current_weekly_total_count > 0)
      ) {
        details.push(
          `Video models: ${video.current_interval_usage_count ?? 0}/${video.current_interval_total_count ?? 0} interval, ${video.current_weekly_usage_count ?? 0}/${video.current_weekly_total_count ?? 0} weekly`
        );
      }
    }

    const resets: QuotaResetInfo[] = [];

    // 1. 5-Hour rolling interval reset
    const intervalTarget = general?.end_time
      ? new Date(general.end_time)
      : general?.remains_time
      ? new Date(Date.now() + general.remains_time)
      : undefined;

    if (intervalTarget && intervalTarget.getTime() > Date.now()) {
      resets.push({
        label: '5-Hour Rolling Window',
        countdown: formatCountdown(intervalTarget),
        targetDate: intervalTarget,
      });
    }

    // 2. Weekly quota allowance reset
    const weeklyTarget = general?.weekly_end_time
      ? new Date(general.weekly_end_time)
      : general?.weekly_remains_time
      ? new Date(Date.now() + general.weekly_remains_time)
      : undefined;

    if (weeklyTarget && weeklyTarget.getTime() > Date.now()) {
      resets.push({
        label: 'Weekly Allowance',
        countdown: formatCountdown(weeklyTarget),
        targetDate: weeklyTarget,
      });
    }

    // Sort by nearest reset
    resets.sort((a, b) => (a.targetDate?.getTime() ?? 0) - (b.targetDate?.getTime() ?? 0));

    const primaryReset = resets[0];
    const status: UsageStatus = pct <= 10 ? 'critical' : pct <= 30 ? 'low' : 'ok';

    return {
      providerId: 'minimax',
      providerName: 'MiniMax',
      percentageRemaining: pct,
      details,
      nextResetTime: primaryReset?.targetDate,
      resetCountdown: primaryReset?.countdown,
      resets: resets.length > 0 ? resets : undefined,
      status,
      lastUpdated: new Date(),
    };
  } catch (err) {
    return {
      providerId: 'minimax',
      providerName: 'MiniMax',
      details: ['Failed to fetch token plan quota'],
      status: 'error',
      lastUpdated: new Date(),
      errorMessage: (err as Error).message,
    };
  }
}

/** Fetch Kimi Code membership usage and rolling window limits. */
export async function fetchKimiUsage(apiKey: string): Promise<UsageReport> {
  try {
    const res = await fetchWithTimeout('https://api.kimi.com/coding/v1/usages', {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      user?: { membership?: { level?: string } };
      usage?: { limit?: string; remaining?: string; resetTime?: string };
      limits?: Array<{ detail?: { limit?: string; remaining?: string; resetTime?: string } }>;
    };

    const rollingLimit = data.limits?.[0]?.detail;
    const weeklyUsage = data.usage;

    const remaining = parseInt(rollingLimit?.remaining ?? weeklyUsage?.remaining ?? '100', 10);
    const limit = parseInt(rollingLimit?.limit ?? weeklyUsage?.limit ?? '100', 10);
    const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 100;

    const details: string[] = [];
    if (data.user?.membership?.level) {
      details.push(`Tier: ${data.user.membership.level.replace('LEVEL_', '')}`);
    }
    if (rollingLimit?.remaining && rollingLimit?.limit) {
      details.push(`5-hour limit: ${rollingLimit.remaining} / ${rollingLimit.limit} calls left`);
    }
    if (weeklyUsage?.remaining && weeklyUsage?.limit) {
      details.push(`Weekly limit: ${weeklyUsage.remaining} / ${weeklyUsage.limit} calls left`);
    }

    const resets: QuotaResetInfo[] = [];

    if (rollingLimit?.resetTime) {
      const parsed = new Date(rollingLimit.resetTime);
      if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
        resets.push({
          label: '5-Hour Rolling Window',
          countdown: formatCountdown(parsed),
          targetDate: parsed,
        });
      }
    }

    if (weeklyUsage?.resetTime) {
      const parsed = new Date(weeklyUsage.resetTime);
      if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
        resets.push({
          label: 'Weekly Membership',
          countdown: formatCountdown(parsed),
          targetDate: parsed,
        });
      }
    }

    // Sort by nearest reset
    resets.sort((a, b) => (a.targetDate?.getTime() ?? 0) - (b.targetDate?.getTime() ?? 0));

    const primaryReset = resets[0];

    const status: UsageStatus = pct <= 10 ? 'critical' : pct <= 30 ? 'low' : 'ok';

    return {
      providerId: 'kimi',
      providerName: 'Kimi Code',
      percentageRemaining: pct,
      details,
      nextResetTime: primaryReset?.targetDate,
      resetCountdown: primaryReset?.countdown,
      resets: resets.length > 0 ? resets : undefined,
      status,
      lastUpdated: new Date(),
    };
  } catch (err) {
    return {
      providerId: 'kimi',
      providerName: 'Kimi Code',
      details: ['Failed to fetch membership quota'],
      status: 'error',
      lastUpdated: new Date(),
      errorMessage: (err as Error).message,
    };
  }
}

/** Fetch OpenRouter account credits & usage balance. */
export async function fetchOpenrouterUsage(apiKey: string): Promise<UsageReport> {
  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/credits', {
      Authorization: `Bearer ${apiKey}`,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: {
        total_credits?: number;
        total_usage?: number;
      };
    };

    const credits = data.data?.total_credits ?? 0;
    const usage = data.data?.total_usage ?? 0;
    const remaining = Math.max(0, credits - usage);
    const balanceDisplay = `$${remaining.toFixed(2)}`;

    const details: string[] = [
      `Total Credits: $${credits.toFixed(2)}`,
      `Total Usage: $${usage.toFixed(2)}`,
    ];

    return {
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      balanceDisplay,
      details,
      status: remaining <= 0 ? 'low' : 'ok',
      lastUpdated: new Date(),
    };
  } catch (err) {
    return {
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      details: ['Failed to fetch OpenRouter credits'],
      status: 'error',
      lastUpdated: new Date(),
      errorMessage: (err as Error).message,
    };
  }
}
