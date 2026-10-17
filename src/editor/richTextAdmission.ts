import { richMarkTags, richMarkType } from "./richTextMarks";
import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";
import type { JSONContent } from "@tiptap/core";
import { inspectRichLink } from "./richTextLinks";

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
  const identities = new Set<string>();
  function children(parent: P.ParentNode, start: number, end: number, inline: boolean, marks: NonNullable<JSONContent["marks"]> = [], depth = 0, sourceNodes = parent.childNodes): JSONContent[] {
    if (depth > 40) throw new Error("Markup is too deeply nested for Visual. Use HTML.");
    let cursor = start;
    const result: JSONContent[] = [];
    for (const child of sourceNodes) {
      if (++count > 5000) throw new Error("Markup has too many nodes for Visual. Use HTML.");
      const location = child.sourceCodeLocation;
      if (!location || location.startOffset !== cursor) throw new Error("The HTML parser changed the source structure. Use HTML.");
      cursor = location.endOffset;
      if (child.nodeName === "#text") {
        const text = (child as P.TextNode).value;
        if (inline) { if (text) result.push({ type: "text", text, marks }); }
        else if (/^\s*$/u.test(text)) {
          const original = raw.slice(location.startOffset, location.endOffset);
          if (!("tagName" in parent) || !["div", "table", "thead", "tbody", "tfoot", "tr", "colgroup", "ul", "ol", "li", "blockquote"].includes(parent.tagName)) opaque.push(original);
          result.push({ type: "gap", attrs: { raw: original } });
        } else throw new Error("Top-level text needs an explicit paragraph. Use HTML.");
        continue;
      }
      if (!("tagName" in child)) throw new Error("Comments and declarations are HTML-only in this visual profile.");
      const tag = child.tagName;
      const tableTags = ["table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col"];
      const tableElement = tableTags.includes(tag) || tag === "div";
      if (child.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new Error("Foreign markup is HTML-only.");
      if (child.attrs.some(a => /^(?:on.+|srcdoc)$/iu.test(a.name) || (tag !== "a" && (/^(?:name|data-sc-.+|data-item-.+)$/iu.test(a.name) || (a.name === "id" && !tableElement)))))
        throw new Error("Identity, managed references or active attributes require HTML editing.");
      const identity = child.attrs.find(a => a.name === "id")?.value;
      if (identity !== undefined) {
        if (!identity || identities.has(identity)) throw new Error("Table identities must be nonempty and unique. Use HTML.");
        identities.add(identity);
      }
      const loc = child.sourceCodeLocation!;
      if (!loc.startTag || (!["img", "br", "col", "hr"].includes(tag) && !loc.endTag)) throw new Error("Explicit opening and closing tags are required for Visual (including table sections). Use HTML.");
      const attrs = { open: raw.slice(loc.startOffset, loc.startTag.endOffset), close: loc.endTag ? raw.slice(loc.endTag.startOffset, loc.endOffset) : "", tag,
        align: safeTextAlignment(child.attrs.find(attribute => attribute.name === "style")?.value ?? "") };
      if (!inline && ["ul", "ol", "li", "blockquote"].includes(tag)) {
        const parentTag = "tagName" in parent ? parent.tagName : "";
        if (tag === "li" && !["ul", "ol"].includes(parentTag)) throw new Error("List items require an explicit list. Use HTML.");
        let content: JSONContent[];
        const extra: Record<string, unknown> = {};
        if (tag === "li" && !child.childNodes.some(node => "tagName" in node && /^(?:p|h[1-6])$/u.test(node.tagName))) {
          const nested = child.childNodes.findIndex(node => "tagName" in node && ["ul", "ol"].includes(node.tagName));
          const boundary = nested < 0 ? loc.endTag!.startOffset : child.childNodes[nested].sourceCodeLocation!.startOffset;
          const text = children(child, loc.startTag.endOffset, boundary, true, [], depth + 1, nested < 0 ? child.childNodes : child.childNodes.slice(0, nested));
          content = [{ type: "listText", content: text }, ...(nested < 0 ? [] : children(child, boundary, loc.endTag!.startOffset, false, [], depth + 1, child.childNodes.slice(nested)))];
        } else content = children(child, loc.startTag.endOffset, loc.endTag!.startOffset, false, [], depth + 1);
        let prefix = "";
        content = content.filter(node => {
          if (node.type === "gap") { prefix += String(node.attrs?.raw ?? ""); return false; }
          node.attrs = { ...node.attrs, before: prefix }; prefix = ""; return true;
        });
        extra.tail = prefix;
        const lists = ["bulletList", "orderedList"];
        if (["ul", "ol"].includes(tag) && (!content.length || content.some(node => node.type !== "listItem"))) throw new Error("Lists require explicit list items. Use HTML.");
        if (tag === "li" && (!content.length || !["paragraph", "heading", "listText"].includes(content[0].type!) || content.slice(1).some(node => !lists.includes(node.type!))))
          throw new Error("A list item supports one text block followed by nested lists. Use HTML for mixed blocks.");
        if (tag === "blockquote" && (!content.length || content.some(node => !["paragraph", "heading", ...lists, "blockquote"].includes(node.type!)))) throw new Error("Blockquotes support paragraphs, headings and lists. Use HTML for other content.");
        if (tag === "ol") {
          const start = child.attrs.find(a => a.name === "start")?.value ?? "1";
          if (!/^-?\d{1,6}$/u.test(start)) throw new Error("Unsupported ordered-list start. Use HTML.");
          extra.order = Number(start); extra.reversed = child.attrs.some(a => a.name === "reversed");
        }
        result.push({ type: tag === "ul" ? "bulletList" : tag === "ol" ? "orderedList" : tag === "li" ? "listItem" : "blockquote", attrs: { ...attrs, ...extra }, content });
      } else if (!inline && tableElement) {
        const parentTag = "tagName" in parent ? parent.tagName : "";
        const allowed: Record<string, string[]> = { table: ["caption", "colgroup", "thead", "tbody", "tfoot"], thead: ["tr"], tbody: ["tr"], tfoot: ["tr"], tr: ["td", "th"], colgroup: ["col"], div: ["table"] };
        if (tableTags.includes(tag) && tag !== "table" && !allowed[parentTag]?.includes(tag)) throw new Error(`Unexpected table element <${tag}>. Use HTML.`);
        if (tag === "table" && !["", "div"].includes(parentTag)) throw new Error("Nested tables are HTML-only.");
        if (tag === "div" && (parentTag !== "" || child.childNodes.filter(n => n.nodeName !== "#text").some(n => !("tagName" in n) || n.tagName !== "table")))
          throw new Error("Only a top-level wrapper containing one table is supported. Use HTML.");
        const cell = tag === "td" || tag === "th";
        const inlineCell = cell && !child.childNodes.some(n => "tagName" in n && ["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(n.tagName));
        const type = tag === "div" ? "tableWrapper" : tag === "table" ? "tableShell" : ["thead", "tbody", "tfoot"].includes(tag) ? "tableGrid" : tag === "tr" ? "tableRow" : cell ? tag === "th" ? "tableHeader" : "tableCell" : tag;
        let content = tag === "col" ? [] : children(child, loc.startTag.endOffset, loc.endTag!.startOffset, inlineCell || tag === "caption", [], depth + 1);
        const extra: Record<string, unknown> = {};
        if (cell) {
          for (const key of ["colspan", "rowspan"]) {
            const value = child.attrs.find(a => a.name === key)?.value ?? "1";
            if (!/^[1-9]\d*$/u.test(value) || Number(value) > 100) throw new Error("Table spans must be between 1 and 100. Use HTML.");
            extra[key] = Number(value);
          }
          if (inlineCell) content = [{ type: "cellText", content }];
        } else if (tag !== "caption" && tag !== "col") {
          let prefix = "";
          content = content.filter(node => {
            if (node.type === "gap") { prefix += String(node.attrs?.raw ?? ""); return false; }
            node.attrs = { ...node.attrs, before: prefix }; prefix = ""; return true;
          });
          extra.tail = prefix;
          if (content.some(node => !allowed[tag]?.includes(String(node.attrs?.tag)))) throw new Error(`Unsupported content inside <${tag}>. Use HTML.`);
          if (tag === "div" && content.length !== 1) throw new Error("A table wrapper must contain exactly one table. Use HTML.");
        }
        result.push({ type, attrs: { ...attrs, ...extra }, content });
      } else if (tag === "img" || (tag === "style" && !inline)) {
        const original = raw.slice(loc.startOffset, loc.endOffset); opaque.push(original);
        result.push({ type: tag === "style" ? "stylesheet" : inline ? "inlineImage" : "blockImage", attrs: { raw: original }, marks });
      } else if (tag === "a" && inline) {
        inspectRichLink(attrs.open);
        result.push({ type: "richLink", attrs, marks,
          content: children(child, loc.startTag.endOffset, loc.endTag!.startOffset, true, [], depth + 1) });
      } else if (tag === "hr" && !inline && !("tagName" in parent)) result.push({ type: "horizontalRule", attrs });
      else if (tag === "br" && inline) result.push({ type: "hardBreak", attrs, marks });
      else if (tag === "span" && inline) {
        result.push({ type: "span", attrs, marks,
          content: children(child, loc.startTag.endOffset, loc.endTag!.startOffset, true, [], depth + 1) });
      } else if (richMarkType(tag) && inline) {
        const type = richMarkType(tag)!;
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
  validateTableGrids(document);
  return { document, signature: htmlSignature(raw), opaque };
}

function validateTableGrids(node: JSONContent): void {
  if (node.type === "tableGrid") {
    const rows = node.content ?? []; const occupied: boolean[][] = rows.map(() => []);
    if (!rows.length || rows.length > 100) throw new Error("Table sections require 1–100 rows. Use HTML.");
    rows.forEach((row, y) => {
      let x = 0;
      for (const cell of row.content ?? []) {
        while (occupied[y][x]) x++;
        const width = Number(cell.attrs?.colspan ?? 1); const height = Number(cell.attrs?.rowspan ?? 1);
        if (x + width > 100 || y + height > rows.length) throw new Error("Table spans cross a section boundary or exceed the grid limit. Use HTML.");
        for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
          if (occupied[y + dy][x + dx]) throw new Error("Overlapping table cells are HTML-only.");
          occupied[y + dy][x + dx] = true;
        }
        x += width;
      }
    });
    const width = occupied[0].length;
    if (!width || occupied.some(row => row.length !== width || Array.from({ length: width }, (_, x) => row[x]).some(value => !value)))
      throw new Error("Ragged table sections are HTML-only; no cells were repaired.");
  }
  node.content?.forEach(validateTableGrids);
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

export function protectedAttributes(raw: string, structuralTableEdit = false, ignoreLinks = false, structuralBlocks = false): string {
  const attributes: unknown[] = [];
  function visit(node: P.ChildNode, spanParents: unknown[] = []): void {
    if (!("tagName" in node)) return;
    if (ignoreLinks && node.tagName === "a") { node.childNodes.forEach(child => visit(child, spanParents)); return; }
    const retained = node.attrs.filter(a => !(structuralTableEdit && ["td", "th"].includes(node.tagName) && ["colspan", "rowspan"].includes(a.name)));
    const descriptor = [node.tagName, retained.map(a => [a.name, a.value])];
    // Even an unstyled span is meaningful structure. Preserve nesting through commands.
    if (node.tagName === "span") attributes.push([descriptor, spanParents]);
    else if (node.tagName === "a" || retained.length || (!structuralBlocks && ["ul", "ol", "li", "blockquote"].includes(node.tagName)) || (!structuralTableEdit && ["table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col"].includes(node.tagName))) attributes.push(descriptor);
    node.childNodes.forEach(child => visit(child, node.tagName === "span" ? [...spanParents, descriptor] : spanParents));
  }
  parseFragment(raw).childNodes.forEach(node => visit(node));
  return JSON.stringify(attributes);
}

export function exportVisual(node: JSONContent): string {
  if (["tableCell", "tableHeader"].includes(node.type ?? "") && node.content?.some(child => child.type === "cellText") && node.content.length !== 1)
    throw new Error("Splitting originally inline cell content would invent paragraph wrappers. Use Shift+Enter for a line break, or edit HTML.");
  let value: string;
  const content = (): string => exportChildren(node.content ?? []);
  if (node.type === "doc") return content();
  if (node.type === "cellText" || node.type === "listText") return String(node.attrs?.before ?? "") + content();
  if (node.type === "text") value = escapeText(node.text ?? "");
  else if (["gap", "stylesheet", "inlineImage", "blockImage"].includes(node.type ?? "")) value = String(node.attrs?.raw ?? "");
  else {
    const tableTypes: Record<string, string> = { tableWrapper: "div", tableShell: "table", tableGrid: "tbody", tableRow: "tr", tableCell: "td", tableHeader: "th", caption: "caption", colgroup: "colgroup", col: "col", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote" };
    const tag = tableTypes[node.type ?? ""] ? String(node.attrs?.tag || tableTypes[node.type!]) : node.type === "heading" ? String(node.attrs?.tag ?? "h2") : node.type === "horizontalRule" ? "hr" : node.type === "hardBreak" ? "br" : node.type === "span" ? "span" : node.type === "richLink" ? "a" : "p";
    let open = String(node.attrs?.open || `<${tag}>`);
    if (node.type === "tableCell" || node.type === "tableHeader") {
      for (const key of ["colspan", "rowspan"]) {
        const pattern = new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
        const match = pattern.exec(open); const old = match ? Number(match[1] ?? match[2] ?? match[3]) : 1;
        const next = Number(node.attrs?.[key] ?? 1);
        if (old !== next) { open = open.replace(pattern, ""); if (next !== 1) open = open.replace(/>$/u, ` ${key}="${next}">`); }
      }
    }
    value = String(node.attrs?.before ?? "") + open + content() + String(node.attrs?.tail ?? "") + String(node.attrs?.close || (["br", "col", "hr"].includes(tag) ? "" : `</${tag}>`));
  }
  return value;
}
// Adjacent text with the same mark shares one wrapper, as in the model's DOM serializer.
function exportChildren(nodes: JSONContent[]): string {
  let result = ""; let active: JSONContent[] = [];
  const close = (mark: JSONContent): string => String(mark.attrs?.close || `</${richMarkTags[mark.type ?? ""]}>`);
  for (const node of nodes) {
    const next = node.marks ?? []; let common = 0;
    while (common < active.length && common < next.length && JSON.stringify(active[common]) === JSON.stringify(next[common])) common++;
    for (let i = active.length - 1; i >= common; i--) result += close(active[i]);
    for (const mark of next.slice(common)) result += String(mark.attrs?.open || `<${richMarkTags[mark.type ?? ""]}>`);
    active = next; result += exportVisual(node);
  }
  for (const mark of [...active].reverse()) result += close(mark);
  return result;
}
