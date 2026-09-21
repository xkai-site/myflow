/**
 * 渠道注册表：Factory Method + Registry（设计 §17.2）。
 *
 * **唯一的分派点**。`service` 只认 `type` 字符串，因此新增渠道的改动是：
 * 「新增 1 个 provider 文件 + 此处 register 1 行 + 配置加 1 条」，
 * `lifecycle.ts` / `rules.ts` / `service.ts` 的 diff 为 0（§17.3 的验收标准）。
 *
 * 未注册 / 工厂抛错 / 校验失败一律降级为 NoopNotifier + 警告，绝不抛异常给调用方。
 */

import type { Logger, Notifier, NotifierFactory, NotifierRegistry } from "../types.ts";
import { createNoopNotifier } from "./noop.ts";

export interface RegistryOptions {
  log: Logger;
}

export function createRegistry({ log }: RegistryOptions): NotifierRegistry {
  const factories = new Map<string, NotifierFactory>();

  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /** 降级为 Noop 时写一条结构化记录：避免"投递 ok"掩盖"其实什么都没发"。 */
  const degrade = (id: string, type: string, reason: string): Notifier => {
    log.record({ event: "channel_degraded", providerId: id, providerType: type, reason });
    return createNoopNotifier(id, type, reason);
  };

  return {
    register(type: string, factory: NotifierFactory): void {
      factories.set(type, factory);
    },

    create(id: string, type: string, rawOptions: unknown): Notifier {
      const factory = factories.get(type);
      if (!factory) {
        log.log("warning", `渠道类型未注册，已降级为 noop: type=${type} id=${id}`);
        return degrade(id, type, `未注册的渠道类型: ${type}`);
      }

      let notifier: Notifier;
      try {
        notifier = factory(id, rawOptions);
      } catch (error) {
        log.log("warning", `渠道工厂抛错，已降级为 noop: type=${type} id=${id}`, {
          error: describe(error),
        });
        return degrade(id, type, `渠道工厂抛错: ${describe(error)}`);
      }

      try {
        const problem = notifier.validate(rawOptions);
        if (problem) {
          log.log("warning", `渠道配置不可用，已降级为 noop: id=${id} 原因=${problem}`);
          return degrade(id, type, problem);
        }
      } catch (error) {
        log.log("warning", `渠道 validate() 抛错，已降级为 noop: id=${id}`, {
          error: describe(error),
        });
        return degrade(id, type, `validate() 抛错: ${describe(error)}`);
      }

      return notifier;
    },
  };
}
