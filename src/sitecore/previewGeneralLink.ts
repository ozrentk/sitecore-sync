import { parseGeneralLink, validateLinkValues } from "../editor/generalLink";
import { normalizeId } from "../editor/itemEditorModel";

export interface PreviewLinkReference {
  targets: readonly string[];
  rawValue: string;
  issue?: string;
  destination?: { kind: "external" | "email" | "anchor" | "content-hub"; value: string };
}

const guid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\})$/iu.test(value);

/** Read-only classification of raw XML plus typed Preview evidence. Never infer an ID from a URL. */
export function previewGeneralLink(raw: string, linkType: unknown, targetItem: unknown): PreviewLinkReference {
  const result: PreviewLinkReference = { targets: [], rawValue: raw };
  if (!raw.trim()) return linkType === null && targetItem === null ? result : { ...result, issue: "Empty link has inconsistent Preview evidence; unresolved." };
  try {
    const document = parseGeneralLink(raw);
    const values = document.values;
    if (linkType !== values.linktype) return { ...result, issue: "Raw and typed Preview link kinds disagree; unresolved." };
    validateLinkValues(values);
    const dam = document.attributes.some(attribute => /^(?:dam-|stylelabs-)/iu.test(attribute.name));
    let contentHub = dam;
    try { contentHub ||= /(?:^|\.)(?:stylelabs\.(?:cloud|com|io)|sitecorecontenthub\.cloud)$/iu.test(new URL(values.url).hostname); } catch { /* A relative internal URL is not a provider identity. */ }
    if (contentHub) return { ...result, destination: { kind: "content-hub", value: values.url },
      issue: values.linktype === "internal" || targetItem !== null ? "Mixed connector/internal identity; not followed." : undefined };
    if (values.linktype !== "internal") {
      return { ...result, destination: { kind: values.linktype === "mailto" ? "email" : values.linktype === "anchor" ? "anchor" : "external", value: values.url || values.anchor },
        issue: targetItem !== null ? "Non-item link has inconsistent target evidence; not followed." : undefined };
    }
    if (!guid(values.id)) return { ...result, issue: "Malformed internal target ID; unresolved." };
    if (document.custom) return { ...result, targets: [values.id], issue: "Custom internal link attributes are unverified; unresolved." };
    const id = targetItem && typeof targetItem === "object" && !Array.isArray(targetItem) ? (targetItem as Record<string, unknown>).id : undefined;
    if (!guid(id) || normalizeId(id) !== normalizeId(values.id)) return { ...result, targets: [values.id],
      issue: targetItem === null ? "Internal link target is missing or inaccessible in Preview; unresolved." : "Raw and typed Preview target identities disagree; unresolved." };
    return { ...result, targets: [values.id] };
  } catch {
    return { ...result, issue: "Malformed or unsupported General Link; original value retained, no target inferred." };
  }
}
