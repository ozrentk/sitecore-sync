import * as vscode from "vscode";
import {
  defaultPublishingFormRuntime,
  type PublishingFormRuntime,
} from "./publishingFormRuntime";
import {
  readTracedPublishFormMessageType,
  validateTracedPublishSubmission,
  type TracedPublishFieldCandidate,
  type TracedPublishFormResult,
  type TracedPublishSiteCandidate,
} from "./publishingFormValidation";

export type {
  TracedPublishFieldCandidate,
  TracedPublishFormResult,
  TracedPublishSiteCandidate,
} from "./publishingFormValidation";

export interface TracedPublishFormInitialState {
  readonly kind: "traced" | "power";
  readonly connectionName: string;
  readonly targetHost: string;
  readonly rootPath: string;
  readonly language: string;
  readonly sites: readonly TracedPublishSiteCandidate[];
  readonly selectedSiteName?: string;
  readonly route: string;
  readonly applicationUrl?: string;
  readonly fields: readonly TracedPublishFieldCandidate[];
}

export async function showTracedPublishForm(
  extensionUri: vscode.Uri,
  initial: TracedPublishFormInitialState,
  loadDescendants: () => Promise<readonly TracedPublishFieldCandidate[]>,
  signal: AbortSignal,
  runtime: PublishingFormRuntime = defaultPublishingFormRuntime,
): Promise<TracedPublishFormResult | undefined> {
  const mediaUri = vscode.Uri.joinPath(extensionUri, "media", "publishing");
  const panel = runtime.createWebviewPanel(
    "xmCloudSync.tracedPublishForm",
    initial.kind === "power" ? "Configure Power Publish" : "Configure Traced Publish",
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

  return new Promise<TracedPublishFormResult | undefined>((resolve, reject) => {
    let settled = false;
    let descendants: readonly TracedPublishFieldCandidate[] | undefined;
    let descendantRequest: Promise<readonly TracedPublishFieldCandidate[]> | undefined;
    let subscription: vscode.Disposable | undefined;
    const finish = (
      value: TracedPublishFormResult | undefined,
      disposePanel = true,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
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
      signal.removeEventListener("abort", abort);
      subscription?.dispose();
      reject(error);
      panel.dispose();
    };
    const abort = (): void => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });

    panel.onDidDispose(() => finish(undefined, false));
    subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        switch (readTracedPublishFormMessageType(message)) {
          case "ready":
            await panel.webview.postMessage({ type: "initialize", state: initial });
            return;
          case "cancel":
            finish(undefined);
            return;
          case "loadDescendants":
            descendantRequest ??= loadDescendants();
            try {
              descendants = await descendantRequest;
              await panel.webview.postMessage({
                type: "descendantsLoaded",
                fields: descendants,
              });
            } catch (error: unknown) {
              descendantRequest = undefined;
              await panel.webview.postMessage({
                type: "descendantsFailed",
                message: errorMessage(error),
              });
            }
            return;
          case "submit": {
            const available = [
              ...initial.fields,
              ...(descendants ?? []),
            ];
            const result = validateTracedPublishSubmission(
              message,
              available,
              initial.sites,
              initial.kind,
            );
            if (typeof result === "string") {
              await panel.webview.postMessage({ type: "validationError", message: result });
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
  const htmlUri = vscode.Uri.joinPath(mediaUri, "tracedPublishForm.html");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "tracedPublishForm.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "tracedPublishForm.js"));
  const bytes = await runtime.readFile(htmlUri);
  return Buffer.from(bytes).toString("utf8")
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{styleUri}}", styleUri.toString())
    .replaceAll("{{scriptUri}}", scriptUri.toString());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
