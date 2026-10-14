import type { AuthoringItemField } from "../sitecore/authoringClient";
import { EditorValidationError, isGuid, normalizeId } from "./itemEditorModel";
import { selectionSourceReason, type SelectionIO } from "./singleSelection";

export const linkKeys = ["linktype", "id", "url", "text", "title", "target", "class", "anchor", "querystring"] as const;
type LinkKey = typeof linkKeys[number];
export type LinkValues = Record<LinkKey, string>;
interface Attribute { readonly name: string; readonly value: string; readonly start: number; readonly end: number }
interface LinkDocument { readonly raw: string; readonly attributes: readonly Attribute[]; readonly insert: number; readonly values: LinkValues; readonly custom: boolean }
export const isGeneralLink = (field: AuthoringItemField): boolean => field.type.toLowerCase() === "general link";
const empty = (): LinkValues => ({ linktype: "external", id: "", url: "", text: "", title: "", target: "", class: "", anchor: "", querystring: "" });
function validText(value: string): boolean {
  return value.length <= 65536 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(value);
}
function decodeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/u.test(value) || value.includes("<")) throw new EditorValidationError("Malformed link XML attribute.");
  const decoded = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (_all, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (code > 0x10ffff || code < 0 || (code >= 0xd800 && code <= 0xdfff)) throw new EditorValidationError("Invalid link XML character.");
    return String.fromCodePoint(code);
  });
  if (!validText(decoded)) throw new EditorValidationError("Unsupported link attribute text; original XML is preserved.");
  return decoded;
}
function encodeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}
/** Bounded grammar, not an XML document loader: no DTDs, entities, namespaces or child nodes. */
export function parseGeneralLink(raw: string): LinkDocument {
  if (!raw) return { raw, attributes: [], insert: 0, values: empty(), custom: false };
  if (raw.length > 262144) throw new EditorValidationError("General Link exceeds the supported size.");
  const opening = /^\s*<link(?=\s|\/|>)/u.exec(raw);
  if (!opening) throw new EditorValidationError("Unsupported General Link XML; original value is preserved.");
  let offset = opening[0].length; const attributes: Attribute[] = []; const names = new Set<string>();
  const token = /\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
  while (true) {
    token.lastIndex = offset; const match = token.exec(raw); if (!match) break;
    const name = match[1];
    if (names.has(name.toLowerCase()) || name === "xmlns" || (linkKeys.includes(name.toLowerCase() as LinkKey) && name !== name.toLowerCase())) throw new EditorValidationError("Duplicate or unsupported General Link attribute.");
    names.add(name.toLowerCase());
    attributes.push({ name, value: decodeXml(match[2] ?? match[3]), start: offset, end: token.lastIndex }); offset = token.lastIndex;
    if (attributes.length > 128) throw new EditorValidationError("General Link has too many attributes.");
  }
  if (!/^\s*(?:\/>|>\s*<\/link>)\s*$/u.test(raw.slice(offset))) throw new EditorValidationError("Malformed or unsupported General Link XML; original value is preserved.");
  const values = empty(); values.linktype = "";
  for (const attribute of attributes) if (linkKeys.includes(attribute.name as LinkKey)) values[attribute.name as LinkKey] = attribute.value;
  if (!["internal", "external", "mailto", "anchor"].includes(values.linktype)) throw new EditorValidationError("This link kind is read-only. Internal, external, email and anchor links are supported; media, JavaScript and connector kinds are deferred.");
  const custom = attributes.some(attribute => !linkKeys.includes(attribute.name as LinkKey));
  return { raw, attributes, insert: offset, values, custom };
}
export function linkSourceReason(field: AuthoringItemField): string | undefined {
  if (field.selectionSource === "") return undefined;
  return selectionSourceReason(field.selectionSource, "droptree");
}
export function linkSelectionField(field: AuthoringItemField): AuthoringItemField {
  return { ...field, type: "Droptree", selectionSource: field.selectionSource === "" ? "/sitecore/content" : field.selectionSource };
}
export function validateLinkValues(values: LinkValues): void {
  if (!["internal", "external", "mailto", "anchor"].includes(values.linktype)) throw new EditorValidationError("Select a supported link kind.");
  if (Object.values(values).some(value => typeof value !== "string" || !validText(value))) throw new EditorValidationError("Link properties contain unsupported text.");
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(values.url.trim())?.[1].toLowerCase();
  if (scheme && !["http", "https", ...(values.linktype === "mailto" ? ["mailto"] : [])].includes(scheme)) throw new EditorValidationError("This URL scheme is not supported.");
  if (values.target && !/^(?:_(?:blank|self|parent|top)|[A-Za-z][A-Za-z0-9_.-]*)$/u.test(values.target)) throw new EditorValidationError("Enter a standard target or a named browser frame.");
  if (values.anchor && /[\s#]/u.test(values.anchor)) throw new EditorValidationError("Enter an anchor without whitespace or a leading #.");
  if (values.linktype === "external") {
    let url: URL; try { url = new URL(values.url); } catch { throw new EditorValidationError("Enter an absolute http:// or https:// URL."); }
    if (!/^https?:\/\//iu.test(values.url) || !["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/u.test(values.url)) throw new EditorValidationError("Only absolute HTTP(S) URLs without credentials or whitespace are supported.");
  } else if (values.linktype === "mailto") {
    if (!/^mailto:[^\s@?&#:%]+@[^\s@?&#:%]+$/iu.test(values.url)) throw new EditorValidationError("Enter one email address without headers or query parameters.");
  } else if (values.linktype === "anchor") {
    const anchor = values.url || values.anchor;
    if (!anchor || /[\s#]/u.test(anchor)) throw new EditorValidationError("Enter an anchor name without whitespace or a leading #.");
    if (values.url && values.anchor && values.url !== values.anchor) throw new EditorValidationError("Conflicting anchor destinations are read-only; original XML is preserved.");
  }
  else if (values.linktype === "internal" && (!isGuid(values.id) || /^0+$/u.test(normalizeId(values.id)))) throw new EditorValidationError("Choose an internal target item.");
}
export function generalLinkInput(raw: string): string { return JSON.stringify({ _xml: raw, ...parseGeneralLink(raw).values }); }
export function serializeGeneralLink(raw: string, input: string): string {
  const current = parseGeneralLink(raw); const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== linkKeys.length + 1
    || typeof (parsed as { _xml?: unknown })._xml !== "string"
    || linkKeys.some(key => !Object.hasOwn(parsed, key) || typeof (parsed as LinkValues)[key] !== "string")) throw new EditorValidationError("Invalid General Link draft.");
  const template = parseGeneralLink((parsed as { _xml: string })._xml);
  const customAttributes = (document: LinkDocument) => document.attributes.filter(a => !linkKeys.includes(a.name as LinkKey)).map(a => document.raw.slice(a.start, a.end));
  if (raw && JSON.stringify(customAttributes(current)) !== JSON.stringify(customAttributes(template))) throw new EditorValidationError("Custom link attributes cannot be added, changed or removed by a field edit.");
  // Retain the original XML for native Undo after a confirmed Clear/Save.
  const document = raw ? current : template;
  const values = Object.fromEntries(linkKeys.map(key => [key, (parsed as LinkValues)[key]])) as LinkValues;
  const previous = document.values;
  validateLinkValues(values);
  if (linkKeys.every(key => values[key] === previous[key])) return document.raw;
  const modified = linkKeys.filter(key => values[key] !== previous[key]);
  if (document.custom && modified.some(key => !["text", "title", "target", "class"].includes(key))) throw new EditorValidationError("Custom link metadata is preserved. Only link text, title, target and CSS class may be edited on this link.");
  if (linkKeys.every(key => values[key] === template.values[key])) return template.raw;
  // Only applicable destination attributes may change. Existing extra ordinary attributes remain untouched.
  const applicable = ["linktype", "text", "title", "target", "class", "anchor", ...(values.linktype === "internal" ? ["id", "querystring"] : ["url"])];
  for (const key of modified) if (!applicable.includes(key) && values[key] !== "") throw new EditorValidationError("This property does not apply to the selected link kind.");
  let result = document.raw || "<link />"; const insert = document.raw ? document.insert : 5;
  const present = new Set(document.attributes.map(attribute => attribute.name));
  const added = linkKeys.filter(key => !present.has(key) && (values[key] || key === "linktype"))
    .map(key => ` ${key}="${encodeXml(values[key])}"`).join("");
  result = result.slice(0, insert) + added + result.slice(insert);
  for (const attribute of [...document.attributes].reverse()) {
    const key = attribute.name as LinkKey;
    if (modified.includes(key)) result = result.slice(0, attribute.start) + ` ${key}="${encodeXml(values[key])}"` + result.slice(attribute.end);
  }
  return result;
}
/** Changed destinations are resolved on the pinned connection; retained unresolved IDs are not replaced. */
export async function validateLinkTarget(field: AuthoringItemField, value: string, io: SelectionIO): Promise<void> {
  const reason = linkSourceReason(field); if (reason) throw new EditorValidationError(reason);
  if (!value) return;
  const next = parseGeneralLink(value).values; const before = parseGeneralLink(field.value).values;
  if (next.linktype !== "internal" || (before.linktype === "internal" && normalizeId(before.id) === normalizeId(next.id))) return;
  const source = linkSelectionField(field).selectionSource!;
  const sourceIsId = Boolean(isGuid(source));
  const root = await io.item(sourceIsId ? { itemId: source } : { path: source });
  const target = await io.item({ itemId: next.id });
  if (!isGuid(root.itemId) || !isGuid(target.itemId) || normalizeId(target.itemId) !== normalizeId(next.id)
    || (sourceIsId ? normalizeId(root.itemId) !== normalizeId(source) : root.path.toLowerCase() !== source.toLowerCase())
    || [root.path, target.path].some(path => /[\\\x00-\x1f]/u.test(path) || path.split("/").some(segment => segment === "." || segment === ".."))
    || !/^\/sitecore\/content(?:\/|$)/iu.test(target.path)
    || !(target.path.toLowerCase() === root.path.toLowerCase() || target.path.toLowerCase().startsWith(`${root.path.toLowerCase()}/`))) throw new EditorValidationError("Internal link target is unavailable or outside the field Source.");
}
