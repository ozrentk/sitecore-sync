import { richMarkNames } from "./richTextMarks";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, AllSelection, Selection, type Command, type Transaction } from "@tiptap/pm/state";
import { toggleMark, lift } from "@tiptap/pm/commands";
import { sinkListItem, liftListItem, splitListItem } from "@tiptap/pm/schema-list";
import { parseFragment } from "parse5";
import { admitVisual, exportVisual, protectedAttributes, safeTextAlignment } from "./richTextAdmission";
import type { JSONContent } from "@tiptap/core";

export const richCommands = ["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bold", "italic", "underline", "strike", "subscript", "superscript", "horizontalRule", "bulletList", "orderedList", "indent", "outdent", "blockquote", "alignLeft", "alignCenter", "alignRight", "alignJustify", "clearFormatting", "splitListItem"] as const;
const marks = richMarkNames;
const listNames = ["bulletList", "orderedList"];
function ancestor(state: EditorState, names: readonly string[]): { node: PMNode; pos: number; depth: number } | undefined {
  for (let depth = state.selection.$from.depth; depth > 0; depth--) {
    const node = state.selection.$from.node(depth);
    if (names.includes(node.type.name)) return { node, pos: state.selection.$from.before(depth), depth };
  }
  return undefined;
}
export function activeRichCommand(state: EditorState, name: string): boolean {
  if (marks.includes(name)) {
    if (!state.selection.empty) {
      let found = false; let every = true;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (!node.isText) return;
        found = true; let active = node.marks.some(mark => mark.type.name === name);
        const path = state.doc.resolve(pos);
        for (let d = path.depth; d > 0; d--) active ||= path.node(d).marks.some(mark => mark.type.name === name);
        every &&= active;
      });
      return found && every;
    }
    if ((state.storedMarks ?? state.selection.$from.marks()).some(mark => mark.type.name === name)) return true;
    for (let d = state.selection.$from.depth; d > 0; d--) if (state.selection.$from.node(d).marks.some(mark => mark.type.name === name)) return true;
    return false;
  }
  if (name.startsWith("align")) {
    try { return selectedBlocks(state).every(({ node }) => node.attrs.align === name.slice(5).toLowerCase()); }
    catch { return false; }
  }
  if (name === "paragraph" || /^h[1-6]$/u.test(name)) {
    try { return selectedBlocks(state).every(({ node }) => name === "paragraph" ? ["paragraph", "listText"].includes(node.type.name) : node.attrs.tag === name); }
    catch { return false; }
  }
  return Boolean(ancestor(state, [name]));
}
function selectedBlocks(state: EditorState): { node: PMNode; pos: number }[] {
  const result: { node: PMNode; pos: number }[] = [];
  if (state.selection.empty) { const block = ancestor(state, ["paragraph", "heading", "listText", "cellText", "caption"]); if (block) result.push(block); }
  else state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => { if (node.isTextblock) { result.push({ node, pos }); return false; } return true; });
  if (!result.length || result.some(({ node }) => !["paragraph", "heading", "listText"].includes(node.type.name))) throw new Error("Select paragraph, heading or list text. Inline table cells and captions retain their original structure; use HTML for block styling.");
  return result;
}
function blockToken(open: string, tag: string, alignment?: string): string {
  const retagged = open ? open.replace(/^<[a-z\d]+/iu, `<${tag}`) : `<${tag}>`;
  if (alignment === undefined) return retagged;
  const node = parseFragment(retagged + `</${tag}>`, { sourceCodeLocationInfo: true }).childNodes[0];
  if (!node || !("tagName" in node)) throw new Error("Unrecognized block token. Use HTML.");
  const style = node.attrs.find(attr => attr.name === "style");
  if (style && !safeTextAlignment(style.value)) throw new Error("This block has other or unrecognized CSS. Edit alignment in HTML to preserve it.");
  const value = `style="text-align: ${alignment};"`;
  if (!style) return retagged.replace(/>$/u, ` ${value}>`);
  const location = node.sourceCodeLocation!.attrs!.style;
  return retagged.slice(0, location.startOffset) + value + retagged.slice(location.endOffset);
}
function apply(tr: Transaction, state: EditorState, command: Command): void {
  const current = EditorState.create({ schema: state.schema, doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks });
  let result: Transaction | undefined;
  if (!command(current, candidate => { result = candidate; }) || !result) throw new Error("This command is unavailable for the current selection.");
  for (const step of result.steps) tr.step(step);
  tr.setSelection(Selection.fromJSON(tr.doc, result.selection.toJSON())); tr.setStoredMarks(result.storedMarks);
}
function indentToken(open: string, direction: number): string {
  const token = open || "<p>";
  const node = parseFragment(token + "</p>", { sourceCodeLocationInfo: true }).childNodes[0];
  if (!node || !("tagName" in node)) throw new Error("Unrecognized block token.");
  const style = node.attrs.find(attr => attr.name === "style");
  if (/["'()\\]/u.test(style?.value ?? "")) throw new Error("Complex CSS values require HTML editing to preserve their syntax.");
  const declarations = (style?.value ?? "").split(";").map(part => part.trim()).filter(Boolean);
  if (declarations.some(part => /^margin\s*:/iu.test(part)) || /\/\*|\*\//u.test(style?.value ?? "")) throw new Error("Edit shorthand or commented margins in HTML first.");
  const margins = declarations.filter(part => /^margin-left\s*:/iu.test(part));
  if (margins.length > 1 || margins.some(part => !/^margin-left\s*:\s*(?:0|\d+px)\s*$/iu.test(part))) throw new Error("Indent supports a single nonnegative pixel margin-left. Edit other margin units in HTML.");
  const previous = margins.length ? Number(margins[0].match(/:\s*(\d+)/u)![1]) : 0;
  const next = Math.max(0, previous + direction * 40);
  if (next === previous) return token;
  if (next > 10240) throw new Error("Maximum paragraph indentation reached.");
  const rest = declarations.filter(part => !/^margin-left\s*:/iu.test(part));
  if (next) rest.push(`margin-left: ${next}px`);
  const value = rest.length ? `style="${(rest.join("; ") + ";").replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")}"` : "";
  if (!style) return token.replace(/>$/u, ` ${value}>`);
  const location = node.sourceCodeLocation!.attrs!.style;
  return (token.slice(0, location.startOffset) + value + token.slice(location.endOffset)).replace(/\s+>$/u, ">");
}
/** Construct one bounded, preflighted operation; callers authorize only this exact transaction. */
export function richTextCommand(state: EditorState, name: string, availabilityOnly = false): Transaction {
  if (!richCommands.includes(name as typeof richCommands[number])) throw new Error("Unknown Rich Text command.");
  if (state.selection instanceof AllSelection) {
    let from: number | undefined; let to: number | undefined;
    state.doc.descendants((node, pos) => { if (node.isTextblock) { from ??= pos + 1; to = pos + node.nodeSize - 1; } });
    if (from === undefined || to === undefined) throw new Error("No text blocks are available for this command.");
    return richTextCommand(EditorState.create({ schema: state.schema, doc: state.doc, selection: TextSelection.create(state.doc, from, to) }), name, availabilityOnly);
  }
  if (!(state.selection instanceof TextSelection)) throw new Error("Select text or place the cursor in a text block first.");
  const tr = state.tr;
  let structural = false; let semanticBlockEdit = false;
  if (name === "horizontalRule") {
    if (!state.selection.empty || state.selection.$from.depth !== 1 || !["paragraph", "heading"].includes(state.selection.$from.parent.type.name)) throw new Error("Place the cursor in a top-level paragraph or heading. The rule is inserted after that block.");
    const position = state.selection.$from.after(1);
    tr.insert(position, [state.schema.nodes.horizontalRule.create(), state.schema.nodes.paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, position + 2));
  } else if (["indent", "outdent"].includes(name) && !ancestor(state, ["listItem"])) {
    for (const { node, pos } of selectedBlocks(state)) {
      if (!["paragraph", "heading"].includes(node.type.name)) throw new Error("Select paragraphs or headings to indent.");
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: indentToken(node.attrs.open || `<${node.attrs.tag || "p"}>`, name === "indent" ? 1 : -1) });
    }
    if (tr.doc.eq(state.doc)) throw new Error("The selected paragraphs are already at the left margin.");
    semanticBlockEdit = true;
  } else if (name === "paragraph" || /^h[1-6]$/u.test(name) || name.startsWith("align")) {
    for (const { node, pos } of selectedBlocks(state)) {
      const alignment = name.startsWith("align") ? name.slice(5).toLowerCase() : undefined;
      const tag = alignment ? node.type.name === "heading" ? String(node.attrs.tag) : "p" : name === "paragraph" ? "p" : name;
      if (node.type.name !== "listText" && (alignment ? node.attrs.align === alignment : node.attrs.tag === tag)) continue;
      const open = blockToken(String(node.attrs.open ?? ""), tag, alignment);
      tr.setNodeMarkup(pos, tag === "p" ? state.schema.nodes.paragraph : state.schema.nodes.heading,
        { ...node.attrs, open, close: `</${tag}>`, tag, ...(alignment ? { align: alignment } : {}) });
    }
    semanticBlockEdit = true;
  } else if (marks.includes(name) || name === "clearFormatting") {
    const opposite = name === "subscript" ? "superscript" : name === "superscript" ? "subscript" : undefined;
    const affected = name === "clearFormatting" ? marks : opposite ? [name, opposite] : [name];
    for (let d = state.selection.$from.depth; d > 0; d--) if (state.selection.$from.node(d).marks.some(mark => affected.includes(mark.type.name)))
      throw new Error("Formatting belongs to an enclosing inline wrapper. Select the whole wrapper or edit HTML.");
    if (name === "clearFormatting") {
      for (const mark of marks) { tr.removeMark(state.selection.from, state.selection.to, state.schema.marks[mark]); tr.removeStoredMark(state.schema.marks[mark]); }
    } else {
      if (opposite && !activeRichCommand(state, name)) { tr.removeMark(state.selection.from, state.selection.to, state.schema.marks[opposite]); tr.removeStoredMark(state.schema.marks[opposite]); }
      apply(tr, state, toggleMark(state.schema.marks[name]));
    }
  } else {
    structural = true;
    const list = ancestor(state, listNames);
    if (listNames.includes(name) && list && list.node.type.name !== name) {
      if (!/^<(?:ol|ul)\s*>$/iu.test(list.node.attrs.open || "<ul>")) throw new Error("Changing this list type would reinterpret its metadata. Use HTML.");
      const tag = name === "orderedList" ? "ol" : "ul";
      tr.setNodeMarkup(list.pos, state.schema.nodes[name], { ...list.node.attrs, tag, open: `<${tag}>`, close: `</${tag}>` });
    } else if (name === "outdent" || (list && name === list.node.type.name)) {
      if (!list) throw new Error("Indent and outdent apply to list items. Place the cursor in a list first.");
      // Inline LI text needs an explicit paragraph only when the user lifts it out of the list.
      for (const { node, pos } of selectedBlocks(state)) if (node.type.name === "listText") tr.setNodeMarkup(pos, state.schema.nodes.paragraph, { ...node.attrs, tag: "p", open: "<p>", close: "</p>" });
      apply(tr, state, liftListItem(state.schema.nodes.listItem));
    } else if (name === "indent") {
      if (!list) throw new Error("Indent and outdent apply to list items. Place the cursor in a list first.");
      apply(tr, state, sinkListItem(state.schema.nodes.listItem));
    } else if (name === "splitListItem") {
      if (!list || !state.selection.empty) throw new Error("Place the cursor in one list item before splitting it.");
      apply(tr, state, splitListItem(state.schema.nodes.listItem));
    } else if (listNames.includes(name)) {
      selectedBlocks(state);
      const range = state.selection.$from.blockRange(state.selection.$to);
      if (!range) throw new Error("Select adjacent text blocks to create a list.");
      if (!["doc", "blockquote"].includes(range.parent.type.name)) throw new Error("Create lists in document or quote paragraphs. Lists inside table cells require HTML.");
      const items: PMNode[] = [];
      let prefix = ""; let gapSize = 0;
      for (let index = range.startIndex; index < range.endIndex; index++) {
        const child = range.parent.child(index);
        if (child.type.name === "gap" && /^\s*$/u.test(child.attrs.raw)) { prefix += String(child.attrs.raw); gapSize += child.nodeSize; continue; }
        if (!["paragraph", "heading"].includes(child.type.name)) throw new Error("Select adjacent paragraphs or headings without other structures to create a list.");
        items.push(state.schema.nodes.listItem.create({ before: prefix }, child)); prefix = "";
      }
      tr.replaceWith(range.start, range.end, state.schema.nodes[name].create({ tail: prefix }, items));
      tr.setSelection(TextSelection.create(tr.doc, state.selection.from + 2, state.selection.to + 2 * items.length - gapSize));
    } else if (name === "blockquote") {
      selectedBlocks(state);
      const quote = ancestor(state, ["blockquote"]);
      if (quote && quote.depth !== state.selection.$from.depth - 1) throw new Error("Select text directly inside the quote to remove its wrapper.");
      if (quote) apply(tr, state, lift);
      else {
        const range = state.selection.$from.blockRange(state.selection.$to);
        if (!range || range.parent.type.name !== "doc") throw new Error("Create a quote from document paragraphs. Nested list/cell quote changes require HTML.");
        const children: PMNode[] = []; let prefix = ""; let gapSize = 0;
        for (let index = range.startIndex; index < range.endIndex; index++) {
          const child = range.parent.child(index);
          if (child.type.name === "gap" && /^\s*$/u.test(child.attrs.raw)) { prefix += String(child.attrs.raw); gapSize += child.nodeSize; continue; }
          if (!["paragraph", "heading", ...listNames, "blockquote"].includes(child.type.name)) throw new Error("Quotes support paragraphs, headings and lists; other structures require HTML.");
          children.push(child.type.create({ ...child.attrs, before: prefix + String(child.attrs.before ?? "") }, child.content, child.marks)); prefix = "";
        }
        tr.replaceWith(range.start, range.end, state.schema.nodes.blockquote.create({ tail: prefix }, children));
        tr.setSelection(TextSelection.create(tr.doc, state.selection.from + 1, state.selection.to + 1 - gapSize));
      }
    }
  }
  // Availability inspects the same structure/metadata using disposable text placeholders.
  // Never serialize this projection into a draft; actual commands validate full text again.
  const inspect = (doc: PMNode): string => {
    const json = doc.toJSON() as JSONContent;
    function compact(node: JSONContent): void { if (node.type === "text") node.text = "x"; node.content?.forEach(compact); }
    if (availabilityOnly) compact(json);
    return exportVisual(json);
  };
  const before = inspect(state.doc); const after = inspect(tr.doc);
  if (state.doc.textContent !== tr.doc.textContent) throw new Error("This command would discard text. Use HTML.");
  if (!semanticBlockEdit && protectedAttributes(before, false, false, structural) !== protectedAttributes(after, false, false, structural))
    throw new Error("This command would remove or duplicate protected formatting, links or structural metadata. Use HTML.");
  tr.doc.check(); admitVisual(after);
  return tr.scrollIntoView();
}
