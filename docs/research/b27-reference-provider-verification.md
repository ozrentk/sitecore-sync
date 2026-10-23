# B27 reference provider verification — 2026-10-23

## Outcome

The exact plus `item.fields(withLanguageFallback: true)` strategy does **not** establish the effective reference graph for item-fallback cases. Do not implement an empty Authoring reference list as proof that the effective page has no references.

Read-only Dev checks used one existing component datasource with a versioned Multilist. The selected locale, item identity, complete diagnostic observations and original ordered IDs were retained in local ignored evidence. This report anonymizes content IDs and paths. No items were created, changed, published or deleted.

## Observations

| Read | Outer version | Ordered reference observation |
| --- | --- | --- |
| Authoring exact `en` | 1 | A, B, C, D |
| Authoring exact `en-AU` | 1 | A, E, C, D |
| Authoring field fallback `en-AU` | 1 | A, E, C, D |
| Authoring exact `en-NZ` | 0 | No local fields |
| Authoring field fallback `en-NZ` | 0 | 87 fields; the Multilist value is empty |
| CM Preview layout `en-NZ`, same datasource nested in the component output | Not source-version evidence | A, E, C, D |

All relevant diagnostic observations reported complete. The first paired AU collection ran 12:29:34–12:29:44 UTC; a repeat and the NZ collection retained independent timestamps in the local evidence. Reads are sequential observations, not a transactional snapshot. The Preview request returned a collected layout, 499,541 response bytes. Nested item identity was matched to the Authoring datasource before comparing the ordered reference IDs.

Configuration evidence showed item fallback enabled via Standard Values and language links NZ → AU → en. The Multilist definition's field-fallback settings were empty in the metadata locale. These facts explain why item fallback must be distinguished from field fallback; they do not prove source provenance for the Preview result. Equality with the AU list is an observation, not permission to label AU as the effective source or writable target.

## Code audit

- `AuthoringContentClient.loadItem` supports a field-fallback read, but its `strictIdentity` path intentionally forces exact reads for editor safety. Passing both flags would silently select exact semantics. Preserve editor behavior; any new read-only effective adapter needs a separate explicit contract.
- The publishing reference parser deduplicates list IDs and can omit malformed list fragments. It is unsuitable as-is for an occurrence tree that must retain order, duplicates and unresolved entries. Do not change publishing semantics incidentally.
- Current Components details inspect exact Authoring values. Their reference links remain exact inspection, not a verified effective recursive graph.

## Specific implementation gate

The proposed Authoring pair can retain useful evidence, but cannot supply the complete effective reference graph in this observed fallback case. Lazy reference-tree implementation is therefore deferred at the provider gate, not blocked by MCP access.

Next verify a Preview-backed read-only reference adapter: establish a bounded item lookup in the same site/locale context for on-demand expansion, distinguish actual item-reference output from arbitrary custom resolver JSON, and detect missing or incomplete coverage. A finite nested layout response alone cannot prove that an omitted child has no further references. Keep exact Authoring reads separately for Details and existing Edit eligibility. Do not infer a fallback edit source from Preview IDs, values or language labels.

Required tree behavior remains field-grouped relationships distinct from placeholders, ordered repeated occurrences, ancestor-path cycle detection, explicit missing/unknown/limit states, bounded per-load reads/cache, cancellation and stale-response rejection. None of that UI is enabled by this research-only change.

## Verification and scope

Live coverage: one versioned Multilist with locale-specific values, one item-fallback case, and its effective nested Preview output. Other field types, missing targets, cycles and lazy recursive completeness were not live-verified. Existing unit/integration tests do not establish these provider semantics. This change updates evidence and backlog only: no runtime change, version bump, VSIX rebuild or publication.


## Follow-up: direct Preview item checks — 2026-10-23

The authenticated Dev Preview IDE supports a bounded direct item lookup that **does return item-fallback reference values**. This resolves the specific empty-NZ-reference blocker for the tested sample. It does not validate arbitrary site-dependent resolvers or identify a writable fallback source.

Live introspection and read-only queries established:

- `Query.item(path: String, language: String!, version: String): Item` accepts the known item ID. It has **no site argument**. `layout` separately requires site, routePath and language.
- `Item.fields(ownFields: Boolean)` returns a list of typed fields without pagination arguments. Fields expose ID, name, raw value and definition metadata (type, section/order and scope). `MultilistField` exposes `count`, ordered `targetIds` and `targetItems`; `LookupField` exposes `targetId` and `targetItem`.
- The same datasource's direct `en` read returned A,B,C,D; direct `en-AU` and `en-NZ` returned A,E,C,D. The NZ result reported NZ/version 1, despite exact Authoring having no local version. This remains effective-read evidence, not stored-version or source-language proof.
- For the four-entry NZ list, `count`, raw-value order, `targetIds` and resolved target item IDs agreed. A separate lookup of the first target succeeded in NZ and exposed further typed fields, including a populated Image. No recursive crawl was performed.
- The full candidate query (identity, raw values, typed IDs and definition metadata) executed successfully. Default `fields` and explicit `ownFields:false` each returned 15 fields; `ownFields:true` returned only the directly defined Multilist. The other 14 included inherited content and selected system fields. Use explicit false. This is Preview-exposed field coverage, **not all 87 Authoring fields**; do not silently imply complete Authoring/template coverage.
- A zero-GUID lookup returned `item: null` without GraphQL errors. This is missing-item behavior for this probe, not proof that permission-denied items behave identically.
- A **single GraphQL operation** requesting the Grenadier NZ layout and the direct datasource field returned identical four-ID sequences. The rendered context identified the requested site and language; the nested item's ID matched the direct lookup. This avoids comparing two independently timed requests, but does not establish transactional snapshot guarantees or prove that `item` inherits the sibling layout's site context.
- Link fields expose `linkType`, `targetItem` and raw value. Image/File fields expose raw value and asset metadata but no typed target-item accessor in the inspected schema. Their live reference extraction was not verified; never treat the field's own ID as its referenced media ID.

Reusable schema-derived queries are in [b27PreviewReferences.graphql](../../test/research/b27PreviewReferences.graphql). The live browser queries used literal known IDs; the checked-in queries use variables and omit private IDs, paths and credentials. Browser results provide response evidence, not the MCP diagnostic's HTTP-attempt trace. No credentials were exported to the repository.

### Implementation boundary now supported

Use a dedicated read-only Preview item adapter for **standard stored reference fields**, with exact Authoring retained independently for Details and Edit. Anchor the root in the validated page layout; keep the selected connection/site/locale in cache keys even though the item query itself cannot select a site. Represent source locale as unknown. A layout/direct-item reference disagreement must remain unresolved, never be silently reconciled using an assumed fallback chain.

Fetch raw typed field values on explicit expansion, then resolve target labels individually with bounded concurrency. Prefer ordered raw IDs/`targetIds` to eager `targetItems`, which has no pagination argument and can hide missing target occurrences. Preserve duplicate and malformed raw occurrences; a target lookup returning null becomes an unavailable node, not a removed relationship. Proposed adapter limits remain 30 seconds / 2 MiB per response, with explicit field/node/depth/read limits and per-load cancellation before production integration.

This is sufficient evidence to begin that constrained adapter and lazy-tree implementation. It does **not** establish general site invariance, custom runtime resolver equivalence, permission behavior, duplicate/malformed reference handling, cycles, cancellation or large-graph behavior. Those require deterministic regression coverage; additional live samples can extend field coverage without modifying existing content. No new runtime or VSIX was produced by these checks.

### General Link read-only follow-up — 2026-10-23

Authenticated Dev Preview introspection confirms LinkField.linkType (String), targetItem (Item), and raw value (String). A navigation datasource with exact en-NZ Authoring version 0 and no fields returned Preview en-NZ version 1 with an internal link whose raw XML ID matched targetItem.id and the rendered-layout link ID. Its en read agreed; this does not establish fallback source provenance. A separate external link returned targetItem:null; empty links returned empty raw values and null type/target. No content was changed.

Production uses only this bounded ordinary-link identity contract. Synthetic regressions cover disagreement, malformed XML, missing targets, duplicate occurrences, cycles and non-item GUID-bearing destinations. Browser results do not provide HTTP-attempt provenance or prove site-dependent resolver equivalence. Image/File remain outside this verification.
