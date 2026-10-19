# B27 CM Preview verification: access gate and query protocol

2026-10-19. Continues the [Authoring discovery spike](b27-authoring-discovery-spike.md). Research only. Open work remains in [BACKLOG.md](../../BACKLOG.md).

## Current decision

**No-go for claiming a verified effective-layout provider yet.** The concrete blocker is the available authenticated execution boundary: MCP exposes fixed Authoring operations, with no CM Preview query operation. The extension has no separately configured Preview credential slot. This does not establish that the remote Preview endpoint is unavailable, or that the user has no Preview credential.

Asked the user to open Dev's Preview GraphQL IDE through Sitecore Deploy and configure its Preview token in that UI, without sharing it in chat. No credentials were extracted from content, local application storage or browser storage. The existing Delivery token and Authoring OAuth credentials were not reused. No live Preview API request has been attempted; there is no HTTP status, response timing or live Preview schema result to report.

## Verified versus candidate evidence

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
- **Device:** only probe a non-default device when the live schema and documentation establish a selector. Otherwise report device coverage unverified and restrict any later provider claim accordingly.

The existing synthetic [B27 fixtures](../../test/unit/b27Discovery.test.ts) exercise conservative discovery contracts; they do not supply missing live provider evidence. No production parser or UI was added in this follow-up.

## Bounded next implementation decision

Resume the live protocol once the configured Preview IDE is accessible. If identity, layout coverage and raw-parameter association can be established, implement a separately authenticated, read-only provider with explicit coverage/provenance, followed by the initial component/immediate-datasource view. If access through the extension is needed, design a dedicated SecretStorage-backed Preview configuration and narrowly scoped diagnostic command first; that is a separate implementation task, not accomplished by exposing Authoring MCP. If provider semantics fail, report the specific gap before selecting a server-side alternative.

Validation for this follow-up: query syntax/operation names, source audit, documentation links and diff review. No TypeScript/runtime change, package, release or live Preview acceptance test. Earlier live Authoring observations remain dated evidence in the preceding report; they were not rerun as Preview verification.
