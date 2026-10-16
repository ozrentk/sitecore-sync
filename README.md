# XM Cloud Sync

XM Cloud Sync is an early-stage VS Code extension for browsing, comparing and synchronizing Sitecore XM Cloud authoring content. Connect to an environment, inspect or edit supported item fields, compare environments or languages, and queue transfers and publishing with delivery evidence.

## Requirements and installation

Use VS Code **1.100.0 or newer** and an XM Cloud environment with a CM URL and environment automation-client credentials. [Prerequisites](docs/connections.md#prerequisites) explain connection setup.

Download the VSIX from [GitHub Releases](https://github.com/ozrentk/sitecore-sync/releases/latest), then use **Extensions: Install from VSIX…** in VS Code. See [installation and updates](docs/releases.md#install-or-update) for details.

## Quick Start

Before starting, [install the extension and have your CM URL and automation-client credentials ready](docs/connections.md#prerequisites).

1. Open the **XM Cloud Sync** activity view.
2. In **Connections**, select **Add Connection**. Enter **Name**, **CM server URL**, **Client ID**, and **Client secret**.
3. Select **Test connection**, then **Add connection** after a successful test.
4. Click the saved connection to open **Browse**. Expand it in **Connections**, select a site, and choose a language in the tree toolbar.
5. Select an item to inspect **Item Details**.
6. **Optional:** select **Compare** and choose another connection, or the same connection with a different language.

## Choose a workflow

| I want to… | Guide |
| --- | --- |
| Configure connections, sites or public-page URLs | [Connections](docs/connections.md) |
| Browse, search, use favorites or compare items | [Browse and Compare](docs/browse-and-compare.md) |
| Edit supported fields and save changes | [Item editor](docs/item-editor.md) |
| Edit Rich Text HTML, headings, lists, quotes, tables, links and supported formatting | [Rich Text editing](docs/item-editor.md#rich-text-html-source) |
| Transfer a field or subtree | [Transfers](docs/transfers.md) |
| Publish and trace content delivery | [Publishing](docs/publishing.md) |
| Manage queued work and operation sequences | [Operations](docs/operations.md) |
| Understand language selection and fallback | [Languages and fallback](docs/languages-and-fallback.md) |
| Run a task plug-in or connect an agent | [Plug-ins](docs/plugins.md) · [MCP](docs/mcp.md) |

## Help and project information

Use [Troubleshooting and support](docs/troubleshooting.md) for diagnostic steps and known limitations, or browse the [documentation index](docs/README.md).

[Contributing and development](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Product specification](PRODUCT_SPEC.md) · [Backlog](BACKLOG.md) · [Research](docs/research/README.md) · [MIT license](LICENSE)
