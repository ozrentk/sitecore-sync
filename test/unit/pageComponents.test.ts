import { test } from "node:test";
import { deepStrictEqual, equal, throws, match, doesNotMatch } from "node:assert/strict";
import { componentRoute, parsePageComponents, renderComponentTree } from "../../src/editor/pageComponents";

const id = "11111111111111111111111111111111";
const selected = { itemId: id, language: "en-AU", site: "Example" };
const instance = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid: id, componentName: "RichText", dataSource: "/sitecore/content/Example/Partial/Data/Text",
  isContentResolved: true, params: { empty: "", label: "A&B" }, ...extra,
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
  match(html, /resolution unknown/u);
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
