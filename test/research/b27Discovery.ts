/** Research-only contracts. No network, XML patch engine, UI, or production imports. */
export interface Context {
  connection: string; site: string; language: string; device: string; page: string;
}
export interface Instance {
  uid: string; renderingId: string; placeholder: string; datasource: string;
  rawParameters: string; parentUid?: string; rootPlacement?: boolean;
}
export interface LayoutEvidence {
  context: Context;
  origin: "authoring-resolved" | "raw-fields" | "published-edge";
  complete: boolean;
  instances: readonly Instance[];
}
export type LayoutResult = { state: "unresolved"; reason: string } | {
  state: "resolved";
  instances: readonly (Instance & { occurrenceKey: string; placement: "resolved" | "Placement unresolved" })[];
};
export function layout(context: Context, evidence: LayoutEvidence): LayoutResult {
  // A provider must independently establish resolution. Raw XML, even patch-free XML,
  // does not prove template inheritance, partial designs, device or final-layout semantics.
  if (evidence.origin !== "authoring-resolved" || !evidence.complete)
    return { state: "unresolved", reason: "Effective authoring layout is unverified" };
  if (Object.keys(context).some(key => context[key as keyof Context] !== evidence.context[key as keyof Context]))
    return { state: "unresolved", reason: "Layout context mismatch" };
  const uids = new Map<string, Instance>();
  for (const instance of evidence.instances) {
    const uid = id(instance.uid);
    if (!uid || !id(instance.renderingId) || uids.has(uid))
      return { state: "unresolved", reason: "Invalid or duplicate rendering instance identity" };
    uids.set(uid, instance);
  }
  function placed(instance: Instance): boolean {
    const visited = new Set<string>([id(instance.uid)!]);
    let current = instance;
    while (current.parentUid) {
      if (current.rootPlacement) return false;
      const parent = id(current.parentUid);
      if (!parent || visited.has(parent) || !uids.has(parent)) return false;
      visited.add(parent); current = uids.get(parent)!;
    }
    return current.rootPlacement === true;
  }
  return { state: "resolved", instances: evidence.instances.map(instance => ({
    ...instance, occurrenceKey: `${context.device}/${id(instance.uid)}`,
    placement: placed(instance) ? "resolved" : "Placement unresolved",
  })) };
}
export function id(value: string): string | undefined {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\})$/iu.test(value)
    ? value.replace(/[{}-]/gu, "").toLowerCase() : undefined;
}
function path(value: string): boolean {
  return /^\/sitecore\/(?:[^/]+\/)*[^/]+$/iu.test(value) &&
    !/[\\?#$|\x00-\x1f]/u.test(value) && !value.split("/").some(part => part === "." || part === "..");
}
export function datasource(raw: string, page: string, verifiedLocalOwner?: string): {
  raw: string; state: "candidate" | "unresolved" | "empty"; target?: string;
} {
  if (!raw) return { raw, state: "empty" }; // Empty does not prove page-as-datasource.
  const direct = id(raw);
  if (direct || path(raw)) return { raw, state: "candidate", target: direct ?? raw };
  const relative = raw.match(/^(page|local):\/(.+)$/u);
  const owner = relative?.[1] === "page" ? page : verifiedLocalOwner;
  if (relative && owner && path(owner) && path(`${owner}/${relative[2]}`))
    return { raw, state: "candidate", target: `${owner}/${relative[2]}` };
  return { raw, state: "unresolved" }; // ./, query:, field:, tokens need verified runtime context.
}
export interface Field {
  id: string; type: string; value: string;
  nameChoices?: { complete: boolean; items: readonly { id: string; name: string }[] };
}
export interface Reference {
  field: string; ordinal: number; raw: string; target?: string;
  kind: "item" | "navigation-on-demand" | "media-leaf" | "unresolved";
}
export function references(fields: readonly Field[]): Reference[] {
  const result: Reference[] = [];
  for (const field of fields) {
    const type = field.type.toLowerCase();
    const add = (raw: string, ordinal: number, kind: Reference["kind"], target?: string) =>
      result.push({ field: field.id, ordinal, raw, kind, ...(target ? { target } : {}) });
    if (!field.value) continue;
    if (["general link", "rich text"].includes(type)) { add(field.value, 0, "navigation-on-demand"); continue; }
    if (["image", "file"].includes(type)) { add(field.value, 0, "media-leaf"); continue; }
    if (["droplist", "grouped droplist"].includes(type)) {
      const choices = field.nameChoices?.items.filter(choice => choice.name.toLowerCase() === field.value.toLowerCase());
      const target = field.nameChoices?.complete && choices?.length === 1 ? id(choices[0].id) : undefined;
      add(field.value, 0, target ? "item" : "unresolved", target); continue;
    }
    const multiple = ["checklist", "multilist", "treelist", "treelistex"].includes(type);
    if (!multiple && !["droplink", "grouped droplink", "droptree"].includes(type)) continue;
    (multiple ? field.value.split("|") : [field.value]).forEach((raw, ordinal) => {
      const target = id(raw.trim());
      add(raw, ordinal, target ? "item" : "unresolved", target);
    });
  }
  return result;
}
export interface ItemEvidence {
  itemId: string; language: string; version: number; complete: boolean;
  fields: readonly Field[];
  // Effective reads do not identify a writable source. No write-target property exists.
  mode: "exact" | "effective";
}
export interface Branch {
  state: "complete" | "partial" | "cycle" | "unavailable";
  provenance: "unverified";
  reason?: string;
  edges: readonly (Reference & { occurrenceKey: string })[];
}
/** One lazy expansion, never ordinary content-tree children or recursive network crawling. */
export async function expand(
  target: string, language: string, usagePath: string, ancestors: readonly string[],
  read: (target: string, language: string, signal: AbortSignal) => Promise<ItemEvidence>,
  signal: AbortSignal, maxEdges = 100, maxDepth = 12,
): Promise<Branch> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 1 || maxEdges > 1000 || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 50)
    throw new Error("Invalid research limits");
  const key = id(target);
  if (!key) throw new Error("Invalid target identity");
  if (ancestors.some(ancestor => id(ancestor) === key)) return { state: "cycle", provenance: "unverified", edges: [] };
  if (ancestors.length >= maxDepth) return { state: "partial", provenance: "unverified", reason: "Depth limit", edges: [] };
  let item: ItemEvidence;
  try { item = await read(key, language, signal); } catch {
    signal.throwIfAborted();
    return { state: "unavailable", provenance: "unverified", reason: "Read failed; absence not established", edges: [] };
  }
  signal.throwIfAborted();
  if (id(item.itemId) !== key || item.language.toLowerCase() !== language.toLowerCase() || !Number.isInteger(item.version) || item.version < 0)
    return { state: "unavailable", provenance: "unverified", reason: "Identity/locale/version mismatch", edges: [] };
  if (item.version === 0 && item.mode === "exact")
    return { state: "partial", provenance: "unverified", reason: "No exact version; effective content not established", edges: [] };
  const refs = references(item.fields);
  return {
    state: item.complete && refs.length <= maxEdges && !refs.some(ref => ref.kind === "unresolved") ? "complete" : "partial",
    provenance: "unverified",
    ...(refs.length > maxEdges ? { reason: "Edge limit; remaining references not shown" } : {}),
    edges: refs.slice(0, maxEdges).map((ref, index) => ({ ...ref, occurrenceKey: `${usagePath}/${ref.field}/${ref.ordinal}/${index}` })),
  };
}
