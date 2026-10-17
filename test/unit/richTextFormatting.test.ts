import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { formatManagedHtml } from "../../src/editor/richTextFormatting";
test("managed HTML deeply indents tokens and deliberately normalizes inline boundary whitespace", () => {
  const input = '<h6 style="text-align: center;"><span class="theme-primary">Heading</span>\n</h6><p>Before <a href="~/link.aspx?_id=ABC&amp;_z=z">the link</a> after (‘<span>&lt;VALUE&gt;</span>’).</p><p>&nbsp;</p>';
  const expected = `<h6 style="text-align: center;">
  <span class="theme-primary">
    Heading
  </span>
</h6>
<p>
  Before
  <a href="~/link.aspx?_id=ABC&amp;_z=z">
    the link
  </a>
  after (‘
  <span>
    &lt;VALUE&gt;
  </span>
  ’).
</p>
<p>
</p>`;
  strictEqual(formatManagedHtml(input), expected);
  strictEqual(formatManagedHtml(expected), expected);
  strictEqual(formatManagedHtml('<p>\u00a0</p><p>&#160;</p><p>&#xA0;</p>'), '<p>\n</p>\n<p>\n</p>\n<p>\n</p>');
  strictEqual(formatManagedHtml('<p>A&nbsp;B</p>'), '<p>\n  A&nbsp;B\n</p>');
});
test("formatting preserves opaque and whitespace-sensitive content and enforces budgets", () => {
  for (const raw of ['<pre>  A\n B</pre>', '<style>p { color:red }\n</style>', '<blockquote style="white-space: pre"><p>A</p><p>B</p></blockquote>', '<p><img src="x"></p>']) {
    const formatted = formatManagedHtml(raw);
    strictEqual(formatted.includes(raw.includes('<img') ? '<img src="x">' : raw), true);
    strictEqual(formatManagedHtml(formatted), formatted);
  }
  const bounded = '<p>x</p>'.repeat(2000); strictEqual(formatManagedHtml(bounded), bounded);
  const table = '<table>\n  <tbody>\n    <tr>\n      <td>\n        One\n      </td>\n    </tr>\n  </tbody>\n</table>';
  strictEqual(formatManagedHtml('<table><tbody><tr><td>One</td></tr></tbody></table>'), table);
});
