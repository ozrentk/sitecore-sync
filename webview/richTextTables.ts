import { Extension, Node } from "@tiptap/core";
import { tableEditing } from "@tiptap/pm/tables";

const attrs = (tag: string) => () => ({ open: { default: "" }, close: { default: "" }, tag: { default: tag }, before: { default: "" }, tail: { default: "" } });
const roles: Record<string, string> = { tableGrid: "table", tableRow: "row", tableCell: "cell", tableHeader: "header_cell" };
export const tableExtensions = [
  Node.create({ name: "tableWrapper", group: "block", content: "tableShell", isolating: true, addAttributes: attrs("div"), renderHTML: () => ["div", { class: "rt-table-wrapper" }, 0] }),
  Node.create({ name: "tableShell", group: "block", content: "caption? colgroup* tableGrid+", isolating: true, addAttributes: attrs("table"), renderHTML: () => ["div", { class: "rt-table-shell" }, 0] }),
  Node.create({ name: "caption", content: "inline*", defining: true, addAttributes: attrs("caption"), renderHTML: () => ["div", { class: "rt-table-caption", "aria-label": "Table caption" }, 0] }),
  Node.create({ name: "colgroup", content: "col*", atom: true, selectable: false, addAttributes: attrs("colgroup"), renderHTML: () => ["div", { class: "rt-table-columns", contenteditable: "false" }, "Column definitions (edit in HTML)"] }),
  Node.create({ name: "col", atom: true, addAttributes: attrs("col"), renderHTML: () => ["span"] }),
  Node.create({ name: "tableGrid", content: "tableRow+", isolating: true, addAttributes: attrs("tbody"), renderHTML: ({ node }) => ["table", { "data-section": node.attrs.tag }, ["tbody", 0]] }),
  Node.create({ name: "tableRow", content: "(tableCell | tableHeader)+", addAttributes: attrs("tr"), renderHTML: () => ["tr", 0] }),
  ...[["tableCell", "td"], ["tableHeader", "th"]].map(([name, tag]) => Node.create({ name, content: "(cellText | paragraph | heading)+", isolating: true,
    addAttributes: () => ({ ...attrs(tag)(), colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } }),
    renderHTML: ({ node }) => [tag, { colspan: node.attrs.colspan, rowspan: node.attrs.rowspan }, 0] })),
  Node.create({ name: "cellText", content: "inline*", renderHTML: () => ["div", { class: "rt-cell-text" }, 0] }),
  Extension.create({ name: "tableBehavior", extendNodeSchema: extension => roles[extension.name] ? { tableRole: roles[extension.name] } : {},
    addProseMirrorPlugins: () => [tableEditing()] }),
];
