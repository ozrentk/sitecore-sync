import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures } from '../richtext/fixtures.mjs';

const evidence = new URL('../../../.test-out/prosemirror-spike/', import.meta.url);
await mkdir(evidence, { recursive: true });
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./browser.mjs', import.meta.url))], bundle: true,
  platform: 'browser', format: 'iife', minify: true, write: false, metafile: true });
await writeFile(new URL('bundle.js', evidence), bundle.outputFiles[0].contents);
await writeFile(new URL('bundle-meta.json', evidence), JSON.stringify(bundle.metafile, null, 2));

test('direct ProseMirror standard versus attribute-preserving schema', async () => {
  const browser = await chromium.launch({ channel: process.env.SPIKE_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const inputs = [...fixtures, { id: 'nested-spans', html: '<p><span class="outer">A<span class="inner">B</span>C</span></p>' }];
    if (process.env.SPIKE_LIVE_FILE) inputs.push(...JSON.parse(await readFile(process.env.SPIKE_LIVE_FILE, 'utf8')));
    const rows = [];
    for (const f of inputs) rows.push({ ...f,
      standard: await page.evaluate(html => pmRoundTrip(html), f.html),
      adapted: await page.evaluate(html => pmRoundTrip(html, true), f.html) });
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    let matchedControl; let controlScript;
    if (process.env.SPIKE_TIPTAP_CONTROL === '1') {
      const aliases = Object.fromEntries(['prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform', 'orderedmap']
        .map(name => [name, fileURLToPath(new URL(`./node_modules/${name}/dist/index.js`, import.meta.url))]));
      const control = await build({ entryPoints: [fileURLToPath(new URL('./tiptap-control.mjs', import.meta.url))],
        bundle: true, platform: 'browser', format: 'iife', write: false, alias: aliases });
      controlScript = control.outputFiles[0].text;
      await page.addScriptTag({ content: control.outputFiles[0].text });
      matchedControl = [];
      for (const row of rows) {
        const output = await page.evaluate(html => matchedTiptap(html), row.html);
        assert.equal(output, row.adapted.output, `Matched-schema control: ${row.id}`);
        matchedControl.push({ id: row.id, identical: true });
      }
    }
    assert.equal(byId.basic.standard.exact, true);
    assert.equal(byId['finance-shape'].standard.output.includes('theme-primary'), false);
    assert.match(byId['finance-shape'].adapted.output, /theme-primary/);
    assert.match(byId['finance-shape'].adapted.afterTextEdit, /theme-primary/);
    assert.match(byId['dam-image'].adapted.output, /stylelabs-content-id="42"/);
    assert.doesNotMatch(byId['dam-image'].standard.output, /stylelabs-content-id/);
    assert.match(byId['internal-link'].adapted.output, /data-sc-id=/);
    assert.doesNotMatch(byId['internal-link'].adapted.output, /target="_blank"/);
    assert.match(byId['media-link'].adapted.output, /download="guide.pdf"/);
    assert.doesNotMatch(byId['embedded-css'].adapted.output, /<style/);
    assert.doesNotMatch(byId.unknown.adapted.output, /custom-card/);
    assert.equal(byId.empty.adapted.output, '<p></p>');
    assert.equal(byId.lexical.adapted.exact, false);
    const attributeTrap = await page.evaluate(() => pmAttributeTrap('<p><a href="/old">Old link</a></p>'));
    assert.match(attributeTrap, /href="\/old"/, 'Naive originals override intentionally changed href');
    const splitTrap = await page.evaluate(() => pmSplitTrap('<p id="anchor">AB</p>'));
    assert.equal((splitTrap.match(/id="anchor"/g) || []).length, 2, 'Naive metadata clones IDs on split');
    assert.notEqual(byId['nested-spans'].adapted.output, byId['nested-spans'].html);

    const strict = await browser.newPage(); const strictRequests = [];
    await strict.route('**/*', route => { strictRequests.push(route.request().url()); return route.abort(); });
    await strict.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-spike'; style-src 'nonce-spike';"><style nonce="spike">.ProseMirror{white-space:pre-wrap} [data-align=center]{text-align:center}</style><script nonce="spike">${bundle.outputFiles[0].text}</script>`);
    const strictOutput = await strict.evaluate(html => pmRoundTrip(html, true), byId['finance-shape'].html);
    if (controlScript) {
      await strict.evaluate(content => { const s = document.createElement('script'); s.nonce = 'spike'; s.textContent = content; document.head.append(s); }, controlScript);
      assert.equal(await strict.evaluate(html => matchedTiptap(html), byId['finance-shape'].html), strictOutput.output);
    }
    await strict.evaluate(html => mountPM(html), byId['finance-shape'].html);
    assert.equal(await strict.locator('h6').evaluate(el => getComputedStyle(el).textAlign), 'center');
    const before = await strict.evaluate(() => pmSnapshot());
    await strict.getByRole('textbox', { name: 'ProseMirror experiment' }).click();
    await strict.keyboard.type('typed');
    assert.match(await strict.evaluate(() => pmSnapshot()), /typed/);
    assert.equal(await strict.evaluate(() => pmUndo()), true);
    assert.equal(await strict.evaluate(() => pmSnapshot()), before);
    assert.equal(await strict.evaluate(() => pmRedo()), true);
    const paste = await strict.evaluate(html => pmPaste(html), byId['dam-image'].html);
    assert.match(paste, /stylelabs-content-id="42"/);
    assert.equal(await strict.locator('img,a[href]').count(), 0);
    await strict.evaluate(() => mountPM('<p onclick="window.pwned=1" style="background-image:url(https://evil.test/bg)">X</p><a href="javascript:window.pwned=1">Y</a><img src="https://evil.test/image" onerror="window.pwned=1">'));
    await strict.locator('.ProseMirror').last().click();
    assert.equal(await strict.evaluate(() => Boolean(window.pwned)), false);
    const activeMarkup = await strict.locator('.ProseMirror [onclick],.ProseMirror [onerror],.ProseMirror img[src],.ProseMirror a[href]').evaluateAll(nodes => nodes.map(n => n.outerHTML));
    assert.deepEqual(activeMarkup, []);
    assert.equal(strictRequests.length, 0);
    await writeFile(new URL(process.env.SPIKE_LIVE_FILE ? 'live-results.json' : 'results.json', evidence), JSON.stringify({
      bundleBytes: bundle.outputFiles[0].contents.length, rows, matchedControl, strictOutput, paste, attributeTrap, splitTrap, requests, strictRequests }, null, 2));
    console.log(`ProseMirror: ${rows.length} cases, standard + adapted; ${bundle.outputFiles[0].contents.length} bundle bytes`);
  } finally { await browser.close(); }
});

test('pinned direct dependency closure includes MIT notices', async () => {
  const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8')); const rows = [];
  for (const path of Object.keys(lock.packages).filter(Boolean)) {
    const folder = new URL(`./${path}/`, import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', folder), 'utf8'));
    assert.equal(pkg.license, 'MIT');
    const file = (await readdir(folder)).find(n => /^licen[sc]e/i.test(n)); assert.ok(file, pkg.name);
    assert.match(await readFile(new URL(file, folder), 'utf8'), /Permission is hereby granted, free of charge/i);
    rows.push({ name: pkg.name, version: pkg.version, license: pkg.license });
  }
  await writeFile(new URL('licenses.json', evidence), JSON.stringify(rows, null, 2));
  console.log(`${rows.length} packages with MIT notices`);
});
