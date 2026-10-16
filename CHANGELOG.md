# Changelog

## 0.48.0 — 2026-10-16

- Extend Visual editing to nested inline spans without flattening their wrappers, classes or style attributes; preserve heading levels, text spacing and blank paragraphs.
- Display literal single-declaration text alignment through bundled, scoped CSS rules. Original classes and arbitrary CSS remain inert; no website stylesheets are fetched.
- Protect even unstyled span nesting against destructive split/join operations. Keep exact no-op mode switches, host undo/redo, pending-input freeze, Save and backup behavior.
- Add the supplied finance-content example and nested formatting, paste, alignment and persistence regressions. Tables, managed links, visual media and formatted paste remain outside the supported profile.

## 0.47.0 — 2026-10-16

- Add a conservative Tiptap Visual mode for paragraphs, headings, bold, italic, underline and line breaks, using the existing HTML draft and Save workflow.
- Check original source tokens before visual admission. Unsupported, repaired, identity-sensitive and complex markup stays HTML-editable with a reason; unchanged mode switches retain exact raw source.
- Preserve CSS, image/DAM metadata and inter-block whitespace as inert data. Block visual operations that would remove protected metadata; display styling remains in the isolated Preview.
- Support plain-text paste and native host undo; reject formatted paste/drop rather than stripping content. No visual media, links, lists, tables or page/fallback editing is added.
- Record future action-icon consistency work as B32. B31 remains a known intermittent test failure, with no new release exception.

## 0.46.0 — 2026-10-16

- Add HTML source editing for eligible ordinary-item Rich Text fields, with a separate read-only sandboxed Preview.
- Preserve raw source and mixed line endings across unchanged mode switches, drafts, backup and Save; integrate pending composition with panel/revision-pinned synchronization and native undo after Save.
- Retain exact-locale, version, fallback and system/page protections. Visual editing and media editing remain deferred.
- B31 remains unresolved; the v0.45.0 release exception does not apply to this version.

## 0.45.0 — 2026-10-16

- Isolate Rich Text previews in sandboxed frames, preserving inline formatting and embedded CSS while blocking scripts, navigation and external requests.
- Rich Text remains read-only. Tiptap and ProseMirror compatibility spikes are evaluation tooling, not shipped editing functionality.
- Known issue (B31): the General Link destination-focus expansion integration check fails intermittently across verification runs; normal interactive reproduction remains unverified. The release accepts this coverage gap, with investigation deferred.
- The v0.45.0 publishing workflow accepts only B31's exact assertion failure, reports it explicitly, and still blocks on all other failures. Branch verification remains strict; remove the temporary exception with the B31 fix.

## 0.44.1

- Preview ordinary SVG logos using a bounded shape-only allowlist; reject scripts, external references, styles and unsupported markup.
- Move Image/File attributes and stored XML into field information, keep the main field compact, and distinguish certificate and unsupported-SVG failures.

## 0.44.0

- Make unsupported editor fields inspectable: Image/File metadata, on-demand safe asset previews/reference resolution, inert Rich Text formatting with original HTML, and explicit empty/unavailable/raw states.
- Keep asset failures visible without losing metadata; scope requests to the captured connection and cancel obsolete results. Preserve unsupported values when saving other fields.
- Show matching Image/File metadata and Rich Text/source presentation in Item Details without changing comparison or transfer behavior.

## 0.43.1

- Inset expanded General Link properties with surrounding spacing to visually group them within their field.

## 0.43.0

- Make General Link compact with keyboard-accessible type buttons, one destination, inline expandable properties and a collapsed summary. Validation errors stay expanded.
- Preserve per-type temporary destinations and properties across switching, Undo/Redo and backup/reload. Save writes only the active type; Save/Clear/Revert discard temporary alternatives.
- Preserve protected custom/DAM metadata, unsupported type identification and existing Source-aware picking. No automatic save or link execution.

## 0.42.0

- Add compact Name Value List rows with lossless encoding, explicit add/remove/clear and validation. Preserve existing duplicates and reject new duplicate keys or malformed rows.
- Add structured General Link editing for internal, HTTP(S), email and anchor links, with Source-aware item picking. Preserve unknown XML/DAM attributes and original raw values; unsupported variants remain read-only.
- Retain changed-only Save, exact-locale protection, conflict checks, backups and Undo/Redo, including restoration after Save/Clear. No link execution, asset selection, media upload or publishing is added.

## 0.41.1

- Show only the final item name in picker headers instead of the shortened breadcrumb; preserve full-path tooltips and tree navigation.

## 0.41.0

- Replace inline item choices with compact, viewport-bounded searchable popovers. Multi-selection uses Add items, persistent Added indicators and add-only result rows; single-selection closes after choosing.
- Keep search fixed above scrolling results, shorten Source breadcrumbs, show relative paths only for duplicate labels, and retain full paths/Source expressions in tooltips. Add accessible close/keyboard navigation and explicit child-level tree navigation.
- Preserve selected-list removal/reordering, draft Undo/Redo, Source validation and Save behavior.

## 0.40.0

- Replace selected-list Move up/down buttons with same-field drag handles and Alt+Up/Alt+Down keyboard reordering for Multilist, Treelist and TreelistEx. Add insertion markers, edge scrolling, compact removal, full-label tooltips and accessible move announcements.
- Make completed reorders coherent native Undo/Redo edits; existing draft edits use the same event model. Preserve exact reference tokens and validate reorder snapshots without changing Save or Source protections.

## 0.39.0

- Support bounded relative immediate-child queries with one exact template-ID filter for Droplist, Droplink, Checklist and Multilist, including the Hotspots Source form.
- Resolve choices from the pinned edited item and validate fresh Source membership before saving; preserve retained unavailable references. Other query forms and grouped/tree query Sources remain read-only.

## 0.38.0

- Add Checklist, Multilist, Treelist and TreelistEx editing through the existing draft, Save/Revert and recovery pipeline.
- Preserve unresolved references and stored ID representations; support explicit add/remove, ordered list movement and lazy tree browsing. Checklist has no ordering controls.
- Validate newly added references against fresh supported Sources before Save. Query/parameterized Sources and malformed or duplicate stored lists remain read-only.

## 0.37.7

- Merge inherited template sections with the same name into one editor group, preserving field order and prior expansion choices.
- Resolve editor headings from template-field Title metadata instead of Authoring value labels such as “standard value”; keep internal names in the information box.

## 0.37.6

- Fix editor section ordering: equal section sort orders now use section names before field-level ordering, so fields cannot pull their section ahead of another group.

## 0.37.5

- Group editor fields by Sitecore section identity, preventing repeated headings when section sort orders match.
- Add keyboard-accessible collapsible sections; standard-only groups start collapsed and expansion choices survive editor refreshes.

## 0.37.4

- Extend the information popover to every editable and read-only field, with metadata and stored values. Reference paths remain in the popover.
- Preserve whitespace and allow scrolling for long stored values.

## 0.37.3

- Compact selection fields into a name-only textbox with Clear on the right; clicking or keyboard-opening the textbox loads choices.
- Close choices after selection, Escape, outside click or focus leaving the field.
- Move selection metadata, stored value and full item path into a hover/click/focus information popover.

## 0.37.2

- Resolve selected Droplink, Grouped Droplink and Droptree names/paths automatically when fields appear, independently of loading their choices.
- Preserve stored values and drafts, show unavailable-reference feedback, and discard stale label responses after edits, refresh or disposal.

## 0.37.1

- Remove the redundant Clear button from checkbox fields; check or uncheck directly.
- Accept literal punctuation such as braces in returned selection item paths without weakening Source restrictions or membership checks.

## 0.37.0

- Add source-aware single-selection controls for Droplist, Droplink, Grouped Droplist, Grouped Droplink and Droptree.
- Support explicit Source root paths/IDs with searchable grouped lists and lazy tree navigation; keep unsupported source forms read-only.
- Preserve unresolved existing values, prevent ambiguous name selection, and revalidate source membership before saving through the existing journal/recovery flow.

## 0.36.1

- Keep open item-editor resources stable while persisting save journals in a separate state file, with recovery of existing drafts.
- Report the failing save stage and safe permission, HTTP, response-validation or cancellation details while retaining drafts and blocking uncertain write retries.

## 0.36.0

- Add Edit… from Browse and the clicked Compare side, opening a dedicated item editor pinned to connection, item, locale and numbered version.
- Add basic text, checkbox, integer, number, date and explicitly UTC datetime controls; preserve untouched values and keep unsupported/fallback fields read-only.
- Add Save/Revert, conflict checks, native dirty tabs/backups, persisted save tracking and readback reconciliation without automatic mutation retries or version creation.

## 0.35.0

- Make displayed Item Details paths copyable like IDs in Browse and on each Compare side, with keyboard-accessible buttons and inline success/failure feedback.
- Keep identity-copy feedback visible without re-rendering away the success mark; validate path copies against the displayed host snapshot.

## 0.34.2

- Show an expected-source hint for fallback fields when their own item has a suitable configured candidate, consistently in Browse, Item Details and Compare.
- Explain candidate provenance and its chain in the tooltip; retain unknown sources when no suitable candidate exists. Resolution and write decisions remain unchanged.

## 0.34.1

- Position Browse's Fallback toggle immediately to the right of the language selector.

## 0.34.0

- Enable synchronized Fallback toggles in Browse and Item Details as well as Compare.
- Display Authoring's effective fields for missing translations while retaining the requested locale and version 0.
- Show bounded, validated configured item-fallback candidates separately from unknown effective provenance; never substitute candidate content.
- Distinguish empty fallback responses from exact-locale absence. Preserve read-only fallback comparisons and stale-request guards.

## 0.33.2

- Replace the fallback dropdown with synchronized Fallback toggles in the tree comparison and Field Diff toolbars; use a Lock Languages toggle in the tree toolbar.
- Remove duplicate fallback-mode labels, the Exact locale values disclosure and the field-transfer reminder while retaining transfer guards.

## 0.33.1

- Removed the missing-page-presentation warning from Item Details and Field Diff. Items without a detected page quietly omit the public-page link.

## 0.33.0

- Add explicit Exact locale / With fallback comparison modes, preserving tree expansion and selection when switching.
- Compare Sitecore-provided effective fields independently on each side, retain inspectable exact values, and label unverified fallback sources unknown.
- Restrict field transfers to Exact locale and reject stale transfers and detail results across mode changes. Browse, publishing and tree transfers keep their existing semantics.

## 0.32.1

- Validate fallback diagnostic outer item identity and requested locale without rejecting legitimate fallback field values.
- Restart a paginated probe once from page one on numbered-version drift; separate discarded evidence and report repeated drift as incomplete/item-changed within shared collection budgets.
- Label the original-locale cross-check as an item.fields-only field-fallback read and expose outer returned metadata separately.
- Include fixed queries, actual variables/cursors, omitted/latest version selection, and safe HTTP attempt timing/status/retry evidence in diagnostic format 3. Preserve existing routing and authentication behavior.

## 0.32.0

- Add confirmed MCP control of the two fallback rule checkboxes on isolated fixture field definitions, including first metadata-language version creation when needed.
- Preserve fixture ownership, stale-preview checks, bounded journaling and unknown-outcome handling for per-language rule experiments.

## 0.31.0

- Add confirmed isolated fallback scope fixtures with their own template, five text fields, localized Standard Values and content item.
- Add journal-bound fixture field edits/resets and second-version creation without widening general shared/system editing.
- Support explicit-version MCP item reads for controlled cross-version comparisons.

## 0.30.0

- Add previewed MCP creation of the first local language version and explicit content-field reset for controlled fallback testing.
- Validate the version mutation contract without execution before preview, preserve confirmation and stale-state checks, and journal uncertain outcomes without retries.

## 0.29.0

- Add explicitly started local MCP access for selected connections, with path-based reads, indexed search, language/site discovery and fallback diagnostics.
- Add previewed, confirmed fallback test creation and exact-locale content field updates with session mutation controls, stale-state checks and persisted recovery records.
- Bundle the stdio MCP server and display client setup instructions; keep Sitecore credentials inside VS Code and revoke access on stop.

## 0.28.1

- Keep fallback test and diagnostic GUID/locale textboxes open when switching windows to copy values.

## 0.28.0

- Add Create Fallback Test Items and Diagnose Fallback Test Items commands, with confirmed template-based creation, workspace recovery records and exact/fallback evidence collection.
- Follow configured fallback-language names as well as GUID references.
- Keep test content unpublished and preserve existing content and template settings.

## 0.27.0

- Extend the Authoring fallback diagnostic with exact language-chain reference, field-definition and template/Standard Values evidence, explicit limits and unknown environment settings.
- Recognize version-0/null-fields responses as completed observations rather than invalid API responses.
- Keep the same connection/item/locale inputs; select **Item probes and fallback configuration** to collect the expanded version-2 report.

## 0.26.0

- Add **Collect Authoring Fallback Diagnostic** to the Command Palette, using saved connection credentials without requiring the browser Playground.
- Collect the schema and optional paginated exact-locale/fallback cross-check evidence into an unsaved JSON report, with cancellation, collection limits and credential redaction.
- Keep comparison, transfer and publishing semantics unchanged while live fallback provenance is investigated.

## 0.25.2

- Recover removed comparison endpoints in Browse without silently selecting another connection; show an explicit connection choice when the browsed source is missing.
- Clear content, language and navigation caches when connection endpoints change, and reject requests superseded while credentials are loading.
- Record B18 automated and browser verification separately from pending manual desktop and live Sitecore acceptance.

## 0.25.1

- Always retain the left comparison side when switching to Browse, preserving its language and navigation. Remove the Keep in Browse selector and side-choice prompt; ignore old retained-side preferences.

## 0.25.0

- Add a visible Browse / Compare selector with the active mode highlighted.
- Remember each browsed connection's comparison partner and language; prompt for missing partners, unavailable languages and conflicting language locks without losing the current view on cancellation.
- Remember the side retained in Browse and preserve its root, selection, loaded branches and scroll through mode switches within the open panel.
- Remove Browse's toolbar Refresh button; retain context-menu refresh and show Cancel loading only during cancellable loads in either mode.

## 0.24.2

- Accept null publishing-language metadata without pausing the queue; continue honoring the reported job state, completion and failure flags.

## 0.24.1

- Correct the shared bottom-panel tab name to Item Details.
- Distinguish hidden fields from an empty Authoring response, report language/version context and provide Show all fields.
- Identify invalid publishing-status fields without exposing response values; report the remote outcome as unknown.

## 0.24.0

- Add read-only Item Details to Browse with item metadata, one field column, scope/source markers and separate All/Hidden visibility controls.
- Enable Standard, Traced and Power Publish, matching item tasks, public-page links and copying item IDs/paths from Browse.
- Reject stale detail responses and action contexts while preserving Compare field differences and transfers.

## 0.23.0

- Open connections in Browse with one full-width content tree, connection-scoped search, sites/favorites and navigation controls.
- Keep comparison actions out of Browse and preserve explicit two-sided Compare workflows. Single-item details/actions and complete mode switching remain planned.

## 0.22.4

- Distinguish valid Experience Edge tokens from site-catalog mismatches; show Authoring and Edge sites and allow an explicit scope override on Save.

## 0.22.3

- Give the Experience Edge token the same single masked field and concise hints as other secrets; empty input keeps the stored token.

## 0.22.2

- Simplify secret placeholders and helper text, shorten the Test connection button, and show connection test results in a modal.

## 0.22.1

- Simplify client and organization secrets to a single masked field each: enter a replacement or leave empty to retain the saved secret.

## 0.22.0

- Add a unified Connection Settings dashboard for creating and editing connections, deployment monitoring, site URL values and traced-publishing defaults.
- Validate entries inline, test unsaved credentials, discover sites, and keep saved secrets masked with explicit keep/replace/remove controls.
- Preserve existing configurations and favorites, reject stale edits and attempt rollback if saving fails.

## 0.21.2

- Distribute installable VSIX files through GitHub Releases, with version-tag and main-branch validation.
- Gate CI and releases on redacted Git-history and packaged-extension secret scans.
- Include all features and fixes through 0.21.1 in the first GitHub download.

## 0.21.1

- Open public-page links directly from comparison and Field Diff without a redundant confirmation dropdown.

## 0.21.0

- Add Configure Public URL Values to each connection’s context menu, opening URL setup for that connection and its selected site.

## 0.20.1

- Show internal field names alongside differing labels in comparison and Field Diff to distinguish repeated labels.
- Recognize public pages from final-layout rendering assignments when the layout ID is inherited from Standard Values and absent from the returned fields.
- Clarify that failed page detection can reflect missing inherited presentation, rather than necessarily a shared datasource.

## 0.20.0

- Offer optional shared URL-template setup after adding a connection when no shared template exists, with an explicit Not now action.

## 0.19.0

- Simplified shared URL-template setup: no connection/site selection, mappings or preview input.
- Infer language and region from the selected language tag, with optional existing overrides.
- Offer homepage preview after saving; configure connection/site base URLs in a separate command.

## 0.18.0

- Enabled indexed name search in the comparison input with left-first lookup, bounded pagination, keyboard-accessible results and cancellation.
- Search result selection reuses exact navigation on the matching connection.

## 0.17.0

- Added a shared public-page URL template, per-connection/site mappings, URL previews and public-page actions in comparison and Field Diff.
- Resolve page-local datasources through their nearest page ancestor and prefill diagnostic publishing application URLs with the same resolver.

## 0.16.0

- Added connection-wide exact item ID/path navigation with left-first lookup, cancellation, ancestor reveal and automatic scope widening.

## 0.15.2

- Show language-switch labels only on comparison sides whose language is changing.

## 0.15.1

- Centered language-switch labels above both comparison sides and shortened each label to its target language.

## 0.15.0

- Prepared language changes in the background while keeping the displayed tree stable, swapping the new view in only when its branches and required item details are ready.
- Added requested/displayed-language status and Retry after loading failure, with preserved selection and scroll position.
- Blocked content-changing comparison actions during preparation and deferred Field Diff until the replacement view commits.

## 0.14.0

- Preserved comparison selection and expanded branches across language-only changes, restoring the selected item first and refreshing its open Field Diff.
- Reused unchanged-side data, restored other expanded branches progressively, and added nearest-ancestor fallback with inline explanations when restoration is incomplete.
- Prevented superseded restoration from overriding explicit navigation and rejected stale language-scoped child/detail requests.

## 0.13.1

- Renamed comparison context actions to Tree Transfer Left > Right and Tree Transfer Right > Left.
- Clarified every tree transfer confirmation that transferred items include all source languages and versions, regardless of the selected comparison language.

## 0.13.0

- Extended navigation loading indicators to sites: the globe becomes spinning arrows while loading and is restored afterward, independently of favorites with the same path.

## 0.12.0

- Added a spinning loading indicator to favorites while their comparison navigation is in progress, with cleanup on completion, failure, cancellation, and supersession.

## 0.11.0

- Added site-click navigation in Connections: reveal the site root in an existing comparison using the same cached and lazy ancestor-loading behavior as favorites.

## 0.10.1

- Fixed intermittent favorite reveal failures caused by overlapping ancestor loads discarding already-loaded descendants in the comparison tree.

## 0.10.0

- Added safe operation replay from completed or failed Operations records. Replay persists semantic input while rebuilding current field fingerprints, subtree inspection context, Authoring snapshots, descendants, publishing batches, route identity, and Power Publish reference graphs.
- Added reusable, versioned Operation Sequences containing ordered field transfer, subtree transfer, Standard Publish, Traced Publish, and Power Publish intents without credentials or runtime checkpoints.
- Added sequence creation from an existing operation, adding operations to editable sequences, reordering and removing operations, editing and duplicating definitions, and shared Operation Details evidence.
- Added explicit sequence execution without a sequence queue. Only one sequence runs at a time; paused sequences release Operations so standalone work or another sequence can run on demand.
- Added immutable running and paused definitions, **Paused on operation** recovery with Retry/Skip/Stop actions, graceful stopping after an already-started operation, global Operations Play/Pause integration, restart recovery, and the latest ten sequence-run history records.
- Added Power Publish replay safety based on selected and previously observed collapsed-scope identities. A newly observed external scope pauses a sequence before publishing, while standalone replay can reopen interactive Power Publish review.

## 0.9.16

- Excluded Authoring snapshots with version `0` in the requested language from mandatory Raw Experience Edge identity verification.
- Added explicit trace evidence for each version-0 item skipped because it has no language version that Edge can expose.
- Reduced the Raw Experience Edge propagation retry window from five minutes to 30 seconds for Traced and Power publishing.

## 0.9.15

- Moved the expandable Power Publish batch list into the **Sitecore publishing** stage and kept it expanded while publishing is active.
- Added persisted per-batch submission, Sitecore state, processed-item, and completion progress so Operation Details advances throughout the batch sequence.
- Added incremental aggregate Experience Edge progress in bounded groups and changed subsequent polling passes to recheck only items that have not matched yet.
- Restored the rotating activity indicator on an Operations row while a publishing operation is running diagnostic verification.

## 0.9.14

- Changed Power Publish to submit and complete every dependency batch before beginning Raw Experience Edge verification.
- Added one aggregate final Edge check for every observed item in the selected publish plan, with identity checks for all items plus selected and graph-forming field checks where applicable.
- Added **Retry final Edge verification** and **Force republish missing items** recovery actions. The latter creates a new durable Full-publish operation containing only the missing or mismatched items.
- Replaced per-batch checkpoint presentation with persisted Power Publish batch history and final Edge verification evidence.

## 0.9.13

- Stopped Power Publish reference discovery from following Sitecore standard-template metadata fields such as `__Editors`.
- Changed unresolved references from custom item fields from queue blockers to visible warnings.
- Retained unresolved warning details in the Power Publish operation evidence when the user proceeds.

## 0.9.12

- Added inline Power Publish readiness diagnostics to every selected scope that cannot be queued.
- Exposed unresolved reference evidence—including its available source item, field, target, and resolution error context—directly in the collapsed scope graph.
- Replaced the generic disabled-queue footer with the affected scope and blocking reason.

## 0.9.11

- Removed template, layout, system, and unsupported reference targets from the interactive Power Publish scope graph.
- Retained non-publishable references as aggregate per-scope planning evidence instead of disabled tree nodes.
- Changed the 200-reference scan budget to count only unique external content/media scope candidates; internal references, configuration targets, unsupported targets, and external URLs no longer consume it.

## 0.9.10

- Fixed collapsed Power Publish scopes so structural descendants are always absorbed beneath their scope root instead of appearing as followable external nodes when Sitecore descendant publishing is disabled.
- Separated scope discovery from execution strategy: enabled descendant delegation publishes selected scope roots through Sitecore, while disabled delegation publishes every inspected item in the selected scopes explicitly.
- Made Power Publish load structural descendant assertion fields independently of the Sitecore descendant-publishing option.

## 0.9.9

- Replaced Power Publish's eager recursive GUID crawl with a user-directed **collapsed scope graph**. Each node represents one Sitecore structural scope and exposes only references that leave its boundary.
- Added a dedicated **Review Power Publish Scope** view. Selecting an unscanned scope scans it immediately; expanding a scope can inspect it without selecting it, and discovered external scopes remain opt-in.
- Added scope-level caching, item-ID deduplication, cycle-safe graph rendering, visible scan progress, and resumable 500-item/200-reference scan budgets.
- Made layout discovery field-aware: only component datasource attributes are followed from layout fields instead of treating every presentation GUID as a content dependency.
- Added field-aware discovery for item-link, General Link, Image, File, and media references, including relative `local:/` layout datasources, media-library classification, external-URL evidence, and default exclusion of template/layout/system references.
- Renamed the Power Publish option to **Publish structural descendants through Sitecore** and documented that Sitecore controls the exact descendant set when enabled.
- Added Power Publish planning evidence for selected content scopes, media items, layout datasources, item links, external URLs, deliberately excluded scopes, and unresolved references.

## 0.9.8

- Corrected the Power Publish configurator so its intentionally omitted **Include related items** option is actually hidden even though checkbox labels use a flex layout; submissions already forced the value off.
- Reused the grouped Traced Publish configurator for Power Publish, retaining Smart/Full mode, optional structural descendants, one route/application verification, structural field assertions, and optional Browser DOM selectors.
- Made supported reference discovery intrinsic to Power Publish instead of exposing Sitecore's non-deterministic **Include related items** option.
- Added structural descendants to the explicit Observed Reference Graph when selected, while keeping referenced-item fields out of the assertion picker.
- Increased the Power Publish graph safety budget to 500 items and blocks queueing when structural or reference discovery is truncated, depth-limited, or unable to load an observed target.
- Replaced one-publish-operation-per-item execution with dependency-layer batches of up to 20 independent root item IDs, preserving cyclic components and publishing the selected root in a final batch.
- Added persisted Raw Experience Edge checkpoints after every Power Publish batch. Item identity, selected fields, and graph-forming reference fields must match before a dependent layer begins; restart recovery resumes from the first unmatched checkpoint.
- Added expandable Power Publish checkpoint evidence to Operation Details.
- Added advisory Traced Publish evidence for supported references observed outside the selected structural scope without publishing or verifying referenced-item fields.

## 0.9.7

- Replaced the Transfers view with **Operations**, where subtree transfers, field-value transfers, and all publishing modes share one durable FIFO and one Play/Pause processor.
- Made publishing asynchronous: configuration now queues a publishing operation and its existing trace can be reopened directly from the matching Operations row.
- Added restart recovery for incomplete publishing runs without starting duplicate server operations.
- Added a shared **Operation Details** editor presentation for transfer evidence and publishing trace stages.
- Corrected Operation Details panel ownership so transfers and publishing traces reuse the same editor instead of opening one editor per operation family.
- Added a collapsed **Show evidence** disclosure to transfer Operation Details so the persisted operation record is available without dominating the summary.
- Isolated comparison-side failures so a broken destination template no longer blocks favorite navigation or an Exact Mirror transfer from the valid source, and Field Diff still displays whichever side loaded successfully.
- Moved **Run task…** to a separate final section of the comparison context menu so the primary diff, publish, transfer, expand, and refresh actions remain prominent.
- Simplified comparison transfer labels to **Transfer Left → Right** or **Transfer Right → Left** and shows only the direction originating from the item cell that opened the context menu.
- Replaced Traced Publish's browser datalist with an explicit filtered field-assertion picker supporting keyboard selection, ranked multi-token search, and a bounded result list; empty values are excluded and the status now explains how many structural items contributed fields.
- Corrected rendered-layout verification to retain every value observed for an item field instead of allowing the last duplicate occurrence to overwrite earlier matches, and reports all observed values plus matching-object counts as evidence.
- Added **Recent Operations**, retaining the newest 30 terminal records and showing the newest 10 by default with a show-more/fewer action.
- Changed the Operations badge to count the complete active FIFO and explain its transfer/publishing breakdown.
- Restored **Expand Loaded Items** and the automatic expansion after **Expand All** by correcting comparison-row traversal introduced by one-sided failure isolation.
- Kept comparison actions available while **Expand All** loads field details in the background; only refresh actions remain guarded until those detail requests finish.
- Scoped the **Refresh Item** guard to the selected row so pending field details on unrelated descendants no longer disable it; **Refresh Subtree** still waits for its complete branch.
- Standardized Operations labels as **Subtree Transfer** and **Field Transfer** in both the queue and recent history.
- Removed redundant **completed** text from successful Operations rows; the green completion icon communicates the status while queue progress and failures remain explicit.

## 0.9.6

- Added optional, searchable field assertions to Traced publish for the selected item and, when enabled, its structural descendants.
- Kept **Related items** independent from field verification: it can affect Sitecore publishing scope but never adds referenced-item fields to the assertion picker.
- Reported selected values explicitly across the Authoring snapshot, raw Experience Edge, rendered route layout, and optional public application response, treating a selected field that is missing from rendered data as a divergence.
- Derived the route of an item below a conventional page-local `Data` subtree from its owning page path instead of suggesting the datasource item's structural path.
- Added contextual Publish Trace recovery actions: retry failed diagnostics without republishing, start a newly confirmed publish after publishing failure, or re-check saved operation IDs after local tracking was abandoned.
- Preserved up to ten previous trace attempts with their conclusions and stage evidence, and never started a missing publishing batch during a status-only re-check.
- Reported successful application responses that omit expected text as **inconclusive** instead of failed, because a plain HTTP probe cannot observe text added later by browser-side rendering or hydration.
- Added optional Browser DOM assertions for selected Traced-publish fields. Users can associate CSS selectors with assertions, then verify hydrated `textContent` in an isolated installed Chrome or Edge browser without changing the ordinary HTTP-response check.
- Made Browser DOM text comparison case-insensitive and exposed the exact verification URL beside selectors to prevent silent environment mismatches.
- Replaced the Traced-publish prompt chain with one compact configuration page for mode, scope, site, route, application URL, searchable field assertions, and optional CSS selectors; descendant fields load only when requested.
- Compacted Traced-publish field assertions into a searchable HTML datalist with an explicit selected-assertion list, and corrected publishing-scope checkbox sizing and label alignment.
- Allowed Browser DOM selectors to be entered before an application URL, while requiring and focusing the exact URL only when Publish is selected.

## 0.9.5

- Added **Publish → Standard publish…**, **Traced publish…**, and **Power publish…** to each available comparison-side item.
- Added official Authoring GraphQL publishing with Smart/Full mode, exact language, optional descendants and related items, operation-ID polling, non-retried publish mutations, and restart recovery.
- Added Traced publish verification across the authoring snapshot, raw Experience Edge items, optional rendered route layout, and optional public application response.
- Added Power publish discovery of an editable **Observed Reference Graph**, dependency-first item ordering, and root/page-last publishing in individually monitored batches.
- Added one progressive **Publish Trace** document with expandable evidence and graph details, while keeping transport and polling details in **XM Cloud Publish** output.
- Stored Experience Edge tokens in VS Code Secret Storage and made the generic application-response probe optional, public-URL based, and independent of Vercel credentials.
- Added per-connection traced-publishing configuration for replacing the Edge endpoint, token, or default Sitecore site.
- Persisted the latest 30 publish runs and wrote redacted JSON publish journals beneath VS Code extension storage.
- Closed the Standard publish progress notification before showing its separate completion message.
- Released the active publishing lock before displaying completion UI, so a finished publish never blocks the next Standard, Traced, or Power publish.
- Persisted the configured sites returned by **Test Connection** and reused them for route-layout tracing: one site is selected automatically, multiple sites use a name/root-path picker, and manual entry remains only as a no-results fallback.
- Moved Experience Edge token ownership into the saved connection's Secret Storage lifecycle and allowed an empty replacement prompt to retain the token already stored for that connection.
- Validated new and replacement Edge tokens before storage by listing their accessible Edge site names, hostnames, and root paths; compared that scope with the connection's verified Authoring sites and required explicit approval or mismatch override.
- Added guarded recovery for stale publish tracking: the blocking warning can abandon local tracking and continue, and a dedicated command can release the lock while preserving an explicit server-status-unknown trace.
- Prefilled route verification with an editable slug derived from the selected item's path relative to the verified site root, omitting a conventional leading `Home` item.
- Corrected route suggestions for XM Cloud site roots above the actual route start item by removing the full prefix through a conventional `Home` segment (for example, `Global/Home/Station Wagon` now suggests `/station-wagon`).

## 0.9.4

- Added **Add missing content**, **Synchronize from source**, and **Exact mirror** subtree transfer types backed by the Content Transfer API's native merge strategies.
- Added a cancellable structural preflight that reports source and target item counts plus the items that will be added, overwritten, or removed before a transfer is queued.
- Added a short destructive confirmation for exact-mirror transfers without a separate production-target checkbox.
- Remembered the last selected subtree transfer type globally and placed it first in the next transfer picker.
- Displayed each subtree transfer type and its preflight counts in the Transfers panel.
- Allowed exact-mirror transfers to replace same-path items with different IDs, counting the target IDs as removals and the source IDs as additions.
- Clarified that Exact mirror deletes and recreates the target subtree, and labeled its preflight counts as matching, source-only, and target-only.

## 0.9.3

- Added isolated JavaScript item tasks with a brokered Authoring API that never exposes connection secrets or access tokens to plug-in code.
- Reused the extension's existing OAuth token cache, retry handling, GraphQL error handling, and item readers for plug-in operations.
- Added brokered item read, child-listing, create, field-update, and delete operations, with cancellation propagated to in-flight Authoring API requests.
- Preserved local PowerShell and optional SPE-remoting tasks, while keeping the new Authoring API broker JavaScript-only for this release.
- Added a JavaScript task example and documented its manifest, runtime contract, item API, result handling, and security boundary.
- Ported the modal slide-in inspection and update tasks to JavaScript, preserving page/rendering lookup, structure validation, KVF mapping, HTML transformation, and linked Table create/update/delete behavior without SPE.

## 0.9.2

- Added reusable `text`, `number`, `pick`, and `boolean` manifest inputs and passed collected values through the task context.
- Added optional `spe-remoting` task execution against the CM environment from the clicked comparison side.
- Prompted for SPE credentials only when an SPE task requires them, stored them per connection in VS Code Secret Storage, and offered replacement after an authentication failure.
- Validated SPE credentials with a read-only probe before sending the actual task and translated Sitecore's malformed login-failure response into the credential-replacement flow.
- Removed stored SPE credentials automatically when their XM Cloud Sync connection is deleted.
- Checked for the local `SPE` remoting module before collecting task inputs or credentials, offered non-blocking installation guidance when it is missing, and released the task lock immediately.

## 0.9.1

- Discovered item task manifests by directly enumerating each workspace's `.xm-cloud-sync/tasks` directory so hidden-folder and workspace-search exclusions cannot suppress valid plug-ins.
- Opened the extension source workspace automatically in the Extension Development Host so F5 debugging discovers its workspace task plug-ins.
- Scoped **Run task…** to the left or right item cell that was right-clicked, so task choices no longer include the opposite comparison side.

## 0.9.0

- Added **Run task…** to comparison-item context menus with matching tasks distinguished by comparison side, connection, language, and path.
- Discovered PowerShell task plug-ins from `.xm-cloud-sync/tasks/**/task.json` and matched them by template ID, item ID, immediate parent path, or ancestor path.
- Passed complete, secret-free item context through a temporary JSON file, streamed stdout and stderr to the **XM Cloud Tasks** output channel, and reported structured OK or failure results.
- Added cancellable, non-interactive PowerShell execution with PowerShell 7 and Windows PowerShell fallback, Workspace Trust enforcement, manifest validation, and temporary-context cleanup.

## 0.8.4

- Made deployment monitoring optional so missing Deploy API permissions never block a subtree transfer.
- Reused existing connection credentials automatically when they can read deployment information, while retaining explicit organization-client configuration as an optional enhancement.
- Continued transfers when a deployment check is unavailable or temporarily fails; only a confirmed deployment-ID change now fails the transfer.

## 0.8.3

- Added organization-level deployment monitoring configuration to saved XM Cloud connections.
- Captured the latest source and destination deployment IDs before each subtree transfer and persisted them with the queue record.
- Failed and paused a subtree transfer when either environment's latest deployment changes, including across VS Code restarts, and made retry start a fresh remote transfer.

## 0.8.2

- Added phase counters to queued subtree and field-value transfer statuses.
- Reported actual Content Transfer chunk progress as `copying chunks (4/6, chunk x/y)`.
- Reported completed Item Transfer blobs and elapsed phase time as `Sitecore (5/6, blob x/y imported, 8m 15s)` and persisted the phase start with the queue record.
- Added adaptive Item Transfer polling: approximately every 2 seconds initially, then 5, 10, and 15 seconds as the Sitecore phase grows longer, with small jitter and no separate between-window delay.
- Switched subtree status to `verifying (6/6)` before destination verification begins and retained the last detailed phase when a transfer fails.

## 0.8.1

- Released Field Diff transfer arrows immediately after enqueueing instead of keeping them disabled until the informational notification was dismissed.
- Limited the field-transfer overwrite confirmation to the first accepted transfer for the extension profile.
- Displayed the internal field name in Transfers and included source and target field paths in its tooltip.
- Shortened transfer labels to the field plus item name or subtree root name while retaining connection and status details in the gray description.
- Paused transfer processing automatically when the queue drains, so later additions wait for an explicit Play action.

## 0.8.0

- Replaced synchronous subtree and field-value execution with a durable, workspace-scoped FIFO transfer queue.
- Renamed **Sync Operations** to **Transfers** and added Play/Pause processing controls, live status, queue count, failed-transfer retry/removal, and journal access.
- Added restart recovery and persisted Content/Item Transfer checkpoints so Sitecore operations can be monitored across multi-hour runs and VS Code restarts.
- Added optimistic source and target freshness checks around queued Authoring `updateItem` field mutations, followed by target verification.
- Removed completed records after their journals are safely written; failed records remain at the queue head and pause processing for explicit user action.

## 0.7.2

- Replaced the Field Diff checkboxes with independent segmented visibility controls for content, Standard Template, and system fields.
- Classified `__`-prefixed fields as system fields before applying Standard Template classification, so each row belongs to exactly one category.
- Defaulted content and Standard Template fields to differences-only and system fields to hidden, while retaining one shared filter profile across item selections and webview restoration.

## 0.7.1

- Displayed each available item ID in the Field Diff summary and made it copyable to the system clipboard with one click.
- Added immediate inline copied-state feedback without requiring browser clipboard permissions or a confirmation dialog.

## 0.7.0

- Added directional value-copy arrows around the **Value** indicator in paired Field Diff rows.
- Added confirmed single-field updates through the Authoring GraphQL `updateItem` mutation using the target language, version, and field name.
- Kept credentials and mutation inputs in the extension host, blocked fallback-derived value copies, and refreshed affected comparison caches after successful writes.

## 0.6.4

- Added connection-scoped favorite Sitecore paths beneath each connection in the Connections view.
- Added **Add to Favorites** to comparison-item context menus, including adding a paired path to either or both connections.
- Opened favorites by revealing already-loaded rows first, then resolving and loading the required ancestor chain through Authoring GraphQL when necessary.
- Prompted to remove a favorite when its path can no longer be found or opened on its connection.
- Kept normal favorite clicks navigation-only: they now require an open comparison containing the favorite's connection and never replace either side implicitly.
- Added **Compare with…** to favorite context menus, placing the favorite's connection on the left, the chosen connection on the right, and then revealing the favorite path.

## 0.6.3

- Stopped treating `consumed` Item Transfer history entries with `TransferState: Unknown` as successful completion.
- Retained destination `.raif` blobs automatically to prevent descendant field data from referencing deleted Azure storage while Sitecore's background database sync is still running.
- Recognized `TransferredWithErrors` as a terminal transfer failure instead of continuing to poll.

## 0.6.2

- Removed **Paste as Connection URL** from the Connections view's **More Actions…** menu.
- Added the paste action to connection-item context menus and to the empty Connections welcome view.

## 0.6.1

- Collapsed the **Sync Operations** view by default and removed the comparison toolbar's complete-refresh button.
- Added a selected-connection trash action beside the Connections view title actions and prevented deletion while the connection is used by the open comparison.
- Added **Paste as Connection URL** for extracting an XM Cloud origin from a full clipboard URL and prefilling the add-connection wizard.
- Enabled **Show differences only** by default in the Field Diff panel.

## 0.6.0

- Added confirmed **Sync Subtree Left → Right…** and **Sync Subtree Right → Left…** actions to paired item rows.
- Integrated Content Transfer and Item Transfer to preserve item IDs while synchronizing all descendants, languages, versions, and media chunks with `OverrideExistingItem`.
- Added source-identity and destination-parent preflight checks, same-environment and path/ID conflict guards, asynchronous transfer-history tracking, and target refresh after completion.
- Added secret-free execution journals beneath VS Code extension storage and retained pending transfer blobs instead of treating the polling window as failure.

## 0.5.3

- Reassigned compact item-difference symbols to `C` for child presence, `T` for template, `V` for selected-language version availability, and `*` for field differences.
- Clarified the field-difference tooltip as **At least one field differs between these items**.

## 0.5.2

- Added field-comparison lifecycle status to item tooltips without introducing visible equal, unchecked, or field-loading markers.
- Added a single `⚠` operational marker for field-detail or child-loading failures, with side, category, and error details in its tooltip.

## 0.5.1

- Included loaded leaf and unexpanded descendant items in ancestor-subtree field invalidation without eagerly loading their child levels.
- Refreshed the visible **Field Diff** panel when its selected item is covered by an ancestor-subtree refresh.

## 0.5.0

- Added **Refresh Item** for reloading a paired item's template, version, and fields without replacing its loaded children.
- Implemented confirmed, cancellable **Refresh All** traversal for every item and field beneath the configured root and exposed it in the comparison toolbar.
- Refreshed the visible **Field Diff** panel immediately when its selected item is covered by an item, subtree, or all-data refresh.
- Prevented superseded in-flight field-detail requests from restoring stale cache entries after refresh invalidation.

## 0.4.2

- Treated a null filtered-field collection on an existing Authoring item as zero non-Standard fields.
- Kept a null item response as an explicit item lookup failure while classifying fields.

## 0.4.1

- Removed expand controls from items that have no children on either comparison side.
- Stopped failed background field-detail requests from immediately retrying on every render.
- Kept background field-detail loading from replacing the child disclosure with a blinking spinner.

## 0.4.0

- Moved detailed field rows out of the structural comparison tree into a dedicated **Field Diff** bottom-panel tab.
- Added **Show Detailed Field Diff** to the item context menu and synchronized the panel with item selection only while the panel is visible.
- Added current-selection filters for equal Standard Template fields and matching fields.
- Kept field scope, value source, local override, metadata, and native textual-diff details in the new paired field table.

## 0.3.1

- Grouped each expanded item's template and fields in an attached border below the item row.
- Removed the separate hidden-Standard-fields count row and moved field summaries into item tooltips.
- Marked populated local overrides on visible Standard Template field rows.

## 0.3.0

- Added lazy, paginated item-field comparison with template, value, type, scope, and value-source differences.
- Added independent language selectors and latest-version resolution on both comparison sides.
- Allowed the same XM Cloud connection on both sides for cross-language comparison.
- Marked shared and unversioned fields while leaving common versioned fields unmarked.
- Hid equal Standard Template fields by default and added **Show all fields**.
- Added native VS Code text diffs for differing textual fields.
- Included field snapshots in comparison caching and subtree refresh invalidation.
- Kept language fallback disabled pending an explicit fallback-semantics investigation.

## 0.2.7

- Added confirmed **Expand All…** to the paired-row context menu for large content trees.
- Added cached-only **Expand Loaded Items** plus explicit **Expand Item** and **Collapse Item** actions.
- Ordered context actions from local to network-heavy behavior with state-sensitive item actions and separators.
- Loaded available sides concurrently with bounded, breadth-first requests and progressive depth updates.
- Added cancellable progress and scope-aware locking during greedy traversal.

## 0.2.6

- Centralized OAuth and Authoring GraphQL requests in a shared Sitecore HTTP client.
- Added up to three retries for transient network failures and HTTP 408, 429, 500, 502, 503, and 504 responses.
- Added exponential backoff with jitter and support for both forms of the `Retry-After` response header.
- Shared endpoint cooldowns across requests to the same origin and made retry waits cancellable.
- Added sanitized retry diagnostics without logging credentials, tokens, request bodies, or query parameters.

## 0.2.5

- Added **Refresh Subtree** to the paired-row context menu.
- Refreshed selected items and every descendant level already loaded in the lazy snapshot.
- Invalidated cached levels and reloaded them in parent-before-child order.
- Locked and visually marked affected rows while allowing disjoint subtree refreshes in parallel.

## 0.2.4

- Simplified the comparison selector toolbar and removed repeated connection headings.
- Moved server URLs into a thin strip beneath the paired tree.
- Narrowed the difference indicator gutter.
- Removed redundant left/right badges from same-path ID conflicts.
- Grouped compact monospace `L`/`R` and `P`/`N`/`T` legend symbols with individual tooltips.
- Anchored the connection URL strip to the bottom when the tree is shorter than the viewport.
- Removed visible full paths from tree rows and highlighted display names that differ from item names.
- Added paired-row expand and collapse by double-clicking either item cell.

## 0.2.3

- Replaced independent content trees with one synchronized paired-row comparison tree.
- Matched loaded items by normalized Sitecore item ID.
- Added left-only, right-only, ID, path, name, and child-presence difference flags.
- Paired same-path items with different IDs as explicit identity conflicts.
- Synchronized selection, expansion, loading, retry, and child alignment across both sides.

## 0.2.2

- Added lazy loading for both XM Cloud authoring content trees.
- Loaded the root and all paginated direct children when a comparison opens.
- Loaded and cached one additional level when an item is expanded.
- Added inline loading, retry, and error states without refreshing on item selection.
- Added a dedicated XM Cloud Sync diagnostic log output channel.

## 0.2.1

- Added **Compare with…** to the connection context menu.
- Required two distinct XM Cloud connections for a comparison.
- Removed the redundant Left Content Tree and Right Content Tree activity views.
- Kept comparison content in a single document-style tab.

## 0.2.0

- Added a document-style comparison tab.
- Added persistent left and right connection selectors and a swap action.
- Added comparison launch actions to the activity view and Command Palette.
- Kept connection secrets and OAuth tokens outside the webview process.

## 0.1.2

- Collapsed exact duplicate sites returned by the Authoring API.
- Reported the number of duplicate API records omitted from connection results.

## 0.1.1

- Added expandable and searchable site details with site name, root path, and root item ID.

## 0.1.0

- Added multiple persistent XM Cloud connections.
- Added secure automation-client credentials using VS Code SecretStorage.
- Added authenticated connection testing against the Authoring GraphQL API.
- Added connection removal with confirmation.

## 0.0.1

- Added the initial installable VS Code extension shell.
- Added the XM Cloud Sync activity view and placeholder commands.
- Added debug, watch, compile, and VSIX packaging workflows.
