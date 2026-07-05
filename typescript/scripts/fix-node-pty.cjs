/**
 * node-pty ships platform prebuilds with a spawn-helper binary that must be
 * executable. Some npm installs (sandboxed CI, strict umask, package managers)
 * leave it mode 0644, which makes posix_spawnp fail for every PTY session.
 */
const fs = require("node:fs");
const path = require("node:path");

const prebuildsDir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");

if (!fs.existsSync(prebuildsDir)) {
  process.exit(0);
}

for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const helper = path.join(prebuildsDir, entry.name, "spawn-helper");
  if (!fs.existsSync(helper)) continue;
  try {
    const mode = fs.statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helper, mode | 0o755);
    }
  } catch {
    // Best effort; PTY spawn will surface a clearer error at runtime.
  }
}
