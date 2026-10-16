import { test } from "node:test";
import { strictEqual, throws, match } from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { tableCommand } from "../../src/editor/richTextTableCommands";
import { admitVisual, exportVisual } from "../../src/editor/richTextAdmission";
import { simpleTableHtml } from "../fixtures/richTextTables";

const attrs = { open: { default: "" }, close: { default: "" }, tag: { default: "" }, before: { default: "" }, tail: { default: "" } };
const schema = new Schema({ nodes: {
  doc: { content: "tableShell+" }, text: {}, cellText: { content: "text*" }, caption: { content: "text*", attrs },
  tableShell: { content: "caption? tableGrid+", attrs },
  tableGrid: { content: "tableRow+", tableRole: "table", attrs },
  tableRow: { content: "(tableCell | tableHeader)+", tableRole: "row", attrs },
  tableCell: { content: "cellText+", tableRole: "cell", attrs: { ...attrs, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
  tableHeader: { content: "cellText+", tableRole: "header_cell", attrs: { ...attrs, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
} });
function state(raw = simpleTableHtml): EditorState {
  const doc = schema.nodeFromJSON(admitVisual(raw).document);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 5) });
}
function apply(current: EditorState, name: string): EditorState { return current.apply(tableCommand(current, name)); }
const raw = (current: EditorState): string => exportVisual(current.doc.toJSON());

test("table commands insert rows and columns without changing populated content; delete rejects populated cells", () => {
  let current = state();
  throws(() => tableCommand(current, "deleteRow"), /populated/);
  throws(() => tableCommand(current, "deleteColumn"), /populated/);
  current = apply(current, "rowAfter");
  strictEqual(raw(current), '<table><tbody><tr><td>A</td><td></td></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></tbody></table>');
  current = apply(current, "columnAfter");
  strictEqual((raw(current).match(/<td>/gu) ?? []).length, 9);
  admitVisual(raw(current));
});

test("merge and split preserve content, and reject multiple populated cells or conflicting headers", () => {
  let current = state();
  current = current.apply(current.tr.setSelection(CellSelection.create(current.doc, 3, 8)));
  current = apply(current, "mergeCells");
  match(raw(current), /<td colspan="2">A<\/td>/);
  current = apply(current, "splitCell");
  strictEqual(raw(current), simpleTableHtml);
  const populated = state(simpleTableHtml.replace('<td></td>', '<td>B</td>'));
  throws(() => tableCommand(populated.apply(populated.tr.setSelection(CellSelection.create(populated.doc, 3, 8))), "mergeCells"), /at most one/);
  const header = state(simpleTableHtml.replace('<td></td>', '<th></th>'));
  throws(() => tableCommand(header.apply(header.tr.setSelection(CellSelection.create(header.doc, 3, 8))), "mergeCells"), /matching header/);
});

test("caption addition, metadata and section boundaries have explicit command policies", () => {
  const current = apply(state(), "caption");
  strictEqual(raw(current), simpleTableHtml.replace('<table>', '<table><caption></caption>'));
  throws(() => tableCommand(state(simpleTableHtml.replace('<td>A', '<td id="keep">A')), "rowAfter"), /metadata/);
  throws(() => tableCommand(state(simpleTableHtml.replace('</tbody>', '</tbody><tfoot><tr><td>X</td><td>Y</td></tr></tfoot>')), "columnAfter"), /multiple sections/);
});

test("empty row/column deletion and insertion before preserve the remaining grid", () => {
  let current = state(); let empty = 0;
  current.doc.descendants((node, pos) => { if (node.type.name === "tableCell" && !node.textContent) empty = pos + 2; });
  current = current.apply(current.tr.setSelection(TextSelection.create(current.doc, empty)));
  current = apply(current, "deleteRow");
  strictEqual(raw(current), '<table><tbody><tr><td>A</td><td></td></tr></tbody></table>');
  empty = 0; current.doc.descendants((node, pos) => { if (node.type.name === "tableCell" && !node.textContent) empty = pos + 2; });
  current = current.apply(current.tr.setSelection(TextSelection.create(current.doc, empty)));
  current = apply(current, "deleteColumn");
  strictEqual(raw(current), '<table><tbody><tr><td>A</td></tr></tbody></table>');
  current = apply(current, "rowBefore"); current = apply(current, "columnBefore");
  strictEqual(raw(current), '<table><tbody><tr><td></td><td></td></tr><tr><td></td><td>A</td></tr></tbody></table>');
});

test("rowspan split stays within its section and never duplicates cell content", () => {
  const original = '<table><tbody><tr><td rowspan="2">A</td><td></td></tr><tr><td></td></tr></tbody></table>';
  const current = apply(state(original), "splitCell");
  strictEqual(raw(current), simpleTableHtml);
  admitVisual(raw(current));
});
