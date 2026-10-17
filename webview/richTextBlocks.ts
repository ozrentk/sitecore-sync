import { Node } from "@tiptap/core";

const attrs = (tag: string) => () => ({ open: { default: "" }, close: { default: "" }, tag: { default: tag }, before: { default: "" }, tail: { default: "" }, align: { default: null } });
export const blockExtensions = [
  Node.create({ name: "bulletList", group: "block", content: "listItem+", addAttributes: attrs("ul"), renderHTML: () => ["ul", 0] }),
  Node.create({ name: "orderedList", group: "block", content: "listItem+",
    addAttributes: () => ({ ...attrs("ol")(), order: { default: 1 }, reversed: { default: false } }),
    renderHTML: ({ node }) => ["ol", { start: node.attrs.order, ...(node.attrs.reversed ? { reversed: "" } : {}) }, 0] }),
  Node.create({ name: "listItem", content: "(paragraph | heading | listText) (bulletList | orderedList)*", defining: true,
    addAttributes: attrs("li"), renderHTML: () => ["li", 0] }),
  Node.create({ name: "listText", content: "inline*", addAttributes: attrs(""), renderHTML: () => ["div", { class: "rt-list-text" }, 0] }),
  Node.create({ name: "blockquote", group: "block", content: "(paragraph | heading | bulletList | orderedList | blockquote)+", defining: true,
    addAttributes: attrs("blockquote"), renderHTML: () => ["blockquote", 0] }),
];
