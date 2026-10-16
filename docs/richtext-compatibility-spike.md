# Rich Text editing compatibility spike

2026-10-16. Evaluation only; no Rich Text editing has been enabled, no Sitecore content was changed, and no release was produced.

## Recommendation

**Conditional go: Tiptap for a deliberately limited visual editor, CodeMirror 6 for HTML source. No-go: transparent round-tripping of arbitrary Sitecore HTML through stock Tiptap.** Implement both views over one exact HTML draft, with explicit HTML-only fallback. Do not treat a successful Tiptap parse, or absence of `contentError`, as proof of preservation.

The visual schema needs adapters and a conservative compatibility gate before it can admit existing content. The currently examined finance and warranty-table examples must initially remain HTML-only. Our sandboxed read-only preview remains useful for those fields. It supports CSS that the editable schema does not preserve.

## Reproduction and boundaries

The isolated harness is in `scripts/spikes/richtext/`. It uses Node's test runner and the repository's existing esbuild and Playwright tooling, with its own pinned npm lockfile. No production dependencies, build entry points, commands, or extension version changed. `scripts/**` is already excluded from the VSIX. This opt-in experiment is not a new production test layer and has not been added to CI.

From the repository root, with root dependencies installed using `npm ci`:

```powershell
npm ci --prefix scripts/spikes/richtext --ignore-scripts --no-audit --no-fund
npm test --prefix scripts/spikes/richtext
```

Requires installed Microsoft Edge (default) or another Playwright-supported installed Chromium channel selected with `SPIKE_BROWSER`. No browser download is performed. If the machine requires system certificate trust, use its normal Node trust configuration; do not disable certificate verification.

Optional: set `SPIKE_LIVE_FILE` to a local JSON array of `{ "id": "local-label", "html": "..." }`. Do not commit real content or identifiers. Reports, bundle and dependency-license inventory are written beneath ignored `.test-out/richtext-spike/`; live inputs/outputs contain content and remain local. All fixture asset requests are intercepted and aborted. No fixture URL is contacted.

Executed five passing tests: browser round-trips, dependency-license inventory, and three executable draft-design checks. The browser experiment ran 14 synthetic fixtures plus four read-only live Dev fields. The draft checks are a design sketch, **not tests of a completed extension integration**. No extension-host suite or VSIX installation was needed: the application was not changed. No screen-reader, IME, full toolbar, paste, drag/drop, large-document, or cross-platform acceptance testing was performed.

## Candidates and license evidence

| Candidate | Pinned version | Result |
| --- | --- | --- |
| `@tiptap/core`, `@tiptap/starter-kit` | 3.32.0 | MIT; vanilla JS, no React required |
| `@tiptap/extension-table`, `extension-image`, `extension-text-align`, `extension-text-style` | 3.32.0 | MIT; examined to measure compatibility, not all recommended for initial shipping |
| `@codemirror/state` | 6.7.6 | MIT |
| `@codemirror/view` | 6.43.14 | MIT |
| `@codemirror/lang-html` | 6.4.12 | MIT; also brings CSS/JS language support |

All 64 resolved packages in the isolated lockfile declare MIT and include a file containing the MIT permission notice. ProseMirror, Lezer, CodeMirror dependencies, `style-mod` and `linkifyjs` are included in that check. This is an inventory of these exact packages, not of every Tiptap product. No paid extensions, hosted services, collaboration, AI, conversion services or proprietary UI kits are used. Preserve bundled copyright/license notices in the eventual release and re-audit whenever dependencies change. The existing root esbuild/Playwright tools were not newly introduced by this spike.

## Observed HTML round-trips

Configuration: StarterKit with local undo/redo and trailing-node disabled, links not opened on click; TextAlign on paragraphs/headings; TextStyleKit; TableKit with resizing disabled; default Image. `enableContentCheck: true`. No custom preservation adapters. Results below are observed behavior for this configuration, not claims that Tiptap cannot be extended.

| Fixture | Concrete result after HTML → Tiptap → HTML |
| --- | --- |
| Basic heading/paragraph/strong | `<h2>Heading</h2><p>Hello <strong>world</strong>.</p>` survives byte-for-byte. |
| Lexical HTML | `<P class='x'> A &rsquo; B &#160; C\r\n D <b>bold</b><br /></P><!--keep-->` becomes `<p>A ’ B &nbsp; C D <strong>bold</strong><br></p>`. Class/comment lost; casing, entities, whitespace, tags and quote style normalized. No content error. |
| Centered finance structure | Heading/paragraph alignment survives with permissive CSP. `<span class="theme-primary">Intro</span>` becomes bare `Intro`. Span-level alignment disappears. Entities decode; newlines and trailing spaces normalize. Content checking reports invalid HTML. |
| Styles/custom attributes | TextAlign preserves paragraph alignment; TextStyleKit retains span color/background/font-family/font-size/line-height, normalizing hex colors to `rgb(...)`. Paragraph `id`, class, custom data and margin disappear. |
| Sized table + embedded CSS | Wrapper overflow, stylesheet, table class/width/height and cell width disappear. `<caption>Caption</caption>` becomes a new table row/cell. `scope="col"` disappears. Colspan survives. Serializer introduces `colgroup` and minimum widths. |
| Sitecore internal link | `~/link.aspx?_id=...&amp;_z=z` survives, as do class/title. `data-sc-id` disappears. Missing target becomes `_blank`; default rel becomes `noopener noreferrer nofollow`. **No content error.** |
| Media download link | `-/media/...ashx?la=en&amp;hash=abc` survives and explicit `_self` survives. `download="guide.pdf"` disappears; default rel is added. **No content error.** |
| Media image in paragraph | Src/alt/width/height survive; `mediaid` disappears. Default block Image splits `<p>Before<img ...>After</p>` into paragraph + image + paragraph. **No content error.** |
| Content Hub image | Public src/alt/width/height survive. `stylelabs-content-id`, `stylelabs-content-type`, `thumbnailsrc`, empty `mediaid` disappear. **No content error.** |
| Unknown wrappers/attributes | Section/custom-card wrappers and their attributes disappear; inner paragraphs/text survive. Unknown span data/ARIA attributes disappear. |
| Embedded CSS | `<style>...</style>` and paragraph class disappear. Styled text remains as a plain paragraph. |
| Lists/code | Ordered-list start survives; per-item `value` disappears; list item text gains paragraphs. Code language class and preformatted whitespace survive. |
| Empty | Empty string serializes to `<p></p>`. Must not manufacture a draft on initialization. |
| Malformed HTML | Browser/schema repairs block nesting and closes elements; duplicate attributes cannot be recovered from the parsed DOM. Requires raw-token-aware detection or HTML-only fallback. |

The content-check implementation in the pinned `@tiptap/core/src/helpers/createNodeFromContent.ts` uses a catch-all schema node for unrecognized elements. It is not a complete attribute-loss detector. Initial content-error handling can still build a reduced editor document; `setContent` with checking enabled can throw. Do not continue visual editing after either outcome.

### Live read-only evidence

MCP exposed Dev with mutations disabled. Examined exact `en` versions: finance intro v1 (the user's centered-content example), warranty table v2, legal terms v2, and partner article v3. Only Rich Text values were used in the local harness; no system-field metadata was exported to tracked files.

All four serialized differently and emitted content errors. Finance lost the theme span class and inline span alignment. Warranty lost its `<style>`, overflow wrapper, explicit dimensions and cell sizing; table cell text remained. Legal terms normalized entities/wrappers and added default link attributes where absent. The partner article normalized its white background color and text representation. This is a bounded sample, not an inventory of the site's Rich Text formats. Internal media/DAM/unknown-markup cases above are synthetic; they were not found and verified in these four live Rich Text fields. The DAM attribute shape also matches the earlier Image-field report, but an Image field is not itself a Rich Text sample.

## CSP, isolation and local bundling

The combined experiment bundles locally as an approximately 878 KB minified IIFE (877,515 bytes in this run), including both editors and the broad evaluation extension set. No CDN, `eval`, hosted API, worker, React runtime or network service was needed for basic typing. Production size must be remeasured with the final schema; this number includes experimental code and is not a packaged-size commitment.

Under the current webview-equivalent policy (`default-src 'none'`, nonce-authorized scripts/styles), both editors mounted and accepted keyboard typing. Tiptap's injected stylesheet accepts `injectNonce`; CodeMirror uses `EditorView.cspNonce`. The strict-policy image fixture made no routed external requests. However, **inline alignment vanished during HTML parsing under this policy**, even though it survived the permissive baseline. Do not loosen the whole webview to solve that. A follow-up must parse admitted styles through inert CSS declarations and explicit schema adapters, render approved formatting via trusted CSS/rules, and test the final policy in an actual VS Code webview.

Keep the existing script-free opaque-origin iframe for read-only preview. It cannot host an interactive Tiptap instance unchanged because it has no script permission. Initially place the controlled visual schema in the trusted editor webview, without inserting arbitrary stored HTML/CSS into its active DOM; keep arbitrary CSS visible only in the existing sandbox preview/HTML view. If richer visual fidelity requires a separate editing iframe, that is an additional `allow-scripts`-only architecture with a narrow validated message bridge, opaque origin, no navigation/network, and a separately proven CSP. Never combine script and same-origin permissions to bypass isolation. That iframe architecture was **not** implemented or validated by this spike.

Use inert parsing, resource-free image placeholders and non-navigable link views. A preservation adapter must store reference metadata in the document model separately from executable DOM attributes. Do not apply arbitrary classes/styles to the extension's controls. Recheck HTML pasted/dropped into the editor; initialization checks alone are insufficient.

## One draft, two views, existing save guarantees

The exact raw HTML string remains authoritative in `FieldDraft.input`; Tiptap JSON is a disposable projection, not persisted source of truth. Keep the original server bytes, current raw draft, visual-entry raw bytes and visual-entry document snapshot distinct.

1. Opening, parsing, selection changes and mode switches do not emit host `change` events or call serialization into the draft. Initialization and `setContent(..., { emitUpdate: false })` produced zero update events in this harness, but the controller must still distinguish user transactions from programmatic ones.
2. HTML changes update raw text directly. Never round-trip HTML-only edits through Tiptap, including on Save, freeze, backup or mode switch. Compatibility rejection leaves that raw draft intact and offers HTML mode plus preview.
3. Only a real, permitted visual document change serializes. If the document returns to its entry state, restore the exact entry HTML, not normalized serialization. Preserve original bytes through native undo, including undo after Save. Actual visual editing can normalize admitted lexical details; disclose this and reject structural/attribute loss rather than silently accepting it.
4. CodeMirror defaults normalize CRLF to LF. The experiment verified explicit CRLF configuration plus `sliceDoc()` retains uniform CRLF. Mixed newlines and lone CR require an exact raw-text change mapping; do not silently choose a single separator. Untouched source always returns original bytes. This needs tests before source editing is shippable.
5. `itemEditorModel.ts` must gain an explicit Rich Text kind and exact-string serialization while retaining all existing page/system/fallback/version/scope guards. Reuse changed-only `planChanges`, scope confirmation, conflict read, journal, non-retried write, numbered-version readback and unknown-outcome reconciliation. No separate save command or mutation pathway.
6. `editor.js` currently freezes inputs by scanning `[data-field-id]` and disabling ordinary controls. Rich editors require a canonical raw mirror, synchronous change delivery, composition flush, `setEditable(false)`/CodeMirror read-only state, and a revision-pinned acknowledgement before Save. Blocking buttons alone does not freeze a contenteditable surface.
7. The host `recordEdit`/backup machinery already stores raw drafts and native undo callbacks. Disable competing local histories or explicitly bridge them; existing document-level Ctrl/Cmd-Z handling would otherwise conflict with contenteditable editors. Coalesce typing without losing the latest acknowledged draft. Destroy editor instances before `root.replaceChildren()`; restore focus/selection after host undo/render. Test hidden panels, stale messages, failed saves, reload, and backup during composition.

The small `draft-experiment.mjs` demonstrates byte-preserving switches, HTML-only edits, backup, and baseline restoration. It is not a production controller and does not prove VS Code undo/save integration.

## Safe visual scope and fallback gate

Start with paragraphs/headings, plain text, strong/emphasis/underline/strike, breaks, basic lists, blockquote and code, then add paragraph/heading alignment through a tested adapter. Even these tags need attribute and nesting checks. Limit whitespace normalization to explicitly accepted cases; preserve pre/code text exactly. Site-specific span classes require a tested mark adapter; their CSS appearance is not available without a trusted theme definition.

Keep whole fields HTML-only initially when they contain unknown elements/attributes, comments that must survive, malformed/duplicate-attribute markup, arbitrary CSS/style blocks, wrappers with layout meaning, custom list numbering, tables/captions/widths, images/DAM metadata, or Sitecore/media/download links. Do not promise to preserve unknown fragments as opaque nodes in the first release: cursor movement, split/join, copy/paste and deletion can still destroy their boundaries.

Before visual editing: inventory raw tokens/attributes/styles, reject anything outside the declared schema, parse a projection, compare a structural/attribute/text fingerprint against the input, and classify every difference. Use `contentError` only as an additional rejection signal. A DOM-only comparison cannot detect duplicate attributes or discarded comments, and equal Tiptap JSON before/after proves only schema stability. Unknown or unclassified differences mean HTML-only. For an especially conservative first cut, require exact round-trip equality (apart from explicitly modeled empty content); this will reject much existing content but cannot silently approve a known serializer change. Re-run the gate after HTML edits and paste/drop. Show concrete reasons such as “table widths and embedded stylesheet are not supported in Visual mode.”

## Implementation split and remaining gates

1. Exact raw draft controller + source editor + current sandbox preview, shipped together with the eventual Visual/HTML feature rather than claiming full Rich Text support early. Implement newline-preserving transactions, native undo, freeze/save, backup and recovery tests first.
2. Tiptap minimal schema, trusted local CSS, formatting adapter for the strict CSP, keyboard-accessible toolbar/tabs and compatibility gate. Enable Visual only for admitted values; unsupported fields remain editable via HTML. Verify full end-to-end acceptance in an Extension Development Host before enabling writes.
3. Separate adapters for Sitecore links and media references/DAM metadata, then tables and site-specific class marks. Each needs preservation fixtures, clipboard tests, safe rendering and explicit gate expansion. Embedded arbitrary CSS remains preview/HTML-only unless a later isolated editing design is verified.

Accessibility: the experiment supplies labels/roles and verifies keyboard typing in both surfaces under CSP. It does not establish accessibility compliance. Production must provide roving toolbar focus, `aria-pressed`, labeled mode tabs, visible VS Code focus colors, an escape path from each editor, high-contrast themes, and keyboard-only operation. CodeMirror's theme API accepts VS Code CSS variables; Tiptap is headless and needs local styling. Screen-reader, IME, keyboard undo across fields/modes and large-document performance remain release gates.

## Primary references

- [Tiptap FAQ: schema-based HTML preservation limitations](https://tiptap.dev/docs/guides/faq)
- [Tiptap invalid-content checking and its HTML limitations](https://tiptap.dev/docs/guides/invalid-schema)
- [Tiptap Editor API: injection, content and lifecycle options](https://tiptap.dev/docs/editor/api/editor)
- [Tiptap Link defaults](https://tiptap.dev/docs/editor/extensions/marks/link)
- [Tiptap source license](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md)
- [CodeMirror project and MIT licensing](https://codemirror.net/)
- [CodeMirror API: CSP nonce, themes and state](https://codemirror.net/docs/ref/)

Documentation was checked alongside the pinned installed package source and executable experiments. Results above take precedence over assumptions from current online docs, which may describe a later release.
