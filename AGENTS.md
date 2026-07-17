# Repository Working Instructions

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
