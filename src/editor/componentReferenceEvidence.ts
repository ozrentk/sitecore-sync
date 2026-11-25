import { isGuid } from "./itemEditorModel";
import { referenceId } from "../sitecore/previewReferences";

/** Only explicit item fields with ordered item arrays or typed link values provide parity evidence.
 * Custom resolver JSON and absent fields do not establish absence of references. */
export function previewReferenceEvidence(report: unknown): Map<string, Record<string, readonly string[]>> {
  const result = new Map<string, Record<string, readonly string[]>>();
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  let count = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++count > 50000 || depth > 100) throw Error("Layout reference evidence exceeds limits.");
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    if (!record(value)) return;
    const id = isGuid(value.id) ? value.id : isGuid(value.dataSource) ? value.dataSource : undefined;
    if (id && record(value.fields)) {
      const fields = result.get(referenceId(id)) ?? Object.create(null) as Record<string, readonly string[]>;
      for (const [name, field] of Object.entries(value.fields)) {
        let ids: string[];
        if (Array.isArray(field) && field.every(target => record(target) && isGuid(target.id))) {
          ids = field.map(target => referenceId((target as { id: string }).id));
        } else if (record(field) && record(field.value) && typeof field.value.linktype === "string") {
          if (field.value.linktype === "internal" && isGuid(field.value.id)) ids = [referenceId(field.value.id)];
          else if (["external", "mailto", "anchor"].includes(field.value.linktype)) ids = [];
          else continue;
        } else if (record(field) && record(field.value) && Object.hasOwn(field.value, "mediaid") && field.value.mediaid) {
          // Only explicit media identity is comparable; asset URLs/connector IDs are not.
          ids = isGuid(field.value.mediaid) ? [referenceId(field.value.mediaid)] : ["invalid-layout-media-identity"];
        } else continue;
        // Conflicting occurrences must not let the last one silently win.
        fields[name] = fields[name] && JSON.stringify(fields[name]) !== JSON.stringify(ids) ? ["conflicting-layout-occurrences"] : ids;
      }
      result.set(referenceId(id), fields);
    }
    for (const child of Object.values(value)) if (typeof child === "object" && child !== null) visit(child, depth + 1);
  };
  visit(report, 0); return result;
}
