import { test } from "node:test";
import { strictEqual, throws, deepStrictEqual } from "node:assert/strict";
import { admitVisual, exportVisual, htmlSignature, protectedAttributes } from "../../src/editor/richTextAdmission";

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
    '<p onclick="x()">event</p>', '<script>x()</script>', '<iframe src="x"></iframe>',
    '<p><strong>a<strong>b</strong></strong></p>', '<p><span>nested</span></p>',
    '<ul><li>list</li></ul>', '<table><tr><td>table</td></tr></table>', '<!--comment--><p>x</p>',
    '<p>\u0000</p>', 'text', 'x'.repeat(262145),
  ]) throws(() => admitVisual(raw), Error, raw.slice(0, 50));
});

test("visual export retains source attributes but canonicalizes changed text entity spelling explicitly", () => {
  const raw = "<P class='a' style='color:red'>&#65; &amp;</P>";
  const admitted = admitVisual(raw);
  const paragraph = admitted.document.content![0];
  paragraph.content = [{ type: "text", text: "Changed < & >" }];
  strictEqual(exportVisual(admitted.document), "<P class='a' style='color:red'>Changed &lt; &amp; &gt;</P>");
  strictEqual(protectedAttributes(exportVisual(admitted.document)), protectedAttributes(raw));
});
