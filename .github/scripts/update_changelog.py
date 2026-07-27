#!/usr/bin/env python3
"""
Insert a new version section into CHANGELOG.md (Keep-a-Changelog format).

Usage: update_changelog.py <new_version> <new_tag> [section_file]

  new_version   Version string without prefix, e.g. 0.6.0
  new_tag       Git tag with prefix, e.g. v0.6.0
  section_file  Path to the section body (default: /tmp/changelog_section.txt)

If CHANGELOG.md has a non-empty ## [Unreleased] body, that body is preferred
over section_file (curated notes win over auto-generated commit lists). The
Unreleased section is then reset to an empty placeholder.
"""

from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(1)

new_version = sys.argv[1]
new_tag = sys.argv[2]
section_file = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/changelog_section.txt")

today = date.today().isoformat()
changelog_path = Path("CHANGELOG.md")
content = changelog_path.read_text()

generated = section_file.read_text().strip() if section_file.exists() else ""

# Split on version headers while keeping the delimiters.
parts = re.split(r"(?=^## \[)", content, flags=re.MULTILINE)
# parts[0] is the preamble (# Changelog ...); subsequent parts start with "## ["
preamble = parts[0]
sections = parts[1:]

unreleased_body = ""
remaining: list[str] = []
for section in sections:
    if section.startswith("## [Unreleased]"):
        body = re.sub(r"^## \[Unreleased\]\s*", "", section, count=1).strip()
        unreleased_body = body
    else:
        remaining.append(section)

section_body = unreleased_body if unreleased_body else generated
if not section_body:
    section_body = "### Changed\n- Minor updates and maintenance"

new_entry = f"## [{new_version}] - {today}\n\n{section_body}\n\n"
content = preamble + "## [Unreleased]\n\n" + new_entry + "".join(remaining)

link = f"[{new_version}]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/{new_tag}"
if link not in content:
    # Reference links are kept in descending-version order; since new_version
    # is always the newest release, insert it above the existing block instead
    # of appending at end-of-file.
    match = re.search(r"^\[\d", content, flags=re.MULTILINE)
    if match:
        content = content[: match.start()] + link + "\n" + content[match.start() :]
    else:
        content = content.rstrip("\n") + f"\n{link}\n"

changelog_path.write_text(content)
print(f"Inserted {new_version} section into CHANGELOG.md")
if unreleased_body:
    print("Used curated [Unreleased] notes as the release body and cleared Unreleased.")
else:
    print("Used generated commit section as the release body.")
