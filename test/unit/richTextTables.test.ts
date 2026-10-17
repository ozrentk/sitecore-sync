import { test } from "node:test";
import { strictEqual, throws } from "node:assert/strict";
import { admitVisual, exportVisual, htmlSignature, protectedAttributes } from "../../src/editor/richTextAdmission";
import { richTableHtml, simpleTableHtml } from "../fixtures/richTextTables";

test("table admission preserves explicit sections, columns, caption, overflow wrapper and cell metadata", () => {
  for (const raw of [richTableHtml, simpleTableHtml, '<table><tbody>\n<tr>\n<td rowspan="2">A</td><td><p>B</p></td></tr><tr><td>C</td></tr></tbody></table>']) {
    const admitted = admitVisual(raw);
    strictEqual(exportVisual(admitted.document), raw);
    strictEqual(htmlSignature(exportVisual(admitted.document)), htmlSignature(raw));
    strictEqual(protectedAttributes(exportVisual(admitted.document)), protectedAttributes(raw));
  }
});

test("table admission refuses repairs, invalid grids, cross-section spans, duplicate identities and unsupported cell containers", () => {
  for (const raw of [
    '<table><tr><td>A</td></tr></table>',
    '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></tbody></table>',
    '<table><tbody><tr><td rowspan="2">A</td></tr></tbody><tfoot><tr><td>B</td></tr></tfoot></table>',
    '<table><tbody><tr><td colspan="0">A</td></tr></tbody></table>',
    '<table id="x"><tbody><tr><td id="x">A</td></tr></tbody></table>',
    '<table><tbody><tr><td><div>A</div></td></tr></tbody></table>',
    '<table><tbody><tr><td><table><tbody><tr><td>A</td></tr></tbody></table></td></tr></tbody></table>',
    '<div><p>other content</p><table><tbody><tr><td>A</td></tr></tbody></table></div>',
    '<table><tbody><tr><td onclick="bad()">A</td></tr></tbody></table>',
    '<table><tbody></tbody></table>',
  ]) throws(() => admitVisual(raw), Error, raw);
});

test("structural authorization does not ignore arbitrary cell metadata or non-table identities", () => {
  const a = '<table><tbody><tr><td id="a" colspan="2">A</td></tr></tbody></table>';
  const b = a.replace('colspan="2"', 'colspan="3"');
  strictEqual(protectedAttributes(a, true), protectedAttributes(b, true));
  strictEqual(protectedAttributes(a, true) === protectedAttributes(a.replace('id="a"', 'id="b"'), true), false);
});
