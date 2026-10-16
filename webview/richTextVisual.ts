import { Editor, Node, Mark, Extension, type JSONContent } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { baseKeymap, toggleMark } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import type { Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { tableExtensions } from "./richTextTables";
import { tableCommand } from "../src/editor/richTextTableCommands";
import { admitVisual, exportVisual, htmlSignature, protectedAttributes } from "../src/editor/richTextAdmission";

interface Callbacks { change(raw: string): void; history(action: string): void; error(message: string): void }
const attributes = () => ({ open: { default: "" }, close: { default: "" }, tag: { default: "p" }, align: { default: null } });
const alignment = (value: unknown): Record<string, string> => typeof value === "string" && /^(?:left|right|center|justify|start|end)$/u.test(value)
  ? { "data-rt-align": value } : {};
const opaqueNames = ["gap", "stylesheet", "inlineImage", "blockImage"];
const nodes = [
  Node.create({ name: "doc", topNode: true, content: "block*" }),
  Node.create({ name: "text", group: "inline" }),
  Node.create({ name: "paragraph", group: "block", content: "inline*", addAttributes: attributes, renderHTML: ({ node }) => ["p", alignment(node.attrs.align), 0] }),
  Node.create({ name: "heading", group: "block", content: "inline*", addAttributes: attributes,
    renderHTML: ({ node }) => [/^h[1-6]$/u.test(node.attrs.tag) ? node.attrs.tag : "h2", alignment(node.attrs.align), 0] }),
  Node.create({ name: "span", group: "inline", inline: true, content: "inline*", defining: true, addAttributes: attributes,
    renderHTML: ({ node }) => ["span", alignment(node.attrs.align), 0] }),
  Node.create({ name: "hardBreak", group: "inline", inline: true, selectable: false, addAttributes: attributes, renderHTML: () => ["br"] }),
  ...opaqueNames.map(name => Node.create({ name, group: name === "inlineImage" ? "inline" : "block", inline: name === "inlineImage", atom: true,
    selectable: false, draggable: false, addAttributes: () => ({ raw: { default: "" } }),
    renderHTML: () => [name === "inlineImage" ? "span" : "div", { "data-opaque": name, contenteditable: "false" },
      name === "gap" ? "" : name === "stylesheet" ? "[Stylesheet — edit in HTML]" : "[Image — edit in HTML]"] })),
];
const marks = [["bold", "strong"], ["italic", "em"], ["underline", "u"]].map(([name, tag]) =>
  Mark.create({ name, addAttributes: attributes, renderHTML: () => [tag, 0] }));

export function createVisual(element: HTMLElement, initial: string, callbacks: Callbacks) {
  const admission = admitVisual(initial);
  if (initial && !admission.document.content?.some(node => ["paragraph", "heading", "tableShell", "tableWrapper"].includes(node.type ?? "")))
    throw new Error("No editable paragraph, heading or table is present. Use HTML.");
  let authorizedTableTransaction: Transaction | undefined;
  let current = initial; let destroyed = false; let composing = false;
  const reject = (message: string): false => { callbacks.error(message); return false; };
  const guard = Extension.create({ name: "sourceGuard", priority: 1000,
    addProseMirrorPlugins() { return [new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        try {
          const raw = exportVisual(transaction.doc.toJSON() as JSONContent);
          const next = admitVisual(raw);
          const structural = transaction === authorizedTableTransaction;
          if (JSON.stringify(next.opaque) !== JSON.stringify(admission.opaque) || protectedAttributes(raw, structural) !== protectedAttributes(current, structural))
            return reject("This operation would change protected metadata or opaque content. Use HTML.");
          return true;
        } catch (error) { return reject(error instanceof Error ? error.message : "This operation is outside the visual profile. Use HTML."); }
      },
      props: {
        handlePaste(view, event) {
          const html = event.clipboardData?.getData("text/html");
          if (html) { reject("Formatted paste is not supported in Visual yet. Paste HTML in HTML mode, or use plain-text paste."); return true; }
          const text = event.clipboardData?.getData("text/plain");
          if (text !== undefined) view.dispatch(view.state.tr.insertText(text));
          return true;
        },
        handleDrop() { reject("Drag/drop is HTML-only in this visual profile."); return true; },
        handleDOMEvents: {
          beforeinput: (_view, event) => {
            const type = (event as InputEvent).inputType;
            if (type !== "historyUndo" && type !== "historyRedo") return false;
            event.preventDefault(); if (!composing) callbacks.history(type === "historyUndo" ? "undo" : "redo"); return true;
          },
          compositionstart: () => { composing = true; return false; },
          compositionend: () => { composing = false; return false; },
          click: (_view, event) => { if ((event.target as Element).closest("a")) event.preventDefault(); return false; },
        },
      },
    }), keymap({
      "Mod-z": () => { if (!composing) callbacks.history("undo"); return true; },
      "Mod-y": () => { if (!composing) callbacks.history("redo"); return true; },
      "Mod-Shift-z": () => { if (!composing) callbacks.history("redo"); return true; },
      "Mod-b": (state, dispatch) => toggleMark(state.schema.marks.bold)(state, dispatch),
      "Mod-i": (state, dispatch) => toggleMark(state.schema.marks.italic)(state, dispatch),
      "Mod-u": (state, dispatch) => toggleMark(state.schema.marks.underline)(state, dispatch),
      "Shift-Enter": (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create())); return true; },
      ...baseKeymap,
    })]; },
  });
  const editor = new Editor({ element, extensions: [...nodes, ...marks, ...tableExtensions, guard], content: initial === "" ? { type: "doc", content: [{ type: "paragraph" }] } : admission.document,
    enableInputRules: false, enablePasteRules: false, injectCSS: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "Rich Text visual editor", "aria-multiline": "true", spellcheck: "false" } },
    onUpdate: ({ editor: active }) => {
      const document = active.getJSON();
      const next = JSON.stringify(document) === baseline ? initial : exportVisual(document);
      if (next !== current) { current = next; callbacks.error(""); callbacks.change(current); }
    },
  });
  const baseline = JSON.stringify(editor.getJSON());
  if (initial !== "" && htmlSignature(exportVisual(editor.getJSON())) !== admission.signature) {
    editor.destroy(); throw new Error("Visual import would normalize the document structure. Use HTML.");
  }
  return {
    read: () => current,
    command(name: string) { if (editor.isEditable && ["bold", "italic", "underline"].includes(name)) {
      editor.view.focus(); toggleMark(editor.schema.marks[name])(editor.state, editor.view.dispatch);
    } else if (editor.isEditable) {
      try { authorizedTableTransaction = tableCommand(editor.state, name); editor.view.dispatch(authorizedTableTransaction); editor.view.focus(); }
      catch (error) { callbacks.error(error instanceof Error ? error.message : "Table operation unavailable."); }
      finally { authorizedTableTransaction = undefined; }
    } },
    focus() { editor.commands.focus(); },
    selection() { const selection = editor.state.selection; return { from: selection.from, to: selection.to,
      ...(selection instanceof CellSelection ? { anchorCell: selection.$anchorCell.pos, headCell: selection.$headCell.pos } : {}) }; },
    restore(selection: { from: number; to: number; anchorCell?: number; headCell?: number }) {
      const max = editor.state.doc.content.size;
      let restored;
      try { restored = selection.anchorCell !== undefined && selection.headCell !== undefined ? CellSelection.create(editor.state.doc, selection.anchorCell, selection.headCell) : undefined; } catch { /* Stale host selection falls back to bounded text selection. */ }
      editor.view.dispatch(editor.state.tr.setSelection(restored ?? TextSelection.create(editor.state.doc, Math.min(selection.from, max), Math.min(selection.to, max))));
      editor.view.focus();
    },
    async freeze() {
      editor.view.dom.blur();
      const start = Date.now();
      while (composing || editor.view.composing) {
        if (Date.now() - start > 3500) throw new Error("Finish composing before saving.");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (destroyed) throw new Error("Visual editor closed.");
      editor.setEditable(false); return current;
    },
    editable(value: boolean) { editor.setEditable(value); },
    dispose() { destroyed = true; editor.destroy(); },
  };
}

Object.assign(globalThis, { createRichTextVisual: createVisual });
