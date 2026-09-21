/**
 * Logging, sanitizing and redaction.
 *
 *  - `sanitize()` is the single exit for text leaving this plugin: escape sequences
 *    and invisible control characters are stripped before truncation.
 *  - `redact()` masks secrets and home-directory paths in error text.
 *  - `createLogger()` writes human-readable lines to stderr plus optional JSONL
 *    records; the JSONL sink only opens when `PI_NOTIFY_LOG_FILE` is set.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

import type { Logger, LogLevel } from "./types.ts";

const DEFAULT_MAX_CHARS = 300;

/** Total JSONL sink budget, so a hook can never write unbounded data. */
const SINK_MAX_BYTES = 1024 * 1024;

/**
 * Removes terminal escape sequences.
 *
 * Whole sequences (parameters and payload included) are deleted rather than just
 * their control bytes: keeping `]777;notify;fake` would leave exactly the text
 * needed to forge a notification once we emit our own OSC sequence.
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
    if (next === undefined) break; // Trailing lone ESC: drop it.
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
      // OSC / DCS / SOS / PM / APC: consume until BEL or ST (ESC backslash)
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
    // Other two-character sequences (for example ESC ( B, ESC 7).
    i += 1;
  }
  return out;
}

/** Drops invisible or visually deceptive characters and normalises newlines. */
function stripInvisible(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") {
      out += "\n";
      continue;
    }
    if (ch === "\r") continue; // \r\n was normalised by the caller; a lone \r is dropped
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
    if (code >= 0x202a && code <= 0x202e) continue; // bidi overrides
    if (code >= 0x2066 && code <= 0x2069) continue; // bidi isolates
    if (code === 0xfeff) continue; // BOM / zero-width no-break space
    out += ch;
  }
  return out;
}

/**
 * The single sanitizing entry point for text leaving this plugin.
 * Normalises CRLF, collapses whitespace, then truncates by code point so
 * surrogate pairs are never split.
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
 * Masks credentials and home-directory paths that may appear in error text.
 * Over-redacting is accepted; leaking a credential is not.
 */
export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : String(input ?? "");
  text = text.replace(/Bearer\s+[^\s,;"']+/gi, "Bearer ***");
  // Cookie headers carry session credentials and are line-scoped, so the whole value goes.
  text = text.replace(/(\b(?:set-)?cookie\s*[:=]\s*)[^\n]*/gi, "$1***");
  // `Authorization: <scheme> <credential>`: the generic key/value rule below would mask only the
  // scheme word and leave the credential in clear text.
  text = text.replace(
    /((?:proxy-)?authorization\s*[:=]\s*)(?:(?:basic|bearer|digest|negotiate|hoba|mutual|aws4-hmac-sha256|apikey|api-key|token)\s+)?("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1***",
  );
  text = text.replace(
    /((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization|auth)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1***",
  );
  text = text.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-***");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_***");
  text = text.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "***jwt***");
  // A key without a separator ("token <secret>") still carries a credential in practice. Only long
  // high-entropy values are masked, so ordinary prose such as "token expired" stays readable; the
  // 16-character floor matches the shortest real API keys. This runs after the family rules above so
  // they keep their more informative form, for example "token gh*_***".
  text = text.replace(
    /((?:api[\s_-]?key|access[\s_-]?key|token|secret|password|passwd)\s+)(?=[A-Za-z0-9_-]{16,})([^\s,;"']+)/gi,
    "$1***",
  );
  text = text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "***");
  // Home directory and user directory, in either separator style.
  if (HOME_POSIX.length > 3) {
    text = text.split(HOME_POSIX).join("~");
    text = text.split(homedir()).join("~");
  }
  text = text.replace(/(?:\/home|\/Users|[A-Za-z]:[\\/]Users)[\\/][^\\/\s"']+/g, "~");
  return text;
}

/** Redacts first and then sanitizes; used for every error message shown to users. */
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
 * Creates the logger.
 *
 * The JSONL sink appends synchronously so record order matches event order,
 * which is what lets the regression scripts assert on it.
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
      // A failing sink must never bubble into a hook: losing logs beats blocking Pi.
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
          // Ignore: stdout/stderr may already be closed.
        }
      }
      writeSink({ event: "log", level, message: text, ...(meta ?? {}) });
    },
    record(entry: Record<string, unknown>): void {
      writeSink(entry);
    },
  };
}

/** No-op logger for tests and for code paths that must stay silent. */
export function createSilentLogger(): Logger {
  return {
    log(): void {},
    record(): void {},
  };
}
