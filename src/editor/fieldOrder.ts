import type { AuthoringItemField } from "../sitecore/authoringClient";

/** Section ordering must be resolved before any field-level sorting. */
export function compareEditorFields(left: AuthoringItemField, right: AuthoringItemField): number {
  return left.sectionSortOrder - right.sectionSortOrder
    || left.sectionName.localeCompare(right.sectionName, "en", { sensitivity: "base" })
    || left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, "en", { sensitivity: "base" });
}

/** Inherited sections with the same name form one visual section. */
export function orderEditorFields(fields: readonly AuthoringItemField[]): AuthoringItemField[] {
  const groups = new Map<string, { order: number; fields: AuthoringItemField[] }>();
  for (const field of fields) {
    const name = field.sectionName || "Fields";
    const group = groups.get(name);
    if (group) { group.order = Math.min(group.order, field.sectionSortOrder); group.fields.push(field); }
    else groups.set(name, { order: field.sectionSortOrder, fields: [field] });
  }
  return [...groups].sort(([leftName, left], [rightName, right]) => left.order - right.order
    || leftName.localeCompare(rightName, "en", { sensitivity: "base" }))
    .flatMap(([, group]) => group.fields.sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name, "en", { sensitivity: "base" })));
}
