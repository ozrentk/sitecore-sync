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

Run **XM Cloud Sync: Open Comparison** from the Command Palette or use the diff icon in the XM Cloud Sync activity view. The comparison opens as a document-style tab with independent left and right connection selectors and a swap button. Choices are remembered per workspace.

You need at least two XM Cloud connections to compare content. You can also right-click a connection and choose **Compare with…**; the selected connection becomes the left side and a Quick Pick selects the right side.

The comparison tab loads the authoring root and its immediate children on both sides. Expanding an item loads its complete set of direct children using paginated Authoring GraphQL requests. Loaded levels are cached for the lifetime of the extension, while clicking an item only selects it and never causes a refresh. Field-level diff is the next comparison milestone.

Loaded items are displayed in one paired-row tree so the left and right sides share selection, expansion, and scrolling. Items are matched by normalized Sitecore item ID. The comparison marks left-only and right-only items, same-path items with different IDs, and differences in path, name, or child presence. The left hierarchy supplies the primary row order; right-only items are inserted near their closest loaded right-side neighbour.

Tree rows show only the item display name so deeply nested content remains readable. The tooltip contains the full path and item ID. When the display name differs from the underlying item name, the display name is blue and the tooltip also includes the item name.

Right-click a paired row and choose **Refresh Subtree** to invalidate and re-read that item plus every descendant level already present in the lazy snapshot. Refresh proceeds from parent levels to child levels so the visible hierarchy remains coherent. The affected rows are temporarily locked; a refresh in a completely disjoint subtree can run at the same time. Unloaded descendants remain lazy and are not fetched solely because of a refresh.

For large Sitecore trees, right-click a paired item and choose **Expand All…**. The ellipsis indicates that a native VS Code warning asks for confirmation before any requests begin. After confirmation, only descendants of that item are fetched and progressively expanded. The selected subtree is locked while it loads, but unrelated parts of the comparison remain usable. Left-only and right-only rows load only their existing side. Disjoint subtree operations may run concurrently; overlapping operations are disabled. Use the cancellable VS Code notification or right-click the operation root and choose **Cancel Expand All** to stop it.

The paired-row context menu shows **Expand Item** or **Collapse Item** according to the selected row's current state, followed by **Expand Loaded Items** and **Expand All…**. A separator places **Refresh Subtree** in its own group. **Expand Loaded Items** recursively expands complete cached levels beneath the selected item without issuing Authoring API requests and does not change expansion elsewhere in the comparison. Partially loaded branches remain lazy.

### Difference legend

| Badge | Meaning |
| --- | --- |
| `L` | The item ID exists only on the left side within the currently loaded comparison data. |
| `R` | The item ID exists only on the right side within the currently loaded comparison data. |
| `LR` | Both left-only and right-only identity states apply. The two symbols are rendered as one group while retaining separate tooltips. |
| `ID` | Items have the same path but different item IDs. This badge replaces the otherwise redundant `LR` group for that row. |
| `P` | The same item ID has different paths on the left and right sides. |
| `N` | The same item ID has a different item name or display name. |
| `T` | The two items disagree about whether they have child items. |

Identity symbols (`L`, `R`, or `ID`) form one blue group. Structural symbols (`P`, `N`, and `T`) form one orange group without spacing between their equal-width characters. Each symbol retains its own tooltip. Multiple groups can appear on the same row when several differences coexist. A row without a badge is structurally equal based on the metadata currently loaded by the comparison. Field values, templates, languages, and versions are not yet included in this structural legend and will receive additional comparison states as those features are implemented.

Connection secrets, access tokens, and Authoring API requests remain in the extension host and are never exposed to the webview.

All Sitecore OAuth and Authoring GraphQL traffic passes through a shared request client. A transient network failure or HTTP 408, 429, 500, 502, 503, or 504 response is retried up to three times after the initial attempt. Retries use exponential backoff starting near 500 ms with jitter. When Sitecore supplies `Retry-After` as seconds or an HTTP date, that delay takes precedence and also pauses other requests to the same endpoint origin. Retry waits can be cancelled. Permanent client and authorization responses, GraphQL errors, and missing items are returned immediately instead of being retried.

Run **XM Cloud Sync: Show Logs** to open the extension's diagnostic log. It records comparison loading, caching, errors, retry attempts, and cooldown waits without recording client secrets, access tokens, request bodies, or query parameters.

The comparison webview is separated into `media/comparison/comparison.html`, `comparison.css`, and `comparison.js`. Extension-host lifecycle and state messaging remain in `src/comparison/comparisonPanel.ts`.

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
