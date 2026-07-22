# Changelog

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
