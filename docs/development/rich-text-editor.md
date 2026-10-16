# Rich Text editor development guide for agents

Status: implementation guidance, reviewed 2026-10-16. **The 0.46.0 implementation adds HTML source editing; visual editing remains deferred.** The latest published release, 0.45.0, is read-only. Experiments demonstrate bounded feasibility, not production visual support or authorization to widen writes.

Read this document before changing Rich Text rendering, editing, serialization, mode switching or save integration. Follow repository `AGENTS.md` and the current user's scope. This guide does not authorize releases, remote pushes, Sitecore mutations or new features outside the assigned task.

## Start here

1. Read this guide, then the [latest custom-adapter evidence](../research/custom-richtext-compatibility-spike.md). Its matrix distinguishes verified behavior from unresolved work.
2. Check current source and [product requirements](../../PRODUCT_SPEC.md); do not infer shipped behavior from a research harness. The [item-editor guide](../item-editor.md) describes current user behavior.
3. Inspect Git status and create the appropriate Git Flow branch. Preserve unrelated changes.
4. Identify the exact content shapes and edit operations your change admits. State the fidelity policy and tests before widening support.
5. Reuse the ordinary item editor's draft, undo, backup, conflict, journal and save flow. Do not create a separate Rich Text mutation path.

## Architectural decision and evidence

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

The following remain unresolved: ambiguous ID joins and references, mixed-content wrappers/lists, repeated same-type marks, richer table sections/colgroups and commands, managed link target reconciliation, media editing, and production iframe/host integration. Images and stylesheet nodes were opaque in the spike; preservation is **not** proof of full visual editing.

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

- [Custom adapters and decision matrix](../research/custom-richtext-compatibility-spike.md) — latest matched editing evidence.
- [Direct ProseMirror experiment](../research/prosemirror-compatibility-spike.md) — earlier attribute traps and matched-schema control.
- [Initial Tiptap/CodeMirror experiment](../research/richtext-compatibility-spike.md) — stock behavior and source/draft integration findings.

This guide supplies development constraints, not a claim that planned functionality has shipped.
