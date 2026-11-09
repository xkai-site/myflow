/** UI test-notification lifecycle. No terminal, configuration writes or delivery implementation. */
import { channelLabel } from "./settings.ts";
import { sanitizeError } from "./log.ts";
import { testBlockMessage, type ActionResult, type SettingsTestResult } from "./settings-actions.ts";
import type { DeliveryResult, NotificationConfig, TestProgress } from "./types.ts";

/** Only non-secret fields used by the built-in sender; never serialize arbitrary provider options. */
export function emailTestKey(config: NotificationConfig, credentialStatus: string, revision: number): string {
  const provider = config.providers.find((entry) => entry.id === "email");
  const transport = provider?.options.transport as { type?: string; profile?: string } | undefined;
  return JSON.stringify([provider?.type, provider?.enabled, provider?.options.from, provider?.options.to,
    provider?.options.subjectPrefix, transport?.type, transport?.profile, credentialStatus, revision]);
}

interface TestUpdate { result: ActionResult; emailLabel?: string }
const resultLabel = (result: DeliveryResult): string => result.skipped ? "未发送" : result.ok ? "服务已接受" : "发送失败";

/** One active subscription. Replacement/teardown and terminal events invalidate late callbacks.
 * valid() additionally rejects email results after address/credential changes. Unsubscribe only
 * detaches this UI observer; it does not claim to cancel a delivery already in flight.
 */
export class SettingsTestRun {
  private generation = 0;
  private unsubscribe?: () => void;

  stop(): void {
    this.generation++;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }

  start(submit: (progress: (event: TestProgress) => void) => SettingsTestResult,
    options: { emailOnly: boolean; valid(): boolean; update(value: TestUpdate): void }): void {
    this.stop();
    const generation = this.generation;
    const results = new Map<string, DeliveryResult>();
    let latest: TestUpdate | undefined;
    let finished = false, sending = false;
    const delivery = (): ActionResult => {
      const values = [...results.values()];
      const labels = values.map((result) => `${channelLabel(result.providerId)}：${resultLabel(result)}`);
      const details = values.flatMap((result, index) => [labels[index],
        ...(result.error ? [`诊断：${sanitizeError(result.error, Math.max(1, result.error.length))}`] : [])]);
      details.push("服务接受不代表实际送达，请检查接收端。");
      return { ok: values.length > 0 && values.every((result) => result.ok && !result.skipped),
        message: labels.join("；") || "测试已结束，未取得发送结果。", feedback: { kind: "delivery", details } };
    };
    const onProgress = (event: TestProgress): void => {
      if (generation !== this.generation || finished || !options.valid()) return;
      let emailLabel: string | undefined;
      if (event.result) {
        results.set(event.result.providerId, event.result);
        if (event.result.providerId === "email") emailLabel = event.result.ok && !event.result.skipped ? "服务已接受，尚未确认收件" : resultLabel(event.result);
      }
      let result: ActionResult;
      if (event.stage === "queued" || event.stage === "sending") {
        sending ||= event.stage === "sending";
        const label = event.stage === "queued" ? "等待发送" : "发送中";
        result = { ok: true, message: `测试：${label}`, feedback: { kind: "progress" } };
        if (options.emailOnly) emailLabel = label;
      } else if (event.stage === "cancelled") {
        result = results.size ? { ...delivery(), ok: false, message: "测试已停止，已取得的发送结果保留在详情中。" }
          : { ok: false, message: sending ? "测试已停止，无法确认发送结果。" : testBlockMessage(event.reason ?? "unknown"),
            feedback: { kind: event.reason === "internal_error" || !event.reason ? "unknown" : "recoverable", next: "diagnostics" } };
        if (options.emailOnly && !results.has("email")) emailLabel = sending ? "结果未知" : "未发送";
      } else {
        result = delivery();
        if (event.stage === "finished" && options.emailOnly && !results.has("email")) emailLabel = "结果未知";
      }
      if (event.stage === "finished" || event.stage === "cancelled") { finished = true; this.unsubscribe = undefined; }
      latest = { result, emailLabel };
      options.update(latest);
    };
    const result = submit(onProgress);
    if (!finished) this.unsubscribe = result.unsubscribe;
    // Some hosts deliver progress synchronously during submission. Do not overwrite that result.
    if (!latest || !result.ok) options.update({ result: { ...result,
      feedback: result.feedback ?? { kind: result.ok ? "progress" : "blocked", next: result.ok ? undefined : "diagnostics" } } });
  }
}
