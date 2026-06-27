# Release Process

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow:

1. Auto-bumps **patch** via `vsce publish patch` (reads from `package.json`)
2. Publishes to Marketplace as **stable**
3. Tags the commit with the new version
4. Creates a GitHub Release with auto-generated notes

No manual tagging needed. Retries up to 3 times on transient failure.

## Pre-release (on demand from any branch)

Push a `v*-pre*` tag from any branch to test a version before merging:

```bash
# first bump the version in package.json manually if needed
# then create and push the tag
git tag v0.4.0-pre.1
git push origin v0.4.0-pre.1
```

The workflow auto-bumps **patch** via `vsce publish patch --pre-release` before publishing.
The resulting version must not already exist on the Marketplace — bump `package.json` before tagging if a conflict is expected.
