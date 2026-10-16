import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { supportedStyleProperty, supportedStyleSelector } from "../../src/editor/richTextStylePolicy";

test("styled visual projection permits bounded typography, spacing and borders only", () => {
  for (const [key, value] of [["color", "rgb(10, 20, 30)"], ["font-size", "20px"], ["text-align", "center"], ["padding", "1em 4px"], ["border", "1px solid red"]]) strictEqual(supportedStyleProperty(key, value), true);
  for (const [key, value] of [["background-image", "url(https://example.test)"], ["color", "var(--secret)"], ["width", "999999px"], ["animation", "spin 1ms infinite"], ["position", "fixed"], ["font-size", "x".repeat(257)], ["color", "u\\72l(x)"]]) strictEqual(supportedStyleProperty(key, value), false);
  strictEqual(supportedStyleProperty("font-size", "1e100px"), false);
});
test("stylesheet selector profile bounds complexity without changing stored source", () => {
  for (const value of ["p", ".theme-primary", "h1, h2", "blockquote > p", "#table .caption"]) strictEqual(supportedStyleSelector(value), true);
  for (const value of ["p:has(*)", "[data-secret]", "p::before", "@import", ".x\\79", "x".repeat(257), Array(18).fill("p").join(",")]) strictEqual(supportedStyleSelector(value), false);
});
