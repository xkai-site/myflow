import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sizeForTask, type ChoicePolicy, type ImageModelConfig, type ImageTask } from "./model-config.ts";

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

export interface ImageParameters { size: string; quality?: string; complexity?: string }
type ParameterKey = keyof ImageParameters;
export function parameterPolicies(model: ImageModelConfig, task: ImageTask): { key: ParameterKey; name: string; policy: ChoicePolicy }[] {
	return [
		{ key: "size" as const, name: "尺寸", policy: sizeForTask(model, task) },
		...(model.quality ? [{ key: "quality" as const, name: "画质", policy: model.quality }] : []),
		...(model.complexity ? [{ key: "complexity" as const, name: "复杂度", policy: model.complexity }] : []),
	];
}

export function parameterItems(model: ImageModelConfig, task: ImageTask, values: ImageParameters): NamedItem[] {
	return [
		{ key: "submit", name: task === "edit" ? "开始编辑" : "开始生成" },
		...parameterPolicies(model, task).map(({ key, name, policy }) => ({ key, name: `${name}：${policyLabel(policy, values[key] ?? policy.default)}` })),
	];
}

export async function selectParameters(ctx: SelectionContext, model: ImageModelConfig, task: ImageTask): Promise<ImageParameters | undefined> {
	const policies = parameterPolicies(model, task);
	const values: ImageParameters = { size: sizeForTask(model, task).default };
	for (const { key, policy } of policies) values[key] = policy.default;
	while (true) {
		const action = await selectItem(ctx, `${model.name} - 参数`, parameterItems(model, task, values));
		if (!action) return undefined;
		if (action.key === "submit") return values;
		const selected = policies.find(({ key }) => key === action.key)!;
		const value = await selectPolicy(ctx, selected.name, selected.policy, values[selected.key]);
		// Escape from a parameter picker returns here without losing previous values.
		if (value !== undefined) values[selected.key] = value;
	}
}
