import { test } from "node:test";
import { strictEqual as equal, deepStrictEqual, match, rejects } from "node:assert/strict";
import { previewGeneralLink } from "../../src/sitecore/previewGeneralLink";
import { PreviewReferenceClient, parsePreviewReferenceItem } from "../../src/sitecore/previewReferences";
import { ComponentReferences } from "../../src/editor/componentReferences";
import { previewReferenceEvidence } from "../../src/editor/componentReferenceEvidence";
import { SitecoreHttpClient } from "../../src/sitecore/sitecoreHttpClient";
import { QueuedHttpRuntime, noOpLogger, jsonResponse } from "./sitecoreClientTestHelpers";
const a = "11111111111111111111111111111111", b = "22222222222222222222222222222222", c = "33333333333333333333333333333333";
const raw = `<link linktype="internal" id="{22222222-2222-2222-2222-222222222222}" text="A &amp; B" />`;
const field = { __typename: "LinkField", id: c, name: "link", value: raw, definition: { type: "General Link" }, linkType: "internal", targetItem: { id: b } };
const item = { id: a, name: "A", displayName: "A", language: { name: "en-NZ" }, version: 1, fields: [field] };
test("Preview internal General Link retains raw evidence and requires typed identity agreement", () => {
  const result = previewGeneralLink(raw, "internal", { id: b });
  equal(result.rawValue, raw); equal(result.issue, undefined); equal(result.targets.length, 1);
  for (const target of [null, undefined, { id: a }, { id: "bad" }, [], b]) {
    const unresolved = previewGeneralLink(raw, "internal", target);
    equal(unresolved.targets.length, 1); match(unresolved.issue!, /unresolved/);
  }
  match(previewGeneralLink(raw, "external", { id: b }).issue!, /kinds disagree/);
  match(previewGeneralLink(raw.replace(" />", ' custom="unknown" />'), "internal", { id: b }).issue!, /Custom/);
});
test("Non-item General Links never infer identities from URL, email, anchor or DAM GUIDs", () => {
  for (const [kind, url, expected] of [["external", `https://example.test/${b}`, "external"], ["mailto", "mailto:test@example.test", "email"],
    ["anchor", b, "anchor"], ["external", `https://tenant.stylelabs.cloud/api/public/content/${b}`, "content-hub"]]) {
    const value = `<link linktype="${kind}" url="${url}" id="${b}" />`;
    const result = previewGeneralLink(value, kind, null);
    deepStrictEqual(result.targets, []); equal(result.destination?.kind, expected); equal(result.rawValue, value);
    const inconsistent = previewGeneralLink(value, kind, { id: b });
    deepStrictEqual(inconsistent.targets, []); equal(Boolean(inconsistent.issue), true);
  }
  const dam = previewGeneralLink(raw.replace(" />", ' dam-id="asset" />'), "internal", { id: b });
  deepStrictEqual(dam.targets, []); equal(dam.destination?.kind, "content-hub");
});
test("Malformed, unsupported, empty and unsafe links remain explicit and inert", () => {
  for (const value of ['<link linktype="internal" url="https://example.test/' + b + '" />',
    '<link linktype="internal" id="{22222222-2222-2222-2222-222222222222" />',
    '<link linktype="internal" id="00000000000000000000000000000000" />',
    '<link linktype="internal" id="' + b + '" id="' + a + '" />', '<!DOCTYPE link><link />',
    '<link linktype="javascript" url="alert(1)" />', '<link linktype="media" id="' + b + '" />',
    '<link linktype="external" url="javascript:alert(1)" />', '<link><child /></link>', "x".repeat(262145)]) {
    const result = previewGeneralLink(value, "internal", { id: b }); equal(Boolean(result.issue), true); equal(result.targets.length, 0); equal(result.rawValue, value);
  }
  equal(previewGeneralLink("", null, null).issue, undefined);
  match(previewGeneralLink("", "internal", { id: b }).issue!, /inconsistent/);
});
test("Typed Preview parser and transport carry only bounded target identity for General Links", async () => {
  const runtime = new QueuedHttpRuntime([jsonResponse({ data: { item } })]);
  const reader = new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, runtime));
  const result = await reader.read("https://cm.example.test", "preview-token", a, "en-NZ", new AbortController().signal);
  equal(result!.fields[0].rawValue, raw); equal(result!.fields[0].issue, undefined);
  match(JSON.parse(String(runtime.requests[0].init.body)).query, /on LinkField \{ linkType targetItem \{ id \} \}/);
  deepStrictEqual(JSON.parse(String(runtime.requests[0].init.body)).variables, { id: a, language: "en-NZ" });
  const partial = new QueuedHttpRuntime([jsonResponse({ data: { item }, errors: [{ message: "private-error" }] })]);
  await rejects(new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, partial)).read("https://cm.example.test", "preview-token", a, "en-NZ", new AbortController().signal), /unavailable/);
  equal(partial.requests.length, 1);
});
test("General Links retain field occurrences and cycle guards without reading non-item destinations", async () => {
  const page = parsePreviewReferenceItem({ ...item, fields: [field, { ...field, id: a, name: "again" },
    { ...field, id: b, name: "external", linkType: "external", targetItem: null, value: '<link linktype="external" url="https://example.test/' + b + '" />' }] }, a, "en-NZ")!;
  const calls: string[] = [];
  const graph = new ComponentReferences(async id => { calls.push(id); return id === a ? page : { id, label: "Target", fields: [{ id: c, name: "back", ...previewGeneralLink(`<link linktype="internal" id="${a}" />`, "internal", { id: a }) }] }; }, new AbortController().signal);
  graph.root("root", a); const result = await graph.expand("root");
  deepStrictEqual(calls, [a, b]); equal(result.groups[0].rawValue, raw);
  equal(result.groups[0].nodes[0].key === result.groups[1].nodes[0].key, false);
  equal(result.groups[2].nodes.length, 0); equal(result.groups[2].destination?.kind, "external");
  equal((await graph.expand(result.groups[0].nodes[0].key)).groups[0].nodes[0].state, "cycle");
});
test("Layout General Link parity never extracts targets from hrefs", async () => {
  const evidence = previewReferenceEvidence({ id: a, fields: { link: { value: { linktype: "internal", id: c, href: "https://example.test/" + b } },
    external: { value: { linktype: "external", href: "https://example.test/" + b } } } });
  deepStrictEqual(evidence.get(a)?.link, [c]); deepStrictEqual(evidence.get(a)?.external, []);
  const graph = new ComponentReferences(async () => parsePreviewReferenceItem(item, a, "en-NZ"), new AbortController().signal, evidence);
  graph.root("root", a); const result = await graph.expand("root");
  equal(result.groups[0].nodes[0].state, "unresolved"); match(result.groups[0].issue!, /disagree/);
});
