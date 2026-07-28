import type {
  AuthoringItemDetails,
  AuthoringItemField,
} from "../sitecore/authoringClient";
import type {
  PublishSnapshot,
  ReferenceEdge,
} from "./publishingTypes";
import {
  classifyReferencePath,
  isPathInsideScope,
  parseReferenceField,
  type ObservedReferenceKind,
} from "./referenceDiscovery";
import type {
  PowerScopeNodeView,
  PowerScopeReferenceView,
  PowerScopeReviewState,
} from "./powerPublishScopeForm";

export interface CollapsedScopeGraphLoader {
  loadItem(target: string, signal: AbortSignal): Promise<AuthoringItemDetails>;
  loadChildren(
    parent: AuthoringItemDetails,
    signal: AbortSignal,
  ): Promise<readonly AuthoringItemDetails[]>;
}

export interface CollapsedScopeGraphPlan {
  readonly selectedRootItemIds: readonly string[];
  readonly snapshots: readonly PublishSnapshot[];
  readonly concreteEdges: readonly ReferenceEdge[];
  readonly planningEdges: readonly ReferenceEdge[];
  readonly evidence: readonly string[];
  readonly scopes: readonly {
    readonly rootItemId: string;
    readonly path: string;
    readonly itemCount: number;
    readonly externalReferenceCount: number;
  }[];
}

interface ScopeRecord {
  readonly id: string;
  readonly root: AuthoringItemDetails;
  readonly kind: ObservedReferenceKind;
  readonly required: boolean;
  status: PowerScopeNodeView["status"];
  readonly detailsById: Map<string, AuthoringItemDetails>;
  readonly pendingItems: AuthoringItemDetails[];
  readonly queuedItemIds: Set<string>;
  readonly inspectedItemIds: Set<string>;
  readonly referenceKeys: Set<string>;
  readonly internalReferenceKeys: Set<string>;
  readonly outgoingReferences: PowerScopeReferenceView[];
  readonly concreteEdges: ReferenceEdge[];
  readonly externalLinks: Set<string>;
  readonly unresolvedReferences: Set<string>;
  pauseReason?: string;
  error?: string;
}

export class CollapsedScopeGraph {
  private readonly records = new Map<string, ScopeRecord>();
  private readonly itemCache = new Map<string, AuthoringItemDetails>();
  private readonly activeScans = new Map<string, Promise<void>>();
  private readonly rootScopeId: string;

  constructor(
    root: AuthoringItemDetails,
    private readonly publishSubItemsThroughSitecore: boolean,
    private readonly loader: CollapsedScopeGraphLoader,
    private readonly itemBudget = 500,
    private readonly referenceBudget = 200,
  ) {
    const record = this.createRecord(root, true);
    this.rootScopeId = record.id;
  }

  state(): PowerScopeReviewState {
    return {
      rootScopeId: this.rootScopeId,
      publishSubItemsThroughSitecore: this.publishSubItemsThroughSitecore,
      itemBudget: this.itemBudget,
      referenceBudget: this.referenceBudget,
      nodes: [...this.records.values()].map((record) => this.view(record)),
    };
  }

  async scan(
    scopeId: string,
    signal: AbortSignal,
    report: (state: PowerScopeReviewState) => Promise<void>,
  ): Promise<PowerScopeReviewState> {
    const existing = this.activeScans.get(scopeId);
    if (existing) {
      await existing;
      return this.state();
    }
    const record = this.records.get(scopeId);
    if (!record) {
      throw new Error("The selected collapsed Power Publish scope is unavailable.");
    }
    if (record.kind !== "content" && record.kind !== "media") {
      return this.state();
    }
    if (record.status === "complete") {
      return this.state();
    }
    const scan = this.scanRecord(record, signal, report);
    this.activeScans.set(scopeId, scan);
    try {
      await scan;
    } finally {
      this.activeScans.delete(scopeId);
    }
    return this.state();
  }

  validate(selectedScopeIds: readonly string[]): string | undefined {
    const selected = new Set(selectedScopeIds);
    if (!selected.has(this.rootScopeId)) {
      return "The initial collapsed scope is required.";
    }
    for (const scopeId of selected) {
      const record = this.records.get(scopeId);
      if (!record || (record.kind !== "content" && record.kind !== "media")) {
        return "A selected collapsed scope is unavailable or cannot be published.";
      }
      if (record.status === "scanning" || record.status === "notScanned") {
        return `${record.root.path} has not finished scanning.`;
      }
      if (record.status === "paused") {
        return `${record.root.path} reached a safety budget. Continue its scan before queueing.`;
      }
      if (record.status === "failed") {
        return `${record.root.path} could not be scanned: ${record.error ?? "unknown error"}`;
      }
      if (record.unresolvedReferences.size) {
        return `${record.root.path} contains ${record.unresolvedReferences.size} unresolved reference(s).`;
      }
    }
    return undefined;
  }

  plan(selectedScopeIds: readonly string[]): CollapsedScopeGraphPlan {
    const selected = new Set(selectedScopeIds);
    const records = selectedScopeIds
      .map((scopeId) => this.records.get(scopeId))
      .filter((record): record is ScopeRecord => Boolean(record));
    const selectedItemIds = new Set(
      records.flatMap((record) =>
        [...record.detailsById.values()].map((details) => normalizeId(details.itemId))
      ),
    );
    const snapshots = deduplicateById(
      records.flatMap((record) => [...record.detailsById.values()]),
    ).map(snapshotFromDetails);
    const concreteEdges = records
      .flatMap((record) => record.concreteEdges)
      .filter((edge) =>
        selectedItemIds.has(normalizeId(edge.sourceItemId)) &&
        selectedItemIds.has(normalizeId(edge.targetItemId))
      );
    const planningEdges: ReferenceEdge[] = [];
    for (const record of records) {
      for (const reference of record.outgoingReferences) {
        if (!selected.has(reference.targetScopeId)) {
          continue;
        }
        const target = this.records.get(reference.targetScopeId);
        if (!target) {
          continue;
        }
        planningEdges.push({
          sourceItemId: record.root.itemId,
          targetItemId: target.root.itemId,
          fieldName: reference.fieldName,
        });
      }
    }
    const mediaRecords = records.filter((record) => record.kind === "media");
    const externalUrlCount = records.reduce(
      (total, record) => total + record.externalLinks.size,
      0,
    );
    const evidence = [
      `Selected ${records.length} collapsed scope(s): ${records.length - mediaRecords.length} content scope(s) and ${mediaRecords.length} media item(s).`,
      `Inspected ${records.reduce((total, record) => total + record.inspectedItemIds.size, 0)} concrete item(s); recorded ${externalUrlCount} external URL(s).`,
      ...records.flatMap((record) => [
        `${record.root.path}: ${record.inspectedItemIds.size} item(s), ${record.internalReferenceKeys.size} internal reference(s), ${uniqueTargetScopeIds(record).length} external scope(s).`,
        ...record.externalLinks.size
          ? [...record.externalLinks].map((link) => `External link: ${link}`)
          : [],
        ...record.outgoingReferences
          .filter((reference) => !selected.has(reference.targetScopeId))
          .map((reference) => {
            const target = this.records.get(reference.targetScopeId);
            return `Excluded external scope ${target?.root.path ?? reference.targetScopeId}, referenced by ${reference.sourceItemPath} › ${reference.fieldName} (${relationKindLabel(reference.relationKind)}).`;
          }),
      ]),
    ];
    return {
      selectedRootItemIds: records.map((record) => record.root.itemId),
      snapshots,
      concreteEdges: deduplicateEdges(concreteEdges),
      planningEdges: deduplicateEdges(planningEdges),
      evidence,
      scopes: records.map((record) => ({
        rootItemId: record.root.itemId,
        path: record.root.path,
        itemCount: record.inspectedItemIds.size,
        externalReferenceCount: uniqueTargetScopeIds(record).length,
      })),
    };
  }

  private async scanRecord(
    record: ScopeRecord,
    signal: AbortSignal,
    report: (state: PowerScopeReviewState) => Promise<void>,
  ): Promise<void> {
    record.status = "scanning";
    record.pauseReason = undefined;
    record.error = undefined;
    await report(this.state());
    const startingItems = record.inspectedItemIds.size;
    const startingReferences = record.referenceKeys.size;
    let activeItem: AuthoringItemDetails | undefined;
    try {
      while (record.pendingItems.length) {
        throwIfAborted(signal);
        const current = record.pendingItems.shift();
        if (!current) {
          break;
        }
        const currentKey = normalizeId(current.itemId);
        if (record.inspectedItemIds.has(currentKey)) {
          continue;
        }
        activeItem = current;
        record.detailsById.set(currentKey, current);
        this.itemCache.set(currentKey, current);
        await this.inspectReferences(record, current, signal);

        if (
          this.publishSubItemsThroughSitecore &&
          record.kind === "content" &&
          current.hasChildren
        ) {
          const children = await this.loader.loadChildren(current, signal);
          for (const child of children) {
            const childKey = normalizeId(child.itemId);
            this.itemCache.set(childKey, child);
            record.detailsById.set(childKey, child);
            if (!record.queuedItemIds.has(childKey) && !record.inspectedItemIds.has(childKey)) {
              record.queuedItemIds.add(childKey);
              record.pendingItems.push(child);
            }
          }
        }
        record.inspectedItemIds.add(currentKey);
        activeItem = undefined;
        const passItems = record.inspectedItemIds.size - startingItems;
        const passReferences = record.referenceKeys.size - startingReferences;
        if (
          record.pendingItems.length > 0 &&
          (
            passItems >= this.itemBudget ||
            passReferences >= this.referenceBudget
          )
        ) {
          record.status = "paused";
          record.pauseReason = passItems >= this.itemBudget
            ? `Paused after the ${this.itemBudget}-item scan budget.`
            : `Paused after the ${this.referenceBudget}-reference scan budget.`;
          await report(this.state());
          return;
        }
        if (passItems % 10 === 0) {
          await report(this.state());
        }
      }
      record.status = "complete";
      await report(this.state());
    } catch (error: unknown) {
      if (
        activeItem &&
        !record.inspectedItemIds.has(normalizeId(activeItem.itemId)) &&
        !record.pendingItems.some((item) =>
          normalizeId(item.itemId) === normalizeId(activeItem?.itemId ?? "")
        )
      ) {
        record.pendingItems.unshift(activeItem);
      }
      if (signal.aborted) {
        throw error;
      }
      record.status = "failed";
      record.error = errorMessage(error);
      await report(this.state());
    }
  }

  private async inspectReferences(
    record: ScopeRecord,
    source: AuthoringItemDetails,
    signal: AbortSignal,
  ): Promise<void> {
    for (const field of source.fields) {
      const parsed = parseReferenceField(field);
      for (const url of parsed.externalLinks) {
        record.externalLinks.add(`${source.path} › ${field.name}: ${url}`);
      }
      for (const reason of parsed.unresolved) {
        record.unresolvedReferences.add(`${source.path} › ${reason}`);
      }
      for (const reference of parsed.itemReferences) {
        const resolvedTarget = resolveRelativeTarget(reference.target, source.path);
        const referenceKey = `${normalizeId(source.itemId)}:${field.fieldId}:${resolvedTarget.toLocaleLowerCase()}`;
        if (record.referenceKeys.has(referenceKey)) {
          continue;
        }
        record.referenceKeys.add(referenceKey);
        let target: AuthoringItemDetails;
        try {
          target = await this.loadReferencedItem(resolvedTarget, signal);
        } catch (error: unknown) {
          if (signal.aborted) {
            throw error;
          }
          record.unresolvedReferences.add(
            `${source.path} › ${field.name}: unable to resolve ${resolvedTarget} (${errorMessage(error)})`,
          );
          continue;
        }
        const edge: ReferenceEdge = {
          sourceItemId: source.itemId,
          targetItemId: target.itemId,
          fieldName: field.name,
        };
        record.concreteEdges.push(edge);
        if (
          normalizeId(target.itemId) === normalizeId(record.root.itemId) ||
          (
            this.publishSubItemsThroughSitecore &&
            isPathInsideScope(target.path, record.root.path)
          )
        ) {
          record.internalReferenceKeys.add(referenceKey);
          continue;
        }
        const targetRecord = this.findContainingRecord(target) ?? this.createRecord(target, false);
        record.outgoingReferences.push({
          targetScopeId: targetRecord.id,
          sourceItemPath: source.path,
          fieldName: field.name,
          relationKind: reference.relationKind,
        });
      }
    }
  }

  private async loadReferencedItem(
    target: string,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    const key = normalizeId(target);
    const cached = this.itemCache.get(key);
    if (cached) {
      return cached;
    }
    const details = await this.loader.loadItem(target, signal);
    this.itemCache.set(normalizeId(details.itemId), details);
    this.itemCache.set(details.path.toLocaleLowerCase(), details);
    return details;
  }

  private findContainingRecord(target: AuthoringItemDetails): ScopeRecord | undefined {
    if (!this.publishSubItemsThroughSitecore) {
      return this.records.get(normalizeId(target.itemId));
    }
    return [...this.records.values()]
      .filter((record) =>
        (record.kind === "content" || record.kind === "media") &&
        isPathInsideScope(target.path, record.root.path)
      )
      .sort((left, right) => right.root.path.length - left.root.path.length)[0];
  }

  private createRecord(root: AuthoringItemDetails, required: boolean): ScopeRecord {
    const id = normalizeId(root.itemId);
    const existing = this.records.get(id);
    if (existing) {
      return existing;
    }
    const kind = classifyReferencePath(root.path);
    const selectable = kind === "content" || kind === "media";
    const record: ScopeRecord = {
      id,
      root,
      kind,
      required,
      status: selectable ? "notScanned" : "complete",
      detailsById: new Map([[id, root]]),
      pendingItems: selectable ? [root] : [],
      queuedItemIds: new Set([id]),
      inspectedItemIds: new Set(),
      referenceKeys: new Set(),
      internalReferenceKeys: new Set(),
      outgoingReferences: [],
      concreteEdges: [],
      externalLinks: new Set(),
      unresolvedReferences: new Set(),
    };
    this.records.set(id, record);
    this.itemCache.set(id, root);
    this.itemCache.set(root.path.toLocaleLowerCase(), root);
    return record;
  }

  private view(record: ScopeRecord): PowerScopeNodeView {
    return {
      id: record.id,
      rootItemId: record.root.itemId,
      name: record.root.displayName,
      path: record.root.path,
      kind: record.kind,
      required: record.required,
      status: record.status,
      inspectedItemCount: record.inspectedItemIds.size,
      resolvedReferenceCount: Math.max(
        0,
        record.referenceKeys.size - record.unresolvedReferences.size,
      ),
      internalReferenceCount: record.internalReferenceKeys.size,
      outgoingReferences: deduplicateScopeReferences(record.outgoingReferences),
      externalLinks: [...record.externalLinks],
      unresolvedReferences: [...record.unresolvedReferences],
      excludedReason: record.kind === "configuration"
        ? "Configuration reference; recorded as evidence and not published by default."
        : record.kind === "unsupported"
          ? "Reference is outside the supported content and media roots."
          : undefined,
      pauseReason: record.pauseReason,
      error: record.error,
    };
  }
}

function snapshotFromDetails(details: AuthoringItemDetails): PublishSnapshot {
  const fields: Record<string, string> = {};
  for (const field of details.fields) {
    if (!field.isStandardTemplate) {
      fields[field.name] = field.value;
    }
  }
  return {
    itemId: details.itemId,
    path: details.path,
    displayName: details.displayName,
    language: details.language,
    version: details.version,
    fields,
    references: details.fields.flatMap((field: AuthoringItemField) =>
      parseReferenceField(field).itemReferences.map((reference) => reference.target)
    ),
  };
}

function uniqueTargetScopeIds(record: ScopeRecord): readonly string[] {
  return [...new Set(record.outgoingReferences.map((reference) => reference.targetScopeId))];
}

function deduplicateScopeReferences(
  references: readonly PowerScopeReferenceView[],
): readonly PowerScopeReferenceView[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.targetScopeId}:${reference.sourceItemPath.toLocaleLowerCase()}:${reference.fieldName.toLocaleLowerCase()}:${reference.relationKind}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateEdges(edges: readonly ReferenceEdge[]): readonly ReferenceEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${normalizeId(edge.sourceItemId)}:${normalizeId(edge.targetItemId)}:${edge.fieldName.toLocaleLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateById(
  details: readonly AuthoringItemDetails[],
): readonly AuthoringItemDetails[] {
  const seen = new Set<string>();
  return details.filter((item) => {
    const key = normalizeId(item.itemId);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeId(value: string): string {
  return value.replace(/[{}]/gu, "").toLocaleLowerCase();
}

function relationKindLabel(
  kind: PowerScopeReferenceView["relationKind"],
): string {
  return kind === "layoutDatasource"
    ? "layout datasource"
    : kind === "media"
      ? "media"
      : "item link";
}

function resolveRelativeTarget(target: string, sourcePath: string): string {
  const lowered = target.toLocaleLowerCase();
  if (lowered.startsWith("local:/")) {
    return `${sourcePath.replace(/\/$/u, "")}/${target.slice("local:/".length).replace(/^\//u, "")}`;
  }
  if (lowered.startsWith("./")) {
    return `${sourcePath.replace(/\/$/u, "")}/${target.slice(2)}`;
  }
  return target;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Power Publish scope scanning was cancelled.", "AbortError");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
