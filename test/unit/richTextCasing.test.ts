import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { replacementText, validReplaceInput } from "../../src/editor/richTextSearchInput";
test("replacement casing is Unicode aware and leaves ambiguous patterns as entered", () => {
  for (const [match, replacement, expected] of [
    ["pro", "AQUA", "aqua"], ["Pro", "aqua", "Aqua"], ["PRO", "aqua", "AQUA"],
    ["pRo", "aQua", "aQua"], ["123", "aQua", "aQua"], ["PRO", "straße", "STRASSE"],
    ["Été", "éCOLE", "École"], ["Pro", "'aqua", "'Aqua"], ["PRO", "", ""],
    ["Pro Max", "aqua blue", "aqua blue"]
  ]) strictEqual(replacementText(match, replacement, true), expected);
  strictEqual(replacementText("PRO", "aqua"), "aqua");
  const input = { query: "pro", matchCase: false, direction: "next", replacement: "aqua", all: true };
  strictEqual(validReplaceInput(input), true);
  strictEqual(validReplaceInput({ ...input, preserveCase: true }), true);
  strictEqual(validReplaceInput({ ...input, preserveCase: "true" }), false);
});
