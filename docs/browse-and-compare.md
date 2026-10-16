# Browse and compare content

[Documentation index](README.md) · [Project overview](../README.md)

## Browse one connection

Click a connection in **Connections**, or choose **Browse Connection**, to open one full-width content tree with a connection and language selector. ID/path/name search uses only that connection. Sites and favorites on the browsed connection reveal their items; lazy loading, refresh, cancellation, icons and keyboard navigation remain available. Comparison controls are hidden. Selecting an item opens the bottom **Item Details** pane with one read-only set of fields and its connection, ID, path, template, language and latest version. Content, Standard Template and system fields have separate All/Hidden controls; Browse preferences are saved separately from Compare filters. Shared/unversioned and value-source markers are retained. The context menu offers **Show Item Details**, **Copy item ID**, **Copy item path**, **Publish** and **Run task…** for matching plug-ins. Eligible items show Open public page in their details. See [publishing](publishing.md), [operations](operations.md), and [item task plug-ins](plugins.md) for their configuration and execution flows. Use the existing explicit Compare commands for two trees, including independent languages on the same connection.

## Switch to Compare and back

Use the **Browse / Compare** buttons at the top to switch modes; the active mode is highlighted. Compare keeps the browsed connection on the left and restores its last partner and partner language, saved per connection in this workspace. On first use or after deleting a partner, choose a connection (including the same connection). Unavailable languages require a new choice. If a remembered lock conflicts with the two languages, explicitly unlock or cancel; cancelling keeps the current tree intact. The right connection and language selectors remain changeable.

Returning to Browse always keeps the **left side**, including its language, root and selected item; loaded branches and scroll are restored within the open panel where available. Navigation snapshots stay in memory, while partner/language preferences survive reloads. Refresh remains in context menus. **Cancel loading** appears only during cancellable tree/language loads in either mode; search keeps its existing Cancel control.

If a comparison endpoint disappears from the connection store, the panel returns to Browse on the left. If that source is missing too, choose a connection explicitly; another environment is never substituted automatically. Endpoint changes clear cached content and navigation snapshots before reloading. Normal UI deletion remains blocked while a connection is in use.

Run **XM Cloud Sync: Open Comparison** from the Command Palette or use the diff icon in the XM Cloud Sync activity view. The comparison opens as a document-style tab with left and right connection and language selectors plus swap and **Lock Languages** controls. Choices are remembered per workspace.

One XM Cloud connection is sufficient. Select the same connection on both sides to compare languages such as `en` and `de`, or select different connections to compare environments. **Compare with…** also offers the selected connection itself for cross-language comparison.

Choose languages with the selectors. See [language switching, locking and fallback](languages-and-fallback.md) for behavior and limits.

## Sites and favorites

Clicking a configured site beneath a connection reveals its root item using the same navigation behavior as favorites. First open the connection in Browse, or select it on either side of an open Compare view. Clicking a site preserves the current connection selections. Loaded rows are reused, missing ancestor levels are loaded as needed, and newer site or favorite clicks supersede earlier navigation. The site globe changes to spinning arrows while its root is loading and returns on completion, failure, cancellation, or superseding navigation. Site and favorite indicators remain separate even when they point to the same path. An unavailable site root reports an error without offering to remove a favorite.

Right-click an item in Browse or Compare and choose **Add to Favorites** to save its Sitecore path beneath the browsed connection or one or both comparison connections. Favorites are marked with `☆` in the Connections view and can be removed from their context action. Clicking a favorite navigates only when its connection is already open in Browse or selected on either Compare side; it never changes a connection selection implicitly. A newer favorite click supersedes navigation still in progress and clears the previous tree highlight while the requested path is resolved. Right-click a favorite and choose **Compare with…** to place its connection on the left, choose the right connection explicitly, and then reveal the saved item. Already-loaded rows are revealed without an API request; otherwise the extension resolves the path with Authoring GraphQL and loads the ancestor chain needed to display it. The favorite shows the same spinning arrows used during connection testing while navigation is loading. The indicator clears on completion, failure, cancellation, or a superseding site or favorite navigation. Overlapping ancestor loads preserve already-loaded descendants by item ID, keeping favorite navigation stable while other branches expand. If the saved path is unavailable, the error prompt offers to remove the stale favorite.

## Find an item by ID or path

The lookup accepts trimmed GUIDs (compact, dashed, or braced) and absolute Sitecore paths. In Browse, Enter searches its single connection. In Compare, Enter searches the entire left connection first and uses the right only when the item is absent; connection failures are reported. The input badge updates locally while typing: Go to ID, Go to path, or Search. Other nonempty text performs indexed name search. Lookup preserves connection/language selections and unrelated expansion, loading only ancestor levels needed to reveal the paired row. The default root is `/`; a result outside a narrower displayed root widens that scope to `/` with an inline explanation. Cancel or a newer lookup supersedes pending navigation.

## Search by name

Enter other text in the same lookup input to search item names containing that text, using the selected language. Scope is visibly **Entire connection**, independent of the displayed tree root. Results list the name, full path and connection. Browse queries its single connection. In Compare, left is queried first; only an empty left result set triggers right-side lookup. Selecting a result uses exact navigation on the result's connection. Arrow keys move between results, Enter selects, Escape cancels, and Tab reaches results and Load more. New input, connection/language changes and explicit site/favorite navigation supersede older searches.

Search uses the documented Authoring `search` query on `sitecore_master_index` (`_name` CONTAINS and selected `_language`), with 50 index records per page and at most ten pages. Item IDs are deduplicated across versions. Index freshness and API/index permissions affect results; unsupported or failed queries show an error without scanning the tree or silently falling back to the other connection. See [Sitecore's Authoring search examples](https://doc.sitecore.com/xp/en/developers/103/sitecore-experience-manager/query-examples-for-authoring-operations.html). Refine the query if the 500-record limit is reached.

## Inspect item details

In Compare, right-click an item and choose **Show Detailed Field Diff** to open **Field Diff** in VS Code's bottom **Item Details** container. The panel follows item selection only while it is visible and stops synchronizing when closed. It displays the complete paired field table with item, connection, language, template, path, and latest-version context. The displayed path and item ID are native keyboard-accessible copy buttons in Browse and on each Compare side. Click or activate either button with the keyboard to copy its full value through the extension-host clipboard; success or failure appears inline. Fields are paired by normalized field ID. Shared fields carry an `S` marker, unversioned fields carry `U`, and the common versioned fields are unmarked. The sticky visibility toolbar classifies every row once: names beginning with `__` are system fields, remaining Standard Template fields form the second category, and all remaining rows are content fields. Content fields can show all rows or differences; Standard Template and system fields can be hidden, limited to differences, or shown in full. In Compare, the default profile shows content and Standard Template differences while hiding system fields. One profile is retained across item selections and webview restoration rather than stored per item. Populated local overrides are marked on field rows, and textual fields can open VS Code's native text diff.

Browse empty-field feedback distinguishes fields hidden by filters from an empty Authoring response. Empty responses show the selected language/version and available versions, distinguishing exact reads from fallback requests that returned no values. Show all fields restores all three Browse visibility categories. The shared bottom-panel container is named Item Details, with the paired Field Diff view retained in Compare.

The displayed path and ID can be copied directly; the tree also provides **Copy item ID** and **Copy item path**. See [public-page URLs](connections.md#public-page-urls) for browser links, [the item editor](item-editor.md) for editing and read-only previews, and [field transfers](transfers.md#transfer-a-field-value) for copying values between sides.

## Tree loading and matching

Browse loads the authoring root and its immediate children for one connection; Compare does so on both sides. Expanding an item loads its latest numbered version, complete field set, template metadata, and direct children using paginated Authoring GraphQL requests. Loaded details are cached for the lifetime of the extension, while clicking an item only selects it and never causes a refresh. Expanded rows contain child items only, keeping the structural tree compact.

Loaded items are displayed in one paired-row tree so the left and right sides share selection, expansion, and scrolling. Items are matched by normalized Sitecore item ID. The comparison marks left-only and right-only items, same-path items with different IDs, and differences in path, name, or child presence. The left hierarchy supplies the primary row order; right-only items are inserted near their closest loaded right-side neighbour.

Tree rows show the item display name with the item's configured Sitecore theme icon when the selected connection's authenticated icon handler returns a supported raster image. An icon set directly or through Standard Values takes precedence; otherwise, the extension uses the icon configured on the item's data-template definition. Icons load asynchronously and progressively after the tree level, so completed icons appear without waiting for slower icons in the same level, and are cached; an unobtrusive fallback remains when the icon is absent, unsafe, unsupported, or temporarily unavailable. The tooltip contains the full path, item ID, and field-comparison lifecycle state: not loaded, loading, equal, different, or failed. Equal, unchecked, and background field-loading states remain visually unmarked. When the display name differs from the underlying item name, the display name is blue and the tooltip also includes the item name. A single red `⚠` marker identifies field-detail or child-loading failures; its tooltip lists the affected side, failure category, and error message.

## Refresh and expand content

Right-click a row and choose **Refresh Item** to re-read only its template, latest version, and fields without replacing its loaded child tree. Choose **Refresh Subtree** to invalidate and re-read that item plus every descendant level already present in the lazy snapshot. Subtree refresh proceeds from parent levels to child levels so the visible hierarchy remains coherent. The affected rows are temporarily locked; a refresh in a completely disjoint subtree can run at the same time. Unloaded descendants remain lazy and are not fetched solely because of a subtree refresh. If the visible **Field Diff** panel is showing an item covered by either command, it refreshes immediately from the new field snapshot.

In Compare, use **XM Cloud Sync: Refresh All** to greedily re-read every item and field beneath the configured root on both sides. Because this can be expensive for large trees, VS Code asks for confirmation first and shows cancellable progress. The complete comparison is locked during the operation, while independent left and right traversal remains concurrent.

For large Sitecore trees, right-click a paired item and choose **Expand All…**. The ellipsis indicates that a native VS Code warning asks for confirmation before any requests begin. After confirmation, only descendants of that item are fetched and progressively expanded. The selected subtree is locked while it loads, but unrelated parts of the comparison remain usable. Left-only and right-only rows load only their existing side. Disjoint subtree operations may run concurrently; overlapping operations are disabled. Use the cancellable VS Code notification or right-click the operation root and choose **Cancel Expand All** to stop it.

The tree context menu shows **Expand Item** or **Collapse Item** according to the selected row's current state, followed by **Expand Loaded Items** and **Expand All…**. A separator groups **Refresh Item** and **Refresh Subtree**. **Expand Loaded Items** recursively expands complete cached levels beneath the selected item without issuing Authoring API requests and does not change expansion elsewhere in the comparison. Partially loaded branches remain lazy.

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

## Text comparison settings

`xmCloudSync.textNormalization` defaults to `none`, comparing text exactly as returned. Set it to `lineEndings` to treat CRLF, CR and LF as equivalent logical line endings. This never changes synchronized values.
