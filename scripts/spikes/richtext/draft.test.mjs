import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftExperiment } from './draft-experiment.mjs';

test('opening and switching retain original bytes, including empty and legacy HTML', () => {
  for (const raw of ['', "<P class='x'>A &rsquo;</P>\r\n<!--keep-->"]) {
    const draft = new DraftExperiment(raw);
    assert.equal(draft.enterVisual(() => ({ type: 'doc' }), () => true), true);
    assert.equal(draft.enterHTML(), raw); assert.equal(draft.dirty, false);
  }
});
test('HTML-only edits, backup and undo do not use visual serialization', () => {
  const draft = new DraftExperiment('<p>A</p>');
  const raw = "<custom x='1'>B</custom>\r\n<style>x{}</style>";
  draft.changeHTML(raw);
  assert.equal(draft.enterVisual(() => { throw Error('Must not parse'); }, () => false), false);
  assert.equal(draft.enterHTML(), raw);
  assert.equal(JSON.parse(draft.backup()).raw, raw);
  draft.undo(); assert.equal(draft.dirty, false);
});
test('actual visual edits serialize; returning to entry document restores original bytes', () => {
  const draft = new DraftExperiment('<P>A</P>');
  draft.enterVisual(() => ({ text: 'A' }), () => true);
  draft.changeVisual({ text: 'B' }, doc => `<p>${doc.text}</p>`);
  assert.equal(draft.enterHTML(), '<p>B</p>'); assert.equal(draft.dirty, true);
  draft.changeVisual({ text: 'A' }, () => { throw Error('Do not normalize a restored baseline'); });
  assert.equal(draft.raw, '<P>A</P>'); assert.equal(draft.dirty, false);
});
