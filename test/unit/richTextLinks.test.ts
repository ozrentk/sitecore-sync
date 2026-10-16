import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws, match } from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { changeRichLink, inspectRichLink, newRichLinkTargets, unlinkRichText } from "../../src/editor/richTextLinks";
import { beginRichLink, richLinkCommand } from "../../src/editor/richTextLinkCommands";
import { admitVisual, exportVisual } from "../../src/editor/richTextAdmission";

const first = "11111111222233334444555555555555";
const second = "aaaaaaaa222233334444555555555555";
const token = `<a class='keep' href="~/link.aspx?_id=${first}&amp;_z=z#section" data-sc-id="{11111111-2222-3333-4444-555555555555}" title='Title'>`;
test("managed links update URI and matching identity atomically without changing unrelated tokens", () => {
  strictEqual(changeRichLink(token, { kind: "sitecore", itemId: first }), token);
  const changed = changeRichLink(token, { kind: "sitecore", itemId: second });
  strictEqual(changed, `<a class='keep' href="~/link.aspx?_id=AAAAAAAA222233334444555555555555&amp;_z=z#section" data-sc-id="{AAAAAAAA-2222-3333-4444-555555555555}" title='Title'>`);
  strictEqual(inspectRichLink(changed).itemId, second);
  const ordinary = changeRichLink(token, { kind: "url", href: "https://example.test/path" });
  strictEqual(inspectRichLink(ordinary).kind, "url"); strictEqual(ordinary.includes("data-sc-id"), false);
  deepStrictEqual(newRichLinkTargets(`<p>${token}old</a></p>`, `<p>${changed}new</a></p>`), [second]);
});
test("custom metadata, conflicting identities and executable links cannot be retargeted", () => {
  for (const open of [token.replace(first, second), '<a href="/x" data-dam-id="42">', '<a href="~/link.aspx?_id='+first+'&amp;_z=z&amp;sc_lang=en">', '<a href="/x" id="anchor">']) {
    strictEqual(inspectRichLink(open).kind, "unknown"); throws(() => changeRichLink(open, { kind: "sitecore", itemId: second })); throws(() => unlinkRichText(open));
  }
  for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/a"]) throws(() => admitVisual(`<p><a href="${href}">x</a></p>`));
  throws(() => changeRichLink(undefined, { kind: "url", href: "https://user:secret@example.test" }));
  throws(() => changeRichLink(undefined, { kind: "sitecore", itemId: "bad" }));
});
test("unlink preserves unrelated attributes and leaves source-only link forms untouched", () => {
  match(unlinkRichText(token)!, /^<span class='keep'/); match(unlinkRichText(token)!, /title='Title'/);
  strictEqual(unlinkRichText('<a href="/x" target="_blank" rel="noopener">'), undefined);
  const raw = '<p><a href="/x" data-unknown="1"><span class="inner">Text</span></a></p>';
  strictEqual(exportVisual(admitVisual(raw).document), raw);
});

const attrs = { open: { default: "" }, close: { default: "" }, tag: { default: "" } };
const schema = new Schema({ nodes: { doc: { content: "paragraph*" }, text: { group: "inline" }, paragraph: { content: "inline*", attrs }, span: { inline: true, group: "inline", content: "inline*", attrs }, richLink: { inline: true, group: "inline", content: "inline*", attrs } }, marks: { bold: { attrs }, italic: { attrs } } });
function state(raw: string, from: number, to = from): EditorState {
  const doc = schema.nodeFromJSON(admitVisual(raw).document); return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}
const output = (current: EditorState): string => exportVisual(current.doc.toJSON());
test("link commands create around nested formatting, retarget and unwrap without losing text", () => {
  let current = state('<p><span class="keep"><strong>Text</strong></span> end</p>', 1, 7);
  current = current.apply(richLinkCommand(current, beginRichLink(current), { kind: "url", href: "/page" }));
  strictEqual(output(current), '<p><a href="/page"><span class="keep"><strong>Text</strong></span></a> end</p>');
  current = current.apply(richLinkCommand(current, beginRichLink(current), { kind: "sitecore", itemId: first }));
  match(output(current), /_id=11111111222233334444555555555555&amp;_z=z/);
  current = current.apply(richLinkCommand(current, beginRichLink(current), "remove"));
  strictEqual(output(current), '<p><span class="keep"><strong>Text</strong></span> end</p>');
});
test("link commands reject empty/cross-container selection, stale sessions and protected formatting splits", () => {
  throws(() => beginRichLink(state('<p>text</p>', 2)), /Select text/);
  throws(() => beginRichLink(state('<p><span>text</span> tail</p>', 3, 9)), /Select text/);
  const current = state('<p>text</p>', 1, 3); const session = beginRichLink(current);
  throws(() => richLinkCommand(current.apply(current.tr.insertText("x")), session, { kind: "url", href: "/x" }), /changed/);
  const protectedState = state('<p><strong class="keep">text</strong></p>', 2, 3);
  throws(() => richLinkCommand(protectedState, beginRichLink(protectedState), { kind: "url", href: "/x" }), /split protected/);
});
