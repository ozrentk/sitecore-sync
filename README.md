# XM Cloud Sync

XM Cloud Sync is an early-stage VS Code extension for comparing and synchronizing Sitecore XM Cloud authoring content.

The current build supports multiple saved XM Cloud connections, automation-client authentication, and authenticated connection testing. It also contributes placeholder Left Content Tree, Right Content Tree, and Sync Operations views for the next milestones.

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

The current comparison tab is the UI shell for the upcoming authoring content trees and field-level diff. Connection secrets remain in the extension host and are never exposed to the webview.

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
