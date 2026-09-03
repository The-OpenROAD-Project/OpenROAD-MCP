---
name: release
description: |
  Prepare a new version release for the openroad-mcp project. Automates version
  bumping, changelog generation, lockfile updates, and release commit creation.

  Use this skill whenever the user asks to:
  - Prepare a release, cut a release, or do a release
  - Bump the version or update the version
  - Create a release commit
  - Ship a new version
  - Update the changelog for a new release

  Trigger on phrases like "release", "bump version", "prepare release", "cut v0.x",
  "ship it", "new release", or any mention of version numbers in the context of
  publishing. Also trigger when the user references the release process we've done
  before (e.g., "do the release thing", "same as last time").
metadata:
  internal: true
---

# Release Preparation

This skill automates the full release preparation workflow for the openroad-mcp
project. It ensures every file that references the version gets updated consistently.

## Project context

- **Build system**: npm / Node.js 22
- **Version source**: `typescript/package.json` `.version` field
- **Changelog format**: Keep a Changelog
- **GitHub repo**: `The-OpenROAD-Project/openroad-mcp`
- **Release gatekeeper**: @vvbandeira (org member) — must approve and merge all releases

## Workflow

### Step 1: Determine versions

Read the current version from `typescript/package.json`:

```bash
jq -r '.version' typescript/package.json
```

Then ask the user what the new version should be. Suggest the next logical
semver bump based on the commits since the last release:

- **Patch** (0.3.0 → 0.3.1): only fixes and minor changes
- **Minor** (0.3.0 → 0.4.0): new features added, backwards compatible
- **Major** (0.3.0 → 1.0.0): breaking changes

Show the suggestion but let the user decide.

### Step 2: Collect commits since last release

Get the last release tag:

```bash
git tag --sort=-v:refname | head -5
```

Then list all commits since that tag:

```bash
git log <last-tag>..HEAD --oneline
```

If no tag exists, use the first commit or the last "chore: release" commit:

```bash
git log --oneline --grep="chore: release" | head -1
```

### Step 3: Categorize commits into changelog sections

Read each commit message and sort into Keep a Changelog categories. Commits may
use conventional prefixes **or** plain one-liner sentences — both are accepted:

| Category | Prefixed form | Plain form (keyword) |
|----------|---------------|----------------------|
| **Added** | `feat:` | sentence mentions "add", "new", "ship" |
| **Changed** | `chore:`, `ci:`, `build:`, `refactor:`, `docs:` | anything else |
| **Fixed** | `fix:` | sentence mentions "fix", "correct", "repair" |

For each commit, format the changelog entry as:
```
- Description ([#PR](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/PR))
```

Use the PR number from the commit message if present. For commits without a PR
number, just use the description sentence.

### Step 4: Update all version references

These files must be updated with the new version. Update ALL of them — missing
one breaks the release consistency.

**typescript/package.json** (+ lockfile) — the canonical version source:

```bash
npm version --prefix typescript --no-git-tag-version X.Y.Z
```

This updates `package.json` and `package-lock.json` together. The TypeScript
server reads its advertised MCP version from `package.json`.

**server.json** — Update all version references:
- Top-level `"version": "X.Y.Z"`
- npm package `"version": "X.Y.Z"`
- OCI identifier `"identifier": "ghcr.io/The-OpenROAD-Project/openroad-mcp:X.Y.Z"`

**CHANGELOG.md** — Add new section before the previous version's section.
Today's date goes in the header. Add the link at the bottom:

```
[X.Y.Z]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/vX.Y.Z
```

### Step 5: Run tests

Run the test suite to verify nothing is broken:

```bash
cd typescript && npm run test
```

If tests fail, report the failures to the user before proceeding. Do not commit
a broken release.

### Step 6: Create the release commit and open a PR

Stage only the release-related files:

```bash
git add CHANGELOG.md server.json typescript/package.json typescript/package-lock.json
```

Commit under the `openroad-ci` bot identity (public org member — required so the
MCP Registry OIDC check passes when the release workflow runs):

```bash
git -c user.name="openroad-ci" \
    -c user.email="54529053+openroad-ci@users.noreply.github.com" \
    commit -m "chore: release vX.Y.Z"
```

Then push to a dedicated release branch and open a PR:

```bash
git checkout -b release/vX.Y.Z
git push -u origin release/vX.Y.Z
gh pr create \
  --title "chore: release vX.Y.Z" \
  --body "$(cat <<'EOF'
## Release vX.Y.Z

See [CHANGELOG.md](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/release/vX.Y.Z/CHANGELOG.md) for full details.

/cc @vvbandeira — please review and merge when ready.
EOF
)" \
  --reviewer vvbandeira
```

**NEVER push directly to `main`.** The decision to merge and tag belongs exclusively
to @vvbandeira. Once the PR is open, report the PR URL to the user and stop — do not
merge, squash, or tag.

> **Tagging is automated.** When @vvbandeira squash-merges the release PR, the
> `auto-tag.yml` workflow detects the `chore: release vX.Y.Z` commit message and
> pushes the tag as `openroad-ci` using `OPENROAD_CI_PAT`. This ensures the
> release workflow actor is a publicly visible org member, satisfying the MCP
> Registry OIDC check. No manual tagging needed.

## Important details

- **Never push to `main` directly.** Always use a `release/vX.Y.Z` branch and open a PR.
- **@vvbandeira must review and merge** — request them as a reviewer on every release PR.
- **`OPENROAD_CI_PAT` secret required** — this PAT must be stored in the repo settings
  with `Contents: Read and write` scope (and Pull requests write for Prepare Release).
  The `auto-tag.yml` / `prepare-release.yml` workflows use it to push the release
  branch/tag as `openroad-ci`, satisfying the MCP Registry org-membership check.
- The CHANGELOG date format is ISO: `YYYY-MM-DD`
- Version tags use a `v` prefix: `v0.4.0` (but the version in files has no prefix)
- Check for ALL files referencing the old version before committing:
  ```bash
  grep -r "OLD_VERSION" typescript/package.json typescript/package-lock.json server.json CHANGELOG.md
  ```
- If `server.json` doesn't exist, skip it (some repos may not have it)
