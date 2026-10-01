import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

test("dashboard secret fields infer replacement, preserve empty drafts and reset after initialization", async () => {
  const context = createContext({ URL });
  new Script(`
    const nodes = new Map();
    function node() { return { value: '', checked: false, textContent: '', dataset: {},
      classList: { add() {} }, attributes: {}, listeners: {},
      append(...children) { for (const child of children) if(child.id) nodes.set(child.id, child); },
      replaceChildren() {}, setAttribute(k,v) {this.attributes[k]=v;},
      hasAttribute(k) {return k in this.attributes;}, removeAttribute(k) {delete this.attributes[k];},
      addEventListener(k,fn) {this.listeners[k]=fn;}, scrollIntoView() {}, focus() {} }; }
    const document = { getElementById(id) {return nodes.get(id) ?? null;},
      createElement: node, querySelector: node, querySelectorAll() {return [];} };
    const sent = [];
    const acquireVsCodeApi = () => ({ postMessage: m => sent.push(m) });
    let receive;
    const window = { addEventListener(type, fn) {receive=fn;} };
  `).runInContext(context);
  const html = await readFile("media/connectionSettings/settings.html", "utf8");
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    new Script(`nodes.set(${JSON.stringify(match[1])}, node());`).runInContext(context);
  }
  new Script(await readFile("media/connectionSettings/settings.js", "utf8")).runInContext(context);
  const run = (code: string): unknown => new Script(code).runInContext(context);
  run(`const initial = {type:'initialize',isNew:false,values:{name:'Test',clientId:'client',serverUrl:'https://cm.example.test',sites:[]},stored:{clientSecret:true,deploymentSecret:true,edgeToken:true}};
    receive({data:initial}); receive({data:{type:'idle'}});`);
  for (const id of ["clientSecret", "deploymentSecret", "edgeToken"]) {
    strictEqual(run(`get('${id}-action')`), null);
    strictEqual(run(`get('${id}').type`), "password");
    strictEqual(run(`get('${id}').disabled`), false);
    strictEqual(run(`get('${id}').placeholder`), "Enter new secret or leave empty to keep the old one");
    strictEqual(run(`get('${id}-stored').textContent`), "A secret is stored.");
    strictEqual(run(`get('${id}').value`), "");
    strictEqual(run(`secretAction('${id}')`), "keep");
    run(`get('${id}').value='replacement-fixture';`);
    deepStrictEqual(JSON.parse(String(run(`JSON.stringify(values().${id})`))), { action: "replace", value: "replacement-fixture" });
    run(`get('${id}').value='';`);
    strictEqual(run(`secretAction('${id}')`), "keep");
    run(`get('${id}').value=' ';`);
    strictEqual(run(`localErrors('save').${id}`), "Enter a replacement secret.");
    run(`receive({data:initial});`);
    strictEqual(run(`secretAction('${id}')`), "keep");
    strictEqual(run(`get('${id}').value`), "");
  }
  run(`request('save');`);
  strictEqual(run(`sent.at(-1).values.clientSecret.action`), "keep");
  strictEqual(run(`sent.at(-1).values.deploymentSecret.action`), "keep");
  strictEqual(run(`sent.at(-1).values.edgeToken.action`), "keep");
  run(`receive({data:{...initial,isNew:true,stored:{}}});`);
  strictEqual(run(`localErrors('save').clientSecret`), "Enter a client secret.");
  run(`get('clientSecret').value='new-fixture';`);
  strictEqual(run(`localErrors('save').clientSecret`), undefined);
});
