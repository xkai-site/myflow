/**
 * Null Object channel.
 *
 * Covers disabled providers, unregistered types and channels that fail their own
 * validation, so call sites never need an `if (notifier)` guard. `send()` always
 * succeeds and has no side effects, so it can never be mistaken for a delivery
 * failure.
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
