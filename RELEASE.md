# Release Process

All publishing happens from GitHub Actions — no local login needed.

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow:

1. Runs `vsce publish patch --no-git-tag-version` — vsce bumps the patch
   version in `package.json` locally and publishes the VSIX to the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp).
   A failed publish is retried up to 3 times. PR pre-releases live on the
   separate `0.9.x` line, so this stable patch bump never collides with them.
2. Reads the published version from `package.json`.
3. Tags the commit `vX.Y.Z` and pushes the tag.
4. Creates a GitHub Release with auto-generated notes (VSIX attached).
5. Syncs the bumped `package.json` back to `main` via an auto-PR titled
   `chore: bump version to vX.Y.Z`. The publish workflow has a job-level
   guard that skips when the push is such a version sync-back (commit message
   starts with `chore: bump version to v`), so the sync-back does not
   re-trigger publishing (no loop). CI runs on the PR, and the workflow
   enables auto-merge so it lands as soon as checks pass.

`main` is branch-protected (PRs only), so the version sync-back uses the PR
path. The `vX.Y.Z` tag is the canonical record of the published version.

## Pre-release (automatic per PR)

Every push to an open pull request publishes a unique pre-release to the
Marketplace pre-release channel:

- Runs after `build` and `test-e2e` pass, on same-repo, non-draft,
  non-dependabot PRs. Version sync-back branches (`ci/bump-v*`) are skipped.
- Versions use the `0.9.<workflow-run>` line: the Marketplace only accepts
  plain `major.minor.patch` (no semver pre-release tags) and pre-release
  versions must differ from stable. `0.9.x` is always above the stable
  `0.3.x` line, so it never collides with stable releases and the newest
  push wins the channel.
- Re-running a workflow re-publishes the same version (deduplicated, safe).
- The published version is commented on the PR.

Pre-release publishes do NOT create tags, GitHub releases, or the version
sync-back PR.
