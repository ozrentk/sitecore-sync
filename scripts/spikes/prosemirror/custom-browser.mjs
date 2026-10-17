// Research only. Explicit importer/exporter shared by two real editing engines.
import { Schema, DOMSerializer } from 'prosemirror-model';
import { EditorState, TextSelection, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { tableNodes, tableEditing, addRowAfter } from 'prosemirror-tables';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlock, joinBackward, toggleMark } from 'prosemirror-commands';
import { Editor, Node, Mark, Extension } from '../richtext/node_modules/@tiptap/core/dist/index.js';
import { DraftExperiment } from '../richtext/draft-experiment.mjs';

const attrs = { html: { default: {} } };
const bag = el => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
// Only enabled in an opaque-origin editing-frame experiment. Never enable in host chrome.
const appearance = node => globalThis.ISOLATED_VISUAL ? Object.fromEntries(
  Object.entries(node.attrs.html || {}).filter(([key]) => ['class', 'style', 'id', 'dir', 'lang'].includes(key))) : {};
const safe = tag => node => [tag, appearance(node), 0];
const textblock = tag => ({ group: 'block', content: 'inline*', attrs, toDOM: safe(tag) });
const nodes = {
  doc: { content: 'block*' }, text: { group: 'inline' },
  paragraph: textblock('p'),
  heading: { ...textblock('h2'), attrs: { ...attrs, tag: { default: 'h2' } }, toDOM: n => [n.attrs.tag, appearance(n), 0] },
  wrapper: { group: 'block', content: 'block*', attrs: { ...attrs, tag: { default: 'div' } }, toDOM: safe('div') },
  wrapperText: { ...textblock('div'), attrs: { ...attrs, tag: { default: 'div' } } },
  span: { group: 'inline', inline: true, content: 'inline*', attrs: { ...attrs, tag: { default: 'span' } }, toDOM: safe('span') },
  code_block: { ...textblock('pre'), content: 'text*', marks: '', code: true, whitespace: 'pre',
    attrs: { ...attrs, code: { default: {} } }, toDOM: () => ['pre', ['code', 0]] },
  stylesheet: { group: 'block', atom: true, attrs: { ...attrs, css: { default: '' } },
    toDOM: () => ['div', { contenteditable: 'false', 'data-opaque': 'css' }, '[Stylesheet: edit in HTML]'] },
  image: { group: 'inline', inline: true, atom: true, attrs,
    toDOM: () => ['span', { 'data-opaque': 'image' }, '[Image]'] },
  blockImage: { group: 'block', atom: true, attrs, toDOM: () => ['div', { 'data-opaque': 'image' }, '[Image]'] },
  hard_break: { group: 'inline', inline: true, toDOM: () => ['br'] },
  tableShell: { group: 'block', content: 'caption? table', attrs: { body: { default: {} } }, toDOM: safe('div') },
  caption: textblock('div'),
  ...tableNodes({ tableGroup: 'block', cellContent: 'block+' }),
};
for (const name of ['table', 'table_row', 'table_cell', 'table_header']) {
  nodes[name] = { ...nodes[name], attrs: { ...nodes[name].attrs, ...attrs } };
}
for (const name of ['table_cell', 'table_header']) nodes[name].attrs.inlineContent = { default: false };
const marks = {
  strong: { attrs, toDOM: safe('strong') }, em: { attrs, toDOM: safe('em') },
  link: { attrs: { ...attrs, href: { default: '' } }, inclusive: false, toDOM: safe('span') },
};
const schema = new Schema({ nodes, marks });
const blockTags = new Set(['P','DIV','SECTION','ARTICLE','CUSTOM-CARD','H1','H2','H3','H4','H5','H6','TABLE','STYLE','PRE','UL','OL','LI']);

function parse(html, s = schema) {
  const root = document.createElement('template'); root.innerHTML = html;
  const create = (name, a, content, m) => s.nodes[name].createChecked(a, content, m);
  function children(el, inline, inherited = []) {
    const result = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (!child.textContent) continue;
        if (inline) result.push(s.text(child.textContent, inherited));
        else if (child.textContent.trim()) result.push(create('paragraph', {}, s.text(child.textContent, inherited)));
      } else if (child.nodeType === 1) result.push(...element(child, inline, inherited));
      // Comments require raw-token admission checks, outside this DOM projection.
    }
    return result;
  }
  function element(el, inline, inherited) {
    const tag = el.localName, html = bag(el);
    if (['script','iframe','object','svg','math','input','form'].includes(tag)) throw new Error(`HTML-only: ${tag}`);
    if (tag === 'style') {
      if (inline) throw new Error('HTML-only: inline stylesheet');
      return [create('stylesheet', { html, css: el.textContent })];
    }
    if (tag === 'img') return [create(inline ? 'image' : 'blockImage', { html }, null, inherited)];
    if (tag === 'br') return [create('hard_break', {}, null, inherited)];
    if (['a','b','strong','em','i'].includes(tag)) {
      const name = tag === 'a' ? 'link' : ['b','strong'].includes(tag) ? 'strong' : 'em';
      if (inherited.some(m => m.type.name === name)) throw new Error(`HTML-only: nested ${name} marks`);
      return children(el, true, [...inherited, s.marks[name].create({ html, href: html.href || '' })]);
    }
    if (tag === 'pre') {
      const code = el.querySelector(':scope > code');
      return [create('code_block', { html, code: code ? bag(code) : {} }, el.textContent ? s.text(el.textContent) : [])];
    }
    if (tag === 'table') {
      if (el.querySelector('thead,tfoot,colgroup') || el.querySelectorAll(':scope > tbody').length > 1)
        throw new Error('HTML-only: table sections/colgroup not implemented');
      const caption = el.querySelector(':scope > caption');
      const rows = [...el.rows].map(row => create('table_row', { html: bag(row) }, [...row.cells].map(cell => {
        const inlineContent = ![...cell.children].some(c => blockTags.has(c.tagName));
        const content = inlineContent ? [create('paragraph', {}, children(cell, true))] : children(cell, false);
        return create(cell.localName === 'th' ? 'table_header' : 'table_cell', {
          html: bag(cell), colspan: cell.colSpan, rowspan: cell.rowSpan, inlineContent,
        }, content.length ? content : [create('paragraph')]);
      })));
      return [create('tableShell', { body: el.tBodies[0] ? bag(el.tBodies[0]) : {} }, [
        ...(caption ? [create('caption', { html: bag(caption) }, children(caption, true))] : []),
        create('table', { html }, rows),
      ])];
    }
    const hasBlocks = [...el.children].some(c => blockTags.has(c.tagName));
    if (inline && hasBlocks) throw new Error('HTML-only: mixed inline/block container');
    if (tag === 'p' || /^h[1-6]$/.test(tag)) return [create(tag === 'p' ? 'paragraph' : 'heading', { html, tag }, children(el, true), inherited)];
    if (inline) return [create('span', { html, tag }, children(el, true), inherited)];
    if (hasBlocks && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
      throw new Error('HTML-only: mixed wrapper content');
    return [create(hasBlocks ? 'wrapper' : 'wrapperText', { html, tag }, children(el, !hasBlocks))];
  }
  return create('doc', {}, children(root.content, false));
}

function serialize(doc) {
  const inert = document.implementation.createHTMLDocument('export');
  const container = inert.createElement('div');
  const serializer = new DOMSerializer({
    text: n => inert.createTextNode(n.text),
    paragraph: n => ['p', n.attrs.html, 0], heading: n => [n.attrs.tag, n.attrs.html, 0],
    wrapper: n => [n.attrs.tag, n.attrs.html, 0], wrapperText: n => [n.attrs.tag, n.attrs.html, 0],
    span: n => [n.attrs.tag, n.attrs.html, 0],
    code_block: n => ['pre', n.attrs.html, ['code', n.attrs.code, 0]],
    stylesheet: n => { const el = inert.createElement('style'); for (const [k,v] of Object.entries(n.attrs.html)) el.setAttribute(k,v); el.textContent = n.attrs.css; return el; },
    image: n => ['img', n.attrs.html], blockImage: n => ['img', n.attrs.html], hard_break: () => ['br'],
    tableShell: n => {
      const grid = n.lastChild;
      const table = serializer.serializeNode(grid, { document: inert });
      const body = table.querySelector('tbody');
      for (const [k,v] of Object.entries(n.attrs.body)) body.setAttribute(k,v);
      if (n.firstChild.type.name === 'caption') table.prepend(serializer.serializeNode(n.firstChild, { document: inert }));
      return table;
    },
    caption: n => ['caption', n.attrs.html, 0],
    table: n => ['table', n.attrs.html, ['tbody', 0]], table_row: n => ['tr', n.attrs.html, 0],
    table_cell: n => cellDOM(n, 'td'), table_header: n => cellDOM(n, 'th'),
  }, {
    strong: n => ['strong', n.attrs.html, 0], em: n => ['em', n.attrs.html, 0],
    // Semantic values win over the preserved bag, including explicit edits.
    link: n => ['a', { ...n.attrs.html, href: n.attrs.href }, 0],
  });
  function cellDOM(node, tag) {
    if (!node.attrs.inlineContent || node.childCount !== 1 || node.firstChild.type.name !== 'paragraph') return [tag, cellAttrs(node), 0];
    const el = inert.createElement(tag);
    for (const [k,v] of Object.entries(cellAttrs(node))) el.setAttribute(k,v);
    el.append(serializer.serializeFragment(node.firstChild.content, { document: inert }));
    return el;
  }
  // DOMSerializer assigns style.cssText, which can drop unknown declarations.
  // Export in inert DOM with setAttribute instead; editing DOM still has its own policy.
  for (const map of [serializer.nodes, serializer.marks]) for (const [name, output] of Object.entries(map)) {
    map[name] = node => {
      const rendered = DOMSerializer.renderSpec(inert, output(node));
      if (node.attrs.html?.style !== undefined) rendered.dom.setAttribute('style', node.attrs.html.style);
      if (name === 'code_block' && node.attrs.code.style !== undefined) rendered.dom.firstChild.setAttribute('style', node.attrs.code.style);
      return rendered;
    };
  }
  container.append(serializer.serializeFragment(doc.content, { document: inert }));
  return container.innerHTML;
}
function cellAttrs(n) {
  const result = { ...n.attrs.html };
  for (const name of ['colspan','rowspan']) {
    if (n.attrs[name] !== 1 || name in result) result[name] = String(n.attrs[name]);
  }
  return result;
}

// Prototype policy: retain the first ID in document order, remove later copies.
// Joining distinct IDs still needs explicit user-facing policy in production.
const uniqueIds = () => new Plugin({ appendTransaction(transactions, old, state) {
  if (!transactions.some(t => t.docChanged)) return null;
  const seen = new Set(); let tr = state.tr;
  state.doc.descendants((node, pos) => {
    const id = node.attrs.html?.id;
    if (!id) return;
    if (seen.has(id)) { const html = { ...node.attrs.html }; delete html.id; tr.setNodeMarkup(pos, undefined, { ...node.attrs, html }); }
    else seen.add(id);
  });
  return tr.docChanged ? tr : null;
} });
const pasteAdapter = () => new Plugin({ props: { handlePaste(view, event) {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return false;
  try { const doc = parse(html, view.state.schema); view.dispatch(view.state.tr.replaceSelection(doc.slice(0))); }
  catch (error) { globalThis.pasteRejection = error.message; }
  return true;
} } });
const plugins = () => [uniqueIds(), history(), pasteAdapter(), tableEditing(), keymap({ 'Mod-z': undo, 'Mod-y': redo }), keymap(baseKeymap)];
const extensions = Object.entries(nodes).map(([name, spec]) => Node.create({ name, topNode: name === 'doc',
  renderHTML: spec.toDOM ? ({ node }) => spec.toDOM(node) : undefined }));
extensions.push(...Object.entries(marks).map(([name, spec]) => Mark.create({ name, renderHTML: ({ mark }) => spec.toDOM(mark) })));
extensions.push(Extension.create({ name: 'customCompatibilityCommands', addProseMirrorPlugins: plugins,
  extendNodeSchema: extension => nodes[extension.name]?.tableRole ? { tableRole: nodes[extension.name].tableRole } : {},
  addCommands: () => ({ compatibilityBold: () => ({ state, dispatch }) => toggleMark(state.schema.marks.strong)(state, dispatch),
    compatibilityAddRow: () => ({ state, dispatch }) => addRowAfter(state, dispatch),
    compatibilityLink: href => ({ state, dispatch }) => changeLink(state, dispatch, href) }) }));
function changeLink(state, dispatch, href) {
  const { from, to } = state.selection; let tr = state.tr;
  state.doc.nodesBetween(from, to, (node, pos) => {
    const mark = node.marks.find(m => m.type.name === 'link');
    if (node.isText && mark) tr = tr.removeMark(pos, pos + node.nodeSize, mark.type)
      .addMark(pos, pos + node.nodeSize, mark.type.create({ ...mark.attrs, href }));
  });
  if (dispatch) dispatch(tr); return tr.docChanged;
}
let tiptap, view, draft;
function applyStyles() {
  if (!globalThis.ISOLATED_VISUAL) return;
  document.querySelectorAll('style[data-source-css]').forEach(el => el.remove());
  view.state.doc.descendants(node => {
    if (node.type.name !== 'stylesheet') return;
    const el = document.createElement('style'); el.setAttribute('data-source-css', '');
    for (const name of ['media', 'type', 'title']) if (name in node.attrs.html) el.setAttribute(name, node.attrs.html[name]);
    el.textContent = node.attrs.css; document.head.append(el);
  });
}
globalThis.custom = {
  semanticTree(html) {
    const root = document.createElement('template'); root.innerHTML = html;
    function walk(node) {
      if (node.nodeType === 3) return { text: node.textContent };
      if (node.nodeType === 8) return { comment: node.textContent };
      const children = [...node.childNodes].filter(child =>
        !(child.nodeType === 3 && !child.textContent.trim() && (!node.localName || ['div','section','article','table','tbody','tr'].includes(node.localName)
          || (['td','th'].includes(node.localName) && [...node.children].some(el => blockTags.has(el.tagName))))));
      return { tag: node.localName || '#root', attrs: node.attributes ? Object.entries(bag(node)).sort(([a],[b]) => a.localeCompare(b)) : [],
        children: children.map(walk) };
    }
    return walk(root.content);
  },
  mount(engine, raw) {
    if (tiptap) tiptap.destroy(); else view?.destroy();
    tiptap = undefined; document.querySelector('#editor')?.remove();
    const place = document.createElement('div'); place.id = 'editor'; document.body.append(place);
    const doc = parse(raw);
    draft = new DraftExperiment(raw); draft.enterVisual(() => doc.toJSON(), () => true);
    if (engine === 'tiptap') {
      tiptap = new Editor({ element: place, extensions, schemaSpec: schema.spec, content: doc.toJSON(), injectCSS: false,
        onTransaction: ({ transaction, editor }) => { if (transaction.docChanged) draft.changeVisual(editor.state.doc.toJSON(), () => serialize(editor.state.doc)); } });
      view = tiptap.view;
    } else view = new EditorView(place, { state: EditorState.create({ doc, plugins: plugins() }),
      dispatchTransaction(tr) { view.updateState(view.state.applyTransaction(tr).state); if (tr.docChanged) draft.changeVisual(view.state.doc.toJSON(), () => serialize(view.state.doc)); } });
    applyStyles(); return serialize(view.state.doc);
  },
  roundtrip: raw => serialize(parse(raw)),
  snapshot: () => serialize(view.state.doc), raw: () => draft.raw,
  debug: () => ({ selection: view.state.selection.toJSON(), parent: view.state.selection.$from.parent.type.name,
    roles: Object.fromEntries(Object.entries(view.state.schema.nodes).map(([k,v]) => [k, v.spec.tableRole])) }),
  select(text, offset = 0, length = 0) {
    let found;
    view.state.doc.descendants((node, pos) => { if (found === undefined && node.isText && node.text.includes(text)) found = pos + node.text.indexOf(text) + offset; });
    if (found === undefined) throw new Error(`Text not found: ${text}`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found, found + length))); view.focus();
  },
  type: text => view.dispatch(view.state.tr.insertText(text)),
  bold: () => tiptap ? tiptap.commands.compatibilityBold() : toggleMark(schema.marks.strong)(view.state, view.dispatch),
  link: href => tiptap ? tiptap.commands.compatibilityLink(href) : changeLink(view.state, view.dispatch, href),
  split: () => splitBlock(view.state, view.dispatch), join: () => joinBackward(view.state, view.dispatch),
  row: () => tiptap ? tiptap.commands.compatibilityAddRow() : addRowAfter(view.state, view.dispatch),
  undo: () => undo(view.state, view.dispatch), redo: () => redo(view.state, view.dispatch),
  paste(raw) { const doc = parse(raw, view.state.schema); view.dispatch(view.state.tr.replaceSelection(doc.slice(0))); },
  switchHTML: () => draft.enterHTML(), htmlEdit: raw => draft.changeHTML(raw),
  switchVisual() {
    const doc = parse(draft.raw, view.state.schema);
    draft.enterVisual(() => doc.toJSON(), () => true);
    view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
    applyStyles(); return true;
  },
};
