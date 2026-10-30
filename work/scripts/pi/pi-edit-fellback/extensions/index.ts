import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

const RECOVERY_MARKER = "Edit recovery:";

export const EDIT_RECOVERY = `Edit recovery:
1. Re-read the relevant file section.
2. Retry edit with sufficient unique context.
3. If ambiguity remains, use the existing bash tool
   to apply a contextual unified diff patch.
4. Validate the patch before applying it.
5. Verify the resulting changes.
6. Do not overwrite the entire file or modify
   unrelated code.

Patch safety: Use standard unified diff, not custom apply_patch format.
Run git apply --check before git apply; apply only on success, otherwise
re-read and re-locate (never force). Preserve unrelated changes; inspect
the target and diff. Stop and explain if the target is unclear.
Use native edit for subsequent edits.`;

// Pi 1.4 reports "the text" for one replacement and "edits[n]" for a batch.
// Match diagnostic fragments, not the complete message or a particular path.
const DUPLICATE_OCCURRENCES = /\bfound\s+(?:[2-9]|[1-9]\d+)\s+occurrences?\s+of\s+(?:the\s+(?:old\s*)?text\b|old\s*text\b|edits\s*\[\s*\d+\s*\])/i;
const NON_UNIQUE_TEXT = /\b(?:old\s*text|the\s+(?:old\s+)?text)\s+(?:must\s+be\s+unique|is\s+not\s+unique)\b/i;
const MULTIPLE_MATCHES = /\bold\s*text\b\s+match(?:es|ed)?\s+(?:multiple|more\s+than\s+one)\s+(?:locations?|positions?|places?)\b/i;

export function enhanceEditFailure(event: ToolResultEvent): ToolResultEventResult | undefined {
  // The normal path does not even inspect content or allocate a result.
  if (event.toolName !== "edit" || event.isError !== true) return;

  const text = event.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (text.includes(RECOVERY_MARKER)) return;
  if (!DUPLICATE_OCCURRENCES.test(text) && !NON_UNIQUE_TEXT.test(text) && !MULTIPLE_MATCHES.test(text)) return;

  return {
    // Append a separate text block: all original blocks and their metadata stay intact.
    content: [...event.content, { type: "text", text: EDIT_RECOVERY }],
    details: event.details,
    // Pi drops structuredContent on content replacement unless explicitly returned.
    structuredContent: event.structuredContent,
    usage: event.usage,
    isError: true,
  };
}

export default function piEditFellback(pi: ExtensionAPI): void {
  pi.on("tool_result", enhanceEditFailure);
}
