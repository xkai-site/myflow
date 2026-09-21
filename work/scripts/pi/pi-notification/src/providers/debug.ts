/**
 * S1 的占位渠道：把通知渲染成**一行清洗后的纯文本**写进 logger。
 *
 * 它是「进程内无依赖渠道」这一类的第一个实例，用来把 S1 的判定链路打通并可观测。
 * S3 会新增 `terminal.ts`（OSC 777 / OSC 99 / Windows toast）实现同一个 `Notifier` 接口，
 * 并把默认配置的 provider 从 `debug` 换成 `terminal`；`lifecycle`/`rules`/`service` 不改一行。
 *
 * 刻意不做的事（避免与 S3 重复）：
 *  - 不写 OSC 序列（那需要终端能力探测与平台分支）
 *  - 不自行重试、不自行加超时（由 `service`/`decorators` 负责）
 */

import { sanitize } from "../log.ts";
import type { Logger, Notifier, NotificationRequest } from "../types.ts";

export interface DebugNotifierOptions {
  log: Logger;
  /** 正文最大字符数（来自 config.content.maxMessageChars） */
  maxChars: number;
}

export function createDebugNotifier(id: string, options: DebugNotifierOptions): Notifier {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 300;

  return {
    id,
    type: "debug",

    validate(): string | undefined {
      return undefined;
    },

    async send(req: NotificationRequest, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("投递已取消");
      const title = sanitize(req.title, maxChars).replace(/\n/g, " ");
      const body = sanitize(req.body, maxChars).replace(/\n/g, " ");
      options.log.log(req.level, `[${req.kind}] ${title}${body ? ` — ${body}` : ""}`, {
        kind: req.kind,
        dedupeKey: req.dedupeKey,
      });
    },

    async dispose(): Promise<void> {},
  };
}
