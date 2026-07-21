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
---

# Release Preparation

This skill automates the full release preparation workflow for the openroad-mcp
project. It ensures every file that references the version gets updated consistently.

## Project context

- **Build system**: hatchling (Python)
- **Package manager**: uv
- **Version source**: `python/pyproject.toml` `[project] version`
- **Changelog format**: Keep a Changelog
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)
- **GitHub repo**: `The-OpenROAD-Project/openroad-mcp`
- **Release gatekeeper**: @vvbandeira (org member) — must approve and merge all releases

## Workflow

### Step 1: Determine versions

Read the current version from `python/pyproject.toml`:

```
grep '^version = ' python/pyproject.toml
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

Read each commit message and sort into Keep a Changelog categories:

| Category | Conventional commit prefix |
|----------|---------------------------|
| **Added** | `feat:` |
| **Changed** | `chore:`, `build:`, `ci:`, `perf:`, `refactor:` |
| **Fixed** | `fix:` |
| **Removed** | commits mentioning removal/deprecation |

For each commit, format the changelog entry as:
```
- Description ([#PR](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/PR))
```

Use the PR number from the commit message if present. For commits without a PR
number, just use the description part after the prefix.

### Step 4: Update all version references

These files must be updated with the new version. Update ALL of them — missing
one breaks the release consistency.

**python/pyproject.toml** — Update `version = "X.Y.Z"` in the `[project]` section.

**typescript/package.json** (+ lockfile) — Update the npm package version to match
(e.g. `npm version --prefix typescript --no-git-tag-version X.Y.Z`). The
TypeScript server reads its advertised MCP version from `package.json`.

**server.json** — Update all version references:
- Top-level `"version": "X.Y.Z"`
- npm package `"version": "X.Y.Z"`
- PyPI package `"version": "X.Y.Z"`
- OCI identifier `"identifier": "ghcr.io/The-OpenROAD-Project/openroad-mcp:X.Y.Z"`

**MCP manifest files and README** — These files use `git+https://github.com/The-OpenROAD-Project/openroad-mcp`
without a version pin. Update every occurrence to pin to the release tag, which
prevents supply chain attacks by ensuring users install a known, reviewed commit:

Change:
```
"git+https://github.com/The-OpenROAD-Project/openroad-mcp"
```
To:
```
"git+https://github.com/The-OpenROAD-Project/openroad-mcp@vX.Y.Z#subdirectory=python"
```

The `#subdirectory=python` fragment is required because the Python project lives
under `python/`, not at the repo root — without it `uvx --from git+…` fails with
"does not appear to be a Python project".

Use a single perl pass that handles all three URL patterns in the README (and
normalizes the `#subdirectory=python` fragment, re-pinning even URLs that already
carry it):
- JSON/TOML quoted: `"git+https://...openroad-mcp@v0.5.3#subdirectory=python"`
- YAML unquoted list item: `- git+https://...openroad-mcp@v0.5.3#subdirectory=python` (end of line)
- Bare (first-time pin): `"git+https://...openroad-mcp"`

```bash
perl -i -pe 's!git\+https://github\.com/The-OpenROAD-Project/openroad-mcp(?:\@v[\d.]+)?(?:#subdirectory=python)?(?="|$)!git+https://github.com/The-OpenROAD-Project/openroad-mcp\@vX.Y.Z#subdirectory=python!g' README.md python/README.md
```

The `!` delimiter avoids clashing with the `|` inside the lookahead `(?="|$)`.
The lookahead matches either a closing quote (JSON/TOML) or end of line (YAML),
so all config formats are covered. The optional `(?:#subdirectory=python)?` lets
the pass re-pin URLs that already carry the fragment without doubling it.

After updating, verify all pinned URLs show the new tag:
```bash
grep "The-OpenROAD-Project/openroad-mcp@" README.md python/README.md
```
Every line should show `@vX.Y.Z`. Also confirm no bare URLs remain:
```bash
grep 'The-OpenROAD-Project/openroad-mcp"' README.md python/README.md
```
That should return no output.

> **Side note for users:** If you always want the latest version and prefer not
> to pin, omit the `@vX.Y.Z` suffix and use the bare URL:
> `git+https://github.com/The-OpenROAD-Project/openroad-mcp`. This trades supply chain
> safety for convenience — acceptable for local/dev setups, not recommended
> for shared or production environments.

**python/uv.lock** — Regenerate by running `uv lock` from `python/`. Do NOT hand-edit this file.

**CHANGELOG.md** — Add new section before the previous version's section.
Today's date goes in the header. Add the link at the bottom:

```
[X.Y.Z]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/vX.Y.Z
```

### Step 5: Run tests

Run the test suite to verify nothing is broken:

```bash
cd python && uv run pytest --tb=short -q
```

If tests fail, report the failures to the user before proceeding. Do not commit
a broken release.

### Step 6: Create the release commit and open a PR

Stage only the release-related files:

```bash
git add CHANGELOG.md python/pyproject.toml server.json python/uv.lock \
        README.md python/README.md typescript/package.json typescript/package-lock.json
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
  with `Contents: Read and write` scope. The `auto-tag.yml` workflow uses it to push
  the release tag as `openroad-ci`, satisfying the MCP Registry org-membership check.
- Always use `uv lock` to regenerate the lockfile rather than editing it manually
- The CHANGELOG date format is ISO: `YYYY-MM-DD`
- Version tags use a `v` prefix: `v0.4.0` (but the version in files has no prefix)
- Check for ALL files referencing the old version by running:
  ```
  grep -r "OLD_VERSION" --include="*.toml" --include="*.json" --include="*.lock" --include="*.md"
  ```
  (replace `OLD_VERSION` with the actual previous version, e.g. `0\.5\.2`)
  before committing, to catch any missed references
- Also verify the README git URLs were updated:
  ```
  grep "openroad-mcp@" README.md
  ```
  All occurrences should show the new `@vX.Y.Z` tag
- If `server.json` doesn't exist, skip it (some repos may not have it)
