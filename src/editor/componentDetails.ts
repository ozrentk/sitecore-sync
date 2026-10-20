import type { AuthoringItemDetails } from "../sitecore/authoringClient";
import { fieldPresentation } from "../sitecore/fieldPresentation";
import { parseReferenceField } from "../publishing/referenceDiscovery";
import { hasPagePresentation } from "../publicPages/publicPageUrl";
import { orderEditorFields } from "./fieldOrder";
import { isGuid } from "./itemEditorModel";

export function componentItemDetails(item: AuthoringItemDetails, expectedId: string, language: string) {
  const normalize = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
  if (!isGuid(item.itemId) || normalize(item.itemId) !== normalize(expectedId)
    || item.language.toLowerCase() !== language.toLowerCase() || !Number.isSafeInteger(item.version) || item.version < 0) {
    throw Error("Item identity or locale mismatch.");
  }
  if (item.fields.length > 500 || item.fields.reduce((sum, field) => sum + field.value.length, 0) > 1024 * 1024) {
    throw Error("Details exceed the inspection limits.");
  }
  const references = new Map<string, { id: string; field: string }>();
  for (const field of item.fields) {
    // Presentation is not a content relationship; do not offer the owning layout as a datasource.
    if (/layout/iu.test(`${field.type} ${field.typeKey}`)) continue;
    for (const reference of parseReferenceField(field).itemReferences) {
      if (!isGuid(reference.target)) continue;
      const key = normalize(reference.target);
      if (!references.has(key)) references.set(key, { id: reference.target, field: field.label || field.name });
    }
  }
  const editable = item.version > 0 && item.path.toLowerCase().startsWith("/sitecore/content/")
    && !hasPagePresentation(item) && !item.fields.some(field => field.containsFallbackValue);
  return {
    itemId: item.itemId, name: item.displayName || item.name, path: item.path,
    requestedLanguage: language, returnedLanguage: item.language, version: item.version,
    effectiveLanguage: item.version === 0 ? "Unavailable (no exact-locale version)"
      : item.fields.some(field => field.containsFallbackValue) ? "Unknown (fallback source unverified)" : item.language,
    editable,
    editReason: editable ? "" : "Edit requires an ordinary content item with a verified exact-locale version and no fallback values.",
    fields: orderEditorFields(item.fields).map(field => ({
      id: field.fieldId, name: field.label || field.name, section: field.sectionName || "Fields",
      isStandardTemplate: field.isStandardTemplate || field.name.startsWith("__"),
      type: field.type, scope: field.scope, raw: field.value, presentation: fieldPresentation(field.type, field.value),
      provenance: field.containsFallbackValue ? "Fallback source unknown" : field.containsStandardValue ? "Standard value" : "Exact locale",
    })),
    references: [...references.values()].slice(0, 100),
    referencesLimited: references.size > 100,
  };
}
