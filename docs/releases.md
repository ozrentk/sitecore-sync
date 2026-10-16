# Install, update and release

[Documentation index](README.md) · [Project overview](../README.md)

## Install or update

Download the VSIX from [GitHub Releases](https://github.com/ozrentk/sitecore-sync/releases/latest), then run **Extensions: Install from VSIX…** in VS Code. Install newer release files manually to update. No Marketplace account or publishing is involved.

Download the newer VSIX and repeat **Extensions: Install from VSIX…**, then reload VS Code when prompted. Installing an update does not require editing a package manifest or building the source. Marketplace auto-updates are not used.

For a locally built package, run `code --install-extension ./dist/sitecore-xm-cloud-sync.vsix` from the repository root. See [building from source](../CONTRIBUTING.md#build-a-vsix).

## Publish a release

To publish a version, prepare `release/<version>` from `develop`, align `package.json` and `package-lock.json`, and update `CHANGELOG.md`. Merge into `main` with a non-fast-forward merge, tag that commit `v<version>`, and merge the release branch back into `develop`. Push `main` and `develop` before pushing the tag. The tag must match the package version and its commit must belong to `main`.

A `vMAJOR.MINOR.PATCH` tag push runs the same validation and packaging as CI, including secret scans. Only after all checks pass does a separate job with `contents: write` publish a GitHub Release and attach the tested VSIX. Branch, pull-request, and manually dispatched CI runs only produce temporary artifacts. Existing releases are not overwritten; rerunning a published tag fails at release creation. Fix a failed validation before publishing a new version; do not move published tags.

The workflow uses its built-in GitHub token, so no personal access token or Marketplace credential is required. For a local scan on Windows, run `./scripts/scan-secrets.ps1 -Mode History` and, after packaging, `./scripts/scan-secrets.ps1 -Mode Package`. These scans use redacted output and cannot guarantee detection of every secret format.

The local Git Flow release is not online until its branches and tag are pushed. When publication is authorized, push `main` and `develop`, then the specific version tag. Verify the GitHub Actions tag run, the published release and its attached VSIX. Do not describe a local package or branch-only CI artifact as a published release.

## Known verification exception for v0.45.0

For the `v0.45.0` tag only, CI explicitly accepts B31's exact General Link destination-focus assertion failure. The test still runs; an accepted failure produces a warning and job-summary entry, and its remaining steps are not exercised. All other failures remain blocking. Ordinary branch tests have no exception. Local reproduction can opt in with `XM_CLOUD_SYNC_B31_EXCEPTION=0.45.0`; the harness also requires extension version 0.45.0. Remove this temporary exception when B31 is fixed. The GitHub release notes disclose the coverage gap.

The underlying [B31 issue](troubleshooting.md#general-link-properties-b31) remains tracked in [BACKLOG.md](../BACKLOG.md). Release-specific exceptions must stay visible rather than turning the entire test suite non-blocking.

## Release history

See [CHANGELOG.md](../CHANGELOG.md).
