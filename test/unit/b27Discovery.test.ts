import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { datasource, expand, layout, references, type Context, type Instance, type ItemEvidence } from "../research/b27Discovery";
import { parseReferenceField } from "../../src/publishing/referenceDiscovery";
import type { AuthoringItemField } from "../../src/sitecore/authoringClient";

const guid = (n: number): string => n.toString(16).padStart(32, "0");
const context: Context = { connection: "fixture", site: "example", language: "en", device: guid(1), page: guid(2) };
const instance = (n: number, overrides: Partial<Instance> = {}): Instance => ({ uid: guid(n), renderingId: guid(100), placeholder: "main", datasource: guid(200), rawParameters: "label=A%26B&empty=&label=C", ...overrides });
const item = (overrides: Partial<ItemEvidence> = {}): ItemEvidence => ({ itemId: guid(200), language: "en", version: 1, mode: "exact", complete: true, fields: [{ id: "related", type: "Multilist", value: `${guid(201)}|${guid(201)}|${guid(202)}` }], ...overrides });

test("B27 publishing extractor is dependency evidence, not a patch resolver or instance inventory", () => {
  const a = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
  const b = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
  const shared = `<r><d id="${a}"><r uid="${a}" ds="${a}"/><r uid="${b}" ds="${a}"/></d></r>`;
  const final = `<r xmlns:p="p" xmlns:s="s" p:p="1"><d id="${a}"><r uid="${a}"><p:d/></r><r uid="${b}" s:ds="${b}" p:before="*"/></d></r>`;
  const field = (value: string): AuthoringItemField => ({ fieldId: guid(1), name: "__Final Renderings", label: "Layout", value, type: "Layout", typeKey: "layout", scope: "VERSIONED", sortOrder: 0, sectionName: "Layout", sectionSortOrder: 0, isStandardTemplate: true, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: false });
  strictEqual(parseReferenceField(field(shared)).itemReferences.length, 1); // Two usages lost.
  deepStrictEqual([...parseReferenceField(field(shared)).itemReferences, ...parseReferenceField(field(final)).itemReferences].map(ref => ref.target), [a, b]);
  // A is still in the union despite removal/replacement in the patch. Do not present this as layout.
  strictEqual(layout(context, { context, origin: "raw-fields", complete: true, instances: [] }).state, "unresolved");
});

test("B27 never treats raw Shared/Final fields or published layout as resolved authoring evidence", () => {
  for (const origin of ["raw-fields", "published-edge"] as const)
    strictEqual(layout(context, { context, origin, complete: true, instances: [instance(3)] }).state, "unresolved");
  strictEqual(layout(context, { context, origin: "authoring-resolved", complete: false, instances: [] }).state, "unresolved");
});
test("B27 pins site, device and locale; repeated rendering/datasource usages retain instances and parameters", () => {
  const evidence = { context, origin: "authoring-resolved" as const, complete: true, instances: [instance(3, { rootPlacement: true }), instance(4, { parentUid: guid(3) })] };
  const result = layout(context, evidence);
  if (result.state !== "resolved") throw Error("Fixture expected resolved layout");
  strictEqual(result.instances.length, 2);
  strictEqual(new Set(result.instances.map(i => i.occurrenceKey)).size, 2);
  deepStrictEqual(result.instances.map(i => i.rawParameters), evidence.instances.map(i => i.rawParameters));
  deepStrictEqual(result.instances.map(i => i.placement), ["resolved", "resolved"]);
  for (const key of ["site", "device", "language", "page", "connection"] as const)
    strictEqual(layout({ ...context, [key]: "other" }, evidence).state, "unresolved");
});
test("B27 missing/ambiguous/cyclic placement stays unresolved without guessing from placeholder keys", () => {
  const instances = [instance(3, { placeholder: "/main/content-{00000000-0000-0000-0000-000000000004}-0" }), instance(4, { parentUid: guid(5) }), instance(5, { parentUid: guid(4) }), instance(6, { parentUid: guid(99) })];
  const result = layout(context, { context, origin: "authoring-resolved", complete: true, instances });
  if (result.state !== "resolved") throw Error("Expected unresolved placements within a resolved fixture");
  strictEqual(result.instances.every(i => i.placement === "Placement unresolved"), true);
  strictEqual(result.instances[0].placeholder, instances[0].placeholder);
  strictEqual(layout(context, { context, origin: "authoring-resolved", complete: true, instances: [instance(3), instance(3)] }).state, "unresolved");
});
test("B27 datasource candidates distinguish page/local owner, unsupported queries, tokens and emptiness", () => {
  const page = "/sitecore/content/Example/home"; const design = "/sitecore/content/Example/Presentation/Header";
  strictEqual(datasource(guid(3), page).target, guid(3));
  strictEqual(datasource(page, page).target, page);
  strictEqual(datasource("page:/Data/Card", page, design).target, `${page}/Data/Card`);
  strictEqual(datasource("local:/Data/Card", page, design).target, `${design}/Data/Card`);
  for (const raw of ["local:/Data/Card", "./Data/Card", "query:./*", "$site/Data", "field:Related", "local:/../Card", "page:/#my-card#"])
    strictEqual(datasource(raw, page).state, "unresolved");
  strictEqual(datasource("", page).state, "empty");
});
test("B27 ID reference families preserve field/value order, repeated usages and invalid tokens", () => {
  for (const type of ["Droplink", "Grouped Droplink", "Droptree", "Checklist", "Multilist", "Treelist", "TreelistEx"])
    strictEqual(references([{ id: "f", type, value: guid(201) }])[0].target, guid(201));
  const refs = references([{ id: "f", type: "Multilist", value: `${guid(201)}|bad|${guid(201)}` }]);
  deepStrictEqual(refs.map(r => r.ordinal), [0, 1, 2]);
  deepStrictEqual(refs.map(r => r.kind), ["item", "unresolved", "item"]);
  strictEqual(references([{ id: "f", type: "Droplink", value: `junk ${guid(201)}` }])[0].kind, "unresolved");
});
test("B27 name-storing fields require complete unambiguous Source choices", () => {
  for (const type of ["Droplist", "Grouped Droplist"]) {
    const field = { id: "f", type, value: "Card" };
    strictEqual(references([field])[0].kind, "unresolved");
    strictEqual(references([{ ...field, nameChoices: { complete: false, items: [{ id: guid(1), name: "Card" }] } }])[0].kind, "unresolved");
    strictEqual(references([{ ...field, nameChoices: { complete: true, items: [{ id: guid(1), name: "Card" }, { id: guid(2), name: "card" }] } }])[0].kind, "unresolved");
    strictEqual(references([{ ...field, nameChoices: { complete: true, items: [{ id: guid(1), name: "Card" }] } }])[0].target, guid(1));
  }
});
test("B27 navigation remains on-demand, media remains leaves and ordinary text does not become a reference", () => {
  const result = references(["General Link", "Rich Text", "Image", "File", "Single-Line Text"].map(type => ({ id: type, type, value: guid(1) })));
  deepStrictEqual(result.map(r => r.kind), ["navigation-on-demand", "navigation-on-demand", "media-leaf", "media-leaf"]);
});
test("B27 lazy expansion reads one item, preserves path-specific duplicate usages and detects ancestor cycles", async () => {
  let reads = 0; const read = async () => { reads++; return item(); }; const signal = new AbortController().signal;
  const a = await expand(guid(200), "en", "rendering-A", [], read, signal);
  const b = await expand(guid(200), "en", "rendering-B", [], read, signal);
  strictEqual(reads, 2); strictEqual(a.edges.length, 3);
  strictEqual(new Set([...a.edges, ...b.edges].map(e => e.occurrenceKey)).size, 6);
  strictEqual((await expand(guid(200), "en", "loop", [guid(200)], read, signal)).state, "cycle");
  strictEqual(reads, 2);
});
test("B27 exact version zero is not absence, effective version zero is not a writable fallback source", async () => {
  const signal = new AbortController().signal;
  strictEqual((await expand(guid(200), "en", "a", [], async () => item({ version: 0 }), signal)).state, "partial");
  const result = await expand(guid(200), "en", "a", [], async () => item({ version: 0, mode: "effective" }), signal);
  strictEqual(result.state, "complete"); strictEqual(result.provenance, "unverified");
  strictEqual("writeTarget" in result, false);
});
test("B27 limits and incomplete reads are explicit, identity mismatch and errors are unavailable", async () => {
  const signal = new AbortController().signal;
  const limited = await expand(guid(200), "en", "a", [], async () => item(), signal, 2);
  strictEqual(limited.state, "partial"); strictEqual(limited.edges.length, 2);
  strictEqual((await expand(guid(200), "en", "a", [guid(1)], async () => { throw Error("Must not read"); }, signal, 2, 1)).reason, "Depth limit");
  strictEqual((await expand(guid(200), "en", "a", [], async () => item({ complete: false }), signal)).state, "partial");
  for (const change of [{ language: "fr" }, { itemId: guid(3) }, { version: -1 }])
    strictEqual((await expand(guid(200), "en", "a", [], async () => item(change), signal)).state, "unavailable");
  strictEqual((await expand(guid(200), "en", "a", [], async () => { throw Error("private server details"); }, signal)).reason, "Read failed; absence not established");
});
test("B27 cancellation before/after IO rejects without publishing stale branch results", async () => {
  const controller = new AbortController(); controller.abort();
  await rejects(expand(guid(200), "en", "a", [], async () => item(), controller.signal), /abort/i);
  const second = new AbortController();
  await rejects(expand(guid(200), "en", "a", [], async () => { second.abort(); return item(); }, second.signal), /abort/i);
});
