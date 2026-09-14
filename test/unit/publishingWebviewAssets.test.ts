import {
  deepStrictEqual,
  doesNotMatch,
  doesNotThrow,
  match,
  ok,
  strictEqual,
} from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";

const publishingAssetRoot = resolve(process.cwd(), "media", "publishing");

const forms = [
  "tracedPublishForm",
  "powerPublishScope",
] as const;

test("publishing webview assets are valid and preserve their host contract", async () => {
  for (const form of forms) {
    const htmlPath = resolve(publishingAssetRoot, `${form}.html`);
    const scriptPath = resolve(publishingAssetRoot, `${form}.js`);
    const stylePath = resolve(publishingAssetRoot, `${form}.css`);
    const [html, script, style] = await Promise.all([
      readFile(htmlPath, "utf8"),
      readFile(scriptPath, "utf8"),
      readFile(stylePath, "utf8"),
    ]);

    ok(style.trim(), `${form}.css must not be empty`);
    doesNotThrow(
      () => new Script(script, { filename: scriptPath }),
      `${form}.js must contain valid JavaScript`,
    );
    match(
      html,
      /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src \{\{cspSource\}\}; script-src \{\{cspSource\}\};">/u,
      `${form}.html must retain its restrictive content security policy`,
    );
    strictEqual(occurrences(html, "{{cspSource}}"), 2);
    strictEqual(occurrences(html, "{{styleUri}}"), 1);
    strictEqual(occurrences(html, "{{scriptUri}}"), 1);
    match(html, /<link rel="stylesheet" href="\{\{styleUri\}\}">/u);
    match(html, /<script src="\{\{scriptUri\}\}"><\/script>/u);
    match(script, /vscode\.postMessage\(\{ type: "ready" \}\);/u);
    doesNotMatch(
      script,
      /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u,
      `${form}.js must not render untrusted data through an HTML injection sink`,
    );

    const requestedIds = [...script.matchAll(/document\.getElementById\("([^"]+)"\)/gu)]
      .map((result) => result[1]);
    const declaredIds = [...html.matchAll(/\sid="([^"]+)"/gu)]
      .map((result) => result[1]);
    ok(requestedIds.length > 0, `${form}.js must bind to the form DOM`);
    deepStrictEqual(
      requestedIds.filter((id) => !declaredIds.includes(id)),
      [],
      `${form}.html must declare every element requested by its script`,
    );
    strictEqual(
      new Set(declaredIds).size,
      declaredIds.length,
      `${form}.html must not contain duplicate element IDs`,
    );
  }
});

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
