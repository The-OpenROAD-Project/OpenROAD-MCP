#!/usr/bin/env python3
"""
Generate a Keep-a-Changelog section from conventional commits since the last tag.

Usage: generate_changelog_section.py [output_file]

Writes the section text to output_file (default: /tmp/changelog_section.txt).
"""

import re
import subprocess
import sys

REPO = "The-OpenROAD-Project/openroad-mcp"
OUTPUT_FILE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/changelog_section.txt"

tags = subprocess.check_output(["git", "tag", "--sort=-v:refname"]).decode().strip()
last_tag = tags.splitlines()[0] if tags else ""

if last_tag:
    log = subprocess.check_output(["git", "log", f"{last_tag}..HEAD", "--oneline"]).decode().strip()
else:
    log = subprocess.check_output(["git", "log", "--oneline"]).decode().strip()

added, changed, fixed = [], [], []

for line in log.splitlines():
    parts = line.split(" ", 1)
    if len(parts) < 2:
        continue
    msg = parts[1]

    pr_match = re.search(r"\(#(\d+)\)", msg)
    pr_num = pr_match.group(1) if pr_match else None

    clean = re.sub(r"^[a-z]+\([^)]+\):\s*", "", msg)
    clean = re.sub(r"^[a-z]+:\s*", "", clean)
    clean = re.sub(r"\s*\(#\d+\)\s*$", "", clean).strip()

    if pr_num:
        entry = f"- {clean} ([#{pr_num}](https://github.com/{REPO}/pull/{pr_num}))"
    else:
        entry = f"- {clean}"

    if re.match(r"feat(\(|:)", msg):
        added.append(entry)
    elif re.match(r"fix(\(|:)", msg):
        fixed.append(entry)
    elif re.match(r"(chore|build|ci|perf|refactor|docs|style|test)(\(|:)", msg):
        changed.append(entry)

sections = []
if added:
    sections.append("### Added\n" + "\n".join(added))
if changed:
    sections.append("### Changed\n" + "\n".join(changed))
if fixed:
    sections.append("### Fixed\n" + "\n".join(fixed))

body = "\n\n".join(sections) if sections else "### Changed\n- Minor updates and maintenance"

with open(OUTPUT_FILE, "w") as f:
    f.write(body)

print(f"Generated changelog section ({OUTPUT_FILE}):")
print(body)
