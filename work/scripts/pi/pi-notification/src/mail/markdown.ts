import { Marked } from "marked";

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
const literalBlock = (text: string) => `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>\n`;

// Only parser-generated formatting is allowed. Keep HTML and resource references as
// visible source text, never as active markup or URL attributes.
const markdown = new Marked({
  breaks: true,
  // Keep table source literal: padding ragged rows can allocate far more than the input size.
  tokenizer: { table: () => undefined },
  renderer: {
    html: ({ raw, block }) => block ? literalBlock(raw) : escapeHtml(raw),
    text: (token) => "escaped" in token && token.escaped ? escapeHtml(token.text) : false,
    link: ({ raw }) => escapeHtml(raw),
    image: ({ raw }) => escapeHtml(raw),
    def: ({ raw }) => literalBlock(raw),
    checkbox: ({ checked }) => checked ? "[x] " : "[ ] ",
    code: ({ text }) => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;color:#242629;padding:12px"><code>${escapeHtml(text)}</code></pre>\n`,
  },
});

export function renderMailMarkdown(text: string): string {
  try {
    return markdown.parse(text, { async: false });
  } catch (error) {
    // Extremely deep Markdown may exceed the parser stack even within the mail byte limit.
    if (!(error instanceof RangeError)) throw error;
    return literalBlock(text);
  }
}
