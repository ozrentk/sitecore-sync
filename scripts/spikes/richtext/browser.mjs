import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { html } from '@codemirror/lang-html';

function extensions() {
  return [StarterKit.configure({ link: { openOnClick: false }, undoRedo: false, trailingNode: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }), TextStyleKit,
    TableKit.configure({ table: { resizable: false } }), Image];
}
globalThis.roundTrip = async input => {
  let updates = 0; const errors = [];
  const element = document.createElement('div'); document.body.append(element);
  const editor = new Editor({ element, extensions: extensions(), content: input,
    injectCSS: false, enableContentCheck: true,
    onContentError: ({ error }) => errors.push(error.message), onUpdate: () => updates++ });
  await new Promise(resolve => setTimeout(resolve, 20));
  const output = editor.getHTML(); const json = editor.getJSON();
  const initialUpdates = updates;
  try { editor.commands.setContent(input, { emitUpdate: false }); }
  catch (error) { errors.push(`setContent: ${error.message}`); }
  const afterSetUpdates = updates;
  editor.destroy(); element.remove();
  return { output, json, errors, initialUpdates, afterSetUpdates };
};
globalThis.sourceRoundTrip = input => {
  // Source editor must retain line endings through an explicit document policy.
  const state = EditorState.create({ doc: input, extensions: [html()] });
  const crlf = EditorState.create({ doc: input, extensions: [html(), EditorState.lineSeparator.of('\r\n')] });
  const parent = document.createElement('div'); document.body.append(parent);
  const view = new EditorView({ state, parent, extensions: [] });
  const result = { normal: view.state.doc.toString(), crlf: crlf.sliceDoc(), text: view.dom.textContent };
  view.destroy(); parent.remove(); return result;
};
globalThis.mountEditors = () => {
  const visual = document.createElement('div'); const source = document.createElement('div');
  document.body.append(visual, source);
  const editor = new Editor({ element: visual, extensions: extensions(), content: '<p>Hello</p>',
    injectCSS: true, injectNonce: 'spike', editorProps: { attributes: { role: 'textbox', 'aria-label': 'Visual HTML', 'aria-multiline': 'true' } } });
  const view = new EditorView({ parent: source, state: EditorState.create({ doc: '<p>Hello</p>',
    extensions: [html(), EditorView.cspNonce.of('spike'), EditorView.contentAttributes.of({ 'aria-label': 'HTML source' }),
      EditorView.theme({ '&': { color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)' } })] }) });
  globalThis.spikeEditors = { editor, view };
};
