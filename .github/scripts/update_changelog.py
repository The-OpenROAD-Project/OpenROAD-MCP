#!/usr/bin/env python3
"""
Insert a new version section into CHANGELOG.md (Keep-a-Changelog format).

Usage: update_changelog.py <new_version> <new_tag> [section_file]

  new_version   Version string without prefix, e.g. 0.6.0
  new_tag       Git tag with prefix, e.g. v0.6.0
  section_file  Path to the section body (default: /tmp/changelog_section.txt)
"""

import sys
from datetime import date

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(1)

new_version = sys.argv[1]
new_tag = sys.argv[2]
section_file = sys.argv[3] if len(sys.argv) > 3 else "/tmp/changelog_section.txt"

today = date.today().isoformat()

with open(section_file) as f:
    section = f.read().strip()

with open("CHANGELOG.md") as f:
    content = f.read()

new_entry = f"## [{new_version}] - {today}\n\n{section}"
insert_marker = "\n## ["
idx = content.find(insert_marker)
if idx == -1:
    content += f"\n{new_entry}\n"
else:
    content = content[:idx] + f"\n\n{new_entry}" + content[idx:]

link = f"[{new_version}]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/{new_tag}"

content = content.rstrip("\n") + f"\n{link}\n"

with open("CHANGELOG.md", "w") as f:
    f.write(content)

print(f"Inserted {new_version} section into CHANGELOG.md")
