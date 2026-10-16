# Action icons and toolbar conventions

Implemented in 0.53.0 (B32). `src/ui/actionIcons.ts` owns original 16-pixel SVG paths and the shared semantic action mapping. Drawings use currentColor, carry no external resources, and are covered by this repository's MIT license. No dependency or third-party icon pack was added.

`webview/actionIcons.ts` decorates static action labels and explicit `data-action-icon`/`data-rich-command` controls. Dynamic content choices, comparison cells, selection triggers and field suggestions are excluded. The decorator preserves labels; explicit glyph controls retain their accessible name. Do not turn arbitrary item names into actions. Add new action labels or explicit keys to the shared mapping, rather than introducing panel-specific drawings. Do not accept SVG markup or paths from Sitecore or messages.

`src/ui/webviewActions.ts` installs the bundled stylesheet/runtime with each panel's existing CSP. It reuses the existing script nonce where required, adds only the shared-media/runtime resource roots and deduplicates those roots. Operation details remain script-free and use the same static SVG renderer. Native VS Code command and tree surfaces retain their existing ThemeIcon conventions.

## Coverage audit

| Surface | Treatment |
| --- | --- |
| Item editor | Save, Revert, outcome checks, locale action, field Clear/Add/Remove, information and General Link disclosure; picker navigation and removal glyphs; asset preview/check/open actions |
| Rich Text | Compact B/I/U, alignment, list/indent, quote/clear-formatting groups; heading selector; Link/Table group with labeled command menu; segmented HTML/Visual/Preview; separate Clear content |
| Browse/Compare | Browse/Compare, swap, language lock/fallback, cancel/retry/navigation and context-menu expand/collapse/refresh/details/edit/favorite/task/publish/copy/transfer actions |
| Item Details / Field Diff | Fallback, public-page actions, ID/path copy and directional field-transfer glyphs |
| Connection dashboard | Save/Add connection, reload/cancel, site add and connection/deployment/Edge tests; active test/save uses busy arrows |
| Publishing configuration/scope | Publish/queue, cancel, field add/remove and scan/retry actions |
| Operation details | Publish again, status checks, verification retries and repair actions receive static icons without scripts |
| Native trees, menus and command palette | Existing VS Code icons for play/pause/stop, refresh/retry, ordering, settings, trash and state indicators retained; text-only palette/context entries remain native platform controls |

Content choices, paragraph options, field visibility filters, section/tree disclosure triangles and drag handles retain their existing semantics rather than receiving decorative action icons. Labels remain visible except familiar formatting commands and previously glyph-only controls. A missing icon runtime leaves formatting text visible.

## Interaction requirements

- Preserve command payloads, enablement, reasons, guards, focus and draft/history behavior. Decorative SVGs ignore pointer input and are hidden from the accessibility tree.
- Keep icon-only actions named and tooltipped. Preserve pressed state separately from focus and disabled state. Busy arrows respect reduced motion; do not infer busy from disabled.
- Keep Rich Text groups together when wrapping. Table menus must stay within the viewport. Maintain native heading-select keys and Alt+Left/Right toolbar traversal, Left/Right/Home/End on buttons, and Up/Down/Escape in Table.
- Test dynamic label replacement and avoid duplicate icons. Inspect wide/narrow dark/light/forced-color layouts. Synthetic focus tests are not screen-reader or native IME acceptance.

Regression coverage: `test/unit/actionIcons.test.ts`, `test/integration/actionIconTests.ts`, the Rich Text production-frame and toolbar suites, and existing real provider/form tests. See [Rich Text acceptance](../research/richtext-implementation-acceptance.md) for scope and omissions.
