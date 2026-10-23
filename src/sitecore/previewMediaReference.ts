import { mediaAttributes } from "./fieldPresentation";
import type { PreviewLinkReference } from "./previewGeneralLink";

export interface PreviewMediaReference extends PreviewLinkReference {
  targetKind?: "media";
  evidenceLabel: "Asset information";
}

/** Only stored mediaid is an item identity. Asset URLs and connector IDs never are. */
export function previewMediaReference(raw: string, kind: "image" | "file", assetUrl: unknown): PreviewMediaReference {
  const result: PreviewMediaReference = { targets: [], rawValue: raw, evidenceLabel: "Asset information" };
  if (!raw.trim()) return assetUrl === null || assetUrl === "" ? result : { ...result, issue: "Empty asset has inconsistent Preview evidence; unresolved." };
  try {
    const attributes = mediaAttributes(raw, kind), attrs = Object.fromEntries(attributes);
    const id = attrs.mediaid ?? "", source = attrs.src || attrs.url || "";
    const connector = attributes.some(([name]) => /^(?:dam-|stylelabs-)/u.test(name));
    let contentHub = connector;
    try { contentHub ||= /(?:^|\.)(?:stylelabs\.(?:cloud|com|io)|sitecorecontenthub\.cloud)$/iu.test(new URL(source).hostname); } catch { /* No URL-derived item identity. */ }
    if (contentHub) return { ...result, destination: { kind: "content-hub", value: source || "Connector asset (no URL)" },
      issue: id ? "Mixed connector and media item identity; unresolved, not followed." : undefined };
    if (!id) {
      if (source) return { ...result, destination: { kind: "external", value: source }, issue: "Asset URL has no explicit Sitecore media item identity; not followed." };
      return { ...result, issue: "Asset has no verified media item identity; unresolved." };
    }
    if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\})$/iu.test(id)
      || /^0+$/u.test(id.replace(/[{}-]/gu, ""))) return { ...result, issue: "Malformed media item identity; unresolved." };
    const known = new Set(["mediaid", "src", "url", "alt", "height", "width", "hspace", "vspace", "border", "class", "title"]);
    if (attributes.some(([name]) => !known.has(name)) || (attrs.src && attrs.url && attrs.src !== attrs.url)) {
      return { ...result, targets: [id], targetKind: "media", issue: "Unsupported asset metadata; unresolved." };
    }
    if (source) {
      const path = new URL(source.replace(/^~\//u, "/"), "https://media.invalid").pathname;
      if (!/^\/(?:-|~)\/media\//iu.test(path)) return { ...result, targets: [id], targetKind: "media", issue: "Mixed asset URL and media item identity; unresolved." };
    }
    return { ...result, targets: [id], targetKind: "media" };
  } catch { return { ...result, issue: "Malformed or unsupported asset XML; original value retained, no target inferred." }; }
}

export function isMediaLibraryPath(path: string | undefined): boolean {
  return typeof path === "string" && /^\/sitecore\/media library\/[^/]/iu.test(path)
    && !/[\\\u0000-\u001f]/u.test(path) && !path.split("/").some(part => part === "." || part === "..");
}
