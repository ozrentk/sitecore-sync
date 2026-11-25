import { test } from "node:test";
import { deepStrictEqual, equal, throws, match, doesNotMatch, rejects } from "node:assert/strict";
import { componentRoute, componentDeviceName, parsePageComponents, renderComponentTree, resolveComponentDatasources } from "../../src/editor/pageComponents";

const id = "11111111111111111111111111111111";
const selected = { itemId: id, language: "en-AU", site: "Example" };
test("device display recognizes only the verified Default identity", () => {
  equal(componentDeviceName("{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}"), "Default");
  equal(componentDeviceName("fe5d7fdf89c04d999aa3b5fbd009c9f3"), "Default");
  equal(componentDeviceName(id), id);
  equal(componentDeviceName("Unknown"), "Unknown");
});
const instance = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid: id, componentName: "RichText", dataSource: "/sitecore/content/Example/Partial/Data/Text",
  isContentResolved: true, params: { empty: "", label: "A&B" }, ...extra,
});
test("datasource lookups deduplicate references, isolate failures and escape resolved labels", async () => {
  const tree = parsePageComponents(fixture({ main: [instance(), instance(), instance({ dataSource: id }),
    instance({ dataSource: "local:/unknown" })] }), selected);
  const reads: string[] = [];
  const resolved = await resolveComponentDatasources(tree, async reference => {
    reads.push(reference);
    if (reference === id) throw Error("private server error");
    return { itemId: id, label: "<Label>", path: "/sitecore/content/label" };
  }, new AbortController().signal);
  equal(reads.length, 2);
  equal(resolved.get(id)?.itemId, undefined);
  const html = renderComponentTree(tree, resolved);
  match(html, /&lt;Label&gt;/u);
  doesNotMatch(html, /data-datasource=|Datasource: /u);
  equal((html.match(/data-component=/gu) || []).length, 4);
  match(html, /Datasource unavailable/u);
  doesNotMatch(html, /private server error|<Label>/u);
});
test("datasource resolution bounds concurrency and stops on cancellation", async () => {
  const tree = parsePageComponents(fixture({ main: Array.from({ length: 12 }, (_, n) =>
    instance({ dataSource: `/sitecore/content/Item${n}` })) }), selected);
  let active = 0, maximum = 0;
  await resolveComponentDatasources(tree, async reference => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { label: reference };
  }, new AbortController().signal);
  equal(maximum, 4);
  const controller = new AbortController();
  controller.abort();
  await rejects(resolveComponentDatasources(tree, async () => { throw Error("must not read"); }, controller.signal));
});
function fixture(placeholders: unknown = { main: [instance()] }, route: Record<string, unknown> = {}): unknown {
  return { status: "collected", rendered: { sitecore: { context: { site: { name: "Example" }, language: "en-AU" },
    route: { itemId: id, name: "Page", databaseName: "master", itemLanguage: "en-AU", itemVersion: 1, placeholders, ...route } } } };
}
test("component tree preserves partial nesting, order, empty parameters and occurrence identity", () => {
  const tree = parsePageComponents(fixture({ main: [instance({ componentName: "Partial", dataSource: "", placeholders: {
    "sxa-signature": [instance(), instance({ dataSource: "local:/unresolved" })],
  } })] }), selected);
  equal(tree.count, 3);
  equal(tree.device, "Unknown");
  const children = tree.placeholders[0]!.components[0]!.placeholders[0]!.components;
  equal(children[0]!.parameters.empty, "");
  equal(children[0]!.datasourceKind, "item");
  equal(children[1]!.datasourceKind, "unresolved");
  equal(children[1]!.issues.includes("Repeated instance identity; kept as a separate occurrence"), true);
  equal(new Set(children.map(child => child.key)).size, 2);
});
test("component tree rejects mismatched identity, locale, database and malformed/incomplete layouts", () => {
  for (const override of [{ itemId: "22222222222222222222222222222222" }, { itemLanguage: "en" }, { databaseName: "web" },
    { itemVersion: 0 }, { placeholders: null }, { placeholders: { main: "invalid" } }]) {
    throws(() => parsePageComponents(fixture(undefined, override), selected));
  }
  throws(() => parsePageComponents({ status: "unresolved" }, selected));
  throws(() => parsePageComponents(fixture(), { ...selected, site: "Other" }));
  throws(() => parsePageComponents(fixture({ main: [instance({ params: { bad: {} } })] }), selected));
});
test("component tree fails closed at traversal limits and on cancellation", () => {
  equal(parsePageComponents(fixture({ main: Array.from({ length: 500 }, () => instance()) }), selected).count, 500);
  throws(() => parsePageComponents(fixture({ main: Array.from({ length: 501 }, () => instance()) }), selected));
  let ph: unknown = { main: [] };
  for (let i = 0; i < 22; i++) ph = { main: [instance({ placeholders: ph })] };
  throws(() => parsePageComponents(fixture(ph), selected));
  const controller = new AbortController(); controller.abort();
  throws(() => parsePageComponents(fixture(), selected, controller.signal));
});
test("unknown identity remains visible and HTML cannot execute remote content", () => {
  const tree = parsePageComponents(fixture({ "<img src=x>": [instance({
    uid: undefined, componentName: "<script>alert(1)</script>", dataSource: "javascript:alert(1)",
    params: { x: "</pre><iframe src='x'>" }, isContentResolved: false,
  })] }), selected);
  const html = renderComponentTree(tree);
  doesNotMatch(html, /<script|<iframe|<img|href=/u);
  match(html, /&lt;script&gt;/u);
  match(html, /Datasource unavailable/u);
  equal(tree.placeholders[0]!.components[0]!.issues.length, 2);
  equal(parsePageComponents(fixture({}), selected).count, 0);
});
test("route candidate preserves item names and requires a home boundary inside the site", () => {
  const site = { name: "Example", rootPath: "/sitecore/content/Example" };
  equal(componentRoute("/sitecore/content/Example/global/home/Test Drive Week", site), "/Test Drive Week");
  equal(componentRoute("/sitecore/content/Example/Home", site), "/");
  throws(() => componentRoute("/sitecore/content/ExampleOther/Home/Page", site));
  throws(() => componentRoute("/sitecore/content/Example/Settings", site));
  deepStrictEqual(parsePageComponents(fixture({}), selected).placeholders, []);
});

test("component rows combine labels and types, retain unresolved expressions and branch independently", () => {
  const tree = parsePageComponents(fixture({ main: [instance({ dataSource: "", componentName: "MainHeroBanner", placeholders: {
    nested: [instance(), instance({ dataSource: "local:/query<value>" })],
  } }), instance()] }), selected);
  const html = renderComponentTree(tree, new Map([["/sitecore/content/Example/Partial/Data/Text", { itemId: id, label: "SW - Title - Rich Text" }]]));
  match(html, />\[MainHeroBanner\]<\/button>/u);
  equal((html.match(/SW - Title - Rich Text \[RichText\]<\/button>/gu) || []).length, 2);
  equal((html.match(/class="branch-toggle"/gu) || []).length, 1);
  match(html, /aria-controls="component-branch-1"/u);
  match(html, /id="component-branch-1"/u);
  match(html, /Declared datasource: local:\/query&lt;value&gt;/u);
  match(html, /\[RichText\] — Datasource unavailable/u);
  doesNotMatch(html, /data-datasource|<value>|None declared/u);
});
