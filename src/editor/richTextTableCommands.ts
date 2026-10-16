import type { EditorState, Transaction, Command } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn, mergeCells, splitCell, selectedRect, isInTable } from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";
import { exportVisual } from "./richTextAdmission";

const commands: Record<string, Command> = { rowBefore: addRowBefore, rowAfter: addRowAfter, columnBefore: addColumnBefore, columnAfter: addColumnAfter, deleteRow, deleteColumn, mergeCells, splitCell };
const nonemptyCells = (grid: PMNode): string[] => {
  const result: string[] = [];
  grid.forEach(row => row.forEach(cell => {
    const raw = exportVisual({ type: "doc", content: cell.toJSON().content });
    if (raw) result.push(raw);
  }));
  return result;
};

/** Build one preflighted transaction; the caller authorizes only this exact object. */
export function tableCommand(state: EditorState, name: string): Transaction {
  if (name === "insertTable") {
    if (!state.selection.empty) throw new Error("Place the cursor without selecting content before inserting a table. Existing content will be preserved.");
    const nodes = state.schema.nodes;
    const cell = () => nodes.tableCell.create(null, nodes.cellText.create());
    const row = () => nodes.tableRow.create(null, [cell(), cell()]);
    const table = nodes.tableShell.create(null, nodes.tableGrid.create(null, [row(), row()]));
    // Insert after the containing top-level block; never split a protected wrapper or nest a table.
    const position = state.selection.$from.depth ? state.selection.$from.after(1) : state.selection.from;
    const transaction = state.tr.insert(position, table);
    return transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 1))).scrollIntoView();
  }
  let shellDepth = state.selection.$from.depth;
  while (shellDepth > 0 && state.selection.$from.node(shellDepth).type.name !== "tableShell") shellDepth--;
  if (!shellDepth) throw new Error("Choose Insert table to create a table, or place the cursor inside an existing table first.");
  const shell = state.selection.$from.node(shellDepth);
  if (name === "caption") {
    const position = state.selection.$from.start(shellDepth);
    const tr = state.tr;
    if (shell.firstChild?.type.name !== "caption") tr.insert(position, state.schema.nodes.caption.create());
    return tr.setSelection(TextSelection.create(tr.doc, position + 1));
  }
  if (!commands[name] || !isInTable(state)) throw new Error("Select cells in one table section first.");
  const rect = selectedRect(state);
  const grid = rect.table;
  let grids = 0; let columns = false;
  shell.forEach(node => { if (node.type.name === "tableGrid") grids++; if (node.type.name === "colgroup") columns = true; });
  if ((name.includes("Column") || name.startsWith("column")) && (grids !== 1 || columns))
    throw new Error("Column operations on tables with multiple sections or column definitions require HTML editing.");
  let protectedCells = false;
  grid.forEach(row => {
    if (!/^<tr\s*>$/iu.test(row.attrs.open || "<tr>")) protectedCells = true;
    row.forEach(cell => {
      const open = String(cell.attrs.open || `<${cell.type.name === "tableHeader" ? "th" : "td"}>`).replace(/\s(?:colspan|rowspan)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "");
      if (!/^<(?:td|th)\s*>$/iu.test(open)) protectedCells = true;
    });
  });
  if (protectedCells) throw new Error("Rows or cells have IDs, scope, styles or other metadata. Structural changes require HTML; cell text remains editable.");
  if (name === "mergeCells") {
    const tags = new Set<string>(); let populated = 0;
    for (const pos of rect.map.cellsInRect(rect)) {
      const cell = grid.nodeAt(pos)!; tags.add(cell.type.name);
      if (exportVisual({ type: "doc", content: cell.toJSON().content })) populated++;
    }
    if (tags.size > 1 || populated > 1) throw new Error("Merge requires matching header/cell types and at most one populated cell. Move content explicitly in HTML first.");
  }
  let candidate: Transaction | undefined;
  commands[name](state, transaction => { candidate = transaction; });
  if (!candidate) throw new Error("This table operation is not available for the current selection.");
  const nextGrid = candidate.doc.nodeAt(candidate.mapping.map(rect.tableStart - 1));
  if (!nextGrid || nextGrid.type.name !== "tableGrid") throw new Error("Removing the entire table section requires HTML editing.");
  if (JSON.stringify(nonemptyCells(nextGrid)) !== JSON.stringify(nonemptyCells(grid)))
    throw new Error("This operation would remove or rearrange populated cells. Clear or move their content explicitly first.");
  return candidate;
}
