import { test } from "node:test";
import { strictEqual, deepStrictEqual, rejects, throws, match } from "node:assert/strict";
import { fieldPresentation, mediaAttributes, fieldAssetUrl, readFieldImage } from "../../src/sitecore/fieldPresentation";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { QueuedHttpRuntime, noOpLogger, testConnection, tokenResponse } from "./sitecoreClientTestHelpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
const image = () => new Response(png, { headers: { "content-type": "image/png" } });
const signal = new AbortController().signal;
test("read-only presentation distinguishes empty, unreadable and populated unsupported content", () => {
  strictEqual(fieldPresentation("Image", "").status, "empty");
  strictEqual(fieldPresentation("Image", null).status, "unavailable");
  strictEqual(fieldPresentation("Custom", " ").status, "populated");
  strictEqual(fieldPresentation("Rich Text", "<p>Hello</p>").kind, "richtext");
  strictEqual(fieldPresentation("Image", "<broken").status, "populated");
  match(fieldPresentation("Image", "<broken").notice!, /Original content/);
});
test("image and file formats preserve custom attributes and identify only evidenced providers", () => {
  const raw = '<image width="800" height="600" alt="A &amp; B" dam-id="opaque" dam-content-type="Image" thumbnailsrc="https://tenant.stylelabs.cloud/api/gateway/1/thumbnail" src="https://tenant.stylelabs.cloud/api/public/content/asset?v=1" custom="&#x26;" />';
  const result = fieldPresentation("Image", raw);
  strictEqual(result.provider, "Content Hub / DAM"); strictEqual(result.alt, "A & B");
  strictEqual(result.metadata!.find(([k]) => k === "custom")![1], "&");
  strictEqual(fieldPresentation("File", '<file mediaid="{11111111-1111-1111-1111-111111111111}" mediapath="/Files/guide"/>').provider, "Sitecore Media Library");
  strictEqual(fieldPresentation("Image", '<image src="https://example.test/a"/>').provider, "Asset (provider unverified)");
  strictEqual(fieldPresentation("Image", '<image mediaid="------------------------------------"/>').provider, "Asset (provider unverified)");
  for (const raw of ['<!DOCTYPE image [<!ENTITY x SYSTEM "file:///secret">]><image alt="&x;"/>', '<image src="a" SRC="b"/>', '<image><script/></image>', '<image src="&custom;"/>', '<image xmlns="x"/>', '<image alt="&#x110000;"/>']) throws(() => mediaAttributes(raw, "image"));
});
test("asset URLs constrain credential routing and reject executable/private destinations", () => {
  strictEqual(fieldAssetUrl(testConnection.serverUrl, "/-/media/a.png")?.authenticated, true);
  strictEqual(fieldAssetUrl(testConnection.serverUrl, "https://tenant.stylelabs.cloud/api/public/content/a?v=1")?.authenticated, false);
  for (const url of ["javascript:alert(1)", "data:image/png,abc", "file:///x", "command:open", "//evil.test/a", "https://127.0.0.1/a", "https://tenant.stylelabs.cloud.evil.test/api/public/content/a", "https://tenant.stylelabs.cloud/api/gateway/1/thumbnail", "https://user:secret@tenant.stylelabs.cloud/api/public/content/a", "/-/media/%2e%2e/a", "/sitecore/admin", "/-/media/a?access_token=secret", "https://tenant.stylelabs.cloud:8443/api/public/content/a"]) strictEqual(fieldAssetUrl(testConnection.serverUrl, url), undefined, url);
});
test("raster previews are bounded, cancellable and never accept SVG/HTML/private responses", async () => {
  match(await readFieldImage(image(), signal), /^data:image\/png;base64,/);
  for (const response of [new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), new Response("login", {status:401}), new Response("html", {headers:{"content-type":"text/html"}}), new Response(png, {headers:{"content-type":"image/png","content-length":"99999999"}})]) await rejects(readFieldImage(response, signal));
  const controller = new AbortController(); controller.abort(); await rejects(readFieldImage(image(), controller.signal));
  await rejects(readFieldImage(new Response("<html>fake raster</html>",{headers:{"content-type":"image/png"}}),signal));
  await rejects(readFieldImage(new Response(new Uint8Array(8*1024*1024+1),{headers:{"content-type":"image/png"}}),signal));
  const pending = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel(){cancelled=true;} });
  const reading = readFieldImage(new Response(stream,{headers:{"content-type":"image/png"}}),pending.signal);
  pending.abort(); await rejects(reading); strictEqual(cancelled,true);
});
test("asset client never sends credentials to Content Hub or follows redirects and does not retry", async () => {
  const runtime = new QueuedHttpRuntime([image()]);
  const result = await new AuthoringContentClient(noOpLogger, runtime).loadFieldAsset(testConnection, "secret", "https://tenant.stylelabs.cloud/api/public/content/a", true, signal);
  strictEqual(runtime.requests.length, 1); deepStrictEqual(runtime.requests[0].init.headers, {});
  strictEqual(runtime.requests[0].init.redirect, "error"); strictEqual(runtime.requests[0].init.credentials, "omit"); match(result.dataUri!, /^data:image/);
  const local = new QueuedHttpRuntime([tokenResponse(), image()]);
  await new AuthoringContentClient(noOpLogger, local).loadFieldAsset(testConnection, "secret", "/-/media/a.png", true, signal);
  strictEqual(new Headers(local.requests[1].init.headers).get("authorization"), "Bearer access-token");
  const failed = new QueuedHttpRuntime([new Response(null,{status:503})]);
  await rejects(new AuthoringContentClient(noOpLogger, failed).loadFieldAsset(testConnection, "secret", "https://tenant.stylelabs.cloud/api/public/content/a", true, signal));
  strictEqual(failed.requests.length, 1);
});
test("File open requires a successful supported HEAD response, no body download", async () => {
  const runtime = new QueuedHttpRuntime([new Response(null,{headers:{"content-type":"application/pdf"}})]);
  const result = await new AuthoringContentClient(noOpLogger,runtime).loadFieldAsset(testConnection,"secret","https://tenant.stylelabs.cloud/api/public/content/file",false,signal);
  strictEqual(runtime.requests[0].init.method,"HEAD"); strictEqual(result.dataUri,undefined);
  const bad = new QueuedHttpRuntime([new Response(null,{headers:{"content-type":"text/html"}})]);
  await rejects(new AuthoringContentClient(noOpLogger,bad).loadFieldAsset(testConnection,"secret","https://tenant.stylelabs.cloud/api/public/content/file",false,signal));
});
