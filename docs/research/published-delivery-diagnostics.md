# Published Delivery diagnostics — 2026-11-25

## Boundary and evidence

The existing ExperienceEdgeClient uses the Delivery layout query but discards GraphQL error/partial evidence. A separate LayoutDiagnosticClient retains bounded diagnostic evidence without changing publishing verification. Saved Traced publishing profile and Edge token are reused; CM Preview has a separate token.

The user reports an accepted Edge token and Grenadier catalog entry, with CM root /sitecore/content/IAL/Grenadier and Edge root /sitecore/content/IAL/Grenadier/Global. This is user-reported catalog evidence only; website endpoint mapping remains unverified.

## Rendering-definition investigation

Target: /sitecore/layout/Renderings/Feature/IAL/IAL-Forms/Grenadier/Test Drive Form, ID 904D4725-538E-469B-9317-4FA34C410316.

[Official Delivery query examples](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/query-examples-for-the-delivery-graphql-api.html) document item fields with name/value. [API differences](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/differences-between-the-preview-and-the-delivery-graphql-apis.html) warn that published field availability differs from Preview. Neither source establishes that this rendering or ComponentQuery is exposed on the configured endpoint.

The fixed probe checks the actual schema before reading this one identity. It never substitutes Authoring or local values. Live Dev schema support and published ComponentQuery were verified on 2026-11-25 via the saved Delivery credentials and MCP transport. A schema denial is unavailable evidence, not proof of absent content. Successful item access without the field is field-unavailable, not an empty query.

## Verification

Automated fixtures cover layout success, missing route, unresolved/unknown component state, HTTP200 errors/partial data, HTTP400 GraphQL errors, auth failures, no retries/redirect policy, streamed limits/cancellation/timeouts, credential redaction, ambiguous comparison, fixed rendering capability/results, and MCP exposure/credential separation. Live checks and automated checks must be recorded separately.


## Live observations (2026-11-25)

Dev, Grenadier, /Station Wagon, en: Delivery HTTP200/GraphQL success with route absent; Preview HTTP200/GraphQL success with route present and 39 observed components. Comparison is inconclusive; no publishing cause is inferred. The Delivery endpoint was the configured https://edge.sitecorecloud.io/api/graphql/v1. Website endpoint mapping is still unverified.

The fixed rendering probe passed its schema gate and returned the exact requested ID and expected /sitecore/layout/Renderings/Feature/IAL/IAL-Forms/Grenadier/Test Drive Form path. ComponentQuery was a published string of 3,745 characters, SHA-256 0d6dac9b21abec86209977941dcf60156d46cccaa1c0e0a1fada5aa5e7f778e9. It declares TDFormData with datasource/language inputs and includes datasource and country reads. The query was observed, not executed or substituted into a layout. No website execution, publish status or failure cause is established.

No Sitecore content, publishing state, deployments or caches were changed. Raw evidence stays in ignored local test output; credentials were used by the extension's saved-secret accessors, never extracted.

The additional known site-root selection Grenadier, /, en returned HTTP200/GraphQL success and a present route on both endpoints. All 22 occurrences matched by unique UID, with no ambiguous/unmatched identities. Preview reported 22 resolved components; Delivery omitted the resolution flag for all 22, recorded as unknown rather than unresolved. Field differences are observations, not proof of a publishing defect.

The additional /test-drive, en-GB selection is an explicitly labeled candidate for the reported public /en/gb/test-drive URL; this mapping was not established. Both endpoints returned HTTP200/GraphQL success and routes with 11 unique UID matches. TestDriveForm UID 1fa6783b-9643-481d-92e1-71e34cdf5092 and datasource 94525C3A-91ED-49C5-B7F3-EE8600F6FA42 agreed. Preview reported isContentResolved=false with no fields; Delivery omitted that flag and returned fields.errors containing: “The field targetItem does not exist on the type TextField.” The nested error location was line 73, column 5; this is server-reported query context, not automatically a line in the separately retrieved ComponentQuery. Top-level GraphQL success does not erase this nested evidence. The query was not corrected or executed separately. No cause beyond the observed component query error or public URL mapping is inferred.

Automated result: 543 unit tests passed; 125 extension-host tests passed. Packaging and isolated installed activation are checked separately. Live observations used the compiled MCP host; no user-desktop Computer Use was performed.
