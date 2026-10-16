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
  gap: { group: "block", atom: true, attrs: { raw: { default: "" } } },
}, marks: { bold: { attrs }, italic: { attrs }, underline: { attrs } } });
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
  throws(() => richTextCommand(state('<p>Text</p>', 'Text', 1), 'indent'), /list items/);
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
