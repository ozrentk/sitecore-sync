# Changelog

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
