import { previewReferenceEvidence } from "../../src/editor/componentReferenceEvidence";
import { test } from "node:test";
import { strictEqual as equal, deepStrictEqual, match, rejects } from "node:assert/strict";
import { previewMediaReference, isMediaLibraryPath } from "../../src/sitecore/previewMediaReference";
import { parsePreviewReferenceItem, PreviewReferenceClient } from "../../src/sitecore/previewReferences";
import { ComponentReferences } from "../../src/editor/componentReferences";
import { SitecoreHttpClient } from "../../src/sitecore/sitecoreHttpClient";
import { QueuedHttpRuntime, noOpLogger, jsonResponse } from "./sitecoreClientTestHelpers";
const a = "11111111111111111111111111111111", b = "22222222222222222222222222222222", c = "33333333333333333333333333333333";
const raw = `<image mediaid="{22222222-2222-2222-2222-222222222222}" alt="A &amp; B" />`;
const field = { __typename: "ImageField", id: c, name: "Image", value: raw, src: "https://media.example.test/generated.svg", definition: { type: "Image" } };
const item = { id: a, path: "/sitecore/content/Page/Data", name: "Data", displayName: "Data", language: { name: "en-NZ" }, version: 1, fields: [field] };
test("Image and File identities come only from bounded raw mediaid, never typed asset URLs", () => {
  for (const kind of ["image", "file"] as const) {
    const value = raw.replace("image", kind), result = previewMediaReference(value, kind, "https://example.test/" + a);
    equal(result.rawValue, value); equal(result.targetKind, "media"); equal(result.issue, undefined); equal(result.targets.length, 1);
    const url = previewMediaReference(`<${kind} src="https://example.test/${b}" />`, kind, null);
    equal(url.targets.length, 0); match(url.issue!, /no explicit/);
    equal(previewMediaReference("", kind, null).issue, undefined);
    match(previewMediaReference("", kind, "https://example.test/asset").issue!, /inconsistent/);
  }
});
test("Content Hub connector IDs and mixed media identities never become Sitecore edges", () => {
  for (const attr of [`stylelabs-content-id="${b}"`, `dam-id="${b}"`, `src="https://tenant.stylelabs.cloud/api/public/content/${b}"`]) {
    const value = `<image ${attr} />`, result = previewMediaReference(value, "image", null);
    equal(result.destination?.kind, "content-hub"); equal(result.targets.length, 0); equal(result.rawValue, value);
    const mixed = previewMediaReference(value.replace(" />", ` mediaid="${a}" />`), "image", null);
    equal(mixed.targets.length, 0); match(mixed.issue!, /Mixed/);
  }
});
test("Malformed and unsupported asset evidence remains explicit instead of empty", () => {
  for (const value of ["<image />", `<image mediaid="${b}" custom="x" />`, `<image mediaid="{${b}" />`, '<image mediaid="00000000000000000000000000000000" />',
    `<image mediaid="${b}" src="https://external.test/asset" />`, `<image mediaid="${b}" mediaid="${a}"/>`, '<!DOCTYPE image><image/>',
    '<image xmlns="x"/>', '<image><child/></image>', '<file mediaid="' + b + '"/>', "x".repeat(262145)]) {
    const result = previewMediaReference(value, "image", null); equal(Boolean(result.issue), true); equal(result.rawValue, value);
  }
  for (const path of [undefined, "/sitecore/content/Image", "/sitecore/media library", "/sitecore/media libraryevil/a", "/sitecore/media library/../content/a", "/sitecore/media library/a\\b"]) equal(isMediaLibraryPath(path), false);
  equal(isMediaLibraryPath("/sitecore/media library/Images/Logo"), true);
});
test("Preview media query preserves raw evidence and resolves exact ID, locale and path independently", async () => {
  const runtime = new QueuedHttpRuntime([jsonResponse({ data: { item } })]);
  const result = await new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, runtime)).read("https://cm.example.test", "preview-token", a, "en-NZ", new AbortController().signal);
  equal(result!.fields[0].rawValue, raw); equal(result!.path, item.path);
  const body = JSON.parse(String(runtime.requests[0].init.body)); match(body.query, /on ImageField \{ src \}/); match(body.query, /on FileField \{ url \}/); match(body.query, /displayName path language/);
  deepStrictEqual(body.variables, { id: a, language: "en-NZ" });
  const invalid = new QueuedHttpRuntime([jsonResponse({ data: { item: { ...item, id: b } } })]);
  await rejects(new PreviewReferenceClient(new SitecoreHttpClient(noOpLogger, invalid)).read("https://cm.example.test", "preview-token", a, "en-NZ", new AbortController().signal), /unavailable/);
  const file = parsePreviewReferenceItem({ ...item, fields: [{ ...field, __typename: "FileField", definition: { type: "File" }, value: raw.replace("image", "file"), url: null }] }, a, "en-NZ")!;
  equal(file.fields[0].targetKind, "media");
});
test("Media graph retains repeats and validates target path before exposing selection", async () => {
  const source = parsePreviewReferenceItem({ ...item, fields: [field, { ...field, id: a, name: "Again" }] }, a, "en-NZ")!;
  for (const path of ["/sitecore/media library/Logo", "/sitecore/content/Logo", undefined]) {
    const calls: string[] = [];
    const graph = new ComponentReferences(async id => { calls.push(id); return id === a ? source : { id, label: "Logo", path, fields: [] }; }, new AbortController().signal);
    graph.root("root", a); const result = await graph.expand("root"); deepStrictEqual(calls, [a, b]); equal(result.groups.length, 2);
    equal(result.groups[0].rawValue, raw); equal(result.groups[0].nodes[0].key === result.groups[1].nodes[0].key, false);
    equal(result.groups[0].nodes[0].state, path?.includes("media library/") ? "ready" : "unresolved");
    equal(Boolean(graph.target(result.groups[0].nodes[0].key)), Boolean(path?.includes("media library/")));
  }
});
test("Media missing, error, cancellation and self-cycle checks retain existing graph guarantees", async () => {
  const source = parsePreviewReferenceItem(item, a, "en-NZ")!;
  for (const fails of [false, true]) {
    const graph = new ComponentReferences(async id => { if (id === a) return source; if (fails) throw Error("unavailable"); return null; }, new AbortController().signal);
    graph.root("root", a); equal((await graph.expand("root")).groups[0].nodes[0].state, fails ? "error" : "missing");
  }
  const controller = new AbortController(); const graph = new ComponentReferences(async () => { controller.abort(); return source; }, controller.signal);
  graph.root("root", a); await rejects(graph.expand("root"));
  const cyclic = { ...source, path: "/sitecore/content/NotMedia", fields: [{ ...source.fields[0], targets: [a] }] };
  const cycle = new ComponentReferences(async () => cyclic, new AbortController().signal); cycle.root("root", a);
  equal((await cycle.expand("root")).groups[0].nodes[0].state, "unresolved");
});

test("Layout asset URLs never become identity and explicit media disagreements stay unresolved", async () => {
  const evidence = previewReferenceEvidence({ id: a, fields: { Image: { value: { mediaid: c, src: "https://example.test/" + b } },
    Asset: { value: { src: "https://example.test/" + b, "dam-id": b } } } });
  deepStrictEqual(evidence.get(a)?.Image, [c]); equal(evidence.get(a)?.Asset, undefined);
  const graph = new ComponentReferences(async () => parsePreviewReferenceItem(item, a, "en-NZ"), new AbortController().signal, evidence);
  graph.root("root", a); equal((await graph.expand("root")).groups[0].nodes[0].state, "unresolved");
});
