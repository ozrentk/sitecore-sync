import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { admitVisual, exportVisual, protectedAttributes } from "./richTextAdmission";

import { literalMatches, validReplaceInput, validSearchInput, type Part, type SearchInput, type ReplaceInput, type SearchResult } from "./richTextSearchInput";
interface Match extends Part { parts: Part[] }
/** Visible text only. Blocks, breaks and opaque fragments are search boundaries. */
export function visualMatches(doc: PMNode, input: SearchInput): Match[] {
  if (!validSearchInput(input)) throw new Error("Enter 1–1,024 characters to find.");
  const matches: Match[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let text = ""; let segments: (Part & { offset: number })[] = [];
    const flush = () => {
      for (const match of literalMatches(text, input)) {
        const parts = segments.filter(segment => segment.offset < match.to && segment.offset + segment.to - segment.from > match.from)
          .map(segment => ({ from: segment.from + Math.max(0, match.from - segment.offset), to: segment.from + Math.min(segment.to - segment.from, match.to - segment.offset) }));
        matches.push({ from: parts[0].from, to: parts.at(-1)!.to, parts });
        if (matches.length > 1000) throw new Error("More than 1,000 matches. Narrow the search before continuing.");
      }
      text = ""; segments = [];
    };
    block.descendants((node, pos) => {
      if (node.isText) { const from = blockPos + 1 + pos; segments.push({ from, to: from + node.nodeSize, offset: text.length }); text += node.text; }
      else if (node.isLeaf) flush();
      return true;
    });
    flush(); return false;
  });
  return matches;
}
export function findVisual(state: EditorState, input: SearchInput): { transaction: Transaction; result: SearchResult } {
  const matches = visualMatches(state.doc, input);
  if (!matches.length) return { transaction: state.tr, result: { count: 0, index: 0, replaced: 0 } };
  const index = input.direction === "previous"
    ? matches.map((match, index) => match.to <= state.selection.from ? index : -1).reduce((last, index) => Math.max(last, index), -1)
    : matches.findIndex(match => match.from >= state.selection.to);
  const selected = index < 0 ? input.direction === "previous" ? matches.length - 1 : 0 : index;
  const match = matches[selected];
  return { transaction: state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)).scrollIntoView(), result: { count: matches.length, index: selected + 1, replaced: 0 } };
}
export function replaceVisual(state: EditorState, input: ReplaceInput): { transaction: Transaction; result: SearchResult } {
  if (!validReplaceInput(input)) throw new Error("Invalid replacement. Use at most 8,192 characters.");
  const matches = visualMatches(state.doc, input);
  const selected = input.all ? matches : matches.filter(match => match.from === state.selection.from && match.to === state.selection.to);
  if (!selected.length && !input.all) throw new Error("Find a match before replacing it. The selection may have changed.");
  if (selected.some(match => match.parts.some((part, index) => index > 0 && part.from !== match.parts[index - 1].to)))
    throw new Error("Replacement crosses a link or wrapper boundary. Narrow the search or edit HTML. Nothing was replaced.");
  const tr = state.tr;
  for (const match of [...selected].reverse()) for (let i = match.parts.length - 1; i >= 0; i--) {
    const part = match.parts[i]; tr.insertText(i === 0 ? input.replacement : "", part.from, part.to);
  }
  const before = exportVisual(state.doc.toJSON()); const after = exportVisual(tr.doc.toJSON());
  tr.doc.check();
  if (protectedAttributes(before) !== protectedAttributes(after) || JSON.stringify(admitVisual(before).opaque) !== JSON.stringify(admitVisual(after).opaque))
    throw new Error("Replacement would remove protected formatting or metadata. Narrow the selection or edit HTML.");
  const remaining = visualMatches(tr.doc, input);
  let index = -1;
  if (!input.all && remaining.length) {
    const resume = tr.mapping.map(selected[0].to, 1);
    index = remaining.findIndex(match => match.from >= resume);
    if (index < 0) index = 0;
    tr.setSelection(TextSelection.create(tr.doc, remaining[index].from, remaining[index].to));
  }
  return { transaction: tr.scrollIntoView(), result: { count: remaining.length, index: index + 1, replaced: selected.length } };
}
