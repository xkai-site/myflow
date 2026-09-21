/**
 * 阶段 1 渠道：系统桌面通知（设计 §17.1 P1 / §17.4 / §13 第 13、14 项）。
 *
 * 零凭据、零网络、零第三方依赖。三种机制：
 *   - OSC 99  : Kitty 协议（`KITTY_WINDOW_ID` / `TERM_PROGRAM=kitty`）
 *   - OSC 777 : Ghostty / iTerm2 / WezTerm / rxvt-unicode，以及其它有 TTY 的兜底
 *   - Windows toast : Windows Terminal 及其它 Windows 终端（WT 不渲染 OSC 777）
 *
 * 与官方 `examples/extensions/notify.ts` 的三处关键差异（都是刻意为之）：
 *  1. 官方把 title/body **直接插值进 PowerShell 脚本字符串**，把 title 当 AUMID 用 ——
 *     存在命令注入面（§13 第 14 项）。本实现把载荷用 **base64 放进环境变量**，
 *     脚本本身是**静态常量、零插值**；toast 文本用 DOM `CreateTextNode` 写入，不用拼 XML。
 *  2. 官方对 OSC 直接内插未清洗的字符串（注入面，§13 第 13 项）。本实现所有载荷先经
 *     `sanitize()`（剥离 ESC/BEL/C0），再在渲染时把换行归一为空格。
 *  3. 官方**无条件**写 stdout。本实现要求 `stdout` 是 TTY 才投递：否则 `-p`/`--mode json`
 *     被重定向的 stdout 会被塞进转义序列，直接破坏调用方拿到的输出。
 *
 * 关于"能不能看见"：终端是否真的渲染 OSC 通知由终端模拟器决定，Pi 与本插件都无法保证。
 * 本环境无 TTY，三种机制均未在真实终端上逐项肉眼确认（与设计 §18.6 的同类未测项一致）。
 */

import { execFile } from "node:child_process";

import { sanitize } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export type TerminalChannel = "osc99" | "osc777" | "toast" | "none";

export interface TerminalEnvironment {
  platform: string;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
}

export interface TerminalSelection {
  channel: TerminalChannel;
  /** channel === "none" 时的原因（用于诊断记录） */
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

// ---------------------------------------------------------------------------
// 纯函数：选择 / 渲染（可单测，无副作用）
// ---------------------------------------------------------------------------

/**
 * 选择投递机制。
 *
 * 规则与理由：
 *  1. `PI_NOTIFY_CHANNEL` 可显式指定机制（`auto`|`osc777`|`osc99`|`toast`|`off`）；
 *     `off` 是本地通知的全局静默开关（§10.3 的调试覆盖）。
 *  2. **写 stdout 的机制（OSC）必须先确认 stdout 是 TTY**。`pi -p`、`--mode json`、
 *     被重定向的输出都是管道，stdout 是调用方读走的数据，塞进去就污染了。
 *  3. `toast` 写的是操作系统通知、**不碰 stdout**，所以显式指定时不受 TTY 限制
 *     （这是 `pi -p` 场景手动静默/开启通知的开关，也便于人工验证）。
 *  4. `auto` 在非 TTY 下一律不发：避免脚本化运行意外弹系统通知。
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
    // Windows Terminal 不渲染 OSC 777，统一走系统 toast。
    return { channel: "toast" };
  }
  return { channel: "osc777" };
}

/**
 * OSC 载荷硬化。
 * 先 `sanitize()`，再额外确保不含能提前终止序列或夹带新序列的字节。
 * 这里的 300 只是**防御性兜底**；实际长度由调用方的 `maxChars` 决定（send() 已先截断）。
 */
function payload(text: string): string {
  const cleaned = sanitize(text, 300);
  const hardened = cleaned.replace(/[\u0000-\u001f\u007f\u001b\u009b]/g, " ").replace(/\s+/g, " ").trim();
  return hardened.replace(/\n/g, " ");
}

export function renderOsc777(title: string, body: string): string {
  const t = payload(title);
  const b = payload(body);
  return `\u001b]777;notify;${t}${b ? `;${b}` : ""}\u0007`;
}

/**
 * OSC 99（Kitty 协议）：分两段发送，`d=1` 表示最后一段。
 * `id` 用于把两段关联成同一条通知。
 */
export function renderOsc99(id: string, title: string, body: string): string {
  const t = payload(title);
  const b = payload(body);
  return [
    `\u001b]99;i=${id}:d=0:p=title;${t}\u001b\\`,
    `\u001b]99;i=${id}:d=1:p=body;${b}\u001b\\`,
  ].join("");
}

/** 静态脚本：**不含任何用户数据**，因此不存在插值注入面。 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // 类型字面量必须写实际类型名，不能用变量拼出来。
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

/** 载荷只经环境变量传入（base64），脚本永远不含用户数据。 */
export function buildToastInvocation(title: string, body: string): ToastInvocation {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT],
    env: {
      PI_NOTIFY_TOAST_TITLE: Buffer.from(payload(title), "utf8").toString("base64"),
      PI_NOTIFY_TOAST_BODY: Buffer.from(payload(body), "utf8").toString("base64"),
    },
  };
}

// ---------------------------------------------------------------------------
// 真实 IO
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export interface TerminalNotifierOptions {
  log: Logger;
  maxChars: number;
  io?: TerminalIo;
}

let oscCounter = 0;

export function createTerminalNotifier(id: string, options: TerminalNotifierOptions): Notifier {
  const io = options.io ?? createDefaultTerminalIo();

  return {
    id,
    type: "terminal",

    /** 探测终端能力（§17.4）。不可用返回原因字符串，由 registry 降级为 Noop。 */
    validate(): string | undefined {
      const selection = selectTerminalChannel(io.environment());
      return selection.channel === "none" ? selection.reason : undefined;
    },

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      const selection = selectTerminalChannel(io.environment());
      if (selection.channel === "none") {
        // 非终端模式跳过本地通知是预期行为（§13 第 12 项），不是失败。
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

      const title = sanitize(req.title, options.maxChars);
      const body = sanitize(req.body, options.maxChars);

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
