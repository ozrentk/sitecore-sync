import { withActionIcons } from "../ui/webviewActions";
import { randomBytes } from "node:crypto";
import { fieldPresentation } from "../sitecore/fieldPresentation";
import * as vscode from "vscode";
import type { ComparisonItemDetails, FieldFallbackMode } from "./fieldFallback";

export const fieldDiffViewId = "xmCloudSync.fieldDiff";

export interface FieldDiffSelection {
  readonly mode?: "browse" | "compare";
  readonly leftItemId?: string;
  readonly rightItemId?: string;
  readonly leftName?: string;
  readonly rightName?: string;
}

export interface FieldDiffSnapshot extends FieldDiffSelection {
  readonly fallbackMode?: FieldFallbackMode;
  readonly leftPublicPageUrl?: string;
  readonly rightPublicPageUrl?: string;
  readonly leftPublicPageError?: string;
  readonly rightPublicPageError?: string;
  readonly leftConnectionName?: string;
  readonly rightConnectionName?: string;
  readonly leftDetails?: ComparisonItemDetails;
  readonly rightDetails?: ComparisonItemDetails;
  readonly leftError?: string;
  readonly rightError?: string;
  readonly textNormalization: "none" | "lineEndings";
}

interface FieldDiffMessage {
  readonly fallbackMode?: unknown;
  readonly contextId?: unknown;
  readonly type?: unknown;
  readonly fieldId?: unknown;
  readonly itemId?: unknown;
  readonly direction?: unknown;
  readonly side?: unknown;
}

export class FieldDiffViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private mode: "browse" | "compare" = "compare";
  private contextId = 0;
  private snapshot: FieldDiffSnapshot | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onBecameVisible: () => void,
    private readonly onOpenTextDiff: (fieldId: string) => Promise<void>,
    private readonly onCopyFieldValue: (
      fieldId: string,
      direction: "leftToRight" | "rightToLeft",
    ) => Promise<void>,
    private readonly onCopyItemIdentity: (
      side: "left" | "right",
      itemId: string,
      path?: string,
    ) => Promise<boolean>,
    private readonly onOpenPublicPage?: (side: "left" | "right", itemId: string) => Promise<void>,
    private readonly onSetFallbackMode?: (mode: FieldFallbackMode) => Promise<void>,
    private readonly getFallbackMode: () => FieldFallbackMode = () => "exact",
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.title = this.mode === "browse" ? "Item Details" : "Field Diff";
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, "media", "fieldDiff");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri, vscode.Uri.joinPath(this.extensionUri, "media", "shared")],
    };
    view.webview.html = withActionIcons(view.webview, this.html(view.webview, mediaUri), this.extensionUri);
    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.onBecameVisible();
        }
      }),
      view.webview.onDidReceiveMessage(async (message: FieldDiffMessage) => {
        if (!message || typeof message !== "object") return;
        if (message.type !== "ready" && message.contextId !== this.contextId) return;
        if (message.type === "setFieldFallbackMode") {
          if (message.fallbackMode !== "exact" && message.fallbackMode !== "fallback") return;
          try { await this.onSetFallbackMode?.(message.fallbackMode); }
          finally { await this.post({ type: "fallbackModeChanged" }); }
          return;
        }
        if (this.mode === "browse" && (message.type === "openTextDiff" || message.type === "copyFieldValue" || message.side === "right")) return;
        if (message.type === "openPublicPage" && (message.side === "left" || message.side === "right") && typeof message.itemId === "string") {
          await this.onOpenPublicPage?.(message.side, message.itemId);
        } else if (message.type === "ready" && view.visible) {
          this.onBecameVisible();
        } else if (message.type === "openTextDiff" && typeof message.fieldId === "string") {
          await this.onOpenTextDiff(message.fieldId);
        } else if (
          message.type === "copyFieldValue" &&
          typeof message.fieldId === "string" &&
          (message.direction === "leftToRight" || message.direction === "rightToLeft")
        ) {
          try {
            await this.onCopyFieldValue(message.fieldId, message.direction);
          } finally {
            await this.post({ type: "copyFinished", fieldId: message.fieldId });
          }
        } else if (
          (message.type === "copyItemId" || message.type === "copyItemPath") &&
          (message.side === "left" || message.side === "right") &&
          typeof message.itemId === "string"
        ) {
          const contextId = this.contextId;
          const details = this.snapshot?.[`${message.side}Details`];
          if (message.type === "copyItemPath" && (!details || details.itemId !== message.itemId)) return;
          let copied = false;
          try { copied = await this.onCopyItemIdentity(message.side, message.itemId, message.type === "copyItemPath" ? details?.path : undefined); }
          catch { /* Report clipboard failures inline without exposing raw errors. */ }
          if (contextId === this.contextId) await this.post({ type: message.type === "copyItemPath" ? "itemPathCopyFinished" : "itemIdCopyFinished",
            side: message.side, itemId: message.itemId, copied });
        }
      }),
    );
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  async showLoading(selection: FieldDiffSelection): Promise<void> {
    this.snapshot = undefined;
    this.setMode(selection.mode ?? "compare");
    this.contextId += 1;
    await this.post({ type: "loading", selection });
  }

  async showSnapshot(snapshot: FieldDiffSnapshot): Promise<void> {
    this.snapshot = snapshot;
    this.setMode(snapshot.mode ?? "compare");
    const present = (details: ComparisonItemDetails | undefined) => details && ({ ...details,
      fields: details.fields.map(field => ({ ...field, presentation: fieldPresentation(field.type, field.value) })) });
    await this.post({ type: "snapshot", snapshot: { ...snapshot, leftDetails: present(snapshot.leftDetails), rightDetails: present(snapshot.rightDetails) } });
  }

  async showError(message: string): Promise<void> {
    await this.post({ type: "error", message });
  }

  async clear(mode: "browse" | "compare" = "compare"): Promise<void> {
    this.snapshot = undefined;
    this.setMode(mode);
    this.contextId += 1;
    await this.post({ type: "clear" });
  }

  private setMode(mode: "browse" | "compare"): void {
    this.mode = mode;
    if (this.view) this.view.title = mode === "browse" ? "Item Details" : "Field Diff";
  }

  private async post(message: Record<string, unknown>): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage({ ...message, mode: this.mode, contextId: this.contextId,
        fallbackMode: this.getFallbackMode() });
    }
  }

  private html(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString("hex");
    const shared = vscode.Uri.joinPath(mediaUri, "..", "shared");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "fieldDiff.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "fieldDiff.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(shared, "readOnlyField.css"))}">
  <title>Field Diff</title>
</head>
<body>
  <header class="toolbar" aria-label="Field visibility">
    <strong id="details-title" class="toolbar-title">Field visibility</strong>
    <button id="field-fallback-mode" type="button" aria-pressed="false" title="Include server-returned language fallback values. Off uses Exact locale.">Fallback</button>
    <div class="visibility-control">
      <span id="content-visibility-label">Content fields</span>
      <div class="visibility-options" role="group" aria-labelledby="content-visibility-label" data-category="content">
        <button type="button" data-mode="hidden" class="browse-only">Hidden</button>
        <button type="button" data-mode="all">All</button>
        <button type="button" data-mode="differences">Differences</button>
      </div>
    </div>
    <div class="visibility-control">
      <span id="standard-visibility-label">Standard Template fields</span>
      <div class="visibility-options" role="group" aria-labelledby="standard-visibility-label" data-category="standard">
        <button type="button" data-mode="hidden">Hidden</button>
        <button type="button" data-mode="differences">Differences</button>
        <button type="button" data-mode="all">All</button>
      </div>
    </div>
    <div class="visibility-control">
      <span id="system-visibility-label">System fields</span>
      <div class="visibility-options" role="group" aria-labelledby="system-visibility-label" data-category="system">
        <button type="button" data-mode="hidden">Hidden</button>
        <button type="button" data-mode="differences">Differences</button>
        <button type="button" data-mode="all">All</button>
      </div>
    </div>
  </header>
  <main id="content" aria-live="polite"></main>
  <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(shared, "readOnlyField.js"))}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.view = undefined;
  }
}
