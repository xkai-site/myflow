/** Session snapshots and sparse default transactions. No presentation, IO or host context. */
import { defaultConfig, mergeConfig, type ConfigProblem } from "./config.ts";
import {
  getPathValue,
  hasPath,
  isPlainObject,
  mergePatch,
  removePath,
  setPatchPath,
  type ConfigPatch,
} from "./patch.ts";
import type { NotificationConfig } from "./types.ts";
import type { SettingItem, SettingPatch, SettingValue, SimpleSettingPatch } from "./settings.ts";

export interface SessionOverlay {
  patch: ConfigPatch;
  providers: Record<string, boolean>;
  providerOptions: Record<string, Record<string, unknown>>;
  /** Switches last changed by unified destinations, not independently edited channel gates. */
  channelOwners?: string[];
}
export const SESSION_OVERLAY_ENTRY = "notify-session-overlay";
export function emptyOverlay(): SessionOverlay {
  return { patch: {}, providers: {}, providerOptions: {} };
}
export function isEmptyOverlay(overlay: SessionOverlay): boolean {
  return (
    !Object.keys(overlay.patch).length &&
    !Object.keys(overlay.providers).length &&
    !Object.keys(overlay.providerOptions).length
  );
}
function notificationPatch(patch: ConfigPatch): ConfigPatch {
  const { api: _api, ...allowed } = structuredClone(patch);
  return allowed;
}

/** Session files are an external boundary. Empty snapshots must survive reload; API stays file-only. */
export function overlayFromEntry(value: unknown): SessionOverlay | undefined {
  if (!isPlainObject(value)) return undefined;
  const patch = isPlainObject(value.patch) ? notificationPatch(value.patch) : {};
  const providers: Record<string, boolean> = {};
  if (isPlainObject(value.providers)) {
    for (const [id, enabled] of Object.entries(value.providers))
      if (typeof enabled === "boolean") providers[id] = enabled;
  }
  const providerOptions: SessionOverlay["providerOptions"] = {};
  if (isPlainObject(value.providerOptions)) {
    for (const [id, options] of Object.entries(value.providerOptions))
      if (isPlainObject(options)) providerOptions[id] = options;
  }
  const channelOwners = Array.isArray(value.channelOwners)
    ? [
        ...new Set(
          value.channelOwners.filter((id): id is string => typeof id === "string" && Object.hasOwn(providers, id))
        ),
      ]
    : [];
  return { patch, providers, providerOptions, ...(channelOwners.length ? { channelOwners } : {}) };
}
export function overlayEntryData(sessionId: string | undefined, overlay: SessionOverlay, at: number) {
  return {
    sessionId,
    patch: notificationPatch(overlay.patch),
    providers: overlay.providers,
    providerOptions: overlay.providerOptions,
    ...(overlay.channelOwners?.length ? { channelOwners: [...overlay.channelOwners] } : {}),
    at,
  };
}
/** Fork/clone entries belong to the old session. Each matching entry is a complete snapshot. */
export function restoreOverlayFromEntries(entries: readonly unknown[], sessionId: string | undefined): SessionOverlay {
  let overlay = emptyOverlay();
  if (sessionId === undefined) return overlay;
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.type !== "custom" || entry.customType !== SESSION_OVERLAY_ENTRY) continue;
    if (!isPlainObject(entry.data) || entry.data.sessionId !== sessionId) continue;
    const restored = overlayFromEntry(entry.data);
    if (restored) overlay = restored;
  }
  return overlay;
}
export function applyOverlay(
  base: NotificationConfig,
  overlay: SessionOverlay
): { config: NotificationConfig; problems: ConfigProblem[] } {
  if (isEmptyOverlay(overlay)) return { config: base, problems: [] };
  const raw = notificationPatch(overlay.patch);
  if (Object.keys(overlay.providerOptions).length || Object.keys(overlay.providers).length) {
    raw.providers = base.providers.map((provider) => ({
      ...provider,
      ...(overlay.providerOptions[provider.id]
        ? { options: mergePatch(provider.options, overlay.providerOptions[provider.id]) }
        : {}),
      ...(Object.hasOwn(overlay.providers, provider.id) ? { enabled: overlay.providers[provider.id] } : {}),
    }));
  }
  const merged = mergeConfig(base, raw, SESSION_OVERLAY_ENTRY);
  return merged.errors.length ? { config: base, problems: merged.errors } : { config: merged.config, problems: [] };
}

export function sessionOverrideValue(overlay: SessionOverlay, item: SettingItem): unknown {
  if (item.paths) {
    const values = item.paths.map((path) => getPathValue(overlay.patch, path));
    if (values.every((value) => value === undefined)) return undefined;
    return values.some((value) => value === undefined) ? "partial" : item.combine!(values);
  }
  if (item.providerId !== undefined) {
    return item.providerOptionPath
      ? getPathValue(overlay.providerOptions[item.providerId], item.providerOptionPath)
      : Object.hasOwn(overlay.providers, item.providerId)
      ? overlay.providers[item.providerId]
      : undefined;
  }
  return getPathValue(overlay.patch, item.userPath);
}
export function builtinDefaultValue(item: SettingItem): unknown {
  if (item.providerId !== undefined) {
    if (item.providerOptionPath)
      return getPathValue(
        defaultConfig().providers.find((provider) => provider.id === item.providerId)?.options,
        item.providerOptionPath
      );
    return item.providerId !== "email";
  }
  return item.read(defaultConfig());
}
export function providerDefinitionSource(item: SettingItem, rawUser: unknown): "default" | "user" {
  const providers = getPathValue(rawUser, "providers");
  return item.providerId !== undefined &&
    Array.isArray(providers) &&
    providers.some((entry) => isPlainObject(entry) && entry.id === item.providerId)
    ? "user"
    : "default";
}
export function settingSnapshot(item: SettingItem, config: NotificationConfig): SettingPatch {
  return item.snapshot?.(config) ?? item.patch(item.read(config) as SettingValue | SettingValue[]);
}
export function patchOperations(patch: SettingPatch): SimpleSettingPatch[] {
  return patch.kind === "compound" ? patch.operations : [patch];
}
/** A reviewed batch owns only listed leaves, not unrelated selected-provider switches. */
export function pendingPatch(items: readonly SettingItem[], config: NotificationConfig): SettingPatch {
  return {
    kind: "compound",
    operations: items.flatMap((item) =>
      item.destinations
        ? [{ kind: "path" as const, path: item.userPath, value: item.read(config) }]
        : patchOperations(item.patch(item.read(config) as SettingValue | SettingValue[]))
    ),
  };
}
/** Pure transaction candidate; validation happens before the caller commits one session snapshot. */
export function applySettingPatch(overlay: SessionOverlay, item: SettingItem, patch: SettingPatch): SessionOverlay {
  const next = structuredClone(overlay);
  const owners = new Set(next.channelOwners ?? []);
  for (const operation of patchOperations(patch)) {
    if (operation.kind === "path") next.patch = setPatchPath(next.patch, operation.path, operation.value);
    else if (operation.kind === "providerOption")
      next.providerOptions[operation.id] = setPatchPath(
        next.providerOptions[operation.id] ?? {},
        operation.optionPath,
        operation.value
      );
    else {
      next.providers[operation.id] = operation.value;
      if (item.destinations) owners.add(operation.id);
      else owners.delete(operation.id);
    }
  }
  if (owners.size) next.channelOwners = [...owners];
  else delete next.channelOwners;
  return next;
}
export function itemRemovals(item: SettingItem, config: NotificationConfig, overlay: SessionOverlay) {
  if (item.paths) return item.paths.map((path) => ({ kind: "path" as const, path }));
  if (item.destinations) {
    const owned = new Set(overlay.channelOwners ?? []);
    for (const id of config.channels) if (!Object.hasOwn(overlay.providers, id) || owned.has(id)) owned.add(id);
    return [
      { kind: "path" as const, path: item.userPath },
      ...[...owned].map((id) => ({ kind: "provider" as const, id })),
    ];
  }
  return [
    item.providerId
      ? item.providerOptionPath
        ? { kind: "providerOption" as const, id: item.providerId, optionPath: item.providerOptionPath }
        : { kind: "provider" as const, id: item.providerId }
      : { kind: "path" as const, path: item.userPath },
  ];
}

export function hasUserDefault(rawUser: unknown, item: SettingItem): boolean {
  if (item.paths) return item.paths.some((path) => hasPath(rawUser, path));
  if (item.providerId !== undefined) {
    const entry = rawProvider(rawUser, item.providerId);
    return item.providerOptionPath ? hasPath(entry, `options.${item.providerOptionPath}`) : hasPath(entry, "enabled");
  }
  return hasPath(rawUser, item.userPath);
}
export function userDefaultValue(rawUser: unknown, item: SettingItem): unknown {
  if (!hasUserDefault(rawUser, item)) return undefined;
  if (item.paths) {
    const values = item.paths.map((path) => getPathValue(rawUser, path));
    return values.some((value) => value === undefined) ? "partial" : item.combine!(values);
  }
  if (item.providerId !== undefined) {
    const entry = rawProvider(rawUser, item.providerId);
    return getPathValue(entry, item.providerOptionPath ? `options.${item.providerOptionPath}` : "enabled");
  }
  return getPathValue(rawUser, item.userPath);
}
function rawProvider(raw: unknown, id: string): Record<string, unknown> | undefined {
  const providers = getPathValue(raw, "providers");
  return Array.isArray(providers) ? providers.find((entry) => isPlainObject(entry) && entry.id === id) : undefined;
}

/** Rebuild from raw JSON inside the file transaction. Never freeze other conversation options. */
function providerUserFilePatch(
  raw: unknown,
  id: string,
  type: string,
  update: (entry: ConfigPatch) => ConfigPatch
): ConfigPatch {
  const providers = getPathValue(raw, "providers");
  const entries = Array.isArray(providers) ? structuredClone(providers) : [];
  const index = entries.findIndex((entry) => isPlainObject(entry) && entry.id === id);
  const entry = index < 0 ? { id, type } : entries[index];
  const updated = update(entry);
  if (index < 0) entries.push(updated);
  else entries[index] = updated;
  return { providers: entries };
}
export function channelUserFilePatch(raw: unknown, id: string, type: string, value: boolean): ConfigPatch {
  return providerUserFilePatch(raw, id, type, (entry) => ({ ...entry, enabled: value }));
}
export function providerOptionUserFilePatch(
  raw: unknown,
  id: string,
  type: string,
  path: string,
  value: unknown
): ConfigPatch {
  return providerUserFilePatch(raw, id, type, (entry) => ({
    ...entry,
    options: setPatchPath(isPlainObject(entry.options) ? entry.options : {}, path, value),
  }));
}
export function settingUserFilePatch(raw: unknown, config: NotificationConfig, patch: SettingPatch): ConfigPatch {
  let sparse: ConfigPatch = isPlainObject(raw) ? structuredClone(raw) : {};
  let result: ConfigPatch = {};
  for (const operation of patchOperations(patch)) {
    const provider =
      operation.kind !== "path" ? config.providers.find((entry) => entry.id === operation.id) : undefined;
    const single =
      operation.kind === "path"
        ? setPatchPath({}, operation.path, operation.value)
        : operation.kind === "providers"
        ? channelUserFilePatch(sparse, operation.id, provider?.type ?? "terminal", operation.value)
        : providerOptionUserFilePatch(
            sparse,
            operation.id,
            provider?.type ?? "email",
            operation.optionPath,
            operation.value
          );
    sparse = mergePatch(sparse, single);
    result = mergePatch(result, single);
  }
  return result;
}
/** Drop only this item's override, pruning empty ancestors and retaining independent gates. */
export function clearItemOverride(overlay: SessionOverlay, item: SettingItem): SessionOverlay {
  const next = structuredClone(overlay);
  if (item.paths || item.destinations) {
    for (const path of item.paths ?? [item.userPath]) next.patch = removePath(next.patch, path);
    if (item.destinations) {
      for (const id of next.channelOwners ?? []) delete next.providers[id];
      delete next.channelOwners;
    }
  } else if (item.providerId !== undefined) {
    if (item.providerOptionPath) {
      const options = removePath(next.providerOptions[item.providerId] ?? {}, item.providerOptionPath);
      if (Object.keys(options).length) next.providerOptions[item.providerId] = options;
      else delete next.providerOptions[item.providerId];
    } else {
      delete next.providers[item.providerId];
      if (next.channelOwners) next.channelOwners = next.channelOwners.filter((id) => id !== item.providerId);
    }
  } else next.patch = removePath(next.patch, item.userPath);
  return next;
}
