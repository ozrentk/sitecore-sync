import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { compareEditorFields } from "../../src/editor/fieldOrder";
import type { AuthoringItemField } from "../../src/sitecore/authoringClient";

const field = (sectionName: string, sectionSortOrder: number, sortOrder: number, name: string): AuthoringItemField => ({
  sectionName, sectionSortOrder, sortOrder, name, fieldId: name, label: name, value: "", type: "Single-Line Text", typeKey: "text",
  scope: "VERSIONED", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false,
  containsStandardValue: false, textual: true,
});

test("section names break section-order ties before field order or name", () => {
  const fields = [field("Image Data", 0, -100, "Alpha"), field("Content Data", 0, 100, "Zulu"), field("Text Block Data", -100, 200, "Text")];
  deepStrictEqual(fields.sort(compareEditorFields).map(f => f.sectionName), ["Text Block Data", "Content Data", "Image Data"]);
});

test("explicit section order wins over names; fields retain their own order within a section", () => {
  const fields = [field("Content Data", 100, 0, "First"), field("Image Data", 0, 20, "Zulu"), field("Image Data", 0, 20, "Alpha"), field("Image Data", 0, 10, "Last")];
  deepStrictEqual(fields.sort(compareEditorFields).map(f => f.name), ["Last", "Alpha", "Zulu", "First"]);
});

test("missing section names and equal metadata retain stable order", () => {
  const fields = [field("", 0, 0, "a"), field("", 0, 0, "A"), field("Content", 0, 0, "Earlier")];
  deepStrictEqual(fields.sort(compareEditorFields).map(f => f.name), ["a", "A", "Earlier"]);
});
