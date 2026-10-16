import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";
import type { JSONContent } from "@tiptap/core";

export const visualLimit = 262144;
export interface VisualAdmission { readonly document: JSONContent; readonly signature: string; readonly opaque: readonly string[] }
const escapeText = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

// Only a single literal declaration is projected. All other CSS remains inert raw data.
export function safeTextAlignment(style: string): string | null {
  return /^\s*text-align\s*:\s*(left|right|center|justify|start|end)\s*;?\s*$/iu.exec(style)?.[1].toLowerCase() ?? null;
}

/** Source locations are checked before building a disposable visual projection. */
export function admitVisual(raw: string): VisualAdmission {
  if (raw.length > visualLimit) throw new Error("Visual editing is limited to 262,144 characters. Use HTML.");
  const errors: string[] = [];
  const root = parseFragment(raw, { sourceCodeLocationInfo: true, onParseError: error => errors.push(error.code) });
  if (errors.length) throw new Error("HTML requires parser repairs or has duplicate/invalid attributes. Use HTML.");
  let count = 0;
  const opaque: string[] = [];
  function children(parent: P.ParentNode, start: number, end: number, inline: boolean, marks: NonNullable<JSONContent["marks"]> = [], depth = 0): JSONContent[] {
    if (depth > 40) throw new Error("Markup is too deeply nested for Visual. Use HTML.");
    let cursor = start;
    const result: JSONContent[] = [];
    for (const child of parent.childNodes) {
      if (++count > 5000) throw new Error("Markup has too many nodes for Visual. Use HTML.");
      const location = child.sourceCodeLocation;
      if (!location || location.startOffset !== cursor) throw new Error("The HTML parser changed the source structure. Use HTML.");
      cursor = location.endOffset;
      if (child.nodeName === "#text") {
        const text = (child as P.TextNode).value;
        if (inline) { if (text) result.push({ type: "text", text, marks }); }
        else if (/^\s*$/u.test(text)) {
          const original = raw.slice(location.startOffset, location.endOffset); opaque.push(original);
          result.push({ type: "gap", attrs: { raw: original } });
        } else throw new Error("Top-level text needs an explicit paragraph. Use HTML.");
        continue;
      }
      if (!("tagName" in child)) throw new Error("Comments and declarations are HTML-only in this visual profile.");
      const tag = child.tagName;
      if (child.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new Error("Foreign markup is HTML-only.");
      if (child.attrs.some(a => /^(?:id|name|data-sc-.+|data-item-.+|on.+|srcdoc)$/iu.test(a.name)))
        throw new Error("Identity, managed references or active attributes require HTML editing.");
      const loc = child.sourceCodeLocation!;
      if (!loc.startTag || (!["img", "br"].includes(tag) && !loc.endTag)) throw new Error("Explicit opening and closing tags are required for Visual.");
      const attrs = { open: raw.slice(loc.startOffset, loc.startTag.endOffset), close: loc.endTag ? raw.slice(loc.endTag.startOffset, loc.endOffset) : "", tag,
        align: safeTextAlignment(child.attrs.find(attribute => attribute.name === "style")?.value ?? "") };
      if (tag === "img" || (tag === "style" && !inline)) {
        const original = raw.slice(loc.startOffset, loc.endOffset); opaque.push(original);
        result.push({ type: tag === "style" ? "stylesheet" : inline ? "inlineImage" : "blockImage", attrs: { raw: original }, marks });
      } else if (tag === "br" && inline) result.push({ type: "hardBreak", attrs, marks });
      else if (tag === "span" && inline) {
        result.push({ type: "span", attrs, marks,
          content: children(child, loc.startTag.endOffset, loc.endTag!.startOffset, true, [], depth + 1) });
      } else if (["strong", "b", "em", "i", "u"].includes(tag) && inline) {
        const type = ["strong", "b"].includes(tag) ? "bold" : ["em", "i"].includes(tag) ? "italic" : "underline";
        if (marks.some(mark => mark.type === type)) throw new Error("Repeated nested formatting is HTML-only.");
        result.push(...children(child, loc.startTag.endOffset, loc.endTag!.startOffset, true, [...marks, { type, attrs }], depth + 1));
      } else if (!inline && (tag === "p" || /^h[1-6]$/u.test(tag))) {
        result.push({ type: tag === "p" ? "paragraph" : "heading", attrs,
          content: children(child, loc.startTag.endOffset, loc.endTag!.startOffset, true, [], depth + 1) });
      } else throw new Error(`<${tag}> is outside the basic visual profile. Use HTML.`);
    }
    if (cursor !== end) throw new Error("Unrepresented source tokens would be lost. Use HTML.");
    return result;
  }
  const document: JSONContent = { type: "doc", content: children(root, 0, raw.length, false) };
  return { document, signature: htmlSignature(raw), opaque };
}

/** Compare actual HTML structure independently of the visual model. */
export function htmlSignature(raw: string): string {
  function describe(node: P.ChildNode): unknown {
    if (node.nodeName === "#text") return ["text", (node as P.TextNode).value];
    if (!("tagName" in node)) return [node.nodeName];
    return [node.tagName, node.attrs.map(a => [a.name, a.value]), node.childNodes.map(describe)];
  }
  return JSON.stringify(parseFragment(raw).childNodes.map(describe));
}

export function protectedAttributes(raw: string): string {
  const attributes: unknown[] = [];
  function visit(node: P.ChildNode, spanParents: unknown[] = []): void {
    if (!("tagName" in node)) return;
    const descriptor = [node.tagName, node.attrs.map(a => [a.name, a.value])];
    // Even an unstyled span is meaningful structure. Preserve nesting through commands.
    if (node.tagName === "span") attributes.push([descriptor, spanParents]);
    else if (node.attrs.length) attributes.push(descriptor);
    node.childNodes.forEach(child => visit(child, node.tagName === "span" ? [...spanParents, descriptor] : spanParents));
  }
  parseFragment(raw).childNodes.forEach(node => visit(node));
  return JSON.stringify(attributes);
}

export function exportVisual(node: JSONContent): string {
  let value: string;
  const content = (): string => exportChildren(node.content ?? []);
  if (node.type === "doc") return content();
  if (node.type === "text") value = escapeText(node.text ?? "");
  else if (["gap", "stylesheet", "inlineImage", "blockImage"].includes(node.type ?? "")) value = String(node.attrs?.raw ?? "");
  else {
    const tag = node.type === "heading" ? String(node.attrs?.tag ?? "h2") : node.type === "hardBreak" ? "br" : node.type === "span" ? "span" : "p";
    value = String(node.attrs?.open || `<${tag}>`) + content() + String(node.attrs?.close || (tag === "br" ? "" : `</${tag}>`));
  }
  return value;
}
// Adjacent text with the same mark shares one wrapper, as in the model's DOM serializer.
function exportChildren(nodes: JSONContent[]): string {
  let result = ""; let active: JSONContent[] = [];
  const close = (mark: JSONContent): string => String(mark.attrs?.close || `</${mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : "u"}>`);
  for (const node of nodes) {
    const next = node.marks ?? []; let common = 0;
    while (common < active.length && common < next.length && JSON.stringify(active[common]) === JSON.stringify(next[common])) common++;
    for (let i = active.length - 1; i >= common; i--) result += close(active[i]);
    for (const mark of next.slice(common)) result += String(mark.attrs?.open || `<${mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : "u"}>`);
    active = next; result += exportVisual(node);
  }
  for (const mark of [...active].reverse()) result += close(mark);
  return result;
}
