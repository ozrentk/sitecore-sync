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
