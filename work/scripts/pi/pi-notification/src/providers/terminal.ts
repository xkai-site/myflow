/**
 * Desktop notification channel: no credentials, no network, no third-party dependencies.
 *
 * Three mechanisms:
 *  - OSC 99: the Kitty protocol (`KITTY_WINDOW_ID` or `TERM_PROGRAM=kitty`);
 *  - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode and other terminals with a TTY;
 *  - Windows toast: Windows terminals, because Windows Terminal does not render OSC 777.
 *
 * Three hardening decisions:
 *  1. The toast payload travels as base64 environment variables into a script that is a static
 *     constant with no interpolation, and the text is written with DOM `CreateTextNode`
 *     instead of string concatenation; interpolating a title into the script would be a
 *     command-injection surface.
 *  2. All payloads are flattened and stripped of terminal controls before rendering.
 *  3. Writing to stdout requires `stdout.isTTY`: under `-p` or `--mode json` that stream is the
 *     caller's data, and an escape sequence written into it corrupts the output.
 *
 * Whether a notification is actually displayed depends on the terminal emulator, which this
 * plugin cannot observe; the mechanisms have not been confirmed by eye on a real terminal.
 */

import { execFile } from "node:child_process";

import { singleLine } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export type TerminalChannel = "osc99" | "osc777" | "toast" | "none";

export interface TerminalEnvironment {
  platform: string;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
}

export interface TerminalSelection {
  channel: TerminalChannel;
  /** Reason when `channel === "none"`, recorded for diagnosis. */
  reason?: string;
}

export interface ToastInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface TerminalIo {
  environment(): TerminalEnvironment;
  write(text: string): void;
  runToast(invocation: ToastInvocation): Promise<void>;
}

/**
 * Selects the delivery mechanism.
 *
 * Rules and their reasons:
 *  1. `PI_NOTIFY_CHANNEL` may force a mechanism (`auto`|`osc777`|`osc99`|`toast`|`off`); `off` is
 *     the global silence switch for local notifications.
 *  2. Mechanisms that write to stdout require a TTY first: under `pi -p`, `--mode json` or a
 *     redirected stream, stdout belongs to the caller and must stay clean.
 *  3. `toast` talks to the OS and never touches stdout, so an explicit request is not gated on
 *     a TTY; that makes it usable as the manual switch for `pi -p` runs.
 *  4. `auto` stays silent without a TTY, so scripted runs never raise a system notification by
 *     accident.
 */
export function selectTerminalChannel(environment: TerminalEnvironment): TerminalSelection {
  const { platform, env, stdoutIsTTY } = environment;
  const override = (env.PI_NOTIFY_CHANNEL ?? "auto").trim().toLowerCase();
  if (override === "off" || override === "none") {
    return { channel: "none", reason: "PI_NOTIFY_CHANNEL=off" };
  }
  if (override === "toast") {
    return { channel: "toast" };
  }
  if (!stdoutIsTTY) {
    return { channel: "none", reason: "stdout 不是 TTY（非终端模式或输出被重定向）" };
  }
  if (override === "osc777" || override === "osc99") {
    return { channel: override };
  }
  if (env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "kitty") {
    return { channel: "osc99" };
  }
  if (platform === "win32") {
    // Windows Terminal does not render OSC 777, so Windows always goes through the OS toast.
    return { channel: "toast" };
  }
  return { channel: "osc777" };
}

export function renderOsc777(title: string, body: string): string {
  // The title and body are delimited by a literal semicolon in OSC 777.
  const t = singleLine(title).replace(/;/g, "；");
  const b = singleLine(body);
  return `\u001b]777;notify;${t}${b ? `;${b}` : ""}\u0007`;
}

/**
 * OSC 99 (Kitty protocol): two parts where `d=1` marks the last one. `id` links both parts
 * into a single notification.
 */
export function renderOsc99(id: string, title: string, body: string): string {
  const t = singleLine(title);
  const b = singleLine(body);
  return [
    `\u001b]99;i=${id}:d=0:p=title;${t}\u001b\\`,
    `\u001b]99;i=${id}:d=1:p=body;${b}\u001b\\`,
  ].join("");
}

/** Static script: it contains no user data, so there is no interpolation surface. */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Type literals must be written out; they cannot be built from variables.
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:PI_NOTIFY_TOAST_TITLE))",
  "$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:PI_NOTIFY_TOAST_BODY))",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$nodes = $template.GetElementsByTagName('text')",
  "$nodes.Item(0).AppendChild($template.CreateTextNode($title)) > $null",
  "$nodes.Item(1).AppendChild($template.CreateTextNode($body)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)",
].join("; ");

/** Payload is passed only through base64 environment variables, so the script never holds user data. */
export function buildToastInvocation(title: string, body: string): ToastInvocation {
  const encodedBody = Buffer.from(singleLine(body), "utf8").toString("base64");
  // Windows environment values are limited to 32,767 characters. Keep the title
  // when an exceptional diagnostic or prompt cannot travel in the body variable.
  const toastBody = encodedBody.length < 32767 ? encodedBody : Buffer.from("详细信息请在 Pi 中查看", "utf8").toString("base64");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT],
    env: {
      PI_NOTIFY_TOAST_TITLE: Buffer.from(singleLine(title), "utf8").toString("base64"),
      PI_NOTIFY_TOAST_BODY: toastBody,
    },
  };
}

export function createDefaultTerminalIo(): TerminalIo {
  return {
    environment(): TerminalEnvironment {
      return {
        platform: process.platform,
        env: process.env,
        stdoutIsTTY: process.stdout?.isTTY === true,
      };
    },
    write(text: string): void {
      process.stdout.write(text);
    },
    runToast(invocation: ToastInvocation): Promise<void> {
      return new Promise((resolve, reject) => {
        execFile(
          invocation.command,
          invocation.args,
          {
            env: { ...process.env, ...invocation.env },
            timeout: 8000,
            windowsHide: true,
          },
          (error) => {
            if (error) reject(new Error(`Windows toast 失败: ${error.message}`));
            else resolve();
          },
        );
      });
    },
  };
}

export interface TerminalNotifierOptions {
  log: Logger;
  io?: TerminalIo;
}

let oscCounter = 0;

export function createTerminalNotifier(id: string, options: TerminalNotifierOptions): Notifier {
  const io = options.io ?? createDefaultTerminalIo();

  return {
    id,
    type: "terminal",

    /** Probes terminal capabilities; a returned reason makes the registry degrade this to Noop. */
    validate(): string | undefined {
      const selection = selectTerminalChannel(io.environment());
      return selection.channel === "none" ? selection.reason : undefined;
    },

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      const selection = selectTerminalChannel(io.environment());
      if (selection.channel === "none") {
        // Skipping local notifications outside a TTY is expected, not a failure.
        options.log.record({
          event: "channel_skipped",
          providerId: id,
          kind: req.kind,
          dedupeKey: req.dedupeKey,
          reason: selection.reason ?? "unavailable",
        });
        return;
      }
      if (signal.aborted) throw new Error("投递已取消");

      const { title, body } = req;
      if (selection.channel === "toast") {
        await io.runToast(buildToastInvocation(title, body));
        return;
      }
      oscCounter = (oscCounter + 1) % 100000;
      const text = selection.channel === "osc99"
        ? renderOsc99(String(oscCounter), title, body)
        : renderOsc777(title, body);
      io.write(text);
    },

    async dispose(): Promise<void> {},
  };
}
