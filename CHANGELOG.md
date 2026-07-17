# Changelog

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
