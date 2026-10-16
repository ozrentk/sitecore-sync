# Direct ProseMirror compatibility spike

[Research index](README.md) · [User documentation](../README.md)

2026-10-16. Follow-up to [the Tiptap/CodeMirror spike](richtext-compatibility-spike.md). Research only: no production changes, Sitecore writes, release or VSIX.

## Decision

**Direct ProseMirror is viable, but switching to it does not solve arbitrary-HTML preservation.** The standard schemas lose much of the same content. Small custom adapters improve preservation substantially, but a matched Tiptap control using those same schema rules and export serializer produced **identical output in all 19 cases**. The improvement comes from owning the schema, not from bypassing Tiptap.

Recommendation: do not switch solely to fix data loss. Keep Tiptap as the current candidate with a custom Sitecore schema and exact-HTML draft controller. Direct ProseMirror remains a reasonable alternative if we prefer owning the command/keymap/plugin composition and minimizing framework dependencies. Either choice needs the same compatibility gate, HTML-only fallback, source editor, save/history integration and edit-operation tests. Neither is ready for unrestricted Rich Text writes.

The first spike was deliberately a stock-extension evaluation. Its conclusions about loss still stand for that configuration; they are **not** a hard ceiling on what a custom Tiptap schema can preserve.

## Experiment and reproduction

`scripts/spikes/prosemirror/` has an isolated package/lockfile and Node test runner. Reuses the previous 14 anonymized fixtures, adds a nested-span case, and optionally reads local samples via `SPIKE_LIVE_FILE`. Root esbuild/Playwright dependencies and an installed Edge are prerequisites, as in the earlier spike. Set `SPIKE_BROWSER` for another supported installed Chromium channel.

```powershell
npm ci --prefix scripts/spikes/prosemirror --ignore-scripts --no-audit --no-fund
npm test --prefix scripts/spikes/prosemirror
```

For the matched Tiptap control, also install the previous spike's locked dependencies:

```powershell
npm ci --prefix scripts/spikes/richtext --ignore-scripts --no-audit --no-fund
$env:SPIKE_TIPTAP_CONTROL = '1'
npm test --prefix scripts/spikes/prosemirror
Remove-Item Env:SPIKE_TIPTAP_CONTROL
```

Optional `SPIKE_LIVE_FILE` is an absolute path to a JSON array of `{ "id": "local-label", "html": "..." }`. Local evidence is written under ignored `.test-out/prosemirror-spike/`, with separate synthetic/live result files. Do not commit actual content. Asset requests are intercepted and aborted; no fixture endpoint is contacted.

Two passing tests cover the browser experiment and license inventory. With live input, the browser test evaluates 19 cases through standard and adapted direct schemas, then the optional matched Tiptap configuration. Additional assertions cover text edits, strict-CSP alignment, keyboard typing, undo/redo, clipboard-slice parsing, safe editing DOM, attribute-change and split failures. These are characterization tests: some intentionally assert a limitation so it cannot be mistaken for solved behavior. No full application test suite, VSIX build or Extension Development Host run: application code was unchanged.

## Versions and licenses

Direct dependencies: `prosemirror-model` 1.25.12, `state` 1.4.4, `view` 1.42.6, `schema-basic` 1.2.5, `schema-list` 1.5.1, `tables` 1.8.5, `commands` 1.7.2, `history` 1.5.1 and `keymap` 1.2.3. The complete direct-spike dependency closure contains 13 packages, all declaring MIT and shipping the MIT permission notice; checked by the test. Core model/state/view versions match those underneath the pinned Tiptap spike. The optional Tiptap control uses that prior spike's MIT-audited dependency closure.

The direct experimental browser bundle is 226,508 minified bytes. The earlier combined Tiptap + CodeMirror experiment was 877,515 bytes, **not an equivalent feature comparison**: this direct bundle has no source editor, TextStyleKit or comparable complete extension set/UI. Measure production choices with identical functionality before using size as a deciding factor. Both can bundle locally with existing esbuild; no CDN or hosted service is required.

## Three configurations

1. **Standard direct:** ProseMirror basic schema plus list and table schemas, default DOM parser/serializer. No claim that this is a complete rich editor.
2. **Adapted direct:** retain original attribute maps on recognized nodes/marks; add a styled-span mark; use a separate export serializer. The active editor renders safe semantic elements, non-navigable link spans and image placeholders. It never attaches source event handlers, URLs or arbitrary styles/classes. Paragraph/heading alignment is read from inert CSS declarations and rendered using a trusted `data-align` selector under a nonce stylesheet.
3. **Matched Tiptap:** same adapted schema structure, parsing/rendering rules and export serializer, registered through Tiptap 3.32.0's `schemaSpec` and local Node/Mark extensions. Does not use StarterKit defaults. Model/state/view module aliases prevent duplicate ProseMirror runtimes in this control. This is proof of configuration parity, not a finished Tiptap adapter library or test of every Tiptap command.

## Concrete findings

| Content | Standard direct | Adapted direct (and matched Tiptap) |
| --- | --- | --- |
| Basic heading/paragraph/strong | Exact round-trip | Exact round-trip |
| Centered finance structure | Drops alignment and span class | Keeps paragraph/heading alignment, `theme-primary` span and span alignment attributes; whitespace/entities still normalize |
| Inline/custom attributes | Drops classes, IDs, data attributes and most styles | Retains those on recognized nodes/marks; CSS strings may still normalize through browser/parser/DOM serialization |
| Internal Sitecore link | Keeps URL/title; loses extra metadata | Keeps URL/title/class/`data-sc-id`; does not invent `_blank` or default rel |
| Media download link | Loses target/download | Keeps `_self` and `download`; synthetic example round-trips exactly |
| Inline Media Library image | Keeps image inline (unlike earlier default Tiptap Image); drops dimensions/ID | Keeps dimensions/`mediaid` and surrounding paragraph; lexical self-closing syntax changes |
| Standalone DAM image | Drops DAM metadata; wraps inline image in a paragraph | Retains DAM IDs/type/thumbnail/empty mediaid, **but still wraps it in a paragraph** |
| Table dimensions | Drops widths/class/style | Keeps table/cell dimensions, class and header `scope`; still drops overflow wrapper and stylesheet; caption becomes a row |
| Unknown wrappers | Unwraps section/custom element | Still unwraps them; attributes on recognized spans survive |
| Embedded CSS | Drops style element | Still drops style element; retained class does not restore its appearance |
| Nested spans | Drops span structure | Flattens `<span class="outer">A<span class="inner">B</span>C</span>` into three sibling marked spans; descendant CSS semantics may change |
| Lists/code | Normalizes list structure, loses item value/code class | Keeps item value; code-block language class still lost; list children gain paragraphs |
| Empty / malformed / lexical | Empty becomes `<p></p>`; repairs invalid nesting; normalizes entities/comments/whitespace | Same fundamental changes; cannot recover duplicate attributes after browser parsing |

All four Dev samples were freshly read through MCP with mutations disabled: finance en v1, warranty table en v2, legal terms en v2, partner article en v3. No field was written. All four still serialize differently. Adapted finance retains the styled spans previously lost; adapted warranty retains table/cell sizing but loses its stylesheet and layout wrapper. Legal terms retain link attributes and recognized spans; the partner article retains its background style. Neither result proves exact lexical preservation or complete structural fidelity. Actual content/identifiers remain in local ignored evidence; media/DAM reference fixtures are synthetic, not claimed to have been observed in those four Rich Text fields.

### Attribute-preservation traps reproduced

Preserving an attribute bag is not a complete editor design:

- Starting with `<a href="/old">`, changing the model's href to `/new` still exports `/old` if original attributes override semantic attributes. Dedicated commands must reconcile changed attributes and retain only untouched ones.
- Splitting `<p id="anchor">AB</p>` after `A` creates two paragraphs both with `id="anchor"`. Splitting/joining requires explicit policies for IDs, classes, styles and other metadata.
- Nesting two marks of the same type flattens their structure. Preserving both attribute maps does not preserve the original nesting or CSS selectors.

The spike deliberately retains these failing semantics as passing characterization assertions. Do not reuse its schema/serializer in production. It is text-edit-focused research, not an arbitrary-attribute preservation library.

## CSP and editing behavior

Under the current webview-equivalent nonce CSP, adapted direct ProseMirror both preserves and displays centered text. The same adapted Tiptap control retains the same HTML under that policy. This resolves the first spike's alignment issue **at prototype level** by changing parsing/rendering, without allowing arbitrary inline styles in the outer webview. The centered CSS selector was tested; arbitrary source CSS is not applied to the editing surface.

Keyboard typing, local undo/redo and parsed paste slices were exercised in a browser. DAM metadata survived the parsed paste fixture; the active editor contained placeholders rather than remote images/live links. A hostile event-handler/background-image/JavaScript-link fixture did not execute or make routed external requests. ProseMirror inserts its own resource-free separator image for some selections; this is not a source asset.

These checks do not replace the eventual HTML admission gate. Original attributes in the model can include unsafe data, so export must never be inserted into the trusted webview. Keep arbitrary CSS in the existing script-free sandbox preview. Source rendering and editing commands need explicit policies. Both candidates require the same careful integration with the VS Code bridge: shared exact raw draft, revision checks, native history, backup, composition flush, freeze and save/conflict/readback. Direct local history tested here must not compete with host undo. The three raw-draft design tests from the previous spike still apply; this experiment does not enable either candidate in the application.

No screen-reader, IME, native clipboard, drag/drop, nested table commands, reference editing, source-editor integration, large-document or cross-platform acceptance was performed. The active surface renders safe approximations; retained classes/DAM metadata do not imply website-faithful display.

## Next step

The decision is now about maintenance and API preference, not a preservation advantage. Keep the proposed exact raw-draft/Visual–HTML architecture and build an explicit Sitecore compatibility layer. Before any release, cover the link-update, split-ID and nested-mark cases as well as unchanged-mode switches, byte-preserving HTML edits, undo after Save, malformed HTML and unsupported-field fallback. Tables, embedded CSS, unknown wrappers and media/reference editing remain gated until their own adapters are verified.

An initial visual schema can be useful, but an admitted document must satisfy a documented preservation policy. Raw byte equality should remain the conservative fallback when a semantic comparison cannot explain every change. No library choice removes that obligation.

Primary references: [ProseMirror schema/parsing guide](https://prosemirror.net/docs/guide/), [schema example](https://prosemirror.net/examples/schema/), [Tiptap external schema API](https://tiptap.dev/docs/editor/api/editor), and the installed pinned packages' source/license files. The matched-schema experiment, rather than a comparison of differently configured defaults, supports the recommendation above.
