# XM Cloud Sync backlog

Consolidated planning inventory as of 2026-09-14, reviewed against version 0.20.0. Unchecked entries are outstanding, not a commitment to implement them in this order. Product requirements remain in [PRODUCT_SPEC.md](PRODUCT_SPEC.md); completed release details are in [CHANGELOG.md](CHANGELOG.md).

Status: B01–B06 are explicit TODOs; B07–B15 are deferred enhancements; B16 is a known limitation; B17 is documentation cleanup; B18 has an agreed high-level plan and awaits implementation. Grouping does not change their priority or scope.

## Publishing and delivery verification

- [ ] **B12 — Automatic publishing after synchronization.** Design an optional workflow that publishes after successful synchronization.
- [ ] **B13 — Authenticated Vercel integration.** Explore project APIs, protected-deployment access, cache invalidation and deployment logs. Configured deployment URLs already work; automatic deployment-URL discovery is not implemented and is a possible extension, not an approved requirement.
- [ ] **B14 — Interactive-component verification.** Extend beyond existing selector-based Browser DOM assertions to interactive behavior. Basic Browser DOM verification is already implemented.

## Plug-ins

- [ ] **B01 — Connection-scoped task plug-ins.** Discover explicitly connection-scoped manifests and run administrative tasks without a selected item, such as rebuilding indexes or the link database. Preserve Workspace Trust, secret-free connection context and credential boundaries; confirm disruptive server-wide operations.
- [ ] **B02 — Plug-in runs as Operations.** Integrate item- and connection-scoped tasks with the common lifecycle, evidence view, Run Again and Operation Sequences. Persist manifest identity, targets and secret-free inputs rather than runtime state. Missing or materially changed plug-ins must pause replay for review.
- [ ] **B16 — Add language versions through the JavaScript task broker.** The broker currently cannot create a missing language version; modal slide-in updates fail explicitly when an existing Table child needs one. This is a documented limitation, not yet a committed feature. Source: [README.md](README.md).

## Language fallback

- [ ] **B03 — Fallback-aware publishing diagnostics.** Capture effective delivery expectations separately from stored localization. Preserve requested language, resolved source language and fallback chain; distinguish item fallback on version-0 items from field fallback on existing versions. Verify Edge in the requested language. Skip version-0 items only when neither a local version nor applicable fallback exists. Explain fallback-derived evidence and initial publication of fallback dependencies; do not enable fallback globally for comparison and transfer.
- [ ] **B04 — Comparison and transfer language-fallback policy.** Decide Authoring query fallback behavior after verifying missing-language responses, containsFallbackValue, item/field fallback and synchronization consequences. Do not hide missing translations or write resolved fallback values as local content. Coordinate with B03 while keeping stored-state comparison distinct from effective-delivery verification.

## Comparison and tree navigation

- [ ] **B07 — Specific item-version selection.** Allow comparison of selected numbered versions instead of only the latest version in each selected language.
- [ ] **B08 — Expand All size preflight.** Estimate unique left/right subtree items without materializing the webview tree. Support cancellation and either an exact count or a configurable warning threshold before expansion.
- [ ] **B10 — ID-first/path-fallback comparison identity.** Add an alternative identity mode for matching items between environments. This is separate from the completed ID/path navigation feature.
- [ ] **B18 — Browse mode for a single connection (planned; not implemented).** Opening a connection defaults to one full-width content tree. Use the familiar comparison-tree presentation and navigation, expose meaningful single-connection actions, and provide an explicit Browse / Compare switch. See the agreed plan below.

### B18 — Agreed high-level plan

**Entry and presentation.** Opening a connection opens Browse mode without asking for a second connection. Show connection and language selectors, the existing ID/path/name input, and one full-width tree. Retain icons, indentation, lazy expansion, loading/error feedback, selection and refresh behavior. Omit the second column, difference indicators, swap, language lock and directional transfer controls in Browse mode. Existing explicit comparison entry points should still open Compare mode.

**Single-connection actions.** Support expand/collapse, refresh and cancellation; ID/path lookup and indexed name search on the selected connection; sites and favorites; copying IDs/paths; item details; and public-page navigation for eligible items. Publishing is a first-class Browse workflow: retain Standard, Traced and Power Publish, together with matching item task plug-ins. Preserve the existing Operations queue, history, confirmation and Workspace Trust behavior. Cross-connection diff and transfer actions belong in Compare mode.

**Item Details.** In Browse mode, the bottom pane presents one item's metadata and field values, rather than a paired field comparison. Retain field visibility controls and shared/unversioned markers. Show ID, path, template, language and version, plus Open public page when available. The initial scope is read-only field inspection; direct field editing is not included. Explicit publishing and task actions remain available.

**Browse to Compare.** Put the browsed connection on the left and reuse its last comparison partner when available. Remember this relationship per browsed connection across reloads, using saved connection identities rather than secrets. Restore the partner language as well, validating that the saved connection and language remain available. Keep the partner changeable. If no partner is remembered or the remembered connection was deleted, prompt the user to select one; do not choose an arbitrary connection. Cancelling leaves Browse intact. If a saved language is unavailable, request a valid selection rather than silently changing the comparison.

**Same-connection comparison.** Allow the same connection on both sides with independently selected languages, for example English versus German. Keep language locking explicit in Compare mode and do not silently apply it in a way that overwrites a restored cross-language comparison.

**Compare to Browse and state.** Let the user choose which comparison side to retain and remember that choice for subsequent switches, while allowing it to be changed. Preserve the retained side's connection, language, root and selected item. Preserve expansion and scroll state where practical, and keep mode-specific navigation state so switching does not unnecessarily restart browsing. New navigation or mode changes must supersede pending loads and prevent stale results from replacing the current view.

**Implementation acceptance.** Verify opening with one configured connection; search and details in Browse; publishing and task availability; absence of diff/transfer controls; first-time partner selection and cancellation; remembered partner/language after reload; deleted partners and unavailable languages; same-connection cross-language comparison; explicit language-lock behavior; and state restoration during cancelled or superseded loading. Use domain tests and extension-host checks where appropriate, plus focused manual checks for tree layout, keyboard access and mode transitions. This plan records future behavior; no implementation has been performed in this planning task.

## Transfers and synchronization

- [ ] **B05 — Accurate subtree-preflight progress wording.** Replace “X tree levels checked” with wording such as “X parent items scanned.” The counter tracks loaded direct-child collections on source and target, not tree depth, and has no known total until traversal ends.
- [ ] **B11 — Reference ID remapping.** Remap references between independently created environments whose corresponding items have different IDs.

## Operations and recovery

- [ ] **B06 — Consistent Operation Sequence persistence.** Migrate definitions and runs into one versioned state object so interruption between independent storage writes cannot leave a partial snapshot. Preserve existing data through migration and test recovery. Source: [operationSequenceStore.ts](src/operations/operationSequenceStore.ts).
- [ ] **B15 — Automatic undo or compensating rollback.** Design recovery for completed content-changing operations, accounting for partial failures and intervening changes.

## Connections and caching

- [ ] **B09 — Clear Connection Cache command.** Provide an explicit connection-level cache clearing action.

## Documentation cleanup

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
