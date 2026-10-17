import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { formatManagedHtml } from "../../src/editor/richTextFormatting";
test("managed HTML gains block indentation without rewriting inline text, attributes or existing line endings", () => {
  strictEqual(formatManagedHtml('<p>A <span title="keep"> B </span>C</p><p>D</p>'), '<p>A <span title="keep"> B </span>C</p>\n<p>D</p>');
  const raw = '<p>A</p>\r\n<p>B</p>'; strictEqual(formatManagedHtml(raw), raw);
  const table = '<table>\n  <tbody>\n    <tr>\n      <td>One</td>\n    </tr>\n  </tbody>\n</table>';
  strictEqual(formatManagedHtml('<table><tbody><tr><td>One</td></tr></tbody></table>'), table);
  strictEqual(formatManagedHtml(table), table);
  const sensitive = '<blockquote style="white-space: pre"><p>A</p><p>B</p></blockquote>';
  strictEqual(formatManagedHtml(sensitive), sensitive);
  const bounded = '<p>x</p>'.repeat(2000); strictEqual(formatManagedHtml(bounded), bounded);
});
