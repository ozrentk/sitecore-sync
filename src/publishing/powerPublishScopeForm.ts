import * as vscode from "vscode";
import type { ObservedReferenceKind } from "./referenceDiscovery";
import {
  defaultPublishingFormRuntime,
  type PublishingFormRuntime,
} from "./publishingFormRuntime";
import {
  readPowerScopeFormMessageType,
  readPowerScopeId,
  readPowerScopeSelection,
} from "./publishingFormValidation";

export type PowerScopeScanStatus =
  | "notScanned"
  | "scanning"
  | "paused"
  | "complete"
  | "failed";

export interface PowerScopeReferenceView {
  readonly targetScopeId: string;
  readonly sourceItemPath: string;
  readonly fieldName: string;
  readonly relationKind: "layoutDatasource" | "itemLink" | "media";
}

export interface PowerScopeNodeView {
  readonly id: string;
  readonly rootItemId: string;
  readonly name: string;
  readonly path: string;
  readonly kind: ObservedReferenceKind;
  readonly required: boolean;
  readonly status: PowerScopeScanStatus;
  readonly inspectedItemCount: number;
  readonly internalReferenceCount: number;
  readonly ignoredReferenceCount: number;
  readonly outgoingReferences: readonly PowerScopeReferenceView[];
  readonly externalLinks: readonly string[];
  readonly unresolvedReferences: readonly string[];
  readonly excludedReason?: string;
  readonly pauseReason?: string;
  readonly error?: string;
}

export interface PowerScopeReviewState {
  readonly rootScopeId: string;
  readonly publishSubItemsThroughSitecore: boolean;
  readonly itemBudget: number;
  readonly referenceBudget: number;
  readonly nodes: readonly PowerScopeNodeView[];
}

export interface PowerScopeReviewResult {
  readonly selectedScopeIds: readonly string[];
}

export async function showPowerPublishScopeForm(
  extensionUri: vscode.Uri,
  initial: PowerScopeReviewState,
  scanScope: (
    scopeId: string,
    signal: AbortSignal,
    report: (state: PowerScopeReviewState) => Promise<void>,
  ) => Promise<PowerScopeReviewState>,
  validateSelection: (
    selectedScopeIds: readonly string[],
  ) => PowerScopeReviewResult | string,
  signal: AbortSignal,
  initialSelectedScopeIds: readonly string[] = [],
  runtime: PublishingFormRuntime = defaultPublishingFormRuntime,
): Promise<PowerScopeReviewResult | undefined> {
  const mediaUri = vscode.Uri.joinPath(extensionUri, "media", "publishing");
  const panel = runtime.createWebviewPanel(
    "xmCloudSync.powerPublishScope",
    "Review Power Publish Scope",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaUri],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "sitecore-xm-cloud-sync.svg");
  let html: string;
  try {
    html = await loadFormHtml(panel.webview, mediaUri, runtime);
  } catch (error: unknown) {
    panel.dispose();
    throw error;
  }

  return new Promise<PowerScopeReviewResult | undefined>((resolve, reject) => {
    let settled = false;
    let latest = initial;
    const activeScans = new Map<string, Promise<void>>();
    const scanController = new AbortController();
    let subscription: vscode.Disposable | undefined;
    const postState = async (state: PowerScopeReviewState): Promise<void> => {
      latest = state;
      await panel.webview.postMessage({
        type: "scopeState",
        state,
        initialSelectedScopeIds,
      });
    };
    const finish = (
      value: PowerScopeReviewResult | undefined,
      disposePanel = true,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      scanController.abort(
        new DOMException("Power Publish scope review was closed.", "AbortError"),
      );
      signal.removeEventListener("abort", abort);
      subscription?.dispose();
      resolve(value);
      if (disposePanel) {
        panel.dispose();
      }
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      scanController.abort(
        new DOMException("Power Publish scope review failed.", "AbortError"),
      );
      signal.removeEventListener("abort", abort);
      subscription?.dispose();
      reject(error);
      panel.dispose();
    };
    const abort = (): void => finish(undefined);
    const startScan = (scopeId: string): void => {
      if (activeScans.has(scopeId) || settled) {
        return;
      }
      const scan = scanScope(scopeId, scanController.signal, postState)
        .then(postState)
        .catch(async (error: unknown) => {
          if (!settled && !signal.aborted) {
            await panel.webview.postMessage({
              type: "scanFailed",
              scopeId,
              message: errorMessage(error),
            });
          }
        })
        .finally(() => activeScans.delete(scopeId))
        .catch(fail);
      activeScans.set(scopeId, scan);
    };

    signal.addEventListener("abort", abort, { once: true });
    panel.onDidDispose(() => finish(undefined, false));
    subscription = panel.webview.onDidReceiveMessage((message: unknown) => {
      try {
        switch (readPowerScopeFormMessageType(message)) {
          case "ready":
            void postState(latest).then(
              () => startScan(latest.rootScopeId),
              fail,
            );
            return;
          case "cancel":
            finish(undefined);
            return;
          case "scan":
            {
              const scopeId = readPowerScopeId(message);
              if (scopeId) {
                startScan(scopeId);
              }
            }
            return;
          case "submit": {
            const selection = readPowerScopeSelection(message);
            if (typeof selection === "string") {
              void Promise.resolve(
                panel.webview.postMessage({
                  type: "validationError",
                  message: selection,
                }),
              ).catch(fail);
              return;
            }
            const result = validateSelection(selection);
            if (typeof result === "string") {
              void Promise.resolve(
                panel.webview.postMessage({
                  type: "validationError",
                  message: result,
                }),
              ).catch(fail);
              return;
            }
            finish(result);
          }
        }
      } catch (error: unknown) {
        fail(error);
      }
    });
    if (signal.aborted) {
      finish(undefined);
      return;
    }
    panel.webview.html = html;
  });
}

async function loadFormHtml(
  webview: vscode.Webview,
  mediaUri: vscode.Uri,
  runtime: PublishingFormRuntime,
): Promise<string> {
  const htmlUri = vscode.Uri.joinPath(mediaUri, "powerPublishScope.html");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "powerPublishScope.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "powerPublishScope.js"));
  const bytes = await runtime.readFile(htmlUri);
  return Buffer.from(bytes).toString("utf8")
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{styleUri}}", styleUri.toString())
    .replaceAll("{{scriptUri}}", scriptUri.toString());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
