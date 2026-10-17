import { findVisual, replaceVisual, visualMatches } from "../../src/editor/richTextSearch";
import { literalMatches, validSearchInput } from "../../src/editor/richTextSearchInput";
import { test } from "node:test";
import { strictEqual, throws, match } from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, AllSelection } from "@tiptap/pm/state";
import { admitVisual, exportVisual } from "../../src/editor/richTextAdmission";
import { richTextCommand, activeRichCommand } from "../../src/editor/richTextCommands";

const attrs = { open: { default: "" }, close: { default: "" }, tag: { default: "p" }, before: { default: "" }, tail: { default: "" }, align: { default: null } };
const blockAttrs = (tag: string) => ({ ...attrs, tag: { default: tag } });
const schema = new Schema({ nodes: {
  doc: { content: "block*" }, text: { group: "inline" }, paragraph: { group: "block", content: "inline*", attrs }, heading: { group: "block", content: "inline*", attrs },
  span: { inline: true, group: "inline", content: "inline*", attrs }, richLink: { inline: true, group: "inline", content: "inline*", attrs },
  bulletList: { group: "block", content: "listItem+", attrs: blockAttrs("ul") }, orderedList: { group: "block", content: "listItem+", attrs: { ...blockAttrs("ol"), order: { default: 1 }, reversed: { default: false } } },
  listItem: { content: "(paragraph | heading | listText) (bulletList | orderedList)*", attrs: blockAttrs("li") }, listText: { content: "inline*", attrs: blockAttrs("") },
  blockquote: { group: "block", content: "(paragraph | heading | bulletList | orderedList | blockquote)+", attrs: blockAttrs("blockquote") },
  horizontalRule: { group: "block", atom: true, attrs },
  hardBreak: { group: "inline", inline: true, attrs },
  gap: { group: "block", atom: true, attrs: { raw: { default: "" } } },
}, marks: { bold: { attrs }, italic: { attrs }, underline: { attrs }, strike: { attrs }, subscript: { attrs }, superscript: { attrs } } });
function state(raw: string, text: string, offset = 0, length = 0): EditorState {
  const doc = schema.nodeFromJSON(admitVisual(raw).document); let position = -1;
  doc.descendants((node, pos) => { if (position < 0 && node.isText && node.text!.includes(text)) position = pos + node.text!.indexOf(text) + offset; });
  if (position < 0) throw Error("Missing fixture text");
  return EditorState.create({ doc, selection: TextSelection.create(doc, position, position + length) });
}
const raw = (value: EditorState) => exportVisual(value.doc.toJSON());
const run = (value: EditorState, command: string) => value.apply(richTextCommand(value, command));

test("lists and quotes preserve explicit/inline items, nesting, numbering and structural whitespace", () => {
  for (const html of ['<ul>\n<li>A<strong>B</strong><ol start="3"><li>C</li></ol></li>\n<li><p class="keep">D</p></li>\n</ul>', '<blockquote cite="https://example.test">\n<p>Quote</p>\n<ul><li>One</li></ul>\n</blockquote>']) {
    strictEqual(exportVisual(schema.nodeFromJSON(admitVisual(html).document).toJSON()), html);
  }
  for (const html of ['<ul></ul>', '<ul><p>wrong</p></ul>', '<ul><li id="identity">A</li></ul>', '<ul><li><p>A</p><p>B</p></li></ul>', '<ol start="wat"><li>A</li></ol>', '<blockquote>plain text</blockquote>']) throws(() => admitVisual(html));
});
test("heading and literal alignment commands retain nested links and unrelated block attributes", () => {
  let current = state('<p class="keep"><span title="Nested"><a href="/x">Text</a></span></p>', "Text", 1);
  current = run(current, "h2"); strictEqual(raw(current), '<h2 class="keep"><span title="Nested"><a href="/x">Text</a></span></h2>');
  current = run(current, "alignCenter"); strictEqual(raw(current), '<h2 class="keep" style="text-align: center;"><span title="Nested"><a href="/x">Text</a></span></h2>');
  strictEqual(activeRichCommand(current, "h2"), true); strictEqual(activeRichCommand(current, "alignCenter"), true);
  current = run(current, "paragraph"); match(raw(current), /^<p class="keep" style="text-align: center;">/);
  throws(() => richTextCommand(state('<p style="color:red;text-align:left">Text</p>', 'Text'), 'alignRight'), /other or unrecognized CSS/);
});
test("clear formatting removes plain marks but refuses annotated or enclosing formatting", () => {
  const start = state('<p><strong>one</strong><em>two</em><u>three</u></p>', 'one');
  const selected = start.apply(start.tr.setSelection(TextSelection.create(start.doc, 1, 12)));
  strictEqual(raw(run(selected, 'clearFormatting')), '<p>onetwothree</p>');
  const attributed = state('<p><strong class="keep">Text</strong></p>', 'Text', 0, 4);
  throws(() => richTextCommand(attributed, 'clearFormatting'), /protected/);
  const nested = state('<p><strong><span class="keep">Text</span></strong></p>', 'Text', 1);
  strictEqual(activeRichCommand(nested, 'bold'), true); throws(() => richTextCommand(nested, 'bold'), /enclosing/);
});
test("list create, type conversion, indent, outdent and removal preserve text order", () => {
  let current = state('<p>One</p><p>Two</p>', 'One');
  current = current.apply(current.tr.setSelection(TextSelection.create(current.doc, 1, 9)));
  current = run(current, 'bulletList'); strictEqual(raw(current), '<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
  current = run(current, 'orderedList'); strictEqual(raw(current), '<ol><li><p>One</p></li><li><p>Two</p></li></ol>');
  current = run(state(raw(current), 'Two', 1), 'indent'); strictEqual(raw(current), '<ol><li><p>One</p><ol><li><p>Two</p></li></ol></li></ol>');
  current = run(state(raw(current), 'Two', 1), 'outdent'); strictEqual(raw(current), '<ol><li><p>One</p></li><li><p>Two</p></li></ol>');
  current = run(state(raw(current), 'Two', 1), 'orderedList'); strictEqual(raw(current), '<ol><li><p>One</p></li></ol><p>Two</p>');
});
test("inline item split/lift is deliberate, while metadata loss and impossible indentation are refused", () => {
  strictEqual(raw(run(state('<ul><li>AB</li></ul>', 'AB', 1), 'splitListItem')), '<ul><li>A</li><li>B</li></ul>');
  strictEqual(raw(run(state('<ul><li>Text</li></ul>', 'Text', 1), 'outdent')), '<p>Text</p>');
  throws(() => richTextCommand(state('<ul><li class="keep">Text</li></ul>', 'Text', 1), 'outdent'), /protected/);
  throws(() => richTextCommand(state('<ul class="keep"><li>Text</li></ul>', 'Text', 1), 'orderedList'), /metadata/);
  strictEqual(raw(run(state('<p>Text</p>', 'Text', 1), 'indent')), '<p style="margin-left: 40px;">Text</p>');
  throws(() => richTextCommand(state('<ul><li>Text</li></ul>', 'Text', 1), 'indent'), /unavailable/);
});
test("quote wrapping/lifting preserves block attributes and refuses deleting annotated wrappers", () => {
  const quoted = run(state('<p class="keep">Text</p>', 'Text', 1), 'blockquote');
  strictEqual(raw(quoted), '<blockquote><p class="keep">Text</p></blockquote>');
  strictEqual(raw(run(quoted, 'blockquote')), '<p class="keep">Text</p>');
  throws(() => richTextCommand(state('<blockquote cite="/source"><p>Text</p></blockquote>', 'Text', 1), 'blockquote'), /protected/);
});

test("select-all supports ordinary text blocks and mixed block selection has no single active type", () => {
  const current = state('<p>One</p><h2>Two</h2>', 'One');
  const selected = current.apply(current.tr.setSelection(new AllSelection(current.doc)));
  strictEqual(activeRichCommand(selected, 'paragraph'), false); strictEqual(activeRichCommand(selected, 'h2'), false);
  strictEqual(raw(run(selected, 'bulletList')), '<ul><li><p>One</p></li><li><h2>Two</h2></li></ul>');
});

test("availability checks retain the real document and repeated block/alignment commands are no-ops", () => {
  const current = state('<P style="text-align:center">Keep all this text</P>', 'Keep', 2);
  strictEqual(richTextCommand(current, 'paragraph').docChanged, false);
  strictEqual(richTextCommand(current, 'alignCenter').docChanged, false);
  strictEqual(exportVisual(richTextCommand(current, 'h2', true).doc.toJSON()), '<h2 style="text-align:center">Keep all this text</h2>');
  strictEqual(raw(current), '<P style="text-align:center">Keep all this text</P>');
});

test("list and quote wrapping retain inter-block whitespace without treating it as content to delete", () => {
  const current = state('<p>One</p>\n<p>Two</p>', 'One');
  const selected = current.apply(current.tr.setSelection(new AllSelection(current.doc)));
  strictEqual(raw(run(selected, 'bulletList')), '<ul><li><p>One</p></li>\n<li><p>Two</p></li></ul>');
  strictEqual(raw(run(selected, 'blockquote')), '<blockquote><p>One</p>\n<p>Two</p></blockquote>');
});

test("mixed alignment has no active value and applying alignment updates every selected block", () => {
  const current = state('<p style="text-align:center">One</p><p style="text-align:right">Two</p>', 'One');
  const selected = current.apply(current.tr.setSelection(new AllSelection(current.doc)));
  strictEqual(activeRichCommand(selected, 'alignCenter'), false);
  strictEqual(activeRichCommand(selected, 'alignRight'), false);
  const updated = run(selected, 'alignLeft');
  strictEqual(raw(updated), '<p style="text-align: left;">One</p><p style="text-align: left;">Two</p>');
  strictEqual(activeRichCommand(updated, 'alignLeft'), true);
});


test("new formatting retains tags, supports toggles and inserts a top-level rule", () => {
  throws(() => admitVisual('<p><constructor>Not a mark</constructor></p>'), /outside/);
  const html = '<p><strike class="keep">Old</strike><sub>2</sub><sup>3</sup></p><hr class="line" />';
  strictEqual(raw(state(html, 'Old')), html);
  for (const [command, tag] of [['strike', 's'], ['subscript', 'sub'], ['superscript', 'sup']]) {
    let value = run(state('<p>Text</p>', 'Text', 0, 4), command);
    strictEqual(raw(value), `<p><${tag}>Text</${tag}></p>`);
    value = run(value, command); strictEqual(raw(value), '<p>Text</p>');
  }
  strictEqual(raw(run(state('<p><sub>Text</sub></p>', 'Text', 0, 4), 'superscript')), '<p><sup>Text</sup></p>');
  strictEqual(raw(run(state('<p>Text</p>', 'Text'), 'horizontalRule')), '<p>Text</p><hr><p></p>');
  throws(() => run(state('<p>Text</p>', 'Text', 0, 2), 'horizontalRule'));
  throws(() => run(state('<p><sub class="keep">Text</sub></p>', 'Text', 0, 4), 'superscript'), /protected/);
});
const find = { query: 'one', matchCase: false, direction: 'next' as const };
test("literal search preserves offsets, limits input and wraps in both directions", () => {
  strictEqual(literalMatches('a.*b .*', { ...find, query: '.*' }).length, 2);
  strictEqual(literalMatches('😀 ONE one', find)[0].from, 3);
  strictEqual(validSearchInput({ ...find, query: '' }), false);
  throws(() => literalMatches('one '.repeat(1001), find), /1,000/);
  let value = state('<p>one ONE</p>', 'one');
  const first = findVisual(value, find); strictEqual(first.result.index, 1); value = value.apply(first.transaction);
  const next = findVisual(value, find); strictEqual(next.result.index, 2); value = value.apply(next.transaction);
  strictEqual(findVisual(value, find).result.index, 1);
  strictEqual(findVisual(value, { ...find, direction: 'previous' }).result.index, 1);
  strictEqual(visualMatches(value.doc, { ...find, matchCase: true }).length, 1);
});
test("replacement is atomic, retains wrappers and rejects crossing structures or metadata loss", () => {
  let value = state('<p class="keep"><span title="x">one one</span></p>', 'one');
  const replaced = replaceVisual(value, { ...find, replacement: 'two', all: true });
  strictEqual(replaced.result.replaced, 2);
  strictEqual(raw(value.apply(replaced.transaction)), '<p class="keep"><span title="x">two two</span></p>');
  throws(() => replaceVisual(value, { ...find, replacement: 'two', all: false }), /Find a match/);
  value = state('<p>one</p><p>o<span>ne</span></p>', 'one');
  throws(() => replaceVisual(value, { ...find, replacement: 'two', all: true }), /boundary/);
  strictEqual(raw(value), '<p>one</p><p>o<span>ne</span></p>');
  value = state('<p><strong title="keep">one</strong></p>', 'one');
  throws(() => replaceVisual(value, { ...find, replacement: '', all: true }), /protected/);
  strictEqual(visualMatches(state('<p>o<br>ne</p>', 'o').doc, find).length, 0);
  strictEqual(visualMatches(state('<p>o</p><p>ne</p>', 'o').doc, find).length, 0);
});


test("paragraph indentation uses 40px steps while preserving styles and content", () => {
  let value = state('<p style="text-align: left; color: red;">Text</p>', 'Text');
  value = run(value, 'indent'); match(raw(value), /text-align: left; color: red; margin-left: 40px;/);
  value = run(value, 'indent'); match(raw(value), /margin-left: 80px/);
  value = run(value, 'outdent'); match(raw(value), /margin-left: 40px/);
  value = run(value, 'outdent'); strictEqual(raw(value), '<p style="text-align: left; color: red;">Text</p>');
  throws(() => run(state('<p style="margin-left: 2em">Text</p>', 'Text'), 'indent'), /pixel/);
  const mixed = state('<p style="margin-left: 40px;">One</p><p>Two</p>', 'One');
  strictEqual(raw(run(mixed.apply(mixed.tr.setSelection(new AllSelection(mixed.doc))), 'outdent')), '<p>One</p><p>Two</p>');
  throws(() => run(state('<p style="color: rgb(1,2,3)">Text</p>', 'Text'), 'indent'), /Complex CSS/);
});
test("repeated single replace automatically selects the next match", () => {
  let value = state('<p>one one one</p>', 'one', 0, 3);
  for (let i = 0; i < 3; i++) {
    const result = replaceVisual(value, { ...find, replacement: 'two', all: false });
    strictEqual(result.result.count, 2 - i); value = value.apply(result.transaction);
  }
  strictEqual(raw(value), '<p>two two two</p>');
});
