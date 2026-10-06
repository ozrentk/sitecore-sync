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
  name: "real comparison webviews switch field policy and show safe read-only fallback evidence",
  async execute(): Promise<void> {
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const directory = await mkdtemp(join(tmpdir(), "xm-fallback-webview-"));
    try {
      for (const kind of ["comparison", "fieldDiff"] as const) {
        const media = vscode.Uri.joinPath(extension.extensionUri, "media", kind);
        const panel = vscode.window.createWebviewPanel("fallbackSmoke", "Fallback smoke", vscode.ViewColumn.Active,
          { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(directory)] });
        const script = kind === "comparison" ? `
          const receive = data => window.dispatchEvent(new MessageEvent("message", { data }));
          const selection = { leftConnectionId: "left", rightConnectionId: "right", leftLanguage: "en-NZ", rightLanguage: "en-AU" };
          const base = { type: "stateChanged", mode: "compare", viewContext: 1, selection,
            connections: [{ id: "left", name: "Left" }, { id: "right", name: "Right" }] };
          receive({ ...base, fallbackMode: "exact", fallbackRevision: 0 });
          if (fieldFallbackMode.value !== "exact") throw Error("Initial mode");
          for (const side of ["left", "right"]) applyLoadedLevel({ side, connectionId: side, language: selection[side + "Language"],
            level: { item: { itemId: "aa", path: "/sitecore", name: "Root", hasChildren: false }, children: [] } });
          const root = state.trees.left.root;
          state.selectedRowKey = "root:aa:aa"; state.expandedRows.add("root:aa:aa");
          fieldFallbackMode.value = "fallback";
          fieldFallbackMode.dispatchEvent(new Event("change"));
          receive({ ...base, fallbackMode: "fallback", fallbackRevision: 1 });
          if (fieldFallbackMode.value !== "fallback" || fieldFallbackMode.disabled) throw Error("Mode selector");
          if (state.trees.left.root !== root || state.selectedRowKey !== "root:aa:aa" || !state.expandedRows.has("root:aa:aa")) throw Error("Navigation reset");
          if (!document.querySelector(".comparison-row")) throw Error("Tree not rendered");
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
          document.querySelector("summary").click();
          if (!document.querySelector("details").open || !document.body.textContent.includes("<script>literal content</script>")) throw Error("Exact evidence missing");
          window.dispatchEvent(new MessageEvent("message", { data: { type: "snapshot", mode: "compare", contextId: 2, snapshot: { ...snapshot, fallbackMode: "exact" } } }));
          if (document.querySelectorAll(".copy-value").length !== 2) throw Error("Exact transfers missing");
        `;
        const scriptPath = join(directory, `${kind}.js`);
        await writeFile(scriptPath, `try { ${script}\n api.postMessage({ type: "smokeResult", ok: true }); } catch (error) { api.postMessage({ type: "smokeResult", error: String(error) }); }`);
        const helper = Object.create((kind === "comparison" ? ComparisonPanelManager : FieldDiffViewProvider).prototype) as {
          loadHtml(webview: vscode.Webview, media: vscode.Uri): Promise<string>;
          html(webview: vscode.Webview, media: vscode.Uri): string;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listener: vscode.Disposable | undefined;
        try {
          const result = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${kind} webview smoke timed out`)), 20_000);
            listener = panel.webview.onDidReceiveMessage((message: { type?: string; ok?: boolean; error?: string }) => {
              if (message.type !== "smokeResult") return;
              try { strictEqual(message.ok, true, message.error); resolve(); } catch (error) { reject(error); }
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
