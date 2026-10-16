import { actionIconSvg, iconForAction, isActionIcon } from '../src/ui/actionIcons';

function decorate(element: HTMLElement): void {
  if (element.matches('.picker-choice, .comparison-cell, .field-suggestion, [role=option], .selection-trigger, [data-selection-label]')) return;
  const known: Record<string, string> = { swap: 'swap', 'mode-browse': 'preview', 'mode-compare': 'swap', 'item-navigation-mode': 'right' };
  const tableActions: Record<string, string> = { insertTable: 'table', caption: 'edit', rowBefore: 'up', rowAfter: 'down', columnBefore: 'left', columnAfter: 'right', deleteRow: 'remove', deleteColumn: 'remove', mergeCells: 'table', splitCell: 'table' };
  let command = element.dataset.richCommand || element.dataset.actionIcon || known[element.id];
  if (command && Object.hasOwn(tableActions, command)) command = tableActions[command];
  let glyph = element.dataset.iconOnly === "true";
  if (element.matches('.field-info-button')) { command = 'info'; glyph = true; }
  if (element.matches('.identity-copy')) command = element.textContent?.startsWith('✓') ? 'check' : 'copy';
  if (element.matches('.copy-value')) { command = element.classList.contains('right') ? 'right' : 'left'; glyph = true; }
  if (element.matches('.link-expand')) { command = element.getAttribute('aria-expanded') === 'true' ? 'collapse' : 'expand'; glyph = true; }
  if (element.matches('.selection-remove')) { command = 'remove'; glyph = true; }
  if (element.matches('.picker-children')) { command = 'right'; glyph = true; }
  if (element.id === 'swap') glyph = true;
  if (element.getAttribute('aria-busy') === 'true') command = 'refresh';
  const label = element.textContent?.trim() || '';
  const icon = command && isActionIcon(command) ? command : iconForAction(label);
  if (!icon) return;
  const previous = element.querySelector(':scope > .action-icon');
  if (previous && element.dataset.renderedIcon === icon) return;
  previous?.remove();
  if (glyph) {
    if (!element.getAttribute('aria-label')) element.setAttribute('aria-label', element.title || label);
    element.replaceChildren(); element.classList.add('action-glyph');
  }
  // Only static map output enters HTML. All labels remain existing text nodes.
  element.insertAdjacentHTML('afterbegin', actionIconSvg(icon));
  element.dataset.renderedIcon = icon;
  if (!element.title) element.title = element.getAttribute('aria-label') || label;
}
function scan(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('button, summary[data-action-icon]')) decorate(element);
}
scan(document);
const observer = new MutationObserver(records => {
  const parents = new Set<HTMLElement>();
  for (const record of records) {
    if (record.target instanceof HTMLElement) parents.add(record.target);
    for (const added of record.addedNodes) if (added instanceof HTMLElement) parents.add(added);
  }
  for (const parent of parents) {
    if (parent.matches('button, summary[data-action-icon]')) decorate(parent);
    scan(parent);
  }
});
observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-busy'] });
window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
