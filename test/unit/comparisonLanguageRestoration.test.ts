import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function webview() {
  const messages: Array<Record<string, unknown>> = [];
  const context = createContext({
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message) }),
    document: {
      getElementById: () => ({ addEventListener: () => undefined }),
      addEventListener: () => undefined,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  new Script(await readFile(resolve("media/comparison/comparison.js"), "utf8")).runInContext(context);
  const run = (code: string): unknown => new Script(code).runInContext(context);
  run(`
    render = () => refreshLoadedItemIndexes();
    const items = {
      aa: { itemId: 'aa', path: '/sitecore', name: 'root', hasChildren: true },
      bb: { itemId: 'bb', path: '/sitecore/A', name: 'A', hasChildren: true },
      cc: { itemId: 'cc', path: '/sitecore/B', name: 'B', hasChildren: true },
      dd: { itemId: 'dd', path: '/sitecore/A/Deep', name: 'Deep', hasChildren: true },
      ee: { itemId: 'ee', path: '/sitecore/A/Deep/Selected', name: 'Selected', hasChildren: false },
      ff: { itemId: 'ff', path: '/sitecore/B/Child', name: 'Child', hasChildren: false },
      ab: { itemId: 'ab', path: '/sitecore/Collapsed', name: 'Collapsed', hasChildren: true },
    };
    const children = { aa: ['bb', 'cc', 'ab'], bb: ['dd'], dd: ['ee'], cc: ['ff'], ab: [], ee: [], ff: [] };
    function respond(side, id, language = state.trees[side].language, childIds = children[id]) {
      applyLoadedLevel({ side, connectionId: side, language,
        requestedItemId: id === 'aa' ? undefined : id,
        level: { item: { ...items[id], displayName: language + ':' + items[id].name },
          children: childIds.map((child) => ({ ...items[child], displayName: language + ':' + items[child].name })) } });
      advanceLanguageRestoration();
    }
    state.selection = { leftConnectionId: 'left', rightConnectionId: 'right', leftLanguage: 'en', rightLanguage: 'en' };
    for (const side of ['left', 'right']) {
      state.trees[side] = emptyTreeState(side, 'en');
      for (const id of ['aa', 'bb', 'dd', 'cc']) { respond(side, id); }
    }
    refreshLoadedItemIndexes();
    state.expandedRows = new Set(['root:aa:aa', 'id:bb', 'id:dd', 'id:cc']);
    state.selectedRowKey = 'id:ee';
    function change(left, right = state.selection.rightLanguage) {
      state.selection = { ...state.selection, leftLanguage: left, rightLanguage: right };
      updateTreeConnections();
      advanceLanguageRestoration();
    }
  `);
  let cursor = messages.length;
  const drain = () => {
    let attempts = 0;
    while (cursor < messages.length) {
      if (++attempts > 100) { throw new Error("Restoration did not terminate"); }
      const message = messages[cursor++];
      if (message.type === "loadChildren") {
        run(`respond(${JSON.stringify(message.side)}, ${JSON.stringify(message.itemId)}, ${JSON.stringify(message.language)})`);
      }
    }
  };
  return { run, messages, drain };
}

test("language changes restore selection before other branches and preserve the unchanged side", async () => {
  const view = await webview();
  view.run("const originalRight = state.trees.right; change('fr'); respond('left', 'aa');");
  strictEqual(view.run("state.trees.right === originalRight"), true);
  strictEqual(view.run("state.selectedRowKey"), undefined);
  view.drain();
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
  strictEqual(view.run("state.languageRestore"), undefined);
  for (const key of ["root:aa:aa", "id:bb", "id:dd", "id:cc"]) {
    strictEqual(view.run(`state.expandedRows.has('${key}')`), true);
  }
  strictEqual(view.run("state.expandedRows.has('id:ab')"), false);
  strictEqual(view.run("findNode(state.trees.left.root, 'ee').displayName"), "fr:Selected");
  const loads = view.messages.filter((message) => message.type === "loadChildren");
  deepStrictEqual(loads.map((message) => [message.side, message.itemId, message.language]), [
    ["left", "bb", "fr"], ["left", "dd", "fr"], ["left", "cc", "fr"],
  ]);
  const selectionIndex = view.messages.findIndex((message) => message.type === "selectFieldDiffItem");
  const siblingIndex = view.messages.findIndex((message) => message.type === "loadChildren" && message.itemId === "cc");
  strictEqual(selectionIndex < siblingIndex, true);
});

test("locked language changes restore both sides and fall back by identity instead of selecting a replacement path", async () => {
  const view = await webview();
  view.run(`
    change('fr', 'fr');
    items.ee = { ...items.ee, itemId: 'replacement' };
    respond('left', 'aa'); respond('right', 'aa');
  `);
  view.drain();
  strictEqual(view.run("state.selectedRowKey"), "id:dd");
  strictEqual(view.run("state.languageRestoreNotice.includes('nearest available ancestor')"), true);
  strictEqual(view.run("state.languageRestore"), undefined);
});

test("rapid language changes retain the original expansion plan and ignore old-language replies", async () => {
  const view = await webview();
  view.run("change('fr', 'fr'); respond('left', 'aa'); respond('right', 'aa'); change('de', 'de'); respond('left', 'bb', 'fr');");
  strictEqual(view.run("state.trees.left.root"), undefined);
  view.run("respond('left', 'aa'); respond('right', 'aa');");
  view.drain();
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
  strictEqual(view.run("state.expandedRows.has('id:cc')"), true);
  strictEqual(view.run("state.languageRestore"), undefined);
});

test("explicit navigation cancels restoration and late results do not steal selection", async () => {
  const view = await webview();
  view.run("change('fr'); respond('left', 'aa'); cancelLanguageRestoration(); state.selectedRowKey = 'id:cc';");
  view.drain();
  strictEqual(view.run("state.selectedRowKey"), "id:cc");
  strictEqual(view.run("state.languageRestore"), undefined);
  strictEqual(view.messages.some((message) => message.type === "selectFieldDiffItem"), false);
});

test("branch and root failures stop restoration without retry loops", async () => {
  const view = await webview();
  view.run(`
    change('fr'); respond('left', 'aa');
    applyLoadFailure({ side: 'left', connectionId: 'left', language: 'fr', requestedItemId: 'bb', message: 'offline' });
    advanceLanguageRestoration();
  `);
  view.drain();
  strictEqual(view.run("state.languageRestore"), undefined);
  strictEqual(view.run("Boolean(state.languageRestoreNotice)"), true);
  const failedRoot = await webview();
  failedRoot.run(`change('fr'); applyLoadFailure({ side: 'left', connectionId: 'left', language: 'fr', message: 'offline' }); advanceLanguageRestoration();`);
  strictEqual(failedRoot.run("state.languageRestore"), undefined);
  strictEqual(failedRoot.run("state.languageRestoreNotice.includes('root failed')"), true);
});

test("connection changes reset state and no-op language updates leave state intact", async () => {
  const view = await webview();
  view.run("change('en');");
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
  strictEqual(view.run("state.languageRestore"), undefined);
  view.run("state.selection.leftConnectionId = 'another'; updateTreeConnections();");
  strictEqual(view.run("state.selectedRowKey"), undefined);
  strictEqual(view.run("state.languageRestore"), undefined);
  strictEqual(view.run("state.expandedRows.size"), 0);
});

test("a collapsed root and a missing-language-version item keep their structural state", async () => {
  const view = await webview();
  view.run("state.expandedRows.clear(); state.selectedRowKey = undefined; change('fr', 'fr'); respond('left', 'aa'); respond('right', 'aa');");
  strictEqual(view.run("state.expandedRows.size"), 0);
  strictEqual(view.run("state.languageRestore"), undefined);
  const noVersion = await webview();
  noVersion.run("items.ee = { ...items.ee, version: 0 }; change('fr', 'fr'); respond('left', 'aa'); respond('right', 'aa');");
  noVersion.drain();
  strictEqual(noVersion.run("state.selectedRowKey"), "id:ee");
});


test("selection follows a pairing-key change when the counterpart appears in a later branch", async () => {
  const view = await webview();
  view.run(`
    const baseRespond = respond;
    respond = (side, id, language = state.trees[side].language) => {
      baseRespond(side, id, language,
        side === 'right' && id === 'dd' ? [] : side === 'right' && id === 'cc' ? ['ee', 'ff'] : children[id]);
    };
    respond('right', 'dd'); respond('right', 'cc');
    change('fr', 'fr'); respond('left', 'aa'); respond('right', 'aa');
  `);
  view.drain();
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
  strictEqual(view.run("state.languageRestore"), undefined);
});
