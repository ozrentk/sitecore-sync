/** Original, locally bundled 16px drawings. Never accept SVG or paths from content. */
export const actionPaths = {
  save: 'M2 2h10l2 2v10H2Z M5 2v4h6V2 M5 14V9h6v5',
  revert: 'M5 3 2 6l3 3 M2 6h7a4 4 0 0 1 0 8H6',
  preview: 'M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5Z M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  clear: 'M3 4h10 M6 2h4 M4 4l1 10h6l1-10 M7 7v4 M9 7v4',
  copy: 'M5 5h8v9H5Z M3 11H2V2h8v1',
  publish: 'M4 12H3a2 2 0 0 1-1-4 4 4 0 0 1 8-3 3 3 0 0 1 3 7h-1 M8 14V7 M5 10l3-3 3 3',
  play: 'M4 2l9 6-9 6Z', refresh: 'M13 6a5 5 0 0 0-9-2 M13 2v4H9 M3 10a5 5 0 0 0 9 2 M3 14v-4h4',
  cancel: 'M4 4l8 8 M12 4l-8 8', add: 'M8 2v12 M2 8h12', remove: 'M2 8h12',
  left: 'M13 8H3 M7 3 2 8l5 5', right: 'M3 8h10 M9 3l5 5-5 5',
  up: 'M8 13V3 M3 7l5-5 5 5', down: 'M8 3v10 M3 9l5 5 5-5',
  swap: 'M2 5h12l-3-3 M14 11H2l3 3', lock: 'M3 7h10v7H3Z M5 7V4a3 3 0 0 1 6 0v3',
  fallback: 'M3 3v6h10 M10 6l3 3-3 3', info: 'M8 7v5 M8 4v.2 M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0',
  edit: 'M3 10 11 2l3 3-8 8-4 1Z M9 4l3 3', favorite: 'm8 1 2 5 5 .5-4 3.5 1 5-4-2.5L4 15l1-5L1 6.5 5 6Z',
  expand: 'M3 5l5 6 5-6', collapse: 'M3 11l5-6 5 6', pause: 'M5 3v10 M11 3v10',
  bold: 'M4 2h5a3 3 0 0 1 0 6H4V2 M4 8h6a3 3 0 0 1 0 6H4V8',
  italic: 'M7 2h6 M3 14h6 M10 2 6 14', underline: 'M4 2v6a4 4 0 0 0 8 0V2 M2 14h12',
  bulletList: 'M2 4h.2 M2 8h.2 M2 12h.2 M6 4h8 M6 8h8 M6 12h8',
  orderedList: 'M1 2h1v4 M1 6h2 M1 10q2-2 2 0l-2 3h2 M6 4h8 M6 8h8 M6 12h8',
  indent: 'M2 2h12 M8 6h6 M8 10h6 M2 14h12 M2 5l3 3-3 3',
  outdent: 'M2 2h12 M8 6h6 M8 10h6 M2 14h12 M5 5 2 8l3 3',
  blockquote: 'M2 8h4v5H2V8c0-4 1-5 4-5 M10 8h4v5h-4V8c0-4 1-5 4-5',
  clearFormatting: 'M3 2h10 M8 2 5 13 M2 13h5 M10 9l4 5 M14 9l-4 5',
  alignLeft: 'M2 2h12 M2 6h8 M2 10h12 M2 14h8', alignCenter: 'M2 2h12 M4 6h8 M2 10h12 M4 14h8',
  alignRight: 'M2 2h12 M6 6h8 M2 10h12 M6 14h8', alignJustify: 'M2 2h12 M2 6h12 M2 10h12 M2 14h12',
  link: 'M6 10 10 6 M5 8 3 10a2 2 0 0 0 3 3l2-2 M8 5l2-2a2 2 0 0 1 3 3l-2 2',
  table: 'M2 2h12v12H2Z M2 6h12 M2 10h12 M6 2v12 M10 2v12',
  html: 'M5 3 1 8l4 5 M11 3l4 5-4 5', check: 'M2 8l4 4L14 3',
  strike: 'M12 3C10 1 4 1 4 5c0 4 8 2 8 6 0 4-6 4-9 2 M2 8h12',
  subscript: 'M2 3l6 8 M8 3l-6 8 M11 10h3v2l-3 2h3',
  superscript: 'M2 5l6 8 M8 5l-6 8 M11 1h3v2l-3 2h3',
  horizontalRule: 'M2 8h12',
  previousMatch: 'M11 3 6 8l5 5', nextMatch: 'M5 3l5 5-5 5',
  find: 'M10 10l4 4 M11 6a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  replace: 'M2 4h10l-3-3 M12 4l-3 3 M14 12H4l3 3 M4 12l3-3',
  undo: 'M6 3 2 7l4 4 M2 7h7a4 4 0 0 1 4 4v2',
  redo: 'M10 3l4 4-4 4 M14 7H7a4 4 0 0 0-4 4v2',
} as const;
export type ActionIcon = keyof typeof actionPaths;
export function isActionIcon(value: string): value is ActionIcon { return Object.hasOwn(actionPaths, value); }
export function actionIconSvg(icon: ActionIcon): string {
  return `<svg class="action-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="${actionPaths[icon]}"/></svg>`;
}
/** Exact UI labels only; content choices must never be passed to this mapping. */
export function iconForAction(label: string): ActionIcon | undefined {
  const normalized = label.replace(/[…]|\.{3}/g, '').trim().toLowerCase();
  const groups: [ActionIcon, string[]][] = [
    ['save', ['save', 'save connection', 'save changes', 'add connection']], ['revert', ['revert']],
    ['preview', ['preview', 'load preview', 'open public page', 'open left page', 'open right page', 'browse', 'open asset', 'resolve media reference', 'check file reference']],
    ['clear', ['clear', 'clear content']], ['cancel', ['cancel', 'cancel test', 'cancel expand all', 'cancel loading', 'close']],
    ['refresh', ['retry', 'retry scan', 'refresh', 'refresh item', 'refresh subtree', 'reload saved values', 'check save outcome', 'recheck status', 'check status again', 'retry browser dom', 'retry final edge verification', 'retry application response', 'retry failed verification']],
    ['play', ['test connection', 'test monitoring & match environment', 'test edge token & site scope', 'run task', 'scan', 'continue scan', 'resume']],
    ['publish', ['publish', 'standard publish', 'traced publish', 'power publish', 'queue standard publish', 'queue traced publish', 'queue power publish', 'publish again', 'force republish missing items']],
    ['copy', ['copy item id', 'copy item path', 'copy']], ['add', ['add', 'add site', 'add field', 'add pair', 'add row', 'add items']], ['remove', ['remove']],
    ['info', ['show item details', 'show detailed field diff']], ['edit', ['edit', 'visual']], ['swap', ['compare', 'open existing locale/version']], ['html', ['html']],
    ['favorite', ['add to favorites']], ['expand', ['expand item', 'expand loaded items', 'expand all', 'load more', 'show all fields']], ['collapse', ['collapse item']],
    ['right', ['tree transfer left > right']], ['left', ['tree transfer right > left']],
    ['lock', ['lock languages']], ['fallback', ['fallback']], ['link', ['link', 'apply link', 'remove link']],
    ['pause', ['pause']], ['table', ['table']],
  ];
  return groups.find(([, labels]) => labels.includes(normalized))?.[0];
}
