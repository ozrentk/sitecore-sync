import * as vscode from "vscode";
import type { PublishMode } from "./publishingTypes";

export interface TracedPublishFieldCandidate {
  readonly key: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemPath: string;
  readonly fieldName: string;
  readonly value: string;
  readonly descendant: boolean;
}

export interface TracedPublishSiteCandidate {
  readonly name: string;
  readonly rootPath: string;
  readonly suggestedRoute: string;
}

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

export interface TracedPublishFormResult {
  readonly mode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
  readonly siteName?: string;
  readonly route?: string;
  readonly applicationUrl?: string;
  readonly fields: readonly {
    readonly itemId: string;
    readonly fieldName: string;
    readonly browserSelector?: string;
  }[];
}

interface SubmitMessage {
  readonly type: "submit";
  readonly mode?: unknown;
  readonly publishSubItems?: unknown;
  readonly publishRelatedItems?: unknown;
  readonly siteName?: unknown;
  readonly route?: unknown;
  readonly applicationUrl?: unknown;
  readonly fields?: unknown;
}

type FormMessage =
  | { readonly type: "ready" }
  | { readonly type: "cancel" }
  | { readonly type: "loadDescendants" }
  | SubmitMessage;

export async function showTracedPublishForm(
  extensionUri: vscode.Uri,
  initial: TracedPublishFormInitialState,
  loadDescendants: () => Promise<readonly TracedPublishFieldCandidate[]>,
  signal: AbortSignal,
): Promise<TracedPublishFormResult | undefined> {
  const mediaUri = vscode.Uri.joinPath(extensionUri, "media", "publishing");
  const panel = vscode.window.createWebviewPanel(
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
    html = await loadFormHtml(panel.webview, mediaUri);
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
    subscription = panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
      try {
        switch (message.type) {
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
            const result = validateSubmission(message, available, initial.sites);
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

function validateSubmission(
  message: SubmitMessage,
  availableFields: readonly TracedPublishFieldCandidate[],
  sites: readonly TracedPublishSiteCandidate[],
): TracedPublishFormResult | string {
  if (message.mode !== "SMART" && message.mode !== "FULL") {
    return "Select Smart publish or Full publish.";
  }
  if (
    typeof message.publishSubItems !== "boolean" ||
    typeof message.publishRelatedItems !== "boolean"
  ) {
    return "The publish scope is invalid.";
  }
  const siteName = optionalString(message.siteName);
  if (sites.length > 0 && !siteName) {
    return "Select the Sitecore site used for route verification.";
  }
  if (
    siteName &&
    sites.length > 0 &&
    !sites.some((site) =>
      site.name.localeCompare(siteName, undefined, { sensitivity: "base" }) === 0
    )
  ) {
    return "Select a Sitecore site from the verified connection catalog.";
  }
  const route = optionalString(message.route);
  const applicationUrl = optionalString(message.applicationUrl);
  if (applicationUrl) {
    const validation = validateHttpsUrl(applicationUrl);
    if (validation) {
      return validation;
    }
  }
  if (!Array.isArray(message.fields)) {
    return "The selected field assertions are invalid.";
  }
  const available = new Map(availableFields.map((field) => [field.key, field]));
  const selections: TracedPublishFormResult["fields"][number][] = [];
  const seen = new Set<string>();
  for (const raw of message.fields) {
    if (!raw || typeof raw !== "object") {
      return "A selected field assertion is invalid.";
    }
    const candidate = raw as {
      readonly key?: unknown;
      readonly browserSelector?: unknown;
    };
    if (typeof candidate.key !== "string" || seen.has(candidate.key)) {
      return "A selected field assertion is invalid or duplicated.";
    }
    const field = available.get(candidate.key);
    if (!field) {
      return "A selected field is no longer available.";
    }
    if (field.descendant && !message.publishSubItems) {
      return "Enable Descendants before selecting fields owned by descendant items.";
    }
    if (!siteName || !route) {
      return "Select a Sitecore site and enter its route before selecting field assertions.";
    }
    const browserSelector = optionalString(candidate.browserSelector);
    if (browserSelector && !applicationUrl) {
      return "Enter the exact application URL before publishing Browser DOM selectors.";
    }
    seen.add(candidate.key);
    selections.push({
      itemId: field.itemId,
      fieldName: field.fieldName,
      browserSelector,
    });
  }
  return {
    mode: message.mode,
    publishSubItems: message.publishSubItems,
    publishRelatedItems: message.publishRelatedItems,
    siteName,
    route,
    applicationUrl,
    fields: selections,
  };
}

async function loadFormHtml(
  webview: vscode.Webview,
  mediaUri: vscode.Uri,
): Promise<string> {
  const htmlUri = vscode.Uri.joinPath(mediaUri, "tracedPublishForm.html");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "tracedPublishForm.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "tracedPublishForm.js"));
  const bytes = await vscode.workspace.fs.readFile(htmlUri);
  return Buffer.from(bytes).toString("utf8")
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{styleUri}}", styleUri.toString())
    .replaceAll("{{scriptUri}}", scriptUri.toString());
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? undefined : "Application URL must use HTTPS.";
  } catch {
    return "Enter a valid HTTPS application URL.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
