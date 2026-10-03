import { strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function webview() {
  let receive!: (event: unknown) => void;
  const messages: Array<Record<string, unknown>> = [];
  const context = createContext({
    acquireVsCodeApi: () => ({ postMessage: (value: Record<string, unknown>) => messages.push(value) }),
    document: { body: { classList: { toggle() {} } }, getElementById: () => ({ scrollTop: 25, closest: () => ({}),
      addEventListener() {}, setAttribute() {}, replaceChildren() {} }), addEventListener() {}, querySelectorAll: () => [] },
    window: { scrollY: 50, scrollTo() {}, addEventListener: (type: string, listener: typeof receive) => { if (type === "message") receive = listener; } },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  new Script(await readFile(resolve("media/comparison/comparison.js"), "utf8")).runInContext(context);
  const run = (code: string): unknown => new Script(code).runInContext(context);
  run(`render = () => refreshLoadedItemIndexes();
    const root = { itemId: 'aa', path: '/sitecore', name: 'root', hasChildren: true };
    const child = { itemId: 'bb', path: '/sitecore/page', name: 'page', hasChildren: true };
    const leaf = { itemId: 'cc', path: '/sitecore/page/data', name: 'data', hasChildren: false };
    state.mode = 'compare'; state.selection = { leftConnectionId: 'a', rightConnectionId: 'b', leftLanguage: 'en', rightLanguage: 'fr' };
    for (const [side, id, language] of [['left', 'a', 'en'], ['right', 'b', 'fr']]) {
      state.trees[side] = emptyTreeState(id, language);
      applyLoadedLevel({side, connectionId: id, language, level: {item: root, children: [child]}});
      applyLoadedLevel({side, connectionId: id, language, requestedItemId: 'bb', level: {item: child, children: [leaf]}});
    }
    state.expandedRows = new Set(['root:aa:aa', 'id:bb']); state.selectedRowKey = 'id:cc';`);
  const switchTo = (mode: string, selection: unknown, retainedFrom?: string) => receive({ data: { type: "stateChanged", mode, selection,
    connections: [{ id: "a" }, { id: "b" }], viewContext: 5, retainedFrom } });
  return { run, messages, switchTo };
}

test("Browse always retains left navigation even if an old message requests right", async () => {
  const view = await webview();
  view.run("state.rootRowKey = 'id:bb'");
  view.switchTo("browse", { leftConnectionId: "a", leftLanguage: "en", rightLanguage: "en" }, "right");
  strictEqual(view.run("state.trees.left.language"), "en");
  strictEqual(view.run("state.trees.left.root.itemId"), "bb");
  strictEqual(view.run("state.selectedRowKey"), "left:cc");
  strictEqual(view.run("state.expandedRows.has('root:bb:missing')"), true);
  strictEqual(view.messages.some(message => message.type === "selectBrowseItem" && message.leftItemId === "cc"), true);
});

test("round-trip restores partner tree and remaps Browse expansion and selection to paired rows", async () => {
  const view = await webview();
  view.switchTo("browse", { leftConnectionId: "a", leftLanguage: "en", rightLanguage: "en" }, "left");
  strictEqual(view.run("state.selectedRowKey"), "left:cc");
  view.switchTo("compare", { leftConnectionId: "a", rightConnectionId: "b", leftLanguage: "en", rightLanguage: "fr" });
  strictEqual(view.run("state.trees.right.root.children[0].children[0].itemId"), "cc");
  strictEqual(view.run("state.selectedRowKey"), "id:cc");
  strictEqual(view.run("state.expandedRows.has('id:bb')"), true);
});

test("mode picker requests do not clear the live view; explicit navigation cancels pending restoration", async () => {
  const view = await webview();
  view.run("requestMode('browse')");
  strictEqual(view.run("state.selectedRowKey"), "id:cc");
  strictEqual(view.messages.at(-1)?.type, "switchMode");
  view.switchTo("browse", { leftConnectionId: "a", leftLanguage: "en", rightLanguage: "en" }, "left");
  view.switchTo("compare", { leftConnectionId: "a", rightConnectionId: "new", leftLanguage: "en", rightLanguage: "de" });
  strictEqual(view.run("Boolean(modeRestoration)"), true);
  view.run("cancelLanguageRestoration()");
  strictEqual(view.run("modeRestoration"), undefined);
});

test("selection waits for partner branches so late pairing cannot replace its row key", async () => {
  const view = await webview();
  view.switchTo("browse", { leftConnectionId: "a", leftLanguage: "en", rightLanguage: "en" }, "left");
  view.switchTo("compare", { leftConnectionId: "a", rightConnectionId: "new", leftLanguage: "en", rightLanguage: "de" });
  view.run("applyLoadedLevel({side:'right',connectionId:'new',language:'de',level:{item:root,children:[child]}}); applyModeRestoration();");
  strictEqual(view.run("Boolean(modeRestoration)"), true);
  view.run("applyLoadedLevel({side:'right',connectionId:'new',language:'de',requestedItemId:'bb',level:{item:child,children:[leaf]}}); applyModeRestoration();");
  strictEqual(view.run("modeRestoration"), undefined);
  strictEqual(view.run("state.selectedRowKey"), "id:cc");
});
