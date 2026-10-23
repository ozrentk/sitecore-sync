import { isGuid } from "./itemEditorModel";
import { referenceId, type PreviewReferenceField, type PreviewReferenceItem } from "../sitecore/previewReferences";

export interface ReferenceOccurrence {
  key: string; label: string; itemId?: string; state: "ready" | "cycle" | "missing" | "error" | "limit" | "unresolved";
}
export interface ReferenceGroup { name: string; issue?: string; nodes: ReferenceOccurrence[]; rawValue?: string; destination?: PreviewReferenceField["destination"]; }
export interface ReferenceExpansion { groups: ReferenceGroup[]; notice: string; }
interface Node { id: string; ancestors: readonly string[]; evidence?: Readonly<Record<string, readonly string[]>>; }

/** One session per connection/site/locale/layout load. Cache identities, never occurrences. */
export class ComponentReferences {
  private readonly nodes = new Map<string, Node>();
  private readonly cache = new Map<string, Promise<PreviewReferenceItem | null>>();
  private readonly expansions = new Map<string, Promise<ReferenceExpansion>>();
  private readonly pending: (() => void)[] = [];
  private active = 0;
  private count = 0;
  constructor(private readonly read: (id: string, signal: AbortSignal) => Promise<PreviewReferenceItem | null>,
    private readonly signal: AbortSignal,
    private readonly evidence: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>> = new Map()) {}
  root(key: string, id: string, evidence?: Node["evidence"]): void {
    if (isGuid(id)) this.nodes.set(key, { id: referenceId(id), ancestors: [], evidence });
  }
  target(key: string): string | undefined { return this.nodes.get(key)?.id; }
  expand(key: string): Promise<ReferenceExpansion> {
    const existing = this.expansions.get(key); if (existing) return existing;
    const node = this.nodes.get(key);
    if (!node) return Promise.reject(Error("Unknown reference occurrence."));
    const result = this.load(node);
    this.expansions.set(key, result); return result;
  }
  private item(id: string): Promise<PreviewReferenceItem | null> {
    this.signal.throwIfAborted();
    const cached = this.cache.get(id); if (cached) return cached;
    if (this.cache.size >= 200) return Promise.reject(Error("Read limit"));
    const result = (async () => {
      if (this.active >= 4) await new Promise<void>(resolve => this.pending.push(resolve));
      else this.active++;
      try { this.signal.throwIfAborted(); return await this.read(id, this.signal); }
      finally { const next = this.pending.shift(); if (next) next(); else this.active--; }
    })();
    this.cache.set(id, result); return result;
  }
  private async load(node: Node): Promise<ReferenceExpansion> {
    this.signal.throwIfAborted();
    if (node.ancestors.includes(node.id)) return { groups: [], notice: "Cycle — already in this branch." };
    if (node.ancestors.length >= 12) return { groups: [], notice: "Reference depth limit (12) reached." };
    const item = await this.item(node.id);
    this.signal.throwIfAborted();
    if (!item) return { groups: [], notice: "Item missing or inaccessible in Preview." };
    const groups: ReferenceGroup[] = [];
    const ancestors = [...node.ancestors, node.id];
    let limited = false;
    for (const field of item.fields) {
      const evidence = (node.evidence ?? this.evidence.get(node.id))?.[field.name];
      const disagreement = evidence && (evidence.length !== field.targets.length || evidence.some((id, i) => referenceId(id) !== referenceId(field.targets[i])));
      const issue = disagreement ? "Layout and direct Preview references disagree; unresolved." : field.issue;
      const group: ReferenceGroup = { name: field.name, issue, nodes: [], rawValue: field.rawValue, destination: field.destination }; groups.push(group);
      // Reserve occurrence keys synchronously; async completion must not reorder rows.
      for (const target of field.targets) {
        if (this.count >= 500) { limited = true; break; }
        const key = `ref:${++this.count}`;
        const id = isGuid(target) ? referenceId(target) : undefined;
        const cycle = id !== undefined && ancestors.includes(id);
        const state = issue || !id ? "unresolved" : cycle ? "cycle" : ancestors.length >= 12 ? "limit" : "ready";
        group.nodes.push({ key, label: target || "Empty reference", itemId: id, state });
        if (id && (state === "ready" || state === "cycle" || state === "limit")) this.nodes.set(key, { id, ancestors });
      }
      if (limited) break;
    }
    const parity = node.evidence ?? this.evidence.get(node.id);
    if (parity) for (const name of Object.keys(parity)) {
      if (!item.fields.some(field => field.name === name)) groups.push({ name, nodes: [], issue: "Layout relationship has no verified direct Preview field; unresolved." });
    }
    await Promise.all(groups.flatMap(group => group.nodes.map(async occurrence => {
      if (occurrence.state !== "ready" || !occurrence.itemId) return;
      try {
        const item = await this.item(occurrence.itemId);
        if (!item) { occurrence.state = "missing"; this.nodes.delete(occurrence.key); }
        else occurrence.label = item.label;
      } catch {
        this.signal.throwIfAborted();
        occurrence.state = this.cache.has(occurrence.itemId) ? "error" : "limit";
        this.nodes.delete(occurrence.key);
      }
    })));
    this.signal.throwIfAborted();
    return { groups, notice: limited ? "Reference occurrence limit (500) reached. Refresh starts a new load."
      : "Preview-exposed references · Source locale unknown." };
  }
}
