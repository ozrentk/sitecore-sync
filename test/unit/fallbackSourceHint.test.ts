import { strictEqual, match, doesNotMatch } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

async function view(kind: "comparison" | "fieldDiff") {
  const element = () => ({ dataset: {}, children: [] as unknown[], textContent: "", title: "", className: "",
    classList: { add() {}, toggle() {} }, style: { setProperty() {} },
    append(...children: unknown[]) { this.children.push(...children); },
    closest: () => ({}), setAttribute() {}, addEventListener() {}, replaceChildren() {} });
  const context = createContext({
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage() {} }),
    document: { body: element(), getElementById: element, createElement: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
  });
  new Script(await readFile(`media/${kind}/${kind}.js`, "utf8")).runInContext(context);
  const run = (source: string): unknown => new Script(source).runInContext(context);
  run(`const field = { fieldId: "a", name: "Title", value: "same text", type: "Text", scope: "VERSIONED", containsFallbackValue: true };
    const candidate = language => ({ version: 0, language: "en-IL", itemFallback: { status: "candidate",
      chain: ["en-IL", language], candidate: { language, version: 1 } } });`);
  return run;
}

for (const kind of ["comparison", "fieldDiff"] as const) {
  test(`${kind}: expected source is a display hint with chain and provenance tooltip`, async () => {
    const run = await view(kind);
    strictEqual(run('fallbackSourceHint(candidate("en")).label'), "expected source: en");
    match(run('fallbackSourceHint(candidate("en")).tooltip') as string, /not verified per-field provenance/u);
    match(run('fallbackSourceHint(candidate("en")).tooltip') as string, /en-IL → en/u);
    strictEqual(run('fieldSource(field)'), "fallback");
    for (const details of ['undefined', '{}', '{ ...candidate("en"), version: 1 }',
      '{ ...candidate("en"), language: "fr" }',
      '{ ...candidate("en"), itemFallback: { ...candidate("en").itemFallback, status: "unavailable" } }',
      '{ ...candidate("en"), itemFallback: { ...candidate("en").itemFallback, status: "disabled" } }',
      '{ ...candidate("en"), itemFallback: { ...candidate("en").itemFallback, chain: ["en-IL", "fr"] } }']) {
      strictEqual(run(`fallbackSourceHint(${details}).label`), "source language unknown");
    }
  });

  test(`${kind}: rendered comparison sides use independent candidates, including unknowns and stored fields`, async () => {
    const run = await view(kind);
    const render = kind === "comparison"
      ? 'createFieldRow({ left: field, right: rightField, flags: [] }, { left: { details: candidate("en") }, right: { details: rightDetails } }, 0)'
      : '(state.snapshot = { leftDetails: candidate("en"), rightDetails }, createFieldRow({ left: field, right: rightField, flags: [] }))';
    run(`let rightDetails = candidate("fr"); let rightField = field; let row = ${render};`);
    const metadata = (side: number) => kind === "comparison" ? `row.children[${side}].children[0].children[0]` : `row.children[${side}].children[1]`;
    match(run(`${metadata(0)}.textContent`) as string, /fallback · expected source: en/u);
    match(run(`${metadata(2)}.textContent`) as string, /fallback · expected source: fr/u);
    doesNotMatch(run(`${metadata(0)}.textContent`) as string, /not verified/u);
    run(`rightDetails = undefined; row = ${render};`);
    match(run(`${metadata(2)}.textContent`) as string, /source language unknown/u);
    match(run(`${metadata(0)}.textContent`) as string, /expected source: en/u);
    run(`rightField = { ...field, containsFallbackValue: false }; row = ${render};`);
    if (kind === "comparison") strictEqual(run('row.children[2].children[0].children.length'), 0);
    else doesNotMatch(run(`${metadata(2)}.textContent`) as string, /expected source/u);
    if (kind === "fieldDiff") {
      run(`state.mode = "browse"; row = ${render};`);
      match(run(`${metadata(0)}.textContent`) as string, /expected source: en/u);
      match(run(`${metadata(0)}.title`) as string, /not verified per-field provenance/u);
    }
  });
}
