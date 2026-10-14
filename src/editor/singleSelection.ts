import type { AuthoringItemField, AuthoringItemLocator, AuthoringTreeItem, AuthoringTreeLevel } from "../sitecore/authoringClient";
import { EditorValidationError, isGuid, normalizeId } from "./itemEditorModel";

export type SelectionKind = "droplist" | "droplink" | "grouped droplist" | "grouped droplink" | "droptree";
export interface SelectionChoice extends AuthoringTreeItem { readonly group?: string; readonly disabled?: string }
export interface SelectionPage { readonly root: AuthoringTreeItem; readonly parent: AuthoringTreeItem; readonly choices: readonly SelectionChoice[] }
export interface SelectionIO {
  item(locator: AuthoringItemLocator): Promise<AuthoringTreeItem>;
  children(locator: AuthoringItemLocator): Promise<AuthoringTreeLevel>;
}
export const selectionLimit = 1000;
export function selectionKind(field: AuthoringItemField): SelectionKind | undefined {
  const type = field.type.toLowerCase();
  return ["droplist", "droplink", "grouped droplist", "grouped droplink", "droptree"].includes(type) ? type as SelectionKind : undefined;
}
export function storesName(kind: SelectionKind): boolean { return kind === "droplist" || kind === "grouped droplist"; }
export function selectionSourceReason(source: string | undefined): string | undefined {
  if (source === undefined) return "Field Source metadata is unavailable. Reload after checking template access.";
  if (!source.trim()) return "An empty Source is not supported; unrestricted browsing is disabled.";
  if (isGuid(source) || validPath(source)) return undefined;
  return "Unsupported Source: only an absolute Sitecore root path or item ID is supported. Queries, relative paths, tokens and filters are read-only.";
}
function validPath(path: string): boolean {
  return /^\/sitecore(?:\/[^/]+)*$/iu.test(path) && path === path.trim()
    && !/[\\?*\[\]#{}$=|&:\x00-\x1f]/u.test(path) && !path.split("/").some(part => part === "." || part === "..");
}
function locator(field: AuthoringItemField): AuthoringItemLocator {
  const reason = selectionSourceReason(field.selectionSource);
  if (reason) throw new EditorValidationError(reason);
  return isGuid(field.selectionSource) ? { itemId: field.selectionSource } : { path: field.selectionSource! };
}
// Returned item paths are data, not Source expressions. Names can legitimately
// contain punctuation (for example braces) excluded by the Source parser.
function validItemPath(path: string): boolean {
  return /^\/sitecore(?:\/[^/]+)*$/iu.test(path) && !/[\\\x00-\x1f]/u.test(path)
    && !path.split("/").some(part => part === "." || part === "..");
}
function assertItem(item: AuthoringTreeItem): void {
  if (!isGuid(item.itemId) || !validItemPath(item.path) || !item.name || item.name.includes("|") || item.name.includes("/")) throw new EditorValidationError("Invalid selection item identity.");
}
function distance(root: string, path: string): number {
  const prefix = `${root.toLowerCase()}/`;
  return path.toLowerCase().startsWith(prefix) ? path.slice(prefix.length).split("/").length : 0;
}
async function children(parent: AuthoringTreeItem, io: SelectionIO): Promise<readonly AuthoringTreeItem[]> {
  const level = await io.children({ itemId: parent.itemId });
  if (normalizeId(level.item.itemId) !== normalizeId(parent.itemId) || level.item.path !== parent.path) throw new EditorValidationError("Selection source moved while loading. Reload choices.");
  const ids = new Set<string>();
  if (level.children.length > selectionLimit) throw new EditorValidationError("Selection source exceeds 1,000 choices.");
  for (const item of level.children) {
    assertItem(item);
    if (distance(parent.path, item.path) !== 1 || ids.has(normalizeId(item.itemId))) throw new EditorValidationError("Selection source returned inconsistent children. Reload choices.");
    ids.add(normalizeId(item.itemId));
  }
  return level.children;
}
export function selectionValue(kind: SelectionKind, choice: AuthoringTreeItem): string {
  if (storesName(kind)) return choice.name;
  const id = normalizeId(choice.itemId).toUpperCase();
  return `{${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}}`;
}
export async function loadSelectionPage(field: AuthoringItemField, io: SelectionIO, parentId?: string): Promise<SelectionPage> {
  const kind = selectionKind(field);
  if (!kind) throw new EditorValidationError("Not a single-selection field.");
  const root = await io.item(locator(field)); assertItem(root);
  let parent = root;
  if (parentId && normalizeId(parentId) !== normalizeId(root.itemId)) {
    if (kind !== "droptree" || !isGuid(parentId)) throw new EditorValidationError("Invalid selection branch.");
    parent = await io.item({ itemId: parentId }); assertItem(parent);
    if (!distance(root.path, parent.path)) throw new EditorValidationError("Selection branch is outside the configured Source.");
  }
  let choices: SelectionChoice[] = [...await children(parent, io)];
  if (kind.startsWith("grouped")) {
    const groups = choices;
    if (groups.length > 50) throw new EditorValidationError("Grouped Source exceeds 50 groups; this field is read-only.");
    choices = [];
    for (const group of groups) {
      choices.push(...(await children(group, io)).map(item => ({ ...item, group: `${group.displayName || group.name} · ${group.path}` })));
      if (choices.length > selectionLimit) throw new EditorValidationError("Selection source exceeds 1,000 choices.");
    }
  }
  if (storesName(kind)) {
    const counts = new Map<string, number>();
    for (const choice of choices) counts.set(choice.name.toLowerCase(), (counts.get(choice.name.toLowerCase()) ?? 0) + 1);
    choices = choices.map(choice => ({ ...choice, ...(counts.get(choice.name.toLowerCase())! > 1 ? { disabled: "Duplicate item name; cannot identify a unique selection." } : {}) }));
  }
  return { root, parent, choices };
}
/** Re-evaluate allowed membership against the current Source immediately before save. */
export async function validateSelection(field: AuthoringItemField, value: string, io: SelectionIO): Promise<void> {
  const kind = selectionKind(field)!;
  locator(field); // Even explicit clearing requires a supported, verified source form.
  if (kind === "droptree") {
    const root = await io.item(locator(field)); assertItem(root);
    if (!value) return;
    if (!isGuid(value)) throw new EditorValidationError("Select one item reference.");
    const selected = await io.item({ itemId: value }); assertItem(selected);
    if (!distance(root.path, selected.path)) throw new EditorValidationError("Selected item is outside the current Source.");
  } else {
    const page = await loadSelectionPage(field, io);
    if (!value) return;
    const matches = page.choices.filter(choice => storesName(kind) ? choice.name === value : isGuid(value) && normalizeId(choice.itemId) === normalizeId(value));
    if (matches.length !== 1 || matches[0].disabled) throw new EditorValidationError("Selection is unavailable, ambiguous or outside the current Source. Reload choices.");
  }
}
