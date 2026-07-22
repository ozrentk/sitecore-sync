# XM Cloud Sync for VS Code — Product Specification

## Product scope

A VS Code extension for comparing and synchronizing Sitecore XM Cloud authoring content between two independently selectable XM Cloud connections.

The MVP supports:

- Multiple XM Cloud connections.
- Side-by-side authoring content trees.
- Lazy loading and explicit full-subtree refresh.
- Item-, language-, version-, and field-level comparison.
- Native VS Code text diff for textual fields.
- A durable FIFO queue for subtree and field-value transfers.
- Dry runs and real execution.
- Dedicated execution journals.

The MVP does not support publishing.

Experience Edge comparison is a possible later diagnostic feature for inspecting published content. It is not part of the authoring diff or sync engine because Edge contains a published, flattened representation rather than the complete authoring item representation.

## Connections

Each connection contains:

- Display name.
- XM Cloud content-management hostname.
- Environment automation client ID.
- Environment automation client secret, stored only in VS Code `SecretStorage`.
- Default root path: `/`.
- Default language: `en`, configurable per connection.

The extension exchanges the automation client credentials for a short-lived JWT at Sitecore's OAuth endpoint. Access tokens remain in memory and are never persisted. Non-secret connection metadata is stored in VS Code global state.

Connections can be tested after creation or from their context menu. A test obtains a JWT and executes a harmless query for configured sites against the Authoring and Management GraphQL endpoint. The exact returned site names, root paths, and root item IDs are shown beneath the tested connection and in a searchable list; this helps explain differences from the sites visible to a user in Channels.

Each connection owns a list of favorite Sitecore paths, displayed as `☆` child entries in the Connections tree. A paired comparison item can be added to either participating connection or both when it exists on both sides. Clicking a favorite is navigation-only: it requires an existing comparison with the favorite's connection selected on either side and never replaces a comparison selection. The favorite context menu's **Compare with…** action explicitly places its connection on the left, prompts for the right connection, opens the comparison, and reveals the saved path. Navigation uses an already-loaded comparison row when possible; otherwise Authoring GraphQL resolves the saved path and loads the required ancestor levels. A missing path produces an error with an option to remove the stale favorite.

Exact duplicate site records returned by the API are collapsed using the tuple of site name, root path, and root item ID. The test result reports how many duplicate API records were omitted. Sites that differ in any of those values remain separate.

## Sitecore request transport

OAuth and Authoring GraphQL communication is encapsulated by one extension-host request client. Each read request gets one initial attempt plus at most three retries for transient network failures and HTTP 408, 429, 500, 502, 503, and 504 responses. Without server guidance, delays use exponential backoff beginning at approximately 500 ms with jitter. A valid `Retry-After` header, expressed as seconds or an HTTP date, overrides that calculated delay and establishes a shared cooldown for later requests to the same origin.

Retry waits are cancellable. Cancellation, permanent HTTP client or authorization errors, GraphQL application errors, and missing content are not retried. Logs identify the operation, attempt, response status, and delay, but never include credentials, bearer tokens, request bodies, or query parameters. Field-value mutations are not retried automatically; after a confirmed success, the affected item details are invalidated and re-read. Future mutation requests must explicitly opt into retry only when their idempotency is guaranteed.

## Activity view

The `Sitecore Sync` activity view contains:

- Connections.
- Transfers.

The activity view is the launcher and connection-management surface. The primary comparison workspace opens as a single document-style VS Code webview tab. It can be opened from the view title or Command Palette. A connection's **Compare with…** context action places that connection on the left and prompts for the right-side connection. The same connection can be selected on both sides for cross-language comparison.

The **Transfers** view is collapsed by default. Selecting a connection exposes a title-bar trash action, but deletion is disabled while that connection is selected on either side of the open comparison or referenced by a queued transfer. A connection's context menu and the empty Connections welcome view provide **Paste as Connection URL**, which reads a full XM Cloud URL from the clipboard, extracts its HTTPS origin, and uses that origin to prefill the add-connection workflow.

The comparison tab's sticky top bar contains independent left and right connection and language selectors plus a swap action. The comparison tab remembers its selections per workspace and updates when connections are added or removed.

Later enhancement: double-clicking a configured site beneath a connection in the Connections pane should open or reveal the comparison tab and use that site's root as the relevant comparison-side starting point. The exact side-selection behavior and handling when the other connection has not yet been chosen remain to be designed.

The comparison tab contains the synchronized content tree and sync-operation controls. Detailed field rows and text-diff launch actions live in the **Field Diff** bottom-panel tab. Connection secrets and access tokens are never sent into either webview; API operations remain in the extension host.

Each side independently selects:

- Connection.
- Root path.
- Language.

The MVP always compares the latest numbered version returned for the selected language. Version selection is deferred.

## Tree structure and interaction

An item can expand into:

- Template metadata.
- A flat field list in the **Field Diff** panel with shared and unversioned scope markers.
- Child items.

Fields have comparison states but are not rendered as tree nodes. Right-clicking an item and choosing **Show Detailed Field Diff** opens its field table in a bottom-panel tab. While visible, that tab follows selection in the comparison tree; closing it stops synchronization. The summary displays each available item ID as a one-click clipboard action using VS Code's extension-host clipboard API and reports success inline. A sticky visibility toolbar applies one retained, panel-level profile across item selections. System fields are identified first by an internal name beginning with `__`; remaining Standard Template fields form the second category, and all other rows are content fields. Content fields support **All** and **Differences**. Standard Template and system fields support **Hidden**, **Differences**, and **All**. The default profile shows differences for content and Standard Template fields and hides system fields. Selecting a differing textual field opens VS Code's native text diff editor with the left and right Authoring values. When both sides contain a field with a **Value** difference, a right arrow above the indicator queues left-to-right and a left arrow below queues right-to-left. Each action confirms the overwrite and sends only the field ID and direction to the extension host. The host snapshots source and target fingerprints; the processor later verifies both, issues one non-retried Authoring `updateItem` mutation, and verifies the stored result. Literal copying uses `reset: false`, so empty, inherited, and Standard Values become explicit target values; fallback-derived values are rejected. The comparison also records whether each value is stored, inherited, supplied by Standard Values, or resolved through fallback so equal text does not hide a different value source.

Selecting an item never refreshes it. Loaded item metadata, fields, versions, languages, and children are cached. Collapsing and re-expanding a loaded node reuses the cache.

The paired-row context menu provides **Expand All…** for large trees. The ellipsis signals that a native modal VS Code warning requires confirmation before traversal begins. The operation traverses breadth-first only below the selected row, loading whichever of the left and right items exist. Completed depths expand progressively. Only the selected subtree is locked, disjoint subtree operations may run concurrently, and cancellation is available from the progress notification or the operation root's **Cancel Expand All** action.

The same context menu shows either **Expand Item** or **Collapse Item** according to row state, then **Expand Loaded Items**, then **Expand All…**. **Refresh Subtree** follows a separator. **Expand Loaded Items** recursively expands complete cached levels beneath the selected row without issuing Authoring API requests or changing unrelated branches. While an expand-all operation runs, **Cancel Expand All** leads the menu and overlapping actions remain disabled.

A later enhancement may perform a cancellable preflight traversal in the extension host, count unique left and right subtree items without populating the webview, and ask for confirmation before materializing a large subtree. The preflight can either return an exact count or stop at a configurable warning threshold and report that the subtree exceeds it.

When a comparison opens, each side loads the configured root item and all of its direct children. Expanding a child loads exactly one additional level. Direct-child collections are followed through every Authoring GraphQL page before the level is displayed as complete. Loading and errors are shown inline in the affected tree without opening another pane.

The two snapshots are rendered as one paired-row tree rather than two independently scrolling controls. A row owns the shared selection and expanded state. Expanding it loads the corresponding level on both available sides concurrently; a left-only or right-only row loads only its existing side.

The paired-row context menu provides **Refresh Item** and **Refresh Subtree**. Item refresh invalidates and re-reads the selected pair's template, latest version, and fields without replacing its loaded child tree. Subtree refresh invalidates the selected level and all descendant levels currently present in the lazy snapshot, then re-reads them in parent-before-child order. Rows belonging to the affected scope are locked and visually marked until refresh completes. If the visible **Field Diff** panel is showing an affected item, its snapshot refreshes immediately. Refreshes may run concurrently only when their loaded item sets do not overlap.

Within loaded data, items are paired by normalized item ID regardless of their loaded path. Items with the same path but different IDs share a conflict row and retain both `Only left` and `Only right` identity flags. The left child order is primary, while right-only rows are inserted before the nearest following matched right-side item when possible.

Context commands for the MVP:

- `Refresh Item`
- `Refresh Subtree`
- `Refresh All`

`Refresh All` greedily re-reads the entire configured root subtree and its field data. It is available from the comparison toolbar and the global **XM Cloud Sync: Refresh All** command. A native warning requires confirmation before traversal starts, and cancellable notification progress reports loaded levels. Internally it uses iterative, paginated traversal; pagination is a transport detail and does not make the visible operation lazy.

`Clear Connection Cache` is reserved for a later release.

### Refresh behavior

The extension maintains refresh locks for tree scopes.

- A refreshing item or subtree shows a spinner or equivalent progress icon.
- Commands that would mutate or refresh the locked scope are disabled.
- Unaffected parts of the tree remain usable.
- Refreshes may run concurrently only when their scopes do not overlap.
- A scope overlaps another scope when they share an item or one scope is an ancestor of the other.
- `Refresh All` locks the complete configured root and therefore cannot overlap another refresh on that side.
- Left and right connections may refresh concurrently because their scopes are independent.
- Refresh operations are cancellable.
- Progress is shown unobtrusively in the VS Code status bar or notification progress UI.
- Cancellation retains the last complete cached snapshot and does not replace it with a partial snapshot.

Refresh results are assembled in a staging snapshot. The active snapshot is replaced atomically after the requested scope has loaded successfully. This prevents half-refreshed comparisons.

## Item identity and indexing

The MVP uses normalized Sitecore item IDs as its only identity key. GUID formatting differences such as braces, hyphens, and letter casing are removed for comparison.

Snapshots use:

```ts
interface SnapshotIndex {
  byId: Map<string, ItemSnapshot>;
  byExactPath: Map<string, ItemSnapshot>;
}
```

`byExactPath` is not an identity index. It exists only to efficiently diagnose an item that is missing by ID but has the same path with a different ID. Without it, every missing item would require a scan of the opposite snapshot.

Paths retain the exact canonical string returned by the Sitecore Authoring API. The MVP performs only boundary normalization needed by the extension:

- Represent the configured database root consistently as `/`.
- Remove an accidental trailing slash except for `/`.
- Do not change path casing.
- Do not change or reinterpret item-name characters.
- Do not treat two paths as equal unless their minimally normalized strings are equal.

The extension must not assume additional path equivalence on Sitecore's behalf. API experiments may later establish whether more normalization is safe.

## Comparison states

For an ID only on the left:

- `OnlyLeft`.
- Add `PathIdentityConflict` when the exact same path exists on the right under a different ID.

For an ID only on the right:

- `OnlyRight`.
- Add `PathIdentityConflict` when the exact same path exists on the left under a different ID.

The UI should pair the left and right halves of one path identity conflict where possible.

For an ID present on both sides:

- Same ID, path, template, languages, versions, and fields: `Same`.
- Different path: `Moved`.
- Different content: `Content`.
- Different template: `Template`.
- Different languages: `Languages`.
- Different versions: `Versions`.

Multiple difference flags can coexist.

Field identity uses field ID rather than field name. Expanded tree rows show child items without inline field rows. The **Field Diff** bottom-panel tab shows one complete paired field table for the selected item, including item, connection, language, path, template, and latest-version context. Shared and unversioned fields receive compact scope markers; versioned fields are unmarked because they are the common case. Its content, Standard Template, and system visibility controls use the category precedence and defaults defined above. The selected profile is shared by every item and restored with the webview; it is never stored per item. Hidden-field and Standard Value summaries remain in the item tooltip. Populated local overrides on Standard Template fields are marked inline in the panel.

Item tooltips report field comparison as not loaded, loading, equal, different, or failed. These lifecycle states do not add visible markers except for failure: a single red `⚠` operational marker covers either field-detail or child-loading errors, and its tooltip identifies the side, category, and returned message. Operational failure is separate from content-difference aggregation and does not generate synchronization operations.

TODO: Decide whether Authoring field queries should use `withLanguageFallback: true` or `false`. The decision must distinguish comparison of the stored localization state from comparison of the effective value visible through language fallback. Before settling it, verify missing-language behavior, `containsFallbackValue`, item-level fallback, field-level fallback, and how a fallback-derived source value should generate a synchronization operation. Do not let fallback silently hide a missing translation or cause a resolved fallback value to be written as if it were locally stored.

## Text normalization

Text comparison has a user configuration setting:

```ts
type TextNormalization = "none" | "lineEndings";
```

Semantics:

- `none`: compare the values exactly as returned.
- `lineEndings`: normalize CRLF, lone CR, and LF to logical LF before comparison, making line-ending style differences equal while preserving line boundaries.

The default is `none` so the tool never hides content differences without an explicit user choice.

This setting affects comparison and diff presentation only. It never rewrites a value during sync. No whitespace trimming, HTML normalization, or Unicode normalization is performed in the MVP.

## Transfers

Confirmed subtree actions in the comparison and field-value arrows in Field Diff append durable records to one workspace-scoped FIFO. They do not perform network mutations inline. The **Transfers** view shows queue order, source and target, operation type, and current status. Play starts or resumes the single worker; Pause stops it at the next safe boundary. Completed records are removed only after their journals are written. A failed head record remains visible and pauses the queue until retried or removed.

Queue records, insertion sequence, processor state, and pending Content/Item Transfer checkpoints are retained in workspace state. An extension restart recovers interrupted local phases as queued and resumes persisted remote polling checkpoints. This supports unattended multi-hour processing without keeping a comparison tab open. Connections referenced by records cannot be deleted.

Subtree status has six phases: `queued (1/6)`, `checking freshness (2/6)`, `exporting content (3/6)`, `copying chunks (4/6, chunk x/y)`, `Sitecore (5/6, import x/y)`, and `verifying (6/6)`. The chunk counter comes from Content Transfer chunk-set metadata and successful destination uploads. The import counter identifies the current Item Transfer job among the generated blobs. Field-value transfers use four analogous phases without export or Sitecore import. Progress is persisted on the queue record; a failed subtree retains its last detailed phase.

Subtree execution uses `ItemAndDescendants` with `OverrideExistingItem`, transfers every language and version, preserves item IDs, blocks same-environment transfer and same-path/different-ID conflicts, verifies source identity and target-parent existence, and refreshes loaded target data after completion. Only explicit Item Transfer `Finished` is terminal success; consumed history with an unknown state remains pending. Destination `.raif` blobs are retained automatically until a reliable cleanup workflow is introduced.

Field-value execution re-reads both items and checks scope-aware field fingerprints captured at enqueue time. A stale source or target fails before mutation. Otherwise it issues one Authoring `updateItem` mutation and re-reads the target to verify the literal value. Identical pending requests are deduplicated.

### Preflight validation

Validation is best-effort rather than a transaction guarantee.

The extension can validate:

- Authentication and API reachability with a harmless query.
- Existence of target parents required by create or move operations.
- Existence of target templates required by create operations.
- Local dependency ordering, including parent-before-child creates and child-before-parent deletes.
- Source freshness by re-reading every source item in the plan and comparing its fingerprint with the snapshot used to generate the plan.
- Target freshness by re-reading affected target items and comparing their fingerprints with the planning snapshot.

The extension cannot reliably prove all effective Sitecore permissions in advance unless the deployed Authoring GraphQL schema exposes the required access data. Effective permissions, workflow rules, locks, insert rules, and server-side validation can still reject a mutation. These failures are handled and recorded per operation.

If freshness validation fails, execution stops before the first mutation and reports which items changed. This is optimistic concurrency protection implemented by the extension, not an atomic server transaction.

## Deletion and recovery

- Delete operations are never silently inferred and executed.
- They are visually marked as destructive.
- Permanent deletion is not supported.
- Non-permanent deletion uses Sitecore Recycle Bin behavior where supported by the Authoring API.
- The MVP does not promise transactional rollback or automatic undo.
- Every attempted mutation is recorded in the execution journal.

## Execution journal

Each preview or execution creates a dedicated UTF-8 log file named with local time:

```text
journal-YYYYMMDD-HHmmss.log
```

Example:

```text
journal-20260717-160237.log
```

The journal location must be visible and openable from the extension. The exact storage directory will be chosen during implementation, preferably beneath VS Code extension storage rather than inside the user's project.

Each journal includes:

- Journal format version.
- Extension version.
- Start and end timestamps with timezone offset.
- Preview or execution mode.
- Source and target connection display names, excluding secrets.
- Selected roots, languages, and versions.
- Text normalization mode.
- Operation plan in dependency order.
- Per-operation start time, end time, outcome, item ID, path, and error details.
- Final counts for succeeded, failed, skipped, and cancelled operations.

Secrets, bearer tokens, client secrets, and authorization headers must never be logged.

## Deferred options

- Experience Edge published-content diagnostics.
- `Clear Connection Cache` command.
- ID-first/path-fallback identity mode.
- Reference ID remapping between independently created environments.
- Publishing after synchronization.
- Automatic undo or compensating rollback.
