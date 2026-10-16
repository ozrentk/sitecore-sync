import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outputDir = new URL('../../../.test-out/richtext-spike/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./browser.mjs', import.meta.url))], bundle: true,
  platform: 'browser', format: 'iife', minify: true, write: false, metafile: true });
await writeFile(new URL('bundle.js', outputDir), bundle.outputFiles[0].contents);
await writeFile(new URL('bundle-meta.json', outputDir), JSON.stringify(bundle.metafile, null, 2));

test('bounded Tiptap compatibility and source-editor experiment', async () => {
  const browser = await chromium.launch({ channel: process.env.SPIKE_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const attempts = [];
    // No supplied HTML can reach a remote service, even in the permissive baseline.
    await page.route('**/*', route => { attempts.push(route.request().url()); return route.abort(); });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const results = [];
    for (const fixture of fixtures) results.push({ ...fixture, ...await page.evaluate(html => roundTrip(html), fixture.html) });
    if (process.env.SPIKE_LIVE_FILE) {
      const live = JSON.parse(await readFile(process.env.SPIKE_LIVE_FILE, 'utf8'));
      for (const fixture of live) results.push({ ...fixture, ...await page.evaluate(html => roundTrip(html), fixture.html) });
    }
    const byId = Object.fromEntries(results.map(row => [row.id, row]));
    assert.equal(byId.basic.output, byId.basic.html);
    assert.ok(byId['finance-shape'].output.includes('text-align: center'));
    assert.ok(!byId['finance-shape'].output.includes('theme-primary'));
    assert.ok(!byId['dam-image'].output.includes('stylelabs-content-id'));
    assert.equal(byId['dam-image'].errors.length, 0, 'Content checking does not detect attribute loss');
    assert.ok(byId['internal-link'].output.includes('target="_blank"'));
    assert.ok(!byId['internal-link'].output.includes('data-sc-id'));
    assert.ok(!byId['media-link'].output.includes('download='));
    assert.ok(!byId.table.output.includes('<caption>'));
    assert.ok(!byId.table.output.includes('882px'));
    assert.ok(byId['media-image'].output.startsWith('<p>Before</p><img'));
    assert.ok(!byId.unknown.output.includes('data-key'));
    assert.ok(!byId['embedded-css'].output.includes('<style'));
    assert.equal(byId.empty.output, '<p></p>');
    assert.ok(results.every(row => row.initialUpdates === 0 && row.afterSetUpdates === 0));
    const source = await page.evaluate(() => sourceRoundTrip("<p class='x'>A</p>\r\n<p>B</p>"));
    assert.ok(!source.normal.includes('\r'));
    assert.ok(source.crlf.includes('\r\n'));
    // Current outer webview-equivalent CSP: script/style nonces, no inline style attributes.
    const strict = await browser.newPage(); const strictRequests = [];
    await strict.route('**/*', route => { strictRequests.push(route.request().url()); return route.abort(); });
    await strict.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-spike'; style-src 'nonce-spike';"><script nonce="spike">${bundle.outputFiles[0].text}</script>`);
    const strictRoundTrip = await strict.evaluate(html => roundTrip(html), byId['finance-shape'].html);
    assert.ok(!strictRoundTrip.output.includes('text-align'), 'Current CSP needs a style parsing/rendering adapter');
    await strict.evaluate(html => roundTrip(html), byId['dam-image'].html);
    await strict.evaluate(() => mountEditors());
    await strict.getByRole('textbox', { name: 'Visual HTML', exact: true }).click();
    await strict.keyboard.press('End'); await strict.keyboard.type(' typed');
    assert.match(await strict.evaluate(() => spikeEditors.editor.getHTML()), /typed/);
    await strict.getByRole('textbox', { name: 'HTML source', exact: true }).click();
    await strict.keyboard.press('End'); await strict.keyboard.type(' source');
    assert.match(await strict.evaluate(() => spikeEditors.view.state.doc.toString()), /source/);
    assert.equal(strictRequests.length, 0);
    await writeFile(new URL(process.env.SPIKE_LIVE_FILE ? 'live-results.json' : 'results.json', outputDir), JSON.stringify({ bundleBytes: bundle.outputFiles[0].contents.length,
      results, source, strictRoundTrip, baselineBlockedRequests: attempts, strictRequests }, null, 2));
    console.log(`Checked ${results.length} fixtures; bundle ${bundle.outputFiles[0].contents.length} bytes. Evidence directory: ${root}.test-out/richtext-spike/`);
  } finally { await browser.close(); }
});

test('all candidate dependencies declare MIT and ship the permission notice', async () => {
  const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));
  const rows = [];
  for (const [path] of Object.entries(lock.packages).filter(([path]) => path)) {
    const folder = new URL(`./${path}/`, import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', folder), 'utf8'));
    assert.equal(pkg.license, 'MIT', pkg.name);
    const { readdir } = await import('node:fs/promises');
    const name = (await readdir(folder)).find(name => /^licen[sc]e/i.test(name));
    assert.ok(name, pkg.name);
    assert.match(await readFile(new URL(name, folder), 'utf8'), /Permission is hereby granted, free of charge/i, pkg.name);
    rows.push({ name: pkg.name, version: pkg.version, license: pkg.license, licenseFile: name });
  }
  await writeFile(new URL('licenses.json', outputDir), JSON.stringify(rows, null, 2));
  assert.equal(rows.length, 64);
});
