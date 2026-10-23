import { test } from "node:test";
import { strictEqual as equal, deepStrictEqual, rejects, throws, match } from "node:assert/strict";
import { parsePreviewReferenceItem, PreviewReferenceClient } from "../../src/sitecore/previewReferences";
import { ComponentReferences } from "../../src/editor/componentReferences";
import { previewReferenceEvidence } from "../../src/editor/componentReferenceEvidence";
import { SitecoreHttpClient } from "../../src/sitecore/sitecoreHttpClient";
import { QueuedHttpRuntime, noOpLogger, jsonResponse } from "./sitecoreClientTestHelpers";
const a = "11111111111111111111111111111111", b = "22222222222222222222222222222222", c = "33333333333333333333333333333333";
const signal = (): AbortSignal => new AbortController().signal;
const field = (targets = [b, b, c]) => ({ id: c, name: "links", value: targets.join("|"), definition: { type: "Multilist" }, __typename: "MultilistField", count: targets.length, targetIds: targets });
const raw = (fields = [field()]) => ({ id: a, name: "A", displayName: "A display", language: { name: "en-NZ" }, version: 1, fields });
test("Preview references preserve ordered repeated raw occurrences and distinguish unknown coverage", () => {
  const result = parsePreviewReferenceItem(raw(), a, "en-NZ")!;
  deepStrictEqual(result.fields[0].targets, [b, b, c]);
  equal(result.fields[0].issue, undefined);
  const malformed = parsePreviewReferenceItem(raw([field([b, "bad", "", b])]), a, "en-NZ")!;
  deepStrictEqual(malformed.fields[0].targets, [b, "bad", "", b]); match(malformed.fields[0].issue!, /Malformed/);
  const disagreement = parsePreviewReferenceItem(raw([{ ...field(), targetIds: [b, c] }]), a, "en-NZ")!;
  match(disagreement.fields[0].issue!, /disagree/);
  const asset = parsePreviewReferenceItem({ ...raw(), fields: [{ ...field(), __typename: "ImageField", definition: { type: "Image" }, value: '<image mediaid="' + b + '" />' }] }, a, "en-NZ")!;
  equal(asset.fields[0].targets.length, 0); match(asset.fields[0].issue!, /not verified/);
});
test("Preview rejects wrong identities, locale, incomplete and excessive fields", () => {
  for (const value of [{ ...raw(), id: b }, { ...raw(), language: { name: "en" } }, { ...raw(), version: 0 },
    raw([field(), field()]), { ...raw(), fields: Array(501).fill(field()) }, raw([field(Array(501).fill(b))]), {}]) {
    throws(() => parsePreviewReferenceItem(value, a, "en-NZ"));
  }
  equal(parsePreviewReferenceItem(null, a, "en-NZ"), null);
});
test("Preview adapter fixes endpoint/token/query and validates responses without retry or leakage", async () => {
  const runtime = new QueuedHttpRuntime([jsonResponse({ data: { item: raw() } })]);
  const client = new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, runtime));
  equal((await client.read("https://cm.example.test", "preview-token", a, "en-NZ", signal()))!.label, "A display");
  const request = runtime.requests[0]; equal(String(request.input), "https://cm.example.test/sitecore/api/graph/edge");
  equal(request.init.redirect, "error"); equal(new Headers(request.init.headers).get("sc_apikey"), "preview-token");
  const body = JSON.parse(String(request.init.body)); deepStrictEqual(body.variables, { id: a, language: "en-NZ" });
  match(body.query, /ownFields: false/);
  for (const response of [jsonResponse({}, 503), jsonResponse({ errors: [{ message: "preview-token" }], data: { item: raw() } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)), jsonResponse({ data: { item: { ...raw(), name: "preview-token" } } }), new Response("invalid")]) {
    const runtime = new QueuedHttpRuntime([response]);
    await rejects(new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, runtime)).read("https://cm.example.test", "preview-token", a, "en-NZ", signal()), /unavailable/);
    equal(runtime.requests.length, 1); equal(runtime.waits.length, 0);
  }
  await rejects(client.read("https://cm.example.test", "preview-token", a, "en-NZ", AbortSignal.abort()));
  equal(runtime.requests.length, 1);
});
test("Lazy graph keeps repeats, caches lookups, separates branches and stops ancestor cycles", async () => {
  const calls: string[] = [];
  const graph = new ComponentReferences(async id => {
    calls.push(id); return { id, label: id === b ? "B" : "A", fields: [{ id: c, name: "links", targets: id === a ? [b, b] : [a] }] };
  }, signal());
  graph.root("one", a); graph.root("two", a); equal(calls.length, 0);
  const first = await graph.expand("one"), second = await graph.expand("two");
  deepStrictEqual(calls, [a, b]); equal(first.groups[0].nodes.length, 2);
  equal(first.groups[0].nodes[0].key === first.groups[0].nodes[1].key, false);
  equal(first.groups[0].nodes[0].key === second.groups[0].nodes[0].key, false);
  const nested = await graph.expand(first.groups[0].nodes[0].key);
  equal(nested.groups[0].nodes[0].state, "cycle");
  equal(await graph.expand("one"), first);
  await rejects(graph.expand("unknown"));
});
test("Lazy graph retains missing, malformed, failures and layout disagreements", async () => {
  const graph = new ComponentReferences(async id => id === a ? { id, label: "A", fields: [{ id: c, name: "links", targets: [b, c, "bad"] }] }
    : id === b ? null : Promise.reject(Error("private error")), signal());
  graph.root("root", a);
  deepStrictEqual((await graph.expand("root")).groups[0].nodes.map(node => node.state), ["missing", "error", "unresolved"]);
  graph.root("conflict", a, { links: [c] });
  const conflict = await graph.expand("conflict"); match(conflict.groups[0].issue!, /disagree/);
  equal(conflict.groups[0].nodes.every(node => node.state === "unresolved"), true);
});
test("Lazy graph bounds concurrent requests, total reads and occurrence count", async () => {
  let active = 0, peak = 0, reads = 0;
  const targets = Array.from({ length: 500 }, (_, i) => (i + 100).toString(16).padStart(32, "0"));
  const graph = new ComponentReferences(async id => {
    reads++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { id, label: id, fields: id === a ? [{ id: c, name: "links", targets }] : [] };
  }, signal());
  graph.root("root", a); graph.root("repeat", a);
  const first = await graph.expand("root"); equal(first.groups[0].nodes.length, 500); equal(reads, 200); equal(peak <= 4, true);
  equal(first.groups[0].nodes.some(node => node.state === "limit"), true);
  match((await graph.expand("repeat")).notice, /occurrence limit/);
});
test("Lazy graph cancels outstanding work and isolates caches between loads", async () => {
  const controller = new AbortController();
  const graph = new ComponentReferences(async (_id, signal) => {
    controller.abort(); signal.throwIfAborted(); return null;
  }, controller.signal);
  graph.root("root", a); await rejects(graph.expand("root"));
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    const fresh = new ComponentReferences(async () => { calls++; return null; }, signal()); fresh.root("root", a); await fresh.expand("root");
  }
  equal(calls, 2);
});
test("Layout parity evidence uses explicit item fields and retains conflicts", () => {
  const evidence = previewReferenceEvidence({ items: [{ id: a, fields: { links: [{ id: b }, { id: b }], custom: { random: c } } }] });
  deepStrictEqual(evidence.get(a)?.links, [b, b]); equal(evidence.get(a)?.custom, undefined);
  const conflict = previewReferenceEvidence([{ id: a, fields: { links: [{ id: b }] } }, { id: a, fields: { links: [{ id: c }] } }]);
  deepStrictEqual(conflict.get(a)?.links, ["conflicting-layout-occurrences"]);
});


test("Lazy graph stops at depth twelve and reports missing parity coverage", async () => {
  const graph = new ComponentReferences(async id => ({ id, label: id, fields: [{ id: c, name: "next", targets: [(BigInt("0x" + id) + 1n).toString(16).padStart(32, "0")] }] }), signal());
  graph.root("root", a, { missingField: [b] });
  let expansion = await graph.expand("root");
  match(expansion.groups[1].issue!, /no verified/);
  for (let depth = 1; depth < 12; depth++) expansion = await graph.expand(expansion.groups[0].nodes[0].key);
  equal(expansion.groups[0].nodes[0].state, "limit");
  match((await graph.expand(expansion.groups[0].nodes[0].key)).notice, /depth limit/);
});
