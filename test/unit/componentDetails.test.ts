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

test("standard section classification does not collapse ordinary standard-value content", () => {
  const fields = componentItemDetails({ ...item, fields: [
    { ...field, containsStandardValue: true },
    { ...field, name: "__Updated", isStandardTemplate: false },
    { ...field, name: "System", isStandardTemplate: true },
  ] }, id, "en-AU").fields;
  equal(fields.find(value => value.provenance === "Standard value")?.isStandardTemplate, false);
  equal(fields.filter(value => value.isStandardTemplate).length, 2);
  equal(fields.length, 3);
});


test("Components offers page content editing while keeping per-field fallback guards", () => {
  const layout = { ...field, fieldId: "22222222222222222222222222222222", name: "__Renderings", type: "Layout", value: '<r><d l="{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}" /></r>', isStandardTemplate: true };
  equal(componentItemDetails({ ...item, fields: [field, layout] }, id, "en-AU").editable, true);
  equal(componentItemDetails({ ...item, fields: [layout] }, id, "en-AU").editable, false);
  equal(componentItemDetails({ ...item, fields: [{ ...field, containsFallbackValue: true }, layout] }, id, "en-AU").editable, false);
});


test("Components permits opening the editor before picker Source metadata loads", () => {
  equal(componentItemDetails({ ...item, fields: [{ ...field, type: "Droplink", typeKey: "droplink", selectionSource: undefined }] }, id, "en-AU").editable, true);
  const fallback = { ...field, fieldId: "22222222222222222222222222222222", name: "Fallback", containsFallbackValue: true };
  equal(componentItemDetails({ ...item, fields: [field, fallback] }, id, "en-AU").editable, true);
});

test("Media Library targets stay non-editable even with supported ordinary text fields", () => {
  equal(componentItemDetails({ ...item, path: "/sitecore/media library/Images/Logo" }, id, "en-AU").editable, false);
});
