import {
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

const comparisonAssetRoot = resolve(process.cwd(), "media", "comparison");

test("comparison webview assets preserve language-lock and item-icon contracts", async () => {
  const htmlPath = resolve(comparisonAssetRoot, "comparison.html");
  const scriptPath = resolve(comparisonAssetRoot, "comparison.js");
  const stylePath = resolve(comparisonAssetRoot, "comparison.css");
  const [html, script, style] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(scriptPath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);

  ok(style.trim(), "comparison.css must not be empty");
  doesNotThrow(() => new Script(script, { filename: scriptPath }));
  match(
    html,
    /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src \{\{cspSource\}\}; script-src \{\{cspSource\}\};?"/,
  );

  const declaredIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((matchResult) => matchResult[1]);
  strictEqual(new Set(declaredIds).size, declaredIds.length, "HTML IDs must be unique");
  for (const matchResult of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    ok(declaredIds.includes(matchResult[1]), `Missing DOM element #${matchResult[1]}`);
  }

  match(html, /<input id="language-lock" type="checkbox">/);
  match(html, /<span>Lock languages<\/span>/);
  match(script, /type: "setLanguageLock", locked: languageLock\.checked/);
  match(script, /languageLock\.checked = state\.selection\.languagesLocked === true/);
  match(script, /message\?\.type === "itemIconsLoaded"/);
  match(script, /message\?\.type === "itemIconsReset"/);
  match(script, /message\?\.type === "favoriteNavigationStarted"/);
  match(script, /message\.navigationId === state\.favoriteNavigationId/);
  match(script, /scheduleItemIconRender\(\)/);
  match(script, /isItemIconDataUri\(icon\.dataUri\)/);
  match(script, /createFallbackItemIcon\(\)/);
  match(style, /\.item-icon\.fallback/);
  doesNotMatch(script, /\.innerHTML\s*=|eval\s*\(|new Function\s*\(/);
});
