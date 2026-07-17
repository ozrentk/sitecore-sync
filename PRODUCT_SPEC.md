# XM Cloud Sync for VS Code — Product Specification

## Product scope

A VS Code extension for comparing and synchronizing Sitecore XM Cloud authoring content between two independently selectable XM Cloud connections.

The MVP supports:

- Multiple XM Cloud connections.
- Side-by-side authoring content trees.
- Lazy loading and explicit full-subtree refresh.
- Item-, language-, version-, and field-level comparison.
- Native VS Code text diff for textual fields.
- Generated, removable sync operations.
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

Exact duplicate site records returned by the API are collapsed using the tuple of site name, root path, and root item ID. The test result reports how many duplicate API records were omitted. Sites that differ in any of those values remain separate.

## Activity view

The `Sitecore Sync` activity view contains:

- Connections.
- Sync operations.

The activity view is the launcher and connection-management surface. The primary comparison workspace opens as a single document-style VS Code webview tab. It can be opened from the view title or Command Palette. A connection's **Compare with…** context action places that connection on the left and prompts for the right-side connection. At least two distinct connections are required.

The comparison tab's sticky top bar contains independent left and right connection selectors and a swap action. The comparison tab remembers its selected connections per workspace and updates when connections are added or removed.

The comparison tab will contain the two synchronized content trees, field rows, text-diff launch actions, and sync-operation controls. Connection secrets and access tokens are never sent into the webview; API operations remain in the extension host.

Each side independently selects:

- Connection.
- Root path.
- Language.
- Version or version-selection mode.

## Tree structure and interaction

An item can expand into:

- Item metadata.
- Shared fields.
- Language/unversioned fields.
- Language/version groups and their versioned fields.
- Child items.

Fields are leaf nodes and have comparison states. Selecting a differing textual field opens VS Code's native text diff editor with the left and right raw values.

Selecting an item never refreshes it. Loaded item metadata, fields, versions, languages, and children are cached. Collapsing and re-expanding a loaded node reuses the cache.

When a comparison opens, each side loads the configured root item and all of its direct children. Expanding a child loads exactly one additional level. Direct-child collections are followed through every Authoring GraphQL page before the level is displayed as complete. Loading and errors are shown inline in the affected tree without opening another pane.

The two snapshots are rendered as one paired-row tree rather than two independently scrolling controls. A row owns the shared selection and expanded state. Expanding it loads the corresponding level on both available sides concurrently; a left-only or right-only row loads only its existing side.

The paired-row context menu provides **Refresh Subtree**. It invalidates the selected level and all descendant levels currently present in the lazy snapshot, then re-reads them in parent-before-child order. Rows belonging to that loaded subtree are locked and visually marked until the refresh completes. Refreshes may run concurrently only when their loaded item sets do not overlap.

Within loaded data, items are paired by normalized item ID regardless of their loaded path. Items with the same path but different IDs share a conflict row and retain both `Only left` and `Only right` identity flags. The left child order is primary, while right-only rows are inserted before the nearest following matched right-side item when possible.

Context commands for the MVP:

- `Refresh Item`
- `Refresh Subtree`
- `Refresh All`

`Refresh All` greedily reloads the entire configured root subtree. Internally it uses iterative, paginated traversal; pagination is a transport detail and does not make the visible operation lazy.

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

Field identity uses field ID rather than field name. Fields are grouped into shared, language/unversioned, and language/versioned groups.

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

## Sync operations

Comparison generates a proposed operation list in the selected sync direction. Users may remove operations before execution. The MVP does not allow manually adding, reversing, or editing generated operations.

Supported workflow:

1. Compare snapshots.
2. Generate proposed operations in the selected direction.
3. Let the user remove unwanted operations.
4. Choose `Preview Sync` or `Execute Sync`.
5. Run preflight validation.
6. Execute in dependency order.
7. Re-read affected items.
8. Refresh comparison state.
9. Record results and errors.

`Preview Sync` is the normal dry run. After a successful preview, `Execute Sync` is presented as the primary call to action. Users may also execute without previewing.

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
