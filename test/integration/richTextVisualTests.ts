import * as vscode from "vscode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictEqual } from "node:assert/strict";
import type { IntegrationTest } from "./testSupport";
import { financeHtml } from "../fixtures/richTextSpans";
import { richTableHtml, simpleTableHtml } from "../fixtures/richTextTables";

export const richTextVisualTests: readonly IntegrationTest[] = [{
  name: "basic visual webview edits, rejects metadata loss, freezes and returns to exact raw HTML through host history",
  async execute() {
    const directory = await mkdtemp(join(tmpdir(), "xm-visual-webview-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const media = vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor");
    const shared = vscode.Uri.joinPath(extension.extensionUri, "media", "shared");
    const out = vscode.Uri.joinPath(extension.extensionUri, "out", "webview");
    const panel = vscode.window.createWebviewPanel("visualSmoke", "Visual smoke", vscode.ViewColumn.Active, { enableScripts: true });
    let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      panel.webview.options = { enableScripts: true, localResourceRoots: [media, shared, out, vscode.Uri.file(directory)] };
      await writeFile(join(directory, "smoke.js"), String.raw`
        const assert=(v,m)=>{if(!v)throw Error(m);};
        const wait=()=>new Promise(r=>setTimeout(r,50));
        (async()=>{
          const raw="<P>A&#38;B</P>\r\n<p>second</p>";
          const field={id:"html",label:"Text",name:"Text",section:"Data",type:"Rich Text",scope:"VERSIONED",source:"Exact locale",kind:"html",original:raw,input:raw,clear:false,raw};
          const state={type:"state",revision:1,busy:false,pending:false,item:{name:"Fixture",path:"/sitecore/content/Fixture"},target:{language:"en",version:1,itemId:"fixture"},connection:"Test",fields:[field],status:"Ready"};
          const show=(input,focus)=>window.dispatchEvent(new MessageEvent("message",{data:{...state,fields:[{...field,input}],focus}}));
          const button=name=>[...document.querySelectorAll(".html-source-actions button")].find(b=>b.textContent===name);
          show(raw);button("Visual").click();await wait();
          assert(visualSources.has("html"),"Visual admitted");assert(htmlSources.get("html").read()===raw,"Untouched raw exact");
          button("HTML").click();await wait();assert(htmlSources.get("html").read()===raw,"Unchanged switch exact");
          button("Visual").click();await wait();
          visualSources.get("html").restore({from:1,to:2});visualSources.get("html").command("bold");await wait();
          assert(htmlSources.get("html").read()==="<P><strong>A</strong>&amp;B</P>\r\n<p>second</p>","Real formatting export");
          const edited=htmlSources.get("html").read();
          document.querySelector(".tiptap").dispatchEvent(new KeyboardEvent("keydown",{key:"z",code:"KeyZ",ctrlKey:true,bubbles:true,cancelable:true}));
          document.querySelector(".tiptap").dispatchEvent(new InputEvent("beforeinput",{inputType:"historyRedo",bubbles:true,cancelable:true}));
          show(raw,{id:"html"});await wait();assert(visualSources.has("html"),"Host undo restores visual mode");
          assert(htmlSources.get("html").read()===raw,"Host undo restores original entity spelling");
          show(edited,{id:"html"});await wait();assert(htmlSources.get("html").read()===edited,"Host redo restores draft");
          window.dispatchEvent(new MessageEvent("message",{data:{type:"freeze",id:"visual-freeze",revision:1}}));await wait();
          assert(document.querySelector(".tiptap").contentEditable==="false","Frozen visual surface");
          window.dispatchEvent(new MessageEvent("message",{data:{type:"unfreeze",revision:1,error:""}}));
          assert(document.querySelector(".tiptap").contentEditable==="true","Unfrozen visual surface");
          button("HTML").click();await wait();assert(!document.querySelector(".tiptap"),"Visual disposed on mode switch");
          show('<p id="managed">keep</p>');button("Visual").click();await wait();
          assert(!visualSources.has("html")&&!document.getElementById("html").hidden,"Unsupported stays HTML-editable");
          assert(htmlSources.get("html").read()==='<p id="managed">keep</p>',"Unsupported raw not repaired");
          assert(document.querySelector(".visual-error").textContent.includes("Identity"),"Admission reason survives source snapshot reads");
          const opaque='<style>body{display:none}</style><p>A<img src="https://example.test/no-request" data-dam-id="42"></p>';
          show(opaque);button("Visual").click();await wait();
          // ProseMirror may insert a source-less IMG separator after inline atoms.
          assert(visualSources.has("html")&&!document.querySelector("#fields style,#fields img[src],#fields img[srcset]"),"Opaque assets never active in host");
          const controller=visualSources.get("html");controller.restore({from:1,to:4});
          document.execCommand("delete");await wait();assert(htmlSources.get("html").read()===opaque,"Deleting opaque data rejected atomically");
          show("");button("Visual").click();await wait();assert(visualSources.has("html"),"Empty visual projection");
          assert(htmlSources.get("html").read()==="","Empty opening must not invent paragraph");
          show("<p>word</p>");await wait();
          visualSources.get("html").restore({from:1,to:1});
          const clipboard=new DataTransfer();clipboard.setData("text/plain","paste ");
          document.querySelector(".tiptap").dispatchEvent(new ClipboardEvent("paste",{clipboardData:clipboard,bubbles:true,cancelable:true}));
          await wait();assert(htmlSources.get("html").read()==="<p>paste word</p>","Plain paste uses guarded transaction");
          clipboard.setData("text/html",'<p onclick="bad()">loss</p>');
          document.querySelector(".tiptap").dispatchEvent(new ClipboardEvent("paste",{clipboardData:clipboard,bubbles:true,cancelable:true}));
          await wait();assert(htmlSources.get("html").read()==="<p>paste word</p>","Formatted paste is rejected without partial text insertion");
          const finance=${JSON.stringify(financeHtml)};
          show(finance);await wait();
          assert(visualSources.has("html")&&htmlSources.get("html").read()===finance,"Exact finance sample admitted without rewriting");
          assert(getComputedStyle(document.querySelector(".tiptap h6")).textAlign==="center","Safe alignment projection");
          assert(!document.querySelector(".tiptap [style],.tiptap .theme-primary"),"Original CSS/classes stay out of trusted DOM");
          visualSources.get("html").restore({from:2,to:2});document.execCommand("insertText",false,"New ");await wait();
          assert(htmlSources.get("html").read().includes('<span class="theme-primary">New Paying For Your Grenadier</span>'),"Typing inside span retains wrapper");
          const spanEdit=htmlSources.get("html").read();
          button("HTML").click();await wait();assert(document.getElementById("html").value===htmlSourceTools.normalize(spanEdit),"Edited span enters HTML unchanged");
          button("Visual").click();await wait();show(finance,{id:"html"});await wait();
          assert(htmlSources.get("html").read()===finance,"Undo restores exact finance entry source and entities");
          show(spanEdit,{id:"html"});await wait();assert(htmlSources.get("html").read()===spanEdit,"Redo restores span edit");
          const nested='<p>AA<span class="x">BB<span style="text-align: center;">CC</span>DD</span>EE</p>';
          show(nested);await wait();visualSources.get("html").restore({from:1,to:15});
          visualSources.get("html").command("bold");await wait();
          assert(htmlSources.get("html").read()==='<p><strong>AA</strong><span class="x"><strong>BB</strong><span style="text-align: center;"><strong>CC</strong></span><strong>DD</strong></span><strong>EE</strong></p>',"Formatting crosses span boundaries without flattening");
          visualSources.get("html").command("bold");await wait();assert(htmlSources.get("html").read()===nested,"Remove formatting restores exact nested entry");
          visualSources.get("html").restore({from:8,to:8});
          const plain=new DataTransfer();plain.setData("text/plain","X");
          document.querySelector(".tiptap").dispatchEvent(new ClipboardEvent("paste",{clipboardData:plain,bubbles:true,cancelable:true}));await wait();
          assert(htmlSources.get("html").read().includes('>CXC</span>'),"Paste edits nested text while retaining structure");
          const beforeSplit=htmlSources.get("html").read();
          document.querySelector(".tiptap").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true,cancelable:true}));await wait();
          assert(htmlSources.get("html").read()===beforeSplit,"Span split cannot duplicate or flatten wrappers");
          const attributed='<p style="text-align:center">one</p><p style="text-align:center">two</p>';
          show(attributed);await wait();visualSources.get("html").restore({from:6,to:6});
          document.querySelector(".tiptap").dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",code:"Backspace",bubbles:true,cancelable:true}));await wait();
          assert(htmlSources.get("html").read()===attributed,"Join cannot remove attributed block");
          show('<p><strong>AA<span class="x">BB</span>CC</strong></p>');await wait();
          visualSources.get("html").restore({from:1,to:9});visualSources.get("html").command("bold");await wait();
          assert(htmlSources.get("html").read()==='<p>AA<span class="x">BB</span>CC</p>',"Remove inherited formatting across span boundary");
          const table=${JSON.stringify(simpleTableHtml)}; const richTable=${JSON.stringify(richTableHtml)};
          show(richTable);await wait();assert(visualSources.has("html")&&htmlSources.get("html").read()===richTable,"Caption/sections/columns/wrapper import is exact");
          assert(document.querySelectorAll('.tiptap table').length===3,"Each section has an isolated grid");
          assert(!document.querySelector('.tiptap #prices,.tiptap [style],.tiptap #size'),"Table identity and CSS do not enter trusted DOM");
          const selectText=(text,offset)=>{const walker=document.createTreeWalker(document.querySelector('.tiptap'),NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.textContent===text){document.querySelector('.tiptap').focus();const range=document.createRange();range.setStart(node,offset);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return;}}throw Error('Text missing '+text);};
          selectText('Prices & sizes',0);await wait();document.execCommand('insertText',false,'New ');await wait();
          assert(htmlSources.get('html').read()===richTable.replace('Prices &amp;','New Prices &amp;'),"Caption edit preserves every other token");
          selectText('Large',5);await wait();document.execCommand('insertText',false,' XL');await wait();
          const tableEdit=htmlSources.get('html').read();assert(tableEdit.includes('>Large XL</td>'),"Cell text editable with metadata");
          visualSources.get('html').command('rowAfter');await wait();assert(htmlSources.get('html').read()===tableEdit,"Metadata-bearing structural edit refused");
          assert(document.querySelector('.visual-error').textContent.includes('metadata'),"Specific table policy reason");
          button('HTML').click();await wait();button('Visual').click();await wait();assert(htmlSources.get('html').read()===tableEdit,"Edited table mode switch exact");
          show(table);await wait();visualSources.get('html').restore({from:5,to:5});visualSources.get('html').command('rowAfter');await wait();
          assert((htmlSources.get('html').read().match(/<tr>/g)||[]).length===3,"Insert row through real controller");
          visualSources.get('html').command('columnAfter');await wait();assert((htmlSources.get('html').read().match(/<td>/g)||[]).length===9,"Insert column through real controller");
          show(table);await wait();visualSources.get('html').restore({from:3,to:8,anchorCell:3,headCell:8});visualSources.get('html').command('mergeCells');await wait();
          assert(htmlSources.get('html').read().includes('<td colspan="2">A</td>'),"Multi-cell merge retains content");
          visualSources.get('html').command('splitCell');await wait();assert(htmlSources.get('html').read()===table,"Split restores original grid");
          visualSources.get('html').restore({from:5,to:5});visualSources.get('html').command('deleteRow');await wait();assert(htmlSources.get('html').read()===table,"Populated row deletion refused");
          visualSources.get('html').command('caption');await wait();document.execCommand('insertText',false,'Caption');await wait();
          assert(htmlSources.get('html').read().includes('<caption>Caption</caption>'),"New caption typing");
          show(table);await wait();visualSources.get('html').restore({from:5,to:5});
          const tablePaste=new DataTransfer();tablePaste.setData('text/plain','X');document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste',{clipboardData:tablePaste,bubbles:true,cancelable:true}));await wait();
          assert(htmlSources.get('html').read()===table.replace('>A<','>XA<'),"Plain cell paste retains grid");
          const pastedTable=htmlSources.get('html').read();tablePaste.setData('text/html','<table><tr><td>bad</td></tr></table>');document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste',{clipboardData:tablePaste,bubbles:true,cancelable:true}));await wait();
          assert(htmlSources.get('html').read()===pastedTable,"Formatted table paste rejected atomically");
          show(table,{id:'html'});await wait();assert(htmlSources.get('html').read()===table,"Host table undo restores raw");
          show(pastedTable,{id:'html'});await wait();assert(htmlSources.get('html').read()===pastedTable,"Host table redo restores edited raw");
          api.postMessage({type:"visual-test",ok:true,edited});
        })().catch(error=>api.postMessage({type:"visual-test",error:String(error)}));
      `);
      let frozen: { drafts: Record<string, { input: string }> } | undefined; let undoRequests = 0; let redoRequests = 0;
      const complete = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(Error("Visual webview timed out")), 35000);
        listener = panel.webview.onDidReceiveMessage(message => {
          if (message.type === "undo") undoRequests++;
          if (message.type === "redo") redoRequests++;
          if (message.type === "frozen") frozen = message;
          if (message.type === "visual-test") {
            try { strictEqual(message.ok, true, message.error); strictEqual(frozen?.drafts.html.input, message.edited); strictEqual(undoRequests, 1, "One native undo request per keypress"); strictEqual(redoRequests, 1, "Native beforeinput history routes to host"); resolve(); } catch (error) { reject(error); }
          }
        });
      });
      const script = (uri: vscode.Uri) => `<script nonce="visual-test" src="${panel.webview.asWebviewUri(uri)}"></script>`;
      panel.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src ${panel.webview.cspSource} 'nonce-visual-test'; script-src 'nonce-visual-test';"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media,"editor.css"))}"><body><h1 id="title"></h1><p id="identity"></p><p id="path"></p><p id="status"></p><button id="save">Save</button><button id="revert">Revert</button><button id="reconcile">Reconcile</button><button id="locale">Locale</button><main id="fields"></main>${script(vscode.Uri.joinPath(shared,"readOnlyField.js"))}${script(vscode.Uri.joinPath(media,"htmlSource.js"))}${script(vscode.Uri.joinPath(out,"richTextVisual.js"))}${script(vscode.Uri.joinPath(media,"editor.js"))}${script(vscode.Uri.file(join(directory,"smoke.js")))}</body>`;
      await complete;
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}];
