import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { codexAuthFile } from "./codex-auth.ts";

// Codex's cache does not publish an output limit. This is a Pi metadata
// placeholder for models absent from Pi's built-in catalog, not an API limit.
const UNKNOWN_MODEL_MAX_TOKENS = 16_384;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const COMPAT_KEYS = ["supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch"] as const;
type BuiltinModelMetadata = Pick<ProviderModelConfig, "id" | "maxTokens" | "compat">;

export function codexModelsFile(): string {
  return path.join(path.dirname(codexAuthFile()), "models_cache.json");
}

function modelError(cachePath: string, detail: string): Error {
  return new Error(
    `无法读取 Codex 模型缓存 (${cachePath})：${detail}。` +
      "本插件未注册模型。请让 Codex 更新该目录的模型缓存，然后在 Pi 执行 /reload。",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Pure projection: the cache owns the list; Pi metadata only fills protocol gaps. */
export function parseCodexModels(
  data: unknown,
  builtinModels: readonly BuiltinModelMetadata[] = [],
  cachePath: string = codexModelsFile(),
): ProviderModelConfig[] {
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw modelError(cachePath, "根节点必须是包含 models 数组的对象");
  }

  const builtins = new Map(builtinModels.map((model) => [model.id, model]));
  const ids = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const [index, value] of data.models.entries()) {
    function invalid(field: string): never {
      throw modelError(cachePath, `第 ${index + 1} 项 ${field}`);
    }
    if (!isRecord(value)) invalid("必须是对象");
    if (value.visibility !== "list" || value.supported_in_api !== true) continue;
    if (typeof value.slug !== "string" || !value.slug.trim()) invalid("slug 必须是非空字符串");
    const id = value.slug.trim();
    if (ids.has(id)) invalid("slug 不能重复");
    ids.add(id);

    if (
      !Array.isArray(value.input_modalities) ||
      !value.input_modalities.every((item) => typeof item === "string")
    ) invalid("input_modalities 必须是字符串数组");
    const input = [...new Set(value.input_modalities.filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    ))];
    if (input.length === 0) invalid("input_modalities 没有 Pi 支持的 text/image 输入");
    if (!isPositiveInteger(value.context_window)) invalid("context_window 必须是正安全整数");

    if (!Array.isArray(value.supported_reasoning_levels)) {
      invalid("supported_reasoning_levels 必须是对象数组");
    }
    const efforts = new Set<string>();
    for (const level of value.supported_reasoning_levels) {
      if (!isRecord(level) || typeof level.effort !== "string" || !level.effort.trim()) {
        invalid("supported_reasoning_levels[].effort 必须是非空字符串");
      }
      efforts.add(level.effort.trim());
    }
    const thinkingLevelMap: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {};
    for (const level of THINKING_LEVELS) {
      thinkingLevelMap[level] = efforts.has(level) ? level : null;
    }
    if (efforts.has("none") || efforts.size === 0) thinkingLevelMap.off = "none";
    if (!efforts.has("minimal") && efforts.has("low")) thinkingLevelMap.minimal = "low";
    if (efforts.size > 0 && !Object.values(thinkingLevelMap).some((effort) => effort !== null)) {
      invalid("supported_reasoning_levels 没有 Pi 可用的推理等级");
    }

    const builtin = builtins.get(id);
    const outputLimit = builtin?.maxTokens;
    const compat: NonNullable<ProviderModelConfig["compat"]> = {};
    for (const key of COMPAT_KEYS) {
      const supported = builtin?.compat?.[key];
      if (typeof supported === "boolean") compat[key] = supported;
    }
    models.push({
      id,
      name: typeof value.display_name === "string" && value.display_name.trim()
        ? value.display_name.trim() : id,
      reasoning: THINKING_LEVELS.some((level) => level !== "off" && thinkingLevelMap[level] !== null),
      thinkingLevelMap,
      input,
      contextWindow: value.context_window,
      maxTokens: Math.min(
        isPositiveInteger(outputLimit) ? outputLimit : UNKNOWN_MODEL_MAX_TOKENS,
        value.context_window,
      ),
      // Pi requires cost metadata; pricing belongs to CC Switch, not this plugin.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
    });
  }
  if (models.length === 0) throw modelError(cachePath, "没有可见且 API 可用的模型");
  return models;
}

/** Read afresh on every factory invocation, including /reload. Never write the cache. */
export function readCodexModels(
  builtinModels: readonly BuiltinModelMetadata[] = [],
  cachePath: string = codexModelsFile(),
): ProviderModelConfig[] {
  let content: string;
  try {
    content = fs.readFileSync(cachePath, "utf8");
  } catch {
    throw modelError(cachePath, "文件不存在或无法读取");
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // JSON.parse errors can include snippets from the source; never forward them.
    throw modelError(cachePath, "JSON 格式错误");
  }
  return parseCodexModels(data, builtinModels, cachePath);
}
