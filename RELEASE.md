# Release Process

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow:

1. Reads the **latest stable git tag** (ignoring pre-release tags), bumps **patch**
2. Publishes to Marketplace as **stable**
3. Tags the commit with the new version
4. Creates a GitHub Release with auto-generated notes

No manual tagging needed. The commit itself is not modified — the tag is the canonical record of the version.

## Pre-release (on demand from any branch)

Push a `v*-pre*` tag from any branch to test a version before merging:

```bash
# first bump the version in package.json manually
# then create and push the tag
git tag v0.4.0-pre.1
git push origin v0.4.0-pre.1
```

The workflow publishes the current `package.json` version with the `--pre-release` flag.
The version must not already exist on the Marketplace — bump before tagging if needed.
