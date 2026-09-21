/**
 * 规则求值（设计 §8 / §12.1 第 4 步 / §12.3 / §12.4）。
 *
 * **纯函数**：无 IO、无时间、无随机、不认识任何渠道名。
 * 输入 `RunOutcome`（+ 可选 `RunSummary`），输出 `NotificationRequest | null`。
 *
 * 渠道路由由 `service` 完成；这里只产出 `level` + `channels` 白名单。
 * 修改本文件不得引入任何 `providers/*` 依赖（§17.3 规则 1、2）。
 *
 * 三个刻意的判定选择：
 *  1. `aborted` 与 `unknown` 默认不通知（人就在终端旁 / 拿不到 stopReason 时宁可少发不误报）。
 *  2. `length` 是**完成但被截断**：等级强制抬到 `warning`，标题写明截断（§12.1 第 3 步）。
 *  3. 一个运行**最多一条通知**：`evaluateSettlement` 按「结果 > 聚合的工具失败」取第一个非空，
 *     工具失败名已并入结果通知正文（`content.includeToolFailureNames`）。
 *
 * 正文的**内容字段**（§19）：会话名/项目名标识 / 成本 / 上下文占比 / assistant 摘录。
 * 前三项是元数据，最后一项默认关闭（可能带出文件内容或密钥）。
 */

import { sanitize, sanitizeError } from "./log.ts";
import type {
  NotificationConfig,
  NotificationKind,
  NotificationRequest,
  NotifyLevel,
  RunOutcome,
  RunSummary,
  ToolFailure,
} from "./types.ts";

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 0, warning: 1, error: 2 };

/**
 * assistant 摘录长度（code point）。**刻意写成常量而非配置项**：
 * 多一个配置项就多一个“设了没效果”的机会，而 10 个字只够当提示，长度本身不是需要调参的东西。
 * 真要调长度，正确的触发点是“真打开了它并发现不够”，而不是现在猜一个更大的默认值。
 */
export const ASSISTANT_EXCERPT_CHARS = 10;

/** 截断标记：让“被我们截了”与“模型本来就写了半句”可区分。 */
export const EXCERPT_ELLIPSIS = "…";

/** 首段标识（会话名 / 项目名）的硬上限（避免一个超长名字把正文挤满）。 */
const IDENTITY_LABEL_CHARS = 40;

/** 上下文占比低于 1% 时不显示：“上下文 0%”是噪声，不是信息。 */
const MIN_CONTEXT_PERCENT = 1;

/** 取两个等级中更高的那个（`length` → 至少 warning）。 */
function atLeast(level: NotifyLevel, floor: NotifyLevel): NotifyLevel {
  return LEVEL_RANK[level] >= LEVEL_RANK[floor] ? level : floor;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${rest}s`;
}

function joinBody(parts: string[], config: NotificationConfig): string {
  return sanitize(parts.filter((part) => part !== "").join(" · "), config.content.maxMessageChars);
}

/**
 * 金额展示。
 * `provider` 不报 usage（`undefined`）与“报了但是 0”（本地模型/免费额度）都不显示——
 * 宁可不写，也不要写一个“$0.0000”让用户以为真的免费。
 */
function formatUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  // 单次调用常见是「几分之一美分」量级：小额给 4 位，大额给 2 位。
  const text = value < 1 ? value.toFixed(4) : value.toFixed(2);
  return Number(text) <= 0 ? "" : `$${text}`;
}

/**
 * 正文首段标识：**会话名优先，未命名时回退到项目目录名**。
 * 绝大多数人从不 `/name`，没有回退的话这一栏对他们永远不出现（等于白做）。
 * 两者都是展示用元数据；空白/纯控制字符一律视为“没有”。
 */
function identityLabel(summary: RunSummary | undefined): string {
  const clean = (value: string | undefined): string =>
    typeof value === "string" ? sanitize(value, IDENTITY_LABEL_CHARS) : "";
  return clean(summary?.sessionName) || clean(summary?.projectName);
}

/**
 * assistant 摘录：**先清洗再截断**。
 * 顺序很重要：消息里经常以换行/缩进开头，先截断会把空白截进摘录里，清洗后反而变空。
 *
 * 截断时做两件小事（两者都**只在真的截断时**生效，不干预模型自己写的完整句子）：
 *  1. 去掉被切在末尾的悬空标点（“已修复登录，改”不该以逗号收尾）；
 *  2. 补 `…`，让“被截断”与“模型本来就写了半句”可区分。
 */
function excerptOf(text: string | undefined): string {
  if (typeof text !== "string") return "";
  const points = [...sanitize(text, 200)];
  if (points.length <= ASSISTANT_EXCERPT_CHARS) return points.join("");
  const cut = points.slice(0, ASSISTANT_EXCERPT_CHARS).join("").replace(/[\s·,，、;；:：.。,、|丨/\\-]+$/, "");
  // 极端情况：切出来的全是标点/空白，宁可显示原样也不显示一个只有 `…` 的摘录。
  return cut === "" ? `${points.slice(0, ASSISTANT_EXCERPT_CHARS).join("")}${EXCERPT_ELLIPSIS}` : `${cut}${EXCERPT_ELLIPSIS}`;
}

/** 每行统一在此产出，保证 `channels` 是拷贝、`meta` 一定带 sessionId/runId/level。 */
function request(input: {
  kind: NotificationKind;
  level: NotifyLevel;
  title: string;
  body: string;
  dedupeKey: string;
  channels: string[];
  sessionId: string;
  runId: string;
  durationMs?: number;
  maxChars: number;
  /** 可选：这一条专用的合并窗口（缺省用 `config.coalesce.windowMs`） */
  coalesceWindowMs?: number;
}): NotificationRequest {
  return {
    level: input.level,
    kind: input.kind,
    title: sanitize(input.title, 60),
    body: sanitize(input.body, input.maxChars),
    dedupeKey: input.dedupeKey,
    ...(input.coalesceWindowMs !== undefined ? { coalesceWindowMs: input.coalesceWindowMs } : {}),
    channels: [...input.channels],
    meta: {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      level: input.level,
    },
  };
}

function ruleOf(config: NotificationConfig, kind: NotificationKind) {
  if (kind === "run_completed") return config.rules.runCompleted;
  if (kind === "run_failed") return config.rules.runFailed;
  if (kind === "run_aborted") return config.rules.runAborted;
  if (kind === "tool_failed") return config.rules.toolFailed;
  if (kind === "compact_failed") return config.rules.compactFailed;
  return config.rules.waitingForUser;
}

/** 「N 个工具失败: read, bash」；`includeToolFailureNames=false` 时只给数量（§13 第 16 项）。 */
export function describeToolFailures(failures: ToolFailure[], config: NotificationConfig): string {
  if (failures.length === 0) return "";
  const total = failures.reduce((sum, failure) => sum + failure.count, 0);
  if (!config.content.includeToolFailureNames) return `${total} 个工具失败`;
  const names = failures.map((failure) => failure.toolName).join(", ");
  return `${total} 个工具失败: ${names}`;
}

/**
 * 运行结果 → 通知请求。
 *
 * `aborted` 与 `unknown` 默认不通知，但两条都仍由配置开关控制，规则本身不写死。
 */
export function evaluateRunOutcome(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  const { outcome } = input;
  const kind: NotificationKind | undefined =
    outcome.status === "completed" ? "run_completed"
      : outcome.status === "failed" ? "run_failed"
        : outcome.status === "aborted" ? "run_aborted"
          : undefined;
  if (!kind) return null;

  const rule = ruleOf(config, kind);
  if (!rule.enabled) return null;

  const truncated = outcome.stopReason === "length";
  const title =
    kind === "run_completed" ? (truncated ? "任务完成（输出被截断）" : "任务完成")
      : kind === "run_failed" ? "任务失败"
        : "任务已取消";

  const parts: string[] = [];
  // 顺序即阅读优先级：先说“是哪个任务”，再说“结果如何”，最后才是成本与用户可能不想看的回复摘录。
  if (config.content.includeSessionLabel) {
    const label = identityLabel(input.summary);
    if (label !== "") parts.push(`[${label}]`);
  }
  if (kind === "run_failed" && outcome.errorMessage) {
    parts.push(sanitizeError(outcome.errorMessage, config.content.maxMessageChars));
  }
  if (config.content.includeDuration && outcome.durationMs > 0) {
    parts.push(`用时 ${formatDuration(outcome.durationMs)}`);
  }
  const failures = describeToolFailures(outcome.toolFailures, config);
  if (failures !== "") parts.push(kind === "run_completed" ? `但 ${failures}` : failures);
  if (config.content.includeCost) {
    const cost = formatUsd(outcome.costUsd);
    if (cost !== "") {
      const cumulative = formatUsd(input.summary?.cumulativeCostUsd);
      parts.push(cumulative === "" || cumulative === cost ? `成本 ${cost}` : `成本 ${cost}（累计 ${cumulative}）`);
    }
    const percent = input.summary?.contextPercent;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= MIN_CONTEXT_PERCENT) {
      parts.push(`上下文 ${Math.min(100, Math.round(percent))}%`);
    }
  }
  if (config.content.includeAssistantExcerpt) {
    const excerpt = excerptOf(outcome.assistantExcerpt);
    if (excerpt !== "") parts.push(excerpt);
  }

  return request({
    kind,
    // `length` 不是错误，但「输出被截断」必须比普通完成更显眼。
    level: truncated ? atLeast(rule.level, "warning") : rule.level,
    title,
    body: joinBody(parts, config),
    dedupeKey: `${outcome.sessionId}:${outcome.runId}:${kind}`,
    channels: rule.channels,
    sessionId: outcome.sessionId,
    runId: outcome.runId,
    durationMs: outcome.durationMs,
    maxChars: config.content.maxMessageChars,
  });
}

/**
 * 工具失败（设计 §12.3）。
 *
 * - `aggregate`（默认）：只在**本 run 没有结果通知**时才用（由 `evaluateSettlement` 保证），
 *   否则失败工具名已经在结果通知正文里了，再发一条就是刷屏。
 * - `immediate`：某工具失败次数达到 `threshold` 时立刻发一条（长任务里没人盯着终端）。
 *   去重键含 `toolName`，所以同一 run 内同一工具只会通知一次（service 的 `seen` 负责）。
 */
export function evaluateToolFailure(
  input: {
    sessionId: string;
    runId: string;
    durationMs?: number;
    toolFailures: ToolFailure[];
    /** 本 run 至今的完整汇总（immediate 模式用它把并行失败聚合成一条） */
    accumulated?: ToolFailure[];
    /** 只有 `immediate` 模式才会带上它（表示“刚刚失败的这一个工具”） */
    toolName?: string;
  },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.toolFailed;
  if (!rule.enabled) return null;
  if (input.toolFailures.length === 0) return null;
  const immediate = rule.mode === "immediate";
  // immediate 模式只在失败发生的那一刻发；走到 settled 时说明已经发过了。
  if (immediate && input.toolName === undefined) return null;

  const failures = immediate
    ? (input.accumulated ?? input.toolFailures).filter((failure) => failure.count > 0)
    : input.toolFailures;
  if (failures.length === 0) return null;
  if (!immediate && !satisfiesAggregate(input.toolFailures, rule)) return null;

  const body = describeToolFailures(failures, config);
  if (body === "") return null;

  return request({
    kind: "tool_failed",
    level: rule.level,
    title: immediate ? `工具 ${input.toolName} 失败` : "工具失败",
    body,
    dedupeKey: immediate
      ? `${input.sessionId}:${input.runId}:tool_failed:${input.toolName}`
      : `${input.sessionId}:${input.runId}:tool_failed`,
    // immediate 模式：同一 run 内的并行工具失败用更大的窗口聚合成一条（§12.3）
    ...(immediate ? { coalesceWindowMs: config.coalesce.toolFailureWindowMs } : {}),
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    durationMs: input.durationMs,
    maxChars: config.content.maxMessageChars,
  });
}

function satisfiesAggregate(
  failures: ToolFailure[],
  rule: NotificationConfig["rules"]["toolFailed"],
): boolean {
  const total = failures.reduce((sum, failure) => sum + failure.count, 0);
  return total >= rule.threshold;
}

/**
 * 一个运行的所有候选中挑一条（§12.1 第 4 步）。
 *
 * 顺序即优先级：
 *   1. 运行结果（失败 / 取消 / 完成）——信息最完整，工具失败名已并入正文；
 *   2. 聚合的工具失败——只在运行结果不通知时兜底（例如 `runCompleted` 被关、aborted 不通知）。
 *
 * 「压缩失败」不在这个序列里：它在 `session_compact_failed` 发生的当下就投递
 * （手工 `/compact` 没有 run 可 settle，等到 settled 就永远发不出去）。
 */
export function evaluateSettlement(
  input: { outcome: RunOutcome; summary?: RunSummary },
  config: NotificationConfig,
): NotificationRequest | null {
  return evaluateRunOutcome(input, config)
    ?? evaluateToolFailure(
      {
        sessionId: input.outcome.sessionId,
        runId: input.outcome.runId,
        durationMs: input.outcome.durationMs,
        toolFailures: input.outcome.toolFailures,
      },
      config,
    );
}

/**
 * `session_compact_failed` → 通知（默认 error 级）。
 *
 * `aborted === true` 表示用户自己取消了压缩，不发（与 `run_aborted` 默认静默同理）。
 * 去重键带 `seq`：每一次压缩失败都是一个独立事件，不该被 service 的 `seen` 吞掉；
 * 防刷屏交给 `coalesce.cooldownMs`。
 */
export function evaluateCompactFailure(
  input: {
    sessionId: string;
    runId: string;
    reason: string;
    errorMessage?: string;
    aborted: boolean;
    seq: number;
  },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.compactFailed;
  if (!rule.enabled) return null;
  if (input.aborted) return null;

  const parts: string[] = [`触发原因 ${input.reason}`];
  if (input.errorMessage) parts.push(sanitizeError(input.errorMessage, config.content.maxMessageChars));

  return request({
    kind: "compact_failed",
    level: rule.level,
    title: "上下文压缩失败",
    body: joinBody(parts, config),
    dedupeKey: `${input.sessionId}:compact_failed:${input.seq}`,
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    maxChars: config.content.maxMessageChars,
  });
}

/**
 * `ui_prompt_start` → 「Pi 在等你」。默认关闭（与 `run_completed` 高度重叠，§12.4）。
 *
 * 白名单由配置给出，且 `rules.waitingForUser.kinds` 在配置校验时就已经**过滤掉 `custom`**
 * （§18.5 修订 1：`custom` 也被加载器/进度 UI 使用，与用户输入无关）。
 * 标题是用户可读的，且经过 `sanitize()`，不会把控制字符带进终端。
 */
export function evaluateWaitingForUser(
  input: { sessionId: string; runId: string; kind: string; title?: string; seq: number },
  config: NotificationConfig,
): NotificationRequest | null {
  const rule = config.rules.waitingForUser;
  if (!rule.enabled) return null;
  if (input.kind === "custom") return null; // 硬性排除，不依赖配置
  if (!rule.kinds.includes(input.kind as (typeof rule.kinds)[number])) return null;

  const body = input.title && input.title.trim() !== ""
    ? `等待你确认：${input.title}`
    : `Pi 正在等待你输入（${input.kind}）`;

  return request({
    kind: "waiting_for_user",
    level: rule.level,
    title: "轮到你输入",
    body,
    dedupeKey: `${input.sessionId}:waiting_for_user:${input.seq}`,
    channels: rule.channels,
    sessionId: input.sessionId,
    runId: input.runId,
    maxChars: config.content.maxMessageChars,
  });
}
