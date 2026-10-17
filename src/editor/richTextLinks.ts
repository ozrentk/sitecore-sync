import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";

export interface RichLinkInfo { readonly kind: "sitecore" | "url" | "unknown"; readonly href: string; readonly itemId?: string; readonly reason?: string }
export type RichLinkDestination = { readonly kind: "sitecore"; readonly itemId: string } | { readonly kind: "url"; readonly href: string };
const guid = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\})$/iu;
export function richLinkId(value: string): string {
  if (!guid.test(value) || /^0+$/u.test(value.replace(/[{}-]/gu, ""))) throw new Error("Choose a valid Sitecore content item.");
  return value.replace(/[{}-]/gu, "").toLowerCase();
}
function anchor(open: string): P.Element {
  const errors: string[] = [];
  const fragment = parseFragment(open + "x</a>", { sourceCodeLocationInfo: true, onParseError: error => errors.push(error.code) });
  const node = fragment.childNodes[0];
  if (errors.length || !node || !("tagName" in node) || node.tagName !== "a" || node.sourceCodeLocation?.startTag?.endOffset !== open.length)
    throw new Error("Invalid anchor opening token. Use HTML.");
  return node;
}
export function validateRichLinkUrl(href: string): void {
  if (!href || href.length > 8192 || /[\s\\<>"'\x00-\x1f\x7f-\x9f]/u.test(href)) throw new Error("Enter a URL without whitespace, credentials or control characters.");
  if (/^https?:\/\//iu.test(href)) {
    let parsed: URL; try { parsed = new URL(href); } catch { throw new Error("Enter a valid HTTP(S) URL."); }
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error("URLs with credentials are not supported.");
    return;
  }
  if (/^mailto:[^@?&#:%]+@[^@?&#:%]+$/iu.test(href) || /^#[^#]+$/u.test(href)) return;
  if (/^\/(?!\/)/u.test(href) && !/link\.aspx|\/-\/media\/|\/~\/media\//iu.test(href)) return;
  throw new Error("Use HTTP(S), a root-relative path, one mailto address or a #fragment. Sitecore targets must use the picker.");
}

/** Only the documented ID-based URI and an already-matching optional mirror are managed. */
export function inspectRichLink(open: string): RichLinkInfo {
  const node = anchor(open); const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
  const href = attrs.href ?? "";
  if (/^(?:javascript|vbscript|data|file|blob):/iu.test(href.replace(/[\s\x00-\x1f]/gu, "")))
    throw new Error("Executable or local-resource links are HTML-only; they are never enabled in Visual.");
  const unknown = node.attrs.some(a => !["href", "class", "style", "title", "target", "rel", "data-sc-id"].includes(a.name));
  const unmanaged = (reason: string): RichLinkInfo => ({ kind: "unknown", href, reason });
  if (unknown) return unmanaged("Custom, identity or DAM link metadata is preserved. Change its destination or remove it in HTML.");
  const internal = /^~\/link\.aspx\?([^#]+)(#[^\s#]*)?$/iu.exec(href);
  if (internal) {
    const params = new URLSearchParams(internal[1]); const entries = [...params.entries()];
    if (entries.length !== 2 || internal[1].split("&").some(part => !/^_(?:id|z)=/u.test(part)) || params.getAll("_id").length !== 1 || params.getAll("_z").length !== 1 || params.get("_z") !== "z")
      return unmanaged("This Sitecore link has unsupported identity/query parameters. Edit its destination in HTML.");
    try {
      const itemId = richLinkId(params.get("_id")!);
      if (attrs["data-sc-id"] !== undefined && richLinkId(attrs["data-sc-id"]) !== itemId)
        return unmanaged("The href and data-sc-id identify different items. Reconcile them in HTML before changing the target.");
      return { kind: "sitecore", href, itemId };
    } catch { return unmanaged("The Sitecore link identity is invalid. Correct it in HTML."); }
  }
  if (attrs["data-sc-id"] !== undefined || /link\.aspx|\/-\/media\/|\/~\/media\/|stylelabs|contenthub/iu.test(href))
    return unmanaged("This managed/media link variant is not supported for destination editing. Use HTML.");
  try { validateRichLinkUrl(href); return { kind: "url", href }; }
  catch (error) { return unmanaged((error as Error).message); }
}
const encode = (value: string): string => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
function replaceAttributes(open: string, values: Record<string, string | null>): string {
  const node = anchor(open); let result = open;
  const present = new Set(node.attrs.map(a => a.name));
  for (const attr of [...node.attrs].reverse()) {
    if (!Object.hasOwn(values, attr.name) || values[attr.name] === attr.value) continue;
    const location = node.sourceCodeLocation!.attrs![attr.name];
    result = result.slice(0, location.startOffset) + (values[attr.name] === null ? "" : `${attr.name}="${encode(values[attr.name]!)}"`) + result.slice(location.endOffset);
  }
  const added = Object.entries(values).filter(([key, value]) => !present.has(key) && value !== null).map(([key, value]) => ` ${key}="${encode(value!)}"`).join("");
  return result.replace(/>$/u, added + ">");
}
function formatId(id: string, original: string): string {
  let value = /[a-f]/u.test(original) && !/[A-F]/u.test(original) ? id : id.toUpperCase();
  if (original.includes("-")) value = `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
  return original.startsWith("{") ? `{${value}}` : value;
}
export function changeRichLink(open: string | undefined, destination: RichLinkDestination): string {
  const old = open ? inspectRichLink(open) : undefined;
  if (old?.reason) throw new Error(old.reason);
  const token = open ?? "<a>";
  const attrs = Object.fromEntries(anchor(token).attrs.map(a => [a.name, a.value]));
  if (destination.kind === "url") {
    validateRichLinkUrl(destination.href);
    // Changing link kind is explicit; associated identity must not remain stale.
    const next = replaceAttributes(token, { href: destination.href, ...(attrs["data-sc-id"] !== undefined ? { "data-sc-id": null } : {}) });
    const checked = inspectRichLink(next);
    if (checked.reason) throw new Error(checked.reason);
    return next;
  }
  const id = richLinkId(destination.itemId);
  if (old?.kind === "sitecore" && old.itemId === id) return token;
  const href = old?.kind === "sitecore"
    ? old.href.replace(/([?&]_id=)[^&#]+/u, (_match, prefix: string) => prefix + id.toUpperCase())
    : `~/link.aspx?_id=${id.toUpperCase()}&_z=z`;
  return replaceAttributes(token, { href, ...(attrs["data-sc-id"] !== undefined ? { "data-sc-id": formatId(id, attrs["data-sc-id"]) } : {}) });
}
/** Removing link behavior retains unrelated styling/title in a span instead of discarding it. */
export function unlinkRichText(open: string): string | undefined {
  const info = inspectRichLink(open); if (info.reason) throw new Error(info.reason);
  const node = anchor(open); const removed = ["href", "data-sc-id", "target", "rel"];
  if (!node.attrs.some(a => !removed.includes(a.name))) return undefined;
  return replaceAttributes(open, Object.fromEntries(removed.map(key => [key, null]))).replace(/^<a\b/iu, "<span");
}

/** Enumerate only the bounded managed profile; unknown HTML-only variants are never guessed. */
export function richLinkTargets(raw: string): Set<string> {
  const result = new Set<string>();
  const root = parseFragment(raw, { sourceCodeLocationInfo: true });
  function visit(node: P.ChildNode): void {
    if (!("tagName" in node)) return;
    if (node.tagName === "a" && node.sourceCodeLocation?.startTag) {
      try { const info = inspectRichLink(raw.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.startTag.endOffset)); if (info.itemId && !info.reason) result.add(info.itemId); } catch { /* HTML-only content is not rewritten or projected by this inventory. */ }
    }
    node.childNodes.forEach(visit);
  }
  root.childNodes.forEach(visit); return result;
}

export function newRichLinkTargets(before: string, after: string): string[] {
  const old = richLinkTargets(before); return [...richLinkTargets(after)].filter(id => !old.has(id));
}
