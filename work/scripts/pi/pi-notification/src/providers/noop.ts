/**
 * Null Object 渠道（设计 §17.2）。
 *
 * 用于「渠道被禁用 / 类型未注册 / 自身校验失败」三种情况，使调用点无需 `if (notifier)`。
 * `send()` 永远成功（无副作用），因此不会被误判为投递失败。
 */

import type { Notifier } from "../types.ts";

export function createNoopNotifier(id: string, type: string, reason?: string): Notifier {
  return {
    id,
    type,
    validate: () => reason,
    async send(): Promise<void> {},
    async dispose(): Promise<void> {},
  };
}
