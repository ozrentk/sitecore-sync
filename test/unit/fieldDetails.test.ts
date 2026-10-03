import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function view() {
  const messages: unknown[] = [];
  const context = createContext({
    acquireVsCodeApi: () => ({ getState: () => ({ visibility: { content: "differences" } }), setState() {}, postMessage: (message: unknown) => messages.push(message) }),
    document: { body: { classList: { toggle() {} } }, getElementById: () => ({}), querySelectorAll: () => [],
      createElement: (tag: string) => ({ tag, dataset: {}, children: [] as unknown[], textContent: "", className: "", classList: { add() {} },
        append(...children: unknown[]) { this.children.push(...children); }, setAttribute() {}, addEventListener() {} }) },
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
  strictEqual(v.run('summary.children[0].children[1].textContent'), "/sitecore/Home · Page · latest version 3");
  v.run('state.mode = "compare"; const pair = createPair(field, { ...field, value: "other" });');
  deepStrictEqual(JSON.parse(v.run('JSON.stringify(pair.flags)') as string), ["Value"]);
  strictEqual(v.run('createFieldRow(pair).children.length'), 3);
  strictEqual(v.run('pairIsVisible(pair)'), true);
});
