// Optional matched-schema control, using the previous spike's pinned installation.
import { Editor, Node, Mark } from '../richtext/node_modules/@tiptap/core/dist/index.js';
import { adapted, serialize } from './browser.mjs';
const extensions = [];
adapted.spec.nodes.forEach((name, spec) => extensions.push(Node.create({ name, topNode: name === 'doc',
  parseHTML: () => spec.parseDOM || [], renderHTML: spec.toDOM ? ({ node }) => spec.toDOM(node) : undefined })));
adapted.spec.marks.forEach((name, spec) => extensions.push(Mark.create({ name,
  parseHTML: () => spec.parseDOM || [], renderHTML: ({ mark }) => spec.toDOM(mark) })));
globalThis.matchedTiptap = input => {
  const editor = new Editor({ extensions, schemaSpec: adapted.spec, content: input, injectCSS: false });
  const output = serialize(editor.state.doc, editor.schema, true);
  editor.destroy(); return output;
};
