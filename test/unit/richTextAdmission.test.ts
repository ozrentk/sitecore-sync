import { test } from "node:test";
import { strictEqual, throws, deepStrictEqual } from "node:assert/strict";
import { admitVisual, exportVisual, htmlSignature, protectedAttributes, safeTextAlignment } from "../../src/editor/richTextAdmission";
import { financeHtml } from "../fixtures/richTextSpans";

test("basic visual admission inventories original tokens and preserves formatting and opaque metadata", () => {
  const raw = '<style data-kind="theme">p { color:red }</style>\r\n<h2 style="text-align:center">A &amp; B</h2>\n<p><b>bold</b> <em>italic</em><br /><img src="https://example.test/x" data-dam-id="42" alt="" /></p>';
  const result = admitVisual(raw);
  strictEqual(htmlSignature(exportVisual(result.document)), result.signature);
  deepStrictEqual(result.opaque, ['<style data-kind="theme">p { color:red }</style>', '\r\n', '\n', '<img src="https://example.test/x" data-dam-id="42" alt="" />']);
  strictEqual(protectedAttributes(exportVisual(result.document)), protectedAttributes(raw));
  strictEqual(exportVisual(admitVisual("").document), "");
  const nested = admitVisual("<p><strong><em>nested</em></strong></p>").document;
  const before = JSON.stringify(nested);
  strictEqual(exportVisual(nested), "<p><strong><em>nested</em></strong></p>");
  strictEqual(JSON.stringify(nested), before, "Export must not reorder marks in the projection");
});

test("token-aware admission refuses malformed, identity-sensitive and unsupported content without repairing it", () => {
  for (const raw of [
    '<p x="1" x="2">duplicate</p>', '<p>unclosed', '<p>a</p></p>', '<p><div>repair</div></p>',
    '<p id="anchor">identity</p>', '<p><a href="/x" data-sc-id="1">managed</a></p>',
    '<p><span id="anchor">identity</span><span id="anchor">duplicate</span></p>',
    '<p onclick="x()">event</p>', '<script>x()</script>', '<iframe src="x"></iframe>',
    '<p><strong>a<strong>b</strong></strong></p>', '<p><small>unsupported</small></p>',
    '<ul><li>list</li></ul>', '<table><tr><td>table</td></tr></table>', '<!--comment--><p>x</p>',
    '<p>\u0000</p>', 'text', 'x'.repeat(262145),
    '<p>' + '<span>'.repeat(41) + 'deep' + '</span>'.repeat(41) + '</p>',
  ]) throws(() => admitVisual(raw), Error, raw.slice(0, 50));
});

test("finance example preserves nested span tokens, heading levels, spacing and blank paragraph", () => {
  const admitted = admitVisual(financeHtml);
  strictEqual(htmlSignature(exportVisual(admitted.document)), htmlSignature(financeHtml));
  const heading = admitted.document.content![0];
  strictEqual(heading.attrs?.tag, "h6"); strictEqual(heading.attrs?.align, "center");
  strictEqual(heading.content![0].type, "span");
  strictEqual(heading.content![0].attrs?.open, '<span class="theme-primary">');
  heading.content![0].content![0].text = "Edited heading";
  const edited = exportVisual(admitted.document);
  strictEqual(edited.includes('<h6 style="text-align: center;"><span class="theme-primary">Edited heading</span>\n</h6>'), true);
  strictEqual(protectedAttributes(edited), protectedAttributes(financeHtml));
  strictEqual(edited.includes('<p style="text-align: center;">\u00a0</p>'), true);
  const nested = '<p><span>outer<span class="inner">inner</span></span></p>';
  strictEqual(exportVisual(admitVisual(nested).document), nested);
  strictEqual(protectedAttributes(nested) === protectedAttributes('<p><span>outer</span><span class="inner">inner</span></p>'), false);
  strictEqual(protectedAttributes('<p><span>text</span></p>') === protectedAttributes('<p>text</p>'), false);
});

test("alignment projection accepts only a literal enum without executing or rewriting CSS", () => {
  strictEqual(safeTextAlignment('text-align: center;'), 'center');
  strictEqual(safeTextAlignment(' TEXT-ALIGN : RIGHT '), 'right');
  for (const style of ['color:red; text-align:center', 'text-align:center!important', 'text-align:var(--x)', 'text-align:center; background:url(https://example.test)', '/*text-align:center*/', 'text-align: center; } body { display:none', 'text-align: expression(x)'])
    strictEqual(safeTextAlignment(style), null);
});

test("visual export retains source attributes but canonicalizes changed text entity spelling explicitly", () => {
  const raw = "<P class='a' style='color:red'>&#65; &amp;</P>";
  const admitted = admitVisual(raw);
  const paragraph = admitted.document.content![0];
  paragraph.content = [{ type: "text", text: "Changed < & >" }];
  strictEqual(exportVisual(admitted.document), "<P class='a' style='color:red'>Changed &lt; &amp; &gt;</P>");
  strictEqual(protectedAttributes(exportVisual(admitted.document)), protectedAttributes(raw));
});
