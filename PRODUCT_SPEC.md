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
- Standard, traced, and dependency-ordered publishing to Experience Edge.

## Item task plug-ins

The comparison item context menu provides **Run task…**. The extension discovers trusted-workspace plug-ins from `.xm-cloud-sync/tasks/**/task.json`; every plug-in consists of a validated manifest and a JavaScript or PowerShell script contained in the same plug-in directory. A manifest has a unique ID, display name, optional description, relative script path, optional execution type and inputs, and at least one match rule. Match rules support normalized template IDs, normalized item IDs, exact case-insensitive immediate-parent paths, and exact case-insensitive ancestor paths. Rules are combined with OR semantics.

Before presenting the picker, the extension identifies whether the left or right item cell was right-clicked and loads complete details only for that side. A context-menu invocation from the shared center area can still consider both available sides. Each matching task-side combination is selectable and identifies its side, connection, language, and item path. Execution uses a direct child process without shell command construction. PowerShell 7 is preferred and Windows PowerShell is the Windows fallback; both run without profiles and in non-interactive mode. Workspace Trust is mandatory and task execution is never automatic.

Before execution, the runner collects manifest inputs in declaration order. Supported general-purpose types are text, finite number with optional range, single-value pick, and boolean. Values are added to the schema-versioned, secret-free context under `inputs`. Context includes task identity, side, non-secret connection identity, language, item/tree metadata, template, available versions, complete fields, parent, and ancestors.

JavaScript is the preferred XM Cloud automation runtime. A `javascript` task exports `run(context, sitecore, log)` and executes in a dedicated Node child process. The worker has no connection credential or token. Its restricted message protocol brokers `get`, immediate-child listing, `create`, named-field `update`, and `delete` operations through the extension's existing `AuthoringContentClient`. The broker reuses the same OAuth token cache, HTTP retry/cooldown policy, GraphQL validation, item parsing, and non-retried mutation behavior as Field Diff. Every request is fixed to the clicked side's saved connection and `master` database. Worker cancellation aborts in-flight Authoring requests.

The modal slide-in tasks use this runtime for a single clicked ModalSlideInButton. They retain the configured product-page/rendering lookup, validate the linked ModalSlideIn and TableContainer structure, resolve market-specific KVF content, and inspect or apply Table field updates, creation, multilist maintenance, and recycling. If an existing Table child needs a language version that cannot be read, version 0.9.3 fails explicitly because item-version creation is outside the initial broker surface.

Existing local PowerShell execution remains supported and receives context and result paths as named parameters. The Authoring broker is not duplicated for PowerShell in version 0.9.3. A manifest can instead declare `spe-remoting`. Before collecting inputs or credentials, the runner checks whether the selected PowerShell host can discover the local `SPE` module. A missing module stops execution and offers to copy the current-user installation command or open the PowerShell Gallery package. SPE execution targets the clicked side's CM URL and uses Windows PowerShell on Windows. Before sending the task script, the launcher executes a read-only marker probe and requires the expected response. It translates the SPE client's malformed CLIXML error for rejected Sitecore credentials into an authentication failure. Only after validation does it send the server script plus its secret-free context through the SPE remoting service. The server script receives the deserialized context as its `Context` parameter. SPE credentials are requested only for SPE tasks, stored per connection in VS Code Secret Storage, passed to the local launcher through standard input, and replaced interactively after an authentication failure. Deleting a connection deletes its SPE credential. A 403 remains an authorization/configuration error rather than triggering credential replacement.

Stdout and stderr stream to a dedicated **XM Cloud Tasks** output channel. Exit code zero is success unless a declared result reports error; non-zero is failure. A result supplies `status` and a user-facing `message`. JavaScript and local PowerShell tasks support process cancellation; SPE tasks are not exposed as cancellable because terminating the local client cannot guarantee that Sitecore stops the remote script. Completion produces an OK or error notification, and temporary files are deleted afterward. Task runs remain separate from the Transfers FIFO.

Experience Edge tracing remains separate from the authoring diff and sync engine because Edge contains a published, flattened representation rather than the complete authoring item representation.

## Publishing and propagation tracing

Right-click an available item on either comparison side and open **Publish** to choose:

- **Standard publish…** triggers an ordinary Sitecore Smart or Full publish for the exact selected language, with optional descendants and related items. It monitors the returned operation ID to completion, reports through a progress notification, and writes technical details to **XM Cloud Publish** output.
- **Traced publish…** captures the selected authoring snapshot, performs the same Sitecore publish, then checks raw Experience Edge content, optional `layout.rendered` route data, and an optional public application response.
- **Power publish…** reuses the grouped Traced Publish configuration and continues into a user-directed collapsed scope graph. Each node represents one structural Sitecore scope and exposes only references leaving that path boundary. Selected dependency scopes publish before the selected route root, followed by the single configured route/application trace.

Publish mutations are never retried automatically because a lost mutation response could otherwise start a duplicate operation. Status, Edge, and application reads use the shared retry and endpoint-cooldown behavior. In-progress records retain operation IDs in workspace state and resume monitoring after an extension restart. Completed records are kept as recent trace history and written as redacted JSON journals beneath extension storage.

An active local publish monitor prevents another publish from starting. If that state is stale, the blocking warning offers **Abandon and Continue**, and the Command Palette provides **XM Cloud Sync: Abandon Current Publish Tracking**. Abandoning aborts local monitoring, records incomplete traces as locally abandoned with unknown server status, and releases the local lock. It does not claim to cancel the server-side XM Cloud publish, which may still be running.

The completed trace conclusion exposes contextual recovery actions. A diagnostic failure offers **Retry failed verification**, which reuses the original Authoring snapshot and assertions and reruns reads from the first failed diagnostic stage without a publish mutation. A Power Publish Raw Edge divergence also offers **Force republish missing items**, which creates a separate durable Full-publish operation for only the missing or mismatched observed items. A publishing failure, or an abandoned trace without an operation ID, offers **Publish again…**, which starts a separate publish flow with normal configuration and confirmation. An abandoned trace with operation IDs offers **Check status again**, which polls only those existing IDs; batches without IDs remain unstarted and make the original plan incomplete. Retry and status-check cancellation restores the prior completed trace, and up to ten previous attempts remain available as expandable evidence.

Traced publishing stores the Experience Edge token as a per-connection VS Code Secret Storage value with the same lifecycle as the connection's other credentials. It is reused automatically, an empty replacement input preserves it, and deleting the connection deletes it. Before a new or replacement value is stored, an authenticated `site.allSiteInfo` query displays the Edge site names, hostnames, and root paths available to that token. The extension compares names and root paths with the connection's verified Authoring sites and requires an explicit warning override when the complete verified catalog does not match. Non-secret endpoint and site metadata are stored separately. Configured sites returned by **Test Connection** are persisted per connection and reused by publishing. A single site is automatic, multiple sites use a picker containing exact names and root paths, and a missing catalog is refreshed through the Authoring API before manual entry is offered. A route is optional; without one, raw Edge item verification still runs and rendered-layout verification is marked skipped. Application-response verification is also optional and uses a normal public HTTPS request. It records HTTP and cache headers, including Vercel headers when returned, without requiring a Vercel account, project ID, or token.

The application probe evaluates only the returned HTTP body, not hydrated or interactive browser DOM. A non-success HTTP status diverges, and a successful response containing the expected text matches. When a successful response omits expected text, the stage is **inconclusive**: client-side rendering can still make the value visible, so absence from server HTML is not treated as failed UI propagation. The trace retains response and cache evidence and permits the application check to be retried.

For users who explicitly opt in, each selected Traced-publish field can carry a CSS selector for an additional **Browser DOM** stage. Selector entry is order-independent, but submitting any selector requires a valid exact application URL and focuses that input when it is missing. The grouped configuration page exposes the URL beside those selectors. The extension launches an isolated headless installation of Google Chrome or Microsoft Edge, navigates to that URL, waits up to 30 seconds for initial navigation and 15 seconds per selector, and compares whitespace-normalized `textContent` using locale-independent, case-insensitive containment semantics while preserving punctuation. The trace records browser channel, requested and final URL, selector, match count, expected value, and up to five observed texts. Different text on a found element diverges; missing or invalid selectors are inconclusive because selector quality is user-controlled. The temporary browser context does not reuse the user's profile, cookies, or signed-in state. No browser is downloaded with the extension.

With a route configured, Traced and Power publish provide the same optional searchable field-assertion picker. Traced candidates include structural descendants when its descendant scope is enabled. Power candidates load structural descendants automatically because a collapsed scope always contains its structural subtree; its Sitecore descendant option controls execution rather than discovery. Traced **Related items** affects only the Sitecore publishing request and never expands assertions. Power has no related-items switch because supported references leaving a selected collapsed scope are shown as opt-in child scopes; referenced items still never expand the assertion picker. Each selected value is recorded at the Authoring boundary and compared explicitly with raw Edge and rendered layout data; a missing selected item or field is a divergence rather than an implicit match. The optional application response requires every selected textual value of sufficient length to appear in the response body.

Traced- and Power-publish preparation is presented as one compact editor-area form without tabs. It groups publishing mode, applicable scope, verified site selection, editable route, optional exact application URL, searchable field assertions, and optional per-field Browser DOM selectors. Available fields are exposed through a browser-native searchable picker and added explicitly; only selected assertions render as editable rows. The form's queue action replaces the separate final confirmation for Traced Publish; Power Publish continues into collapsed-scope review and final confirmation. Descendant fields load on demand when descendants are enabled, and disabling that scope removes descendant assertions from the submission. First-time Edge endpoint/token collection remains in native password input because secrets are validated and stored outside the webview.

The route prompt is prefilled from the selected item path relative to the selected site's verified root path. Because the reported site root can be above the actual route start, the complete prefix through a conventional `Home` segment is omitted; remaining item-name segments are normalized into lowercase URL slugs. For an item below a conventional page-local `Data` subtree, the suggestion stops at the owning page path. If the item is outside the known site root, the item name supplies a conservative one-segment suggestion. The value remains editable and can be cleared.

Traced and Power operations reuse one document-style **Publish Trace** tab. It displays one progressive vertical stage list and a concise conclusion. Evidence and selected-scope reference details remain collapsed until requested; there are no internal tabs or permanent diagnostic panes. Standard publish opens the trace only on failure.

The Power Publish collapsed scope graph is explicitly limited to supported, observable item references rather than claiming knowledge of code-driven or search-driven dependencies. Layout fields contribute only component datasource attributes. Droplink, Droptree, Multilist, Treelist, General Link, Image, and File fields contribute field-type-specific targets. A selected scope exposes only content and media references leaving its structural path boundary. Template, layout, system, unsupported, and external-URL targets are omitted from the graph and summarized as aggregate evidence. External scopes are scanned lazily when selected or expanded, cached by item ID, and protected from cycles. A scan pauses in resumable 500-item or 200-unique-external-scope chunks; internal and non-publishable references do not consume the external-scope budget. Power Publish refuses to queue an incomplete selected scope; unresolved custom-field references remain visible warning evidence.

TODO: Add fallback-aware publishing diagnostics without changing comparison or transfer semantics. Publishing must be able to capture effective delivery content separately from the stored localization snapshot: preserve the requested language, resolved source language and fallback chain; distinguish item-level fallback for a version-0 requested language from a genuinely non-observable item; distinguish field-level fallback on an existing requested-language version; and verify Experience Edge using the originally requested language rather than treating a successful source-language query as proof. Version-0 items should be skipped only when neither a local version nor an applicable fallback exists. The trace should identify fallback-derived expectations and their source language, account for the initial Edge publication required to establish fallback-language dependencies, and avoid enabling `withLanguageFallback: true` globally because that would hide missing translations and blur stored-value differences in comparison and transfer workflows.

## Connections

Each connection contains:

- Display name.
- XM Cloud content-management hostname.
- Environment automation client ID.
- Environment automation client secret, stored only in VS Code `SecretStorage`.
- Optional organization automation client credentials and matched Deploy environment ID for deployment-interruption monitoring; the secret is stored only in `SecretStorage`.
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

TODO: Replace the subtree-transfer preflight message `X tree levels checked` with clearer wording such as `X branches scanned` or `X parent items scanned`. The counter represents source and target parent items whose direct-child collections have been loaded, not the depth of either tree, and there is no known total until traversal finishes.

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

Subtree status has six phases: `queued (1/6)`, `checking freshness (2/6)`, `exporting content (3/6)`, `copying chunks (4/6, chunk x/y)`, `Sitecore (5/6, blob x/y imported, elapsed)`, and `verifying (6/6)`. The chunk counter comes from Content Transfer chunk-set metadata and successful destination uploads. The Sitecore counter reports Item Transfer blobs confirmed as `Finished`, not restored Sitecore items. Its elapsed duration begins when the Sitecore phase starts and refreshes locally without extra requests or workspace-state writes. Polling uses jittered intervals near 2 seconds for the first minute, 5 seconds through five minutes, 10 seconds through ten minutes, and 15 seconds thereafter. Field-value transfers use four analogous phases without export or Sitecore import. Progress is persisted on the queue record; a failed subtree retains its last detailed phase.

Subtree execution uses `ItemAndDescendants` with one of three selectable merge strategies: **Add missing content** uses `KeepExistingItem`, **Synchronize from source** uses `OverrideExistingItem`, and **Exact mirror** uses `OverrideExistingTree`. A cancellable preflight enumerates both subtrees and reports the structural add, overwrite, and removal counts before enqueueing. Same-path/different-ID conflicts block add-missing and synchronize transfers. Exact mirror permits those conflicts because the target identities are removed before the source tree is written; preflight counts each conflicting target ID as a removal and its source ID as an addition. The last selected mode is remembered globally, and queued subtree rows retain the mode and preflight summary. Execution transfers every language and version, preserves item IDs, blocks same-environment transfer and the complete `/sitecore` root, verifies source identity and target-parent existence, and refreshes loaded target data after completion. Only explicit Item Transfer `Finished` is terminal success; consumed history with an unknown state remains pending. Destination `.raif` blobs are retained automatically until a reliable cleanup workflow is introduced.

Deployment monitoring is an optional subtree safeguard. The processor first attempts to reuse each connection's existing credentials and can use separately configured organization automation credentials when available. If both environments are readable, it captures their latest Deploy API deployment IDs and timestamps immediately before remote work begins. The IDs are persisted with the queue record and checked at most once per 15 seconds during long-running polling plus once before completion. A confirmed source or destination deployment change fails the transfer and pauses the FIFO. Missing permissions or failed monitoring requests are logged and do not affect transfer execution. Retrying a confirmed deployment-change failure clears the potentially stale Content/Item Transfer checkpoint and creates a fresh remote transfer.

Field-value execution re-reads both items and checks scope-aware field fingerprints captured at enqueue time. A stale source or target fails before mutation. Otherwise it issues one Authoring `updateItem` mutation and re-reads the target to verify the literal value. Identical pending requests are deduplicated.

## v0.9.7 Operations

The **Transfers** view becomes **Operations**. Subtree transfers, field-value transfers, and Standard, Traced, and Power publishing records share one durable workspace-scoped FIFO and one processor. The processor executes exactly one operation at a time. Publishing therefore does not bypass a long transfer, and transfers do not bypass publishing. New work can still be enqueued while another operation is active.

Publishing configuration appends a complete serializable plan and returns control to VS Code. It respects the existing Operations Play/Pause state: a queued publish does not start merely because it was added. Play starts or resumes the common processor, Pause takes effect at the next operation-specific safe boundary, and a failed head operation pauses the FIFO until it is retried or moved out of the active queue. Queued but inactive records can be reordered or removed; the active record cannot.

An operation separates its reusable plan from execution state so future recorded workflows can replay intent without copying remote IDs, checkpoints, timestamps, or stale values. A queued Traced publish stores selected field identities and verification settings, but captures current Authoring values and the pre-publish route baseline only when it reaches the queue head. Remote mutation or publishing identifiers are persisted immediately after they are returned.

The **Operations** tree presents the active FIFO in exact execution order, followed by **Recent Operations**. Selecting any row opens one shared **Operation Details** editor bound to the operation ID. Its header, status, timestamps, and actions are common; its content is type-specific. Publishing retains the current Publish Trace stages and evidence. Subtree transfers add source/destination, preflight, chunk copy, Sitecore import, deployment baseline, checkpoint, verification, failure, and journal evidence. Field-value transfers show source/target freshness, mutation, and verification evidence. Both the tree row and editor subscribe to the same persisted operation store.

Terminal operations move from the active queue to Recent Operations only after their secret-free journal is written. The most recent 30 terminal records are retained, while the tree shows the newest 10 by default and offers **Show all recent operations** for the remaining retained records. These are record-count limits, not time limits. Queued, active, waiting, and blocking-failed records are never pruned by history retention. When a 31st terminal record is added, the oldest terminal row is removed from workspace history while its journal remains on disk.

The Operations view badge is included in v0.9.7. Its number equals the active FIFO length across all operation types, including queued, running, waiting, and blocking-failed records, while excluding Recent Operations. Its tooltip breaks the number down by state so a total such as `5` can explain that one operation is running, three are queued, and one requires attention.

## v0.9.8 Power Publish execution and final Edge verification

Power Publish uses the same editor-area configurator as Traced Publish. It retains one Smart/Full mode, optional structural descendants, one verified Sitecore site and route, one optional exact application URL, structural field assertions, and optional Browser DOM selectors. It omits Sitecore's **Include related items** flag: supported references are always discovered and become an explicit, reviewable graph. Selecting descendants adds those items as graph seeds; referenced-item fields never enter the user assertion picker.

Graph discovery is complete-or-blocking. Structural traversal remains bounded to 200 items and observed-reference traversal to 500 items and eight reference levels. Reaching a limit or failing to load an observed target prevents queueing and explains why the graph is incomplete. The user may still remove discovered graph nodes deliberately during review; the root is always retained.

The selected graph is collapsed into strongly connected components and dependency layers. Independent components in one layer share Sitecore publish operations containing at most 20 root item IDs; a cyclic component remains indivisible even when larger. The selected root is removed from dependency batching and published in one final batch. Every batch stores its Sitecore operation ID and persists its live submission, remote state, processed count, and completion status inside the Sitecore publishing stage. Raw Experience Edge is verified only after all Sitecore batches complete. The final verifier checks identity for every observable item plus user-selected fields and reference fields that produced outgoing graph edges, reporting incremental checked and matched counts in bounded request groups. An Authoring snapshot with version `0` in the requested language has no language version for Edge to expose; it is excluded from mandatory identity matching and retained as explicit skipped evidence. The first pass checks the complete observable set; later passes recheck only divergent items during a 30-second propagation retry window. A missing or mismatched observable item is reported together with every other divergence, rather than stopping later diagnostics. Restart recovery polls saved operation IDs before the final verifier runs. A failed final Edge verification can be retried without publishing, or repaired by a new durable Full-publish operation containing only divergent items.

After all Sitecore batches, Power Publish runs one aggregate Raw Edge stage followed by the same single rendered-route, application-response, and Browser DOM stages as Traced Publish. It does not repeat route or application verification for datasource dependencies.

## v0.9.9 Collapsed Power Publish scopes

Power Publish replaces eager recursive reference crawling with a user-directed collapsed scope graph. The initial node represents the selected Sitecore item's structural subtree. References whose targets remain inside that path boundary are internal evidence. Resolved content or media targets outside the boundary become child scope nodes.

Selecting an unscanned child includes it and starts scanning immediately. Expanding an unselected child scans it for inspection without silently including it. Each scanned child repeats the same boundary analysis, constructing the graph only along branches the user chooses. Nodes are cached and deduplicated by item ID; repeated and cyclic appearances link to the existing node.

The configurator labels the execution option **Publish structural descendants through Sitecore**. When enabled, each selected collapsed scope root is sent to Sitecore with descendant publishing enabled. This is more efficient, but Sitecore controls the exact descendant set. When disabled, every inspected item in each selected scope is sent explicitly. Deliberately unselected external scopes are recorded as exclusions and do not block queueing; unresolved references and incomplete selected scopes do.

The review summary separates content scopes, media items, layout datasources, item links, external URLs, exclusions, and unresolved references. Template, layout, system, and unsupported targets are excluded from the tree and counted as aggregate evidence. Scan work is cached and reports progress; reaching a 500-item or 200-unique-external-scope chunk pauses the node and offers continuation rather than failing or silently truncating the plan.

## v0.9.10 Structural scope and execution separation

A collapsed scope always traverses and absorbs its structural descendants. The **Publish structural descendants through Sitecore** checkbox no longer changes the collapsed boundary. It chooses only between delegated execution using selected scope roots and deterministic explicit execution using every inspected item in those scopes. Power Publish descendant field assertions likewise load independently of that execution choice.

## v0.9.11 Publishable reference filtering

Only unique external `/sitecore/content` and `/sitecore/media library` targets become collapsed-scope candidates and consume the external-scope safety budget. Resolved template, layout, system, and unsupported targets remain cached but are represented only by aggregate ignored-reference counts in review and final evidence.

## v0.10.0 Operation replay and sequences

Completed and failed Operations records can be replayed when they contain a supported reusable intent. Reusable intent is separate from execution state and never contains credentials, access tokens, remote operation IDs, checkpoints, timestamps, deployment baselines, journals, old Authoring values, or old field fingerprints. A replay becomes a new durable Operation record and is processed by the existing common FIFO.

Field Transfer intent identifies explicit source and destination connections, items, languages, and fields. Replay reloads both endpoints and captures new scope-aware fingerprints before queueing. Subtree Transfer intent identifies explicit source and destination connections, a stable source root ID with its last-known path, and the transfer mode. It does not persist comparison-side direction or inspection languages: replay resolves a current common inspection language, follows the stable root ID to its current path, and lets Sitecore transfer every available language and version. Standard Publish intent retains the root ID, requested language, Smart/Full mode, descendant flag, and related-item flag, but never a concrete descendant list.

Traced Publish intent additionally retains its verified site, route, optional exact application URL, field assertion identities, and optional Browser DOM selectors. Every replay reloads current assertion owners, recaptures selected field values and the pre-publish rendered-route identity, and stops for attention if a saved item or field no longer exists. Power Publish intent retains selected and previously observed collapsed-scope identities. Every replay rebuilds the current graph, snapshots, dependency layers, and batches. A newly observed external scope is never accepted silently: standalone replay offers interactive Power Publish review, while sequence execution pauses on that operation before any publishing mutation.

An **Operation Sequence** is a named, optionally described, definition with an internal `definitionVersion` and an ordered list of Operation intents. It is created from an existing Operation; further Operations can be appended from Recent Operations. Editable definitions support rename, description changes, operation reordering/removal, deletion, and duplication. A running or paused run keeps its source definition immutable; duplication creates an editable definition for future execution. A run stores an immutable definition snapshot, so later edits never alter historical evidence.

Sequences have no queue. **Run Sequence** and **Resume Sequence** are explicit actions. Only one sequence may be running at a time, and standalone operations cannot be added while it owns execution. The sequence submits exactly one child Operation at a time to the existing Operations FIFO and starts the next only after the previous child reaches a terminal result. A manually paused sequence, a sequence paused on an operation, or a sequence paused by global Operations processing releases execution so a standalone Operation or another sequence can run. The earlier sequence can resume only after that work finishes or pauses.

Run states are **Running**, **Paused**, **Paused on operation**, **Paused by Operations**, **Completed**, **Stopped**, and the rare terminal **Failed** state reserved for an unrecoverable sequence-runner or persisted-state problem. An ordinary child failure produces **Paused on operation** and offers **Retry operation**, **Skip operation**, and **Stop sequence**. Retry rebuilds current runtime input rather than reusing the failed record. Stop is immediate at a safe boundary; if a remote operation has already started, the extension observes it to completion and stops before starting the next child. There is no transaction, rollback, or automatic undo.

The Operations tree contains **Operation Sequences** and **Recent Sequence Runs** separately from the ordinary Queue and Recent Operations. The latest ten terminal sequence runs are retained. A sequence row opens the shared Operation Details editor with its ordered operations, results, errors, and secret-free saved inputs. After an extension restart, an interrupted sequence becomes **Paused on operation**; its local child record is archived instead of being repeated automatically.

After restart, the common processor restores its Play/Pause state and queue order, resumes a saved remote checkpoint or publishing operation ID, and does not advance to the next record until recovery reaches a terminal state. An uncertain operation without a recoverable remote identifier is marked interrupted and never repeated automatically. Migration must also handle the legacy case where the older independent transfer and publishing managers both left active work.

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

- `Clear Connection Cache` command.
- ID-first/path-fallback identity mode.
- Reference ID remapping between independently created environments.
- Automatic publishing after synchronization.
- Authenticated Vercel project APIs, protected-deployment bypass, cache invalidation, and deployment logs.
- Browser DOM and interactive-component verification.
- Automatic undo or compensating rollback.
