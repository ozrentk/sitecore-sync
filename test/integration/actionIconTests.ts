import * as vscode from 'vscode';
import { strictEqual, match, doesNotMatch } from 'node:assert/strict';
import { withActionIcons } from '../../src/ui/webviewActions';
import type { IntegrationTest } from './testSupport';

export const actionIconTests: readonly IntegrationTest[] = [{
  name: 'shared icons load under nonce CSP, preserve labels and ignore content choices',
  async execute() {
    const extension = vscode.extensions.getExtension('OzrenTK.sitecore-xm-cloud-sync')!;
    const panel = vscode.window.createWebviewPanel('iconTest', 'Action icons', vscode.ViewColumn.Active, { enableScripts: true });
    let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const complete = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Action icons timed out')), 15000);
        listener = panel.webview.onDidReceiveMessage(message => { try { strictEqual(message.ok, true, message.error); resolve(); } catch (error) { reject(error); } });
      });
      panel.webview.html = withActionIcons(panel.webview, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-icons';"></head><body>
      <button id="save">Save</button><button id="copy" class="identity-copy" aria-label="Copy item ID">example-id</button><button class="comparison-cell">Save</button><button class="picker-choice">Clear</button><button class="field-suggestion">Publish</button>
      <script nonce="icons">
      const api=acquireVsCodeApi();const assert=(v,m)=>{if(!v)throw Error(m);};
      const wait=()=>new Promise(r=>setTimeout(r,100));
      (async()=>{await wait();const save=document.getElementById('save');
      assert(save.querySelector('svg'),'Save icon loaded under CSP');assert(save.textContent==='Save','Text unchanged');
      assert(!document.querySelector('.comparison-cell svg, .picker-choice svg, .field-suggestion svg'),'Content labels untouched');
      assert(document.querySelector('#copy svg')&&document.getElementById('copy').textContent==='example-id','Copy icon does not replace value');
      save.textContent='Save changes';await wait();assert(save.querySelectorAll('svg').length===1,'Rerender restores one icon');
      save.setAttribute('aria-busy','true');await wait();assert(save.dataset.renderedIcon==='refresh','Busy uses circular arrows');
      save.setAttribute('aria-busy','false');await wait();assert(save.dataset.renderedIcon==='save','Idle restores the action icon');
      const toggle=document.createElement('button');toggle.className='link-expand';toggle.setAttribute('aria-label','Expand link properties');toggle.setAttribute('aria-expanded','false');toggle.textContent='▾';document.body.append(toggle);await wait();
      assert(toggle.dataset.renderedIcon==='expand'&&toggle.textContent==='','Glyph has a named icon');
      toggle.setAttribute('aria-expanded','true');await wait();assert(toggle.dataset.renderedIcon==='collapse','Expanded state changes icon');
      api.postMessage({ok:true});})().catch(error=>api.postMessage({error:String(error)}));</script></body></html>`, extension.extensionUri);
      await complete;
      panel.webview.options = { ...panel.webview.options, enableScripts: false };
      const staticHtml = withActionIcons(panel.webview, '<html><head></head><body><a class="button" href="command:example">Publish again…</a></body></html>', extension.extensionUri);
      match(staticHtml, /<svg/); doesNotMatch(staticHtml, /<script/);
      strictEqual(panel.webview.options.enableScripts, false);
      const count = panel.webview.options.localResourceRoots?.length;
      withActionIcons(panel.webview, staticHtml, extension.extensionUri);
      strictEqual(panel.webview.options.localResourceRoots?.length, count, 'Repeated operation renders do not grow roots');
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); }
  },
}];
