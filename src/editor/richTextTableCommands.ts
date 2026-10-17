import type { EditorState, Transaction, Command } from "@tiptap/pm/state";
import { TextSelection, NodeSelection, AllSelection } from "@tiptap/pm/state";
import { CellSelection, addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn, mergeCells, splitCell, selectedRect, isInTable } from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";
import { admitVisual, exportVisual, protectedAttributes } from "./richTextAdmission";

function tableTarget(state: EditorState): { node: PMNode; pos: number } | undefined {
  if (state.selection instanceof NodeSelection && ["tableShell", "tableWrapper"].includes(state.selection.node.type.name)) return { node: state.selection.node, pos: state.selection.from };
  for (let d = 1; d <= state.selection.$from.depth; d++) if (["tableWrapper", "tableShell"].includes(state.selection.$from.node(d).type.name)) return { node: state.selection.$from.node(d), pos: state.selection.$from.before(d) };
  if (state.selection instanceof AllSelection) {
    let target: { node: PMNode; pos: number } | undefined; let other = false;
    state.doc.forEach((node, pos) => {
      if (["tableShell", "tableWrapper"].includes(node.type.name) && !target) target = { node, pos };
      else if (node.type.name !== "gap" || !/^\s*$/u.test(node.attrs.raw)) other = true;
    });
    if (!other) return target;
  }
  return undefined;
}
export function wholeTableSelected(state: EditorState): boolean {
  const target = tableTarget(state); if (!target) return false;
  if (state.selection instanceof NodeSelection || state.selection instanceof AllSelection) return true;
  if (!(state.selection instanceof CellSelection)) return false;
  const rect = selectedRect(state); let grids = 0; target.node.descendants(node => { if (node.type.name === "tableGrid") grids++; });
  return grids === 1 && rect.left === 0 && rect.top === 0 && rect.right === rect.map.width && rect.bottom === rect.map.height;
}
function deleteTarget(state: EditorState): Transaction {
  const target = tableTarget(state); if (!target) throw new Error("Select a table or place the cursor inside it first.");
  const tr = state.tr.delete(target.pos, target.pos + target.node.nodeSize);
  let editable = false; tr.doc.descendants(node => { if (node.isTextblock) editable = true; });
  if (!editable) tr.insert(Math.min(target.pos, tr.doc.content.size), state.schema.nodes.paragraph.create());
  tr.doc.check(); admitVisual(exportVisual(tr.doc.toJSON()));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target.pos, tr.doc.content.size)))).scrollIntoView();
}

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
  if (name === "deleteTable") return deleteTarget(state);
  if (name === "insertTable") {
    if (!state.selection.empty) {
      const range = state.selection.$from.blockRange(state.selection.$to);
      if (!range || range.parent.type.name !== "doc") throw new Error("Select top-level paragraphs or headings to convert into rows.");
      const rows: PMNode[] = []; let before = "";
      for (let i = range.startIndex; i < range.endIndex; i++) {
        const block = state.doc.child(i);
        if (block.type.name === "gap" && /^\s*$/u.test(block.attrs.raw)) { before += block.attrs.raw; continue; }
        if (!["paragraph", "heading"].includes(block.type.name)) throw new Error("Only adjacent paragraphs and headings can be converted to table rows.");
        rows.push(state.schema.nodes.tableRow.create({ before }, state.schema.nodes.tableCell.create(null, block))); before = "";
      }
      if (!rows.length || rows.length > 100) throw new Error("Select between 1 and 100 paragraphs.");
      const table = state.schema.nodes.tableShell.create(null, state.schema.nodes.tableGrid.create({ tail: before }, rows));
      const tr = state.tr.replaceWith(range.start, range.end, table);
      if (state.doc.textContent.replace(/\s/gu, "") !== tr.doc.textContent.replace(/\s/gu, "") || protectedAttributes(exportVisual(state.doc.toJSON()), true) !== protectedAttributes(exportVisual(tr.doc.toJSON()), true)) throw new Error("Conversion would change existing content or metadata.");
      tr.doc.check(); admitVisual(exportVisual(tr.doc.toJSON()));
      return tr.setSelection(TextSelection.near(tr.doc.resolve(range.start + 1))).scrollIntoView();
    }
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
  if (["removeRows", "removeColumns"].includes(name)) {
    if (!isInTable(state)) throw new Error("Select cells to delete rows or columns.");
    const rect = selectedRect(state); const grid = rect.table; let grids = 0; let columns = false;
    shell.forEach(node => { if (node.type.name === "tableGrid") grids++; if (node.type.name === "colgroup") columns = true; });
    if (name === "removeColumns" && (grids !== 1 || columns)) throw new Error("Column deletion with multiple sections or column definitions requires HTML.");
    grid.forEach(row => row.forEach(cell => { if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) throw new Error("Split merged cells before deleting rows or columns."); }));
    const rows: PMNode[] = [];
    grid.forEach((row, _offset, y) => {
      if (name === "removeRows" && y >= rect.top && y < rect.bottom) return;
      const cells: PMNode[] = []; row.forEach((cell, _cellOffset, x) => { if (name !== "removeColumns" || x < rect.left || x >= rect.right) cells.push(cell); });
      if (cells.length) rows.push(row.type.create(row.attrs, cells, row.marks));
    });
    if (!rows.length && grids === 1) return deleteTarget(state);
    const position = rect.tableStart - 1;
    const tr = rows.length ? state.tr.replaceWith(position, position + grid.nodeSize, grid.type.create(grid.attrs, rows, grid.marks)) : state.tr.delete(position, position + grid.nodeSize);
    tr.doc.check(); admitVisual(exportVisual(tr.doc.toJSON()));
    return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(position + 1, tr.doc.content.size)))).scrollIntoView();
  }
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
