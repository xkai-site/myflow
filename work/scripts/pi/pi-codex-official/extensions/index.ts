import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveCodexOAuthConfig } from "./codex-auth.ts";

const PROVIDER_ID = "openai-codex";
const API = "openai-codex-responses";
const BASE_URL = "https://chatgpt.com/backend-api";

interface LocalModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config");

function readModels(): LocalModelConfig[] {
  const configPath = path.join(CONFIG_DIR, "models.json");
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("根节点必须是非空数组");
    }
    const models = data.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`第 ${index + 1} 个模型必须是对象`);
      }
      const model = value as Partial<LocalModelConfig>;
      const cost = model.cost as Partial<LocalModelConfig["cost"]> | undefined;
      if (
        typeof model.id !== "string" ||
        model.id.trim() === "" ||
        typeof model.name !== "string" ||
        model.name.trim() === "" ||
        typeof model.reasoning !== "boolean" ||
        !Array.isArray(model.input) ||
        model.input.length === 0 ||
        !model.input.every((item) => item === "text" || item === "image") ||
        typeof model.contextWindow !== "number" ||
        model.contextWindow <= 0 ||
        typeof model.maxTokens !== "number" ||
        model.maxTokens <= 0 ||
        !cost ||
        typeof cost.input !== "number" ||
        typeof cost.output !== "number" ||
        typeof cost.cacheRead !== "number" ||
        typeof cost.cacheWrite !== "number"
      ) {
        throw new Error(`第 ${index + 1} 个模型配置不完整或类型错误`);
      }
      return model as LocalModelConfig;
    });
    const ids = new Set(models.map((model) => model.id));
    if (ids.size !== models.length) {
      throw new Error("模型 id 不能重复");
    }
    return models;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取模型配置 ${configPath}。原因: ${detail}`);
  }
}

const MODELS = readModels();

export default function (pi: ExtensionAPI) {
  // 使用扩展兼容层注册，避免开发模式热重载时加载第二份 pi-ai 运行时。
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenAI Codex (CC Switch)",
    baseUrl: BASE_URL,
    api: API,
    authHeader: true,
    oauth: createLiveCodexOAuthConfig(),
    models: MODELS,
  });
}
