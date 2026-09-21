/**
 * Channel registry (factory + registry).
 *
 * This is the only dispatch point: `service` only knows the `type` string, so
 * adding a channel means one new provider file, one `register` call here and one
 * config entry, with no change to lifecycle, rules or service.
 *
 * An unregistered type, a throwing factory or a failing validation always degrades
 * to a NoopNotifier with a warning; it never throws at the caller.
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

  /** Structured record on degradation, so "delivery ok" cannot hide "nothing was sent". */
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
