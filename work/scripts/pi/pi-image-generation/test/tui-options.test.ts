import assert from "node:assert/strict";
import test from "node:test";
import { readTestConfig } from "./config-helpers.ts";
import { itemOptions, parameterItems, policyLabel, selectItem, selectParameters, selectPolicy } from "../src/tui-options.ts";

const config = await readTestConfig();
const model = config.models.find((m) => m.key === "openai-flare-26")!;

test("model labels show configuration positioning and map actual choices to stable keys", async () => {
	const models = config.models;
	const options = itemOptions(models, "openai-flare-26");
	// These positions intentionally verify default-first presentation, not catalog ordering.
	assert.equal(options[0].item.key, "openai-flare-26");
	assert.equal(options[0].label, "GPT Image 2.6 Flare - 快速生成与日常迭代（默认）");
	for (const item of models) {
		assert.ok(item.description, `${item.key} needs positioning`);
		assert.ok(options.find((option) => option.item.key === item.key)!.label.startsWith(`${item.name} - ${item.description}`));
	}
	assert.equal(itemOptions(models.filter((item) => item.provider === "qwen"), "wan")[0].label, "Wan 2.7 Image - 基础生图与参考图编辑（默认）");
	for (const target of models) {
		for (const description of [target.description, "修改后的定位说明"]) {
			const items = models.map((item) => item.key === target.key ? { ...item, description } : item);
			const selected = await selectItem({ ui: { select: async (_title, labels) => {
				const tokens = itemOptions(items, "openai-flare-26");
				assert.deepEqual(labels, tokens.map((token) => token.label));
				return tokens.find((token) => token.item.key === target.key)!.label;
			} } }, "图片模型", items, "openai-flare-26");
			assert.equal(selected?.key, target.key);
		}
	}
});

test("single/empty choices skip UI; cancel and unknown labels cannot select a model", async () => {
	const ctx = { ui: { select: async () => assert.fail("Unexpected selector") } };
	assert.equal(await selectItem(ctx, "single", [model]), model);
	assert.equal(await selectItem(ctx, "empty", []), undefined);
	for (const response of [undefined, "not-an-option"]) {
		assert.equal(await selectItem({ ui: { select: async () => response } }, "models", config.models), undefined);
	}
});

test("colliding display text is disambiguated without parsing keys from labels", async () => {
	const items = [
		{ key: "one", name: "Same", description: "描述" },
		{ key: "two", name: "Same", description: "描述" },
		{ key: "three", name: "Same - 描述 (one)" },
	];
	const options = itemOptions(items);
	assert.equal(new Set(options.map((o) => o.label)).size, items.length);
	for (let i = 0; i < items.length; i++) {
		assert.equal(await selectItem({ ui: { select: async (_t, labels) => labels[i] } }, "models", items), items[i]);
	}
});

test("parameter menu uses defaults in one confirmation, with model-supported controls only", async () => {
	for (const selected of config.models) {
		let count = 0;
		const result = await selectParameters({ ui: { select: async (_title, labels) => { count++; return labels[0]; } } }, selected, "generate");
		assert.equal(count, 1);
		assert.deepEqual(result, { size: selected.size.generate.default,
			...(selected.quality ? { quality: selected.quality.default } : {}),
			...(selected.complexity ? { complexity: selected.complexity.default } : {}),
			...(selected.outputFormat ? { outputFormat: selected.outputFormat.default } : {}),
			...(selected.background ? { background: selected.background.default } : {}),
		});
		const options = parameterItems(selected, "generate", result!);
		assert.equal(options.some((o) => o.key === "quality"), !!selected.quality);
		assert.equal(options.some((o) => o.key === "complexity"), !!selected.complexity);
		assert.equal(options.some((o) => o.key === "outputFormat"), !!selected.outputFormat);
		assert.equal(options.some((o) => o.key === "background"), !!selected.background);
		assert.ok(options.slice(1).every((o) => o.name.includes("默认")));
	}
	assert.equal(policyLabel(model.size.generate, "1024x1024"), "正方形 (1024x1024)");
});

test("parameter changes persist, Escape returns from picker and main Escape cancels", async () => {
	const actions = ["size", "1536x1024", "quality", "max", "complexity", "low", "quality", undefined, "submit"];
	let index = 0;
	const result = await selectParameters({ ui: { select: async (title, labels) => {
		const action = actions[index++];
		if (action === undefined) return undefined;
		if (title.endsWith(" - 参数")) {
			const values = { size: index > 2 ? "1536x1024" : "auto", quality: index > 4 ? "max" : "auto", complexity: index > 6 ? "low" : "high" };
			const items = parameterItems(model, "generate", values);
			assert.deepEqual(labels, items.map((o) => o.name));
			return labels[items.findIndex((o) => o.key === action)];
		}
		const policy = title === "尺寸" ? model.size.generate : title === "画质" ? model.quality! : model.complexity!;
		return labels.find((label) => label === policyLabel(policy, action));
	} } }, model, "generate");
	assert.equal(index, actions.length);
	assert.deepEqual(result, { size: "1536x1024", quality: "max", complexity: "low", outputFormat: "png", background: "auto" });
	assert.equal(await selectParameters({ ui: { select: async () => undefined } }, model, "generate"), undefined);
});

test("single-value policies skip pickers and editing uses task-specific size", async () => {
	const policy = { default: "fixed", options: [{ value: "fixed", label: "固定" }] };
	assert.equal(await selectPolicy({ ui: { select: async () => assert.fail() } }, "single", policy), "fixed");
	const pro = config.models.find((m) => m.key === "wan-pro")!;
	const result = await selectParameters({ ui: { select: async (_title, labels) => {
		assert.equal(labels[0], "开始编辑");
		return labels[0];
	} } }, pro, "edit");
	assert.deepEqual(result, { size: "2K" });
	assert.equal(parameterItems(pro, "edit", result!)[1].name, "尺寸：2K（默认）");
	assert.ok(!pro.size.edit!.options.some((o) => o.value === "4K"));
});
