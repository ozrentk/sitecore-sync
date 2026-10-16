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
