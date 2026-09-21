/**
 * 稀疏补丁工具（出厂/用户/会话三层值的公共底座）。
 *
 * 三个使用方：
 *  - `config.ts`：把 Ctrl+S 的单字段补丁合并进用户文件原文（稀疏写盘）。
 *  - `settings.ts`：会话覆盖（overlay）与配置项路径读写。
 *  - 测试：直接驱动路径读写，不必构造整套配置。
 *
 * 语义刻意的：**数组整体替换**（数组就是一个字段的值），普通对象逐字段深合并。
 */

export type ConfigPatch = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取嵌套字段；任一层不存在返回 undefined。 */
export function getPathValue(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** 路径是否在对象里**显式存在**（用于识别「用户从未保存过这一项」）。 */
export function hasPath(source: unknown, path: string): boolean {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}

/** 逐层写路径，返回新的补丁对象（不修改入参）。 */
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

/** 深合并：普通对象递归，数组与标量整体替换。 */
export function mergePatch<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (isPlainObject(base) ? base : patch) as T;
  const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? mergePatch(current, value) : structuredClone(value);
  }
  return result as T;
}
