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
  // Exercise the shipped tree/reveal logic without requiring a browser renderer.
  new Script(`
    render = () => refreshLoadedItemIndexes();
    function item(id, path, hasChildren = true) {
      return { itemId: id, path, name: path.split('/').pop(), hasChildren };
    }
    function load(side, parent, children, root = false) {
      applyLoadedLevel({ side, connectionId: side, language: 'en',
        requestedItemId: root ? undefined : parent.itemId, level: { item: parent, children } });
    }
    const root = item('aa', '/sitecore');
    const checkout = item('bb', '/sitecore/Checkout');
    const cta = item('cc', '/sitecore/CTA Buttons');
    const summary = item('dd', '/sitecore/Checkout/Order Summary');
    const favorite = item('ee', '/sitecore/Checkout/Order Summary/Key Vehicle Features', false);
    for (const side of ['left', 'right']) {
      state.trees[side] = emptyTreeState(side, 'en');
      load(side, root, [checkout, cta], true);
      load(side, checkout, [summary]);
      load(side, summary, [favorite]);
    }
  `).runInContext(context);
  return {
    messages,
    run: (code: string): unknown => new Script(code).runInContext(context),
  };
}

test("favorite survives late ancestor and root responses with reordered siblings on either side", async () => {
  for (const side of ["left", "right"]) {
    for (const rootResponse of [false, true]) {
      const view = await webview();
      view.run(`
        load('${side}', root, [cta, { ...checkout, itemId: '{BB}', displayName: 'Updated' }], ${rootResponse});
        load('${side}', checkout, [summary]);
      `);
      strictEqual(view.run(`revealFavorite('${side}', favorite.path)`), true);
      strictEqual(view.run(`findNode(state.trees['${side}'].root, 'bb').displayName`), "Updated");
      strictEqual(view.run("state.selectedRowKey"), "id:ee");
      strictEqual(view.run("state.expandedRows.has('id:bb')"), true);
      strictEqual(view.run("state.expandedRows.has('id:cc')"), false);
      deepStrictEqual({ ...view.messages.at(-1) }, {
        type: "selectFieldDiffItem", leftItemId: "ee", rightItemId: "ee",
        leftName: "Key Vehicle Features", rightName: "Key Vehicle Features",
      });
    }
  }
});

test("ancestor updates honor removals and never reuse descendants for a replacement identity", async () => {
  const view = await webview();
  view.run("load('left', root, [cta, { ...checkout, itemId: 'ff' }]);");
  strictEqual(view.run("state.trees.left.root.children[0].itemId"), "cc");
  strictEqual(view.run("state.trees.left.root.children[1].childrenLoaded"), false);
  strictEqual(view.run("findNode(state.trees.left.root, 'ee')"), undefined);
  view.run("load('right', root, [cta]);");
  strictEqual(view.run("revealFavorite('right', favorite.path)"), false);
});
