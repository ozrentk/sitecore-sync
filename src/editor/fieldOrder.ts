import type { AuthoringItemField } from "../sitecore/authoringClient";

/** Section ordering must be resolved before any field-level sorting. */
export function compareEditorFields(left: AuthoringItemField, right: AuthoringItemField): number {
  return left.sectionSortOrder - right.sectionSortOrder
    || left.sectionName.localeCompare(right.sectionName, "en", { sensitivity: "base" })
    || left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, "en", { sensitivity: "base" });
}
