import * as vscode from "vscode";
import { strictEqual, match, doesNotMatch, rejects, deepStrictEqual } from "node:assert/strict";
import { mock } from "node:test";
import { componentItemDetails } from "../../src/editor/componentDetails";
import { PageComponentsPanel } from "../../src/editor/pageComponentsPanel";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { AuthoringContentClient, AuthoringItemDetails } from "../../src/sitecore/authoringClient";
import type { IntegrationTest } from "./testSupport";
const datasourceId = "22222222222222222222222222222222";
const referenceId = "33333333333333333333333333333333";
const id = "11111111111111111111111111111111";
function dependencies() {
  const connection = { id: "test", name: "Test", serverUrl: "https://example.test", clientId: "client" };
  return {
    connection,
    connections: {
      get: () => connection, getClientSecret: async () => "authoring-secret", getPreviewToken: async () => "preview-secret",
      listVerifiedSites: () => [{ name: "Example", rootPath: "/sitecore/content/Example" }],
    } as unknown as ConnectionStore,
    authoring: {
      loadItem: async () => ({ itemId: id, name: "Page", displayName: "Page", path: "/sitecore/content/Example/home/Page" }),
      loadLanguages: async () => [{ name: "en" }, { name: "en-AU" }],
      loadSelectionItem: async () => ({ itemId: id, name: "Datasource", displayName: "Datasource", path: "/sitecore/content/Example/Data", hasChildren: false }),
    } as unknown as AuthoringContentClient,
  };
}
const report = { status: "collected", rendered: { sitecore: {
  context: { site: { name: "Example" }, language: "en" },
  route: { deviceId: "fe5d7fdf-89c0-4d99-9aa3-b5fbd009c9f3", itemId: id, name: "Page", databaseName: "master", itemLanguage: "en", itemVersion: 1,
    placeholders: { main: [{ uid: id, componentName: "<RichText>", dataSource: "", isContentResolved: true }] } },
} } };
export const pageComponentsTests: readonly IntegrationTest[] = [{
  name: "page components opens an isolated read-only webview with validated Preview context",
  async execute() {
    const { connections, authoring } = dependencies();
    let panel: vscode.WebviewPanel | undefined;
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      panel = original(...args); return panel;
    });
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, token, selection) => {
      strictEqual(token, "preview-secret"); strictEqual(selection.route, "/Page"); return report;
    } });
    try {
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      match(panel!.webview.html, /&lt;RichText&gt;/u);
      match(panel!.webview.html, /Source locale: unknown/u);
      match(panel!.webview.html, /default-src 'none'/u);
      doesNotMatch(panel!.webview.html, /preview-secret|authoring-secret|<RichText>/u);
      strictEqual(panel!.webview.options.localResourceRoots?.length, 2);
    } finally { provider.dispose(); spy.mock.restore(); }
  },
}, {
  name: "Components uses verified device metadata and retains raw unknown identities",
  async execute() {
    for (const available of [true, false]) {
      const { connections, authoring } = dependencies();
      let panel: vscode.WebviewPanel | undefined;
      const original = vscode.window.createWebviewPanel;
      const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => { panel = original(...args); return panel; });
      const lookup = mock.method(authoring, "loadSelectionItem", async () => {
        if (!available) throw Error("Unavailable");
        return { itemId: referenceId, name: "Print", displayName: "Print", path: "/sitecore/layout/Devices/Print", hasChildren: false };
      });
      const provider = new PageComponentsPanel(connections, authoring, { collect: async () => ({ ...report, rendered: { sitecore: {
        ...report.rendered.sitecore, route: { ...report.rendered.sitecore.route, deviceId: referenceId },
      } } }) });
      try {
        await provider.open({ connectionId: "test", itemId: id, language: "en" });
        match(panel!.webview.html, new RegExp(`title="${referenceId}"`));
        if (available) match(panel!.webview.html, />Print<\/span>/u);
        else doesNotMatch(panel!.webview.html, />Default<\/span>|>Print<\/span>/u);
      } finally { provider.dispose(); spy.mock.restore(); lookup.mock.restore(); }
    }
  },
}, {
  name: "Components details separates page, datasource and reference identities and fences actions",
  async execute() {
    const { connections, authoring, connection } = dependencies();
    let panel: vscode.WebviewPanel | undefined;
    let receive!: (message: unknown) => unknown;
    const messages: Array<Record<string, unknown>> = [];
    const restores: Array<() => void> = [];
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      panel = original(...args);
      const listener = mock.method(panel.webview, "onDidReceiveMessage", (fn: typeof receive) => { receive = fn; return new vscode.Disposable(() => {}); });
      const post = mock.method(panel.webview, "postMessage", async (message: Record<string, unknown>) => { messages.push(message); return true; });
      restores.push(() => listener.mock.restore(), () => post.mock.restore());
      return panel;
    });
    const lookup = mock.method(authoring, "loadSelectionItem", async (...args: Parameters<AuthoringContentClient["loadSelectionItem"]>) => {
      const locator = args[2]; const target = "itemId" in locator ? locator.itemId.replace(/[{}-]/gu, "").toLowerCase() : datasourceId;
      return { itemId: target, name: "Datasource", displayName: "Datasource label", path: "/sitecore/content/Example/Data", hasChildren: false };
    });
    const originalLoad = authoring.loadItem;
    const load = mock.method(authoring, "loadItem", async (...args: Parameters<AuthoringContentClient["loadItem"]>) => {
      const locator = args[2];
      if ("itemId" in locator && locator.itemId === id) return originalLoad(...args);
      strictEqual(args[3], "en"); strictEqual(args[6], false); strictEqual(args[7], true);
      return details("itemId" in locator ? locator.itemId : datasourceId);
    });
    const opened: unknown[] = [], edited: unknown[] = [];
    const withDatasource = { ...report, rendered: { sitecore: { ...report.rendered.sitecore, route: {
      ...report.rendered.sitecore.route, placeholders: { main: [
        { uid: id, componentName: "Text", dataSource: datasourceId, isContentResolved: true },
        { uid: referenceId, componentName: "Repeated", dataSource: datasourceId, isContentResolved: true },
        { componentName: "Unresolved", dataSource: "local:/unknown" },
      ] },
    } } } };
    const provider = new PageComponentsPanel(connections, authoring, { collect: async () => withDatasource }, {
      extensionUri: vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!.extensionUri,
      reveal: async (...args) => { opened.push(args); }, edit: async (...args) => { edited.push(args); },
    });
    const wait = async (predicate: () => boolean): Promise<void> => {
      for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error("Details did not arrive.");
    };
    try {
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      strictEqual(lookup.mock.calls.length, 1); // repeated component, one label lookup
      receive({ type: "select", key: '["main",0]', revision: 0, intent: 1 });
      strictEqual(messages.length, 0);
      receive({ type: "select", key: '["main",0]', revision: 1, intent: 1 });
      await wait(() => Boolean(messages.at(-1)?.item));
      const selection = messages.at(-1)!.selection;
      strictEqual((messages.at(-1)!.item as { itemId: string }).itemId, datasourceId);
      strictEqual(opened.length, 0); // inspecting does not change global Browse
      receive({ type: "reveal", revision: 1, selection, itemId: id });
      receive({ type: "edit", revision: 1, selection });
      deepStrictEqual(opened, [["test", datasourceId, "en", "/sitecore/content/Example/Data"]]);
      deepStrictEqual(edited, [["test", datasourceId, "en", 2]]);
      receive({ type: "reference", revision: 1, selection, key: "reference:0", intent: 2 });
      await wait(() => (messages.at(-1)?.item as { itemId?: string } | undefined)?.itemId === referenceId);
      receive({ type: "edit", revision: 1, selection }); // stale datasource context
      strictEqual(edited.length, 1);
      receive({ type: "reveal", revision: 1, selection: messages.at(-1)!.selection });
      deepStrictEqual(opened[1], ["test", referenceId, "en", "/sitecore/content/Example/Data"]);
      receive({ type: "select", key: '["main",2]', revision: 1, intent: 3 });
      await wait(() => Boolean(messages.at(-1)?.error));
      receive({ type: "edit", revision: 1, selection: messages.at(-1)!.selection });
      strictEqual(edited.length, 1);
      connection.serverUrl = "https://changed.test";
      receive({ type: "select", key: '["main",1]', revision: 1, intent: 4 });
      strictEqual(messages.at(-1)!.intent, 3);
    } finally { provider.dispose(); restores.forEach(restore => restore()); spy.mock.restore(); lookup.mock.restore(); load.mock.restore(); }
  },
}, {
  name: "Components cancels and fences detail responses after selection, locale changes and disposal",
  async execute() {
    const { connections, authoring } = dependencies();
    let receive!: (message: unknown) => unknown;
    const messages: Array<Record<string, unknown>> = [];
    const restores: Array<() => void> = [];
    const pending: Array<{ signal: AbortSignal; resolve: (value: AuthoringItemDetails) => void }> = [];
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      const panel = original(...args);
      const listener = mock.method(panel.webview, "onDidReceiveMessage", (fn: typeof receive) => { receive = fn; return new vscode.Disposable(() => {}); });
      const post = mock.method(panel.webview, "postMessage", async (message: Record<string, unknown>) => { messages.push(message); return true; });
      restores.push(() => listener.mock.restore(), () => post.mock.restore());
      return panel;
    });
    const originalLoad = authoring.loadItem;
    const load = mock.method(authoring, "loadItem", async (...args: Parameters<AuthoringContentClient["loadItem"]>) =>
      "itemId" in args[2] && args[2].itemId === id ? originalLoad(...args)
        : new Promise<AuthoringItemDetails>(resolve => pending.push({ signal: args[5], resolve })));
    const lookup = mock.method(authoring, "loadSelectionItem", async () => ({ itemId: datasourceId, name: "Text", displayName: "Text", path: "/sitecore/content/Example/Data", hasChildren: false }));
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, _token, selection) => ({ ...report, rendered: { sitecore: {
      context: { site: { name: "Example" }, language: selection.language },
      route: { ...report.rendered.sitecore.route, itemLanguage: selection.language, placeholders: {
        main: [{ uid: id, componentName: "Text", dataSource: datasourceId }, { componentName: "No datasource" }],
      } },
    } } }) });
    const wait = async (predicate: () => boolean): Promise<void> => {
      for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error("Async details did not start.");
    };
    try {
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      receive({ type: "select", key: '["main",0]', revision: 1, intent: 1 });
      await wait(() => pending.length === 1);
      receive({ type: "select", key: '["main",1]', revision: 1, intent: 2 });
      strictEqual(pending[0].signal.aborted, true);
      pending[0].resolve(details(datasourceId));
      await wait(() => Boolean(messages.at(-1)?.error));
      receive({ type: "select", key: '["main",0]', revision: 1, intent: 3 });
      await wait(() => pending.length === 2);
      receive({ type: "load", language: "en-AU", revision: 1 });
      strictEqual(pending[1].signal.aborted, true);
      pending[1].resolve(details(datasourceId));
      await new Promise(resolve => setTimeout(resolve, 30));
      strictEqual(messages.some(message => Boolean(message.item)), false);
      receive({ type: "select", key: '["main",0]', revision: 2, intent: 1 });
      await wait(() => pending.length === 3);
      provider.dispose();
      strictEqual(pending[2].signal.aborted, true);
      pending[2].resolve({ ...details(datasourceId), language: "en-AU" });
    } finally { provider.dispose(); restores.forEach(restore => restore()); spy.mock.restore(); load.mock.restore(); lookup.mock.restore(); }
  },
},
  {
  name: "Components reference expansion cancels on reload and rejects stale and unknown targets",
  async execute() {
    const { connections, authoring } = dependencies();
    let receive!: (message: unknown) => unknown;
    const messages: Array<Record<string, unknown>> = [];
    const restores: Array<() => void> = [];
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      const panel = original(...args);
      const listener = mock.method(panel.webview, "onDidReceiveMessage", (fn: typeof receive) => { receive = fn; return new vscode.Disposable(() => {}); });
      const post = mock.method(panel.webview, "postMessage", async (message: Record<string, unknown>) => { messages.push(message); return true; });
      restores.push(() => listener.mock.restore(), () => post.mock.restore()); return panel;
    });
    const lookup = mock.method(authoring, "loadSelectionItem", async () => ({ itemId: datasourceId, name: "Data", displayName: "Data", path: "/sitecore/content/Example/Data", hasChildren: false }));
    const pending: Array<{ signal: AbortSignal; resolve: (value: null) => void }> = [];
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, _token, selection) => ({ ...report, rendered: { sitecore: {
      context: { site: { name: "Example" }, language: selection.language }, route: { ...report.rendered.sitecore.route, itemLanguage: selection.language,
        placeholders: { main: [{ uid: id, componentName: "Text", dataSource: datasourceId, isContentResolved: true }] } },
    } } }) }, undefined, { read: async (_origin, _token, _id, _language, signal) => new Promise(resolve => pending.push({ signal, resolve })) });
    const wait = async (predicate: () => boolean): Promise<void> => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error("Reference test timeout"); };
    try {
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      receive({ type: "expandReferences", revision: 1, key: "unknown" }); strictEqual(pending.length, 0);
      const key = JSON.stringify(["main", 0]);
      receive({ type: "expandReferences", revision: 1, key }); await wait(() => pending.length === 1);
      receive({ type: "load", revision: 1, language: "en-AU" });
      strictEqual(pending[0].signal.aborted, true); pending[0].resolve(null);
      await new Promise(resolve => setTimeout(resolve, 30));
      strictEqual(messages.some(message => message.type === "references"), false);
      receive({ type: "expandReferences", revision: 1, key }); strictEqual(pending.length, 1);
      receive({ type: "expandReferences", revision: 2, key }); await wait(() => pending.length === 2);
      provider.dispose(); strictEqual(pending[1].signal.aborted, true); pending[1].resolve(null);
      await new Promise(resolve => setTimeout(resolve, 10));
      strictEqual(messages.some(message => message.type === "references"), false);
    } finally { provider.dispose(); restores.forEach(restore => restore()); spy.mock.restore(); lookup.mock.restore(); }
  },
},
  ...([false, true] as const).map(narrowExpected => ({
  name: `Components ${narrowExpected ? "narrow" : "desktop"} header and details controls preserve selection, resize and focus`,
  async execute() {
    const { connections, authoring } = dependencies();
    let panel: vscode.WebviewPanel | undefined;
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => { panel = original(...args); return panel; });
    const originalLoad = authoring.loadItem;
    const load = mock.method(authoring, "loadItem", async (...args: Parameters<AuthoringContentClient["loadItem"]>) =>
      "itemId" in args[2] && args[2].itemId === id ? originalLoad(...args) : { ...groupedDetails(), itemId: "itemId" in args[2] ? args[2].itemId : datasourceId });
    const lookup = mock.method(authoring, "loadSelectionItem", async () => ({ itemId: datasourceId, name: "Text", displayName: "SW - Title - Rich Text with a long descriptive name that should wrap", path: "/sitecore/content/Example/Data", hasChildren: false }));
    const provider = new PageComponentsPanel(connections, authoring, { collect: async () => ({ ...report, rendered: { sitecore: {
      ...report.rendered.sitecore, route: { ...report.rendered.sitecore.route, placeholders: {
        main: [{ uid: id, componentName: "Component", dataSource: datasourceId, isContentResolved: true, placeholders: { nested: [{ componentName: "Instance only" }] } }],
      } },
    } } }) }, undefined, { read: async (_origin, _token, target) => ({ id: target, label: target === referenceId ? "Effective reference" : "Datasource", path: "/sitecore/media library/Logo", fields: [
      { id, name: "Related", targets: target === datasourceId ? [referenceId, referenceId] : [datasourceId] },
      { id, name: "Media", targets: [referenceId], targetKind: "media" as const, evidenceLabel: "Asset information", rawValue: '<image mediaid="' + referenceId + '" />' },
      { id: referenceId, name: "Internal link", targets: [referenceId], rawValue: '<link linktype="internal" id="' + referenceId + '" />' },
      { id: datasourceId, name: "External link", targets: [], rawValue: '<link linktype="external" url="https://example.test/" />', destination: { kind: "external" as const, value: "https://example.test/" } },
    ] }) });
    let timer: ReturnType<typeof setTimeout> | undefined, listener: vscode.Disposable | undefined;
    try {
      await vscode.commands.executeCommand(narrowExpected ? "workbench.action.editorLayoutTwoColumns" : "workbench.action.editorLayoutSingle");
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      const result = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(Error("Components UI timeout")), 20000);
        listener = panel!.webview.onDidReceiveMessage(message => {
          if (message.type === "componentsSmoke") {
            try { strictEqual(message.ok, true, message.error); strictEqual(message.narrow, narrowExpected, "Unexpected editor group width"); resolve(); } catch (error) { reject(error); }
          }
        });
      });
      if (!narrowExpected) {
        const extensionUri = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!.extensionUri;
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(extensionUri, ".test-out", "components-ux-fixture.json"), Buffer.from(JSON.stringify({ html: panel!.webview.html,
          item: { ...componentItemDetails(groupedDetails(), datasourceId, "en"), role: "Datasource", references: [] } })));
      }
      const nonce = /nonce="([a-f0-9]+)"/u.exec(panel!.webview.html)![1];
      const script = `(async()=>{
        try{
          const wait=async fn=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error("Details UI did not settle");};
          const header=document.getElementById("page-header"), tree=document.getElementById("tree"), toggle=document.getElementById("expand");
          if(!header.contains(document.getElementById("component-count"))||!header.contains(document.getElementById("layout-context")))throw Error("Metadata is not in header");
          if(tree.contains(document.getElementById("layout-context")))throw Error("Metadata still in tree");
          if(getComputedStyle(header).borderBottomStyle!=="solid"||header.getBoundingClientRect().width!==document.getElementById("workspace").getBoundingClientRect().width)throw Error("Full-width header divider missing");
          if(!toggle.hidden||!toggle.disabled)throw Error("Empty pane offers expansion");
          toggle.click();if(workspace.classList.contains("expanded"))throw Error("Empty pane expanded");
          if(!header.textContent.includes("Default")||header.textContent.includes("not proof"))throw Error("Device or prose incorrect");
          const button=document.querySelector("[data-component]"), chevron=document.querySelector(".branch-toggle");
          if(document.querySelector("[data-datasource]")||!button.textContent.endsWith("[Component]"))throw Error("Duplicate or incorrect selection row");
          const row=button.closest(".component-row");
          if(Math.abs(button.getBoundingClientRect().right-row.getBoundingClientRect().right)>1||getComputedStyle(button).whiteSpace!=="normal")throw Error("Row does not fill/wrap");
          chevron.click();
          if(!document.getElementById(chevron.getAttribute("aria-controls")).hidden||workspace.classList.contains("show-details"))throw Error("Chevron selected component");
          chevron.click();
          const refs=document.querySelector("[data-reference-key]");refs.open=true;
          await wait(()=>refs.querySelectorAll(".component-select").length===4);
          const referenceRows=refs.querySelectorAll(".component-select");
          if(referenceRows[0].textContent!=="Effective reference"||referenceRows[1].textContent!=="Effective reference")throw Error("Ordered repeated references lost");
          const asset=[...refs.querySelectorAll("details")].find(el=>el.querySelector("summary")?.textContent==="Asset information");
          if(!asset||asset.open)throw Error("Asset evidence absent or not collapsed");
          asset.querySelector("summary").click();
          if(!asset.querySelector("pre").textContent.includes('<image mediaid="'))throw Error("Asset XML lost");
          const evidence=[...refs.querySelectorAll("details")].filter(el=>el.querySelector("summary")?.textContent==="Link information");
          if(evidence.length!==2||evidence.some(el=>el.open))throw Error("Link information not collapsed");
          if(refs.querySelector("a[href]")||!refs.textContent.includes("External URL — not an item reference"))throw Error("External link was navigable or lost");
          evidence[1].querySelector("summary").click();
          if(!evidence[1].open||!evidence[1].querySelector("pre").textContent.includes('<link linktype="external"'))throw Error("Raw link evidence lost");
          const child=refs.querySelector(".reference-branch");child.open=true;
          await wait(()=>child.textContent.includes("Cycle — already in this branch"));
          referenceRows[0].click();
          await wait(()=>document.getElementById("detail-content").textContent.includes("Referenced item"));
          if(!document.getElementById("detail-content").textContent.includes("${referenceId}"))throw Error("Reference selection targeted owner");
          if(narrowLayout.matches){document.getElementById("back").click();if(document.activeElement!==referenceRows[0])throw Error("Reference focus not restored");}
          button.click();
          if(chevron.getAttribute("aria-expanded")!=="true")throw Error("Selection collapsed children");
          await wait(()=>document.querySelector(".field"));
          if(!document.getElementById("detail-content").textContent.includes("${datasourceId}"))throw Error("Wrong datasource identity");
          if(document.querySelector(".field input,.field textarea"))throw Error("Fields became editable");
          const groups=[...document.querySelectorAll(".field-group")];
          const standard=groups.find(group=>group.querySelector("summary").textContent==="Statistics");
          if(!standard||standard.open||!standard.querySelector(".field"))throw Error("Standard fields not retained/collapsed");
          for(const name of ["Content","Mixed"]){if(!groups.find(group=>group.querySelector("summary").textContent===name)?.open)throw Error("Content hidden");}
          standard.querySelector("summary").click();if(!standard.open)throw Error("Standard fields cannot expand");
          const split=document.getElementById("divider");
          split.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
          if(split.getAttribute("aria-valuenow")!=="45")throw Error("Keyboard resize failed");
          const narrow=matchMedia("(max-width:700px)").matches;
          if(narrow && getComputedStyle(document.getElementById("tree")).display!=="none")throw Error("Narrow details did not replace tree");
          if(toggle.hidden||toggle.disabled||toggle.getAttribute("aria-label")!=="Expand details"||!toggle.querySelector("svg"))throw Error("Loaded toggle invalid");
          if(narrow){
            if(getComputedStyle(toggle).display!=="none")throw Error("Narrow expand duplicates Back");
            document.getElementById("back").click();
            if(document.activeElement!==button||getComputedStyle(tree).display==="none")throw Error("Back/focus failed");
          }else{
            if(getComputedStyle(document.getElementById("back")).display!=="none")throw Error("Desktop Back visible");
            toggle.focus();toggle.click();
            if(getComputedStyle(tree).display!=="none"||toggle.title!=="Restore split view")throw Error("Expand failed");
            if(getComputedStyle(document.getElementById("back")).display!=="none")throw Error("Duplicate restore action");
            toggle.click();
            if(getComputedStyle(tree).display==="none"||toggle.title!=="Expand details"||document.activeElement!==toggle)throw Error("Restore/focus failed");
          }
          document.querySelectorAll("[data-component]")[1].click();
          await wait(()=>document.getElementById("detail-content").textContent.includes("No datasource is declared"));
          if(!toggle.hidden||!toggle.disabled||!document.getElementById("detail-content").textContent.includes("Component instance"))throw Error("Instance-only control state invalid");
          api.postMessage({type:"componentsSmoke",ok:true,narrow});
        }catch(error){api.postMessage({type:"componentsSmoke",error:String(error)});}
      })();`;
      panel!.webview.html = panel!.webview.html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
      await result;
    } finally {
      clearTimeout(timer); listener?.dispose(); provider.dispose(); spy.mock.restore(); load.mock.restore(); lookup.mock.restore();
      await vscode.commands.executeCommand("workbench.action.editorLayoutSingle");
    }
  },
})), {
  name: "closing page components cancels an outstanding Preview read",
  async execute() {
    const { connections, authoring } = dependencies();
    let panel: vscode.WebviewPanel | undefined, received: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      panel = original(...args); return panel;
    });
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, _token, _selection, signal) => {
      received = signal; started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
    } });
    try {
      const opening = provider.open({ connectionId: "test", itemId: id, language: "en" });
      await startedPromise;
      panel!.dispose();
      await opening;
      strictEqual(received!.aborted, true);
      await rejects(provider.open({ connectionId: "test", itemId: "invalid", language: "en" }));
    } finally { provider.dispose(); spy.mock.restore(); }
  },
}];

function details(itemId: string): AuthoringItemDetails {
  return { itemId, name: "Datasource", displayName: "Datasource", path: "/sitecore/content/Example/Data", hasChildren: false,
    language: "en", version: 2, template: { templateId: id, name: "Text" }, availableVersions: [{ language: "en", version: 2 }],
    fields: [{ fieldId: id, name: "Related", label: "Related", type: "Droplink", typeKey: "droplink", value: "{33333333-3333-3333-3333-333333333333}",
      scope: "VERSIONED", sectionName: "Content", sectionSortOrder: 0, sortOrder: 0, isStandardTemplate: false,
      containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: false }] };
}

function groupedDetails(): AuthoringItemDetails {
  const item = details(datasourceId), field = item.fields[0];
  return { ...item, fields: [
    { ...field, containsStandardValue: true },
    { ...field, fieldId: referenceId, name: "__Updated", label: "Updated", sectionName: "Statistics", isStandardTemplate: true },
    { ...field, name: "__System", sectionName: "Mixed", isStandardTemplate: true },
    { ...field, sectionName: "Mixed" },
  ] };
}
