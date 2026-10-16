import { findVisual, replaceVisual, visualMatches } from "../src/editor/richTextSearch";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { literalMatches, type SearchInput, type ReplaceInput } from "../src/editor/richTextSearchInput";
import { richMarkTags } from "../src/editor/richTextMarks";
import { Editor, Node, Mark, Extension, type JSONContent } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { baseKeymap } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import type { Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { tableExtensions } from "./richTextTables";
import { blockExtensions } from "./richTextBlocks";
import { richCommands, richTextCommand, activeRichCommand } from "../src/editor/richTextCommands";
import { tableCommand } from "../src/editor/richTextTableCommands";
import { beginRichLink, richLinkCommand, type RichLinkSession } from "../src/editor/richTextLinkCommands";
import type { RichLinkDestination } from "../src/editor/richTextLinks";
import { admitVisual, exportVisual, htmlSignature, protectedAttributes } from "../src/editor/richTextAdmission";

interface Callbacks { change(raw: string): void; history(action: string): void; error(message: string): void; selection?(): void }
const attributes = () => ({ open: { default: "" }, close: { default: "" }, tag: { default: "p" }, align: { default: null }, before: { default: "" }, tail: { default: "" } });
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
  Node.create({ name: "richLink", group: "inline", inline: true, content: "inline*", defining: true, addAttributes: attributes,
    renderHTML: () => ["span", { class: "rt-link", "data-rich-link": "true" }, 0] }),
  Node.create({ name: "horizontalRule", group: "block", atom: true, addAttributes: attributes, renderHTML: () => ["hr"] }),
  Node.create({ name: "hardBreak", group: "inline", inline: true, selectable: false, addAttributes: attributes, renderHTML: () => ["br"] }),
  ...opaqueNames.map(name => Node.create({ name, group: name === "inlineImage" ? "inline" : "block", inline: name === "inlineImage", atom: true,
    selectable: false, draggable: false, addAttributes: () => ({ raw: { default: "" } }),
    renderHTML: () => [name === "inlineImage" ? "span" : "div", { "data-opaque": name, contenteditable: "false" },
      name === "gap" ? "" : name === "stylesheet" ? "[Stylesheet — edit in HTML]" : "[Image — edit in HTML]"] })),
];
const marks = Object.entries(richMarkTags).map(([name, tag]) =>
  Mark.create({ name, addAttributes: attributes, renderHTML: () => [tag, 0] }));

export function createVisual(element: HTMLElement, initial: string, callbacks: Callbacks, extraExtensions: Extension[] = []) {
  const admission = admitVisual(initial);
  if (initial && !admission.document.content?.some(node => ["paragraph", "heading", "horizontalRule", "tableShell", "tableWrapper", "bulletList", "orderedList", "blockquote"].includes(node.type ?? "")))
    throw new Error("No editable paragraph, heading or table is present. Use HTML.");
  let authorizedTableTransaction: Transaction | undefined;
  let authorizedLinkTransaction: Transaction | undefined;
  let authorizedLinkInventory: string | undefined;
  let linkSession: RichLinkSession | undefined;
  let authorizedCommand: Transaction | undefined;
  let authorizedCommandInventory: string | undefined;
  let structuralCommand = false;
  let retainedOpaque = admission.opaque;
  let validatedDoc: unknown;
  let validatedOpaque: readonly string[] = admission.opaque;
  let current = initial; let destroyed = false; let composing = false;
  let searchInput: SearchInput | undefined;
  const reject = (message: string): false => { callbacks.error(message); return false; };
  const guard = Extension.create({ name: "sourceGuard", priority: 1000,
    addProseMirrorPlugins() { return [new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        try {
          const raw = exportVisual(transaction.doc.toJSON() as JSONContent);
          const next = admitVisual(raw);
          const structural = transaction === authorizedTableTransaction;
          const expected = transaction === authorizedCommand ? authorizedCommandInventory : transaction === authorizedLinkTransaction ? authorizedLinkInventory : protectedAttributes(current, structural);
          const opaque = (values: readonly string[]) => transaction === authorizedCommand && structuralCommand ? values.filter(value => !/^\s*$/u.test(value)) : values;
          if (JSON.stringify(opaque(next.opaque)) !== JSON.stringify(opaque(retainedOpaque)) || protectedAttributes(raw, structural) !== expected)
            return reject("This operation would change protected metadata or opaque content. Use HTML.");
          validatedDoc = transaction.doc; validatedOpaque = next.opaque;
          return true;
        } catch (error) { return reject(error instanceof Error ? error.message : "This operation is outside the visual profile. Use HTML."); }
      },
      props: {
        decorations(state) {
          if (!searchInput) return DecorationSet.empty;
          try {
            return DecorationSet.create(state.doc, visualMatches(state.doc, searchInput).flatMap(match => match.parts.map(part =>
              Decoration.inline(part.from, part.to, { class: match.from === state.selection.from && match.to === state.selection.to ? "rt-search-current" : "rt-search-match" }))));
          } catch { return DecorationSet.empty; }
        },
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
      "Mod-b": () => execute("bold"), "Mod-i": () => execute("italic"), "Mod-u": () => execute("underline"),
      "Mod-Alt-0": () => execute("paragraph"),
      ...Object.fromEntries([1,2,3,4,5,6].map(level => [`Mod-Alt-${level}`, () => execute(`h${level}`)])),
      "Mod-Shift-7": () => execute("orderedList"), "Mod-Shift-8": () => execute("bulletList"),
      "Shift-Enter": (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create())); return true; },
      ...baseKeymap,
      Enter: state => {
        if (!activeRichCommand(state, "listItem")) return baseKeymap.Enter(state, editor.view.dispatch, editor.view);
        return execute(state.selection.$from.parent.content.size ? "splitListItem" : "outdent");
      },
      Tab: state => activeRichCommand(state, "listItem") ? execute("indent") : false,
      "Shift-Tab": state => activeRichCommand(state, "listItem") ? execute("outdent") : false,
      Backspace: state => activeRichCommand(state, "listItem") && state.selection.empty && state.selection.$from.parent.isTextblock && state.selection.$from.parentOffset === 0
        ? execute("outdent") : baseKeymap.Backspace(state, editor.view.dispatch, editor.view),
    })]; },
  });
  const editor: Editor = new Editor({ element, extensions: [...nodes, ...marks, ...tableExtensions, ...blockExtensions, guard, ...extraExtensions], content: initial === "" ? { type: "doc", content: [{ type: "paragraph" }] } : admission.document,
    enableInputRules: false, enablePasteRules: false, injectCSS: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "Rich Text visual editor", "aria-multiline": "true", spellcheck: "false" } },
    onTransaction: () => callbacks.selection?.(),
    onUpdate: ({ editor: active }) => {
      const document = active.getJSON();
      if (active.state.doc === validatedDoc) retainedOpaque = validatedOpaque;
      const next = JSON.stringify(document) === baseline ? initial : exportVisual(document);
      if (next !== current) { current = next; callbacks.error(""); callbacks.change(current); }
    },
  });
  const baseline = JSON.stringify(editor.getJSON());
  if (initial !== "" && htmlSignature(exportVisual(editor.getJSON())) !== admission.signature) {
    editor.destroy(); throw new Error("Visual import would normalize the document structure. Use HTML.");
  }
  function execute(name: string): boolean {
    if (!editor.isEditable) return true;
    try {
      if (richCommands.includes(name as typeof richCommands[number])) {
        authorizedCommand = richTextCommand(editor.state, name);
        structuralCommand = ["bulletList", "orderedList", "indent", "outdent", "blockquote", "splitListItem"].includes(name);
        authorizedCommandInventory = protectedAttributes(exportVisual(authorizedCommand.doc.toJSON()));
        editor.view.dispatch(authorizedCommand);
      } else { authorizedTableTransaction = tableCommand(editor.state, name); editor.view.dispatch(authorizedTableTransaction); }
      editor.view.focus();
    } catch (error) { callbacks.error(error instanceof Error ? error.message : "Command unavailable."); }
    finally { authorizedCommand = undefined; authorizedCommandInventory = undefined; structuralCommand = false; authorizedTableTransaction = undefined; }
    return true;
  }
  let statusState = editor.state;
  const statuses = new Map<string, { enabled: boolean; active: boolean; reason: string }>();
  return {
    read: () => current,
    clearSearch() { searchInput = undefined; if (!destroyed) editor.view.dispatch(editor.state.tr); },
    highlightSearch(input: SearchInput) {
      const matches = visualMatches(editor.state.doc, input); searchInput = input;
      editor.view.dispatch(editor.state.tr);
      return { count: matches.length, index: matches.findIndex(match => match.from === editor.state.selection.from && match.to === editor.state.selection.to) + 1, replaced: 0 };
    },
    search(input: SearchInput) {
      if (destroyed || composing || editor.view.composing) throw new Error("Finish composing before searching.");
      const found = findVisual(editor.state, input); searchInput = input; editor.view.dispatch(found.transaction); return found.result;
    },
    replaceSearch(input: ReplaceInput) {
      if (destroyed || !editor.isEditable || composing || editor.view.composing) throw new Error("Finish composing and wait for editing to resume before replacing.");
      const replaced = replaceVisual(editor.state, input); editor.view.dispatch(replaced.transaction);
      if (!editor.state.doc.eq(replaced.transaction.doc)) throw new Error("Replacement was refused by the preservation guard.");
      return replaced.result;
    },
    beginLink() {
      linkSession = beginRichLink(editor.state);
      return { ...linkSession.info, existing: Boolean(linkSession.node) };
    },
    cancelLink() { linkSession = undefined; },
    applyLink(destination: RichLinkDestination | "remove") {
      if (!editor.isEditable || !linkSession || destroyed) throw new Error("Reopen Link before applying changes.");
      try {
        authorizedLinkTransaction = richLinkCommand(editor.state, linkSession, destination);
        authorizedLinkInventory = protectedAttributes(exportVisual(authorizedLinkTransaction.doc.toJSON()));
        const expected = authorizedLinkTransaction.doc;
        editor.view.dispatch(authorizedLinkTransaction);
        if (!editor.state.doc.eq(expected)) throw new Error("The link change was refused by the preservation guard. Use HTML.");
        linkSession = undefined; editor.view.focus();
      } finally { authorizedLinkTransaction = undefined; authorizedLinkInventory = undefined; }
    },
    command: execute,
    status(name: string) {
      if (!editor.isEditable) return { enabled: false, active: false, reason: "Editing is frozen." };
      if (statusState !== editor.state) { statuses.clear(); statusState = editor.state; }
      const existing = statuses.get(name); if (existing) return existing;
      const active = activeRichCommand(editor.state, name);
      let result;
      try {
        if (name === "link") beginRichLink(editor.state);
        else if (richCommands.includes(name as typeof richCommands[number])) richTextCommand(editor.state, name, true);
        else tableCommand(editor.state, name);
        result = { enabled: true, active, reason: "" };
      } catch (error) { result = { enabled: false, active, reason: error instanceof Error ? error.message : "Unavailable for this selection." }; }
      statuses.set(name, result); return result;
    },
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
      linkSession = undefined;
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

Object.assign(globalThis, { createRichTextVisual: createVisual, richTextSearchTools: { literalMatches } });
