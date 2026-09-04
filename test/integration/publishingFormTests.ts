import {
  deepStrictEqual,
  rejects,
  strictEqual,
} from "node:assert/strict";
import * as vscode from "vscode";
import {
  showPowerPublishScopeForm,
  type PowerScopeReviewState,
} from "../../src/publishing/powerPublishScopeForm";
import type { PublishingFormRuntime } from "../../src/publishing/publishingFormRuntime";
import {
  showTracedPublishForm,
  type TracedPublishFormInitialState,
} from "../../src/publishing/tracedPublishForm";
import type { IntegrationTest } from "./testSupport";

class TestWebview {
  readonly received = new vscode.EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.received.event;
  readonly messages: unknown[] = [];
  readonly cspSource = "test-csp-source";
  html = "";
  postError: Error | undefined;

  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({ scheme: "test-resource" });
  }

  async postMessage(message: unknown): Promise<boolean> {
    if (this.postError) {
      throw this.postError;
    }
    this.messages.push(message);
    return true;
  }

  fire(message: unknown): void {
    this.received.fire(message);
  }

  dispose(): void {
    this.received.dispose();
  }
}

class TestPanel {
  readonly webviewHost = new TestWebview();
  readonly webview = this.webviewHost as unknown as vscode.Webview;
  readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;
  iconPath: vscode.Uri | { readonly light: vscode.Uri; readonly dark: vscode.Uri } | undefined;
  disposeCalls = 0;

  dispose(): void {
    if (this.disposeCalls > 0) {
      return;
    }
    this.disposeCalls += 1;
    this.disposed.fire();
  }

  closeFromUser(): void {
    this.disposed.fire();
  }

  release(): void {
    this.webviewHost.dispose();
    this.disposed.dispose();
  }
}

class TestPublishingFormRuntime implements PublishingFormRuntime {
  readonly panel = new TestPanel();
  created: {
    readonly viewType: string;
    readonly title: string;
    readonly options: vscode.WebviewPanelOptions & vscode.WebviewOptions;
  } | undefined;
  readError: Error | undefined;

  createWebviewPanel(
    viewType: string,
    title: string,
    _showOptions: vscode.ViewColumn,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ): vscode.WebviewPanel {
    this.created = { viewType, title, options };
    return this.panel as unknown as vscode.WebviewPanel;
  }

  async readFile(): Promise<Uint8Array> {
    if (this.readError) {
      throw this.readError;
    }
    return new TextEncoder().encode(
      "<meta content=\"{{cspSource}}\"><link href=\"{{styleUri}}\"><script src=\"{{scriptUri}}\"></script>",
    );
  }

  dispose(): void {
    this.panel.release();
  }
}

export const publishingFormTests: readonly IntegrationTest[] = [
  {
    name: "Traced Publish form initializes, validates, retries descendants, and submits",
    async execute(): Promise<void> {
      const runtime = new TestPublishingFormRuntime();
      let descendantCalls = 0;
      const initial = tracedInitial();
      const resultPromise = showTracedPublishForm(
        vscode.Uri.file("C:\\xm-cloud-sync-tests"),
        initial,
        async () => {
          descendantCalls += 1;
          if (descendantCalls === 1) {
            throw new Error("Descendant lookup failed");
          }
          return [descendantField()];
        },
        new AbortController().signal,
        runtime,
      );
      try {
        await waitFor(() => runtime.panel.webviewHost.html.length > 0);
        strictEqual(runtime.created?.viewType, "xmCloudSync.tracedPublishForm");
        strictEqual(runtime.created?.title, "Configure Traced Publish");
        strictEqual(runtime.created?.options.enableScripts, true);
        strictEqual(runtime.created?.options.localResourceRoots?.length, 1);
        strictEqual(runtime.panel.webviewHost.html.includes("{{"), false);
        strictEqual(runtime.panel.webviewHost.html.includes("test-csp-source"), true);

        runtime.panel.webviewHost.fire(null);
        runtime.panel.webviewHost.fire({ type: "ready" });
        await waitForMessage(runtime, "initialize");
        deepStrictEqual(messageOfType(runtime, "initialize"), {
          type: "initialize",
          state: initial,
        });

        runtime.panel.webviewHost.fire({ type: "loadDescendants" });
        await waitForMessage(runtime, "descendantsFailed");
        strictEqual(descendantCalls, 1);
        deepStrictEqual(messageOfType(runtime, "descendantsFailed"), {
          type: "descendantsFailed",
          message: "Descendant lookup failed",
        });

        runtime.panel.webviewHost.fire({ type: "loadDescendants" });
        runtime.panel.webviewHost.fire({ type: "loadDescendants" });
        await waitForMessage(runtime, "descendantsLoaded");
        strictEqual(descendantCalls, 2);

        runtime.panel.webviewHost.fire({
          type: "submit",
          mode: "SMART",
          publishSubItems: false,
          publishRelatedItems: false,
          siteName: "website",
          route: "/",
          fields: [{ key: "child:title" }],
        });
        await waitForMessage(runtime, "validationError");

        runtime.panel.webviewHost.fire({
          type: "submit",
          mode: "FULL",
          publishSubItems: true,
          publishRelatedItems: true,
          siteName: " website ",
          route: " /news ",
          applicationUrl: " https://www.example.com/news ",
          fields: [
            { key: "root:title", browserSelector: " h1 " },
            { key: "child:title" },
          ],
        });

        deepStrictEqual(await resultPromise, {
          mode: "FULL",
          publishSubItems: true,
          publishRelatedItems: true,
          siteName: "website",
          route: "/news",
          applicationUrl: "https://www.example.com/news",
          fields: [
            { itemId: "root-item", fieldName: "Title", browserSelector: "h1" },
            { itemId: "child-item", fieldName: "Title", browserSelector: undefined },
          ],
        });
        strictEqual(runtime.panel.disposeCalls, 1);
      } finally {
        runtime.dispose();
      }
    },
  },
  {
    name: "Traced Publish form closes safely on pre-cancellation and HTML load failure",
    async execute(): Promise<void> {
      const cancelledRuntime = new TestPublishingFormRuntime();
      const controller = new AbortController();
      controller.abort(new DOMException("Cancelled", "AbortError"));
      try {
        strictEqual(
          await showTracedPublishForm(
            vscode.Uri.file("C:\\xm-cloud-sync-tests"),
            tracedInitial(),
            async () => [],
            controller.signal,
            cancelledRuntime,
          ),
          undefined,
        );
        strictEqual(cancelledRuntime.panel.disposeCalls, 1);
        strictEqual(cancelledRuntime.panel.webviewHost.html, "");
      } finally {
        cancelledRuntime.dispose();
      }

      const failedRuntime = new TestPublishingFormRuntime();
      failedRuntime.readError = new Error("HTML unavailable");
      try {
        await rejects(
          showTracedPublishForm(
            vscode.Uri.file("C:\\xm-cloud-sync-tests"),
            tracedInitial(),
            async () => [],
            new AbortController().signal,
            failedRuntime,
          ),
          /HTML unavailable/u,
        );
        strictEqual(failedRuntime.panel.disposeCalls, 1);
      } finally {
        failedRuntime.dispose();
      }

      const closedRuntime = new TestPublishingFormRuntime();
      const closedResult = showTracedPublishForm(
        vscode.Uri.file("C:\\xm-cloud-sync-tests"),
        tracedInitial(),
        async () => [],
        new AbortController().signal,
        closedRuntime,
      );
      try {
        await waitFor(() => closedRuntime.panel.webviewHost.html.length > 0);
        closedRuntime.panel.closeFromUser();
        strictEqual(await closedResult, undefined);
        strictEqual(closedRuntime.panel.disposeCalls, 0);
      } finally {
        closedRuntime.dispose();
      }
    },
  },
  {
    name: "Power Publish scope form deduplicates scans and validates before submitting",
    async execute(): Promise<void> {
      const runtime = new TestPublishingFormRuntime();
      const initial = scopeState("notScanned");
      let scanCalls = 0;
      const selections: readonly string[][] = [];
      const resultPromise = showPowerPublishScopeForm(
        vscode.Uri.file("C:\\xm-cloud-sync-tests"),
        initial,
        async (scopeId, _signal, report) => {
          scanCalls += 1;
          strictEqual(scopeId, "root-scope");
          await report(scopeState("scanning"));
          await new Promise((resolve) => setTimeout(resolve, 10));
          return scopeState("complete");
        },
        (selectedScopeIds) => {
          (selections as string[][]).push([...selectedScopeIds]);
          return selectedScopeIds.includes("root-scope")
            ? { selectedScopeIds }
            : "The required root scope is missing.";
        },
        new AbortController().signal,
        ["saved-scope"],
        runtime,
      );
      try {
        await waitFor(() => runtime.panel.webviewHost.html.length > 0);
        strictEqual(runtime.created?.viewType, "xmCloudSync.powerPublishScope");
        strictEqual(runtime.created?.title, "Review Power Publish Scope");
        strictEqual(runtime.panel.webviewHost.html.includes("{{"), false);

        runtime.panel.webviewHost.fire({ type: "ready" });
        await waitFor(() => scanCalls === 1);
        runtime.panel.webviewHost.fire({ type: "scan", scopeId: "root-scope" });
        runtime.panel.webviewHost.fire({ type: "scan", scopeId: 42 });
        strictEqual(scanCalls, 1);
        await waitFor(() => messagesOfType(runtime, "scopeState").length >= 3);

        runtime.panel.webviewHost.fire({ type: "submit", selectedScopeIds: [42] });
        await waitForMessage(runtime, "validationError");
        runtime.panel.webviewHost.fire({ type: "submit", selectedScopeIds: ["optional-scope"] });
        await waitFor(() => messagesOfType(runtime, "validationError").length === 2);
        runtime.panel.webviewHost.fire({
          type: "submit",
          selectedScopeIds: ["root-scope", "optional-scope"],
        });

        deepStrictEqual(await resultPromise, {
          selectedScopeIds: ["root-scope", "optional-scope"],
        });
        deepStrictEqual(selections, [
          ["optional-scope"],
          ["root-scope", "optional-scope"],
        ]);
        strictEqual(runtime.panel.disposeCalls, 1);
      } finally {
        runtime.dispose();
      }
    },
  },
  {
    name: "Power Publish scope form retries failed scans and cancels active work",
    async execute(): Promise<void> {
      const runtime = new TestPublishingFormRuntime();
      const controller = new AbortController();
      let scanCalls = 0;
      let activeSignal: AbortSignal | undefined;
      const resultPromise = showPowerPublishScopeForm(
        vscode.Uri.file("C:\\xm-cloud-sync-tests"),
        scopeState("notScanned"),
        async (_scopeId, signal) => {
          scanCalls += 1;
          if (scanCalls === 1) {
            throw new Error("Scope scan failed");
          }
          activeSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        (selectedScopeIds) => ({ selectedScopeIds }),
        controller.signal,
        [],
        runtime,
      );
      try {
        await waitFor(() => runtime.panel.webviewHost.html.length > 0);
        runtime.panel.webviewHost.fire({ type: "ready" });
        await waitForMessage(runtime, "scanFailed");
        deepStrictEqual(messageOfType(runtime, "scanFailed"), {
          type: "scanFailed",
          scopeId: "root-scope",
          message: "Scope scan failed",
        });

        runtime.panel.webviewHost.fire({ type: "scan", scopeId: "root-scope" });
        await waitFor(() => scanCalls === 2);
        controller.abort(new DOMException("Cancelled", "AbortError"));

        strictEqual(await resultPromise, undefined);
        strictEqual(activeSignal?.aborted, true);
        strictEqual(runtime.panel.disposeCalls, 1);
      } finally {
        runtime.dispose();
      }
    },
  },
  {
    name: "Power Publish scope form rejects failed host-to-webview messages",
    async execute(): Promise<void> {
      const runtime = new TestPublishingFormRuntime();
      runtime.panel.webviewHost.postError = new Error("Webview unavailable");
      let scanCalls = 0;
      const resultPromise = showPowerPublishScopeForm(
        vscode.Uri.file("C:\\xm-cloud-sync-tests"),
        scopeState("notScanned"),
        async () => {
          scanCalls += 1;
          return scopeState("complete");
        },
        (selectedScopeIds) => ({ selectedScopeIds }),
        new AbortController().signal,
        [],
        runtime,
      );
      try {
        await waitFor(() => runtime.panel.webviewHost.html.length > 0);
        runtime.panel.webviewHost.fire({ type: "ready" });

        await rejects(resultPromise, /Webview unavailable/u);
        strictEqual(scanCalls, 0);
        strictEqual(runtime.panel.disposeCalls, 1);
      } finally {
        runtime.dispose();
      }
    },
  },
];

function tracedInitial(): TracedPublishFormInitialState {
  return {
    kind: "traced",
    connectionName: "Production",
    targetHost: "production.example.com",
    rootPath: "/sitecore/content/Home",
    language: "en",
    sites: [{
      name: "website",
      rootPath: "/sitecore/content/Tenant/Site",
      suggestedRoute: "/",
    }],
    selectedSiteName: "website",
    route: "/",
    fields: [{
      key: "root:title",
      itemId: "root-item",
      itemName: "Home",
      itemPath: "/sitecore/content/Home",
      fieldName: "Title",
      value: "Welcome",
      descendant: false,
    }],
  };
}

function descendantField() {
  return {
    key: "child:title",
    itemId: "child-item",
    itemName: "Child",
    itemPath: "/sitecore/content/Home/Child",
    fieldName: "Title",
    value: "Child title",
    descendant: true,
  } as const;
}

function scopeState(
  status: "notScanned" | "scanning" | "complete",
): PowerScopeReviewState {
  return {
    rootScopeId: "root-scope",
    publishSubItemsThroughSitecore: false,
    itemBudget: 500,
    referenceBudget: 200,
    nodes: [{
      id: "root-scope",
      rootItemId: "root-item",
      name: "Home",
      path: "/sitecore/content/Home",
      kind: "content",
      required: true,
      status,
      inspectedItemCount: status === "notScanned" ? 0 : 1,
      internalReferenceCount: 0,
      ignoredReferenceCount: 0,
      outgoingReferences: [],
      externalLinks: [],
      unresolvedReferences: [],
    }],
  };
}

function messagesOfType(
  runtime: TestPublishingFormRuntime,
  type: string,
): readonly Record<string, unknown>[] {
  return runtime.panel.webviewHost.messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === type),
  );
}

function messageOfType(
  runtime: TestPublishingFormRuntime,
  type: string,
): Record<string, unknown> | undefined {
  return messagesOfType(runtime, type)[0];
}

async function waitForMessage(
  runtime: TestPublishingFormRuntime,
  type: string,
): Promise<void> {
  await waitFor(() => messagesOfType(runtime, type).length > 0);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for publishing form state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
