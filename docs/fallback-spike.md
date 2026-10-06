# Language fallback technical spike — B04

Status as of 2026-10-06: B04's first comparison delivery uses Sitecore-provided effective fields and explicitly unknown fallback sources. The calculated resolver and verified source chains remain deferred; configuration and runtime-rule verification are incomplete. B03 publishing and B26 editor integration remain separate work. The earlier implementation gate below records the original, broader resolver plan; the bounded-delivery section records the approved narrower scope.

## Agreed implementation contract

- New comparisons start in **Exact locale**. Use `withLanguageFallback: false`, preserving missing versions and Standard Values/inheritance metadata. Exact locale does not mean physically stored values only.
- **With fallback** is explicit and remains selected while navigating that comparison. Resolve each side independently. Keep exact values and resolution evidence inspectable, alongside effective values, source locale/version and full chain.
- Read the requested locale without fallback first. Inspect applicable configuration and enablement, then follow configured candidates using reads without fallback. Independently query the original requested locale with fallback enabled as a cross-check. Never substitute that cross-check for source resolution or infer a source from matching text.
- Preserve requested and effective locale per field. Equal text from different origins must remain distinguishable, such as **Equal value, different source**.
- A disagreement or missing evidence produces **Unverified fallback**. Preserve calculated and Sitecore results; do not confidently classify that field as equal or make its unverified source writable.
- Enable field transfer only in Exact locale, enforced in the extension host as well as the UI. Mode changes invalidate pending loads and stale field-transfer messages. Do not change subtree-transfer semantics or enable fallback globally for publishing/transfer.
- Editor save behavior remains existing-source only, without creating versions; this task does not implement editor saves.

## Evidence gathered

| Evidence | Finding | Confidence / limit |
| --- | --- | --- |
| Repository `itemDetailsQuery` | `fields(ownFields: false, withLanguageFallback: false)` requests value, three provenance flags, scope, template field ID, language/version and available versions. | Verified source contract; not a captured server schema. |
| Repository `loadItemDetailsPages` / parser | Null outer `item` throws; version 0 is permitted; absent fields become an empty collection. Missing provenance flags become false. | Verified client behavior. The parser cannot establish whether an omitted flag means false on the server. A fallback evidence reader must preserve unknown/missing evidence. |
| Repository language query | Fetches language names/display metadata only; no fallback chain or policy. | Verified. Language names or regional similarity cannot supply the missing chain. |
| Official fallback setup documentation [1] | Configuration has environment, site UI, item/template and field-definition concerns. Versioned field enablement depends on an additional setting. | Documented, not verified against this environment or Authoring execution context. Delivery/Page builder settings cannot automatically be equated to Authoring settings. |
| Official fallback overview [2] | Item fallback covers missing versions; field fallback has exclusions including shared/system fields and Standard Values items. | Documented for XP 10.0, requiring environment verification before applying to XM Cloud Authoring. |
| Official Authoring documentation [3] | The environment's authenticated IDE exposes its schema. | Documentation provides the discovery route, not the missing runtime evidence. |
| Available access | No schema export found in this repository. The user shared an authenticated Experience Edge Delivery Playground, which is a different API from Authoring; the Authoring Playground returned 404. Version 0.26.0 now supports collecting evidence directly through the saved extension connection, so browser IDE access is no longer required. Connection credentials are retrieved through VS Code SecretStorage. | No live probe requests performed. No credentials copied into files or requests and no environment content/configuration changed. |

Sources reviewed:

1. [Sitecore: Enable and set up language fallback](https://doc.sitecore.com/sai/en/developers/sitecoreai/content-modeling-and-presentation/working-with-languages/language-fallback/overview-of-setting-up-language-fallback/enable-and-set-up-language-fallback.html).
2. [Sitecore: Language fallback](https://doc.sitecore.com/xp/en/developers/100/sitecore-experience-manager/language-fallback.html).
3. [Sitecore: Authoring and Management GraphQL API](https://doc.sitecore.com/sai/en/developers/sitecoreai/content-modeling-and-presentation/sitecore-authoring-and-management-graphql-api.html).
4. [Sitecore: Fine-tune fallback configuration](https://doc.sitecore.com/xp/en/developers/102/sitecore-experience-manager/fine-tune-your-language-fallback-configuration.html) documents the per-language field-setting switch; its actual effective value still needs verification.

## Read-only probe procedure

Preferred in 0.26.0: use the Command Palette diagnostic described in the README. It uses saved credentials, retrieves schema and optional item probes, and opens an unsaved JSON report. It does not infer a chain or resolve source provenance. The offline instructions below remain useful for inspecting/generated queries or a separately authenticated IDE.

The checked-in helper generates requests and validates a supplied schema locally. It has no HTTP client, accepts no credentials and does not execute requests. Use the installed lockfile dependencies:

```powershell
node --import tsx scripts/fallback-spike.ts schema
node --import tsx scripts/fallback-spike.ts probes 00000000-0000-0000-0000-000000000001 en-NZ en-AU en
node --import tsx scripts/fallback-spike.ts validate <exported-schema-file>
```

Replace the example item GUID with a representative existing item. The locale arguments are explicit probe candidates, not an asserted fallback chain. Do not derive them from regional names. Output contains each query and its variables. It reuses the application's details selection, changes only the fallback argument for the cross-check, and keeps the original requested locale. The schema command outputs a standard GraphQL introspection query; an IDE schema export is also suitable. Validation accepts SDL or JSON introspection (with or without the `data` wrapper).

The user has authorized development-environment testing, including creating and removing new test items, while preserving all existing items. Start with read-only evidence; if fixture creation becomes necessary, record the new item identities and remove only those items. At the initial planning stage no creation or deletion had been performed; subsequent controlled results are recorded below.

Run queries in an already authenticated Authoring Playground. Complete pagination independently for each query: copy `endCursor` into `after` until `hasNextPage` is false. Preserve null outer items, version 0, absent versus null collections, empty values and all provenance flags in evidence. Never interpret a first page as a complete field set. Keep raw response exports outside version control; sanitize item names/values before making deterministic fixtures. Do not include headers, tokens or credentials in exports.

First inspect schema descriptions for the actual types reachable from `item`, `fields`, `templateField`, `languages`, site/configuration queries and `ItemQueryInput`. Determine whether they expose effective fallback configuration, chain references, source metadata and raw/empty/reset state. If configuration is only available through language/template definition items, verify those fields and inheritance using exact reads; do not hard-code guessed IDs or localized labels. The effective environment/context switches must also be established. A template checkbox alone does not prove all required switches are enabled.

Run exact requested/candidate reads, then the fallback-enabled original lookup. For missing requested versions, distinguish an absent outer item from a version-0 object: a nested `fields` argument cannot be assumed to change the outer lookup. Check whether any separate item-level API option exists in the actual schema. Do not treat an empty nested response as proof that no usable fallback exists.

## Runtime matrix still required

The following matrix tracks required evidence. Later observations below cover only the explicitly named cases; remaining cases are unverified.

| Case | Evidence required |
| --- | --- |
| Existing local value | Exact and cross-check values, scope, flags, local version, effective enablement. |
| Missing requested version | Null versus version 0; item enablement; whether nested fallback returns fields; existing source version. |
| `en-NZ -> en-AU -> en` | Actual configured chain and intermediate version absence, not a guessed chain. |
| Disabled fallback | Effective environment/context and item/field settings; no inferred fallback from an equal candidate. |
| Mixed field sources | Field-definition enablement/inheritance and separate source evidence per field. |
| Empty value | Distinguish explicitly empty, unset/reset, inherited and Standard Value; determine which states trigger fallback. |
| Shared / unversioned / Standard Values | Scope-specific behavior and any fallback exclusions; do not assign a fictitious locale to shared values. |
| No usable source | Complete valid chain and complete candidate reads, with no access errors mistaken for absence. |
| Invalid / cyclic chain | Sanitized fixture built from the eventual config contract; bounded traversal with explicit unresolved reason. |
| Cross-check mismatch | Preserve both results, source uncertainty and observation times. Equal text alone must not certify provenance. |
| Errors / cancellation / supersession | Deterministic mocked failures; never cache a failure as missing content or publish stale results. |

## B04 implementation gate and next steps

The schema must establish supported reads, and representative responses/configuration must establish the resolution rules. Without these, implementing a source resolver would invent empty-value semantics, enablement and version-0 behavior. An exported schema alone permits query validation but does not complete runtime validation. Next evidence: run **XM Cloud Sync: Collect Authoring Fallback Diagnostic** in the extension using the saved dev connection. Start with Schema only, then representative item probes. This uses the Authoring endpoint directly; an authenticated browser IDE is optional. Review the resulting schema and item responses together with relevant effective configuration.

Once established, implement an evidence-preserving adapter and pure bounded resolver, then deterministic regression fixtures for the matrix above. Represent unresolved configuration/provenance explicitly. Keep source identity, locale, version, field scope, inheritance/Standard Values, exact values, calculated values, cross-check values and capture times separate.

Sequential probes are intentional during the spike. GraphQL aliases could reduce round trips once schema and resolver scoping are verified; they do not guarantee transactional consistency. Bound any later cache by connection, database, item, requested/candidate locale, version and policy generation; use short session/request scope, deduplicate in-flight reads, and invalidate on relevant navigation/settings changes. Do not persist speculative provenance. Detect disagreement or changed observations rather than claiming a snapshot.

After the foundation passes the runtime matrix, add the mode selector, independent side resolution, visible provenance/evidence and host-side field-transfer fencing. Verify mode defaults/retention, language locking, navigation preservation, stale detail responses and stale transfer messages in unit/extension-host tests and focused UI checks. Publishing diagnostics and editor integration remain deferred.

## Verification of this preparatory change

Automated verification: `npm test` passed 275 tests; `npm run check` passed; focused probe tests passed again after adding SDL and wrapped/unwrapped JSON schema coverage. CLI generation was smoke-tested for the schema query and a three-locale probe set. `git diff --check` passed.

Automated tests cover query-only generation, candidate bounds/validation, exact candidate reads, original-locale cross-check, retained provenance/pagination fields and schema compatibility diagnostics. These tests verify tooling, not fallback runtime behavior. That preparatory check did not exercise a live environment. Version 0.26.0 subsequently adds the authenticated client/command with unit coverage for pagination, incomplete evidence, cancellation, authentication routing and redaction, plus an extension-host smoke check for saved credentials and opening an unsaved report. Live probes, fallback runtime fixtures and resolver/UI integration remain pending. Manual native UI acceptance has not been performed.


## Live evidence received and next collection (0.27.0)

The user-supplied report dated 2026-10-03 (raw content kept outside the repository) establishes one observed case: requested en-NZ and candidate en-AU return version 0 and null fields with fallback disabled. Candidate en returns version 1 and 124 fields across two pages. The original en-NZ query with fallback enabled returns 124 fields while item metadata still says en-NZ/version 0; three fields carry containsFallbackValue. Item fallback enablement is supplied through Standard Values. This does not prove the effective source or a chain through en-AU. Schema collection remained unavailable. This supersedes the earlier unverified status for this particular missing-version/nested-fields case only; mixed-field/empty-value/environment policy remains unresolved.

Version 0.27.0 corrects the misleading invalid-response classification for version-0/null-fields evidence and adds the configuration collection described in README. It reuses the verified item-query shape for language definition paths and observed definition/template GUIDs. Field names identify candidate settings and raw IDs/provenance remain in the output; unknown or unavailable settings never become false. It follows only valid observed GUID references with deduplication/limits and makes no changes. It does not assume that the configured references necessarily equal the effective runtime chain. Field definitions are read in each supplied locale, including metadata locale; base-template/Standard Values items use metadata locale. Requested locales with no definition fields remain explicit. Environment enablement and LanguageFieldFallback.AllowVaryFallbackSettingsPerLanguage are still unknown. The next user-executed report is needed to verify these new reads against this environment.


## Configuration evidence and controlled fixtures (0.28.0)

The second configuration report establishes observed language settings en-NZ -> en-AU -> en: the Fallback Language values are locale names, not GUIDs. The collector now follows validated names beneath /sitecore/system/Languages, while retaining GUID support and bounded cycle detection. BAUPage Standard Values supply item fallback enablement. The three fallback-marked content fields have Enable Shared Language Fallback set in their metadata-locale field definitions; definition reads in the regional locales have version 0. This does not establish per-language override semantics or environment switches. Configuration coverage was partial (16 of 48 field definitions and a capped template traversal).

The user authorized preparation of mutation and diagnostic commands for new content and, if needed, changes to existing content. Version 0.28.0 implements the narrower new-item procedure in README: source-only enabled/disabled item controls and local value/empty controls. Run it once for a page template and once for a component template. It neither clones a page tree nor changes template rules. Multiple language versions on one new item, field-rule changes and reset-versus-empty mutations remain unimplemented pending evidence; do not treat these four controls as the full matrix. All live execution is user initiated; no environment mutations were made while developing the commands.


## Controlled page/component observations (2026-10-04)

Eight isolated test items were created through confirmed MCP plans: four page controls and four component controls. Existing content was preserved; nothing was published or deleted. Raw reports remain outside the repository because they contain private content.

- Language-definition evidence links `en-NZ -> en-AU -> en`. The selected page text field and component rich-text field both expose enabled shared language-fallback settings.
- Source-only controls have exact requested/intermediate version 0 and null fields. Reading fields with fallback enabled in the original requested locale returns the English marker with `containsFallbackValue: true`, while the outer version stays 0.
- The same nested-field behavior occurs on controls whose item-level fallback setting is empty. This is evidence about this field query, not proof that item-level fallback is enabled.
- A local requested-language marker is returned without a fallback flag. A local empty control with no populated source is empty without a fallback flag.
- Temporarily writing a literal empty English source on both source-enabled controls produces an empty requested/intermediate cross-check value **with** `containsFallbackValue: true`. Restoring the English markers restores those cross-check values. Exact English reads verified both markers restored at version 1. An empty fallback-marked value therefore cannot be treated as a usable nonempty value.

Schema introspection remains unavailable. Configuration traversal is bounded and partial; effective environment switches are not established. Later sections record controlled mixed-field observations. These observations do not complete B04's implementation gate.

Version 0.30.0 adds previewed first-language-version creation and explicit field reset to support the next experiments. The version preview validates its mutation contract using `@skip` before allowing execution. The version-creation contract and field-reset operation have now also been exercised on the development environment through confirmed MCP plans; see the following results.


### Existing local version: empty versus reset

The same isolated page and component source-enabled controls were each given an `en-NZ` version 1, retaining their English marker and leaving `en-AU` initially absent. Each stage was followed by exact reads in all three locales and a fallback-enabled read in the original `en-NZ` locale. Both selected fields behaved alike:

| Controlled state in `en-NZ` | Exact value | Fallback-enabled value | `containsFallbackValue` on cross-check |
| --- | --- | --- | --- |
| Newly created version, field untouched | Empty | English marker | true |
| Explicit local marker | Local marker | Local marker | false |
| Literal empty written over local marker (`reset: false`) | Empty | Empty | false |
| Explicit reset after literal empty (`reset: true`) | Empty | English marker | true |

All four stages retained version 1. Exact reads of untouched, literal-empty and reset states returned the same empty value with fallback/inherited/Standard Value flags all false. Therefore the current exact field response cannot distinguish an explicit empty override from an unset/reset field. A resolver must not treat an empty exact value as permission to walk the chain, or it would override intentionally empty content. Preserve the original-locale cross-check; without stronger raw-state evidence, unresolved distinctions must remain explicit.

These are observations for one page text field and one component rich-text field under the observed development configuration, not a universal rule for all Sitecore fields or deployments. The tests changed only the previously created controls. Existing real content, templates, language definitions and publishing remained untouched.


### Intermediate-language precedence and final state

After the reset stage, both controls received `en-AU` version 1 and distinct intermediate markers while their `en-NZ` fields remained reset. The fallback-enabled original `en-NZ` reads returned the corresponding Australian marker with `containsFallbackValue: true`, ahead of the still-populated English marker. Exact Australian reads confirmed the distinct values. This controlled intervention supports precedence in the observed `en-NZ -> en-AU -> en` chain; it does not turn value equality alone into a general provenance guarantee.

The run completed 12 confirmed mutations (four version creations, six literal writes and two resets) and ten diagnostic reports, with all 40 item probes complete. Final exact reads verified the English marker and version 1 unchanged on each control. The two test items now retain version 1 in `en`, `en-NZ` and `en-AU`; requested-language fields are reset and intermediate-language markers remain available for follow-up. No publishing, deletion, template edit or language-configuration edit occurred.

At this stage the remaining evidence included mixed field sources, shared/unversioned and populated Standard Value behavior, intermediate explicit-empty handling, per-language field-rule overrides and effective environment switches. Subsequent checks are recorded below. Full schema introspection remains unavailable despite successful validation/execution of the narrow version mutation. Partial configuration coverage and independent read times remain limitations. No fallback resolver or comparison behavior was changed by this evidence-only follow-up.


### Mixed-field and intermediate-empty checks (2026-10-04)

Using the isolated page control and unchanged field definitions, an original `en-NZ` fallback-enabled read simultaneously returned a local description (fallback false), an Australian title (fallback true), and English keywords (fallback true). Distinct markers and exact candidate reads support independent per-field resolution in this controlled case. The three field definitions expose enabled shared language-fallback settings.

Writing literal empty values over the Australian title/text markers on the isolated page and component made each original `en-NZ` cross-check return empty with `containsFallbackValue: true`, despite populated English sources. Thus the observed chain stops at an explicitly empty intermediate value; skipping all empty candidates would produce an incorrect result.

Read-only scope observations found shared Standard Value fields with identical values across the three locales and no fallback flag. The page's unversioned fields were system fields; this is not a controlled test of unversioned content across item versions. Existing versioned defaults also showed a cross-check value with both `containsFallbackValue` and `containsStandardValue` true. Another default changed from empty in an exact read to populated/Standard Value in a cross-check without a fallback flag. Preserve the raw flags and observation mode; they are not mutually exclusive categories or sufficient source-language evidence.

The available MCP mutation surface intentionally permits only existing versioned content text fields and creation of the first local version. It cannot create isolated test templates, alter shared/unversioned fields, or create/read a second version. A controlled Standard Values precedence/override matrix and unversioned mutation matrix therefore require additional fixture support; read-only observations must not be reported as completion of those checks.


Resetting the intermediate title/text fields restored the original English markers on both page and component. The Australian test markers are now removed; the fields remain reset. The page retains a local requested-language description and English keyword marker for subsequent mixed-field checks.

For the disabled-field comparison, `canonicalUrl` has empty shared and per-language fallback settings in its metadata-locale definition, unlike the enabled fields. A distinct English marker was written only on the isolated content item. Exact `en-NZ`/`en-AU` reads and the original `en-NZ` cross-check stayed empty with fallback false, while enabled fields on the same response continued returning their source markers. Effective environment/per-language switches remain independently unknown; this is observed behavior under the current configuration, not a claim that an absent setting always means disabled.


A further requested-language reset was previewed to rule out an explicit empty local override in the disabled-field control. Its confirmation timed out before the pre-write journal checkpoint; the plan has no operation record and no write was retried. This final control remains pending, so the disabled-field comparison is observed evidence rather than the completed reset-controlled matrix.

This round completed seven confirmed mutations and seven diagnostic reports (28 item probes, all complete). Source title/text markers remained populated in English throughout the diagnostic observations. Only the two isolated test items were modified; nothing was published or deleted. Shared/unversioned mutations and template changes were not attempted. Raw evidence and operation IDs remain in local reports outside Git. This follow-up changes documentation only and requires no new extension build.


### Disabled-field control completed; isolated scope tooling (0.31.0)

The previously timed-out reset was prepared again and confirmed in a subsequent run. All four probes completed: the original requested-locale cross-check remained empty with fallback false after explicit reset, while English retained its canonical URL marker. This completes that control under the observed field configuration.

Version 0.31.0 adds the missing isolated-template and version-2 tooling. Its recipe and ownership boundaries have automated coverage; live fixture creation and the full Standard Values/shared/unversioned matrix remain pending an extension reload. The next run should create the fixture, collect the seeded default/source comparison, exercise local/defaulted override-empty-reset, and compare shared/unversioned edits across locales and versions 1 and 2. Do not report the new matrix as verified until those live observations complete.

### Controlled Standard Values and field scopes (2026-10-04)

After reloading 0.31.0, the isolated recipe completed all 14 journaled writes: a new template, section, five text fields, localized Standard Values and one content item. All subsequent writes targeted this new content item. Existing content and templates were not changed; nothing was published or deleted.

The defaulted versioned field had a distinct requested-language Standard Value and an explicit English source value. Observed results in `en-NZ` were:

| State | Exact locale | Original-locale fallback cross-check |
| --- | --- | --- |
| Untouched | Requested Standard Value; standard true, fallback false | Explicit English value; standard false, fallback true |
| Local override | Local marker; both flags false | Local marker; both flags false |
| Literal empty over override | Empty; both flags false | Empty; both flags false |
| Reset | Requested Standard Value; standard true, fallback false | Explicit English value; standard false, fallback true |

In this controlled configuration, a requested-language Standard Value did not prevent the fallback-enabled read from returning an explicit source-language value. A local override did, including an explicitly stored empty string. Reset restored the seeded behavior. This establishes the observed case, not every possible ordering of inherited defaults, source defaults and per-language rules.

The content item then received `en-NZ` version 2. Exact reads compared NZ versions 1 and 2 with Australian and English version 1 after each scope change:

- Updating the shared field through NZ version 2 changed all four observed locale/version combinations.
- Updating the unversioned field through NZ version 2 changed both NZ versions; Australian and English values stayed unchanged.
- Updating the versioned field through NZ version 2 changed only that version; NZ version 1 and the other locales stayed unchanged.
- Writing an explicit empty unversioned value cleared both NZ versions and suppressed the latest-version fallback cross-check, despite a populated English source. Reset left both exact NZ values empty but restored the English value with fallback true in the cross-check.

The disabled versioned control remained empty with fallback false throughout all seven diagnostics, while enabled fields in the same responses resolved source values. Shared values never acquired a fallback flag in these observations.

The round completed ten confirmed operations (23 individual writes), seven diagnostic reports with all 28 item probes complete, and 24 explicit-version reads. A local verification script asserted the expected values, flags, scopes of effect, returned versions and completed operation statuses against saved reports. Raw reports, IDs and the script remain outside Git. Final fixture state retains the shared marker across locales, the versioned NZ marker only in version 2, the reset defaulted field, and the reset unversioned NZ field with its English source intact.

This completes the planned controlled Standard Values override/empty/reset and shared/unversioned cross-version checks. Per-language field-rule overrides, effective environment switches, and broader default/inheritance combinations remain unverified. Historical reads here were exact reads; fallback-enabled historical-version behavior was not tested. Source-language identity is still not generally proven by value equality, and exact empty values still cannot distinguish explicit empty from reset. These findings support using Sitecore's original-locale effective read with explicit unknown provenance, while preserving exact stored-locale comparison and transfer behavior. No resolver, UI or publishing behavior changed in this evidence-only follow-up.

### Per-language rule experiment preparation (0.32.0)

The isolated definition's English metadata read confirmed a shared checkbox named `Enable Shared Language Fallback` and a versioned checkbox named `Enable Language Fallback`. Its NZ metadata version was absent. Version 0.32.0 adds a bounded, confirmed fixture-only tool to create that first metadata version if needed and set these two checkboxes. Live rule combinations remain pending a reload of this tooling.

The earlier proposed "local disable overrides shared enable" expectation needs correction. [Sitecore's configuration documentation](https://doc.sitecore.com/xp/en/developers/102/sitecore-experience-manager/fine-tune-your-language-fallback-configuration.html) describes the versioned setting as an additional enablement input when `LanguageFieldFallback.AllowVaryFallbackSettingsPerLanguage` is enabled; a false local value defers to the shared setting. When that switch is disabled, only the shared setting is considered. This is documented context, not evidence of the effective switch on this deployment.

The next live matrix should compare shared on/local off, shared off/local on, both off and both on, reading original-locale cross-checks for NZ and AU separately. Keep distinct English source markers and reset local content for rule precedence tests, then repeat local marker/explicit-empty/reset controls. Verify metadata readback and record actual behavior without inferring the environment switch from one negative result. Only fixture definitions may change; environment configuration stays untouched.

### Live per-language rule matrix (2026-10-05)

The rule tool was exercised on the isolated fixture's initially disabled versioned field, with a populated English source and empty NZ/AU content. Each mutation was confirmed in VS Code. A preceding attempt timed out before its pre-write journal checkpoint; exact NZ metadata still had version 0 and no operation record existed. The following run used fresh previews, not automatic mutation retries.

Definition readbacks confirmed the requested checkbox values after every rule change. The first change created NZ metadata version 1. Initial original-locale effective reads were:

| Shared setting | NZ setting | NZ result | AU result (no local metadata version yet) |
| --- | --- | --- | --- |
| Off, baseline | Absent | Empty, fallback false | Empty, fallback false |
| On | Off | English source, fallback true | English source, fallback true |
| Off | On | English source, fallback true | English source, fallback true |
| Off | Off | Empty, fallback false | Empty, fallback false |
| On | On | Empty, fallback false | English source, fallback true |

A read-only repeat of the last row, with AU read first, reproduced that unexpected NZ/AU split. An explicit AU metadata version was then created with its local checkbox off and the shared checkbox off, leaving NZ's local checkbox on. Both locales returned empty/fallback false. Repeating this combination in the opposite read order gave the same result. Thus the observed mixed-setting behavior did not establish reliable locale-specific precedence; absence of AU metadata alone is not a proven explanation.

With shared/NZ settings restored to on, the NZ content marker/empty/reset sequence returned the local marker (fallback false), literal empty (fallback false), then the English source after reset (fallback true). During these three stages, the untouched AU content's effective result alternated empty/source/empty despite no further rule writes. Exact English source reads stayed populated. These inconsistent effective responses prevent treating this matrix as a passing precedence test or proof of the environment switch. Cache invalidation, server routing or other runtime behavior are possible explanations, not verified diagnoses. No cache clear, server restart or environment-setting change was attempted.

Finally, both checkboxes were restored to off and read back as empty in English, NZ and AU metadata. Final effective reads in NZ and AU were empty/fallback false. The test content field remains reset in NZ version 2 with its English source intact. The newly created NZ/AU field-definition versions remain for follow-up; nothing was deleted or published and no real content/template was edited.

The run completed ten confirmed operations containing twelve writes, 24 diagnostic reports with all 96 item probes complete, and 24 exact metadata reads. A local verification script checked completed operation statuses, probe completeness, the unchanged English source, local marker/empty results and restored checkbox values, and preserved the differing effective results without asserting a successful precedence rule. Raw reports and the combined evidence remain outside Git. This is a documentation-only follow-up; no build or unit-suite rerun was needed.

Per-language rule precedence and effective environment configuration remain unresolved. Before using those settings for a resolver, investigate repeatability of effective reads and configuration/cache behavior on the server. Preserve exact-locale comparison semantics and label effective observations with unknown provenance/configuration where needed; do not infer a deterministic rule from these inconsistent responses.

### Diagnostic audit corrections (0.32.1, 2026-10-06)

Mock requests reproduced two collector validation gaps: wrong outer languages and pages from different numbered versions could previously be marked complete. The audit of the 96 prior live item observations found matching identities/languages, stable numbered versions within each probe and no duplicate field IDs. These gaps therefore do not establish the cause of the earlier inconsistent effective values. The original locale, fixed query arguments and cursor reset were correct; this diagnostic path has no content-response cache.

Format 3 validates the outer identity/locale on exact and field-fallback reads. A numbered-version change restarts the affected probe once from page one, requesting latest again with version omitted. Discarded attempts remain separate diagnostic evidence; repeated drift reports incomplete/item-changed. Page, byte and request limits cover both attempts. Stable versions are still not transactional snapshots and cannot detect every same-version edit.

The cross-check is now labeled a field-fallback read: the argument belongs to `item.fields`, not the outer item query. Outer returned identity/language/version is displayed separately and is not evidence of whole-item substitution or field-source provenance. Reports retain deduplicated fixed queries, actual request variables, per-request times and safe per-HTTP-attempt timing/status/retry evidence, including failed requests. They exclude headers, cookies, credentials and raw error messages. Backend identification/affinity remains deferred under B30, with no routing changes. These corrections use mock regression coverage; no new live observations or Sitecore writes were performed for this update.

### Bounded comparison delivery (2026-10-06, 0.33.0)

A read-only format-3 verification collected four reports with 16 complete item probes and 156 traced requests. NZ/AU exact and effective reads repeated consistently, without retries or discarded attempts. Schema remained unavailable, environment settings unknown and template traversal partial. No content changed. This verifies the current fixture state, not the earlier inconsistent rule-mutation cases.

The user approved implementing comparison behavior first: use Sitecore effective fields with explicit unknown source language, retaining exact evidence. This narrows the original resolver gate for the first delivery only. A calculated source resolver, verified chains, historical fallback, whole-item substitution, B03 publishing and B26 editor integration remain deferred. New tabs default to Exact locale; With fallback survives navigation and refreshes fields without rebuilding the tree. Field-transfer mode and stale-request guards apply in the extension host as well as the UI.
