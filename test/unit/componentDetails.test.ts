import { test } from "node:test";
import { equal, throws } from "node:assert/strict";
import { componentItemDetails } from "../../src/editor/componentDetails";
import type { AuthoringItemDetails, AuthoringItemField } from "../../src/sitecore/authoringClient";

const id = "11111111111111111111111111111111";
const field: AuthoringItemField = { fieldId: id, name: "Text", label: "Text", type: "Rich Text", typeKey: "richtext",
  value: '<p style="text-align:center">Stored</p>', scope: "VERSIONED", sortOrder: 0, sectionName: "Content", sectionSortOrder: 0,
  isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: true };
const item: AuthoringItemDetails = { itemId: id, name: "Text", displayName: "Text", path: "/sitecore/content/Data/Text",
  hasChildren: false, language: "en-AU", version: 2, template: { templateId: id, name: "Text" }, availableVersions: [], fields: [field] };
test("component details retains raw content and exact numbered locale without inferring Preview provenance", () => {
  const details = componentItemDetails(item, id, "en-AU");
  equal(details.fields[0].raw, field.value);
  equal(details.fields[0].presentation.kind, "richtext");
  equal(details.version, 2);
  equal(details.editable, true);
  equal(componentItemDetails({ ...item, version: 0, fields: [] }, id, "en-AU").editable, false);
  equal(componentItemDetails({ ...item, fields: [{ ...field, containsFallbackValue: true }] }, id, "en-AU").editable, false);
  equal(componentItemDetails({ ...item, path: "/sitecore/templates/Text" }, id, "en-AU").editable, false);
  throws(() => componentItemDetails(item, "22222222222222222222222222222222", "en-AU"));
  throws(() => componentItemDetails(item, id, "en"));
});
test("component details deduplicates supported references and bounds displayed fields", () => {
  const relation = { ...field, type: "Treelist", typeKey: "treelist", value: "{22222222-2222-2222-2222-222222222222}|{22222222-2222-2222-2222-222222222222}" };
  equal(componentItemDetails({ ...item, fields: [relation] }, id, "en-AU").references.length, 1);
  throws(() => componentItemDetails({ ...item, fields: Array.from({ length: 501 }, () => field) }, id, "en-AU"));
  throws(() => componentItemDetails({ ...item, fields: [{ ...field, value: "x".repeat(1024 * 1024 + 1) }] }, id, "en-AU"));
});
