import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction, Selection } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { exportVisual, protectedAttributes } from "./richTextAdmission";
import { changeRichLink, inspectRichLink, unlinkRichText, type RichLinkDestination, type RichLinkInfo } from "./richTextLinks";

export interface RichLinkSession { readonly doc: PMNode; readonly selection: Selection; readonly from: number; readonly to: number; readonly node?: PMNode; readonly info: RichLinkInfo }
export function beginRichLink(state: EditorState): RichLinkSession {
  const selection = state.selection;
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name !== "richLink") continue;
    const from = selection.$from.before(depth); const to = from + node.nodeSize;
    if (selection.to >= to) throw new Error("Select text within one link to edit it.");
    const info = inspectRichLink(String(node.attrs.open));
    let media = false; node.descendants(child => { if (child.type.name === "inlineImage") media = true; });
    return { doc: state.doc, selection, from, to, node, info: media ? { ...info, reason: "Image links are preserved. Edit their destination or remove them in HTML." } : info };
  }
  if (!(selection instanceof TextSelection) || selection.empty || !selection.$from.sameParent(selection.$to))
    throw new Error("Select text within one paragraph or whole inline wrappers to create a link, or place the cursor inside an existing link.");
  const slice = state.doc.slice(selection.from, selection.to);
  let unsupported = false; slice.content.descendants(node => { if (["richLink", "inlineImage"].includes(node.type.name)) unsupported = true; });
  if (slice.openStart || slice.openEnd || unsupported) throw new Error("This selection crosses a link, image or partial wrapper. Select text within one inline container, or whole wrappers.");
  return { doc: state.doc, selection, from: selection.from, to: selection.to, info: { kind: "url", href: "" } };
}

export function richLinkCommand(state: EditorState, session: RichLinkSession, destination: RichLinkDestination | "remove"): Transaction {
  if (state.doc !== session.doc || !state.selection.eq(session.selection)) throw new Error("The document or selection changed. Reopen Link before applying a destination.");
  if (session.info.reason) throw new Error(session.info.reason);
  const node = session.node;
  if (destination === "remove") {
    if (!node) throw new Error("Place the cursor inside an existing link to remove it.");
    const open = unlinkRichText(String(node.attrs.open));
    if (open) return state.tr.setNodeMarkup(session.from, state.schema.nodes.span, { ...node.attrs, open, close: "</span>", tag: "span" }, node.marks);
    const children: PMNode[] = [];
    node.forEach(child => {
      if (child.marks.some(mark => node.marks.some(parent => parent.type === mark.type))) throw new Error("Removing this link would merge repeated formatting wrappers. Use HTML.");
      children.push(child.mark([...node.marks, ...child.marks]));
    });
    return state.tr.replaceWith(session.from, session.to, Fragment.fromArray(children));
  }
  const open = changeRichLink(node ? String(node.attrs.open) : undefined, destination);
  if (node) return state.tr.setNodeMarkup(session.from, undefined, { ...node.attrs, open }, node.marks);
  const content = state.doc.slice(session.from, session.to).content;
  const link = state.schema.nodes.richLink.create({ open, close: "</a>", tag: "a" }, content);
  const transaction = state.tr.replaceWith(session.from, session.to, link);
  if (protectedAttributes(exportVisual(state.doc.toJSON()), false, true) !== protectedAttributes(exportVisual(transaction.doc.toJSON()), false, true))
    throw new Error("Creating this link would split protected formatting. Select the whole formatting wrapper or use HTML.");
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(session.from + 1)));
}
