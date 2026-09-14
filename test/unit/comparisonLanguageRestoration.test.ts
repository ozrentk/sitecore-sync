import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function webview() {
  const messages: Array<Record<string, unknown>> = [];
  const replacements: unknown[] = [];
  const context = createContext({
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message) }),
    document: {
      getElementById: () => ({ addEventListener: () => undefined, setAttribute: () => undefined, replaceChildren: (value: unknown) => replacements.push(value) }),
      addEventListener: () => undefined,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  new Script(await readFile(resolve("media/comparison/comparison.js"), "utf8")).runInContext(context);
  const run = (code: string): unknown => new Script(code).runInContext(context);
  run(`
    const productionRender = render;
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
      finishBackgroundLanguageSwitch();
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
      if (message.type === "loadItemDetails") {
        run(`applyItemDetailsMessage({ side: ${JSON.stringify(message.side)}, connectionId: ${JSON.stringify(message.connectionId)}, language: ${JSON.stringify(message.language)}, itemId: ${JSON.stringify(message.itemId)}, details: { fields: [], template: { templateId: "template" }, availableVersions: [], language: ${JSON.stringify(message.language)} } }, "loaded"); advanceLanguageRestoration(); finishBackgroundLanguageSwitch();`);
      }
      if (message.type === "loadChildren") {
        run(`respond(${JSON.stringify(message.side)}, ${JSON.stringify(message.itemId)}, ${JSON.stringify(message.language)})`);
      }
    }
  };
  return { run, messages, drain, replacements };
}

test("language changes prepare selection and branches before committing and preserve the unchanged side", async () => {
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
  strictEqual(selectionIndex > siblingIndex, true);
  strictEqual(view.run("state.languageSwitch"), undefined);
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
  strictEqual(view.run("state.languageSwitch.failed"), true);
  strictEqual(view.run("state.languageSwitch.previous.trees.left.language"), "en");
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


test("background preparation retains the displayed snapshot and defers Field Diff until commit", async () => {
  const view = await webview();
  view.run("const displayed = state.trees.left; change('fr'); respond('left', 'aa');");
  strictEqual(view.run("state.languageSwitch.previous.trees.left === displayed"), true);
  strictEqual(view.run("state.languageSwitch.previous.selectedRowKey"), "id:ee");
  strictEqual(view.run("state.languageSwitch.previous.trees.left.language"), "en");
  strictEqual(view.run("state.trees.left.language"), "fr");
  strictEqual(view.messages.some(message => message.type === "selectFieldDiffItem"), false);
  view.drain();
  strictEqual(view.run("state.languageSwitch"), undefined);
  strictEqual(view.messages.at(-1)?.type, "selectFieldDiffItem");
});

test("failed preparation keeps the original view and Retry prepares it afresh", async () => {
  const view = await webview();
  view.run(`
    change('fr');
    applyLoadFailure({ side: 'left', connectionId: 'left', language: 'fr', message: 'offline' });
    advanceLanguageRestoration(); finishBackgroundLanguageSwitch();
  `);
  strictEqual(view.run("state.languageSwitch.failed"), true);
  strictEqual(view.run("state.languageSwitch.previous.trees.left.language"), "en");
  view.run("retryBackgroundLanguageSwitch(); respond('left', 'aa');");
  strictEqual(view.messages.some(message => message.type === "retryLanguageSwitch"), true);
  view.drain();
  strictEqual(view.run("state.languageSwitch"), undefined);
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
});

test("returning to the displayed language reuses its snapshot immediately", async () => {
  const view = await webview();
  view.run("const original = state.trees.left; change('fr'); change('en');");
  strictEqual(view.run("state.trees.left === original"), true);
  strictEqual(view.run("state.languageSwitch"), undefined);
  strictEqual(view.run("state.selectedRowKey"), "id:ee");
});


test("render leaves the existing DOM untouched until preparation commits", async () => {
  const view = await webview();
  view.run(`
    state.connections = [{ id: 'left' }, { id: 'right' }];
    renderOptions = () => undefined;
    renderLanguageOptions = () => undefined;
    createComparisonWorkspace = () => ({ snapshot: 'replacement' });
    change('fr'); productionRender(); respond('left', 'aa'); productionRender();
  `);
  strictEqual(view.replacements.length, 0);
  view.drain();
  view.run("productionRender();");
  strictEqual(view.replacements.length, 1);
  view.run(`
    change('de');
    applyLoadFailure({ side: 'left', connectionId: 'left', language: 'de', message: 'offline' });
    advanceLanguageRestoration(); finishBackgroundLanguageSwitch(); productionRender();
  `);
  strictEqual(view.replacements.length, 1, "A failed switch keeps the last displayed DOM");
});


test("switch labels follow changed sides through supersession, failure and completion", async () => {
  const view = await webview();
  const visibility = () => {
    view.run("updateLanguageSwitchStatus();");
    return [view.run("languageSwitchStatus.hidden"), view.run("languageSwitchStatusRight.hidden")];
  };
  deepStrictEqual(visibility(), [true, true]);
  view.run("change('fr');");
  deepStrictEqual(visibility(), [false, true]);
  view.run("change('fr', 'fr');");
  deepStrictEqual(visibility(), [false, false]);
  view.run("change('en', 'fr');");
  deepStrictEqual(visibility(), [true, false]);
  view.run(`
    applyLoadFailure({ side: 'right', connectionId: 'right', language: 'fr', message: 'offline' });
    advanceLanguageRestoration(); finishBackgroundLanguageSwitch();
  `);
  deepStrictEqual(visibility(), [true, false]);
  view.run("retryBackgroundLanguageSwitch(); respond('right', 'aa');");
  view.drain();
  deepStrictEqual(visibility(), [true, true]);
});
