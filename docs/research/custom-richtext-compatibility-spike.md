# Custom Rich Text editing compatibility

[Research index](README.md) · [Previous direct comparison](prosemirror-compatibility-spike.md)

2026-10-16. Research only. No production editor, Sitecore writes, version bump, VSIX, push or release.

## Decision

**Prefer Tiptap with custom extensions.** The meaningful structural gaps tested here can be closed equally in Tiptap and direct ProseMirror. No tested gap establishes that we need our own editing engine. This is a conditional implementation recommendation, not approval to enable unrestricted Rich Text writes.

The earlier experiments omitted schema support for stylesheets, wrappers, captions and nested spans. Those omissions were not library limits. This experiment builds that support and exercises actual editing, exports, paste and history. Tiptap uses real custom Node/Mark/Extension instances, with its public external-schema mechanism; custom commands and plugins implement the same behavior as the direct control.

**Some requirements cannot be satisfied by a DOM/schema serializer alone:** reconstructing original entity spelling, quote style, duplicate attributes or malformed source after parsing; showing script-dependent components with scripts prohibited; and retrieving external styles/assets with requests prohibited. Those are representation or policy conflicts, not reasons to switch libraries. Exact raw drafts, HTML editing, isolated previews and carefully scoped visual editing address them without pretending every fragment is fully visually editable.

## Reproduce

From the repository root, use the existing locked MIT dependencies:

```powershell
npm ci --prefix scripts/spikes/richtext --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/spikes/prosemirror --ignore-scripts --no-audit --no-fund
npm run test:custom --prefix scripts/spikes/prosemirror
```

Root esbuild/Playwright dependencies and installed Microsoft Edge are required. Set `SPIKE_BROWSER` to another installed Playwright Chromium channel. No browser is downloaded. The spike imports pinned Tiptap 3.32.0 and the direct ProseMirror package versions recorded in the previous report; no dependencies were added. Both prior dependency-closure MIT notice checks remain applicable and were rerun.

Optional `SPIKE_LIVE_FILE`: absolute path to a local JSON array of `{ "id": "local-label", "html": "..." }`. Actual content and generated evidence stay under ignored `.test-out/custom-richtext-spike/`. Do not commit them. The browser intercepts external requests as an additional test safeguard; CSP blocks the exercised resource requests before interception.

Files: `scripts/spikes/prosemirror/custom-browser.mjs` and `custom.test.mjs`. Three browser tests cover the matrix below, script-free preview isolation, and an opaque-origin editable frame. The old `npm test` remains the original characterization experiment; its assertions of old adapter failures are intentionally unchanged.

## Matched design

- One explicit inert HTML importer, typed schema, inert export serializer, command policy and paste adapter, used by both engines. Shared model/state/view dependencies prevent duplicate ProseMirror runtimes.
- Nested spans are inline **nodes with editable children**, rather than repeated marks. Unknown simple block/inline containers preserve tag and attributes in the model. The trusted surface renders safe approximations.
- A table shell holds an editable caption alongside the ProseMirror grid; export places the caption back inside the table. Overflow wrappers and stylesheet nodes remain separate model nodes. Initially inline cell contents export without an added paragraph; a genuinely split cell may need paragraphs.
- Stylesheet CSS/attributes are preserved in an opaque node. CSS text is edited in HTML, not through a visual CSS designer. Image/DAM nodes are also opaque placeholders; preserving them beside editable text does not constitute image editing.
- The exporter gives edited link href precedence over the old attribute bag. A post-transaction prototype ID policy retains the first occurrence and strips later node IDs, covering paragraph splits. It is not a complete identity policy.
- Inert export restores original style attributes with `setAttribute`: ordinary ProseMirror DOM serialization uses `style.cssText`, which can normalize/drop declarations. A fixture containing an unknown CSS property and a custom property survives an adjacent text edit.
- Tiptap explicitly supplies `tableRole` through `extendNodeSchema`. External-schema structural fields alone did not preserve this command metadata. This was an extension wiring fix, verified by a successful row-add command.
- The raw-draft controller is the previous design sketch, connected to transactions here. Entering Visual projects the current raw draft; switching without edits preserves its bytes. HTML-only edits never pass through export. Undo to the visual-entry document restores the exact entry string. This is not VS Code native-history/save integration.

## Evidence and classification

All listed operations were exercised in **both** engines, with matched outputs. Ten fixture families also compare input/output DOM trees independently of the model. That comparison ignores attribute order and explicitly selected whitespace-only indentation between blocks/table cells; it does not prove arbitrary CSS equivalence.

| Shape or operation | Observed result | Classification |
| --- | --- | --- |
| Stylesheet CSS and attributes | CSS text, media and custom attributes survive cell/text edits and export | Preserved opaque; HTML editing for CSS |
| Styles applied in isolation | Inline alignment, stylesheet color, descendant span rule work while typing and undoing in an opaque-origin frame; parent toolbar unchanged | Editable styled text for tested selectors; not universal website fidelity |
| Overflow wrapper, table caption, cell text | Wrapper/attributes and caption location preserved; caption/cell typing and row insertion work | Editable; caption DOM is an editing approximation |
| Initially inline table cells | No invented paragraph in export; colspan/scope and styles retained | Editable for tested simple grids |
| Unknown simple wrappers/attributes | Section/custom-card and span attributes survive inner text edits | Editable child content; custom-element behavior unsupported |
| Nested styled spans | Nesting and attribute maps survive keyboard typing, bold and parsed/event paste | Editable; cursor/formatting boundary coverage incomplete |
| Enter inside nested spans | Splits the paragraph and clones the span ancestry across the two blocks identically in both engines | Normalized structure reflecting an explicit edit; identity policy still needed |
| Pre/code | Language class, custom attributes, spaces/newline survive typing | Editable |
| Standalone and inline images | Standalone image stays standalone; src, DAM IDs, thumbnailsrc, dimensions and empty mediaid survive neighboring edits and paste | Preserved opaque; not visual media editing |
| Sitecore/media links | Original metadata retained; changing href exports the new href; undo/redo works | Editable text/href; a full reference picker and target-metadata reconciliation remain unimplemented |
| Paragraph split/join | Split retains one original ID and both classes; joining the split halves restores the expected paragraph | Editable for this policy/test |
| Joining distinct paragraph IDs | Second anchor is lost | **Lossy**; must block or explicitly reconcile before admission |
| Paste | Synthetic browser ClipboardEvent reaches the custom importer; same output as parsed-slice paste; rejected script paste leaves draft unchanged | Editable admitted shapes; OS clipboard/drop not tested |
| Visual/HTML switching | Original/HTML-edited bytes unchanged until an actual visual edit; current HTML is reprojected; local undo restores exact entry bytes | Exact raw preservation between edits |
| Entity spelling, quotes, comments, indentation | Raw draft preserved before edits; full visual export normalizes lexical details and drops comments | Normalized or lossy after visual edits; needs admission policy |
| Mixed-content lists/wrappers, repeated same-type marks, table sections/colgroups | Explicitly rejected by this importer | Unsupported here; not established engine limitations |
| Malformed HTML/duplicate attributes | Browser repairs/discards information before schema import | Lossy DOM projection; HTML-only unless source-token strategy added |

Tests use keyboard typing, programmatic selection, bold, split/join, href change, caption and cell edits, row insertion, paste events, undo/redo, and HTML draft changes followed by new visual edits. They do not test every toolbar command or every cross-boundary selection.

### Read-only sample evidence

MCP exposed Dev with mutations disabled. One fresh finance Rich Text value was read in en version 1. Four saved read-only samples from the earlier experiment were also reused; they are historical snapshots, not four newly verified server values.

Fresh finance plus saved finance, warranty table and partner article produced identical results across both engines. Their DOM trees match under the stated attribute-order/indentation policy; all differ lexically from original HTML. A text edit and undo restored exact raw input. The saved legal sample was rejected for nested strong marks. This conservative rejection is an importer omission: a recursive inline-node adapter could preserve that structure, but formatting/removal semantics need tests. Do not infer full-site coverage from these samples.

## Remaining gaps: cause and next action

Complexity is relative engineering effort, not a time estimate.

| Gap | Cause / fundamental? | Workaround and UX cost | Complexity / confidence |
| --- | --- | --- | --- |
| Exact lexical HTML after visual edits | DOM parser is many-to-one; impossible to reconstruct lost spelling from that DOM alone. Not impossible with retained source tokens | Preserve raw until edits; disclose normalization, or build token/AST mapping and patch only edited ranges. Comments may remain HTML-only | High to very high for token mapping; high confidence in limitation |
| Malformed markup, duplicate attributes | Browser repair precedes either editor | Raw-token admission scan and HTML-only editing; user fixes markup before Visual | Medium gate, very high lossless structural editing; high confidence |
| Mixed inline/block wrappers and lists | Current schema/importer restriction | Define node-specific models or transparent text-run wrappers with separate export; temporarily HTML-only | Medium–high; not fundamental, medium confidence until tested |
| Repeated strong/em/link marks | Same-type marks cannot describe arbitrary recursive nesting as a mark set | Recursive inline nodes as for spans, with explicit formatting commands; HTML-only meanwhile | Medium–high; feasible model, uncertain broad command UX |
| Table sections/colgroups, complex selections | Not implemented; table grid commands assume their own structure | Preserve shell/section metadata and map grid edits, or HTML-only tables beyond admitted profile | High; uncertain until merge/split/delete/paste cases tested |
| IDs on joins, paste, duplicated marks | Command semantics; two anchors cannot become one unambiguously | Block ambiguous merge or preserve an anchor node; require a policy for duplicate IDs, ID references and original duplicates | Medium–high; split case verified, general case open |
| Reference target changes | Generic href edit does not prove Sitecore ID metadata remains consistent with the new target | Dedicated atomic reference-edit command/picker; do not expose unrestricted href-only editing for managed references | Medium; existing preservation is not full editing |
| Unknown custom elements | Tag/attribute storage is feasible, component runtime/layout is not implemented | Edit children/attributes in HTML, safe generic visual container and preview; no claim of custom component WYSIWYG | High per family; script-dependent behavior conflicts with blocked scripts |
| Images/DAM metadata | Deliberately opaque in this spike | Local preview/picker/property form later, HTML editing now. No live asset preview under blocked requests | Medium–high; metadata preservation verified, editing unverified |
| Arbitrary CSS in editable surface | Isolation is feasible; CSS can still hide/reflow editor content, target helper DOM, animate or impair usability inside the frame | Parent toolbar/source-mode escape, bounded resources, trusted editing overrides or preview-only CSS. Website layout may differ | High hardening; tested simple CSS, no universal claim |
| External resources and scripts | Prohibited by the chosen policy | Keep references but show placeholders; trusted local resources if later explicitly designed | Cannot fully reproduce external behavior while forbidding it; high confidence |
| Native history, IME, accessibility, cross-platform editing | Integration work, not a schema fix | Shared host draft/history, accessible toolbar/frame navigation, selection/composition tests | High; not exercised here |

The semantic comparator itself is not an admission gate: it sees the browser-repaired DOM and ignores selected indentation. Whitespace can matter under CSS. A production gate must inventory original tokens and classify every change rather than assuming this test's normalization policy fits all fields.

## Isolation result and limits

Two separate prototypes were tested:

1. Script-free preview, empty sandbox permission set, resource-blocking CSP; stylesheet color and nested selector apply, source script has no effect, toolbar unaffected.
2. Editable iframe with **allow-scripts only**, no allow-same-origin, a nonce-authorized bundled editor script, inline styles permitted only inside the frame, and default-src none / base-uri none / form-action none. No source scripts are admitted. Both engines type/undo with source CSS applied. Parent DOM access fails and no exercised external request reaches the network interceptor.

This proves a bounded architectural option, not a secure production iframe integration. No parent/child message bridge, VS Code webview nesting, focus escape, selection synchronization, CSP bypass audit, CSS resource exhaustion, navigation matrix, screen-reader or IME validation was performed. Arbitrary CSS is never attached to the trusted outer editor in the tests. The table shell/caption and safe custom-element DOM differ from website DOM, so not every selector will produce website-identical rendering.

## Alternatives and implementation split

| Choice | Fidelity | Ownership / cost | Decision |
| --- | --- | --- | --- |
| Tiptap custom extensions | Same tested preservation as direct ProseMirror; underlying model constraints remain | Own schema, import/export, admission gate, command policies and host integration; retain extension/command APIs | **Preferred** |
| Direct ProseMirror | No demonstrated fidelity advantage with equivalent adapters | Also compose commands, plugin lifecycle, keymaps and UI integration ourselves | Reasonable API preference, not a data-loss remedy |
| Our own editor over contenteditable | Browser still normalizes parsing/DOM; editing can introduce browser-specific structure | Own document/selection model, composition, transactions, undo, tables, clipboard normalization, accessibility and browser differences | Not justified by these findings |
| Our own source-token-aware document layer | Could retain untouched source ranges more precisely | Complex mappings between source, DOM and edited model; must resolve ambiguous changes | Consider incrementally only if exact post-edit source becomes a firm requirement; can sit alongside Tiptap |

Next implementation should separate:

1. Exact draft/source-mode/native-history/save integration and raw-token/semantic admission gate.
2. Custom Tiptap schema plus tested commands, including join/identity and reference-metadata rules; reject unsupported operations, not only initial HTML.
3. Accessible trusted visual UI first, with optional isolated styling frame only after bridge/focus/CSP review. Keep source editing available outside the frame.
4. Media pickers, richer tables, recursive formatting and more content families as independently tested adapters.
5. Extension Development Host acceptance: switching, paste/drop, IME, keyboard/screen-reader navigation, freeze/save, backup/reload, undo after Save and failed-save recovery.

No full application tests or VSIX smoke test were needed for this isolated research change. The browser fixture suite, dependency license checks and repository type check were run. Production Rich Text remains read-only.

## Primary references

- [Tiptap custom Node API](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node): local parsing/rendering and schema extensions.
- [ProseMirror guide](https://prosemirror.net/docs/guide/): document schema/model architecture. The web fetch was unavailable during this follow-up; pinned installed source was inspected instead.
- [MDN iframe sandbox documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe): sandbox permission boundary.
- Pinned installed implementation: `@tiptap/core/src/schema/mergeSchemaSpec.ts`, `getSchemaByResolvedExtensions.ts`, and `prosemirror-commands/src/commands.ts`. Executable results, rather than differently configured defaults, support the decision.
