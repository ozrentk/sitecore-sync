# XM Cloud Sync backlog

Consolidated planning inventory as of 2026-09-14, reviewed against version 0.20.0. Unchecked entries are outstanding, not a commitment to implement them in this order. Product requirements remain in [PRODUCT_SPEC.md](PRODUCT_SPEC.md); completed release details are in [CHANGELOG.md](CHANGELOG.md).

## Explicit TODOs

- [ ] **B01 — Connection-scoped task plug-ins.** Discover explicitly connection-scoped manifests and run administrative tasks without a selected item, such as rebuilding indexes or the link database. Preserve Workspace Trust, secret-free connection context and credential boundaries; confirm disruptive server-wide operations.
- [ ] **B02 — Plug-in runs as Operations.** Integrate item- and connection-scoped tasks with the common lifecycle, evidence view, Run Again and Operation Sequences. Persist manifest identity, targets and secret-free inputs rather than runtime state. Missing or materially changed plug-ins must pause replay for review.
- [ ] **B03 — Fallback-aware publishing diagnostics.** Capture effective delivery expectations separately from stored localization. Preserve requested language, resolved source language and fallback chain; distinguish item fallback on version-0 items from field fallback on existing versions. Verify Edge in the requested language. Skip version-0 items only when neither a local version nor applicable fallback exists. Explain fallback-derived evidence and initial publication of fallback dependencies; do not enable fallback globally for comparison and transfer.
- [ ] **B04 — Comparison and transfer language-fallback policy.** Decide Authoring query fallback behavior after verifying missing-language responses, containsFallbackValue, item/field fallback and synchronization consequences. Do not hide missing translations or write resolved fallback values as local content. Coordinate with B03 while keeping stored-state comparison distinct from effective-delivery verification.
- [ ] **B05 — Accurate subtree-preflight progress wording.** Replace “X tree levels checked” with wording such as “X parent items scanned.” The counter tracks loaded direct-child collections on source and target, not tree depth, and has no known total until traversal ends.
- [ ] **B06 — Consistent Operation Sequence persistence.** Migrate definitions and runs into one versioned state object so interruption between independent storage writes cannot leave a partial snapshot. Preserve existing data through migration and test recovery. Source: [operationSequenceStore.ts](src/operations/operationSequenceStore.ts).

## Deferred enhancements

- [ ] **B07 — Specific item-version selection.** Allow comparison of selected numbered versions instead of only the latest version in each selected language.
- [ ] **B08 — Expand All size preflight.** Estimate unique left/right subtree items without materializing the webview tree. Support cancellation and either an exact count or a configurable warning threshold before expansion.
- [ ] **B09 — Clear Connection Cache command.** Provide an explicit connection-level cache clearing action.
- [ ] **B10 — ID-first/path-fallback comparison identity.** Add an alternative identity mode for matching items between environments. This is separate from the completed ID/path navigation feature.
- [ ] **B11 — Reference ID remapping.** Remap references between independently created environments whose corresponding items have different IDs.
- [ ] **B12 — Automatic publishing after synchronization.** Design an optional workflow that publishes after successful synchronization.
- [ ] **B13 — Authenticated Vercel integration.** Explore project APIs, protected-deployment access, cache invalidation and deployment logs. Configured deployment URLs already work; automatic deployment-URL discovery is not implemented and is a possible extension, not an approved requirement.
- [ ] **B14 — Interactive-component verification.** Extend beyond existing selector-based Browser DOM assertions to interactive behavior. Basic Browser DOM verification is already implemented.
- [ ] **B15 — Automatic undo or compensating rollback.** Design recovery for completed content-changing operations, accounting for partial failures and intervening changes.

## Known limitation and documentation cleanup

- [ ] **B16 — Add language versions through the JavaScript task broker.** The broker currently cannot create a missing language version; modal slide-in updates fail explicitly when an existing Table child needs one. This is a documented limitation, not yet a committed feature. Source: [README.md](README.md).
- [ ] **B17 — Correct the stale deferred-verification entry.** PRODUCT_SPEC.md still lists “Browser DOM and interactive-component verification” together as deferred. Remove the already implemented Browser DOM portion and retain only the additional interactive behavior described in B14.

## Recently completed — excluded from outstanding work

- [x] Connection-wide exact ID/path navigation with left-first lookup, ancestor reveal, cancellation and scope widening (0.16.0).
- [x] Shared public-page URL template, connection/site values, page and local-datasource resolution, comparison and Field Diff navigation, and publishing URL integration (0.17.0).
- [x] Indexed name search in the shared input, with left-first search, pagination and keyboard navigation (0.18.0).
- [x] Simplified global template setup, language/region inference with optional overrides, separate base-URL configuration and homepage preview (0.19.0).
- [x] Optional template setup after adding a connection, skipped when a shared template already exists (0.20.0).
- [x] Site-click navigation using existing comparison navigation behavior (0.11.0); site/favorite loading indicators followed in 0.12.0–0.13.0.

## Accepted current limits

Public-page routes use the existing Home-relative slug calculation; custom routing, aliases and rewrites may need adjustments. Datasource navigation requires a page ancestor and does not establish exclusive page usage. Name search depends on index freshness and permissions and is bounded to 500 index records. These are documented limits, not newly approved implementation tasks.

## Maintenance

Use this file as the single backlog inventory. Add newly agreed work here, preserve stable IDs, and mark entries complete with a release or commit reference. Keep detailed requirements and nearby source notes aligned without treating duplicate mentions as separate tasks. This inventory records known work; it is not an exhaustive defect audit.
