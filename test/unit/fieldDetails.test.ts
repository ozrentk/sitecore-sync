import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function view() {
  const messages: unknown[] = [];
  const context = createContext({
    acquireVsCodeApi: () => ({ getState: () => ({ visibility: { content: "differences" } }), setState() {}, postMessage: (message: unknown) => messages.push(message) }),
    document: { body: { classList: { toggle() {} } }, getElementById: () => ({ addEventListener() {}, setAttribute() {} }), querySelectorAll: () => [],
      createElement: (tag: string) => ({ tag, dataset: {}, listeners: {} as Record<string, () => void>, children: [] as unknown[], textContent: "", className: "", classList: { add() {} },
        append(...children: unknown[]) { this.children.push(...children); }, setAttribute() {}, addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; } }) },
    window: { addEventListener() {} },
  });
  new Script(await readFile("media/fieldDiff/fieldDiff.js", "utf8")).runInContext(context);
  const run = (source: string): unknown => new Script(source).runInContext(context);
  run('const field = { fieldId: "a", name: "Title", label: "Title", value: "<script>untrusted</script>", type: "Text", typeKey: "text", scope: "SHARED", textual: true, isStandardTemplate: false };');
  return { run, messages };
}

test("Browse field rows have one read-only value and retain scope/source metadata without differences", async () => {
  const v = await view();
  v.run('state.mode = "browse"; const pair = createPair(field, undefined); const row = createFieldRow(pair);');
  strictEqual(v.run('pair.flags.length'), 0);
  strictEqual(v.run('row.children.length'), 1);
  strictEqual(v.run('row.className.includes("different")'), false);
  strictEqual(v.run('row.children[0].children[2].textContent'), "<script>untrusted</script>");
  strictEqual(v.run('row.children[0].children[0].children[1].textContent'), "S");
  strictEqual(v.run('scopeMarker({ ...field, scope: "UNVERSIONED" }).textContent'), "U");
  strictEqual(v.run('pairIsVisible(pair)'), true);
  v.run('state.browseVisibility.content = "hidden";');
  strictEqual(v.run('pairIsVisible(pair)'), false);
  strictEqual(v.run('state.visibility.content'), "differences");
  strictEqual(v.run('fieldSource({ ...field, containsFallbackValue: true })'), "fallback");
});

test("Browse summary has one identity and Compare retains paired fields and difference flags", async () => {
  const v = await view();
  v.run('state.mode = "browse"; const summary = createSummary({ leftDetails: { itemId: "item", path: "/sitecore/Home", language: "fr", version: 3, template: { name: "Page" } }, leftConnectionName: "Authoring" });');
  strictEqual(v.run('summary.children.length'), 1);
  strictEqual(v.run('summary.children[0].children[0].textContent'), "Home · Authoring · fr");
  strictEqual(v.run('summary.children[0].children[1].children.slice(0, 2).map(child => child.textContent).join("")'), "/sitecore/Home · Page · latest version 3");
  v.run('state.mode = "compare"; const pair = createPair(field, { ...field, value: "other" });');
  deepStrictEqual(JSON.parse(v.run('JSON.stringify(pair.flags)') as string), ["Value"]);
  strictEqual(v.run('createFieldRow(pair).children.length'), 3);
  strictEqual(v.run('pairIsVisible(pair)'), true);
});

test("empty Browse fields distinguish hidden values, API absence and failures", async () => {
  const v = await view();
  v.run('state.mode = "browse";');
  strictEqual(v.run('emptyFieldsMessage({}, 4)'), "All 4 returned field(s) are hidden by the current filters.");
  strictEqual(v.run('emptyFieldsMessage({ leftDetails: { language: "en-UK", version: 0, availableVersions: [{ language: "en", version: 2 }] } }, 0)'),
    "Authoring returned no fields for en-UK (version 0). Language fallback is not applied. Available versions: en (v2).");
  strictEqual(v.run('emptyFieldsMessage({ leftError: "Failed" }, 0)'), "Fields are unavailable because item details could not be loaded.");
  v.run('render = () => undefined; state.browseVisibility.content = "hidden"; showAllBrowseFields();');
  strictEqual(v.run('state.browseVisibility.content'), "all");
  strictEqual(v.run('state.browseVisibility.system'), "all");
  strictEqual(v.run('state.visibility.content'), "differences");
});

test("fallback comparison hides transfers and redundant evidence UI while marking unknown sources", async () => {
  const v = await view();
  v.run(`state.snapshot = { fallbackMode: "fallback" };
    const pair = createPair({ ...field, containsFallbackValue: true }, { ...field, value: "different" });
    const row = createFieldRow(pair);
    const summary = createSummary({ fallbackMode: "fallback", leftDetails: {
      itemId: "item", path: "/sitecore/Home", language: "en-NZ", version: 0, template: { name: "Page" },
      comparisonEvidence: { exact: { fields: [field] }, exactObservedAt: "a", effectiveObservedAt: "b" }
    } });`);
  strictEqual(v.run('row.children[1].children.every(child => child.className === "badge difference")'), true);
  strictEqual(v.run('row.children[0].children[1].textContent.includes("source language unknown")'), true);
  strictEqual(v.run('summary.children[0].children.length'), 3);
  v.run('state.snapshot.fallbackMode = "exact";');
  strictEqual(v.run('createFieldRow(pair).children[1].children[0].className'), "value-transfer");
});

test("version-zero fallback preserves requested identity and labels configured sources as candidates", async () => {
  const v = await view();
  v.run(`state.mode = "browse"; const details = { itemId: "item", path: "/sitecore/Home", language: "en-NZ", version: 0,
    template: { name: "Page" }, comparisonEvidence: { exact: { fields: [] } },
    itemFallback: { status: "candidate", chain: ["en-NZ", "en-AU", "en"], candidate: { language: "en", version: 1 } } };
    const summary = createSummary({ fallbackMode: "fallback", leftDetails: details });`);
  strictEqual(v.run('summary.children[0].children[0].textContent'), "Home · Connection · en-NZ");
  strictEqual(v.run('summary.children[0].children[1].children.slice(0, 2).map(child => child.textContent).join("")'), "/sitecore/Home · Page · latest version 0");
  strictEqual(v.run('summary.children[0].children[1].children[2].textContent'), "Configured fallback candidate: en-NZ → en-AU → en (v1)");
  strictEqual(v.run('emptyFieldsMessage({ fallbackMode: "fallback", leftDetails: details }, 0)'),
    "Authoring returned no fields for en-NZ (version 0). Fallback was requested; Authoring returned no values.");
});


test("identity copy buttons send side and item identity rather than a webview-supplied path", async () => {
  const v = await view();
  v.run(`state.contextId = 7; state.mode = "compare";
    const details = { itemId: "right-id", path: "/sitecore/content/A long path" };
    const pathButton = identityCopyButton("right", details, "path"); pathButton.listeners.click();`);
  strictEqual(v.run('pathButton.textContent'), "/sitecore/content/A long path");
  strictEqual(v.run('pathButton.title'), "Copy right item path");
  strictEqual(v.run('pathButton.disabled'), true);
  deepStrictEqual(JSON.parse(JSON.stringify(v.messages.at(-1))), { type: "copyItemPath", side: "right", itemId: "right-id", contextId: 7 });
  v.run('state.mode = "browse"; const idButton = identityCopyButton("left", details, "id"); idButton.listeners.click();');
  strictEqual(v.run('idButton.title'), "Copy item ID");
  deepStrictEqual(JSON.parse(JSON.stringify(v.messages.at(-1))), { type: "copyItemId", side: "left", itemId: "right-id", contextId: 7 });
});
