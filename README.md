# XM Cloud Sync

XM Cloud Sync is an early-stage VS Code extension for comparing and synchronizing Sitecore XM Cloud authoring content.

The current build supports multiple saved XM Cloud connections, automation-client authentication, authenticated connection testing, and a single document-style comparison workspace. The activity view contains Connections and the placeholder Sync Operations view for the next milestones.

## Add and test a connection

Create an environment automation client for the XM Cloud environment in Sitecore Deploy. Keep its client ID and client secret available.

1. Open the **XM Cloud Sync** activity view.
2. In **Connections**, select **Add Connection**.
3. Enter a unique name, the CM server URL, client ID, and client secret.
4. Select **Test Connection**, or use the play button beside the saved connection later.

The client secret is stored in VS Code `SecretStorage`. OAuth access tokens are kept in memory only.

After a successful test, expand the connection to see every configured site returned by the Authoring API, including its root path and root item ID. The success notification also provides a searchable **Show Sites** list. This API list can include sites that are not shown as ordinary site tiles in Channels.

If the Authoring API returns identical site records, the extension displays the site once and reports the number of duplicate records omitted. Records are considered identical only when their name, root path, and root item ID all match exactly.

## Open a comparison

Run **XM Cloud Sync: Open Comparison** from the Command Palette or use the diff icon in the XM Cloud Sync activity view. The comparison opens as a document-style tab with independent left and right connection and language selectors plus a swap button. Choices are remembered per workspace.

One XM Cloud connection is sufficient. Select the same connection on both sides to compare languages such as `en` and `de`, or select different connections to compare environments. **Compare with…** also offers the selected connection itself for cross-language comparison.

Selecting a connection reveals a trash action beside **Add Connection** and **Open Comparison**. A connection used by the open comparison cannot be deleted. **Paste as Connection URL** is available from the Connections view context/overflow menu; it accepts a full XM Cloud URL copied from Content Editor, extracts its HTTPS origin, and prefills the connection wizard.

The comparison tab loads the authoring root and its immediate children on both sides. Expanding an item loads its latest numbered version, complete field set, template metadata, and direct children using paginated Authoring GraphQL requests. Loaded details are cached for the lifetime of the extension, while clicking an item only selects it and never causes a refresh. Expanded rows contain child items only, keeping the structural tree compact.

Right-click an item and choose **Show Detailed Field Diff** to open the **Field Diff** tab in VS Code's bottom panel. The panel follows item selection only while it is visible and stops synchronizing when closed. It displays the complete paired field table with item, connection, language, template, path, and latest-version context. Fields are paired by normalized field ID. Shared fields carry an `S` marker, unversioned fields carry `U`, and the common versioned fields are unmarked. Equal Standard Template fields are hidden by default, while differing Standard Template fields remain visible; **Show equal Standard Template fields** reveals them. **Show differences only** is enabled by default and hides matching fields. These filters apply to the currently selected item rather than being stored per item. Populated local overrides are marked on field rows, and textual fields can open VS Code's native text diff.

Loaded items are displayed in one paired-row tree so the left and right sides share selection, expansion, and scrolling. Items are matched by normalized Sitecore item ID. The comparison marks left-only and right-only items, same-path items with different IDs, and differences in path, name, or child presence. The left hierarchy supplies the primary row order; right-only items are inserted near their closest loaded right-side neighbour.

Tree rows show only the item display name so deeply nested content remains readable. The tooltip contains the full path, item ID, and field-comparison lifecycle state: not loaded, loading, equal, different, or failed. Equal, unchecked, and background field-loading states remain visually unmarked. When the display name differs from the underlying item name, the display name is blue and the tooltip also includes the item name. A single red `⚠` marker identifies field-detail or child-loading failures; its tooltip lists the affected side, failure category, and error message.

Right-click a paired row and choose **Refresh Item** to re-read only its template, latest version, and fields without replacing its loaded child tree. Choose **Refresh Subtree** to invalidate and re-read that item plus every descendant level already present in the lazy snapshot. Subtree refresh proceeds from parent levels to child levels so the visible hierarchy remains coherent. The affected rows are temporarily locked; a refresh in a completely disjoint subtree can run at the same time. Unloaded descendants remain lazy and are not fetched solely because of a subtree refresh. If the visible **Field Diff** panel is showing an item covered by either command, it refreshes immediately from the new field snapshot.

Use the toolbar refresh button or **XM Cloud Sync: Refresh All** to greedily re-read every item and field beneath the configured root on both sides. Because this can be expensive for large trees, VS Code asks for confirmation first and shows cancellable progress. The complete comparison is locked during the operation, while independent left and right traversal remains concurrent.

For large Sitecore trees, right-click a paired item and choose **Expand All…**. The ellipsis indicates that a native VS Code warning asks for confirmation before any requests begin. After confirmation, only descendants of that item are fetched and progressively expanded. The selected subtree is locked while it loads, but unrelated parts of the comparison remain usable. Left-only and right-only rows load only their existing side. Disjoint subtree operations may run concurrently; overlapping operations are disabled. Use the cancellable VS Code notification or right-click the operation root and choose **Cancel Expand All** to stop it.

The paired-row context menu shows **Expand Item** or **Collapse Item** according to the selected row's current state, followed by **Expand Loaded Items** and **Expand All…**. A separator groups **Refresh Item** and **Refresh Subtree**. **Expand Loaded Items** recursively expands complete cached levels beneath the selected item without issuing Authoring API requests and does not change expansion elsewhere in the comparison. Partially loaded branches remain lazy.

## Synchronize a subtree

Right-click an item and choose **Sync Subtree Left → Right…** or **Sync Subtree Right → Left…**. After explicit confirmation, the extension transfers that item and all descendants with `OverrideExistingItem`. Content Transfer and Item Transfer preserve Sitecore item IDs and include every language and numbered version; the languages selected in the comparison only control the preflight lookup and refreshed comparison view.

Subtree transfer is disabled when both sides point to the same XM Cloud environment or when the same path contains different item IDs. The complete `/sitecore` root is also excluded. The extension verifies that the source path still resolves to the item ID shown in the comparison and that the destination parent exists before starting the transfer.

The progress notification remains open while Sitecore processes the transfer. Completed target blobs are cleaned up, while a transfer that remains pending is retained for later processing rather than being reported as failed. Finished transfers refresh the affected loaded target subtree. Every attempt writes a secret-free journal beneath the extension's global storage; the completion or error notification can open it directly.

### Difference legend

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
