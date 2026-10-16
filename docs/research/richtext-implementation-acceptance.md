# Rich Text source and basic visual implementation acceptance

Reviewed 2026-10-16. This records local implementation evidence, not a GitHub release or blanket support for arbitrary HTML. Follow the [development guide](../development/rich-text-editor.md) and [user-facing support contract](../item-editor.md#rich-text-basic-visual-mode).

## Delivered scope

- **0.46.0:** HTML source editing, isolated read-only Preview, exact raw draft preservation, native host history and the existing Save/backup/conflict/journal path. Source editing does not require visual admission.
- **0.47.0:** custom Tiptap basic visual profile with paragraphs/headings, bold/italic/underline and hard breaks. Source-location checks reject parser repairs, lost tokens and duplicate attributes. Independent parsed-structure comparison fences initial projection; per-transaction admission and metadata inventories protect subsequent edits.
- Untouched modes retain the original string. Actual visual changes explicitly permit text-entity/newline canonicalization and requested formatting-wrapper changes. Styles, attributes, image/DAM markup and inter-block whitespace are preserved as inert data; CSS is displayed only in the isolated Preview.
- Unsupported structures remain HTML-editable with a persistent reason. No managed-link editing, identity reconciliation, lists/tables, visual media editing, formatted paste/drop, page editing or fallback-source writes are claimed.

## Automated and browser evidence

| Check | Result |
| --- | --- |
| Source-step unit suite | 432 passed |
| Source-step VS Code 1.100.0 integration suite | 110 passed on final run |
| Visual-step unit suite | 435 passed |
| Visual-step VS Code 1.100.0 integration suite | 111 passed on final run; no B31 exception enabled |
| Strict extension/test/browser-source checking | Passed through integration compilation and packaging |
| Real-keyboard isolated Edge checks | Typing, Enter/Backspace split/join, formatting/removal, single native-undo routing, plain/HTML paste policy, opaque metadata guards, freeze and empty content passed |
| Full-interface browser check | Mode switching, source updates, persistent admission reason and visual layout checked |
| Local VSIX installation | 0.46.0 and 0.47.0 installed and activated in isolated profiles; 0.47.0 also performed an edit using its packaged visual bundle |
| Package review and secret scan | Required browser/source assets and license notices present; source-only tooling excluded; pinned Gitleaks package scans passed |

The integration regressions exercise actual VS Code webviews, panel/revision-pinned freeze, raw backups, pending-input history and undo after Save, Visual disposal/recreation, host-history state replacement and opaque/paste rejection. The composition timing regression simulates the browser event order deterministically; it does not constitute real operating-system IME acceptance. The source step's blur/final-input ordering was also checked in headless Edge.

B31 failed in some intermediate full-suite runs and passed in later runs. Its General Link assertion was neither changed nor exempted. Successful final runs do not establish that its underlying intermittent defect is fixed.

No live Sitecore reads/writes, page changes or publication were needed. All committed fixtures are synthetic. Native IME, screen-reader, high-contrast and interactive desktop save acceptance remain outstanding. Broader content profiles require separate admission/operation evidence.

## Dependency review

The added locked closure has 20 packages, all MIT or BSD-2-Clause; [license texts are retained](../../THIRD_PARTY_NOTICES.md). `npm ls` confirms shared ProseMirror model/state/view installations rather than duplicate runtimes. Browser dependencies are locally bundled under `out/webview/`, without a CDN or paid service.

The npm production audit reported existing advisories for `fast-uri` 3.1.6 (high) and `qs` 6.15.3 (moderate), reached through the existing MCP SDK dependencies. Both exact versions were already present on `develop` before this work; no advisory was reported for the added visual-editor closure. These findings are recorded for a separate dependency/security follow-up, not silently fixed or declared irrelevant here. This is dependency advisory evidence, not an exploitability assessment.

## Nested-span increment (0.48.0)

The supplied finance HTML is retained in `test/fixtures/richTextSpans.ts`, including both spans, `theme-primary`, literal centered alignment, H6/H2 levels, entity spellings, spacing and the nonbreaking-space paragraph. Recursive inline nodes preserve spans rather than flattening them into marks. Protected inventories include all spans and their span ancestry. Literal single-declaration alignment on paragraphs/headings/spans is mapped to scoped bundled CSS; original classes/style text never enter trusted DOM.

- Full unit suite: **437 passed**; strict extension/test/webview type checks passed.
- Full VS Code 1.100.0 suite: **111 passed**, without a B31 exception. Regressions cover the exact fixture, typing in a span, nested formatting apply/remove, inherited-mark removal, plain paste, protected split/join, Visual/HTML switching, host undo/redo and a visual-export snapshot through Save, exact Undo after Save and backup restoration.
- Isolated Edge real-keyboard checks edited text inside both supplied spans and nested spans, applied/removed formatting across their boundaries, and verified split/join guards. Source classes/styles, heading levels and the blank paragraph survived; no external requests were observed. A screenshot was inspected for centered heading/body alignment and unaffected host chrome.
- Unit checks reject identity-bearing/duplicate-ID spans, excessive nesting and unsafe/combined alignment expressions. Unsupported content stays HTML-editable; no new table, link-destination, media or formatted-paste capability is claimed.

No dependencies changed beyond the extension version. No live Sitecore writes were performed. Operating-system IME, screen-reader/high-contrast and live save acceptance remain outstanding. Successful runs do not close the independently intermittent B31 issue.

## Table increment — 3B (0.49.0)

Implemented the [bounded table profile](../item-editor.md#tables-0490) using custom Tiptap nodes and the already-locked MIT ProseMirror table commands. Explicit sections are independent grids inside a preserved table shell; export retains their original section tags, column definitions, caption, wrapper and metadata. Caption/cell text is editable. Structural commands have explicit metadata/content policies: no populated-cell deletion, mixed-header or multi-populated-cell merge, cross-section merge, metadata-bearing row/cell structure change, or column change across sections/colgroups. Unsupported input remains HTML-editable. No managed-link or broader styled-container/media increment is included.

- **445 unit tests passed**, including exact rich-table round trips, invalid grids/IDs/spans, row/column insertion/deletion, guarded merge/split, caption creation, header conflicts and rowspan splitting. Strict extension/test/webview checks passed.
- **111 VS Code 1.100.0 integration tests passed**, without a B31 exception. The actual editor webview exercises caption/cell typing, commands, multi-cell selection, metadata refusal, HTML/Visual switches, plain/rejected formatted paste and host state restoration. The provider Save/backup fixture now includes a table alongside the span fixture, with mocked writes, revision-pinned freeze, composition refusal, Undo after Save and exact restored drafts.
- Isolated Edge used real keyboard typing and mouse dragging to select cells. Caption/cell edits, row/column insertion, merge/split, history routing and freeze passed. Enter in an originally inline cell is rejected; Shift+Enter retains an explicit break. An early review identified the potential loss of split inline-cell block boundaries; the exporter now refuses that representation. No external requests were observed, and the table screenshot was visually inspected.
- The local 0.49.0 VSIX was installed in a disposable VS Code profile. Activation, registered commands and actual merge/split/row insertion through the **installed** browser bundle passed. Packaged assets/notices were present, source-only tooling was excluded and the pinned package secret scan passed.

All fixtures are synthetic. No live Sitecore reads, writes, publishing, remote pushes or release tags were required. Native OS IME, screen-reader/high-contrast, site-specific table samples and live save acceptance remain unverified. This bounded acceptance does not establish arbitrary table/CSS fidelity or fix the independently intermittent B31 issue. No new dependencies or licensing terms were introduced.

## Missing table creation correction (0.49.1)

The 0.49.0 controls operated only on existing tables; there was no creation action. Added **Insert table (2 × 2)** after the current top-level block with a first-cell text selection. Existing content is preserved, nonempty selections are refused, and insertion from a cell creates a sibling table rather than a nested one. Existing-table errors now point to the creation action.

Verification: **447 unit tests and 111 integration tests passed**, including insertion in empty documents, protected-paragraph preservation, nested-table prevention, the visible toolbar click, immediate first-cell typing, subsequent row insertion, exact mode switches and host undo/redo state restoration. Isolated Edge mouse/keyboard checks exercised the actual menu and buttons and the screenshot was inspected. No live Sitecore writes were performed; the existing native IME/accessibility/live-save gaps remain.

## Managed links — 3C (0.50.0)

Implemented the bounded [link profile](../item-editor.md#links-0500): recursive inert anchors, create/edit/remove controls, content-root target picking, atomic supported href/mirror reconciliation, preserved nested formatting and pre-save validation of new internal targets. Custom/conflicting/DAM/image variants retain HTML access instead of guessed destination changes. The actual read-only Dev sample used the documented ID-based URI without additional identity attributes; all committed fixtures are synthetic. No live writes or publishing occurred.

- Full unit suite: **453 passed**. After the final URL-profile tightening, **21 focused link/editor model tests passed**. Strict extension/test/webview type checks passed.
- First integration run: **112 passed**. Final run with direct provider target-identity validation: **111 passed, 1 failed** at the existing B31 assertion `Destination focus must expand inline`. The Rich Text webview, content-root picker supersession/disposal and wrong-target validation, plus save/readback/backup/history tests passed. The remaining steps of the B31 test were not exercised on that run. No exception or rerun-to-green was used.
- Isolated Edge exercised actual keyboard selection and pointer-operated Link controls: URL creation, Sitecore target choice, internal retargeting, inert DOM, exact mode switches and removal. The extension-host webview additionally exercised nested formatting, identity removal on kind change, stale selection refusal and host history restoration. The provider save/backup fixture now includes a changed link alongside spans and a table.
- Pending link forms close on mode switch and Save freeze; picker disposal removes its temporary focus listener. Source-only and unknown link variants remain preserved rather than rewritten.

Per the user's decision, leave B31 for later and retain this work on `feature/richtext-managed-links`, without merging to develop or publishing a release. The local VSIX is for review; the final full suite is not green. Native OS IME, assistive technology and live Sitecore save acceptance remain unverified. No dependencies or licensing terms changed.

## B31 resolution and 3C integration (0.50.1)

The earlier deferred-merge decision was superseded by explicit user authorization to fix B31 and merge 3C. An isolated VS Code 1.100.0 probe reproduced `document.hasFocus() === false`, an active destination input and no focus/focusin event after programmatic focus. The test now establishes foreground focus before its unchanged expansion assertion, and also exercises background/foreground restoration. Production controls handle destination clicks and restored window focus. The obsolete release exception is removed from current CI/tests; published v0.45.0 history remains unchanged. This closes the specific focus defect without claiming unrelated native IME/accessibility or live-save acceptance.
Combined verification: 451 unit tests and all 112 extension-host tests passed, with no B31 exception. Isolated Edge pointer/keyboard checks passed for General Link expansion/chevron navigation and Rich Text URL creation, internal picking/retargeting and removal. Strict type checks passed.

## Bounded command completeness (0.51.0)

Implemented the [formatting/list/quote profile](../item-editor.md#formatting-commands-lists-and-quotes-0510): paragraph/H1–H6, B/I/U, literal alignment, bullets/numbers, list indent/outdent, quotes and plain-mark clearing. Active/mixed/disabled states and keyboard actions use guarded commands. No arbitrary CSS, media editing, formatted paste, page editing, fallback-source writes or publishing is included.

- Unit suite: **461 passed**, including independent expected HTML for list/quote import and edits, inline LI normalization, nested/attributed metadata refusal, mixed selections, no-op tokens and whitespace boundaries. Strict extension/test/webview type checks passed. The first sandboxed unit attempt could not complete loopback MCP tests; the complete run used the required local transport access.
- Extension-host suite: **112 passed**, without B31 exceptions. The actual toolbar tests cover lists, indentation, heading/alignment, quote removal, plain-mark clearing, active/disabled reasons, raw mode switches and host history. Pretty-printed paragraph wrapping remains editable afterward; opaque stylesheet/DAM image bytes survive structural edits and typing. Provider Save/readback/backup/undo coverage includes a list inside a quote alongside links, spans and tables. A duplicate variable in an added generated test script was corrected after a timeout; no assertion was removed or bypassed.
- Isolated Edge keyboard/pointer checks cover Ctrl+A, list creation, Tab/Shift+Tab, Enter/typing, headings/alignment, outdent, quote, clear formatting and exact HTML roundtrip. The harness waits for the observable asynchronous indentation update rather than asserting synchronously. Toolbar layout was visually inspected and selects use compact widths.
- A synthetic 100,700-character field took approximately **65 ms** to compute 20 uncached command statuses in the local browser measurement after text-compacted availability checks (previously approximately 776 ms). This is one local observation, not a cross-machine performance guarantee. Real commands still validate full text and the actual resulting document.

No new dependencies or license changes. No live Sitecore reads/writes were needed for this increment. Native OS IME, assistive-technology/high-contrast acceptance and live save acceptance remain unverified. Multi-paragraph list items, metadata-destructive operations, arbitrary mixed containers and broader styling/media remain HTML-only or separate work. Published release history is unchanged; 0.51.0 is a local installable update until separately authorized for publication.
