# B27 CM Preview verification: live evidence and query protocol

2026-10-19. Continues the [Authoring discovery spike](b27-authoring-discovery-spike.md). Research only. Open work remains in [BACKLOG.md](../../BACKLOG.md).

## Current decision — updated 2026-10-20

**Controlled partial-design and unpublished-value checks passed.** With explicit user authorization, created four isolated items in Dev's demo site through Content Editor: a page, page design, partial design and text datasource beneath the partial design. Existing items were not edited and no publish action was performed. The demo site was used because it exposes the standard headless partial-design templates; the earlier real-page checks used a different site on the same Dev connection.

The new page selected only the new page design, which selected only the new partial design. The partial's shared presentation contained one RichText instance in `headless-main`, with `local:/b27-marker` as datasource and `label=B27&empty=` as parameters. Its text datasource contained a unique marker A, subsequently changed to marker B without publication.

Verified observations:

- Preview returned the expected new page and page-design identities. The page's own raw presentation had a layout but no rendering instances, and its final presentation was empty.
- Effective `headless-main` contained a `PartialDesignDynamicPlaceholder` wrapper, whose UID and `sid` matched the partial-design item. Its signature-named nested placeholder contained the exact RichText UID configured on the partial.
- Preview resolved `local:/b27-marker` to the datasource path beneath the partial design, not beneath the page. The returned Text value matched the controlled marker.
- Preview returned marker A, then marker B after a direct save, with one HTTP 200 attempt each (272 ms and 264 ms transport timings). Exact Authoring readback confirmed B. This establishes visibility of these newly created, never-published items and their changed value in this fixture; it is not a universal freshness guarantee or a Delivery comparison.
- Unlike the earlier navigation sample, the fixture retained `"empty": ""` in its parameter object. Do not generalize empty-parameter removal across renderings. Preview parameters remain effective projections, separate from raw strings.

Cleanup: deleted the page, page design and partial-design subtree (including the datasource) through Content Editor, then deleted the three thumbnails Sitecore generated for those new presentation items. Exact-ID index searches returned zero results for all seven items; the test route returned HTTP 200 with null layout (`status: unresolved`, 24 response bytes). Restored Raw values to its original off setting. No recycle-bin purge or existing media-folder deletion was performed. Index absence alone is not proof of physical erasure; these were normal Content Editor deletions.

**Next implementation boundary:** the sampled provider now has evidence for ordinary layouts, standard partial-design expansion, owner-relative datasource resolution and unpublished changes. Proceed with a bounded read-only component/immediate-datasource tree, retaining effective nesting and occurrence identity, explicit unknown provenance and the agreed implicit-device constraint. Treat custom resolvers, nested/base partial-design inheritance and other datasource expressions as unverified. Do not derive writable source locales or reconstruct raw presentation from effective output.

Validation: live fixture creation/readback, two fixture layout reads, post-delete null-layout check, targeted cleanup searches and documentation diff review. Runtime source is unchanged, so automated runtime suites were not rerun. No fixture payloads, private IDs or credentials are committed.

## Earlier dedicated diagnostic evidence — 2026-10-20

**The extension's dedicated CM Preview diagnostic now works against Dev.** After saving the separate Preview token, two fixed layout queries succeeded through MCP for the same known page in `en` and `en-AU`. No Sitecore writes or publications were performed. The IDE observations below remain earlier evidence.

Both responses returned the expected page identity, `master`, their requested context/item language and route version 1. Each contained 20 unique instance UIDs. Traversing only explicit placeholder arrays confirmed identical instance UIDs, component names, datasource strings, nesting, placeholder-local order and parameter objects across the two locales. This replaces the discarded earlier cross-locale analysis, not the underlying observations. The rendered payloads differ; structural equality does not establish content equality or fallback source provenance.

| Diagnostic | UTC start | HTTP attempts | HTTP attempt elapsed | Response bytes |
| --- | --- | --- | --- | --- |
| English | 2026-10-20 08:38:03.406 | 1, HTTP 200, no retry | 1,803 ms | 734,383 |
| Australian English | 2026-10-20 08:38:03.392 | 1, HTTP 200, no retry | 1,340 ms | 453,958 |

These two reads ran concurrently, unlike the sequential initial protocol below. Timings are single-request transport observations, not performance benchmarks or full body-consumption timings. Reports completed approximately 1.92 s and 1.45 s after their respective starts. Both stayed below the diagnostic's 2 MiB bound. No transactional snapshot or server-instance identity is established.

A subsequent exact English Authoring read confirmed the same page identity/version and supplied raw shared/final presentation. A targeted UID association for one navigation instance found eight entries in the final `s:par` string, including three empty entries. Preview returned five parameter properties: all five nonempty values agreed, and the three empty entries were absent. This is direct evidence that Preview parameters are a projection, not a raw-string-preserving representation. Keep raw presentation and effective parameter objects separate; never reconstruct authoritative raw parameters from Preview. This targeted comparison is not a general XML patch resolver.

**Next boundary:** the authenticated diagnostic and sampled locale structure/parameter checks are verified. Partial designs, context-dependent datasource expressions, complete raw/effective ownership and known unpublished freshness remain unverified. A bounded read-only provider can preserve effective occurrences and explicitly unresolved provenance under the agreed implicit-device constraint; a complete authoring tree still needs the remaining coverage checks. No production tree UI or write capability is authorized by this evidence.

Validation: two live Preview reads, one targeted Authoring read, bounded local response traversal (500 occurrences / 20 nested levels), and documentation diff review. No runtime source changed; automated runtime suites were not rerun. Raw payloads, private identifiers and credentials are not committed.

## Earlier IDE evidence — 2026-10-20

**Preview access is now verified through the user-configured Dev IDE.** The earlier access blocker below is historical. Five read-only queries succeeded: root introspection, root operation contract, site catalog, and the known page in English and Australian English. This establishes a useful provider candidate, not full B27 acceptance: unpublished freshness, partial designs and raw-parameter fidelity remain unverified. Arbitrary-device support is excluded by the agreed constraint below.

The live root schema exposes `layout(site: String!, routePath: String!, language: String!)` returning `LayoutData`, with no device argument. `item` accepts optional `path: String`, required `language: String!`, and optional `version: String`. No undocumented selectors were attempted.

The catalog returned four entries, including two entries with the intended site name but different root paths. Site-name matching alone is therefore insufficient. The page layout itself returned the expected page ID, `master` database, English language/version 1 and the standard default-device ID. It contained four top-level placeholders and **20 distinct instance UIDs**, nested to depth two. One component type appeared three times with distinct UIDs and datasources. Array order and explicit parent nesting are observable without parsing placeholder names. Raw placeholder expressions differ from the normalized keys in Preview; preserve the two representations separately.

The Australian English query returned the same page ID and device, context language and route item language `en-AU`, and route version 1. A fresh exact Authoring read on 2026-10-20 returned version 0 with no fields, confirming the previous day's observation. This is evidence of different read semantics, not proof that a local version exists or that English is the source. No writable locale is inferred.

Inspected component records expose `uid`, `componentName`, `dataSource`, `isContentResolved` and, where applicable, `params`, `fields`, and `placeholders`. They do not expose a raw parameter string or rendering-definition ID in this sample. Preserve raw Authoring presentation separately; associating it with effective instances still needs verification. A sixth identity query was submitted but its result was not verified before the browser tool timed out on large response observation. No reliable per-request latency was captured. An attempted cross-locale count comparison was discarded because of a local analysis-state error; no order/parameter equivalence claim is made.

After the user restarted MCP, three targeted Authoring reads succeeded: the page in English (version 1, 124 fields), the same page in Australian English (version 0, no fields), and one Preview datasource in English (matching identity, version 1, 85 fields). Shared presentation still contains 14 UID occurrences and final presentation 20; these are not effective counts.

Three specific raw/effective comparisons support patch resolution in this sample: an instance explicitly deleted by final `<p:d />` is absent from Preview; an inherited instance absent from the final patch remains in Preview; and a footer instance uses the final `s:ds` override instead of the shared datasource. This is stronger evidence than matching total counts. It does not validate every patch directive or custom resolver, and reads are nontransactional.

Browser observation failed on the large response, so five successful Preview queries plus the three fresh Authoring reads are the verified boundary. No Sitecore content was changed, and no unpublished difference was manufactured. Private payloads and identifiers are not stored in this report.

| Capability | Current status |
| --- | --- |
| Configured Dev Preview authentication and layout query | Verified through IDE |
| Expected page identity and master database | Verified in returned layout; fresh Authoring identity agrees |
| Nested placement, distinct instances, repeated component types | Verified for one English page, including the three patch comparisons above |
| Datasource identity | One returned GUID verified by fresh Authoring read |
| Fallback source provenance | Unverified; exact/effective locale-version discrepancy reproduced |
| Device | Returned default device observed; root layout schema has no device selector |
| Raw parameters, partial designs, custom datasource expressions | Not verified |
| Unpublished freshness | Not verified; no known unpublished difference supplied |

**Recommendation:** proceed with designing a dedicated read-only Preview connection/diagnostic boundary, but do not claim full B27 coverage or enable writes. Complete partial-design and parameter association checks before promising a complete authoring tree. A limited provider must expose its coverage and unresolved evidence rather than silently substituting raw XML or published Delivery.

## Agreed device constraint — 2026-10-20

B27 uses the provider’s implicit device context. Arbitrary device selection, multi-device support and non-default-device verification are out of scope and are not acceptance blockers. Preserve a returned device ID as evidence; otherwise use unknown. Missing device identity alone must not reject an otherwise valid read-only layout. “Invariant” may describe the absence of a user-selectable dimension, but must not claim that content is identical across devices. This decision supersedes the earlier spike’s requirement to pin and verify a requested device; its synthetic device-mismatch fixtures remain historical research, not the production acceptance contract.

## Historical access gate — 2026-10-19

**No-go for claiming a verified effective-layout provider yet.** The concrete blocker is the available authenticated execution boundary: MCP exposes fixed Authoring operations, with no CM Preview query operation. The extension has no separately configured Preview credential slot. This does not establish that the remote Preview endpoint is unavailable, or that the user has no Preview credential.

Asked the user to open Dev's Preview GraphQL IDE through Sitecore Deploy and configure its Preview token in that UI, without sharing it in chat. No credentials were extracted from content, local application storage or browser storage. The existing Delivery token and Authoring OAuth credentials were not reused. No live Preview API request has been attempted; there is no HTTP status, response timing or live Preview schema result to report.

## Historical verified versus candidate evidence — 2026-10-19

| Area | Evidence status | Consequence |
| --- | --- | --- |
| Current MCP boundary | Verified source/tool inventory: fixed Authoring reads and mutation-plan tools only | Tools named `preview_*` preview mutation plans; they do not query CM Preview |
| Credential configuration | Verified source: Authoring, deployment and traced-publishing Edge secrets; no separate Preview setting | Do not overwrite the existing Delivery profile to run this experiment |
| Direct CM endpoint/auth | Documented: HTTPS CM `/sitecore/api/graph/edge`, Preview token in `sc_apikey` | Actual Dev endpoint/auth still untested |
| Alternative platform access | Documentation describes Preview Context ID, distinct from Live Context ID | Not evidence that either is configured or exposed here |
| Unpublished freshness | Documentation describes CM draft access; no known unpublished difference supplied | Live freshness unproven; no edits/publications will be made to manufacture evidence |
| Schema and device selector | Candidate introspection prepared, no live Preview schema | Do not add guessed `device` arguments or headers; do not assert Default covers all devices |
| Site/route/page identity | Prior Authoring evidence only | Match returned identity to Authoring; route name alone is insufficient |
| Nested/repeated instances | Documented nested placeholder arrays with instance UIDs | Live placement, order and completeness unverified |
| Partial designs/custom resolvers | Context-sensitive behavior must be sampled | Missing raw-page instances cannot automatically be labelled deleted |
| Parameters | Documented `params` object | Parsed parameters cannot establish byte-for-byte raw string fidelity |
| Fallback source | Earlier Authoring evidence lacks source provenance | Requested locale and returned values do not establish a writable source locale |

## Current sources and applicability

The [Preview API overview](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/preview-graphql-api.html) describes read-only access to CM draft and published content. This is product documentation, not proof about the running Dev environment.

[Authorization documentation](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/authorization-and-api-access/index.html) distinguishes direct API tokens from platform Context IDs. [IDE setup](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/set-up-the-graphql-ides.html) gives the Preview IDE path `/sitecore/api/graph/edge/ide/`. Use the Preview IDE supplied by the selected environment and configure its token there; the Delivery IDE is a separate service.

[Preview/Delivery differences](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/differences-between-the-preview-and-the-delivery-graphql-apis.html) describe differences in field availability, search versions, links and caching. Keep requests small and sequential; published Delivery evidence cannot replace Preview evidence.

[Layout response documentation](https://doc.sitecore.com/sai/en/developers/sitecoreai/introduction-to-framework-agnostic-sitecore-development/content-rendering/layout-query-and-response.html) shows nested placeholder arrays, instance `uid`, `dataSource`, `params` and `fields`. Rendering contents resolvers can source fields from contexts other than the declared datasource. Therefore rendered fields are not automatically a complete datasource record or a writable source. All documentation was consulted on the report date; older XM Cloud links may redirect to current SitecoreAI documentation.

## Reproducible query protocol

[Candidate operations](../../test/research/b27Preview.graphql) contain no credentials or environment identifiers. They have local GraphQL syntax validation only. They have not been submitted to Preview, and the previous QA Authoring schema does not validate them.

1. On the explicitly selected CM Preview IDE, run `B27PreviewRoot`, then `B27PreviewType` with the returned root name. Inspect `layout`, `item` and their named return types. Record argument types and whether a documented device selector exists. Stop on access/schema errors; never retry with another credential type.
2. Confirm the intended site using `B27PreviewSites` after checking its live schema. The catalog is discovery metadata, not proof of the requested rendering context. If it is unexpectedly large, stop rather than paginate broadly.
3. Run `B27PreviewPage` with variables shaped as `{ "site": "example", "language": "en", "route": "/example" }`, using a single known page. Retain request identity separately from response context. Accept object or JSON-string `rendered` only after validation. GraphQL errors, null routes, identity mismatch or incomplete responses remain unresolved.
4. If supported, run `B27PreviewIdentity` for the same known page ID/path and locale, and cross-check with a contemporaneous exact Authoring read. A separate identity read alone does not prove the layout belongs to that item; seek layout route/item identity too. Preserve this distinction if the layout omits identity.
5. Repeat only for one contrasting existing locale and at most one known partial-design example. Compare actual array order and UIDs, not raw shared/final counts. Follow explicit nested arrays; keep orphan/unknown placement as **Placement unresolved** with the original key.
6. Validate at most two returned datasource identities with Authoring. Retain raw expressions where context resolution is unavailable. An empty datasource or custom resolver does not imply page-as-datasource. Never recurse through item children as component dependencies.

Budget for the initial live pass: at most 12 sequential Preview operations and four targeted Authoring reads, one attempt per operation, stop on cancellation or access failure. A future diagnostic client needs explicit timeout, response-byte and traversal limits; the IDE cannot prove those client guarantees. No broad search, auto-refresh, mutation or publication. Record start/end time, endpoint role, operation, sanitized variables, error classification, and whether response completeness was observed. Do not export headers, tokens or private payloads to Git.

## Comparison acceptance

- **Freshness:** use an existing, user-identified unpublished difference. Compare the relevant Authoring value to Preview; optional Delivery corroboration requires its separately configured access. Equal Preview/Authoring values without a known unpublished difference do not prove freshness. All reads are nontransactional.
- **Locale:** retain requested language, response context language, outer item language/version and any explicit source-language evidence separately. A matching string or configured fallback chain is not provenance.
- **Placement/order:** provider nesting supplies candidate parent relationships; preserve placeholder-local array order and path-specific occurrences. Do not infer a universal order between unrelated placeholders. Duplicate/missing UIDs, flattened placement or partial-design ambiguity need explicit unresolved records.
- **Parameters:** keep Preview's parameter object distinct from raw per-instance `s:par`/`par`. For the synthetic string `label=A%26B&empty=&label=C`, a plain object cannot preserve both `label` occurrences and original ordering/encoding. Do not reconstruct a raw string from the object. Correlation with raw Authoring data requires verified instance and effective-layout ownership; patch/inherited/partial-design values cannot be guessed.
- **Datasource/context:** retain the returned raw expression and separately verified target. `local:/` needs the owning partial-design context. Custom resolver fields are effective rendering output, not a guaranteed item-field snapshot.
- **Device:** use the provider’s implicit context; preserve returned identity or record unknown. Do not probe arbitrary devices or block acceptance on non-default-device coverage.

The existing synthetic [B27 fixtures](../../test/unit/b27Discovery.test.ts) exercise conservative discovery contracts; they do not supply missing live provider evidence. No production parser or UI was added in this follow-up.

## Bounded next implementation decision

Resume the remaining live checks once browser observation recovers, or through a separately implemented diagnostic boundary. If identity, layout coverage and raw-parameter association can be established, implement a separately authenticated, read-only provider with explicit coverage/provenance, followed by the initial component/immediate-datasource view. If access through the extension is needed, design a dedicated SecretStorage-backed Preview configuration and narrowly scoped diagnostic command first; that is a separate implementation task, not accomplished by exposing Authoring MCP. If provider semantics fail, report the specific gap before selecting a server-side alternative.

Validation: the initial follow-up checked query syntax/operation names, source and documentation. The 2026-10-20 continuation adds the live checks above and a documentation diff review. No TypeScript/runtime change, package, release or full live acceptance test. Earlier observations remain dated evidence; the three fresh Authoring reads are explicitly distinguished above.
