/**
 * 日志 / 清洗 / 脱敏（设计 §13 第 13、16、23 项）。
 *
 * 三件事：
 *  1. `sanitize()` —— 所有对外文案的唯一出口。先剥离转义序列与不可见控制字符，再截断。
 *     官方 `examples/extensions/notify.ts` 直接内插字符串（存在注入面），本插件不复刻该缺陷。
 *  2. `redact()` —— 错误信息脱敏（secret / 家目录路径）。
 *  3. `createLogger()` —— stderr 人类可读日志 + 可选 JSONL 结构化记录。
 *
 * JSONL sink 由 `PI_NOTIFY_LOG_FILE` 打开，仅用于诊断与回归断言；未设置时零开销。
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

import type { Logger, LogLevel } from "./types.ts";

const DEFAULT_MAX_CHARS = 300;

/** 单条日志/记录写入上限，避免 hook 内出现无界的磁盘写入。 */
const SINK_MAX_BYTES = 1024 * 1024;

/**
 * 剥离终端转义序列。
 *
 * 注意语义选择：OSC / CSI / DCS 等序列是**整段删除（含其参数与载荷）**，而不是只删控制字符。
 * 理由是安全第一 —— 若只删 `\x1b`/`\x07` 而保留 `]777;notify;fake`，这些残留文本会变成
 * 我们重新拼装 OSC 时的可见正文，反而制造了伪造通知的素材。
 */
function stripEscapeSequences(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== "\u001b") {
      out += ch;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) break; // 结尾孤立的 ESC：丢弃
    if (next === "[") {
      // CSI: ESC [ params(0x30-0x3f) intermediates(0x20-0x2f) final(0x40-0x7e)
      let j = i + 2;
      while (j < input.length && input[j] >= "\u0030" && input[j] <= "\u003f") j += 1;
      while (j < input.length && input[j] >= "\u0020" && input[j] <= "\u002f") j += 1;
      if (j < input.length && input[j] >= "\u0040" && input[j] <= "\u007e") j += 1;
      i = j - 1;
      continue;
    }
    if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
      // OSC / DCS / SOS / PM / APC：直到 BEL 或 ST(ESC \)
      let j = i + 2;
      while (j < input.length) {
        if (input[j] === "\u0007") {
          j += 1;
          break;
        }
        if (input[j] === "\u001b" && input[j + 1] === "\\") {
          j += 2;
          break;
        }
        j += 1;
      }
      i = j - 1;
      continue;
    }
    // 其余双字符序列（如 ESC ( B、ESC 7）
    i += 1;
  }
  return out;
}

/** 去掉不可见/会造成视觉欺骗的字符，并归一换行。 */
function stripInvisible(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") {
      out += "\n";
      continue;
    }
    if (ch === "\r") continue; // \r\n 已由调用前的归一处理；孤立 \r 丢弃
    if (ch === "\t") {
      out += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue; // C0 + DEL
    if (code >= 0x80 && code <= 0x9f) continue; // C1
    if (code === 0x2028 || code === 0x2029) {
      out += "\n";
      continue;
    }
    if (code >= 0x202a && code <= 0x202e) continue; // bidi 覆盖
    if (code >= 0x2066 && code <= 0x2069) continue; // bidi 隔离
    if (code === 0xfeff) continue; // BOM / 零宽非断行
    out += ch;
  }
  return out;
}

/**
 * 对外文案的唯一清洗入口。
 *
 * - 剥离转义序列与不可见控制字符
 * - `\r\n` / `\r` 归一为 `\n`，压缩连续空白，去掉首尾空白
 * - 按 code point 截断到 `maxChars`（避免切断代理对）
 */
export function sanitize(input: unknown, maxChars: number = DEFAULT_MAX_CHARS): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const normalized = raw.replace(/\r\n?/g, "\n");
  const visible = stripInvisible(stripEscapeSequences(normalized));
  const collapsed = visible
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const points = [...collapsed];
  if (points.length <= limit) return collapsed;
  return `${points.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

const HOME_POSIX = homedir().replace(/\\/g, "/");

/**
 * 脱敏：错误信息里可能带凭据或家目录路径（设计 §2.2 第 4 点）。
 * 只做「去敏」，不改变语义；宁可过度遮蔽，也不外传凭据。
 */
export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : String(input ?? "");
  text = text.replace(/Bearer\s+[^\s,;"']+/gi, "Bearer ***");
  text = text.replace(
    /((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization|auth)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1***",
  );
  text = text.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-***");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_***");
  text = text.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "***jwt***");
  text = text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "***");
  // 家目录 / 用户目录
  if (HOME_POSIX.length > 3) {
    text = text.split(HOME_POSIX).join("~");
    text = text.split(homedir()).join("~");
  }
  text = text.replace(/(?:\/home|\/Users|[A-Za-z]:[\\/]Users)[\\/][^\\/\s"']+/g, "~");
  return text;
}

/** 清洗 + 脱敏的组合，供错误信息使用。 */
export function sanitizeError(input: unknown, maxChars: number = DEFAULT_MAX_CHARS): string {
  return sanitize(redact(input), maxChars);
}

function sinkPath(): string | undefined {
  const value = process.env.PI_NOTIFY_LOG_FILE;
  return value && value.trim() !== "" ? value : undefined;
}

function stderrEnabled(): boolean {
  const value = process.env.PI_NOTIFY_DEBUG;
  return value === "1" || value === "true";
}

/**
 * 创建 logger。
 *
 * 写入策略：JSONL sink 用同步 append —— 它只在 `PI_NOTIFY_LOG_FILE` 存在时开启（诊断/测试），
 * 单条受限于 1 MiB 总量，且能保证记录顺序与事件顺序一致（否则回归脚本无法稳定断言）。
 */
export function createLogger(): Logger {
  let sunkBytes = 0;
  let sinkDisabled = false;

  const writeSink = (entry: Record<string, unknown>): void => {
    if (sinkDisabled || sunkBytes >= SINK_MAX_BYTES) return;
    const file = sinkPath();
    if (!file) return;
    try {
      const line = `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`;
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      sunkBytes += Buffer.byteLength(line);
    } catch {
      // 诊断 sink 失败绝不冒泡到 hook：宁可不记日志，也不阻断 Pi。
      sinkDisabled = true;
    }
  };

  return {
    log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
      const text = sanitize(message, 2000);
      if (stderrEnabled()) {
        try {
          process.stderr.write(`[pi-notify] ${level} ${text}\n`);
        } catch {
          // 忽略：stdout/stderr 可能已关闭
        }
      }
      writeSink({ event: "log", level, message: text, ...(meta ?? {}) });
    },
    record(entry: Record<string, unknown>): void {
      writeSink(entry);
    },
  };
}

/** 测试/调试用的空 logger。 */
export function createSilentLogger(): Logger {
  return {
    log(): void {},
    record(): void {},
  };
}
