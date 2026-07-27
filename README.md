# XM Cloud Sync

XM Cloud Sync is an early-stage VS Code extension for comparing and synchronizing Sitecore XM Cloud authoring content.

The current build supports multiple saved XM Cloud connections, automation-client authentication, authenticated connection testing, a document-style comparison workspace, and a durable asynchronous transfer queue.

## Add and test a connection

Create an environment automation client for the XM Cloud environment in Sitecore Deploy. Keep its client ID and client secret available.

1. Open the **XM Cloud Sync** activity view.
2. In **Connections**, select **Add Connection**.
3. Enter a unique name, the CM server URL, client ID, and client secret.
4. Select **Test Connection**, or use the play button beside the saved connection later.

The client secret is stored in VS Code `SecretStorage`. OAuth access tokens are kept in memory only.

Deployment monitoring is optional. The extension first tries the connection's existing credentials; if they already have Deploy API access, no setup is needed. Otherwise subtree transfers continue normally without monitoring. To enable the additional guard explicitly, right-click a connection and select **Configure Deployment Monitoring**, then enter an organization automation client with Deploy API access. The extension matches the saved CM hostname to its deployment environment and stores the additional secret in `SecretStorage`.

After a successful test, expand the connection to see every configured site returned by the Authoring API, including its root path and root item ID. The success notification also provides a searchable **Show Sites** list. This API list can include sites that are not shown as ordinary site tiles in Channels.

If the Authoring API returns identical site records, the extension displays the site once and reports the number of duplicate records omitted. Records are considered identical only when their name, root path, and root item ID all match exactly.

## Open a comparison

Run **XM Cloud Sync: Open Comparison** from the Command Palette or use the diff icon in the XM Cloud Sync activity view. The comparison opens as a document-style tab with independent left and right connection and language selectors plus a swap button. Choices are remembered per workspace.

One XM Cloud connection is sufficient. Select the same connection on both sides to compare languages such as `en` and `de`, or select different connections to compare environments. **Compare with…** also offers the selected connection itself for cross-language comparison.

Selecting a connection reveals a trash action beside **Add Connection** and **Open Comparison**. A connection used by the open comparison cannot be deleted. **Paste as Connection URL** is available by right-clicking a connection and as an action in the empty Connections view; it accepts a full XM Cloud URL copied from Content Editor, extracts its HTTPS origin, and prefills the connection wizard.

Right-click a comparison item and choose **Add to Favorites** to save its Sitecore path beneath one or both participating connections. Favorites are marked with `☆` in the Connections view and can be removed from their context action. Clicking a favorite navigates only when a comparison is already open and its connection is selected on the left or right; it never changes either selection implicitly. Right-click a favorite and choose **Compare with…** to place its connection on the left, choose the right connection explicitly, and then reveal the saved item. Already-loaded rows are revealed without an API request; otherwise the extension resolves the path with Authoring GraphQL and loads the ancestor chain needed to display it. If the saved path is unavailable, the error prompt offers to remove the stale favorite.

The comparison tab loads the authoring root and its immediate children on both sides. Expanding an item loads its latest numbered version, complete field set, template metadata, and direct children using paginated Authoring GraphQL requests. Loaded details are cached for the lifetime of the extension, while clicking an item only selects it and never causes a refresh. Expanded rows contain child items only, keeping the structural tree compact.

Right-click an item and choose **Show Detailed Field Diff** to open the **Field Diff** tab in VS Code's bottom panel. The panel follows item selection only while it is visible and stops synchronizing when closed. It displays the complete paired field table with item, connection, language, template, path, and latest-version context. Each available item ID is visible beneath that context and copies to the system clipboard with one click. Fields are paired by normalized field ID. Shared fields carry an `S` marker, unversioned fields carry `U`, and the common versioned fields are unmarked. The sticky visibility toolbar classifies every row once: names beginning with `__` are system fields, remaining Standard Template fields form the second category, and all remaining rows are content fields. Content fields can show all rows or differences; Standard Template and system fields can be hidden, limited to differences, or shown in full. The default profile shows content and Standard Template differences while hiding system fields. One profile is retained across item selections and webview restoration rather than stored per item. Populated local overrides are marked on field rows, and textual fields can open VS Code's native text diff. When both sides contain a field with different values, the arrows above and below its **Value** indicator add a confirmed field transfer in either direction. Processing uses one Authoring `updateItem` mutation. An inherited or Standard Value becomes an explicit stored target value; fallback-derived values are not eligible.

Loaded items are displayed in one paired-row tree so the left and right sides share selection, expansion, and scrolling. Items are matched by normalized Sitecore item ID. The comparison marks left-only and right-only items, same-path items with different IDs, and differences in path, name, or child presence. The left hierarchy supplies the primary row order; right-only items are inserted near their closest loaded right-side neighbour.

Tree rows show only the item display name so deeply nested content remains readable. The tooltip contains the full path, item ID, and field-comparison lifecycle state: not loaded, loading, equal, different, or failed. Equal, unchecked, and background field-loading states remain visually unmarked. When the display name differs from the underlying item name, the display name is blue and the tooltip also includes the item name. A single red `⚠` marker identifies field-detail or child-loading failures; its tooltip lists the affected side, failure category, and error message.

Right-click a paired row and choose **Refresh Item** to re-read only its template, latest version, and fields without replacing its loaded child tree. Choose **Refresh Subtree** to invalidate and re-read that item plus every descendant level already present in the lazy snapshot. Subtree refresh proceeds from parent levels to child levels so the visible hierarchy remains coherent. The affected rows are temporarily locked; a refresh in a completely disjoint subtree can run at the same time. Unloaded descendants remain lazy and are not fetched solely because of a subtree refresh. If the visible **Field Diff** panel is showing an item covered by either command, it refreshes immediately from the new field snapshot.

Use the toolbar refresh button or **XM Cloud Sync: Refresh All** to greedily re-read every item and field beneath the configured root on both sides. Because this can be expensive for large trees, VS Code asks for confirmation first and shows cancellable progress. The complete comparison is locked during the operation, while independent left and right traversal remains concurrent.

For large Sitecore trees, right-click a paired item and choose **Expand All…**. The ellipsis indicates that a native VS Code warning asks for confirmation before any requests begin. After confirmation, only descendants of that item are fetched and progressively expanded. The selected subtree is locked while it loads, but unrelated parts of the comparison remain usable. Left-only and right-only rows load only their existing side. Disjoint subtree operations may run concurrently; overlapping operations are disabled. Use the cancellable VS Code notification or right-click the operation root and choose **Cancel Expand All** to stop it.

The paired-row context menu shows **Expand Item** or **Collapse Item** according to the selected row's current state, followed by **Expand Loaded Items** and **Expand All…**. A separator groups **Refresh Item** and **Refresh Subtree**. **Expand Loaded Items** recursively expands complete cached levels beneath the selected item without issuing Authoring API requests and does not change expansion elsewhere in the comparison. Partially loaded branches remain lazy.

## Queue and process transfers

Right-click an item and choose **Add Subtree Transfer Left → Right…** or **Add Subtree Transfer Right → Left…**. Choose **Add missing content** to preserve matching target items, **Synchronize from source** to replace matching items while retaining target-only descendants, or **Exact mirror** to replace the complete target subtree and delete target-only descendants. The last selected type is remembered globally and offered first next time.

Before confirmation, a cancellable structural preflight enumerates both subtrees and reports source and target counts plus how many items will be added, overwritten, or removed. Exact mirror uses a short **Replace target tree?** warning that states the target subtree will be deleted and recreated, then reports matching, source-only, and target-only item counts. There is no separate production-target checkbox. After confirmation, the extension adds the subtree and its transfer type to the workspace's FIFO queue. Field Diff arrows add field-value transfers to the same queue. Duplicate pending requests are not added twice.

Open **Transfers** in the activity view and select Play to process records one at a time in insertion order. Pause stops before the next transfer or between remote polling windows; an already-issued request is allowed to reach a safe boundary. Queue contents, order, processing state, and remote checkpoints survive VS Code restarts. Completed records disappear after a secret-free journal is written. A failure remains at the queue head, pauses processing, and can be retried or removed.

Subtree rows show six phases: queued, freshness checking, content export, chunk copying, Sitecore import, and verification. Chunk copying uses the actual Content Transfer count, for example `copying chunks (4/6, chunk 7/23)`. The Sitecore phase reports completed transfer blobs and elapsed phase time, for example `Sitecore (5/6, blob 0/1 imported, 8m 15s)`. Item Transfer polling starts near two-second intervals, backs off to 5, 10, and finally 15 seconds for long-running imports, and applies small jitter. Field-value rows show four phases from queued through verification. Detailed subtree progress is persisted with the queue record and remains visible on failure.

Subtree processing uses Content Transfer and Item Transfer with `KeepExistingItem`, `OverrideExistingItem`, or `OverrideExistingTree` according to the selected transfer type, preserving IDs and transferring every language and numbered version. It is disabled for the same XM Cloud environment and the complete `/sitecore` root. Same-path/different-ID conflicts block add-missing and synchronize transfers; exact mirror resolves them by removing the target identities and writing the source identities. Only explicit `TransferState: Finished` is success; unknown consumed history remains pending and is polled over as many windows as necessary. Field transfers re-read both endpoints, reject changed source or target state, issue one non-retried Authoring mutation, and verify the result. Finished work refreshes affected loaded comparison data.

When deployment information is available for both sides, the processor records the latest source and destination deployment IDs at subtree start. It checks those IDs during long-running Content and Item Transfer polling, throttled to at most once every 15 seconds, and persists the baselines for restart recovery. If either ID changes, the transfer fails, the queue pauses, and retry discards the old remote checkpoint and starts a fresh transfer. Missing permissions and temporary monitoring errors are logged but never block or fail a transfer.

## Publish with tracing

Right-click the left or right item cell in the comparison and open **Publish**:

- **Standard publish…** performs an ordinary Sitecore Smart or Full publish for the selected language, with optional descendants and related items. It monitors the Sitecore operation to completion and reports through a notification and the **XM Cloud Publish** output channel.
- **Traced publish…** additionally snapshots authoring content and verifies propagation through raw Experience Edge items, optional rendered route layout, and an optional public application response.
- **Power publish…** discovers an **Observed Reference Graph**, lets you select its items, publishes dependencies first and the selected root last, then performs the same trace.

Traced publishing asks for the Experience Edge GraphQL endpoint and API token on first use. The token is stored in VS Code Secret Storage. Site names returned by **Test Connection** are retained with the connection: a single site is selected automatically, while multiple sites are presented by exact name and root path. If no verified site catalog exists, the extension retrieves it again; manual site-name entry is used only when the API returns no sites. Site and route are optional unless rendered-layout verification is wanted. Right-click a saved connection and choose **Configure Traced Publishing**, or run **XM Cloud Sync: Configure Traced Publishing**, to replace the endpoint, token, or default site later.

The application URL is always optional. When supplied, the extension makes a normal public HTTPS request and records status plus cache headers such as `Age`, `Cache-Control`, `x-vercel-cache`, and `x-vercel-id`. This requires no Vercel credentials. If the URL is omitted or inaccessible, only that stage is skipped or marked unavailable; Sitecore and Experience Edge tracing still run.

Traced and Power operations use one progressive **Publish Trace** document. Evidence and the Observed Reference Graph stay collapsed until opened. Standard publish normally uses only progress notifications; the trace opens if it fails. Run **XM Cloud Sync: Show Latest Publish Trace** to reopen recent evidence or **XM Cloud Sync: Show Publish Output** for low-level polling details.

Publish operations and their Sitecore operation IDs are persisted so monitoring can resume after VS Code restarts. Redacted JSON journals are written beneath VS Code extension storage. Publish mutations are not retried automatically.

## Item task plug-ins

Right-click a comparison item and choose **Run task…** to run a matching workspace JavaScript or PowerShell plug-in. Create each plug-in beneath `.xm-cloud-sync/tasks/<task-name>/` with a `task.json` manifest and a script contained in the same directory. Tasks can match an item by template ID, item ID, exact immediate-parent path, or exact ancestor path; rules within a manifest are OR conditions. When both comparison sides match, the picker identifies the side, connection, language, and path.

```json
{
  "id": "validate-product",
  "name": "Validate product",
  "description": "Checks product content.",
  "script": "validate-product.js",
  "execution": {
    "type": "javascript"
  },
  "inputs": [
    {
      "id": "market",
      "type": "pick",
      "label": "Market",
      "required": true,
      "options": [
        { "label": "United Kingdom", "value": "uk" },
        { "label": "Germany", "value": "de" }
      ]
    }
  ],
  "matches": {
    "templateIds": ["{TEMPLATE-ID}"],
    "itemIds": [],
    "parentPaths": [],
    "ancestorPaths": ["/sitecore/content/Products"]
  }
}
```

Inputs support `text`, `number`, `pick`, and `boolean`. Common properties are `id`, `type`, `label`, optional `description`, `required`, and `default`. Text inputs can provide `placeholder`; number inputs can provide `minimum` and `maximum`; pick inputs require scalar options or `{ "label", "value", "description" }` objects. Collected values are available as `context.inputs.<id>`.

JavaScript is the recommended execution type for XM Cloud content automation. Set `execution.type` to `javascript` and use a `.js`, `.cjs`, or `.mjs` script that exports an asynchronous `run(context, sitecore, log)` function. The script runs in an isolated Node child process. Its `sitecore` object sends a restricted set of operations back to the extension, where the existing authenticated Authoring API client executes them. Client secrets and access tokens never enter the task process.

```js
exports.run = async function run(context, sitecore, log) {
  const item = await sitecore.items.get({
    itemId: context.item.itemId,
    language: context.language,
    version: context.item.version
  });

  log.info(`Updating ${item.path}`);
  const updated = await sitecore.items.update({
    itemId: item.itemId,
    language: item.language,
    version: item.version,
    fields: {
      Title: "Updated title"
    }
  });

  return { status: "ok", message: `Updated ${updated.path}.` };
};
```

The brokered item API supports:

- `sitecore.items.get({ itemId | path, language?, version? })` — returns complete item details.
- `sitecore.items.getChildren({ itemId | path, language? })` — returns the item and its immediate children.
- `sitecore.items.create({ name, templateId, parent, language?, fields? })` — creates an item and returns complete details. `parent` accepts an item ID or path.
- `sitecore.items.update({ itemId, language?, version, fields })` — updates named string field values and returns refreshed details. A version is required to avoid accidentally updating a different version.
- `sitecore.items.delete({ itemId | path, permanently? })` — deletes to the recycle bin by default; permanent deletion must be explicit.

All operations are scoped to the connection on the clicked comparison side and the `master` database. A task cannot request another saved connection. Omitting `language` uses the clicked language. Authoring mutations are not retried automatically. Cancellation terminates the worker and aborts any in-flight Authoring request. The task can return `{ "status": "ok", "message": "Done." }` or `{ "status": "error", "message": "Reason." }`; returning a string is shorthand for a successful message. See `examples/item-task-javascript` for a read-only working plug-in.

`examples/modal-slide-in-authoring` contains the JavaScript port of the modal slide-in inspection and update task. It retains the configured product-page rendering lookup and changes only the selected button's linked Table items. The update task can update, create, and recycle Table items and keeps the TableContainer multilist synchronized. Version 0.9.3 deliberately reports an error instead of guessing when an existing Table child needs a new language version, because adding item versions is not yet part of the brokered API.

Local PowerShell is the default execution type. Its script receives `-ContextPath` and `-ResultPath`. Context JSON includes schema version, task identity, collected inputs, comparison side, connection identity without credentials, language, parent and ancestor paths, and complete item details including template, versions, and fields. Standard output and error stream live to **XM Cloud Tasks**. The script can write `{"status":"ok","message":"Done."}` or `{"status":"error","message":"Reason."}` to the result path; a non-zero exit code is always failure. See `examples/item-task` for a working plug-in that can be copied into a workspace.

Set `execution.type` to `spe-remoting` for a server-side Sitecore PowerShell Extensions task. Before asking for task inputs or credentials, the extension checks whether the selected PowerShell host can discover the local `SPE` remoting module. If it is missing, execution stops and the notification can copy `Install-Module -Name SPE -Scope CurrentUser` or open the SPE package page. The extension uses the clicked side's connection URL and language, asks for a Sitecore username and password only on first use, and stores the credential per connection in VS Code Secret Storage. A read-only authentication probe must succeed before the actual task script is sent; authentication failure offers credential replacement. Deleting the connection also deletes its SPE credential. The workspace script executes inside Sitecore and receives one `Context` object parameter. SPE Remoting must also be enabled and authorized on the CM environment.

Tasks run only on an explicit click and only in trusted workspaces. JavaScript tasks run in a dedicated child process supplied by the extension. Local tasks use `pwsh -NoLogo -NoProfile -NonInteractive`, falling back to Windows PowerShell when PowerShell 7 is unavailable. SPE remoting tasks use Windows PowerShell on Windows for compatibility with the SPE client module. Scripts run under the machine's normal PowerShell execution policy. Temporary context and result files are deleted after execution. Sitecore credentials are never included in the manifest, context file, command line, or logs.

## Difference legend

| Badge | Meaning |
| --- | --- |
| `L` | The item ID exists only on the left side within the currently loaded comparison data. |
| `R` | The item ID exists only on the right side within the currently loaded comparison data. |
| `LR` | Both left-only and right-only identity states apply. The two symbols are rendered as one group while retaining separate tooltips. |
| `ID` | Items have the same path but different item IDs. This badge replaces the otherwise redundant `LR` group for that row. |
| `P` | The same item ID has different paths on the left and right sides. |
| `N` | The same item ID has a different item name or display name. |
| `C` | The two items disagree about whether they have child items. |
| `T` | The paired items use different templates. |
| `V` | Selected-language version availability differs between the items. |
| `*` | At least one field differs between these items. |
| `⚠` | Field-detail or child loading failed. This is an operational state, not a content difference. |

Identity symbols (`L`, `R`, or `ID`) form one blue group. Structural and content symbols form one orange group. Operational failure uses a separate red `⚠` marker and does not affect difference filtering or synchronization. Each symbol retains its own tooltip, and multiple symbols can coexist. Field rows use descriptive badges such as `Type`, `Scope`, `Source`, and `≠`; these are independent of the compact item-level symbols.

Connection secrets, access tokens, and Authoring API requests remain in the extension host and are never exposed to the webview.

All Sitecore OAuth and Authoring GraphQL traffic passes through a shared request client. A transient network failure or HTTP 408, 429, 500, 502, 503, or 504 response is retried up to three times after the initial attempt. Retries use exponential backoff starting near 500 ms with jitter. When Sitecore supplies `Retry-After` as seconds or an HTTP date, that delay takes precedence and also pauses other requests to the same endpoint origin. Retry waits can be cancelled. Permanent client and authorization responses, GraphQL errors, and missing items are returned immediately instead of being retried.

Run **XM Cloud Sync: Show Logs** to open the extension's diagnostic log. It records comparison loading, caching, errors, retry attempts, and cooldown waits without recording client secrets, access tokens, request bodies, or query parameters.

The comparison webview is separated into `media/comparison/comparison.html`, `comparison.css`, and `comparison.js`. The bottom-panel field view lives in `media/fieldDiff`, with its provider in `src/comparison/fieldDiffView.ts`. Extension-host lifecycle and state messaging remain in `src/comparison/comparisonPanel.ts`.

## Debug during development

1. Run `npm install` once.
2. Open this folder in VS Code.
3. Press `F5` and choose **Run XM Cloud Sync Extension** if prompted.
4. A separate Extension Development Host window opens with the development extension loaded.
5. After changing TypeScript, run `npm run compile`, then execute **Developer: Reload Window** in the Extension Development Host.

Set breakpoints in `src/extension.ts`; VS Code uses the generated source maps when debugging.

For continuous compilation, run `npm run watch` in a terminal. You still reload the Extension Development Host after compiled code changes.

## Build an installable extension

```powershell
npm run package
```

This creates:

```text
dist/sitecore-xm-cloud-sync.vsix
```

Install it using **Extensions: Install from VSIX...** in VS Code, or:

```powershell
code --install-extension .\dist\sitecore-xm-cloud-sync.vsix
```

## Update a locally installed VSIX

Increase the `version` in `package.json`, run `npm run package`, and install the new VSIX. Reload VS Code when prompted. Marketplace auto-update is intentionally outside the current development scope.

## Product specification

See `PRODUCT_SPEC.md` in the extension source or run **XM Cloud Sync: Open Product Specification**.
