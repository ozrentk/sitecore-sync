import * as vscode from "vscode";
import { strictEqual } from "node:assert/strict";
import type { IntegrationTest } from "./testSupport";

export const richTextFrameTests: readonly IntegrationTest[] = [{
  name: "isolated styled Rich Text frame preserves source, commands, freeze and disposal under webview CSP",
  async execute() {
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const root = vscode.Uri.joinPath(extension.extensionUri, "out", "webview");
    const panel = vscode.window.createWebviewPanel("styledVisual", "Styled Visual", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [root] });
    let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const complete = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Styled frame integration timed out")), 25000);
        listener = panel.webview.onDidReceiveMessage(message => { if (message.type === "styled-result") { try { strictEqual(message.ok, true, message.error); resolve(); } catch (error) { reject(error); } } });
      });
      panel.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src 'nonce-styled'; script-src 'nonce-styled';"><main id="root"></main><script nonce="styled" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "richTextFrame.js"))}"></script><script nonce="styled">
        const api=acquireVsCodeApi();const assert=(v,m)=>{if(!v)throw Error(m);};
        (async()=>{const raw='<style>.theme{color:red}</style><P class="theme" style="text-align:center">Text &amp; more</P>';
          let changed=0;let failure='';const editor=createRichTextFrame(document.getElementById('root'),raw,{change:()=>changed++,error:m=>failure=m,history:()=>{}});
          const wait=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('Frame state missing: '+failure);};
          await wait(()=>editor.status('h2').enabled);assert(editor.read()===raw&&changed===0,'Initialization must not replace raw');
          const frame=document.querySelector('iframe');assert(frame.sandbox.value==='allow-scripts','Opaque script-only sandbox');assert(frame.contentDocument===null,'Frame must not share origin');
          window.dispatchEvent(new MessageEvent('message',{source:window,origin:'null',data:{channel:'rich-text-frame',type:'state',state:{raw:'bad',sequence:999}}}));
          assert(editor.read()===raw,'Foreign reply cannot replace source');
          editor.command('h2');await wait(()=>editor.read().includes('<h2 class="theme"'));assert(editor.read()==='<style>.theme{color:red}</style><h2 class="theme" style="text-align:center">Text &amp; more</h2>','Requested retag retains CSS and content');
          const frozen=await editor.freeze();assert(frozen===editor.read(),'Freeze acknowledges current exact source');
          editor.command('paragraph');await new Promise(r=>setTimeout(r,100));assert(editor.read()===frozen,'Frozen commands do not edit');
          editor.editable(true);await wait(()=>editor.status('paragraph').enabled);editor.restore({from:2,to:6});
          const info=await editor.beginLink();assert(info.existing===false,'Link session crosses authenticated bridge');
          await editor.applyLink({kind:'url',href:'/example'});assert(editor.read().includes('href="/example"'),'Link reply carries authoritative state');
          const final=await editor.freeze();assert(final===editor.read(),'Final snapshot flushed');editor.dispose();assert(!document.querySelector('iframe'),'Disposal removes frame');
          const next=createRichTextFrame(document.getElementById('root'),raw,{change:()=>{},error:()=>{},history:()=>{}});const pending=next.freeze();next.dispose();let rejected=false;try{await pending;}catch{rejected=true;}assert(rejected,'Disposal cancels pending freeze');
          const unsupported='<p onclick="bad()">Retain</p>';let unavailable='';const refused=createRichTextFrame(document.getElementById('root'),unsupported,{change:()=>{throw Error('Rejected init changed raw');},error:e=>unavailable=e,history:()=>{}});
          await wait(()=>Boolean(unavailable));assert(await refused.freeze()===unsupported,'Failed initialization preserves an HTML escape');assert(document.querySelector('iframe').inert,'Failed frame never accepts input');refused.dispose();
          api.postMessage({type:'styled-result',ok:true});
        })().catch(error=>api.postMessage({type:'styled-result',error:String(error)}));
      </script>`;
      await complete;
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); }
  },
}, {
  name: "production editor isolates frame messages and keeps modes and revision-pinned freeze coherent",
  async execute() {
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const root = vscode.Uri.joinPath(extension.extensionUri, "out", "webview");
    const media = vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor");
    const shared = vscode.Uri.joinPath(extension.extensionUri, "media", "shared");
    const panel = vscode.window.createWebviewPanel("styledModes", "Styled modes", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [root, media, shared] });
    let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    let frozen: { revision: number; drafts: Record<string, { input: string }> } | undefined;
    try {
      const complete = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Styled modes integration timed out")), 25000);
        listener = panel.webview.onDidReceiveMessage(message => {
          if (message.type === "frozen") frozen = message;
          if (message.type === "styled-modes-result") { try { strictEqual(message.ok, true, message.error); strictEqual(frozen?.revision, 4); strictEqual(frozen?.drafts.html.input, '<h2 style="text-align:center">Keep</h2>'); resolve(); } catch (error) { reject(error); } }
        });
      });
      const script = (uri: vscode.Uri) => `<script nonce="styled" src="${panel.webview.asWebviewUri(uri)}"></script>`;
      panel.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src 'nonce-styled'; script-src 'nonce-styled';"><h1 id="title"></h1><p id="identity"></p><p id="path"></p><p id="status"></p><button id="save">Save</button><button id="revert">Revert</button><button id="reconcile">Reconcile</button><button id="locale">Locale</button><main id="fields"></main>${script(vscode.Uri.joinPath(shared, "readOnlyField.js"))}${script(vscode.Uri.joinPath(media, "htmlSource.js"))}${script(vscode.Uri.joinPath(root, "richTextFrame.js"))}${script(vscode.Uri.joinPath(media, "editor.js"))}${script(vscode.Uri.joinPath(root, "actionIcons.js"))}<script nonce="styled">
      (async()=>{
        const assert=(v,m)=>{if(!v)throw Error(m);};const wait=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('Expected editor state missing');};
        const raw='<p style="text-align:center">Keep</p>';const field={id:'html',label:'Text',name:'Text',section:'Data',type:'Rich Text',scope:'VERSIONED',source:'Exact locale',kind:'html',original:raw,input:raw,clear:false,raw};
        const state={type:'state',revision:4,busy:false,pending:false,item:{name:'Fixture',path:'/sitecore/content/Fixture'},target:{language:'en',version:1,itemId:'fixture'},connection:'Test',fields:[field],status:'Ready'};
        const sendState=data=>window.dispatchEvent(new MessageEvent('message',{data}));const button=name=>[...document.querySelectorAll('.html-source-actions button')].find(b=>b.textContent===name);
        sendState(state);button('Visual').click();await wait(()=>visualSources.get('html')?.status('h2').enabled);
        await wait(()=>document.querySelector('[data-rich-command="bold"] svg'));
        const bold=document.querySelector('[data-rich-command="bold"]');bold.focus();bold.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
        assert(document.activeElement.dataset.richCommand==='italic','Arrow navigation reaches adjacent icon command');
        assert(bold.getAttribute('aria-label')==='Bold'&&bold.textContent==='Bold','Icon command retains accessible and text labels');
        const alignment=document.querySelector('[data-rich-command="alignCenter"]');await wait(()=>alignment.getAttribute('aria-pressed')==='true');
        assert(document.querySelector('.richtext-modes')&&button('Clear content'),'Modes and explicit clear are distinct');
        visualSources.get('html').command('h2');await wait(()=>htmlSources.get('html').read().startsWith('<h2'));
        assert(document.getElementById('title').textContent==='Fixture','Frame state must not replace host state');
        const frame=document.querySelector('.richtext-editing-frame');sendState({channel:'rich-text-frame',type:'state',item:{name:'Wrong'}});assert(document.getElementById('title').textContent==='Fixture','Frame namespace is not host state');
        window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{...state,item:{name:'Wrong'}}}));assert(document.getElementById('title').textContent==='Fixture','Nested source cannot spoof host state');
        sendState({type:'freeze',id:'styled-freeze',revision:4});await wait(()=>document.getElementById('save').disabled);await new Promise(r=>setTimeout(r,200));
        assert(htmlSources.get('html').read()==='<h2 style="text-align:center">Keep</h2>','Freeze retains the changed raw draft');
        sendState({type:'unfreeze',revision:4,error:''});await wait(()=>visualSources.get('html').status('h2').enabled);
        button('HTML').click();await wait(()=>!document.getElementById('html').hidden);assert(!document.querySelector('.richtext-editing-frame'),'HTML disposes the frame');
        assert(document.getElementById('html').value==='<h2 style="text-align:center">Keep</h2>','Mode switch keeps edited source');
        button('Preview').click();await wait(()=>document.querySelector('.richtext-preview'));assert(document.querySelector('.richtext-preview').sandbox.value==='','Preview stays script-free');
        button('Visual').click();await wait(()=>visualSources.get('html')?.status('h2').enabled);assert(htmlSources.get('html').read()==='<h2 style="text-align:center">Keep</h2>','Reentry is raw-exact');
        api.postMessage({type:'styled-modes-result',ok:true});
      })().catch(error=>api.postMessage({type:'styled-modes-result',error:String(error)}));</script>`;
      await complete;
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); }
  },
}];
