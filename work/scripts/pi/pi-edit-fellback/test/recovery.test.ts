import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import install, { EDIT_RECOVERY, enhanceEditFailure } from "../extensions/index.ts";

const duplicate = "Found 2 occurrences of edits[2] in assets/css/style.scss. Each oldText must be unique. Please provide more context to make it unique.";

function event(text = duplicate, overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "edit",
    toolCallId: "test-edit",
    input: { path: "assets/css/style.scss", edits: [{ oldText: "x", newText: "y" }] },
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
    ...overrides,
  };
}

function textOf(result: { content?: ToolResultEvent["content"] }): string {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("registers only one synchronous tool_result handler and accesses no other API", () => {
  const registrations: unknown[][] = [];
  const pi = new Proxy({}, {
    get(_target, key) {
      assert.equal(key, "on", `Unexpected ExtensionAPI access: ${String(key)}`);
      return (...args: unknown[]) => { registrations.push(args); return () => {}; };
    },
  });
  install(pi as ExtensionAPI);
  assert.deepEqual(registrations, [["tool_result", enhanceEditFailure]]);
  assert.ok(!(enhanceEditFailure(event()) instanceof Promise));
});

test("normal results and non-edit results return before inspecting content", () => {
  for (const overrides of [
    { isError: false },
    { toolName: "bash" },
    { toolName: "write" },
    { toolName: "read" },
    { toolName: "custom-edit" },
  ]) {
    const original = event(duplicate, overrides);
    Object.defineProperty(original, "content", { get() { throw new Error("content must not be accessed"); } });
    assert.equal(enhanceEditFailure(original), undefined);
  }
});

for (const message of [
  duplicate,
  "Found 2 occurrences of the text in sample.txt. The text must be unique. Please provide more context to make it unique.",
  "Found 12 occurrences of oldText in file.txt.",
  "FOUND 100 OCCURRENCES OF edits[10] in C:\\path with spaces\\file.ts.",
  "Found\n3 occurrences of the text in file.txt.",
  "Each oldText must be unique.",
  "oldText is not unique in target.ts",
  "The old text is not unique.",
  "oldText matches multiple locations in target.ts",
  "Old text matched more than one position in target.ts",
]) {
  test(`enhances ambiguity: ${message}`, () => {
    const original = event(message);
    const result = enhanceEditFailure(original);
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(result.content?.length, original.content.length + 1);
    assert.equal(result.content?.[0], original.content[0]);
    assert.equal(textOf(result), `${message}\n${EDIT_RECOVERY}`);
    assert.equal(textOf(original), message);
  });
}

for (const message of [
  "Could not find the exact text in sample.txt. The old text must match exactly including all whitespace and newlines.",
  "Could not find edits[2] in sample.txt. The oldText must match exactly including all whitespace and newlines.",
  "Could not edit file: missing.ts. Error code: ENOENT.",
  "EACCES: permission denied",
  "oldText must not be empty in sample.txt.",
  "edits[0] and edits[1] overlap in file.ts. Merge them into one edit or target disjoint regions.",
  "No changes made to sample.txt. The replacement produced identical content.",
  "Operation aborted",
  "Found 0 occurrences of oldText in file.ts.",
  "Found 1 occurrence of the text in file.ts.",
  "Found 12 occurrences of a search pattern in file.ts.",
  "Error parsing oldText: invalid input",
  "file name must be unique",
  "",
]) {
  test(`leaves unrelated failure untouched: ${message || "(empty)"}`, () => {
    assert.equal(enhanceEditFailure(event(message)), undefined);
  });
}

test("preserves original blocks, details, structuredContent, usage and input without mutation", () => {
  const image = Object.freeze({ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" });
  const originalText = Object.freeze({ type: "text" as const, text: duplicate, extraMetadata: "retain" });
  const otherText = Object.freeze({ type: "text" as const, text: "Additional diagnostic" });
  const details = Object.freeze({ custom: "retain", nested: { a: 1 } });
  const structuredContent = Object.freeze({ diagnostic: "ambiguous", count: 2 });
  const usage = Object.freeze({
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const original = event(duplicate, { content: [image, originalText, otherText], details, structuredContent, usage, parentToolCallId: "parent" });
  Object.freeze(original.content);
  Object.freeze(original);
  const before = structuredClone(original);
  const result = enhanceEditFailure(original)!;
  assert.equal(result.isError, true);
  assert.equal(result.details, details);
  assert.equal(result.structuredContent, structuredContent);
  assert.equal(result.usage, usage);
  for (const [index, block] of original.content.entries()) assert.equal(result.content?.[index], block);
  assert.deepEqual(original, before);
  assert.equal(result.content?.length, 4);
});

test("preserves falsey structured content values", () => {
  for (const structuredContent of [null, false, 0, ""]) {
    assert.equal(enhanceEditFailure(event(duplicate, { structuredContent }))?.structuredContent, structuredContent);
  }
});

test("duplicate detection can span multiple text blocks; never reads image data as error text", () => {
  const result = enhanceEditFailure(event("", { content: [
    { type: "text", text: "Each oldText" },
    { type: "image", data: "ignored", mimeType: "image/png" },
    { type: "text", text: "must be unique." },
  ] }));
  assert.equal(result?.isError, true);
  assert.equal(enhanceEditFailure(event("", { content: [
    { type: "image", data: duplicate, mimeType: "image/png" },
  ] })), undefined);
  assert.equal(enhanceEditFailure(event("", { content: [] })), undefined);
});

test("is idempotent across handler chaining and repeated dispatch, with no cross-call state", () => {
  const original = event();
  const result = enhanceEditFailure(original)!;
  const repeated = { ...original, ...result } as ToolResultEvent;
  assert.equal(enhanceEditFailure(repeated), undefined);
  assert.equal(textOf(result).split("Edit recovery:").length - 1, 1);
  assert.equal(enhanceEditFailure(event(`${duplicate}\n\n${EDIT_RECOVERY}`)), undefined);
  // A shortened or previously appended recovery block is not duplicated either.
  assert.equal(enhanceEditFailure(event(`${duplicate}\nEdit recovery:\n1. Re-read the file.`)), undefined);
  assert.ok(enhanceEditFailure(original));
  assert.equal(enhanceEditFailure(event(duplicate, { isError: false })), undefined);
});

test("recovery guidance covers safe progressive repair without automatic execution", () => {
  assert.match(EDIT_RECOVERY, /1\. Re-read/);
  assert.match(EDIT_RECOVERY, /2\. Retry edit with sufficient unique context/);
  assert.match(EDIT_RECOVERY, /3\. If ambiguity remains/);
  assert.match(EDIT_RECOVERY, /contextual unified diff/);
  assert.match(EDIT_RECOVERY, /git apply --check before git apply; apply only on success/);
  assert.match(EDIT_RECOVERY, /never force/);
  assert.match(EDIT_RECOVERY, /Do not overwrite the entire file/);
  assert.match(EDIT_RECOVERY, /Preserve unrelated changes/);
  assert.match(EDIT_RECOVERY, /inspect\s+the target and diff/);
  assert.match(EDIT_RECOVERY, /Stop and explain if the target is unclear/);
  assert.match(EDIT_RECOVERY, /Use native edit for subsequent edits/);
});
