# Release Process

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow:

1. Bumps the **patch** version automatically (e.g., `0.3.0` → `0.3.1`)
2. Publishes to Marketplace as **stable**
3. Commits the version bump back to `main`
4. Creates a GitHub Release with auto-generated notes

No manual tagging needed.

## Pre-release (on demand from any branch)

Push a `v*-pre*` tag from any branch to test a version before merging:

```bash
# first bump the version in package.json manually
# then create and push the tag
git tag v0.4.0-pre.1
git push origin v0.4.0-pre.1
```

The workflow publishes the current `package.json` version with `--pre-release` flag.
The version must not already exist on the Marketplace — bump before tagging if needed.
