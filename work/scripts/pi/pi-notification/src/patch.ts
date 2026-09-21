/**
 * Sparse patch helpers shared by all three config layers.
 *
 * Used by `config.ts` (merging a single Ctrl+S field into the raw user file),
 * by `settings.ts` (session overlay and per-setting path access) and by tests.
 *
 * Semantics are deliberate: arrays are replaced as a whole value while plain
 * objects merge field by field.
 */

export type ConfigPatch = Record<string, unknown>;

/**
 * Keys whose assignment would replace the prototype of the target object instead of storing a value.
 * A configuration patch never needs them, so they are dropped.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a nested field; returns undefined as soon as a level is missing. */
export function getPathValue(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** True when the path exists as an own property; used to detect "never saved by the user". */
export function hasPath(source: unknown, path: string): boolean {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

/** Writes one path level by level and returns a new patch object; the input is left untouched. */
export function setPatchPath(patch: ConfigPatch, path: string, value: unknown): ConfigPatch {
  const keys = path.split(".");
  const root: ConfigPatch = { ...patch };
  let cursor: Record<string, unknown> = root;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    const copy: Record<string, unknown> = isPlainObject(next) ? { ...next } : {};
    cursor[key] = copy;
    cursor = copy;
  }
  cursor[keys[keys.length - 1]!] = value;
  return root;
}

/** Deep merge: plain objects recurse, arrays and scalars are replaced. */
export function mergePatch<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (isPlainObject(base) ? base : patch) as T;
  const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    // Assigning `__proto__` would swap the prototype of the merged object, letting a file inject
    // properties that were never validated; the key is dropped instead of written.
    if (UNSAFE_KEYS.has(key)) continue;
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? mergePatch(current, value) : structuredClone(value);
  }
  return result as T;
}
