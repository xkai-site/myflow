const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexUsageResponse {
  [key: string]: unknown;
}

export type UsageFetch = typeof fetch;

export interface UsageWindow {
  label: string;
  usedPercent?: number;
  resetAtMs?: number;
  resetAfterSeconds?: number;
}

export interface UsageSummary {
  planType?: string;
  windows: UsageWindow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}

function parseResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function windowLabel(seconds: unknown, fallback: string): string {
  if (seconds === 18_000) return "5 小时窗口";
  if (seconds === 604_800) return "7 天窗口";
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return `${fallback}（${seconds} 秒）`;
  }
  return fallback;
}

function parseWindow(value: unknown, fallback: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  let usedPercent = validPercent(value.used_percent);
  if (usedPercent === undefined) {
    const percentLeft = validPercent(value.percent_left);
    if (percentLeft !== undefined) usedPercent = 100 - percentLeft;
  }
  const resetAtMs = parseResetAt(value.reset_at);
  const after = value.reset_after_seconds;
  const resetAfterSeconds = typeof after === "number" && Number.isFinite(after) && after >= 0
    ? after : undefined;
  const limitSeconds = value.limit_window_seconds;
  if (usedPercent === undefined && resetAtMs === undefined && resetAfterSeconds === undefined) return undefined;
  return {
    label: windowLabel(limitSeconds, fallback),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
  };
}

/** Extract recognized plan and quota-window fields; ignore unknown or malformed fields. */
export function parseCodexUsage(data: CodexUsageResponse): UsageSummary {
  const planType = typeof data.plan_type === "string" && data.plan_type.trim()
    ? data.plan_type.trim() : undefined;
  const windows: UsageWindow[] = [];
  const rateLimits = [data.rate_limit ?? data.rate_limits].filter(isRecord);
  for (const rateLimit of rateLimits) {
    for (const [key, fallback] of [["primary_window", "主要窗口"], ["secondary_window", "次要窗口"]] as const) {
      const window = parseWindow(rateLimit[key], fallback);
      if (window && !windows.some((item) => item.label === window.label)) windows.push(window);
    }
  }
  // Keep named feature limits separate so distinct quotas remain visible.
  if (Array.isArray(data.additional_rate_limits)) {
    for (const [index, value] of data.additional_rate_limits.entries()) {
      if (!isRecord(value)) continue;
      const label = [value.name, value.limit_name, value.feature].find(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )?.trim() ?? `附加窗口 ${index + 1}`;
      const window = parseWindow(value.rate_limit ?? value, label);
      if (window && !windows.some((item) => item.label === window.label)) windows.push(window);
    }
  }
  // Also accept explicitly named five_hour and weekly window fields.
  for (const [key, fallback] of [["five_hour", "5 小时窗口"], ["weekly", "7 天窗口"]] as const) {
    const window = parseWindow(data[key], fallback);
    if (window && !windows.some((item) => item.label === window.label)) windows.push(window);
  }
  return { ...(planType ? { planType } : {}), windows };
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatReset(window: UsageWindow, now: number): string | undefined {
  const at = window.resetAtMs ?? (window.resetAfterSeconds !== undefined
    ? now + window.resetAfterSeconds * 1000 : undefined);
  const chinaAt = at === undefined ? undefined : at + 8 * 60 * 60 * 1000;
  if (at === undefined || !Number.isFinite(new Date(at).getTime()) ||
      chinaAt === undefined || !Number.isFinite(new Date(chinaAt).getTime())) return undefined;
  const utc = new Date(at).toISOString().slice(0, 16).replace("T", " ");
  const china = new Date(chinaAt).toISOString().slice(0, 16).replace("T", " ");
  return `重置时间：${utc} UTC（北京时间：${china}）`;
}

function displayWidth(text: string): number {
  return Array.from(text).reduce((width, char) =>
    width + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
}

function padDisplayWidth(text: string, targetWidth: number): string {
  return text + " ".repeat(Math.max(0, targetWidth - displayWidth(text)));
}

/** Format recognized summary fields without serializing unrecognized response data. */
export function formatCodexUsage(summary: UsageSummary, now: number = Date.now()): string {
  const lines = ["OpenAI 用量查询", `套餐：${summary.planType ?? "未知"}`];
  const labelWidth = Math.max(0, ...summary.windows.map((window) => displayWidth(window.label)));
  const usedTexts = summary.windows.map((window) => window.usedPercent === undefined
    ? undefined : `已用 ${formatPercent(window.usedPercent)}`);
  const usedWidth = Math.max(0, ...usedTexts.filter((text): text is string => text !== undefined).map(displayWidth));
  for (const [index, window] of summary.windows.entries()) {
    const reset = formatReset(window, now);
    const used = usedTexts[index];
    let details = "暂无可用数据";
    if (used && reset) {
      details = `${used}；${" ".repeat(usedWidth - displayWidth(used))}${reset}`;
    } else if (used || reset) {
      details = used ?? reset!;
    }
    lines.push(`${padDisplayWidth(window.label, labelWidth)}：${details}`);
  }
  if (!summary.planType && summary.windows.length === 0) {
    lines.push("接口返回成功，但暂未识别到套餐或用量窗口字段。内部接口格式可能已变化。");
  }
  return lines.join("\n");
}

/** Fetch usage for accountId with the supplied access token; credentials are sent only in request headers. */
export async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
  fetchImpl: UsageFetch = fetch,
): Promise<CodexUsageResponse> {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) throw new Error("缺少有效的 Codex access token。");
  const account = typeof accountId === "string" ? accountId.trim() : "";
  if (!account) throw new Error("缺少有效的 ChatGPT 账号 ID。");

  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": account,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("查询 OpenAI 用量超时，请稍后重试。", { cause: error });
    }
    throw new Error("无法连接 OpenAI 用量接口，请检查网络后重试。", { cause: error });
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("OpenAI 用量接口拒绝了登录凭据（401）。请通过 Codex 更新登录后重试。");
    }
    if (response.status === 403) {
      throw new Error("当前账号无权查询此用量接口（403）。");
    }
    if (response.status === 429) {
      throw new Error("OpenAI 用量接口请求过于频繁（429），请稍后重试。");
    }
    throw new Error(`OpenAI 用量接口请求失败（HTTP ${response.status}）。`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error("OpenAI 用量接口返回了无效 JSON。", { cause: error });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("OpenAI 用量接口返回格式不是 JSON 对象。");
  }
  return data as CodexUsageResponse;
}
