import { Schema, DOMParser, DOMSerializer } from 'prosemirror-model';
import { schema as basic } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';

const standard = new Schema({ nodes: addListNodes(basic.spec.nodes, 'paragraph block*', 'block')
  .append(tableNodes({ tableGroup: 'block', cellContent: 'block+' })), marks: basic.spec.marks });
const rawAttrs = element => Object.fromEntries([...element.attributes].map(a => [a.name, a.value]));
function preserve(spec) {
  return { ...spec, attrs: { ...spec.attrs, originalAttrs: { default: null } },
    parseDOM: spec.parseDOM?.map(rule => !rule.tag ? rule : { ...rule, getAttrs(element) {
      const attrs = rule.getAttrs ? rule.getAttrs(element) : rule.attrs || {};
      return attrs === false ? false : { ...attrs, originalAttrs: rawAttrs(element) };
    } }) };
}
let adaptedNodes = standard.spec.nodes;
standard.spec.nodes.forEach((name, spec) => { if (name !== 'text' && name !== 'doc') adaptedNodes = adaptedNodes.update(name, preserve(spec)); });
let adaptedMarks = standard.spec.marks;
standard.spec.marks.forEach((name, spec) => { adaptedMarks = adaptedMarks.update(name, preserve(spec)); });
adaptedMarks = adaptedMarks.addToEnd('styledSpan', { attrs: { originalAttrs: { default: null } },
  parseDOM: [{ tag: 'span', getAttrs: element => ({ originalAttrs: rawAttrs(element) }) }],
  toDOM: () => ['span', 0] });

// Active editing DOM never receives source attributes, URLs or arbitrary CSS.
// The export serializer is deliberately separate; these adapters are experimental.
function safeSpec(name, spec) {
  if (!spec.toDOM) return spec;
  const toDOM = spec.toDOM;
  return { ...spec, toDOM(node) {
    if (name === 'image') return ['span', { 'data-image-placeholder': 'true' }, '[Image]'];
    if (name === 'link') return ['span', { 'data-link-placeholder': 'true' }, 0];
    const dom = toDOM(node);
    if (name === 'paragraph' || name === 'heading') {
      const sheet = new CSSStyleSheet(); sheet.replaceSync(`x{${node.attrs.originalAttrs?.style || ''}}`);
      const align = sheet.cssRules[0]?.style?.textAlign;
      if (['left', 'center', 'right', 'justify'].includes(align)) return [dom[0], { 'data-align': align }, 0];
    }
    return dom;
  } };
}
adaptedNodes.forEach((name, spec) => { adaptedNodes = adaptedNodes.update(name, safeSpec(name, spec)); });
adaptedMarks.forEach((name, spec) => { adaptedMarks = adaptedMarks.update(name, safeSpec(name, spec)); });
const adapted = new Schema({ nodes: adaptedNodes, marks: adaptedMarks });

function serializer(schema, custom) {
  if (!custom) return DOMSerializer.fromSchema(schema);
  const original = DOMSerializer.fromSchema(standard);
  const wrap = (name, output) => node => {
    const dom = output(node);
    if (!Array.isArray(dom)) return dom;
    const attrs = typeof dom[1] === 'object' && !Array.isArray(dom[1]) ? dom[1] : {};
    const rest = attrs === dom[1] ? dom.slice(2) : dom.slice(1);
    // Preserve original lexical attribute values in this text-edit-only experiment.
    // Attribute-changing commands need dedicated reconciliation before shipping.
    return [dom[0], { ...attrs, ...node.attrs.originalAttrs }, ...rest];
  };
  return new DOMSerializer(Object.fromEntries(Object.entries(original.nodes).map(([n, f]) => [n, wrap(n, f)])),
    { ...Object.fromEntries(Object.entries(original.marks).map(([n, f]) => [n, wrap(n, f)])),
      styledSpan: mark => ['span', mark.attrs.originalAttrs || {}, 0] });
}
function parse(input, schema) {
  const template = document.createElement('template'); template.innerHTML = input;
  return DOMParser.fromSchema(schema).parse(template.content);
}
function serialize(doc, schema, custom) {
  // Resource-bearing export DOM remains in a document without a browsing context.
  const inert = document.implementation.createHTMLDocument('export'); const div = inert.createElement('div');
  div.append(serializer(schema, custom).serializeFragment(doc.content, { document: inert }));
  return div.innerHTML;
}
globalThis.pmRoundTrip = (input, custom = false) => {
  const schema = custom ? adapted : standard; const doc = parse(input, schema);
  const initial = serialize(doc, schema, custom);
  let firstText;
  doc.descendants((node, pos) => { if (node.isText && firstText === undefined) firstText = pos; });
  const state = EditorState.create({ doc, schema });
  const edited = firstText === undefined ? doc : state.apply(state.tr.insertText('EDIT ', firstText)).doc;
  return { output: initial, afterTextEdit: serialize(edited, schema, custom), json: doc.toJSON(), exact: initial === input };
};
globalThis.mountPM = input => {
  globalThis.pmView?.destroy();
  const place = document.createElement('div'); document.body.append(place);
  globalThis.pmView = new EditorView(place, { state: EditorState.create({ doc: parse(input, adapted), schema: adapted,
    plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo }), keymap(baseKeymap)] }),
    attributes: { role: 'textbox', 'aria-label': 'ProseMirror experiment', 'aria-multiline': 'true' } });
};
globalThis.pmSnapshot = () => serialize(pmView.state.doc, adapted, true);
globalThis.pmUndo = () => undo(pmView.state, pmView.dispatch);
globalThis.pmRedo = () => redo(pmView.state, pmView.dispatch);
globalThis.pmPaste = input => {
  // Tests the default clipboard parser's slice normalization, not OS clipboard integration.
  const template = document.createElement('template'); template.innerHTML = input;
  const slice = DOMParser.fromSchema(adapted).parseSlice(template.content);
  pmView.dispatch(pmView.state.tr.replaceSelection(slice));
  return pmSnapshot();
};
globalThis.pmSelectAll = () => pmView.dispatch(pmView.state.tr.setSelection(TextSelection.create(pmView.state.doc, 1, pmView.state.doc.content.size - 1)));

globalThis.pmAttributeTrap = input => {
  const doc = parse(input, adapted); let state = EditorState.create({ doc, schema: adapted });
  doc.descendants((node, pos) => {
    const mark = node.marks.find(mark => mark.type.name === 'link');
    if (node.isText && mark) state = state.apply(state.tr.removeMark(pos, pos + node.nodeSize, mark.type)
      .addMark(pos, pos + node.nodeSize, mark.type.create({ ...mark.attrs, href: '/new' })));
  });
  return serialize(state.doc, adapted, true);
};
globalThis.pmSplitTrap = input => {
  const state = EditorState.create({ doc: parse(input, adapted), schema: adapted });
  return serialize(state.apply(state.tr.split(2)).doc, adapted, true);
};

export { adapted, serialize };
