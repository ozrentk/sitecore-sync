# Repository Working Instructions

This file is the working agreement for coding agents and contributors in this repository. Follow it for every task unless the user explicitly gives a conflicting instruction. More deeply nested `AGENTS.md` files, if added later, may refine these rules for their directory only.

## Project overview

XM Cloud Sync is a TypeScript VS Code extension for comparing and synchronizing Sitecore XM Cloud content. It runs in the VS Code extension host and is packaged as a VSIX.

- Extension manifest and commands: `package.json`
- Extension entry point: `src/extension.ts`
- TypeScript source: `src/`
- Compiled and bundled output: `out/`
- Packaging output: `dist/`
- Build and packaging helpers: `scripts/`
- User documentation: `README.md`
- Release history: `CHANGELOG.md`
- Product requirements: `PRODUCT_SPEC.md`
- Example item task plug-ins: `examples/`

Treat `out/`, `dist/`, `node_modules/`, VSIX files, logs, and TypeScript build metadata as generated artifacts. Do not hand-edit or commit them unless the repository intentionally starts tracking a specific artifact.

## Source of truth and scope

Before changing code:

1. Read the relevant source, `package.json` contributions, `PRODUCT_SPEC.md`, and nearby documentation.
2. Check `git status --short --branch` and preserve unrelated user changes.
3. Use the Git Flow process below before editing.
4. Keep the change as small as practical and do not refactor unrelated code.

Do not assume the compiled bundle describes intended behavior; TypeScript source and project documentation are authoritative. Keep command IDs, view IDs, context keys, settings, activation events, and menu conditions synchronized between `package.json` and the implementation.

## Development commands

Use the checked-in lockfile and install dependencies with `npm ci` when a clean install is required.

- `npm run check` — strict TypeScript validation without emitting files.
- `npm run check:extension` — type-check only the extension source.
- `npm run check:tests` — type-check the unit and extension-host test sources.
- `npm test` or `npm run test:unit` — type-check and run the TypeScript unit-test suite.
- `npm run test:integration` — compile the extension and run smoke tests in VS Code 1.100.0.
- `npm run test:all` — run both unit and extension-host suites.
- `npm run compile` — run the type check and build `out/extension.js` with the project build script.
- `npm run watch` — continuously compile TypeScript during development.
- `npm run clean` — remove generated build output through the project script.
- `npm run package` — prepare and create `dist/sitecore-xm-cloud-sync.vsix` using `vsce`.

Prefer repository scripts over ad hoc compiler, bundler, or packaging commands. Do not change dependencies or `package-lock.json` unless the task requires it.

## VS Code extension practices

### Extension lifecycle

- Register commands, providers, listeners, watchers, output channels, and other disposables through the extension context or dispose of them explicitly.
- Keep activation lightweight. Defer network calls and expensive work until the corresponding command or view needs them.
- Avoid module-level mutable state when state can be owned by a service and reset or disposed predictably.
- Preserve data across reloads only through the appropriate VS Code storage API. Use `SecretStorage` for credentials and tokens; never put secrets in settings, logs, source control, fixtures, or error messages.
- Respect cancellation tokens and VS Code progress APIs for operations that can take noticeable time.
- Handle deactivation, window reloads, partially initialized services, and repeated command invocation safely.

### Commands, views, settings, and context keys

- Declare user-facing commands and contributed UI in `package.json` and register their handlers in code.
- Use the existing `xmCloudSync.*` namespace for command IDs, settings, view IDs, and context keys.
- Keep titles, enablement clauses, menu visibility, and view item context values consistent with runtime behavior.
- Add configuration schemas with safe defaults, precise descriptions, and backwards-compatible behavior.
- When a contribution changes, verify it manually in an Extension Development Host; type checking alone cannot validate manifest wiring.

### Webviews and tree views

- Treat all remote content, workspace files, persisted data, and webview messages as untrusted input.
- Escape dynamic HTML, validate every message payload, use a restrictive Content Security Policy, and use nonces for scripts.
- Do not enable arbitrary command URIs or load remote resources unless the feature explicitly requires and constrains them.
- Use `asWebviewUri` for local webview resources and keep resource roots minimal.
- Preserve VS Code theme support, keyboard access, focus behavior, and readable empty/loading/error states.
- Refresh only the affected tree nodes where practical and use stable item IDs when preserving selection or expansion matters.

### Networking and Sitecore operations

- Use the existing client and service abstractions under `src/sitecore/`; do not duplicate authentication or request logic in UI code.
- Validate URLs and externally supplied identifiers before use.
- Apply timeouts and cancellation where supported. Report actionable errors without exposing tokens, headers, or sensitive response content.
- Avoid automatic retries for non-idempotent mutations. For safe retries, use bounded attempts and make retry state visible to callers.
- Keep destructive or content-changing operations explicit to the user and preserve the queue, journal, and operation-state guarantees already established by the extension.
- Do not require a live XM Cloud environment for unit tests.

### Workspace trust and item task plug-ins

- This extension has limited untrusted-workspace support. Preserve the rule that workspace JavaScript or PowerShell item task plug-ins do not execute in untrusted workspaces.
- Never weaken trust checks, shell argument handling, path validation, or process isolation as a convenience.
- Treat plug-in output as untrusted and avoid leaking secrets into child-process arguments or logs.
- Keep behavior portable across supported VS Code platforms; do not introduce Windows-only assumptions unless the feature is explicitly platform-specific and documented.

## TypeScript and code quality

- Preserve the strict compiler guarantees in `tsconfig.json`, including unused-code, implicit-return, switch-fallthrough, and casing checks.
- Prefer explicit domain types and narrow unknown external data before use. Avoid `any`; when unavoidable at an external boundary, isolate and explain it.
- Separate VS Code UI concerns, persistence, network clients, and domain logic so behavior can be tested without the extension host.
- Favor small functions and dependency injection over hidden global dependencies.
- Keep asynchronous flows awaited and observable. Handle rejected promises at their ownership boundary.
- Use clear user-facing error messages and richer diagnostic logging, while redacting sensitive data from both.
- Match the surrounding naming, formatting, and module style. Do not add a formatter or lint tool as part of an unrelated change.
- Comments should explain constraints or intent, not restate the code.

## Tests and test suite

### Current state

The repository has a TypeScript unit-test suite under `test/unit/`. It uses Node's built-in test runner, Node's strict assertion API, and `tsx`, and runs through `npm test`. Current coverage includes XM Cloud server URL normalization, persisted operation and transfer domain validation, field-state fingerprints, operation-intent preparation and sequence-runner transitions, Sitecore reference discovery, collapsed Power Publish scope graph planning, Sitecore HTTP transport behavior, and Authoring and publishing response parsing and validation. The extension-host suite under `test/integration/` uses `@vscode/test-electron` and covers activation, contributed-command registration, configuration defaults, `ConnectionStore` metadata and secret persistence, `TransferQueueStore` persistence and recovery, `TransferProcessor` FIFO and transfer execution, and `OperationSequenceStore` validation, editing, locking, ordering, recovery, and retention behavior through `npm run test:integration`.

Run `npm test` for unit-test changes and `npm run test:integration` for extension activation, manifest wiring, or configuration changes. Continue to perform focused manual Extension Development Host checks for UI behavior that the smoke suite does not exercise. Record exactly what was and was not exercised.

### Expectations for changed behavior

- Every defect fix should include a regression test when the affected logic can be tested without disproportionate setup.
- New domain logic should have unit tests covering the normal path, boundary values, invalid external data, cancellation, and expected failures.
- Persistence and queue/state-machine changes should test reload/recovery, ordering, retries, partial failure, and backwards compatibility of stored data.
- Network client tests should mock transport at the boundary and cover request construction, response validation, authentication failures, timeouts, cancellation, and redaction. Never call live Sitecore services in the default suite.
- Commands, views, configuration, activation, and VS Code API integration should use extension-host integration tests where unit tests cannot provide meaningful confidence.
- Webview behavior should test message validation and pure rendering/state transformations separately from the browser surface; use focused integration or UI tests only for behavior that requires it.
- Keep tests deterministic, isolated, and safe to run in parallel. Do not rely on execution order, developer credentials, global machine state, or external services.
- Use temporary directories and disposable fixtures. Tests must not modify a developer's real VS Code profile, workspace content, Sitecore environment, or persisted extension data.

### Extending the test infrastructure

When adding application tests or additional test layers:

1. Continue using Node's built-in test runner for isolated domain code and prefer `@vscode/test-electron` for extension-host integration tests.
2. Add explicit scripts such as `test:unit` and `test:integration` to `package.json` when separate test layers exist.
3. Keep unit tests under `test/unit/` and extension-host tests under `test/integration/`.
4. Ensure test compilation does not leak test code into the shipped extension bundle or VSIX.
5. Document local prerequisites and commands in `README.md`.
6. Add the suite to CI if CI exists or is introduced by the task.

Do not add another framework speculatively during an unrelated change. If meaningful testing is blocked by missing infrastructure, explain the gap and propose the smallest follow-up.

### Verification matrix

Run checks proportional to the change:

| Change | Minimum verification |
| --- | --- |
| Documentation or agent instructions only | Review the diff; validate referenced scripts and paths |
| TypeScript implementation | Relevant tests when present, then `npm run check` |
| Extension activation, commands, views, menus, settings, or webviews | Type check plus focused Extension Development Host smoke test |
| Build configuration, dependencies, or bundled runtime behavior | `npm run compile` plus relevant tests |
| Installable extension or release work | Relevant tests, `npm run check`, `npm run package`, and install/smoke-test the VSIX when practical |

If a required check cannot run, report why and do not silently replace it with a weaker check.

## Documentation and release discipline

- Update `README.md` for user-visible behavior, configuration, setup, workflows, or development commands.
- Update `PRODUCT_SPEC.md` when product behavior or requirements change.
- Update `CHANGELOG.md` and the extension version only when producing an installable update or release, unless the user requests otherwise.
- Keep `package.json` and `package-lock.json` versions aligned when bumping the extension version.
- Follow semantic versioning: patch for backwards-compatible fixes, minor for backwards-compatible features, and major for breaking changes.
- Check the packaged file list and never ship credentials, local state, fixtures containing secrets, source-only tooling, or unintended large files.
- Do not publish to the VS Code Marketplace, push branches/tags, or create a remote release unless the user explicitly asks.

## Git Flow is required

Use Git Flow for every repository-changing task unless the user explicitly requests a different workflow.

### Protected long-lived branches

- `main` contains released production versions only.
- `develop` is the integration branch for completed development work.
- Do not commit directly to `main` or `develop`.

### Starting work

Before editing files:

1. Check the current branch and working-tree status.
2. Preserve unrelated user changes. Do not discard, overwrite, or include them in a commit.
3. Select the correct base and branch type:
   - `feature/<short-kebab-name>` from `develop` for new capabilities and non-urgent improvements.
   - `bugfix/<short-kebab-name>` from `develop` for ordinary defect fixes.
   - `release/<version>` from `develop` for release preparation.
   - `hotfix/<version-or-short-name>` from `main` only for urgent fixes to a released version.
4. Create or switch to that task branch before making changes.

The Git Flow CLI might not be installed. Standard `git switch`, `git branch`, and `git merge` commands are acceptable equivalents.

### Completing feature and bugfix work

1. Run checks appropriate to the change. At minimum for TypeScript changes, run `npm run check`.
2. Package with `npm run package` when the change affects the installable extension.
3. Update documentation, `CHANGELOG.md`, and the extension version when producing an installable update.
4. Commit only files belonging to the task, using a concise conventional commit message.
5. Merge the task branch into `develop` with a non-fast-forward merge.
6. Do not delete the task branch unless the user asks; retaining it makes the local history easier to inspect.
7. Do not push branches or tags to a remote unless the user asks.

### Releases

For `release/<version>`:

1. Perform release-only changes on the release branch.
2. Verify type checking and VSIX packaging.
3. Merge the release branch into `main` with a non-fast-forward merge.
4. Tag `main` with `v<version>`.
5. Merge the release branch back into `develop`.
6. Do not push the branches or tag unless the user asks.

### Hotfixes

For `hotfix/<version-or-short-name>`:

1. Branch from `main`.
2. Apply and verify only the urgent released-version fix.
3. Merge into `main` and tag it when it produces a new release.
4. Merge the same hotfix into `develop`.
5. Do not push the branches or tag unless the user asks.

### Reporting

At handoff, report:

- The task branch used.
- Verification performed.
- Commit and merge commit identifiers, when created.
- The branch currently checked out.
- Any uncommitted or unmerged work that remains.

## Commit and review checklist

Before committing:

1. Inspect `git diff --check`, `git diff`, and `git status --short`.
2. Confirm only task files are staged; never stage unrelated user changes with `git add -A` or `git add .`.
3. Run the verification required by the matrix above.
4. Check that no credentials, tokens, personal URLs, local state, or generated artifacts were added.
5. Use a concise Conventional Commit message such as `docs: expand repository agent guidance`.

In the handoff, distinguish automated checks, manual checks, and checks not run. Mention risks or follow-up work plainly.
