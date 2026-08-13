# Release Process

All publishing happens from GitHub Actions — no local login needed.

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow:

1. Runs `vsce publish patch --no-git-tag-version` — vsce bumps the patch
   version in `package.json` locally and publishes the VSIX to the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp).
   A failed publish is retried up to 3 times.
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

## Pre-release (on demand from any branch)

Push a `v*-pre*` tag from any branch to test a version before merging:

```bash
# bump the version in package.json manually first
# then create and push the tag
git tag v0.4.0-pre.1
git push origin v0.4.0-pre.1
```

The workflow publishes the current `package.json` version with the
`--pre-release` flag to the Marketplace pre-release channel. The version must
not already exist on the Marketplace — bump before tagging if needed.

Pre-release publishes do NOT create tags, GitHub releases, or the version
sync-back PR.
