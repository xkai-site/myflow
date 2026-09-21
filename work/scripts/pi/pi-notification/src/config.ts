/**
 * Configuration.
 *
 * Three layers: factory defaults, sparse user defaults on disk, and per-conversation
 * choices (an overlay owned by `settings.ts`). This module owns the first two plus the
 * degradation rules; there is no project-level layer.
 *
 * Writes validate first, then write a same-directory temporary file (0o600) and rename
 * it into place; a failed write never overwrites the previous file.
 *
 * Two robustness rules that shape the code below:
 *  1. A broken config must never silently disable all notifications. Parse or validation
 *     failures degrade to "failed runs only, error level, default channel" and keep the
 *     reason visible, because losing failure notifications over a stray comma is the
 *     worst possible failure mode for this plugin.
 *  2. Writes are sparse: Ctrl+S persists only the saved setting and never freezes the
 *     remaining fields at today's defaults.
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

/** Rule name to config key, using camelCase keys in the file. */
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
 * `ui_prompt_*` kinds that may appear in the config allow-list.
 * `custom` is excluded permanently: the loader and progress UI emit it too, so it says
 * nothing about user input.
 */
export const ALLOWED_PROMPT_KINDS: UIPromptKind[] = ["select", "confirm", "input", "editor"];

const ALL_PROMPT_KINDS: UIPromptKind[] = [...ALLOWED_PROMPT_KINDS, "custom"];

export interface ConfigProblem {
  /** Field path that failed, for example `delivery.timeoutMs`. */
  path: string;
  message: string;
}

export interface ConfigLoadResult {
  config: NotificationConfig;
  /** Sources actually in effect, shown by the status view for diagnosis. */
  sources: string[];
  /** Fatal parse or validation problems that trigger degradation. */
  errors: ConfigProblem[];
  /** Non-fatal problems, such as unknown fields. */
  warnings: ConfigProblem[];
  /** True when the safe subset is in effect. */
  degraded: boolean;
}

export interface ReadConfigOptions {
  /** User-level directory, from `getAgentDir()`. */
  agentDir: string;
}

/** Path of the user config file. It stores sparse user defaults, not a full snapshot. */
export function userConfigPath(agentDir: string): string {
  return path.join(agentDir, "pi-notification", "config.json");
}

/**
 * Factory defaults.
 *
 * The default channel is the terminal one: no credentials, no network, no dependencies.
 * The debug channel stays registered so it can be selected in the file when diagnosing.
 */
export function defaultConfig(): NotificationConfig {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    minLevel: "info",
    rules: {
      runCompleted: { enabled: true, level: "info", channels: ["terminal"] },
      runFailed: { enabled: true, level: "error", channels: ["terminal"] },
      // Pressing Esc means the user is sitting at the machine, so this stays silent by default.
      runAborted: { enabled: false, level: "info", channels: ["terminal"] },
      // Tool failures are aggregated into one message and skipped when the run already
      // produced a result notification.
      toolFailed: { enabled: true, level: "warning", channels: ["terminal"], mode: "aggregate", threshold: 1 },
      compactFailed: { enabled: true, level: "error", channels: ["terminal"] },
      // Overlaps heavily with run_completed, so it is off by default. `custom` can never be white-listed.
      waitingForUser: { enabled: false, level: "info", channels: ["terminal"], kinds: [...ALLOWED_PROMPT_KINDS] },
    },
    coalesce: {
      // One notification per logical run (sessionId + runId): several events must not flood the user.
      windowMs: 1500,
      toolFailureWindowMs: 10000,
      // Minimum interval between two notifications of the same kind.
      cooldownMs: 3000,
    },
    quietHours: { enabled: false, start: "23:00", end: "08:00", exceptLevels: ["error"] },
    content: {
      includeDuration: true,
      includeToolFailureNames: true,
      // Leading identity label: session name when available, else the project directory name.
      includeSessionLabel: true,
      // Assistant replies are not forwarded by default: they can carry file content or secrets.
      includeAssistantExcerpt: false,
      includeCost: true,
      maxMessageChars: 300,
    },
    delivery: {
      timeoutMs: 8000,
      // Retry and circuit breaking are applied by the reliability decorators.
      maxRetries: 1,
      concurrency: 1,
      queueLimit: 50,
      circuitBreakerFailures: 3,
    },
    providers: [{ id: "terminal", type: "terminal", enabled: true, options: {} }],
    // Maximum wait allowed inside `session_shutdown`: the exit path must stay short.
    shutdownFlushMs: 200,
  };
}

/**
 * Safe fallback config: failed-run notification only, error level, default channel.
 * It is used when the config is broken so the plugin keeps working and the status view
 * can still show what went wrong.
 *
 * Only `run_failed` stays on, because "a typo silences failure notifications" is the worst
 * outcome; every other rule is switched off to avoid producing noise from a bad file.
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
// Validation: strict per-field checks
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
      // Forward compatibility: a rule name from a newer version is ignored with a warning.
      warnings.push({ path: fieldPath, message: "未知规则名，已忽略（可能是更新版本写入的）" });
      continue;
    }
    if (!isPlainObject(ruleRaw)) {
      errors.push({ path: fieldPath, message: "必须是对象" });
      continue;
    }
    // Inherit from **base**, not from the factory defaults: when a single setting is saved or
    // the three layers are merged, the siblings of that rule must survive untouched.
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
          // `custom` is excluded permanently: writing it into the file has no effect.
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
    // A non-boolean `enabled` (for example the string "false") used to be coerced to true, which
    // silently turned a channel on; it must degrade loudly like every other boolean in this file.
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      errors.push({ path: `${fieldPath}.enabled`, message: `必须是布尔值，实际是 ${JSON.stringify(item.enabled)}` });
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
 * Overlays the user-supplied partial config onto `base`. Illegal fields are collected in
 * `errors`; the caller decides whether that means degradation.
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
      // 0 is a valid value and switches that filter off; tests and users who want one
      // notification per run rely on it.
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
// Reading: factory defaults, then sparse user defaults
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
 * Loads the effective config: built-in defaults, then the sparse user file.
 *
 * A fatal problem in either layer degrades the whole config to the safe subset instead of
 * switching notifications off, and keeps the reason for the status view. The
 * per-conversation overlay is applied later by `settings.ts`.
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
 * Reads the raw user file without merging defaults. This is what sparse writes and the
 * "has this setting ever been saved?" check rely on.
 * Missing file means `raw: undefined`; a corrupt file or a non-object root means `ok: false`
 * and the caller must refuse to overwrite it.
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
 * Merges one patch into the user file and writes it atomically (Ctrl+S).
 *
 * Unlike `writeUserConfig` this writes sparse user defaults: existing fields plus this one
 * patch, without snapshotting the remaining fields at today's defaults, so settings the
 * user never touched keep following the factory defaults. A corrupt file is never
 * overwritten, because that would freeze the degraded result into the user defaults.
 */
export function writeUserDefault(agentDir: string, patch: ConfigPatch): ConfigWriteResult {
  const file = userConfigPath(agentDir);
  const current = readUserConfigRaw(agentDir);
  if (!current.ok) return { ok: false, problems: current.problems };
  const sparse = mergePatch(current.raw ?? {}, patch);
  // Validate with the same strict rules before writing: a single setting still goes through
  // the full field validation, so an illegal value is always refused.
  const merged = mergeConfig(defaultConfig(), sparse, file);
  if (merged.errors.length > 0) return { ok: false, problems: merged.errors };
  const written = atomicWriteConfig(agentDir, `${JSON.stringify(sparse, null, 2)}\n`);
  if (!written.ok) return written;
  return { ok: true, config: merged.config, problems: [], warnings: merged.warnings };
}

/**
 * Writes a full user-level snapshot; used by tests and migrations. The caller may only
 * update its in-memory state after this succeeds. New code should prefer `writeUserDefault`.
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
 * Atomic write: a same-directory temporary file created exclusively (`wx`, 0o600), closed,
 * then renamed. The destination is never deleted first, so a failure keeps the old file and
 * only the temporary file created by this call is cleaned up.
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
    temporary = candidate; // Only ever clean up the file this call created.
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

/** Session-level silence switch, driven by an environment variable. */
export function isDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_NOTIFY_DISABLE === "1" || env.PI_NOTIFY_DISABLE === "true";
}

/** Short description shown by `/notify status`. */
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
