import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { actionPaths, actionIconSvg, iconForAction, isActionIcon } from '../../src/ui/actionIcons';

test('shared actions retain consistent icons across labels and refuse unknown keys', () => {
  assert.equal(iconForAction('Save'), iconForAction('Save connection'));
  assert.equal(iconForAction('Clear'), iconForAction('Clear content'));
  assert.equal(iconForAction('Retry Browser DOM'), iconForAction('Refresh Item'));
  assert.equal(iconForAction('Publish again…'), iconForAction('Queue Power Publish'));
  assert.equal(iconForAction('<script>Save</script>'), undefined);
  assert.equal(isActionIcon('__proto__'), false);
  assert.equal(isActionIcon('constructor'), false);
});
test('bundled icons are inert original paths with decorative accessibility semantics', () => {
  for (const icon of Object.keys(actionPaths)) {
    assert.ok(isActionIcon(icon));
    const svg = actionIconSvg(icon);
    assert.match(svg, /aria-hidden="true" focusable="false"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.doesNotMatch(svg, /(?:href|url|script|style|onload|foreignObject)/i);
    assert.match(actionPaths[icon], /^[a-zA-Z0-9 .,-]+$/);
  }
});
