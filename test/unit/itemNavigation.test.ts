import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { classifyNavigationInput, isWithinPath } from "../../src/comparison/itemNavigation";

test("navigation recognizes exact GUID forms and paths, rejecting malformed IDs", () => {
  for (const value of ["0123456789abcdef0123456789abcdef", "01234567-89ab-cdef-0123-456789abcdef", "{01234567-89AB-cdef-0123-456789abcdef}", " {0123456789abcdef0123456789abcdef} "]) {
    deepStrictEqual(classifyNavigationInput(value), { kind: "id", locator: { itemId: "0123456789abcdef0123456789abcdef" } });
  }
  deepStrictEqual(classifyNavigationInput(" /sitecore/content/ "), { kind: "path", locator: { path: "/sitecore/content" } });
  strictEqual(classifyNavigationInput("  ").kind, "empty");
  strictEqual(classifyNavigationInput("Vehicle Prices").kind, "name");
  for (const value of ["01234567-89ab-cdef-0123-456789abcdeg", "{bad-id}", "0123456789abcdef0123456789abcde", "/sitecore/../x", "x".repeat(2049)]) {
    strictEqual(classifyNavigationInput(value).kind, "invalid");
  }
  strictEqual(isWithinPath("/sitecore/content", "/"), true);
  strictEqual(isWithinPath("/sitecore/content/child", "/SITECORE/CONTENT"), true);
  strictEqual(isWithinPath("/sitecore/content2", "/sitecore/content"), false);
});
