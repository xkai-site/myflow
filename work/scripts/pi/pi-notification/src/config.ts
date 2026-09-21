/**
 * 配置（设计 §10 / §13 第 5 、6 项；UX 方案 §值模型）。
 *
 * 三层值：**出厂默认 → 用户级默认（稀疏文件） → 本对话选择（overlay，见 settings.ts）**。
 * 本模块只负责前两层 + 降级，不读项目级配置（已删除该层）。
 *
 * 写盘先校验，再同目录临时文件（0o600）+ 原子 rename；失败不覆盖原文件。
 *
 * 两条关键健壮性规则：
 *  1. **损坏配置不静默全关**（§13 第 5 项）：解析或校验失败时降级为「仅 terminal + 仅 error +
 *     只开 run_failed」，并留下可查的原因（状态总览会显示），而不是把通知悄悄关掉。
 *     理由：用户写错一个逗号就再也收不到失败通知，是这个插件最糟糕的失败模式。
 *  2. **稀疏写盘**：Ctrl+S 只写被保存的那一项（`writeUserDefault`），不把其余字段钉死在今天的默认值上。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { isPlainObject, mergePatch, type ConfigPatch } from "./patch.ts";

import type {
  NotificationConfig,
  NotifyLevel,
  ProviderConfig,
  RuleConfig,
  ToolFailureMode,
  ToolFailureRuleConfig,
  UIPromptKind,
  WaitingForUserRuleConfig,
} from "./types.ts";

export const CONFIG_VERSION = 1;

const LEVELS: NotifyLevel[] = ["info", "warning", "error"];

/** 规则名 → 配置键的映射（配置里用 camelCase，与 §10.2 一致）。 */
const RULE_KEYS = [
  "runCompleted",
  "runFailed",
  "runAborted",
  "toolFailed",
  "compactFailed",
  "waitingForUser",
] as const;

const TOOL_FAILURE_MODES: ToolFailureMode[] = ["aggregate", "immediate"];

/**
 * `ui_prompt_*` 允许出现在配置里的 kind。
 * `custom` **永久排除**（§18.5 修订 1：它同时被加载器/进度 UI 使用，与用户输入无关）。
 */
export const ALLOWED_PROMPT_KINDS: UIPromptKind[] = ["select", "confirm", "input", "editor"];

const ALL_PROMPT_KINDS: UIPromptKind[] = [...ALLOWED_PROMPT_KINDS, "custom"];

export interface ConfigProblem {
  /** 出问题的字段路径，例如 `delivery.timeoutMs` */
  path: string;
  message: string;
}

export interface ConfigLoadResult {
  config: NotificationConfig;
  /** 实际生效的来源，用于状态总览与排障 */
  sources: string[];
  /** 解析/校验中的致命问题（会导致降级） */
  errors: ConfigProblem[];
  /** 非致命问题（例如未知字段） */
  warnings: ConfigProblem[];
  /** true 表示已降级为安全子集 */
  degraded: boolean;
}

export interface ReadConfigOptions {
  /** 用户级目录（`getAgentDir()`） */
  agentDir: string;
}

/** 用户级配置文件路径（`~/.pi/agent/pi-notification/config.json`）。存的是**稀疏用户默认**。 */
export function userConfigPath(agentDir: string): string {
  return path.join(agentDir, "pi-notification", "config.json");
}

/**
 * 默认配置。
 *
 * 渠道默认为 `terminal`（阶段 1：系统桌面通知，零凭据/零网络/零依赖）。
 * `debug` 渠道仍然注册着，可在配置里手动改用它把通知写成日志（排障用）。
 */
export function defaultConfig(): NotificationConfig {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    minLevel: "info",
    rules: {
      runCompleted: { enabled: true, level: "info", channels: ["terminal"] },
      runFailed: { enabled: true, level: "error", channels: ["terminal"] },
      // 用户按 Esc 时人就在终端旁，默认静默（§12.1 第 3 步）。
      runAborted: { enabled: false, level: "info", channels: ["terminal"] },
      // 工具失败默认聚合成一条（§12.3），且当本 run 已有结果通知时不再重复发。
      toolFailed: { enabled: true, level: "warning", channels: ["terminal"], mode: "aggregate", threshold: 1 },
      compactFailed: { enabled: true, level: "error", channels: ["terminal"] },
      // 与 run_completed 高度重叠，默认关闭（§12.4）。`custom` 永远不在白名单里。
      waitingForUser: { enabled: false, level: "info", channels: ["terminal"], kinds: [...ALLOWED_PROMPT_KINDS] },
    },
    coalesce: {
      // 同一逻辑运行（sessionId+runId）内只放行一条通知：防「一次运行多条事件」刷屏。
      windowMs: 1500,
      toolFailureWindowMs: 10000,
      // 同 kind 两次通知的最小间隔（用户连点两次、极短时间内的多次运行只提醒一次）。
      cooldownMs: 3000,
    },
    quietHours: { enabled: false, start: "23:00", end: "08:00", exceptLevels: ["error"] },
    content: {
      includeDuration: true,
      includeToolFailureNames: true,
      // 首段标识：会话名优先，未命名时回退到项目目录名；两者都是展示用元数据。
      includeSessionLabel: true,
      // 默认不外传 assistant 回复（可能带出文件内容/密钥）——§13 第 16 项。
      includeAssistantExcerpt: false,
      includeCost: true,
      maxMessageChars: 300,
    },
    delivery: {
      timeoutMs: 8000,
      // 重试/熔断由 providers/decorators 执行（§17.2）。
      maxRetries: 1,
      concurrency: 1,
      queueLimit: 50,
      circuitBreakerFailures: 3,
    },
    providers: [{ id: "terminal", type: "terminal", enabled: true, options: {} }],
    // session_shutdown 内可以等这么久（§18.4：退出路径必须带短超时）。
    shutdownFlushMs: 200,
  };
}

/**
 * 安全降级配置：只保留「失败通知 + 终端渠道 + error 门槛」。
 * 配置损坏时用它继续工作，并让用户能从 `/notify status` 看到原因。
 *
 * 降级只留 `run_failed` 一条路径，是因为「配置写错就收不到失败通知」是最糟糕的失败模式；
 * 其余规则（含 S6 的工具失败/压缩失败）一律关掉，避免用一份坏配置产生噪音。
 */
export function degradedConfig(): NotificationConfig {
  const config = defaultConfig();
  config.minLevel = "error";
  config.rules = {
    runCompleted: { enabled: false, level: "info", channels: ["terminal"] },
    runFailed: { enabled: true, level: "error", channels: ["terminal"] },
    runAborted: { enabled: false, level: "info", channels: ["terminal"] },
    toolFailed: {
      enabled: false,
      level: "warning",
      channels: ["terminal"],
      mode: "aggregate",
      threshold: 1,
    },
    compactFailed: { enabled: false, level: "error", channels: ["terminal"] },
    waitingForUser: { enabled: false, level: "info", channels: ["terminal"], kinds: [...ALLOWED_PROMPT_KINDS] },
  };
  return config;
}

// ---------------------------------------------------------------------------
// 校验：逐字段严格检查（风格参考 pi-image-generation 的 model-config）
// ---------------------------------------------------------------------------

function checkBoolean(
  raw: Record<string, unknown>,
  key: string,
  target: { [k: string]: unknown },
  fieldPath: string,
  errors: ConfigProblem[],
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    errors.push({ path: fieldPath, message: `必须是布尔值，实际是 ${JSON.stringify(value)}` });
    return;
  }
  target[key] = value;
}

function checkLevel(value: unknown, fieldPath: string, errors: ConfigProblem[]): NotifyLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !LEVELS.includes(value as NotifyLevel)) {
    errors.push({ path: fieldPath, message: `必须是 ${LEVELS.join(" | ")} 之一，实际是 ${JSON.stringify(value)}` });
    return undefined;
  }
  return value as NotifyLevel;
}

function checkPositiveInt(
  raw: Record<string, unknown>,
  key: string,
  target: { [k: string]: unknown },
  fieldPath: string,
  errors: ConfigProblem[],
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    errors.push({ path: fieldPath, message: `必须是 ${min}..${max} 的整数，实际是 ${JSON.stringify(value)}` });
    return;
  }
  target[key] = value;
}

function checkChannels(value: unknown, fieldPath: string, errors: ConfigProblem[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    errors.push({ path: fieldPath, message: `必须是字符串数组（渠道 id），实际是 ${JSON.stringify(value)}` });
    return undefined;
  }
  return [...new Set(value as string[])];
}

function checkRules(
  value: unknown,
  baseRules: NotificationConfig["rules"],
  errors: ConfigProblem[],
  warnings: ConfigProblem[],
): Partial<Record<string, RuleConfig>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ path: "rules", message: "必须是对象" });
    return undefined;
  }
  const result: Record<string, RuleConfig> = {};
  for (const [key, ruleRaw] of Object.entries(value)) {
    const fieldPath = `rules.${key}`;
    if (!(RULE_KEYS as readonly string[]).includes(key)) {
      // 允许未来规则名出现在配置里（前向兼容），但不生效
      warnings.push({ path: fieldPath, message: "未知规则名，已忽略（可能是更新版本写入的）" });
      continue;
    }
    if (!isPlainObject(ruleRaw)) {
      errors.push({ path: fieldPath, message: "必须是对象" });
      continue;
    }
    // 从 **base** 继承，不是从出厂默认继承：单项保存/三层合并时，同规则的其它字段必须原样保留。
    const base = baseRules as unknown as Record<string, RuleConfig>;
    const rule: RuleConfig = structuredClone(base[key]);
    const target = rule as unknown as Record<string, unknown>;
    checkBoolean(ruleRaw, "enabled", target, `${fieldPath}.enabled`, errors);
    const level = checkLevel(ruleRaw.level, `${fieldPath}.level`, errors);
    if (level) rule.level = level;
    const channels = checkChannels(ruleRaw.channels, `${fieldPath}.channels`, errors);
    if (channels) rule.channels = channels;

    if (key === "toolFailed") {
      const toolRule = rule as ToolFailureRuleConfig;
      if (ruleRaw.mode !== undefined) {
        if (typeof ruleRaw.mode !== "string" || !TOOL_FAILURE_MODES.includes(ruleRaw.mode as ToolFailureMode)) {
          errors.push({ path: `${fieldPath}.mode`, message: `必须是 ${TOOL_FAILURE_MODES.join(" | ")} 之一，实际是 ${JSON.stringify(ruleRaw.mode)}` });
        } else {
          toolRule.mode = ruleRaw.mode as ToolFailureMode;
        }
      }
      checkPositiveInt(ruleRaw, "threshold", target, `${fieldPath}.threshold`, errors, { min: 1, max: 100 });
    }

    if (key === "waitingForUser") {
      const waitingRule = rule as WaitingForUserRuleConfig;
      if (ruleRaw.kinds !== undefined) {
        if (!Array.isArray(ruleRaw.kinds) || ruleRaw.kinds.some((item) => typeof item !== "string")) {
          errors.push({ path: `${fieldPath}.kinds`, message: `必须是字符串数组，实际是 ${JSON.stringify(ruleRaw.kinds)}` });
        } else {
          const requested = [...new Set(ruleRaw.kinds as string[])];
          const unknown = requested.filter((item) => !ALL_PROMPT_KINDS.includes(item as UIPromptKind));
          if (unknown.length > 0) {
            errors.push({ path: `${fieldPath}.kinds`, message: `未知的 prompt kind: ${unknown.join(", ")}` });
          }
          // `custom` 永久排除：即使写进配置也不生效（§18.5 修订 1）
          if (requested.includes("custom")) {
            warnings.push({ path: `${fieldPath}.kinds`, message: "`custom` 永久排除（加载器/进度 UI 也会触发它），已忽略" });
          }
          waitingRule.kinds = requested.filter((item) => ALLOWED_PROMPT_KINDS.includes(item as UIPromptKind)) as UIPromptKind[];
        }
      }
    }

    result[key] = rule;
  }
  return result as Partial<Record<string, RuleConfig>>;
}

function checkProviders(value: unknown, errors: ConfigProblem[]): ProviderConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ path: "providers", message: "必须是数组" });
    return undefined;
  }
  const seen = new Set<string>();
  const providers: ProviderConfig[] = [];
  value.forEach((item, index) => {
    const fieldPath = `providers[${index}]`;
    if (!isPlainObject(item)) {
      errors.push({ path: fieldPath, message: "必须是对象" });
      return;
    }
    const id = item.id;
    const type = item.type;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push({ path: `${fieldPath}.id`, message: "必须是非空字符串" });
      return;
    }
    if (seen.has(id)) {
      errors.push({ path: `${fieldPath}.id`, message: `渠道 id 重复: ${id}` });
      return;
    }
    if (typeof type !== "string" || type.trim() === "") {
      errors.push({ path: `${fieldPath}.type`, message: "必须是非空字符串" });
      return;
    }
    const options = item.options;
    if (options !== undefined && !isPlainObject(options)) {
      errors.push({ path: `${fieldPath}.options`, message: "必须是对象" });
      return;
    }
    seen.add(id);
    providers.push({
      id,
      type,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      options: (options as Record<string, unknown> | undefined) ?? {},
    });
  });
  return providers;
}

/**
 * 把「用户提供的部分配置」叠到 base 上。任何字段非法都会记入 errors（由调用方决定是否降级）。
 */
export function mergeConfig(base: NotificationConfig, raw: unknown, source: string): {
  config: NotificationConfig;
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
} {
  const errors: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  if (!isPlainObject(raw)) {
    return { config: base, errors: [{ path: source, message: "配置根必须是 JSON 对象" }], warnings };
  }

  const config: NotificationConfig = structuredClone(base);

  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    errors.push({ path: "version", message: `只支持 version ${CONFIG_VERSION}，实际是 ${JSON.stringify(raw.version)}` });
  }

  checkBoolean(raw, "enabled", config as unknown as Record<string, unknown>, "enabled", errors);
  const minLevel = checkLevel(raw.minLevel, "minLevel", errors);
  if (minLevel) config.minLevel = minLevel;

  const rules = checkRules(raw.rules, base.rules, errors, warnings);
  if (rules) {
    for (const key of RULE_KEYS) {
      const override = rules[key];
      if (override) config.rules[key] = override;
    }
  }

  if (raw.quietHours !== undefined) {
    if (!isPlainObject(raw.quietHours)) {
      errors.push({ path: "quietHours", message: "必须是对象" });
    } else {
      const quiet = raw.quietHours;
      checkBoolean(quiet, "enabled", config.quietHours as unknown as Record<string, unknown>, "quietHours.enabled", errors);
      for (const key of ["start", "end"] as const) {
        if (quiet[key] === undefined) continue;
        if (typeof quiet[key] !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(quiet[key])) {
          errors.push({ path: `quietHours.${key}`, message: "必须是严格 HH:MM（00:00–23:59）" });
        } else {
          config.quietHours[key] = quiet[key];
        }
      }
      if (quiet.exceptLevels !== undefined) {
        if (!Array.isArray(quiet.exceptLevels) || quiet.exceptLevels.some((level) => !LEVELS.includes(level))) {
          errors.push({ path: "quietHours.exceptLevels", message: "必须是 info | warning | error 等级数组" });
        } else {
          config.quietHours.exceptLevels = [...new Set(quiet.exceptLevels)] as NotifyLevel[];
        }
      }
    }
  }

  if (raw.content !== undefined) {
    if (!isPlainObject(raw.content)) {
      errors.push({ path: "content", message: "必须是对象" });
    } else {
      checkBoolean(raw.content, "includeDuration", config.content as unknown as Record<string, unknown>, "content.includeDuration", errors);
      checkBoolean(raw.content, "includeToolFailureNames", config.content as unknown as Record<string, unknown>, "content.includeToolFailureNames", errors);
      checkBoolean(raw.content, "includeSessionLabel", config.content as unknown as Record<string, unknown>, "content.includeSessionLabel", errors);
      checkBoolean(raw.content, "includeAssistantExcerpt", config.content as unknown as Record<string, unknown>, "content.includeAssistantExcerpt", errors);
      checkBoolean(raw.content, "includeCost", config.content as unknown as Record<string, unknown>, "content.includeCost", errors);
      checkPositiveInt(raw.content, "maxMessageChars", config.content as unknown as Record<string, unknown>, "content.maxMessageChars", errors, { min: 20, max: 2000 });
    }
  }

  if (raw.delivery !== undefined) {
    if (!isPlainObject(raw.delivery)) {
      errors.push({ path: "delivery", message: "必须是对象" });
    } else {
      checkPositiveInt(raw.delivery, "timeoutMs", config.delivery as unknown as Record<string, unknown>, "delivery.timeoutMs", errors, { min: 1, max: 120000 });
      checkPositiveInt(raw.delivery, "maxRetries", config.delivery as unknown as Record<string, unknown>, "delivery.maxRetries", errors, { min: 0, max: 10 });
      checkPositiveInt(raw.delivery, "concurrency", config.delivery as unknown as Record<string, unknown>, "delivery.concurrency", errors, { min: 1, max: 8 });
      checkPositiveInt(raw.delivery, "queueLimit", config.delivery as unknown as Record<string, unknown>, "delivery.queueLimit", errors, { min: 1, max: 1000 });
      checkPositiveInt(raw.delivery, "circuitBreakerFailures", config.delivery as unknown as Record<string, unknown>, "delivery.circuitBreakerFailures", errors, { min: 0, max: 100 });
    }
  }

  if (raw.coalesce !== undefined) {
    if (!isPlainObject(raw.coalesce)) {
      errors.push({ path: "coalesce", message: "必须是对象" });
    } else {
      // 0 是合法值 = 关闭该项过滤（测试与「每次运行都要提醒」的用户需要它）
      checkPositiveInt(raw.coalesce, "windowMs", config.coalesce as unknown as Record<string, unknown>, "coalesce.windowMs", errors, { min: 0, max: 600000 });
      checkPositiveInt(raw.coalesce, "toolFailureWindowMs", config.coalesce as unknown as Record<string, unknown>, "coalesce.toolFailureWindowMs", errors, { min: 0, max: 600000 });
      checkPositiveInt(raw.coalesce, "cooldownMs", config.coalesce as unknown as Record<string, unknown>, "coalesce.cooldownMs", errors, { min: 0, max: 600000 });
    }
  }

  checkPositiveInt(raw, "shutdownFlushMs", config as unknown as Record<string, unknown>, "shutdownFlushMs", errors, { min: 0, max: 5000 });

  const providers = checkProviders(raw.providers, errors);
  if (providers) config.providers = providers;

  return { config, errors, warnings };
}

// ---------------------------------------------------------------------------
// 读盘（出厂默认 → 用户级默认）
// ---------------------------------------------------------------------------

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean; message: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, missing, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, missing: false, message: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 载入有效配置：内置默认值 → 用户级默认值（稀疏）。
 *
 * 任何一层出现致命错误都会**整份降级**为安全子集（不静默全关），并保留原因。
 * 本对话覆盖不在这里 —— 由 `settings.ts` 的 `applyOverlay()` 叠在结果之上。
 */
export function loadConfig(options: ReadConfigOptions): ConfigLoadResult {
  const errors: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const sources: string[] = ["defaults"];

  let config = defaultConfig();

  const userPath = userConfigPath(options.agentDir);
  const userRaw = readJsonFile(userPath);
  if (userRaw.ok) {
    const merged = mergeConfig(config, userRaw.value, userPath);
    errors.push(...merged.errors);
    warnings.push(...merged.warnings);
    config = merged.config;
    sources.push(userPath);
  } else if (!userRaw.missing) {
    errors.push({ path: userPath, message: userRaw.message });
    sources.push(`${userPath}（读取失败）`);
  }

  if (errors.length > 0) {
    return { config: degradedConfig(), sources, errors, warnings, degraded: true };
  }
  return { config, sources, errors, warnings, degraded: false };
}

export type ConfigWriteResult =
  | { ok: true; config: NotificationConfig; problems: ConfigProblem[]; warnings: ConfigProblem[] }
  | { ok: false; problems: ConfigProblem[] };

/**
 * 读用户文件**原文**（不合并默认值）。Ctrl+S 的稀疏写盘与「该项是否已被保存过」都靠它。
 * 文件不存在 → `raw: undefined`；文件损坏或根不是对象 → `ok: false`（调用方必须拒绝覆盖）。
 */
export function readUserConfigRaw(
  agentDir: string,
): { ok: true; raw: Record<string, unknown> | undefined } | { ok: false; problems: ConfigProblem[] } {
  const file = userConfigPath(agentDir);
  const read = readJsonFile(file);
  if (read.ok) {
    if (!isPlainObject(read.value)) return { ok: false, problems: [{ path: file, message: "配置根必须是 JSON 对象" }] };
    return { ok: true, raw: read.value };
  }
  if (read.missing) return { ok: true, raw: undefined };
  return { ok: false, problems: [{ path: file, message: read.message }] };
}

/**
 * 把单项补丁合并进用户文件并原子写盘（Ctrl+S）。
 *
 * 与 `writeUserConfig` 的区别：**写的是稀疏用户默认**（原文已有字段 + 本次这一个补丁），
 * 不把其余字段写成今天的默认值快照，因此用户没碰过的项仍然跟随出厂默认。
 * 损坏原文件 → 拒绝写入（否则会把安全降级结果固化成用户默认）。
 */
export function writeUserDefault(agentDir: string, patch: ConfigPatch): ConfigWriteResult {
  const file = userConfigPath(agentDir);
  const current = readUserConfigRaw(agentDir);
  if (!current.ok) return { ok: false, problems: current.problems };
  const sparse = mergePatch(current.raw ?? {}, patch);
  // 写盘前用同一套严格校验（单项也走全量字段校验，非法值一律拒绝）。
  const merged = mergeConfig(defaultConfig(), sparse, file);
  if (merged.errors.length > 0) return { ok: false, problems: merged.errors };
  const written = atomicWriteConfig(agentDir, `${JSON.stringify(sparse, null, 2)}\n`);
  if (!written.ok) return written;
  return { ok: true, config: merged.config, problems: [], warnings: merged.warnings };
}

/**
 * 写用户层完整快照（测试与迁移用）；调用方只能在成功之后更新内存态。
 * 新代码优先用 `writeUserDefault` 写单项。
 */
export function writeUserConfig(agentDir: string, raw: unknown): ConfigWriteResult {
  const file = userConfigPath(agentDir);
  const merged = mergeConfig(defaultConfig(), raw, file);
  if (merged.errors.length > 0) return { ok: false, problems: merged.errors };
  const written = atomicWriteConfig(agentDir, `${JSON.stringify(merged.config, null, 2)}\n`);
  if (!written.ok) return written;
  return { ok: true, config: merged.config, problems: [], warnings: merged.warnings };
}

/**
 * 原子写盘：同目录临时文件用 `wx` 独占创建（`0o600`）→ 关闭 → rename；绝不先删目的文件。
 * 失败时保留原文件，临时文件尽力清理。
 */
function atomicWriteConfig(
  agentDir: string,
  text: string,
): { ok: true } | { ok: false; problems: ConfigProblem[] } {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const file = userConfigPath(agentDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const candidate = path.join(path.dirname(file), `.config-${randomUUID()}.tmp`);
    fd = openSync(candidate, "wx", 0o600);
    temporary = candidate; // 只清理本次成功创建的文件
    writeFileSync(fd, text, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    temporary = undefined;
    return { ok: true };
  } catch (error) {
    return { ok: false, problems: [{ path: "userConfig", message: error instanceof Error ? error.message : String(error) }] };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
}

/** 会话级静默开关（§10.3 的环境变量覆盖）。 */
export function isDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_NOTIFY_DISABLE === "1" || env.PI_NOTIFY_DISABLE === "true";
}

/** 供 `/notify status` 展示的简短描述。 */
export function describeConfig(config: NotificationConfig): string {
  const enabledRules = RULE_KEYS.filter((key) => config.rules[key].enabled).map((key) => key);
  const providers = config.providers.filter((provider) => provider.enabled).map((provider) => `${provider.id}:${provider.type}`);
  return [
    `enabled=${config.enabled}`,
    `minLevel=${config.minLevel}`,
    `rules=${enabledRules.join(",") || "none"}`,
    `providers=${providers.join(",") || "none"}`,
    `timeoutMs=${config.delivery.timeoutMs}`,
  ].join(" ");
}
