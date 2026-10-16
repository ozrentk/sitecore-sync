# Contributing to XM Cloud Sync

[Project overview](README.md) · [Documentation index](docs/README.md)

## Development environment

Use Node.js 24 (the CI version), npm and VS Code 1.100.0 or newer. Start with `npm ci`. Integration tests need a desktop environment and download their pinned VS Code build on first use; live Sitecore credentials are not required.

## Debug the extension

1. Run `npm ci` to install the checked-in dependency graph.
2. Open this folder in VS Code.
3. Press `F5` and choose **Sitecore XM Cloud Sync Extension** if prompted.
4. A separate Extension Development Host window opens with the development extension loaded.
5. After changing TypeScript, run `npm run compile`, then execute **Developer: Reload Window** in the Extension Development Host.

Set breakpoints in `src/extension.ts`; VS Code uses the generated source maps when debugging.

For continuous compilation, run `npm run watch` in a terminal. You still reload the Extension Development Host after compiled code changes.

## Test and validate

```powershell
npm test
```

The unit-test harness uses Node's built-in test runner with `tsx` for TypeScript execution. Tests live under `test/unit/`. Current coverage exercises XM Cloud server URL normalization, persisted operation, transfer, and publishing-run validation, item-task manifest parsing, matching, path containment, and input validation, publishing form validation and webview asset contracts, publishing retry and status-recheck transitions, publishing snapshot expectations, version observability, and trace conclusion classification, Raw Experience Edge, rendered-layout, application-response, and Browser DOM observation and result evaluation, Power Publish dependency and repair-batch planning, field-state fingerprints, operation-intent preparation and sequence-runner transitions, Sitecore reference discovery, collapsed Power Publish scope graph planning, Sitecore HTTP transport behavior, and Authoring, Publishing, and Experience Edge client response parsing and validation.

Run `npm run check` to type-check both the extension source and the test suite.

Run the extension-host suite separately:

```powershell
npm run test:integration
```

The first integration run downloads VS Code 1.100.0 into `.vscode-test/`, then launches an isolated Extension Development Host against an empty temporary workspace. It verifies activation, contributed-command registration, the default extension configuration, connection and credential persistence, queue and operation-sequence persistence, item-task discovery and isolated JavaScript worker execution, publishing configuration webview messaging and lifecycle, PublishingManager batch execution, restart recovery, diagnostic handoff, failure persistence, and queue recovery, and transfer-processor lifecycle, field-transfer, subtree-checkpoint, and deployment-monitoring behavior without contacting Sitecore. Run `npm run test:all` to execute both unit and extension-host suites.

GitHub Actions runs the complete validation cycle on Windows Server 2025 with Node.js 24 for pull requests and pushes targeting `develop` or `main`. The workflow can also be started manually. It installs the checked-in dependency graph with `npm ci`, type-checks the extension and tests, runs both test suites, and builds the VSIX. Branch/PR/manual runs do not publish; version-tag runs follow [the release procedure](docs/releases.md#publish-a-release). Successful runs expose `sitecore-xm-cloud-sync.vsix` as a downloadable workflow artifact for 14 days. CI also scans Git history and the packaged extension for secrets with a checksum-verified Gitleaks binary; a finding fails the run.

For isolated integration checks against another installed VS Code build, set `XM_CLOUD_SYNC_TEST_VSCODE_EXECUTABLE` to its executable before running `npm run test:integration`; otherwise the suite uses VS Code 1.100.0.

Run build/package and extension-host suites sequentially: packaging cleans generated output that active tests may still use. UI changes also need focused manual Extension Development Host checks; automated tests do not replace them.

## Build a VSIX

```powershell
npm run package
```

This creates:

```text
dist/sitecore-xm-cloud-sync.vsix
```

Installation and updates are described in [releases](docs/releases.md#install-or-update). A development package is not a published release.

## Source layout

The comparison webview is separated into `media/comparison/comparison.html`, `comparison.css`, and `comparison.js`. The bottom-panel field view lives in `media/fieldDiff`, with its provider in `src/comparison/fieldDiffView.ts`. Extension-host lifecycle and state messaging remain in `src/comparison/comparisonPanel.ts`.

The manifest is `package.json`, extension entry point is `src/extension.ts`, authenticated clients are under `src/sitecore/`, unit tests under `test/unit/`, and extension-host tests under `test/integration/`. Generated `out/`, `dist/`, `.test-out/`, `.vscode-test/` and dependency directories are not source changes.

## Git Flow and contributions

Follow [AGENTS.md](AGENTS.md) for the full working agreement. Start feature and ordinary bugfix branches from `develop`; use `feature/<short-name>` or `bugfix/<short-name>`. Preserve unrelated work, run the checks appropriate to the change, commit only task files, and merge into `develop` with a non-fast-forward merge. Do not commit directly to `main` or `develop`. Retain task branches unless asked to remove them; pushing or publishing requires explicit authorization.

Use `release/<version>` from `develop` for releases and `hotfix/<version-or-name>` from `main` for urgent released-version fixes. See [maintainer release steps](docs/releases.md#publish-a-release) for merges, tags and publishing.

Documentation-only changes require diff, path and link review; they do not need a gratuitous version bump. Runtime changes require relevant tests and `npm run check`; activation/manifest/webview changes also need focused host verification. Keep credentials and local state out of source, fixtures and packages.

## Research and product planning

Experimental tools and historical evidence live in [research](docs/research/README.md). [PRODUCT_SPEC.md](PRODUCT_SPEC.md) records requirements, [BACKLOG.md](BACKLOG.md) tracks outstanding work, and [CHANGELOG.md](CHANGELOG.md) records released changes.
