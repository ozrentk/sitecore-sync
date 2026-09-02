import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthoringItemDetails,
  AuthoringItemField,
} from "../../src/sitecore/authoringClient";
import {
  CollapsedScopeGraph,
  type CollapsedScopeGraphLoader,
} from "../../src/publishing/collapsedScopeGraph";

const rootId = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const childId = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
const missingId = "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}";
const mediaId = "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}";

test("starts with a required unscanned root and validates selections", async () => {
  const root = item(rootId, "/sitecore/content/Tenant/Home");
  const graph = new CollapsedScopeGraph(
    root,
    false,
    new MemoryGraphLoader([root]),
  );
  const state = graph.state();

  strictEqual(state.rootScopeId, normalizedId(rootId));
  deepStrictEqual(state.nodes.map((node) => ({
    id: node.id,
    required: node.required,
    status: node.status,
  })), [{
    id: normalizedId(rootId),
    required: true,
    status: "notScanned",
  }]);
  strictEqual(graph.validate([]), "The initial collapsed scope is required.");
  match(graph.validate([state.rootScopeId]) ?? "", /has not finished scanning/u);
  await rejects(
    graph.scan("missing-scope", new AbortController().signal, ignoreReport),
    /selected collapsed Power Publish scope is unavailable/u,
  );
});

test("scans descendants and builds an explicit-item publish plan", async () => {
  const fixture = graphFixture(false);
  const rootScopeId = fixture.graph.state().rootScopeId;

  await fixture.graph.scan(
    rootScopeId,
    new AbortController().signal,
    ignoreReport,
  );
  let state = fixture.graph.state();
  const discoveredMedia = state.nodes.find((node) => node.rootItemId === mediaId);

  strictEqual(state.nodes[0]?.status, "complete");
  strictEqual(state.nodes[0]?.inspectedItemCount, 2);
  strictEqual(state.nodes[0]?.internalReferenceCount, 2);
  strictEqual(state.nodes[0]?.ignoredReferenceCount, 1);
  deepStrictEqual(state.nodes[0]?.externalLinks, [
    "/sitecore/content/Tenant/Home › External Link: https://example.com/article",
  ]);
  strictEqual(discoveredMedia?.required, false);
  strictEqual(discoveredMedia?.status, "notScanned");
  match(
    state.nodes[0]?.unresolvedReferences[0] ?? "",
    /unable to resolve .*CCCCCCCC.*Unknown item/u,
  );
  match(
    fixture.graph.validate([rootScopeId, discoveredMedia?.id ?? ""]) ?? "",
    /Media\/Hero has not finished scanning/u,
  );

  await fixture.graph.scan(
    discoveredMedia?.id ?? "",
    new AbortController().signal,
    ignoreReport,
  );
  state = fixture.graph.state();
  strictEqual(state.nodes.find((node) => node.rootItemId === mediaId)?.status, "complete");
  strictEqual(fixture.graph.validate([rootScopeId, normalizedId(mediaId)]), undefined);

  const plan = fixture.graph.plan([rootScopeId, normalizedId(mediaId)]);
  deepStrictEqual(plan.publishItemIds, [rootId, childId, mediaId]);
  deepStrictEqual(
    plan.snapshots.map((snapshot) => snapshot.itemId),
    [rootId, childId, mediaId],
  );
  deepStrictEqual(plan.concreteEdges, [
    { sourceItemId: rootId, targetItemId: childId, fieldName: "Related" },
    { sourceItemId: rootId, targetItemId: mediaId, fieldName: "Hero Image" },
    { sourceItemId: childId, targetItemId: rootId, fieldName: "Parent Link" },
  ]);
  deepStrictEqual(plan.planningEdges, plan.concreteEdges);
  strictEqual(
    plan.evidence.some((entry) =>
      entry.startsWith("External link: /sitecore/content/Tenant/Home") &&
      entry.includes("https://example.com/article")
    ),
    true,
  );
  strictEqual(
    plan.evidence.some((entry) => entry.includes("WARNING") && entry.includes("unresolved")),
    true,
  );
});

test("delegates descendants and plans edges between selected scope roots", async () => {
  const fixture = graphFixture(true);
  const rootScopeId = fixture.graph.state().rootScopeId;

  await fixture.graph.scan(
    rootScopeId,
    new AbortController().signal,
    ignoreReport,
  );
  await fixture.graph.scan(
    normalizedId(mediaId),
    new AbortController().signal,
    ignoreReport,
  );

  const plan = fixture.graph.plan([rootScopeId, normalizedId(mediaId)]);
  deepStrictEqual(plan.publishItemIds, [rootId, mediaId]);
  deepStrictEqual(plan.planningEdges, [{
    sourceItemId: rootId,
    targetItemId: mediaId,
    fieldName: "Hero Image",
  }]);
  strictEqual(plan.concreteEdges.length, 3);
  strictEqual(
    plan.evidence.some((entry) =>
      entry.includes("delegates structural descendants to Sitecore")
    ),
    true,
  );
});

test("deduplicates repeated children, edges, snapshots, and scope references", async () => {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
    [
      field("Related", "Multilist", childId, false, "related-one"),
      field("Related", "Multilist", childId, false, "related-two"),
      field(
        "Hero Image",
        "Image",
        `<image mediaid="${mediaId}" />`,
        false,
        "image-one",
      ),
      field(
        "Hero Image",
        "Image",
        `<image mediaid="${mediaId}" />`,
        false,
        "image-two",
      ),
    ],
  );
  const child = item(
    childId,
    "/sitecore/content/Tenant/Home/Child",
  );
  const media = item(
    mediaId,
    "/sitecore/media library/Images/Hero",
  );
  const loader = new MemoryGraphLoader(
    [root, child, media],
    new Map([[normalizedId(rootId), [child, child]]]),
  );
  const graph = new CollapsedScopeGraph(root, true, loader);
  const rootScopeId = graph.state().rootScopeId;

  await graph.scan(rootScopeId, new AbortController().signal, ignoreReport);
  const rootNode = graph.state().nodes[0];
  strictEqual(rootNode?.inspectedItemCount, 2);
  strictEqual(rootNode?.outgoingReferences.length, 1);
  strictEqual(graph.state().nodes.length, 2);

  await graph.scan(
    normalizedId(mediaId),
    new AbortController().signal,
    ignoreReport,
  );
  const plan = graph.plan([rootScopeId, normalizedId(mediaId)]);

  deepStrictEqual(
    plan.snapshots.map((snapshot) => snapshot.itemId),
    [rootId, childId, mediaId],
  );
  deepStrictEqual(plan.concreteEdges, [
    { sourceItemId: rootId, targetItemId: childId, fieldName: "Related" },
    { sourceItemId: rootId, targetItemId: mediaId, fieldName: "Hero Image" },
  ]);
  deepStrictEqual(plan.planningEdges, [{
    sourceItemId: rootId,
    targetItemId: mediaId,
    fieldName: "Hero Image",
  }]);
});

test("pauses at the item budget and resumes from pending descendants", async () => {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
  );
  const firstChild = item(
    childId,
    "/sitecore/content/Tenant/Home/First",
  );
  const secondChild = item(
    mediaId,
    "/sitecore/content/Tenant/Home/Second",
  );
  const loader = new MemoryGraphLoader(
    [root, firstChild, secondChild],
    new Map([[normalizedId(rootId), [firstChild, secondChild]]]),
  );
  const graph = new CollapsedScopeGraph(root, false, loader, 1, 200);
  const scopeId = graph.state().rootScopeId;

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  let node = graph.state().nodes[0];
  strictEqual(node?.status, "paused");
  strictEqual(node?.inspectedItemCount, 1);
  strictEqual(node?.pauseReason, "Paused after the 1-item scan budget.");
  match(graph.validate([scopeId]) ?? "", /reached a safety budget/u);

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  node = graph.state().nodes[0];
  strictEqual(node?.status, "paused");
  strictEqual(node?.inspectedItemCount, 2);

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  node = graph.state().nodes[0];
  strictEqual(node?.status, "complete");
  strictEqual(node?.inspectedItemCount, 3);
  strictEqual(graph.validate([scopeId]), undefined);
});

test("pauses after discovering the configured number of external scopes", async () => {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
    [field("Hero Image", "Image", `<image mediaid="${mediaId}" />`)],
  );
  const child = item(
    childId,
    "/sitecore/content/Tenant/Home/Child",
  );
  const media = item(
    mediaId,
    "/sitecore/media library/Images/Hero",
  );
  const loader = new MemoryGraphLoader(
    [root, child, media],
    new Map([[normalizedId(rootId), [child]]]),
  );
  const graph = new CollapsedScopeGraph(root, false, loader, 500, 1);
  const scopeId = graph.state().rootScopeId;

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  let node = graph.state().nodes[0];
  strictEqual(node?.status, "paused");
  strictEqual(node?.inspectedItemCount, 1);
  strictEqual(
    node?.pauseReason,
    "Paused after the 1-external-scope scan budget.",
  );
  strictEqual(node?.outgoingReferences.length, 1);

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  node = graph.state().nodes[0];
  strictEqual(node?.status, "complete");
  strictEqual(node?.inspectedItemCount, 2);
});

test("can retry a scope after child loading fails", async () => {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
  );
  const child = item(
    childId,
    "/sitecore/content/Tenant/Home/Child",
  );
  let attempts = 0;
  const loader: CollapsedScopeGraphLoader = {
    async loadItem(): Promise<AuthoringItemDetails> {
      throw new Error("No item references were expected.");
    },
    async loadChildren(): Promise<readonly AuthoringItemDetails[]> {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Temporary child loading failure.");
      }
      return [child];
    },
  };
  const graph = new CollapsedScopeGraph(root, false, loader);
  const scopeId = graph.state().rootScopeId;

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  strictEqual(graph.state().nodes[0]?.status, "failed");
  strictEqual(graph.state().nodes[0]?.inspectedItemCount, 0);
  match(
    graph.validate([scopeId]) ?? "",
    /Temporary child loading failure/u,
  );

  await graph.scan(scopeId, new AbortController().signal, ignoreReport);
  strictEqual(graph.state().nodes[0]?.status, "complete");
  strictEqual(graph.state().nodes[0]?.inspectedItemCount, 2);
  strictEqual(attempts, 2);
});

test("propagates cancellation to an active loader", async () => {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
  );
  let loadingStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    loadingStarted = resolve;
  });
  const loader: CollapsedScopeGraphLoader = {
    async loadItem(): Promise<AuthoringItemDetails> {
      throw new Error("No item references were expected.");
    },
    loadChildren(
      _parent: AuthoringItemDetails,
      signal: AbortSignal,
    ): Promise<readonly AuthoringItemDetails[]> {
      loadingStarted?.();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const graph = new CollapsedScopeGraph(root, false, loader);
  const controller = new AbortController();
  const reason = new DOMException("Test cancelled the scan.", "AbortError");
  const scan = graph.scan(graph.state().rootScopeId, controller.signal, ignoreReport);

  await started;
  controller.abort(reason);
  await rejects(scan, (error: unknown) => {
    strictEqual(error, reason);
    return true;
  });
});

function graphFixture(publishSubItemsThroughSitecore: boolean): {
  readonly graph: CollapsedScopeGraph;
} {
  const root = item(
    rootId,
    "/sitecore/content/Tenant/Home",
    true,
    [
      field("Related", "Multilist", childId),
      field("Hero Image", "Image", `<image mediaid="${mediaId}" />`),
      field(
        "External Link",
        "General Link",
        '<link linktype="external" url="https://example.com/article" />',
      ),
      field(
        "Layout",
        "Layout",
        '<r><d><r ds="/sitecore/layout/Renderings/Hero" /></d></r>',
      ),
      field("Missing", "Droplink", missingId),
      field("System", "Single-Line Text", "ignored", true),
    ],
  );
  const child = item(
    childId,
    "/sitecore/content/Tenant/Home/Child",
    false,
    [field("Parent Link", "Droplink", rootId)],
  );
  const media = item(
    mediaId,
    "/sitecore/media library/Images/Media/Hero",
  );
  const loader = new MemoryGraphLoader(
    [root, child, media],
    new Map([[normalizedId(rootId), [child]]]),
  );
  return {
    graph: new CollapsedScopeGraph(
      root,
      publishSubItemsThroughSitecore,
      loader,
    ),
  };
}

class MemoryGraphLoader implements CollapsedScopeGraphLoader {
  private readonly itemsByTarget = new Map<string, AuthoringItemDetails>();

  constructor(
    items: readonly AuthoringItemDetails[],
    private readonly childrenByParent = new Map<
      string,
      readonly AuthoringItemDetails[]
    >(),
  ) {
    for (const current of items) {
      this.itemsByTarget.set(normalizedId(current.itemId), current);
      this.itemsByTarget.set(current.path.toLocaleLowerCase(), current);
    }
  }

  async loadItem(
    target: string,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    throwIfAborted(signal);
    const current = this.itemsByTarget.get(normalizedTarget(target));
    if (!current) {
      throw new Error(`Unknown item: ${target}`);
    }
    return current;
  }

  async loadChildren(
    parent: AuthoringItemDetails,
    signal: AbortSignal,
  ): Promise<readonly AuthoringItemDetails[]> {
    throwIfAborted(signal);
    return this.childrenByParent.get(normalizedId(parent.itemId)) ?? [];
  }
}

function item(
  itemId: string,
  path: string,
  hasChildren = false,
  fields: readonly AuthoringItemField[] = [],
): AuthoringItemDetails {
  const name = path.split("/").filter(Boolean).at(-1) ?? "Item";
  return {
    itemId,
    name,
    displayName: name,
    path,
    hasChildren,
    language: "en",
    version: 1,
    template: {
      templateId: "{00000000-0000-0000-0000-000000000001}",
      name: "Test Template",
    },
    availableVersions: [{ language: "en", version: 1 }],
    fields,
  };
}

function field(
  name: string,
  type: string,
  value: string,
  isStandardTemplate = false,
  fieldId = name,
): AuthoringItemField {
  return {
    fieldId,
    name,
    label: name,
    value,
    type,
    typeKey: type,
    scope: "VERSIONED",
    sortOrder: 0,
    sectionName: "Content",
    sectionSortOrder: 0,
    isStandardTemplate,
    containsFallbackValue: false,
    containsInheritedValue: false,
    containsStandardValue: false,
    textual: true,
  };
}

function normalizedId(value: string): string {
  return value.replaceAll(/[{}]/gu, "").toLocaleLowerCase();
}

function normalizedTarget(value: string): string {
  return value.startsWith("{") ? normalizedId(value) : value.toLocaleLowerCase();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

async function ignoreReport(): Promise<void> {}
