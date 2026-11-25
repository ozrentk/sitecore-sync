# B27 authoring discovery spike

Date: 2026-10-19. Research only; no production tree, Sitecore writes, publishing or credentials collected. Open work is tracked only in [BACKLOG.md](../../BACKLOG.md).

## Decision

Do not build the page component tree from the existing publishing dependency extractor. It scans raw presentation attributes and deduplicates targets; it does not resolve layout patches, instance order, devices or placement. A shared/final union can retain a deleted datasource and lose repeated usages.

The next implementation prerequisite is a live, read-only **CM Preview layout provider verification**. Authoring remains the source for item/reference reads. CM Preview is a candidate for effective unpublished presentation; published Experience Edge is optional corroboration, never a replacement for draft content. No effective layout provider was established by this spike. Until one is verified, report effective layout as unresolved rather than manufacture a tree.

## Evidence and decision matrix

| Concern | Evidence | Decision / limit |
| --- | --- | --- |
| Shared/final presentation | QA and Dev exact reads contain inherited shared XML and final patch XML | Verified raw evidence; resolve patches server-side, never concatenate |
| Authoring effective layout API | QA introspection has no layout/resolved-layout operation on Query or Item | Verified for that schema only; catalogs of renderings/page designs are not instances |
| CM Preview | Official documentation describes CM `/sitecore/api/graph/edge` and `layout` | Documented candidate; credentials, schema, freshness, placement, parameters and device coverage not live verified |
| Instance UID/order | Raw XML has UIDs, repeated rendering definitions and ordering directives | Not proof of effective instance count/order; preserve occurrence identity |
| Placement | Dynamic placeholder keys observed | Never infer a parent solely from a key; show **Placement unresolved** with raw key |
| Locale fallback | QA fields-fallback read returns content on an outer version-0 item | Effective values do not establish source locale or writable target |
| GUID/path datasources | Raw GUID references and successful item reads | Candidate identity must be validated by a read; absolute paths supported by prototype only |
| Relative datasource | Documented `page:/` and owner-dependent `local:/` | Resolve only with verified context; `./`, queries, tokens and `field:` remain unresolved |
| Field choice Source | QA schema exposes template-field `dataSource.items` and `resolvedSources` | Promising API, not executed; completeness/context semantics still unverified |
| Nested references | Live datasource/reference reads and synthetic lazy traversal | Follow reference fields, not ordinary item children |
| Parameters | Raw per-instance parameter strings observed | Retain unchanged per instance; interpretation and editing deferred |

The [versioned layout API documentation](https://doc.sitecore.com/xp/en/developers/103/sitecore-experience-manager/the-versioned-layout-api-changes.html) describes server-side `LayoutField.GetFieldValue` patch resolution. That .NET API is not automatically available through GraphQL. Raw XML that looks complete also does not prove inherited/partial-design resolution.

The [CM Preview documentation](https://doc.sitecore.com/xmc/en/developers/xm-cloud/set-up-the-graphql-playgrounds-to-test-content.html) distinguishes CM preview from published Delivery. Verify authentication through an explicitly configured secret; do not retrieve API keys from content or reuse an Authoring/Delivery credential by assumption. The observed MCP exposes fixed reads and diagnostics, not arbitrary GraphQL or Preview requests.

## Live coverage and freshness

Samples below are anonymized; private content, hostnames and identifiers are deliberately excluded. All reads were read-only on 2026-10-19. QA schema evidence must not be presented as Dev schema evidence.

| Sample | Observation |
| --- | --- |
| QA page A, en | Version 1, 123 fields; shared 3,767 characters / 14 UID occurrences; final 5,267 / 19 with patch directives |
| QA page A, en-GB | Version 1; final 1,967 characters / 3 UID occurrences; locale presentation differs |
| QA datasource B, en | Version 1, 85 fields, two populated Droplinks, populated Images, empty Multilist; no presentation |
| QA references C and D, en | Both version 1 / 84 fields; C includes General Link and name-valued Droplists |
| Dev page A, en | Version 1, 124 fields; shared 3,767 / 14; final 5,326 / 20 with patch namespace |
| Dev page A, en-AU | Exact version 0, no fields |
| Dev datasource E, en | Version 1 / 85 fields; populated Multilist, Droplink and General Link fields |

UID occurrences are **not effective component counts**. Different environments have different content; no parity claim is made. Dev datasource E was one raw-layout reference, not an established effective component datasource. No navigation target or content subtree was crawled.

QA diagnostic ran 14:49:33.423Z–14:49:42.209Z: 58 logical requests / 58 HTTP attempts, 1,778,917 evidence bytes, no budget exhaustion. Exact en-AU returned version 0/no fields; `item.fields(withLanguageFallback:true)` returned 123 fields while the outer item stayed en-AU/version 0. Layout lengths matched English, but layout fallback flags were false and no source locale was returned. The observed AU-to-en configuration is not field provenance. This diagnostic includes schema/configuration reads and is not a minimal page-tree benchmark.

Individual QA exact reads took approximately 530–717 ms; Dev en-AU and datasource reads took 403 and 572 ms. These are host-observed tool durations, including transport and variable caches; some independent requests ran concurrently. No latency guarantee, throughput benchmark or snapshot isolation was established. Same-version content may change between reads.

## Queries and boundaries

[Candidate queries](../../test/research/b27Queries.ts) contain:

- `B27ItemEvidence`: item identity/version/locale, `isFallback`, `hasPresentation`, paginated fields and provenance flags. Variables: `where: { itemId, language }`, `after: null`, `fallback: false` (separate explicitly labelled effective read uses true).
- `B27FieldSource`: field template Source, resolved-source descriptors and paginated candidate items. Variables: `where`, `field` (field name), `after`. Every page must be read before name uniqueness can be established.
- `B27SiteContext`: site root/start, language and device metadata. Variable: `site`.
- `B27PreviewLayout`: `layout(site, language, routePath) { item { rendered } }` at the separate Preview endpoint. Variables: `site`, `language`, `route`.

The first three validate against the captured QA introspection schema, but were **not executed**. Preview was neither schema-validated nor executed. Existing MCP reads use `XmCloudSyncItemDetails` in [authoringQueries.ts](../../src/sitecore/graphql/authoringQueries.ts); its fallback modifier applies to `fields`, not the outer item lookup. Follow pagination, validate identities/locales/versions and preserve attempt/freshness evidence. The fixed read adapter's booleans are not a replacement for raw diagnostic provenance.

QA `ItemQueryInput` has no site/device selector. Site metadata and a stored layout device ID do not prove a requested device was rendered. Require provider evidence for the requested device; do not silently use Default for another device. Older [Edge device limitations](https://doc.sitecore.com/xp/en/developers/hd/19/sitecore-headless-development/limitations-and-restrictions-of-experience-edge-for-xm.html) are version-specific documentation, not a live QA capability test.

## Proposed model and traversal

Pin a discovery session to connection, site, page, requested locale, device, read mode and generation. Keep freshness/attempt metadata and requested versus verified source locale separate. An effective value with unknown source is **unverified provenance**, with no inferred write target.

Keep rendering instances (UID, definition ID, order, raw placeholder, raw datasource, raw parameters) separate from datasource items and reference edges. A placement edge requires authoritative provider evidence. Partial designs and runtime component queries can add behavior absent from simple raw XML. [SXA prefixes](https://doc.sitecore.com/xp/en/developers/sxa/103/sitecore-experience-accelerator/use-a-prefix-to-set-the-data-source-context-960061.html) specifically make `local:/` relative to a partial-design owner in that context. [Dynamic placeholder conventions](https://doc.sitecore.com/xp/en/developers/92/sitecore-experience-manager/dynamic-placeholders.html) are not a universal parser for SXA/custom runtime placement.

Initial delivery loads components and their immediate datasource items. Expanding a datasource follows its reference fields to items, whose reference fields can in turn be expanded. Preserve field order and each occurrence, including repeated usages of the same target. Cycle detection uses the current ancestor path, not a global visited set that hides legitimate repeated usages. A future cache may share reads by full context while UI nodes remain path-specific; invalidate/fence old generations on locale changes.

| Field family | Treatment |
| --- | --- |
| Droplink, Grouped Droplink, Droptree | Strict single item ID |
| Checklist, Multilist, Treelist, TreelistEx | Ordered ID list; preserve duplicate occurrences and malformed tokens as unresolved |
| Droplist, Grouped Droplist | Resolve stored name only against a complete, unambiguous Source result |
| General Link, Rich Text | Separate navigation extraction on demand; not automatic component dependencies |
| Image, File | Media leaves |
| Other text | Never scan arbitrary text for GUIDs |

Empty datasource does not establish page-as-datasource. Queries/tokens/custom Sources remain visible unresolved values. Missing/failed reads are not proof of absence. Bounded expansion must label partial results, cancellation and unresolved edges explicitly.

## Prototype and verification

[Research-only model](../../test/research/b27Discovery.ts) and [12 regression fixtures](../../test/unit/b27Discovery.test.ts) cover raw-layout rejection, the publishing-extractor counterexample, context mismatch, repeated usages/parameters, unresolved/cyclic placement, datasource context, supported field families, ambiguous names, navigation/media classification, lazy reference cycles, version-0/effective provenance, bounds, errors and cancellation.

The prototype accepts synthetic trusted resolved-layout evidence; **it does not implement a provider**, XML patch engine, network boundary validator, UI or production cache. Defaults of 100 edges and depth 12 are fixture limits, not approved product limits. Unknown provenance remains explicit even for exact reads in this minimal model. It is excluded from the VSIX under `test/**`.

Automated validation: 490 unit tests passed and `npm run check` passed (extension, tests and webview). No Extension Development Host, VSIX packaging or live save test is required for this research-only change, and none was performed. Live coverage does not prove custom Sources, name uniqueness, deep reference chains, partial-design placement, non-default devices or effective Preview layout.

## Recommended implementation sequence

First verify CM Preview against Authoring evidence using a configured read credential: unpublished changes, locales, device behavior, nested placement, repeated instances, partial designs, datasource identity and parameter fidelity. If it cannot satisfy the contract, assess a supported server-side Authoring extension rather than approximate a patch engine.

Then implement the read-only component/immediate-datasource view behind a verified provider, followed by bounded lazy field-reference expansion and on-demand navigation links. Coordinate editor entry points with B28; verified fallback-source writes belong to B26, publishing to B29. This report does not authorize those production changes. B35 live Rich Text save acceptance remains deferred.
