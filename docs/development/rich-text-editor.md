# Rich Text editor development guide for agents

Status: implementation guidance, reviewed 2026-10-17. **0.46.0 adds HTML source editing; 0.47.0 adds the guarded basic visual profile; 0.48.0 extends it to nested spans and safe alignment; 0.49.0 adds bounded table editing; 0.50.0 adds managed links; 0.51.0 adds bounded formatting/list/quote commands; 0.52.0 adds isolated styled editing; 0.53.0 adds the compact toolbar and shared action icons; 0.54.0 adds formatting, two toolbar rows and inline Find/Replace/native history controls.** The latest published release, 0.45.0, is read-only. Experiments demonstrate bounded feasibility, not authorization to widen the implemented visual profile.

Read this document before changing Rich Text rendering, editing, serialization, mode switching or save integration. Follow repository `AGENTS.md` and the current user's scope. This guide does not authorize releases, remote pushes, Sitecore mutations or new features outside the assigned task.

## Start here

1. Read this guide, then the [latest custom-adapter evidence](../research/custom-richtext-compatibility-spike.md). Its matrix distinguishes verified behavior from unresolved work.
2. Check current source and [product requirements](../../PRODUCT_SPEC.md); do not infer shipped behavior from a research harness. The [item-editor guide](../item-editor.md) describes current user behavior.
3. Inspect Git status and create the appropriate Git Flow branch. Preserve unrelated changes.
4. Identify the exact content shapes and edit operations your change admits. State the fidelity policy and tests before widening support.
5. Reuse the ordinary item editor's draft, undo, backup, conflict, journal and save flow. Do not create a separate Rich Text mutation path.

## Toolbar chrome (0.53.0)

Keep action drawings and semantic labels in `src/ui/actionIcons.ts`, the browser decorator in `webview/actionIcons.ts`, and asset injection in `src/ui/webviewActions.ts`. All SVG paths are original static data; never accept SVG from content. Do not decorate choice labels. Shared assets must inherit each panel's existing CSP and minimal local roots; script-free operation panels receive static SVG only. Preserve content text and accessible names when replacing an existing glyph.

The Rich Text grouped toolbar remains outside the opaque frame. Command status/reasons and execution still come from the guarded editor, not from icon state. Keep direct alignment pressed states, native select behavior, keyboard traversal, explicit Clear content vs Clear formatting, narrow layouts and unclipped menus covered by production UI tests. Icons must fail to visible text for formatting controls if their bundle is unavailable. No icon redesign authorizes new commands or relaxed fidelity checks.

## Architectural decision and evidence

### Isolated styled Visual surface (0.52.0)

Production Visual uses `richTextFrame.ts` and a separately bundled `richTextFrameRuntime.ts` around the same guarded core. The opaque data frame has `allow-scripts` only, a nonce-authorized trusted bundle, nonce styles and a default-deny CSP. Its nonce matches the enclosing webview policy; never add `unsafe-inline`, `allow-same-origin`, remote scripts or source HTML interpolation. HTML, mode controls, status and formatting toolbar remain in the host. Preview is unchanged and script-free.

`richTextStyles.ts` projects supported CSS through decorations and nonce-authorized CSS layers (defaults, stored stylesheet, inline). It does not mutate model tokens or authoritative source. `richTextStylePolicy.ts` defines the bounded property/selector/numeric profile; see [user limits](../item-editor.md#rich-text-basic-visual-mode). Unsupported styling is retained but not displayed. CSSOM parsing is used only for the disposable display. Images remain opaque, and helper table/link DOM still limits website fidelity. This closes the bounded styled-editing portion of 3D, not media editing or arbitrary HTML/CSS support.

Authenticate child replies using exact `contentWindow`, opaque origin and a cryptographic session; validate bounded snapshots, selection/status/link payloads and monotonically increasing sequences. Requests have IDs, ordered execution, timeouts and disposal rejection. Host editor messages reject child sources and frame channels. Never accept a frame `state` as the extension's item state. Keep the frame inert until initialization is acknowledged; a rejected initialization may return original raw for HTML escape because it never enabled input. Once input is enabled, failed freeze acknowledgement must preserve the draft and fail closed rather than save a cached value.

Changed raw is sent immediately; selection-only updates may be frame-scheduled. Freeze snapshots flush the authoritative child draft before the host acknowledgement. Preserve the existing document revision/generation fence in `editor.js` and the provider; old disposed frames cannot update replacement fields. Link forms await replies and recheck active editor identity. Escape focuses the outer HTML control, Save routes to the ordinary host action and history routes to VS Code. Compute expensive table statuses only while the table menu is open.

Regression coverage includes actual production mode transitions, child/host message separation, rejected initialization escape, dispose during freeze, strict protocol parsing and bounded CSS. Browser checks must observe actual requests without an interceptor disguising CSP failures, inspect computed CSS, and exercise typing plus source fidelity. Keep explicit native IME, assistive-technology and live-save limitations until those checks are performed.

### Command completeness increment (0.51.0)

Read the [command profile and limits](../item-editor.md#formatting-commands-lists-and-quotes-0510). `richTextCommands.ts` constructs a single transaction and independently checks text, protected attributes and admission. The controller authorizes that exact transaction only. Paragraph/heading/alignment changes modify only the requested semantic tokens; other commands compare protected inventories. Do not replace these checks with a reusable guard bypass or merely compare two exports from the same adapter.

`richTextBlocks.ts` supplies custom lists, list items, quotes and synthetic inline `listText`. Retain original before/tail whitespace tokens and inline LI content without inventing paragraphs on import. Explicit lifting or block-type changes may promote inline LI text to a paragraph/heading. LI permits one text block followed by nested lists; do not widen it to mixed blocks without independent edit tests. Identity-bearing new families, multi-paragraph items and lists inside table cells remain HTML-only. Existing table/link policies still apply.

Only an explicit structural command may move whitespace-only opaque gaps into container tokens. The controller updates its retained opaque inventory after the accepted document change; ordinary subsequent edits must match that inventory exactly. Stylesheets and images are never exempted. Test pretty-printed paragraph wrapping followed by typing, not just initial serialization. Structural indentation may move; raw/no-op switching remains exact.

Availability uses cached editor-state results and a disposable text-compacted projection to avoid parsing large text repeatedly. It must never replace the real command document or authoritative draft: execution rechecks full text and admission. Test active/mixed states, disabled reasons, actual keyboard/pointer interactions and large fields. Clear formatting is plain B/I/U/strike/sub/sup only; arbitrary CSS, attributed mark loss and partial inherited-wrapper changes remain refused. Do not silently interpret Clear as deleting links or styles.

The new regression tests live in `test/unit/richTextCommands.test.ts`, the real Rich Text webview suite and the existing provider Save/backup fixture. Keep host history, freeze/composition, stale link sessions, exact locale and conflict protections intact. Broader styling/media (3D), formatted paste and native IME/accessibility/live-save acceptance remain separate work.

### Managed links — 3C (0.50.0)

Read the [link profile](../item-editor.md#links-0500). Anchors are recursive `richLink` inline nodes, rendered as inert spans without hrefs, raw attributes or navigation. `richTextLinks.ts` recognizes only the documented ID-based URI plus an optional already-matching `data-sc-id` mirror. A read-only Dev sample confirmed the URI without any mirror; mirror handling is a synthetic compatibility profile. The [archived Sitecore user guide](https://resources.doc.sitecore.com/en/legacy-docs/sitecore-experience-platform-8.0.pdf) documents the URI. Do not generalize these observations into support for arbitrary managed metadata, query parameters, DAM or media links.

Commands capture the exact document and selection. Refuse stale sessions and partial-container/image/link selections. Creating a link must independently compare all non-link protected metadata before authorizing the exact resulting transaction; generic edits retain the full metadata guard. Retargeting changes only the anchor token. Removal retains unrelated styling/title in a span, or unwraps children while refusing conflicting repeated marks. Never use a reusable guard bypass. Matching href/identity changes must be atomic, including intentional removal of the mirror when switching to an ordinary URL. Do not expose arbitrary raw attributes in trusted DOM.

Reuse the revision/request-pinned choice picker and SelectionIO. Rich Text Source is an HTML editor profile, not a selection root; the target root is explicitly `/sitecore/content`. Before Save, resolve newly introduced supported internal IDs on the pinned connection/locale and validate returned identities and paths. Do not revalidate unchanged references as a condition of unrelated text edits. Unknown profiles remain authoritative HTML and cannot be guessed into supported identities. Do not add automatic mutation retries or a second save path.

Tests cover token updates, nested formatting and selection boundaries, stale sessions, content-root requests, failed target validation before writes, actual toolbar/picker interaction, inert DOM, mode/history restoration and provider save/backup. No live content was changed. Native IME/accessibility and live save acceptance remain unverified; 3D broader styling/media is separate work.

### Table increment — 3B (0.49.0)

0.49.1 adds the missing Insert table entry. Create a bounded 2×2 table after the selected top-level block; never split its preserved wrappers, replace a nonempty selection or nest a table. Set a valid first-cell selection before returning the authorized transaction. Regression coverage must exercise the visible toolbar path, immediate typing and row commands—not just command calls on an already-existing table.

Read the [supported table profile and refusal policies](../item-editor.md#tables-0490) before changing table behavior. `webview/richTextTables.ts` defines locally bundled custom Tiptap nodes and the required `tableRole` metadata. A preserved table shell contains a caption, retained column definitions and separate ProseMirror grids for explicit sections; the exporter reconstructs the original single HTML table. It must never silently flatten section boundaries. Structural whitespace is retained as prefix/tail tokens. Synthetic `cellText` nodes export inline without invented paragraphs; refuse splits that would lose their block boundary.

`src/editor/richTextTableCommands.ts` preflights structural commands. Only the exact resulting transaction is authorized to alter table structure. All other transactions retain strict structure/metadata inventories. Structural authorization still checks nonstructural attributes and opaque content, re-admits the exported grid, rejects populated-cell loss/reordering and refuses metadata-bearing cell/row edits. Do not replace this with a reusable boolean bypass or accept unvalidated transaction metadata. Native host history still owns Undo/Redo; no ProseMirror history plugin is added. Cell selections are retained across host rerenders when valid.

The table identity policy is retention, not reconciliation: table-family IDs are allowed only if nonempty and unique, stay out of trusted DOM, and prevent structural edits to their rows/cells. There is no generic clone/deduplicate-ID policy. Column definitions are preserved and structurally protected; changing them or changing columns across sections is HTML-only. Table structural operations may change indentation and span-token spelling, but ordinary no-op mode switching remains raw-exact.

Regression fixtures are synthetic in `test/fixtures/richTextTables.ts`. Test real cell/caption typing, table command metadata, populated/empty deletion, header conflicts, span split, multi-cell selections, paste, host history, mode switching and provider Save/backup. Assert independent expected HTML rather than merely comparing two uses of the same adapter. The earlier research table support is not a substitute for these production policies. 3C managed links and 3D broader styling/media are not implemented by this increment.

### Nested-span increment (0.48.0)

Spans are recursive inline nodes, never flattened into a single mark. Import retains exact opening/closing tokens and nested children; export preserves that hierarchy. Every span, even one without attributes, participates in the protected inventory together with its span ancestry. Commands that duplicate, remove or reparent protected wrappers are rejected. Existing identity/managed-reference guards still apply, including IDs on spans. Direct repeated same-type marks and unsupported container structures remain gated.

`safeTextAlignment` recognizes only a single literal `text-align` declaration with an enum value. Rendering emits a validated `data-rt-align` value, mapped by bundled CSS selectors scoped under `.richtext-visual`. It never copies original `style` or `class` into trusted DOM. Combined declarations, comments, CSS variables/functions and `!important` remain unprojected; their exact original attributes survive export. A website class such as `theme-primary` is preserved data, not an appearance promise or an instruction to load external CSS.

The supplied regression fixture is `test/fixtures/richTextSpans.ts`. Exercise both spans, nesting, formatting apply/remove across boundaries, protected split/join, plain/rejected formatted paste, exact entry restoration, Save/backup and mode switches when extending this profile. Entity spellings and raw line endings are distinct from parsed text/spacing; unchanged entry raw stays exact, while actual visual edits retain the previously documented lexical-normalization policy.

### Basic visual foundation (0.47.0)

The original 0.47.0 Tiptap profile admitted explicit paragraphs/headings, bold/italic/underline and hard breaks. `src/editor/richTextAdmission.ts` uses parse5 source locations/errors to reject missing tokens, implied repairs and duplicate attributes before projection. `webview/richTextVisual.ts` compares the normalized model export with an independent parsed source structure before enabling editing. Original attribute tokens are retained. Every changed transaction is re-admitted, with ordered opaque-fragment and attributed-element inventories preventing silent loss. Unknown markup, comments, managed identities/links, directly repeated marks, lists and tables stay HTML-only; nested spans are covered by the 0.48.0 increment above. Do not widen support just because the research schema supports more shapes.

Raw HTML remains authoritative. Untouched entry/exit and host undo preserve its exact string; actual visual changes explicitly permit entity/text-newline canonicalization and requested formatting-wrapper changes. CSS and images remain inert data in the trusted visual surface; original CSS is never applied to host chrome. Use the separate isolated Preview for styling. Formatted paste and drag/drop are refused; plain-text insertion goes through the same transaction guard. No visual ProseMirror history plug-in is installed: history belongs to VS Code.

Tiptap/PM 3.32.0 and parse5 7.3.0 are pinned. The 20-package locked closure uses MIT/BSD-2-Clause licenses; see [retained notices](../../THIRD_PARTY_NOTICES.md). Only bundled browser code is loaded. Dependency changes require renewed lockfile/license and duplicate-runtime checks. Test compile with `npm run check:webview` as part of `npm run check`.

**Use Tiptap with custom nodes, marks, extensions and commands as the preferred implementation direction.** Direct ProseMirror provided no preservation advantage when configured equivalently. Revisit this choice only with a concrete unmet requirement and a matched test, not because stock extensions omit HTML features.

The latest spike proved these capabilities in both engines:

- Nested styled span structure survives typing, bold formatting and paste.
- Overflow wrappers, table captions and attributes survive caption/cell edits and row insertion.
- Pre/code language classes, whitespace and custom attributes survive text edits.
- Simple unknown containers retain tags/attributes while their child text is edited.
- Stylesheet CSS/attributes and image/DAM metadata can be preserved separately from active editor DOM.
- Changed href values can override preserved originals; a paragraph split can retain one original ID.
- An opaque-origin editable iframe can apply tested inline/embedded CSS while accepting typing and undo, without styling the parent toolbar or making the exercised external requests.
- Untouched mode switches and HTML-only edits preserve raw source; undo to a visual-entry baseline can restore its exact bytes.

These are bounded results, not blanket support. The old spikes intentionally characterize failures of earlier configurations. Their failing behaviors must not be presented as unavoidable library limitations.

The following remain unresolved: ambiguous ID joins and references, mixed-content wrappers/lists, repeated same-type marks, table structural edits beyond the bounded 0.49.0 profile, arbitrary managed-link variants, media editing, and production iframe/host integration. Images and stylesheet nodes were opaque in the spike; preservation is **not** proof of full visual editing.

## Non-negotiable draft and fidelity rules

1. **Raw HTML is the authoritative draft.** Keep the server baseline, current raw draft, visual-entry raw string and visual-entry model snapshot distinct. Tiptap JSON is a disposable projection, not the persisted source of truth.
2. Do not serialize into the draft on initialization, selection, focus, layout, programmatic projection or an unchanged Visual/HTML switch. Opening an empty field must not invent `<p></p>`.
3. HTML-mode edits update the raw string directly. Saving, freezing, backup and switching modes must never route HTML-only edits through the visual serializer.
4. Reparse the **current** raw draft on entry to Visual. Never edit a stale projection after HTML changes.
5. Only a real, admitted visual document change may replace raw HTML with serialized output. Undo back to the visual-entry document restores the exact entry string, not a normalized serialization.
6. Preserve whitespace and newline forms in raw edits, including mixed CRLF/LF and lone CR. A source widget's default newline normalization is not acceptable merely because its displayed text looks equivalent.
7. Distinguish lexical fidelity (comments, quoting, entity spelling, whitespace, attribute order) from DOM structure/attributes and rendered appearance. Do not promise one based on another.
8. Browser parsing loses some source information before either editor sees it: duplicate attributes, malformed nesting and entity spellings cannot be reconstructed from the DOM alone. Preserve original source or use a deliberate token-aware mapping; otherwise keep such content HTML-only.
9. Do not silently drop, flatten, rewrite or repair unclassified content on save. A permitted normalization needs an explicit rule and regression test; potentially meaningful changes require HTML-only fallback or a deliberate user action.
10. Rendering restrictions must not silently sanitize the authoritative draft. Safe editor DOM and inert export are separate concerns. Preserve raw content while refusing unsupported visual operations.

## Admission and support classification

Build a compatibility gate before enabling visual writes. Inventory original tokens as well as parsed structure; a DOM-only comparison cannot detect everything the browser discarded. Compare input with the proposed representation and classify every difference. Tiptap content checking and equal model JSON are useful checks, not complete loss detectors.

Use these labels in tests and documentation:

| Classification | Meaning |
| --- | --- |
| Editable | Declared content and operations preserve the promised semantics through edits/export |
| Preserved opaque with HTML editing | Bytes/metadata retained, but this fragment lacks meaningful visual editing |
| Normalized | An identified, accepted representation change; specify exactly what changes |
| Unsupported | Visual admission or operation refused; raw draft remains editable through HTML |
| Lossy | Meaningful content/metadata disappears or changes unexpectedly; do not admit this path |

Gate initial content, HTML-to-Visual transitions, paste/drop and operations that can change structure. Unsupported input must leave the draft recoverable and explain the reason. A rejected paste must not partially apply. Do not implement a whole-field fallback by clearing its draft.

The spike comparator ignores selected indentation and attribute order. **Do not copy it as a production gate.** Whitespace and changed helper DOM can affect CSS; model equality does not establish website-identical rendering.

## Schema, command and serialization rules

| Area | Required development rule |
| --- | --- |
| Attributes | Preserve untouched metadata, but explicitly edited semantic values must win over stale original bags. Test clearing/removal as well as replacement. |
| Styles | Preserve original CSS text and style attributes in inert export. The spike found `style.cssText` can normalize/drop declarations; storing attributes alone is insufficient. Never apply raw styles to host chrome. |
| Nested spans/marks | Repeated same-type marks do not describe arbitrary nesting. Use recursive nodes or another tested representation; verify cursor movement, formatting removal, Enter/Backspace and cross-boundary selections. |
| Tables | Preserve wrappers, caption location, section metadata, dimensions, scope and spans. Avoid invented paragraph wrappers in previously inline cells. Test structural commands, not only import/export. |
| Tiptap tables | When using an external schema, supply required plugin metadata such as `tableRole` through the extension API; prove commands work. |
| IDs | Define split, join, clone and paste policies for node/mark IDs and their references. Never silently deduplicate original content. The spike's retain-first-ID plugin is **not** a production policy. |
| Joining anchors | Joining paragraphs with distinct IDs lost the second ID in the spike. Block the ambiguous operation or explicitly preserve/reconcile anchors before admitting it. |
| Sitecore links | Change the target and associated identity metadata atomically. A correct href export does not prove `data-sc-id` or other stored reference data still identifies the target. |
| Images/DAM | Preserve standalone versus inline placement, URLs, IDs, dimensions, alt text, thumbnail/custom attributes and explicit empty values. Placeholder preservation is not media editing. |
| Unknown elements | Preserve admitted tag/attribute/child structure without executing custom behavior. Do not claim a generic container reproduces a custom component. |
| Pre/code | Preserve language classes and preformatted whitespace through typing, paste, formatting and export. |

Use locally bundled, permissively licensed open-source packages only; no paid extensions or services. Audit the actual locked dependency closure and notices when changing dependencies. Do not introduce duplicate ProseMirror runtime instances. The spike package versions are evidence, not a permanent mandate to retain those versions.

## Security and iframe boundaries

- Treat stored HTML/CSS, clipboard data and webview messages as untrusted.
- Keep arbitrary HTML, CSS, event handlers and resource URLs out of trusted webview chrome. Parse and export inertly. Validate all message payloads and preserve the existing CSP boundary.
- Keep the shipped read-only preview script-free with an opaque origin. Do not add scripts to it as a shortcut.
- If implementing a separate editable iframe, use an opaque origin with `allow-scripts` only for trusted bundled editor code; **never combine it with `allow-same-origin`**. Source scripts remain prohibited.
- Block external requests, navigation, forms and active embeds with a constrained renderer and CSP. Do not weaken outer-webview CSP to display stored styles.
- Prove the bridge's message source, payload schema, session/revision identity and cancellation behavior. An opaque frame's origin alone cannot authenticate its messages.
- Keep the toolbar and an accessible HTML-mode escape outside arbitrary source CSS. Bound size, depth, node count and resource use; do not truncate the authoritative source when limiting display.
- Test CSS imports, fonts/backgrounds, handlers, scripts, URL schemes, forms and navigation attempts. A test interceptor aborting a request is not proof CSP prevented it; distinguish the two.
- Blocked scripts/resources necessarily limit website fidelity. Our own editor would face the same constraint.

The editable-frame spike did not validate a VS Code message bridge, nested webview integration, full navigation/CSP defenses, accessibility or resource exhaustion. Its permissive frame-only inline-style setting is an experiment, not an approved production security design.

## Integration map and save invariants

Inspect these current locations before changing behavior; follow renamed symbols if the code moves:

| Location | Responsibility |
| --- | --- |
| `src/editor/itemEditorModel.ts` | `FieldDraft`, exact serialization, eligibility, changed-only `planChanges`, save/reconciliation logic |
| `src/editor/itemEditorProvider.ts` | Custom document, `recordEdit`, native undo/redo, backup, panel lifecycle, revision/freeze/save coordination |
| `media/itemEditor/editor.js` and `editor.css` | Field controls, message handling, focus, freeze/unfreeze, rendering |
| `media/itemEditor/htmlSource.js` | Raw source controller, normalized textarea projection, exact clipboard splicing, composition synchronization |
| `src/editor/richTextAdmission.ts` and `webview/richTextVisual.ts` | Token-aware basic-profile admission, inert custom schema/export, transaction guards and host history routing |
| `src/editor/richTextTableCommands.ts` and `webview/richTextTables.ts` | Bounded table command preflight, section grids, Tiptap table roles and metadata-preserving structure |
| `src/comparison/fieldDiffView.ts` and `media/fieldDiff/` | Read-only Item Details/Field Diff integration; do not accidentally enable writes here |
| `scripts/spikes/richtext/` and `scripts/spikes/prosemirror/` | Isolated research fixtures, not production adapters |

Retain exact-locale/version/fallback and system-field guards; shared/unversioned warnings; changed-only scope confirmation; conflict checks; journaled non-retried writes; numbered-version readback; and unknown-outcome reconciliation. Never automatically retry a Rich Text mutation.

Before Save, flush composition and pending edits, obtain a revision-pinned acknowledgement, and freeze both source and visual controls. Disabling ordinary buttons is insufficient. Preserve drafts on failure.

Integrate local editing history with VS Code custom-document history; do not run competing undo stacks. Test undo after Save, across modes and fields, failed saves, reload/backup and multiple panels. Destroy editor instances before replacing their DOM and restore valid selection/focus after host updates.

## Implementation order and acceptance

1. Retain the HTML source implementation's exact raw draft, host history, backup and freeze/save guarantees. Its raw string is separate from the textarea's LF projection; never replace it with `textarea.value` during Save. Source-only edits do not require visual admission and must never pass through a visual serializer.
2. Implement the raw-token/semantic admission gate and safe HTML-only fallback.
3. Add the custom Tiptap schema and command policies for a named content profile. Keep unsupported structures/operations gated.
4. Add isolated CSS editing, managed references, media controls and complex tables only with their own tests and security/accessibility review.
5. Enable production Rich Text writes only after full extension-host and focused user-flow acceptance. Do not expand publishing, page editing or fallback-source writes as a side effect.

Every supported family needs original HTML → import → actual edit → export tests. At minimum cover typing; split/join; formatting/removal; link changes; table commands; paste/drop; undo/redo; unchanged and edited Visual/HTML switches; and save/backup/recovery. Check empty, malformed, unknown, large and hostile inputs. Compare against independent expected structure/attributes, not just another editor using the same adapter.

Test identity conflicts, stale hrefs, duplicated IDs, nested spans, stylesheets, overflow wrappers/captions, language classes, inline/standalone images and Sitecore/DAM metadata as explicit regressions. Do not turn a characterization assertion of data loss into a passing support claim.

Use deterministic synthetic fixtures in committed tests. Sitecore reads need exposed authorized access; report fresh versus historical evidence separately. Keep real item content and credentials out of tracked files. Ask the user to start MCP when live verification is needed; continue independent tests when possible. Research access alone does not authorize mutations.

Research reproduction (from repository root, after root dependencies are installed):

```powershell
npm ci --prefix scripts/spikes/richtext --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/spikes/prosemirror --ignore-scripts --no-audit --no-fund
npm run test:custom --prefix scripts/spikes/prosemirror
```

This opt-in browser harness requires installed Edge or `SPIKE_BROWSER`. It is not a substitute for production unit tests, `npm run check`, extension-host tests, or manual keyboard/IME/screen-reader/high-contrast checks. Follow the repository verification matrix; do not run packaging concurrently with extension-host tests.

## Keep this guide current

On each Rich Text change, update the affected support classification, regression tests and this guide's unresolved decisions. Record which tests ran and which did not, plus any live-read limitations. Keep dated research reports historical and link newer evidence rather than rewriting old results as though they always passed.

Evidence:

- [Source/basic visual implementation acceptance](../research/richtext-implementation-acceptance.md) — production-profile tests and explicit remaining acceptance gaps.
- [Custom adapters and decision matrix](../research/custom-richtext-compatibility-spike.md) — latest matched editing evidence.
- [Direct ProseMirror experiment](../research/prosemirror-compatibility-spike.md) — earlier attribute traps and matched-schema control.
- [Initial Tiptap/CodeMirror experiment](../research/richtext-compatibility-spike.md) — stock behavior and source/draft integration findings.

This guide supplies development constraints, not a claim that planned functionality has shipped.


## Search and extended formatting rules (0.54.0)

Read the [user contract](../item-editor.md#formatting-findreplace-and-history-0540). `richTextMarks.ts` is the shared supported-mark registry. Rules require schema/admission/export/commands, not toolbar-only aliases. Keep imported attributes/tokens protected and sub/sup exclusion deliberate. Horizontal rules are top-level atoms; insertion requires a collapsed selection in a top-level paragraph/heading.

`richTextSearchInput.ts` owns bounded literal matching and bridge validation. `richTextSearch.ts` maps visible text to actual document positions without searching opaque content or joining blocks/breaks. All replacement plans are constructed on an immutable transaction; reject wrapper crossings and compare independent protected/opaque inventories before dispatch. Replace all must fail as a whole. Ordinary transaction guards still apply; search does not gain a guard bypass.

Highlights are transient ProseMirror decorations or an escaped textarea mirror. Never serialize them or treat a selection-only transaction as a draft change. HTML matching/replacement must use `source.read()` and raw offsets; convert offsets only for display. Keep `source.replace()` as the sole raw mutation boundary. Reuse the existing native history notification; do not add ProseMirror history. Frame operations stay authenticated, validated, ordered and lifetime-bound. The inline bar must recheck its field/editor lifetime after asynchronous replies; freeze blocks mutations. Preserve two distinct toolbar rows, keyboard behavior and focus on close.
