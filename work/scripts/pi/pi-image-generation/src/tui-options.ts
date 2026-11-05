import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseReferenceImagePaths } from "./image-files.ts";
import { normalizeImageOutput, normalizeNativeOutput, outputFormatForTask, sizeForOutput, type ChoicePolicy, type ImageModelConfig, type ImageTask } from "./model-config.ts";

type SelectionContext = { ui: Pick<ExtensionContext["ui"], "select"> };
export interface NamedItem { key: string; name: string; description?: string }

/** Display strings are opaque UI tokens, never parsed to recover a model key. */
export function itemOptions<T extends NamedItem>(items: readonly T[], defaultKey?: string): { label: string; item: T }[] {
	const ordered = [...items].sort((a, b) => Number(b.key === defaultKey) - Number(a.key === defaultKey));
	const labels = ordered.map((item) => `${item.name}${item.description ? ` - ${item.description}` : ""}${item.key === defaultKey ? "（默认）" : ""}`);
	const used = new Set<string>();
	return ordered.map((item, index) => {
		const base = labels[index];
		let label = labels.indexOf(base) !== labels.lastIndexOf(base) ? `${base} (${item.key})` : base;
		while (used.has(label)) label += ` [${index + 1}]`;
		used.add(label);
		return { label, item };
	});
}

export async function selectItem<T extends NamedItem>(ctx: SelectionContext, title: string, items: readonly T[], defaultKey?: string): Promise<T | undefined> {
	if (items.length === 1) return items[0];
	if (!items.length) return undefined;
	const options = itemOptions(items, defaultKey);
	const choice = await ctx.ui.select(title, options.map((option) => option.label));
	return options.find((option) => option.label === choice)?.item;
}

export function policyLabel(policy: ChoicePolicy, value: string): string {
	const label = policy.options.find((option) => option.value === value)?.label ?? value;
	return `${label}${/^\d+[x*]\d+$/i.test(value) && label !== value ? ` (${value})` : ""}${value === policy.default ? "（默认）" : ""}`;
}

export async function selectPolicy(ctx: SelectionContext, title: string, policy: ChoicePolicy, current = policy.default): Promise<string | undefined> {
	const options = [...policy.options].sort((a, b) => Number(b.value === current) - Number(a.value === current));
	return (await selectItem(ctx, title, options.map((option) => ({ key: option.value, name: policyLabel(policy, option.value) }))))?.key;
}

export interface ImageParameters { size: string; quality?: string; complexity?: string; outputFormat?: string; background?: string; frameCount?: number; frameDurationMs?: number; markupPath?: string }
type ParameterKey = Exclude<keyof ImageParameters, "frameCount" | "frameDurationMs" | "markupPath">;
export function parameterPolicies(model: ImageModelConfig, task: ImageTask, values?: ImageParameters): { key: ParameterKey; name: string; policy: ChoicePolicy }[] {
	const outputFormat = outputFormatForTask(model, task);
	return [
		{ key: "size" as const, name: "尺寸", policy: sizeForOutput(model, task, values?.outputFormat) },
		...(model.quality ? [{ key: "quality" as const, name: "画质", policy: model.quality }] : []),
		...(model.complexity ? [{ key: "complexity" as const, name: "复杂度", policy: model.complexity }] : []),
		...(outputFormat ? [{ key: "outputFormat" as const, name: "输出格式", policy: outputFormat }] : []),
		...(model.background ? [{ key: "background" as const, name: "背景", policy: model.background }] : []),
	];
}

export function parameterItems(model: ImageModelConfig, task: ImageTask, values: ImageParameters): NamedItem[] {
	return [
		{ key: "submit", name: task === "edit" ? "开始编辑" : "开始生成" },
		...parameterPolicies(model, task, values).map(({ key, name, policy }) => ({ key, name: `${name}：${policyLabel(policy, values[key] ?? policy.default)}` })),
		...(task === "edit" && model.nativeCapabilities?.markup?.enabled ? [{ key: "markupPath", name: `标记 PNG：${values.markupPath ? "已选择" : "未选择"}（实验性，Codex 未在线验证）` }] : []),
		...(task === "generate" && values.outputFormat === "gif" && model.nativeCapabilities?.gif?.enabled ? [
			{ key: "frameCount", name: `动画帧数：${values.frameCount ?? model.nativeCapabilities.gif.frameCount.default}` },
			{ key: "frameDurationMs", name: `每帧时长：${values.frameDurationMs ?? model.nativeCapabilities.gif.frameDurationMs.default}ms` },
		] : []),
	];
}

export async function selectParameters(ctx: SelectionContext & { ui: { input?: ExtensionContext["ui"]["input"] } }, model: ImageModelConfig, task: ImageTask): Promise<ImageParameters | undefined> {
	const values: ImageParameters = { size: sizeForOutput(model, task).default };
	for (const { key, policy } of parameterPolicies(model, task)) values[key] = policy.default;
	const sizes = { raster: values.size, gif: model.nativeCapabilities?.gif?.size.default ?? "auto" };
	while (true) {
		const policies = parameterPolicies(model, task, values);
		const action = await selectItem(ctx, `${model.name} - 参数`, parameterItems(model, task, values));
		if (!action) return undefined;
		if (action.key === "submit") {
			return { ...values, ...normalizeNativeOutput(model, values, task) };
		}
		if (action.key === "markupPath") {
			if (!ctx.ui.input) throw new Error("Host does not support markup path input");
			const input = await ctx.ui.input("标记 PNG 路径（透明图层，留空移除，Escape 保留）", values.markupPath);
			if (input !== undefined) {
				const paths = parseReferenceImagePaths(input);
				if (paths.length > 1) throw new Error("Markup accepts exactly one PNG path");
				if (paths.length) values.markupPath = paths[0];
				else delete values.markupPath;
			}
			continue;
		}
		if (action.key === "frameCount" || action.key === "frameDurationMs") {
			const gif = model.nativeCapabilities?.gif;
			if (!gif?.enabled || task !== "generate" || values.outputFormat !== "gif") throw new Error("GIF controls are unavailable");
			const key = action.key;
			const policy = gif[key];
			if (!ctx.ui.input) throw new Error("Host does not support GIF parameter input");
			const input = await ctx.ui.input(`${key === "frameCount" ? "动画帧数" : "每帧时长（ms）"}（${policy.min}～${policy.max}，当前 ${values[key] ?? policy.default}，Enter 保留）`);
			if (input !== undefined && input.trim()) {
				if (!/^\d+$/.test(input.trim())) throw new Error("GIF 参数必须是整数");
				Object.assign(values, normalizeNativeOutput(model, { ...values, [key]: Number(input.trim()) }, task));
			}
			continue;
		}
		const selected = policies.find(({ key }) => key === action.key)!;
		// Filter in either selection order using exactly the command layer's rules.
		const policy = selected.key === "outputFormat" || selected.key === "background"
			? { ...selected.policy, options: selected.policy.options.filter((option) => {
				try { normalizeImageOutput(model, { ...values, [selected.key]: option.value }, task); return true; }
				catch { return false; }
			}) } : selected.policy;
		const value = await selectPolicy(ctx, selected.name, policy, values[selected.key]);
		// Escape from a parameter picker returns here without losing previous values.
		if (value !== undefined) {
			if (selected.key === "outputFormat" && value !== values.outputFormat) {
				sizes[values.outputFormat === "gif" ? "gif" : "raster"] = values.size;
				values.size = sizes[value === "gif" ? "gif" : "raster"];
				delete values.frameCount; delete values.frameDurationMs;
			}
			values[selected.key] = value;
		}
	}
}
