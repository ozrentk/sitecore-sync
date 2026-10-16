import * as vscode from "vscode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictEqual } from "node:assert/strict";
import { ComparisonPanelManager } from "../../src/comparison/comparisonPanel";
import { FieldDiffViewProvider } from "../../src/comparison/fieldDiffView";
import type { IntegrationTest } from "./testSupport";

/** Exercise the shipped scripts inside actual VS Code webviews, with synthetic content only. */
export const fallbackWebviewTests: readonly IntegrationTest[] = [{
  name: "real comparison and Field Diff webviews show synchronized fallback toggles without redundant labels",
  async execute(): Promise<void> {
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const directory = await mkdtemp(join(tmpdir(), "xm-fallback-webview-"));
    try {
      for (const kind of ["comparison", "fieldDiff"] as const) {
        const media = vscode.Uri.joinPath(extension.extensionUri, "media", kind);
        const panel = vscode.window.createWebviewPanel("fallbackSmoke", "Fallback smoke", vscode.ViewColumn.Active,
          { enableScripts: true, localResourceRoots: [media, vscode.Uri.joinPath(media, "..", "shared"), vscode.Uri.file(directory)] });
        const script = kind === "comparison" ? `
          const receive = data => window.dispatchEvent(new MessageEvent("message", { data }));
          const selection = { leftConnectionId: "left", rightConnectionId: "right", leftLanguage: "en-NZ", rightLanguage: "en-AU" };
          const base = { type: "stateChanged", mode: "compare", viewContext: 1, selection,
            connections: [{ id: "left", name: "Left" }, { id: "right", name: "Right" }] };
          receive({ ...base, fallbackMode: "exact", fallbackRevision: 0 });
          if (fieldFallbackMode.getAttribute("aria-pressed") !== "false") throw Error("Initial fallback state");
          if (languageLock.getAttribute("aria-pressed") !== "false") throw Error("Initial lock state");
          languageLock.click();
          fieldFallbackMode.click();
          for (const side of ["left", "right"]) applyLoadedLevel({ side, connectionId: side, language: selection[side + "Language"],
            level: { item: { itemId: "aa", path: "/sitecore", name: "Root", hasChildren: false }, children: [] } });
          const root = state.trees.left.root;
          state.selectedRowKey = "root:aa:aa"; state.expandedRows.add("root:aa:aa");
          receive({ ...base, fallbackMode: "fallback", fallbackRevision: 1 });
          if (fieldFallbackMode.getAttribute("aria-pressed") !== "true" || fieldFallbackMode.disabled) throw Error("Fallback not synchronized");
          if (state.trees.left.root !== root || state.selectedRowKey !== "root:aa:aa" || !state.expandedRows.has("root:aa:aa")) throw Error("Navigation reset");
          if (!document.querySelector(".comparison-row")) throw Error("Tree not rendered");
          receive({ ...base, selection: { ...selection, languagesLocked: true }, fallbackMode: "exact", fallbackRevision: 2 });
          if (languageLock.getAttribute("aria-pressed") !== "true" || fieldFallbackMode.getAttribute("aria-pressed") !== "false") throw Error("Toggles not updated");
          receive({ ...base, mode: "browse", fallbackMode: "fallback", fallbackRevision: 3 });
          if (fieldFallbackMode.closest(".toolbar-actions").hidden || !languageLock.hidden || !swapButton.hidden) throw Error("Browse toolbar state");
          const languageRect = leftLanguageSelect.getBoundingClientRect();
          const fallbackRect = fieldFallbackMode.getBoundingClientRect();
          if (fallbackRect.left < languageRect.right || fallbackRect.left - languageRect.right > 16
            || Math.abs((fallbackRect.top + fallbackRect.bottom - languageRect.top - languageRect.bottom) / 2) > 2) throw Error("Browse fallback must sit immediately right of language selector");
        ` : `
          const field = { fieldId: "a", name: "Title", label: "Title", value: "Effective text", type: "Text", typeKey: "text",
            scope: "VERSIONED", textual: true, containsFallbackValue: true, isStandardTemplate: false };
          const exact = { fields: [{ ...field, value: "<script>literal content</script>", containsFallbackValue: false }] };
          const details = { itemId: "aa", path: "/sitecore/Home", language: "en-NZ", version: 0, template: { name: "Page" }, fields: [field],
            comparisonEvidence: { exact, exactObservedAt: "a", effectiveObservedAt: "b", sourceLanguage: "unknown" } };
          const snapshot = { fallbackMode: "fallback", leftDetails: details, rightDetails: { ...details, fields: [{ ...field, value: "Other" }] } };
          window.dispatchEvent(new MessageEvent("message", { data: { type: "snapshot", mode: "compare", contextId: 1, snapshot } }));
          if (document.querySelector(".copy-value")) throw Error("Fallback transfer visible");
          if (!document.body.textContent.includes("source language unknown")) throw Error("Unknown source missing");
          if (fieldFallbackMode.getAttribute("aria-pressed") !== "true" || fieldFallbackMode.hidden || fieldFallbackMode.disabled) throw Error("Toggle state");
          if (document.querySelector("details") || document.body.textContent.includes("Field transfer requires") || document.body.textContent.includes("Exact locale values")) throw Error("Clutter remains");
          fieldFallbackMode.click();
          if (!fieldFallbackMode.disabled) throw Error("Selector must wait for host");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "snapshot", mode: "compare", contextId: 2, snapshot: { ...snapshot, fallbackMode: "exact" } } }));
          if (document.querySelectorAll(".copy-value").length !== 2) throw Error("Exact transfers missing");
          if (fieldFallbackMode.getAttribute("aria-pressed") !== "false" || fieldFallbackMode.disabled) throw Error("Toggle not restored");
          const pathButton = document.querySelector('[data-copy-item-path="right"]');
          if (!(pathButton instanceof HTMLButtonElement) || pathButton.textContent !== details.path
            || pathButton.title !== "Copy right item path" || !pathButton.getAttribute("aria-label").includes(details.path)) throw Error("Path copy accessibility");
          pathButton.focus(); pathButton.click();
          if (!pathButton.disabled) throw Error("Path copy pending state");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "itemPathCopyFinished", contextId: 2, side: "right", itemId: "aa", copied: true } }));
          if (!pathButton.isConnected || !pathButton.textContent.startsWith("✓ ") || pathButton.disabled) throw Error("Path feedback was lost");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "itemPathCopyFinished", contextId: 2, side: "right", itemId: "aa", copied: false } }));
          if (pathButton.textContent !== "⚠ Copy failed") throw Error("Path failure feedback missing");
          const idButton = document.querySelector('[data-copy-item-id="left"]');
          window.dispatchEvent(new MessageEvent("message", { data: { type: "itemIdCopyFinished", contextId: 2, side: "left", itemId: "aa", copied: true } }));
          if (!idButton.textContent.startsWith("✓ ")) throw Error("ID feedback missing");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "loading", mode: "compare", fallbackMode: "fallback", contextId: 3, selection: {} } }));
          if (fieldFallbackMode.getAttribute("aria-pressed") !== "true" || !fieldFallbackMode.disabled) throw Error("Loading state");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "clear", mode: "browse", fallbackMode: "exact", contextId: 4 } }));
          if (fieldFallbackMode.hidden || fieldFallbackMode.disabled) throw Error("Browse selector unavailable");
          const browseDetails = { ...details, itemFallback: { status: "candidate", chain: ["en-NZ", "en-AU", "en"], candidate: { language: "en", version: 1 } } };
          window.dispatchEvent(new MessageEvent("message", { data: { type: "snapshot", mode: "browse", contextId: 4, snapshot: { fallbackMode: "fallback", leftDetails: browseDetails } } }));
          if (!document.body.textContent.includes("Configured fallback candidate: en-NZ → en-AU → en (v1)")) throw Error("Candidate missing");
          if (!document.body.textContent.includes("latest version 0") || document.querySelector(".copy-value")) throw Error("Browse identity or transfer state");
          const fallbackMetadata = document.querySelector(".metadata");
          if (!fallbackMetadata.textContent.includes("fallback · expected source: en") || fallbackMetadata.textContent.includes("not verified")
            || !fallbackMetadata.title.includes("not verified per-field provenance") || !fallbackMetadata.title.includes("en-NZ → en-AU → en")) throw Error("Expected source hint or tooltip missing");
        `;
        const scriptPath = join(directory, `${kind}.js`);
        await writeFile(scriptPath, `try { ${script}\n api.postMessage({ type: "smokeResult", ok: true }); } catch (error) { api.postMessage({ type: "smokeResult", error: String(error) }); }`);
        const helper = Object.create((kind === "comparison" ? ComparisonPanelManager : FieldDiffViewProvider).prototype) as {
          loadHtml(webview: vscode.Webview, media: vscode.Uri): Promise<string>;
          html(webview: vscode.Webview, media: vscode.Uri): string;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listener: vscode.Disposable | undefined;
        let policyMessage = false;
        let lockMessage = false;
        try {
          const result = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${kind} webview smoke timed out`)), 20_000);
            listener = panel.webview.onDidReceiveMessage((message: { type?: string; ok?: boolean; error?: string; fallbackMode?: string; contextId?: number; viewContext?: number; locked?: boolean }) => {
              if (message.type === "setFieldFallbackMode") policyMessage = kind === "fieldDiff"
                ? message.fallbackMode === "exact" && message.contextId === 1 : message.fallbackMode === "fallback" && message.viewContext === 1;
              if (message.type === "setLanguageLock") lockMessage = message.locked === true;
              if (message.type !== "smokeResult") return;
              try { strictEqual(message.ok, true, message.error); strictEqual(policyMessage, true); if (kind === "comparison") strictEqual(lockMessage, true); resolve(); } catch (error) { reject(error); }
            });
          });
          const html = kind === "comparison" ? await helper.loadHtml(panel.webview, media) : helper.html(panel.webview, media);
          panel.webview.html = html.replace("</body>", `<script src="${panel.webview.asWebviewUri(vscode.Uri.file(scriptPath))}"></script></body>`);
          await result;
        } finally {
          clearTimeout(timer); listener?.dispose(); panel.dispose();
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
}];
