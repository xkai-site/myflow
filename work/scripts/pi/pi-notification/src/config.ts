/**
 * 配置（设计 §10 / §13 第 5、6、7 项）。
 *
 * 本轮实现：内置默认值 + 用户级读盘 + 校验 + 降级 + 项目级合并（仅信任项目）。
 * **不做**：写入（原子写/`0o600`）、配置向导、`/notify reload` —— 那些属于 S5 的完整形态；
 * 本轮没有"改配置"的命令，因此暂时不需要写盘。
 *
 * 两条关键安全/健壮性规则：
 *  1. **损坏配置不静默全关**（§13 第 5 项）：解析或校验失败时降级为「仅 terminal + 仅 error +
 *     只开 run_failed」，并留下可查的原因（`/notify status` 会显示），而不是把通知悄悄关掉。
 *     理由：用户写错一个逗号就再也收不到失败通知，是这个插件最糟糕的失败模式。
 *  2. **项目级配置不得定义渠道**（§13 第 7 项）：`.pi/pi-notification/config.json` 只在项目被
 *     信任时读取，且其中的 `providers` 会被忽略并告警——渠道将来会承载 URL/密钥，
 *     不能让一个被 clone 下来的仓库决定把通知发到哪里。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

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
  /** 实际生效的来源，用于 `/notify status` 与排障 */
  sources: string[];
  /** 解析/校验中的致命问题（会导致降级） */
  errors: ConfigProblem[];
  /** 非致命问题（例如未知字段、被忽略的项目级 providers） */
  warnings: ConfigProblem[];
  /** true 表示已降级为安全子集 */
  degraded: boolean;
}

export interface ReadConfigOptions {
  /** 用户级目录（`getAgentDir()`） */
  agentDir: string;
  /** 项目根（`ctx.cwd`）；未信任时传 undefined */
  cwd?: string;
  /** 项目级配置目录名（官方 `CONFIG_DIR_NAME`，通常为 `.pi`）；由调用方注入，本模块不依赖 SDK */
  configDirName: string;
  /** 仅当项目被信任时才允许合并项目级配置 */
  projectTrusted: boolean;
}

/** 用户级配置文件路径（`~/.pi/agent/pi-notification/config.json`）。 */
export function userConfigPath(agentDir: string): string {
  return path.join(agentDir, "pi-notification", "config.json");
}

/** 项目级配置文件路径（`<cwd>/.pi/pi-notification/config.json`）。 */
export function projectConfigPath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, "pi-notification", "config.json");
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
    content: {
      includeDuration: true,
      includeToolFailureNames: true,
      // 默认不外传用户输入与完整回复（§13 第 16 项）。
      includePromptExcerpt: false,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function checkRules(value: unknown, errors: ConfigProblem[], warnings: ConfigProblem[]): Partial<Record<string, RuleConfig>> | undefined {
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
    const defaults = defaultConfig().rules as unknown as Record<string, RuleConfig>;
    const rule: RuleConfig = structuredClone(defaults[key]);
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

  const rules = checkRules(raw.rules, errors, warnings);
  if (rules) {
    for (const key of RULE_KEYS) {
      const override = rules[key];
      if (override) config.rules[key] = override;
    }
  }

  if (raw.content !== undefined) {
    if (!isPlainObject(raw.content)) {
      errors.push({ path: "content", message: "必须是对象" });
    } else {
      checkBoolean(raw.content, "includeDuration", config.content as unknown as Record<string, unknown>, "content.includeDuration", errors);
      checkBoolean(raw.content, "includeToolFailureNames", config.content as unknown as Record<string, unknown>, "content.includeToolFailureNames", errors);
      checkBoolean(raw.content, "includePromptExcerpt", config.content as unknown as Record<string, unknown>, "content.includePromptExcerpt", errors);
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
// 读盘
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
 * 载入有效配置。
 *
 * 顺序：默认值 → 用户级 → （可选）项目级。
 * 任何一层出现致命错误都会**整份降级**为安全子集（不静默全关），并保留原因。
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

  if (options.projectTrusted && options.cwd) {
    const projectPath = projectConfigPath(options.cwd, options.configDirName);
    const projectRaw = readJsonFile(projectPath);
    if (projectRaw.ok) {
      // §13 第 7 项：项目级不得定义渠道（渠道将来承载 URL/密钥）
      if (isPlainObject(projectRaw.value) && projectRaw.value.providers !== undefined) {
        warnings.push({ path: `${projectPath}: providers`, message: "项目级配置不允许定义渠道，已忽略" });
        delete (projectRaw.value as Record<string, unknown>).providers;
      }
      const merged = mergeConfig(config, projectRaw.value, projectPath);
      errors.push(...merged.errors);
      warnings.push(...merged.warnings);
      config = merged.config;
      sources.push(projectPath);
    } else if (!projectRaw.missing) {
      errors.push({ path: projectPath, message: projectRaw.message });
      sources.push(`${projectPath}（读取失败）`);
    }
  }

  if (errors.length > 0) {
    return { config: degradedConfig(), sources, errors, warnings, degraded: true };
  }
  return { config, sources, errors, warnings, degraded: false };
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
