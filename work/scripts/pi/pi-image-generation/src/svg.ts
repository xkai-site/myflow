import { SaxesParser } from "saxes";

export const SVG_MAX_BYTES = 2 * 1024 * 1024;
export const SVG_MAX_NODES = 10_000;
export const SVG_MAX_DEPTH = 64;
const NS = "http://www.w3.org/2000/svg";
const ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const NUMBER_LIST = /^[\d\s.,+eE%\-]+$/;
const COMMON = new Set(["id", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "fill-rule", "clip-rule", "opacity", "fill-opacity", "stroke-opacity", "transform", "clip-path"]);
const ELEMENTS: Record<string, string[]> = {
 svg: ["viewBox", "width", "height", "x", "y", "preserveAspectRatio", "version"],
 g: [], defs: [], title: [], desc: [],
 path: ["d", "pathLength"], rect: ["x", "y", "width", "height", "rx", "ry", "pathLength"],
 circle: ["cx", "cy", "r", "pathLength"], ellipse: ["cx", "cy", "rx", "ry", "pathLength"],
 line: ["x1", "y1", "x2", "y2", "pathLength"], polygon: ["points", "pathLength"], polyline: ["points", "pathLength"],
 text: ["x", "y", "dx", "dy", "rotate", "text-anchor", "dominant-baseline", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing", "textLength", "lengthAdjust"],
 tspan: ["x", "y", "dx", "dy", "rotate", "text-anchor", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing"],
 linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"],
 radialGradient: ["cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod"],
 stop: ["offset", "stop-color", "stop-opacity"], clipPath: ["clipPathUnits"],
};
const WORDS = new Set(["stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "text-anchor", "dominant-baseline", "font-family", "font-weight", "font-style", "lengthAdjust", "preserveAspectRatio", "gradientUnits", "spreadMethod", "clipPathUnits"]);

/** Reject unsafe documents, never regex-sanitize XML or silently strip active content.
 * Deliberately narrower than SVG: no CSS/style, href/use, images, filters, masks,
 * animation, foreignObject or arbitrary namespaces. Only local paint/clip references.
 */
export function validateStaticSvg(bytes: Uint8Array): void {
 const fail = (): never => { throw new Error("Unsafe or invalid static SVG XML"); };
 if (!bytes.length || bytes.length > SVG_MAX_BYTES) throw new Error("SVG exceeds the file size limit");
 let xml: string;
 try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(); }
 const parser = new SaxesParser({ xmlns: true });
 const stack: string[] = [];
 const ids = new Map<string, string>();
 const references: { id: string; clip: boolean }[] = [];
 let nodes = 0, roots = 0;
 const countNode = () => { if (++nodes > SVG_MAX_NODES) fail(); };
 parser.on("error", fail);
 parser.on("doctype", fail);
 parser.on("processinginstruction", fail);
 parser.on("cdata", fail);
 parser.on("comment", countNode);
 parser.on("xmldecl", decl => {
  countNode();
  if (decl.version !== "1.0" || (decl.encoding && decl.encoding.toLowerCase() !== "utf-8")) fail();
 });
 parser.on("opentag", tag => {
  countNode();
  if (stack.length >= SVG_MAX_DEPTH) fail();
  if (tag.uri !== NS || tag.prefix || !Object.hasOwn(ELEMENTS, tag.local)) fail();
  if (!stack.length) { if (++roots !== 1 || tag.local !== "svg") fail(); }
  else if (tag.local === "svg") fail(); // no nested viewports/resource amplification
  // Definitions cannot inherit a clip reference from a clipped ancestor.
  if (tag.local === "defs" && (stack.length !== 1 || stack[0] !== "svg")) fail();
  if (["clipPath", "linearGradient", "radialGradient"].includes(tag.local) && stack.at(-1) !== "defs") fail();
  if (tag.local === "stop" && !["linearGradient", "radialGradient"].includes(stack.at(-1) ?? "")) fail();
  if (Object.keys(tag.attributes).length > 48) fail();
  for (const attr of Object.values(tag.attributes)) {
   if (attr.name === "xmlns" && stack.length === 0 && attr.value === NS) continue;
   if (attr.prefix || attr.uri || (!COMMON.has(attr.local) && !ELEMENTS[tag.local].includes(attr.local))) fail();
   const { local: name, value } = attr;
   if (value.length > (name === "d" || name === "points" ? 256_000 : 2048)) fail();
   if (name === "id") {
    if (!ID.test(value) || ids.has(value)) fail();
    ids.set(value, tag.local);
   } else if (["fill", "stroke", "stop-color"].includes(name)) {
    const ref = /^url\(#([A-Za-z_][A-Za-z0-9_.-]{0,127})\)$/.exec(value);
    if (ref) references.push({ id: ref[1], clip: false });
    else if (!/^(?:[A-Za-z]+|#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\))$/.test(value)) fail();
   } else if (name === "clip-path") {
    // No recursive clip graphs, including inherited references inside a clipPath.
    if (["svg", "defs", "clipPath", "linearGradient", "radialGradient", "stop"].includes(tag.local) || stack.includes("clipPath")) fail();
    const ref = /^url\(#([A-Za-z_][A-Za-z0-9_.-]{0,127})\)$/.exec(value);
    if (!ref) { if (value !== "none") fail(); }
    else references.push({ id: ref[1], clip: true });
   } else if (name === "d") {
    if (!/^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE\-]*$/.test(value)) fail();
   } else if (name === "transform" || name === "gradientTransform") {
    if (!/^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([\d\s.,+eE\-]+\)\s*)+$/.test(value)) fail();
   } else if (WORDS.has(name)) {
    if (!/^[A-Za-z\d\s,'_\-]+$/.test(value)) fail();
   } else if (!NUMBER_LIST.test(value)) fail();
  }
  stack.push(tag.local);
 });
 parser.on("closetag", () => { stack.pop(); });
 parser.on("text", text => {
  countNode();
  if (text.trim() && !["text", "tspan", "title", "desc"].includes(stack.at(-1) ?? "")) fail();
 });
 try { parser.write(xml).close(); } catch { return fail(); }
 if (roots !== 1 || stack.length) fail();
 for (const ref of references) {
  const target = ids.get(ref.id);
  if (ref.clip ? target !== "clipPath" : target !== "linearGradient" && target !== "radialGradient") fail();
 }
}
