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

TODO: Add connection-scoped task plug-ins alongside item-scoped tasks. A connection context action should discover manifests explicitly declared for a connection scope and run them without requiring a selected Sitecore item. This supports administrative operations such as rebuilding indexes or rebuilding the link database. Connection tasks must remain explicit trusted-workspace actions, receive only the selected non-secret connection context, use the existing credential boundaries, and clearly confirm potentially disruptive server-wide work before execution.

TODO: Treat item- and connection-scoped plug-in runs as Operations. A plug-in Operation should use the common Operations lifecycle and evidence view, support **Run Again** with its saved secret-free inputs, and be eligible for inclusion as an Operation Sequence entry. The saved intent must identify the plug-in manifest and target connection or item without persisting credentials or transient runtime state; missing or materially changed plug-ins must pause execution for review rather than running a different command silently.

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

Connection creation and editing use one Connection Settings webview with inline validation and Connection, Deployment monitoring, Public URLs, and Traced publishing sections. Existing configuration commands open their corresponding section. Tests use unsaved form values and do not persist settings. Save applies validated values, Cancel/closing discards drafts, and Reload restores saved values. Secret values never return to the webview and are explicitly kept, replaced, or removed. Existing storage keys, connection IDs, favorites, and language overrides are retained. The global public-page template is visibly labelled as applying to all connections. Site catalogs load on explicit tests, deployment environments are matched to the CM host, and Edge catalog mismatches show both catalogs and require explicit confirmation before saving changed publishing credentials; a successful Edge request is reported as a valid token even when catalogs differ. Edge is tested before Authoring; failures distinguish token/endpoint requests from CM site comparison and expose safe HTTP/schema/network diagnostics without remote response bodies. Run-specific publishing options stay in the publishing form. Writes attempt rollback on failure and stale settings are rejected rather than overwritten. Changing server/authoring credentials requires closing comparisons and resolving queued-operation references first.

The Connection Settings client secret, organization client secret, and Experience Edge token each use a single masked input. Nonempty input requests replacement on Save; empty input preserves the stored value. Saved secrets are never populated in these inputs. New connections still require a client secret. The dashboard **Test connection** button shows a modal result for success, failure, or cancellation/timeout while the dashboard remains open. Validation and site discovery still run without saving.

Connections can be tested after creation or from their context menu. A test obtains a JWT and executes a harmless query for configured sites against the Authoring and Management GraphQL endpoint. The exact returned site names, root paths, and root item IDs are shown beneath the tested connection and in a searchable list; this helps explain differences from the sites visible to a user in Channels.

Each connection owns a list of favorite Sitecore paths, displayed as `☆` child entries in the Connections tree. A paired comparison item can be added to either participating connection or both when it exists on both sides. Clicking a favorite is navigation-only: it requires an existing comparison with the favorite's connection selected on either side and never replaces a comparison selection. The favorite context menu's **Compare with…** action explicitly places its connection on the left, prompts for the right connection, opens the comparison, and reveals the saved path. Navigation uses an already-loaded comparison row when possible; otherwise Authoring GraphQL resolves the saved path and loads the required ancestor levels. Each navigation is correlated from the extension host through the webview; a newer request supersedes in-flight favorite navigation, and the previous row highlight is cleared while the requested path is resolving. The favorite shows the same spinning arrows used during connection testing while navigation is loading. The indicator clears on completion, failure, cancellation, or a superseding site or favorite navigation. Overlapping ancestor loads preserve already-loaded descendants by item ID, keeping favorite navigation stable while other branches expand. A missing path produces an error with an option to remove the stale favorite.

Exact duplicate site records returned by the API are collapsed using the tuple of site name, root path, and root item ID. The test result reports how many duplicate API records were omitted. Sites that differ in any of those values remain separate.

## Sitecore request transport

OAuth and Authoring GraphQL communication is encapsulated by one extension-host request client. Each read request gets one initial attempt plus at most three retries for transient network failures and HTTP 408, 429, 500, 502, 503, and 504 responses. Without server guidance, delays use exponential backoff beginning at approximately 500 ms with jitter. A valid `Retry-After` header, expressed as seconds or an HTTP date, overrides that calculated delay and establishes a shared cooldown for later requests to the same origin.

Retry waits are cancellable. Cancellation, permanent HTTP client or authorization errors, GraphQL application errors, and missing content are not retried. Logs identify the operation, attempt, response status, and delay, but never include credentials, bearer tokens, request bodies, or query parameters. Field-value mutations are not retried automatically; after a confirmed success, the affected item details are invalidated and re-read. Future mutation requests must explicitly opt into retry only when their idempotency is guaranteed.

## Activity view

The `Sitecore Sync` activity view contains:

- Connections.
- Transfers.

The activity view is the launcher and connection-management surface. The primary comparison workspace opens as a single document-style VS Code webview tab. It can be opened from the view title or Command Palette. A connection's **Compare with…** context action places that connection on the left and prompts for the right-side connection. The same connection can be selected on both sides for cross-language comparison.

The **Transfers** view is collapsed by default. Selecting a connection exposes a title-bar trash action, but deletion is disabled while that connection is selected on either side of the open comparison or referenced by a queued transfer.

The comparison tab's sticky top bar contains left and right connection and language selectors, a swap action, and a workspace-persisted **Lock languages** checkbox. While locked, changing either language selects the same configured language on the other side using case-insensitive matching. Enabling the lock when the selections differ asks which current language should win and succeeds only when that language is configured on both connections. A language or connection change that cannot preserve the lock is blocked and offers an explicit unlock action; unlocking for a connection change selects `en` on the new connection when available, otherwise its first configured language. Item-version availability and Sitecore language fallback do not count as connection-level language availability.

Changing only comparison languages keeps the current tree visible while preparing a replacement in the background. A label centered at the top of each reloading side shows its target language, for example "Switching to en-CA...". Once the selected item, previously expanded branches, and their required details are ready, the view updates in one step, preserving selection and scroll position; collapsed branches stay collapsed. The unchanged comparison side reuses its loaded data. Field Diff follows the committed selection. Tree transfer, publishing, and editing actions are unavailable during preparation, while scrolling, language choices, and item selection remain available. A failed load retains the previous view and offers Retry; choosing its displayed language restores it immediately. New language choices supersede pending preparation, and favorite or site navigation takes precedence. If an item no longer exists, the prepared view selects its nearest available ancestor with an explanation. Connection changes retain the full reset behavior.

Comparison navigation supports exact normalized Sitecore item IDs, absolute paths, and indexed item-name search. Selecting a match loads its ancestor path rather than expanding the entire tree. See the navigation sections below.

Comparison rows display the configured Sitecore `__Icon` when it resolves through the selected connection's authenticated, same-origin `/-/icon/` handler to a supported raster asset. A non-empty item field, including an effective Standard Value, takes precedence; otherwise, the extension resolves the `__Icon` stored on the item's data-template definition. Template lookups are deduplicated within each item batch. Raw icon identifiers and legacy standard-theme paths are normalized to the handler. Icon metadata and image data load separately from the structural tree and use bounded, connection-scoped caches, pending-request deduplication, cancellation, and limited concurrency. Completed icon images are applied progressively so a slow image request does not delay other resolved icons from the same tree level. Only validated PNG, JPEG, GIF, WebP, or ICO content within the size limit is converted to a data URI for the webview; SVG, redirects, external origins, and unsupported paths or content retain the lightweight fallback. Icon availability is presentation-only and never contributes a comparison difference or synchronization operation.

Clicking a configured site beneath a connection reveals its root item using the same navigation behavior as favorites. A comparison must already be open with that connection selected on either side; clicking a site preserves the connection selections. Loaded rows are reused, missing ancestor levels are loaded as needed, and newer site or favorite clicks supersede earlier navigation. The site globe changes to spinning arrows while its root is loading and returns on completion, failure, cancellation, or superseding navigation. Site and favorite indicators remain separate even when they point to the same path. An unavailable site root reports an error without offering to remove a favorite.

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

Fields have comparison states but are not rendered as tree nodes. Right-clicking an item and choosing **Show Detailed Field Diff** opens its field table in a bottom-panel tab. While visible, that tab follows selection in the comparison tree; closing it stops synchronization. The summary displays each available item ID and its existing path as native keyboard-accessible clipboard buttons in Browse and on each Compare side. Both use the extension-host clipboard API and shared inline success/failure feedback. Path requests carry only the item ID and side; the host takes the full path from its displayed snapshot, rejects stale selections and Browse-right requests, and never trusts a webview-supplied path. A sticky visibility toolbar applies one retained, panel-level profile across item selections. System fields are identified first by an internal name beginning with `__`; remaining Standard Template fields form the second category, and all other rows are content fields. Content fields support **All** and **Differences**. Standard Template and system fields support **Hidden**, **Differences**, and **All**. The default profile shows differences for content and Standard Template fields and hides system fields. Selecting a differing textual field opens VS Code's native text diff editor with the left and right Authoring values. When both sides contain a field with a **Value** difference, a right arrow above the indicator queues left-to-right and a left arrow below queues right-to-left. Each action confirms the overwrite and sends only the field ID and direction to the extension host. The host snapshots source and target fingerprints; the processor later verifies both, issues one non-retried Authoring `updateItem` mutation, and verifies the stored result. Literal copying uses `reset: false`, so empty, inherited, and Standard Values become explicit target values; fallback-derived values are rejected. The comparison also records whether each value is stored, inherited, supplied by Standard Values, or resolved through fallback so equal text does not hide a different value source.

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

B04 first delivery: new comparison tabs default to **Exact locale**, retaining Standard Values/inheritance metadata and missing versions. **Fallback** toggle buttons in both the tree comparison and Field Diff (Item Details) toolbars control the same explicit mode, retained during navigation within that tab. Off means Exact locale. **Lock Languages** uses an accessible pressed-state toggle in the tree toolbar. Each side independently reads exact and Sitecore-provided effective fields for its requested locale; the flag applies only to `item.fields`, not whole-item fallback. Exact observations and capture times remain internal evidence. The panel omits duplicate mode labels, the Exact locale values disclosure and the field-transfer reminder. Browse exposes Fallback immediately to the right of the language selector in its top toolbar and in Item Details; Lock Languages remains Compare-only. Fallback fields display an expected-source hint only for their own side's suitable configured version-0 candidate; the tooltip explains unverified per-field provenance and shows the configured chain. Otherwise source language remains unknown. This presentation hint does not change source comparison, resolution or operation decisions; equal text is value equality, not verified source equality. Source chains and a calculated resolver remain deferred until configuration and empty-value semantics are verified. Field transfers are available only in Exact locale, with host-side guards against stale requests and mode round trips. Mode changes reload field details while preserving expanded tree nodes and selection. Publishing, tasks and subtree-transfer semantics remain unchanged. See [the fallback investigation](docs/fallback-spike.md).

The comparison context menu names subtree actions **Tree Transfer Left > Right** and **Tree Transfer Right > Left**. Every transfer-mode confirmation explicitly states that transferred items include all source languages and versions, regardless of the selected comparison language.

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

### Exact item navigation

The comparison lookup accepts trimmed GUIDs (compact, dashed, or braced) and absolute Sitecore paths. Enter searches the entire left connection first and uses the right only when the item is absent; connection failures are reported. The input badge updates locally while typing: Go to ID, Go to path, or Search. Other nonempty text performs indexed name search. Lookup preserves connection/language selections and unrelated expansion, loading only ancestor levels needed to reveal the paired row. The default root is `/`; a result outside a narrower displayed root widens that scope to `/` with an inline explanation. Cancel or a newer lookup supersedes pending navigation.

### Public-page URLs

Use **Configure Connection… → Public URLs** to edit the shared template, clearly labelled **All connections**, and each site’s base URLs. **XM Cloud Sync: Configure Public Page URLs** opens this section after choosing a connection; the template still applies to every connection and site. Supported optional placeholders are `{publicBaseUrl}`, `{deploymentBaseUrl}`, `{language}`, `{country}`, and `{route}`. Language and region are inferred from the selected Sitecore language tag: `en-US` becomes `en` and `US`; `zh-Hant-TW` becomes `zh` and `TW`. A language without a region, such as `en`, leaves country unavailable; omit `{country}` or use an optional override. Existing explicit mappings continue to override inference.

URL changes are saved with the dashboard. Site discovery comes from **Test Connection**; exact site names may also be entered manually. Existing optional language overrides remain intact.

If the template uses `{publicBaseUrl}` or `{deploymentBaseUrl}`, run **XM Cloud Sync: Configure Connection/Site Public URL Values** separately to assign those origins. Alternatively, right-click a connection in **Connections**, choose **Configure Connection…**, and select its **Public URLs** section and site. The Command Palette entry opens that same dashboard section; the shared template changes only when edited and saved. The deployment value can be a configured Vercel origin. Settings `xmCloudSync.publicPageUrlTemplate` and `xmCloudSync.publicPageValues` allow advanced editing, including optional language/country overrides and a default site for ambiguous roots.

**Open public page** uses the clicked comparison side. The Field Diff summaries offer **Open left page** and **Open right page**, with the URL in each tooltip. Opening launches the resolved URL directly in the default browser without an additional confirmation. Field headings show the internal field name alongside a differing display label, so repeated labels remain distinguishable. Pages are recognized from a device layout assignment or a rendering assignment in shared/final presentation fields, including final-layout deltas whose layout is inherited from Standard Values. If Authoring returns neither assignment, page detection is unavailable. Items without detected page presentation simply omit the public-page link; Item Details and Field Diff do not show a missing-presentation warning. Datasources resolve through the nearest page ancestor within their site; shared datasources outside page ancestry are unsupported. Ancestry does not prove exclusive usage. Traced/Power Publish reuse this resolver for their editable initial application URL. Without a template, existing publishing URL behavior is preserved.

Route calculation currently uses the existing Home-relative, slug-based suggestion. Custom routing, aliases and rewrites may require editing the publishing URL or adapting the shared template; automatic Vercel discovery is not performed. Presentation inheritance is described in [Sitecore's layout documentation](https://doc.sitecore.com/xp/en/users/104/sitecore-experience-platform/edit-the-layout-of-an-item.html).

### Indexed name search

Enter other text in the same comparison input to search item names containing that text, using the selected language. Scope is visibly **Entire connection**, independent of the displayed tree root. Results list the name, full path and connection. Left is queried first; only an empty left result set triggers right-side lookup. Selecting a result uses exact navigation on the result's connection. Arrow keys move between results, Enter selects, Escape cancels, and Tab reaches results and Load more. New input, connection/language changes and explicit site/favorite navigation supersede older searches.

Search uses the documented Authoring `search` query on `sitecore_master_index` (`_name` CONTAINS and selected `_language`), with 50 index records per page and at most ten pages. Item IDs are deduplicated across versions. Index freshness and API/index permissions affect results; unsupported or failed queries show an error without scanning the tree or silently falling back to the other connection. See [Sitecore's Authoring search examples](https://doc.sitecore.com/xp/en/developers/103/sitecore-experience-manager/query-examples-for-authoring-operations.html). Refine the query if the 500-record limit is reached.

## GitHub distribution

The installable VSIX is distributed through GitHub Releases without Marketplace publishing. Version tag pushes must match the manifest and lockfile and reference a commit on `main`. CI scans Git history and the built package for secrets, then publishes the verified VSIX only after type checking and both test suites pass. Ordinary CI artifacts expire after 14 days; release assets are the download location for users. Updates are installed manually from the newer VSIX. Publishing credentials use the workflow token with write access confined to the release job.

## B18 Browse mode and session foundation

`src/comparison/contentSession.ts` defines a panel-independent Browse/Compare lifecycle. Opening one endpoint produces Browse; Compare requires two explicit endpoints and preserves independent languages even when both use the same connection. A retained side carries its connection, language, root and selected item into Browse. Language lock is explicit and inconsistent locked pairs are rejected without changing the previous state.

Transitions commit atomically after asynchronous preparation. Cancelled or failed preparation preserves the committed state; newer transitions, selection changes, cancellation and disposal invalidate earlier work. Same-key loads supersede each other, while separate keys may coexist. Results are published only while their originating session revision is current, including when transport ignores cancellation or selection returns to the same values.

Connection selection now opens Browse with one full-width tree and a single connection/language selector. Search is limited to that connection; site/favorite navigation, icons, lazy loading, refresh, cancellation and keyboard navigation reuse the existing tree. The panel consumes the session lifecycle and rejects stale tree, language and detail responses after session changes. Comparison-only controls and actions are hidden and guarded in Browse. Selecting an item opens a read-only Item Details pane with one set of field values, connection and item identity, ID/path/template/language/version context, shared/unversioned markers and source labels. Browse uses separately persisted All/Hidden controls for content, Standard Template and system fields; there are no difference filters or transfer arrows. The context menu provides identity copying, details, Standard/Traced/Power Publish, matching item task plug-ins and public-page navigation; eligible public links also appear in details. Actions reuse the existing service, configuration, confirmation, Operations and Workspace Trust boundaries. Session and detail-context checks reject stale actions and responses after selection, language or mode changes. No field editing is introduced. Explicit comparison commands retain two-sided behavior and independent languages on the same connection. Browse does not overwrite the saved comparison selection.

The top bar contains a Browse / Compare selector with active-mode highlighting. Switching to Compare retains Browse on the left and restores the partner and language remembered per source connection. First use and deleted partners require an explicit choice, including the source connection itself; unavailable languages require an explicit valid choice. A conflicting remembered language lock offers explicit unlock or cancellation without silently replacing languages. Preparation leaves the current tree and loads intact until commit. New mode choices, navigation, cancellation and disposal supersede pending preparation.

Switching to Browse always retains the left comparison side, without a side selector or prompt. Previously stored retained-side preferences are ignored and removed when preferences are next saved. The left connection, language, displayed root and selected identity carry across; bounded in-memory mode snapshots restore loaded expansions and scroll within the panel. These snapshots do not persist remote content. Workspace metadata under `sitecoreXmCloudSync.modePreferences.v1` stores only partner connection IDs, languages and lock preferences. No credentials are introduced. The toolbar has no Browse-specific Refresh button; existing context-menu refresh remains. Cancel loading is shown only while cancellable content loading is active in either mode, alongside existing search and subtree cancellation behavior.

Connection-store removal never silently substitutes an endpoint in an active session. An affected comparison returns to Browse on the left; a missing browsed source shows an explicit connection choice. Endpoint changes invalidate cached tree/language/details data and in-memory navigation snapshots. Supersession during credential lookup prevents the obsolete network request from starting. Normal UI removal remains guarded while the connection is in use.

B18 #1–#4 are implemented. Version 0.25.2 includes automated host/browser verification and recovery fixes; #5 remains pending for native desktop manual and live Sitecore acceptance. The README records verification boundaries.


Browse empty-field feedback distinguishes fields hidden by filters from an empty Authoring response. Empty responses show the selected language/version and available versions, distinguishing exact reads from fallback requests that returned no values. Show all fields restores all three Browse visibility categories. The shared bottom-panel container is named Item Details, with the paired Field Diff view retained in Compare.

Invalid publishing-status responses identify the failed contract fields and received types without exposing response values. They leave the remote outcome unknown and do not trigger an automatic republish.

Publishing status may return null language metadata. This is treated as unavailable metadata; polling and completion/failure decisions still use the validated job state and flags. Malformed non-null language values remain errors.


### Missing-translation fallback observations (0.34.0)

When a requested locale has version 0, Fallback displays the effective fields returned by Authoring without replacing its language/version metadata. Item Details shows a **configured fallback candidate** when a bounded traversal of language definitions finds a version and the item's shared Enable Item Fallback flag is enabled (including Standard Values). The candidate chain is configuration evidence, not confirmed whole-item or per-field provenance. Values always come from the original-locale server response; candidate content is never substituted. Missing/invalid metadata, cycles, failed reads or traversal limits leave the source unverified. Language-definition metadata is read in `en`; environments without readable English metadata remain unverified. Exact locale stays the default. These reads do not change or publish content.

### Authoring fallback evidence collection

Diagnostic format 3 validates every non-null outer item against the requested GUID/path and exact locale (case-insensitive), including configuration reads and the field-fallback cross-check. Fallback values within fields are legitimate and must not be mistaken for an outer-language mismatch. `withLanguageFallback` applies only to `item.fields`; label that probe as a field-fallback read and expose outer returned ID/language/version independently. Do not claim item substitution or implement a resolver.

Detect numbered-version drift between pages and restart the entire affected probe once from page one with latest version requested again by omission. Keep discarded attempts separate from active pages and configuration discovery. Record the restart; a second drift is incomplete with `item-changed` status. Same-version edits remain outside this consistency check and collection is never a transactional snapshot. Both attempts share the 50-page limit; schema/item/configuration requests share a maximum of 512 GraphQL calls and the 6 MiB evidence-entry budget, including discarded pages and request traces.

Record fixed query text and actual variables (including language, cursor and omitted/latest version selection), linked by request IDs to pages/probes. Capture per-HTTP-attempt start time, time to response headers, HTTP status or safe failure category, and scheduled retry/delay without changing transport behavior. Record whole-request timing through body parsing too. Exclude credentials, headers, cookies and raw errors. Query text may be deduplicated by ID. Declare any trace omitted by the budget. Backend identification and affinity remain deferred under B30; routing is unchanged.

A Command Palette action, **XM Cloud Sync: Collect Authoring Fallback Diagnostic**, uses a chosen saved connection and its SecretStorage credentials through the existing Authoring client. It reads the authenticated schema without requiring the browser IDE. Optionally, it collects one item by GUID in one to eight supplied locales with fallback disabled, followed by a fallback-enabled read of the original requested locale. Supplied candidates are not asserted to be the configured fallback chain. Raw null/missing values and provenance flags remain in evidence; no resolver or write target is inferred.

Collection is cancellable and bounded to 50 pages per probe and 6 MiB of retained evidence. Failed schema reads do not block independent item probes. Unavailable, malformed and limit-reached results are explicit; completed collection does not establish provenance or snapshot consistency. Open the report in an unsaved JSON editor, remove known authentication credentials, omit raw server error messages and avoid automatic persistence/upload. Reports can contain selected item content and must be reviewed before sharing. No mutation, fallback-mode UI, transfer-policy change or publishing/editor integration is included.


The item diagnostic in 0.27.0 additionally collects exact language-definition evidence and follows observed `Fallback Language` GUID references, then traverses item-template base-template/Standard Values references and reads up to 16 content-field definitions (fallback-marked first) in the supplied locales. Metadata reads use supplied `en` when present, otherwise the last supplied locale; this choice never asserts a fallback source. Preserve setting field IDs and provenance, reference links, unavailable/missing evidence and coverage limits. Limit each language/template traversal to 16 items and configuration collection to 96 item reads, under the existing evidence budget. Repeated references are not followed again. The report does not infer effective environment switches, a resolved chain, or inherited write targets. Report version 2 recognizes version-0/null-fields observations as complete with a no-local-fields outcome, without converting null to an empty field array.


The fallback spike includes Command Palette actions to create controlled test items from an existing representative item's template and diagnose the resulting set. Creation confirms the development connection/content parent/template/field and creates four uniquely named children, using source-only item-fallback enabled/disabled cases and requested-locale local-value/empty controls. Mutations reuse the Authoring client without retries, checkpoint intended paths and outcomes in workspace state, and do not alter existing items, templates, language settings or publishing. Diagnostic collection operates only on confirmed IDs in recorded runs and refuses a changed connection server. These fixtures are evidence gathering, not a complete mixed-version/reset matrix or B04 implementation. Configuration discovery supports observed locale-name links as well as GUID links, with bounded traversal and explicit unknowns.

Fallback test creation and diagnostic GUID/locale textboxes stay open when focus moves to another window, allowing IDs to be copied and pasted. Press Escape to cancel.


### Local agent access through MCP

MCP access is an explicitly started, local-only integration with selected saved connections. It is unavailable in untrusted workspaces and remote extension hosts, starts read-only, and stops on extension disposal. The UI exposes Start MCP Access, Stop MCP Access and Enable MCP Mutations in the Command Palette plus an active status indicator. Startup provides client configuration rather than editing external client settings. A bundled stdio MCP server forwards authenticated, bounded requests to an ephemeral loopback endpoint owned by VS Code. Sitecore credentials remain in SecretStorage; a separate local capability file authorizes the bridge. Host and Origin validation prevent browser-origin access, while same-OS-user processes remain within the local trust boundary.

Tools list exposed connections, cached sites and live languages, search by name, read exact-locale items by path or GUID, and collect fallback evidence. The first mutation surface previews controlled fallback-item creation or a literal update of one existing latest-version content text field, then requires explicit in-VS-Code confirmation. Session mutation opt-in is per connection. Shared/system/fallback-derived fields, ambiguous field names and missing versions are not writable. Plans expire, are bounded and cannot be replayed after approved execution starts. Writes use the existing Authoring client, never retry automatically, preserve pre-write journal checkpoints and verify field updates. Stale field fingerprints block writes but do not constitute a transactional lock. No publishing, deletion, arbitrary code or arbitrary GraphQL surface is exposed.

The workspace journal holds at most 100 records and preserves uncertain outcomes without saving update values or credentials. Reads redact known client credentials, raw remote errors are suppressed, and responses retain the diagnostic's unknown/provenance limits. Bridge limits are four active calls, 64 KiB requests, 8 MiB responses and three-minute execution. Stopping/restarting revokes the endpoint capability, clears plans and mutation grants, and does not restart pending operations. Existing comparison, transfer queue and publishing semantics remain unchanged.

MCP additionally previews first-version creation for a configured locale whose exact item has version 0 and no available local version, plus explicit reset of an eligible latest-version text field. Validate the version contract with execution skipped, recheck the item snapshot before mutation, require version 1 on readback, and record version/reset outcomes without retries. Reset readback does not assert effective fallback or require an empty value. Existing confirmations, content/field restrictions and unknown-outcome recovery remain in force.


The controlled fallback scope matrix uses a separate fixed MCP recipe: resolve built-in template metadata and `/sitecore/templates/User Defined`, create a unique template, section, five text fields, localized Standard Values and one content item beneath the chosen content parent. Require two or three configured locales ending in `en`. Only IDs created during that run may receive recipe updates. Checkpoint all bounded steps, validate resulting identities/scopes/defaults, and persist a fixture manifest only on completed creation. Partial/unknown runs retain paths and IDs without automatic replay or cleanup.

Dedicated scope field/version previews require the completed manifest on the same connection/server and validate the current item/template/field contract. They permit shared/unversioned text writes only on those recorded fixture fields, and version 2 only on the recorded content item. Scope effects are explicit in the confirmation preview. General field mutation restrictions remain unchanged. Exact MCP reads may request a positive version and must reject a different returned version. These tools gather evidence; they do not enable comparison fallback or assert source-language provenance.

The isolated rule preview permits only the shared and versioned fallback checkboxes on the completed fixture's recorded FixtureEnabled/FixtureDisabled definitions, in recorded locales. Check the fixed Template field identity, exact definition path, version 0/1, content-field type/scope and known checkbox IDs/types/scopes. A missing local metadata version may be created after skipped-contract validation; then update the two booleans, with at most two separately checkpointed writes. Recheck the full English/local snapshot before execution and verify returned metadata and values. Partial/unknown outcomes are retained with no retries. Native confirmation describes shared scope and any version creation. Do not expose generic template editing, modify environment switches, or interpret a cleared local checkbox as a guaranteed disabling override.


## Item editor Stage A (B24/B25, ordinary-item B28 entry)

Browse and the clicked Compare side expose Edit… for a dedicated custom-document editor. Each tab is bound to connection/item/locale/concrete numbered version and keeps its own draft. Latest resolves on opening; locale/version navigation opens another existing target. No version creation or publishing occurs. Known page-presentation items and items outside content remain read-only; B27 is deferred.

The Stage A allowlist is Single-Line Text, Multi-Line Text, Checkbox, Integer, Number, Date and Datetime. Show template sections, internal names, labels, type, scope and value source. Preserve untouched values exactly, text whitespace/newlines and numeric precision. Datetime is explicitly UTC with compact UTC serialization; ambiguous stored representations are read-only. Date is date-only with midnight storage. Clear is explicit empty, not reset; inherited/Standard Values become explicit only when edited. All other types remain visible and read-only, including Rich Text until visual and HTML source modes preserve content when switching.

Save requires explicit native confirmation (also for autosave), rereads the pinned exact-locale version, checks template and changed-field fingerprints, persists intent before the non-retried mutation, records acknowledgement and verifies readback. No atomic conflict lock is claimed. Partial/unknown outcomes retain drafts and require read-only reconciliation; unknown unconfirmed writes cannot replay. Shared/unversioned effects are warned and cached comparison details across locales are invalidated after confirmation. VS Code owns native dirty/close/discard/backup handling; local content snapshots and save journals permit recovery. Draft edits use native custom-document edit events for Undo/Redo; one completed reorder is one undoable edit. Undo never writes remotely, and restored drafts still require the normal Save checks. Revert invalidates earlier callbacks; backups retain values rather than full session undo history. Full B26 fallback-source editing is deferred; missing local versions never cause materialization. Bottom Item Details remains an inspector.

Item-editor failures expose the failed operation stage and safe error categories without raw server text. Durable state uses a `.xmitem.state` sidecar so journal writes do not replace the open custom-document resource. Existing single-file journals remain readable; unresolved durable intent takes precedence over older VS Code backups.

Every item-editor field, including read-only fields, has a hover/click/focus information icon containing its internal name, type, scope, value source and stored value. Reference paths appear there when resolved. Stored values describe the loaded snapshot until Save or reload; drafts remain in the controls. Long values scroll within the popover. Read-only reasons remain visible beside the field.

Item-editor fields are grouped into collapsible Sitecore template sections, ordering sections by section sort order and then name, and fields within them by field sort order and then name. Content groups start expanded; groups containing only standard-template fields start collapsed. Click a heading or use Enter/Space to toggle it. Each editor remembers section expansion across refreshes and webview restoration. Collapsing does not discard drafts. Inherited sections with the same name share one visual group, using the lowest contributing section sort order. Fields are sorted across the merged group. Previous expansion settings migrate by keeping the merged group open if any contributing group was open.

Editor field headings resolve template-field Title metadata asynchronously (selected locale, then English for presentation only), falling back to the internal field name. Authoring value labels such as “standard value” are never used as headings. Internal names and value provenance remain in the information box.

## Item editor Stage B1 — single-selection controls

B1 extends the existing pinned custom document, draft/journal, explicit Save, conflict/readback and no-retry pipeline with Droplist, Droplink, Grouped Droplist, Grouped Droplink and Droptree. Droplists store names; link/tree variants store one canonical braced GUID on explicit selection. Original representations remain intact when untouched. Searchable popover result rows expose groups; the keyboard-accessible tree loads a child level on explicit navigation. Original raw selections remain visible when missing, inaccessible, ambiguous or outside the current Source. Opening/loading/filtering creates no draft; duplicate names cannot be newly selected in name-based controls.

Absolute Sitecore root paths and item IDs are supported; flat lists additionally support the bounded child-query extension below. Flat lists select children, grouped lists grandchildren and Droptree descendants excluding the root. Other query expressions, relative paths, empty sources, tokens and filters are explicitly read-only. Root and branch identities/locale are verified, complete pagination is bounded, and malformed, repeated, moved, duplicate or out-of-scope results fail closed. The Source is read as shared template metadata using the edited connection; a version-zero definition may use an advertised existing metadata version only after verifying shared Type/Source. No new content locale is inferred. UI results are scoped to document identity/revision, superseded requests are aborted, and disposal/Save cancels pending choices. Save reloads Source and re-evaluates membership before intent persistence and the existing single non-retried mutation. Concurrent change after validation is still possible.

Limits: 64 template field definitions, 1,000 choices per list/branch, 50 groups, 20 child pages and 30 seconds per choice/validation operation. Metadata unavailability only disables the affected selection field. B3 General Link/Name Value List, Rich Text, media, fallback-source editing, page editing and publishing are deferred. Live read-only Dev evidence confirmed shared Source/Type for Droplist/Droplink and version-zero metadata in en-AU; real selection writes were not performed.

Checkbox controls expose only checked/unchecked editing, with no separate Clear action. Selection item paths returned by Authoring are literal data and may contain braces; Source-expression parsing remains separate, and structural path/membership checks still apply.

Selected reference labels resolve asynchronously when editor fields are shown, with at most four concurrent exact-connection/locale lookups. Name-storing lists show the stored name immediately. Label resolution also supports read-only fields, never changes drafts or verifies Source membership, and does not load the choices list. The compact textbox shows the display name; a hover/click/focus information popover contains metadata, the raw stored value and full path; unavailable references retain their value. Requests are cancelled on refresh/save/disposal and responses must match the document revision and current field value.

Selection choices open from the textbox (click, Enter, Space or Arrow Down), with Clear immediately to its right. Selection closes the picker and returns focus to the textbox. Escape, outside pointer interaction and focus leaving the field dismiss it without changing values. Closing fences late choice responses; only one picker is open at a time.

## Item editor Stage B2 — multiple-selection controls

Checklist, Multilist, Treelist and TreelistEx reuse B1 metadata/Source resolution and Stage A drafts, backups, Save/Revert, conflict checks, non-retried writes and readback. Checklist uses searchable add-only choice rows and has no reorder controls. Multilist uses available/selected lists with explicit Add/Remove and same-field drag-handle or Alt+Up/Alt+Down reordering. Tree lists use a branch-lazy Source-constrained tree and the ordered selected list. Native buttons provide keyboard access; closing fences stale choices.

Explicit root paths/IDs allow children for flat lists and descendants excluding root for trees. Checklist/Multilist also support the bounded child-query extension below; other query/parameter/filter/relative/token/empty Sources stay read-only. Partial or over-limit pages never become selectable. Preserve every retained reference token and order; only explicit edits affect the stored pipe-separated value. Original unavailable/out-of-source IDs remain visible/removable and survive additions/reorders. Reject duplicates, malformed tokens and more than 256 references as read-only. New IDs serialize as braced GUIDs. Source, type and exact value fingerprints are rechecked at Save; only additions require current membership, while retained IDs remain intact. No fallback materialization, page editing, publishing, B3 or media support is introduced.

Read-only Dev inspection confirmed braced pipe-separated values and real Multilist query Sources; complex query configurations remain read-only. No real content was mutated.

## B1/B2 bounded child-query extension (0.39.0)

Flat Droplist/Droplink/Checklist/Multilist Sources accept only `query:./child::*[@@templateid='GUID']` and the abbreviated `query:./*[@@templateid='GUID']`. Fully anchored parsing permits whitespace between tokens, paired single/double quotes, and compact/dashed/braced-dashed GUIDs of either case. Keywords are case-sensitive. Other syntax stays read-only, including grouped/tree query Sources.

Evaluate against the editor's pinned item ID, connection and locale, never the current tree selection, referenced item or site root. Enumerate complete bounded immediate-child pages, verify identities/paths/locales and direct template IDs, then filter by equality without inherited-template matching or descendant crawling. Missing template metadata, permission errors and incomplete/over-limit pages are failures; an empty complete result is valid. Existing 1,000-child/20-page/30-second limits apply before filtering. Source and field conflicts are checked on Save; new membership is freshly revalidated before intent persistence, retained unknown references keep their exact tokens, and no new save/recovery path is introduced. Concurrent changes after validation are still possible.

Official Authoring examples establish item and index-search operations, not a reliable contextual field-Source evaluator. This deliberately bounded implementation uses existing paged children and template metadata, not general query execution. B3 and media remain separate.

## Selected-item reorder UX (0.40.0)

Multilist, Treelist and TreelistEx selected rows have a left drag handle, truncated label with full name/path tooltip and a permanently reachable right-side Remove action. Visible Move up/down buttons are removed. Keyboard users focus the handle and press Alt+Up/Alt+Down; an accessible hint, focus retention and live move announcements support this interaction. Checklist remains unordered. Drop indicators distinguish insertion before/after; first/last positions, edge scrolling, no-op and cancellation are supported.

Only local same-field drag sessions with an unchanged value snapshot and revision can reorder. External/cross-field/cross-editor drops, stale controls and blocked states cannot reorder. The host validates the current value snapshot and an exact-token permutation; it rejects additions, removals, representation changes and duplicate/malformed lists through this path. New order affects only the draft. Native custom-document edit events support coherent Undo/Redo, including restoring prior values after Save without replacing the fresh base or other fields. Save, Source-query membership, conflict checks, journals, backups and readback remain in place.

## Compact item-selection popovers (0.41.0)

Multi-selection uses Add items, with a compact anchored popover shared visually with single-selection. Search/header stay fixed while only results scroll. Position prefers beneath the trigger and flips above when needed; width and height are viewport-bounded. Each result is a keyboard-accessible button showing its name, duplicate-only relative-parent detail, full-path tooltip and Current/Added indicator. Duplicate labels within one parent additionally expose their internal name. Added rows remain focusable but cannot add twice; removal/reordering lives only in the selected list.

The picker header shows only the final item name in the current Source hierarchy, with full path/expression tooltip. Tree fields retain explicit child-level navigation and Back; search is restricted to the displayed level, with an explanatory scope note. No source scope, query parsing or unloaded-descendant discovery is changed. Escape/Close restores trigger focus, outside interaction respects its focus destination, and dismissal preserves additions already made to the draft. Pending response tokens/revisions and document lifetime checks remain in force. Error, loading, empty, all-added and selection-limit states are visible. Existing Save, conflict, Undo/Redo, backup, unresolved-reference and Source restrictions are preserved.


## Structured item fields — Stage B3 (0.42.0)

Deliver Name Value List first, then ordinary General Link, within the existing item editor. No new editor identity, page editor, publishing, Rich Text/HTML editor or fallback-source writes. Only changed eligible fields enter the existing mutation journal, scope confirmation, conflict checks and numbered-version readback. Native Undo/Redo and backup must retain original representations, including Undo after a confirmed Save or Clear. Invalid drafts stay recoverable and cannot be submitted.

Name Value List uses an ordered array of entries, never a dictionary: zero to 256 name/value rows, preserved duplicates and empty values, exact unchanged raw entries/halves, percent-encoded UTF-8 edits and plus-as-space decoding. Split each entry only at its first equals sign. UI adds/removes rows without offering reorder. Empty keys, missing separators, malformed percent/UTF-8 escapes, control characters and oversized lists are read-only. New case-insensitive duplicate keys are validation errors; existing duplicates stay independent. Consumer merge/lookup semantics are not assumed. Removing every row/Clear writes an empty string, not inheritance reset.

General Link supports case-sensitive ordinary `internal`, `external`, `mailto`, `anchor` tokens on one empty `link` XML element (self-closing or explicit close). Expose only applicable destination, text, title, target, class, anchor and querystring controls. No DTD/entity expansion, namespaces, child elements, duplicate attributes or external resource access. Decode XML entities safely; serialize changed attributes with XML escaping while retaining untouched attributes byte-for-byte. Bound XML to 256 KiB, 128 attributes and 64 KiB per attribute. Internal links use the same bounded tree picker; verify shared Source/Type metadata, use `/sitecore/content` for a confirmed empty Source, allow an explicit root path/ID including that root itself, reject query/parameter Sources. Revalidate changed target identity and Source containment on the pinned connection/locale; retain existing unresolved IDs on unrelated edits. Field Source/type changes conflict at Save.

Allow absolute HTTP(S) destinations without credentials/whitespace, one email address without headers/query parameters, anchors without whitespace/leading hash, and standard or named-frame targets. New anchor links store the destination in `url`, matching the LinkField example. Preserve existing anchor-only or matching URL/anchor representations; reject conflicting destinations. Do not execute or preview destinations. Media, JavaScript, custom connector link kinds and General Link with Search remain read-only. For supported ordinary links with unknown attributes, preserve metadata and allow only text/title/target/class edits or explicit Clear; destination/kind changes are blocked. Full DAM asset selection, images/files and uploads are outside B3.

Evidence: read-only Dev component examples confirmed ordinary internal XML with id/anchor/querystring and external XML with url, plus an empty shared Source on the template field. Sampled page Name Value Lists were empty. Sanitized round-trip fixtures cover non-empty entries, XML variants and custom attributes; no live write was performed. Sitecore documents ampersand-separated pairs and query-string parameter encoding, ordinary LinkField variants and custom Content Hub mapped attributes. Duplicate-key consumer semantics and connector-specific kinds are deliberately not inferred.

Primary references:
- [Sitecore simple field types](https://doc.sitecore.com/xp/en/developers/100/sitecore-experience-manager/the-simple-field-types.html)
- [Sitecore rendering data field formats](https://doc.sitecore.com/sai/en/developers/sitecoreai/introduction-to-framework-agnostic-sitecore-development/content-rendering/field-types-in-rendering-data.html)
- [Sitecore query-string parameter encoding](https://archive.doc.sitecore.com/xp/en/SdnArchive/upload/sitecore6/64/presentation_component_reference-usletter.pdf)
- [Sitecore General Link properties](https://doc.sitecore.com/xp/en/developers/105/sitecore-experience-manager/access-general-link-fields.html)
- [Content Hub public links and mapped attributes](https://doc.sitecore.com/xp/en/developers/connect-for-ch/52/connect-for-content-hub/manage-public-links-to-a-dam-asset.html)


## Compact General Link and recoverable alternatives (0.43.0)

Use a single-choice radio group styled like Item Details Hidden/All: Sitecore item, External URL, Email, Anchor. One active type, roving tab stop, Arrow/Home/End and Space/Enter keyboard operation. Collapsed fields show the type group, one destination (item path/URL/email/anchor), separate Clear, properties chevron and a concise non-default property summary. Expanded properties are inset with surrounding spacing to group them within the field. Destination focus/click and type changes expand inline properties. Moving focus inside the field does not collapse; validation failures force expansion, including restored invalid drafts. Only the existing source picker is a popover. No link execution or automatic save.

Keep common text/title/target/class values across type switches. Store bounded per-type id/url/anchor/querystring alternatives inside the existing field draft input; invalid intermediate destinations are allowed while inactive. The host validates the active link and alternative shape, and serializes no alternative data. Conversion removes inapplicable ordinary XML attributes. Preserve original XML for unchanged values and existing custom metadata; protected custom/DAM links show only their current type, with destination/type conversion blocked. Unsupported kinds show a read-only type identifier. Source/context/fallback guards remain unchanged.

Native edit events, dirty state, Undo/Redo and backup/reload include alternatives. Successful Save clears all temporary alternatives, even when the active serialized content is unchanged and no mutation is needed. Explicit Clear clears them too. Revert reloads the saved link, clears alternatives and ends prior edit history. Undo after Save restores local history and requires another explicit Save to change Sitecore. Invalid active data blocks Save but never blocks switching back. Keep open/closed properties state independent of dirty content; it may remain expanded after a host refresh.


## Read-only field presentation (0.44.0)

Read-only fields remain inspectable. The item editor shows Image and File XML attributes (including unknown/custom mappings), available alt text, dimensions and references. A valid media ID identifies a Media Library reference; DAM identifiers identify Content Hub. Ambiguous or unknown providers are labeled accordingly. Empty strings, unreadable values, malformed populated values and preview failures are distinct. Raw stored values are escaped, inspectable and never rewritten by this presentation. Existing locale/version/scope/fallback labels and field-visibility controls are retained.

Use **Load preview** for an Image with a stored supported URL, **Check file reference** for a File, or **Resolve media reference** for a Media Library ID without a supported URL. Resolution uses the captured connection/locale and verifies the returned ID and Media Library path. It does not invent a media URL. Asset requests start only on demand, with at most three concurrent requests per document and a 20-second timeout. Asset HTTP reads have no retries; Media Library item resolution uses the existing Authoring read policy. Raster previews support PNG, JPEG, GIF and WebP with verified MIME/signatures, capped at 8 MiB; SVG and other formats retain metadata/source rather than executing markup. An explicit **Open asset** action appears only after a successful supported response. File validation uses HEAD and supports PDF, ZIP, binary, text, raster image, MP4 and MP3 responses. Redirects, private/unavailable assets, unexpected formats and oversized responses leave metadata/raw content intact with a failure message and retry option.

Only explicit same-origin `/-/media/` or `/~/media/` URLs receive existing Sitecore authentication. Content Hub `/api/public/content/` URLs on `*.stylelabs.cloud`, `*.stylelabs.com`, `*.stylelabs.io` and `*.sitecorecontenthub.cloud` are fetched anonymously. Gateway/private URLs, custom CDN hosts, credentials/signature/token query parameters and unsafe schemes are not fetched. No credentials reach the webview or an external host. Remote URLs are never webview image sources: only bounded raster data is passed to the editor. TLS verification remains enabled; environments with enterprise certificates must have a trust configuration accepted by the extension host. No Content Hub credential setup is added.

Rich Text has a formatting-only read-only preview rebuilt from allowed HTML elements, plus escaped **HTML source (unchanged)**. No original attributes, scripts, styles, active links, embedded media, SVG, forms or remote resources are attached to the document. Embedded images become alt-text placeholders. Preview size/depth/node limits do not truncate the inspectable source. Other unsupported/custom/system field values remain readable raw text under their existing visibility rules. This adds no Rich Text editing, image selection, upload, publication or fallback-source mutation.

Item Details uses the same Image/File metadata, raw-value and Rich Text display; asset loading/resolution remains in the item editor. Text diff and field transfer semantics remain unchanged. The live Dev sample confirmed Content Hub image attributes (`dam-id`, `dam-content-type`, `thumbnailsrc`, `src`, alt and dimensions); a supplied public JPEG passed the read-only loader using system certificate trust. Media Library URL responses, private assets, Files and failure/security behavior were exercised with isolated fixtures, not live writes.

References: [Sitecore image fields](https://doc.sitecore.com/xp/en/developers/92/sitecore-experience-manager/access-image-fields.html), [Content Hub attribute mappings](https://doc.sitecore.com/xp/en/developers/connect-for-ch/51/connect-for-content-hub/change-the-image-tag-attribute-mapping-in-sitecore.html), [Content Hub public links](https://doc.sitecore.com/ch/en/developers/cloud-dev/public-links.html).
