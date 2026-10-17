import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures } from '../richtext/fixtures.mjs';

const evidence = new URL('../../../.test-out/custom-richtext-spike/', import.meta.url);
await mkdir(evidence, { recursive: true });
const alias = Object.fromEntries(['model','state','view','transform','commands','history','keymap']
  .map(name => [`prosemirror-${name}`, fileURLToPath(new URL(`./node_modules/prosemirror-${name}/dist/index.js`, import.meta.url))]));
alias.orderedmap = fileURLToPath(new URL('./node_modules/orderedmap/dist/index.js', import.meta.url));
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./custom-browser.mjs', import.meta.url))],
  bundle: true, format: 'iife', platform: 'browser', write: false, alias });
const nested = '<p><span class="outer" data-x="1">A<span class="inner" style="color:red">BC</span>D</span></p>';
const table = '<div class="overflow" style="overflow-x:auto"><style media="screen" data-origin="test">.grid td{color:red}</style><table class="grid"><caption class="label">Caption</caption><tbody data-body="keep"><tr><td>Cell</td><td>Other</td></tr></tbody></table></div>';
const records = [];
const liveInputs = process.env.SPIKE_LIVE_FILE ? JSON.parse(await readFile(process.env.SPIKE_LIVE_FILE, 'utf8')) : [];

test('custom Tiptap and direct ProseMirror: structural preservation through editing', async () => {
  const browser = await chromium.launch({ channel: process.env.SPIKE_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-spike'; style-src 'nonce-spike'; frame-src 'self' about:;"><style nonce="spike">.ProseMirror{white-space:pre-wrap} #chrome{color:rgb(0,128,0)}</style><div id="chrome">Editor toolbar</div><script nonce="spike">${bundle.outputFiles[0].text}</script>`);
    const run = (method, ...args) => page.evaluate(({ method, args }) => custom[method](...args), { method, args });
    const outputs = {};
    for (const engine of ['direct', 'tiptap']) {
      outputs[engine] = [];
      for (const fixture of [...fixtures, { id: 'nested', html: nested }, { id: 'caption-table', html: table }]) {
        if (fixture.id === 'lists') {
          await assert.rejects(run('mount', engine, fixture.html), /HTML-only: mixed wrapper content/);
          outputs[engine].push({ id: fixture.id, classification: 'unsupported mixed list content in this importer' });
          continue;
        }
        const initial = await run('mount', engine, fixture.html);
        assert.equal(await run('raw'), fixture.html, `${engine}/${fixture.id}: original raw HTML`);
        assert.equal(await run('switchHTML'), fixture.html);
        if (['styles','table','internal-link','media-link','media-image','dam-image','unknown','embedded-css','nested','caption-table'].includes(fixture.id)) {
          assert.deepEqual(await run('semanticTree', initial), await run('semanticTree', fixture.html), fixture.id);
        }
        outputs[engine].push({ id: fixture.id, initial });
      }
      await run('mount', engine, nested);
      assert.equal(await run('snapshot'), nested);
      await run('select', 'BC', 1);
      await page.keyboard.type('typed');
      assert.match(await run('snapshot'), /<span class="inner" style="color:red">BtypedC<\/span>/);
      await run('select', 'BtypedC', 1, 5); assert.equal(await run('bold'), true);
      assert.match(await run('snapshot'), /B<strong>typed<\/strong>C/);
      records.push({ engine, case: 'nested-typing-formatting', output: await run('snapshot') });

      await run('mount', engine, '<p id="anchor" class="keep">AB</p>');
      await run('select', 'AB', 1); assert.equal(await run('split'), true);
      const split = await run('snapshot');
      assert.equal(split, '<p id="anchor" class="keep">A</p><p class="keep">B</p>');
      assert.equal(await run('join'), true);
      assert.equal(await run('snapshot'), '<p id="anchor" class="keep">AB</p>');
      records.push({ engine, case: 'split-join', output: split });

      const link = fixtures.find(f => f.id === 'internal-link').html;
      await run('mount', engine, link); await run('select', 'Go', 0, 2);
      assert.equal(await run('link', '/changed'), true);
      const changedLink = await run('snapshot');
      assert.match(changedLink, /href="\/changed"/); assert.match(changedLink, /data-sc-id=/);
      assert.doesNotMatch(changedLink, /href="~\/link/);
      assert.equal(await run('undo'), true); assert.equal(await run('raw'), link);
      assert.equal(await run('redo'), true); assert.equal(await run('snapshot'), changedLink);
      records.push({ engine, case: 'link-history', output: changedLink });

      await run('mount', engine, table);
      await run('select', 'Caption', 7); await page.keyboard.type(' edited');
      await run('select', 'Cell', 4); await page.keyboard.type(' edited');
      assert.equal(await run('row'), true, `${engine} table: ${JSON.stringify(await run('debug'))}`);
      const changedTable = await run('snapshot');
      assert.match(changedTable, /<caption class="label">Caption edited<\/caption>/);
      assert.match(changedTable, /<style media="screen" data-origin="test">\.grid td\{color:red\}<\/style>/);
      assert.match(changedTable, /style="overflow-x:auto"/);
      assert.match(changedTable, /<tbody data-body="keep">/);
      assert.equal((changedTable.match(/<tr/g) || []).length, 2);
      records.push({ engine, case: 'caption-cell-row-edit', output: changedTable });

      const code = '<pre data-x="keep"><code class="language-js" data-language="js">a  b\n c</code></pre>';
      await run('mount', engine, code); await run('select', 'a  b', 1); await page.keyboard.type('X');
      assert.equal(await run('snapshot'), code.replace('a  b', 'aX  b'));
      const unknown = fixtures.find(f => f.id === 'unknown').html;
      await run('mount', engine, unknown); await run('select', 'Inside', 6); await page.keyboard.type(' edited');
      assert.equal(await run('snapshot'), unknown.replace('Inside', 'Inside edited'));

      const image = fixtures.find(f => f.id === 'dam-image').html;
      await run('mount', engine, image + '<p>After</p>'); await run('select', 'After', 5); await page.keyboard.type(' edited');
      const imageEdited = await run('snapshot');
      assert.ok(imageEdited.startsWith('<img ')); assert.match(imageEdited, /stylelabs-content-id="42"/);
      assert.match(imageEdited, /mediaid=""/);
      records.push({ engine, case: 'standalone-image-neighbor-edit', output: imageEdited });
      await run('mount', engine, '<p>Paste here</p>'); await run('select', 'Paste here', 10);
      await run('paste', image + table + nested);
      const pasted = await run('snapshot');
      assert.match(pasted, /stylelabs-content-id="42"/); assert.match(pasted, /<caption/);
      assert.match(pasted, /class="outer"/); assert.match(pasted, /class="inner"/);
      records.push({ engine, case: 'parsed-paste', output: pasted });
      await run('mount', engine, '<p>Paste here</p>'); await run('select', 'Paste here', 10);
      await page.evaluate(html => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html);
        document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, image + table + nested);
      assert.equal(await run('snapshot'), pasted, 'Paste event uses custom import adapter');
      await page.evaluate(() => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/html', '<script>window.pwned=1</script>');
        document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      assert.equal(await run('snapshot'), pasted, 'Rejected paste must not change the draft');
      assert.equal(await page.evaluate(() => pasteRejection), 'HTML-only: script');

      const lexical = fixtures.find(f => f.id === 'lexical').html;
      await run('mount', engine, lexical); await run('switchHTML');
      const rawEdit = lexical + '\r\n<!-- source edit &amp; -->\r';
      await run('htmlEdit', rawEdit); assert.equal(await run('raw'), rawEdit);
      await run('switchVisual'); assert.equal(await run('switchHTML'), rawEdit);
      await run('switchVisual'); await run('select', 'bold', 4); await page.keyboard.type('!');
      assert.match(await run('raw'), /bold!/);
      assert.equal(await run('undo'), true); assert.equal(await run('raw'), rawEdit);
      await run('switchHTML'); const newer = '<p data-new="yes">New source text</p><!--new-->';
      await run('htmlEdit', newer); await run('switchVisual'); await run('select', 'New source text', 15);
      await page.keyboard.type('!'); assert.match(await run('snapshot'), /New source text!/);
      assert.equal(await run('undo'), true); assert.equal(await run('raw'), newer);
      const unusualCSS = '<p style="vendor-unknown: keep; --token: 1; color: red">AB</p>';
      await run('mount', engine, unusualCSS); await run('select', 'AB', 1); await page.keyboard.type('X');
      assert.equal(await run('snapshot'), unusualCSS.replace('AB', 'AXB'));
      // Explicit remaining model/command boundary, not a successful preservation case.
      await run('mount', engine, '<p id="first">A</p><p id="second">B</p>');
      await run('select', 'B'); assert.equal(await run('join'), true);
      assert.equal(await run('snapshot'), '<p id="first">AB</p>');
      records.push({ engine, case: 'join-distinct-ids', classification: 'lossy without a join policy' });
      await run('mount', engine, nested); await run('select', 'BC', 1);
      const nestedSplit = await run('split');
      records.push({ engine, case: 'split-inside-inline-node', result: nestedSplit, output: await run('snapshot') });
      for (const unsupported of ['<div>text<p>block</p></div>', '<table><thead><tr><th>H</th></tr></thead></table>', '<p><strong>A<strong>B</strong></strong></p>']) {
        await assert.rejects(run('mount', engine, unsupported), /HTML-only:/);
      }
      assert.notEqual(await run('roundtrip', lexical), lexical);
      records.push({ engine, case: 'raw-mode-switch', exact: true });
    }
    assert.deepEqual(outputs.direct, outputs.tiptap);
    for (const row of records.filter(r => r.engine === 'direct')) {
      const counterpart = records.find(r => r.engine === 'tiptap' && r.case === row.case);
      assert.deepEqual({ ...row, engine: 'same' }, { ...counterpart, engine: 'same' });
    }
    assert.equal(await page.locator('#editor style,#editor a[href],#editor img[src]').count(), 0);
    assert.equal(requests.length, 0);
    await writeFile(new URL('results.json', evidence), JSON.stringify({ outputs, records, requests }, null, 2));
    if (liveInputs.length) {
      const live = [];
      for (const fixture of liveInputs) for (const engine of ['direct', 'tiptap']) {
        try {
          const initial = await run('mount', engine, fixture.html);
          const semanticEqual = JSON.stringify(await run('semanticTree', initial)) === JSON.stringify(await run('semanticTree', fixture.html));
          const differences = await page.evaluate(({ original, output }) => {
            const differences = [];
            function compare(a,b,path) {
              if (!a || !b) { differences.push({ path, kind: 'missing-node', before: a?.tag, after: b?.tag }); return; }
              if (a.tag !== b.tag) differences.push({ path, kind: 'tag', before: a.tag, after: b.tag });
              if (a.text !== b.text) differences.push({ path, kind: 'text', beforeLength: a.text?.length, afterLength: b.text?.length });
              if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) differences.push({ path, kind: 'attributes', beforeNames: a.attrs?.map(x=>x[0]), afterNames: b.attrs?.map(x=>x[0]) });
              for(let i=0;i<Math.max(a.children?.length||0,b.children?.length||0);i++) compare(a.children?.[i],b.children?.[i],path+'/'+i);
            }
            compare(custom.semanticTree(original),custom.semanticTree(output),'root'); return differences;
          }, { original: fixture.html, output: initial });
          const firstText = await page.locator('.ProseMirror').evaluate(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node; while ((node = walker.nextNode())) if (node.textContent.trim() && !node.parentElement.closest('[data-opaque]')) return node.textContent;
          });
          if (firstText) { await run('select', firstText); await page.keyboard.type('EDIT '); }
          const edited = await run('snapshot');
          if (firstText) { assert.equal(await run('undo'), true); assert.equal(await run('raw'), fixture.html); }
          live.push({ id: fixture.id, engine, initial, edited, exactInitial: initial === fixture.html, semanticEqual, differences, undoExact: true });
        } catch (error) {
          if (!/HTML-only:/.test(error.message)) throw error;
          live.push({ id: fixture.id, engine, rejected: error.message.split('\n')[0] });
        }
      }
      for (const row of live.filter(r => r.engine === 'direct')) {
        assert.deepEqual({ ...row, engine: 'same' }, { ...live.find(r => r.engine === 'tiptap' && r.id === row.id), engine: 'same' });
      }
      await writeFile(new URL('live-results.json', evidence), JSON.stringify(live, null, 2));
    }
  } finally { await browser.close(); }
});

test('script-free sandbox applies stored CSS without changing editor chrome or requesting assets', async () => {
  const browser = await chromium.launch({ channel: process.env.SPIKE_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent('<div id="chrome" style="color:rgb(0,128,0)">Toolbar</div>');
    await page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.setAttribute('sandbox', '');
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none';"><style data-origin="test">@import url('https://assets.example.test/style.css'); body{color:rgb(255,0,0)} .outer .inner{font-weight:700}</style><p class="outer">A<span class="inner">B</span></p><img src="https://assets.example.test/image"><script>window.pwned=1<\/script>`;
      document.body.append(frame);
    });
    const frame = page.frameLocator('iframe');
    assert.equal(await frame.locator('p').evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)');
    assert.equal(await frame.locator('.inner').evaluate(el => getComputedStyle(el).fontWeight), '700');
    assert.equal(await page.locator('#chrome').evaluate(el => getComputedStyle(el).color), 'rgb(0, 128, 0)');
    assert.equal(await page.evaluate(() => Boolean(window.pwned)), false);
    assert.equal(await frame.locator('p').evaluate(el => Boolean(el.ownerDocument.defaultView.pwned)), false);
    assert.equal(requests.length, 0);
  } finally { await browser.close(); }
});

test('isolated editable iframe applies CSS while both custom engines still edit nested content', async () => {
  const browser = await chromium.launch({ channel: process.env.SPIKE_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent('<div id="chrome" style="color:rgb(0,128,0)">Toolbar</div>');
    await page.evaluate(script => {
      const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-spike'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';"><script nonce="spike">globalThis.ISOLATED_VISUAL=true;${script}<\/script>`;
      document.body.append(iframe);
    }, bundle.outputFiles[0].text);
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    await frame.waitForFunction(() => Boolean(globalThis.custom));
    const styled = '<style media="screen" data-origin="keep">body{color:rgb(255,0,0)} .outer .inner{font-weight:700} p{text-align:center;background-image:url(https://assets.example.test/bg)}</style>' + nested;
    for (const engine of ['direct','tiptap']) {
      await frame.evaluate(({ engine, styled }) => custom.mount(engine, styled), { engine, styled });
      assert.equal(await frame.locator('.inner').evaluate(el => getComputedStyle(el).fontWeight), '700');
      assert.equal(await frame.locator('p').evaluate(el => getComputedStyle(el).textAlign), 'center');
      assert.equal(await frame.locator('p').evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)');
      await frame.evaluate(() => custom.select('BC', 1)); await page.keyboard.type('EDIT');
      assert.match(await frame.evaluate(() => custom.snapshot()), /BEDITC/);
      assert.match(await frame.evaluate(() => custom.snapshot()), /<style media="screen" data-origin="keep">/);
      assert.equal(await frame.evaluate(() => custom.undo()), true);
      assert.equal(await frame.evaluate(() => custom.raw()), styled);
      assert.equal(await frame.evaluate(() => { try { return Boolean(parent.document); } catch { return false; } }), false);
    }
    assert.equal(await page.locator('#chrome').evaluate(el => getComputedStyle(el).color), 'rgb(0, 128, 0)');
    assert.equal(requests.length, 0);
  } finally { await browser.close(); }
});
