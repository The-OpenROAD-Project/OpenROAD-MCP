/**
 * Real OpenROAD REPL integration check.
 * Run with: npx tsx scripts/integration_check.ts
 */

import { InteractiveSession } from "../src/interactive/session.js";
import { Settings } from "../src/config/settings.js";

const PASS = "✓";
const FAIL = "✗";
const results: { label: string; ok: boolean; detail?: string }[] = [];

function check(label: string, ok: boolean, detail?: string) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? `  →  ${detail}` : ""}`);
}

async function waitForPrompt(session: InteractiveSession, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let accumulated = "";
  while (Date.now() < deadline) {
    const result = await session.readOutput(500);
    accumulated += result.output;
    if (accumulated.includes("openroad>") || accumulated.includes("%")) break;
  }
  return accumulated;
}

async function run() {
  console.log("\nOpenROAD REPL integration check\n");

  const settings = new Settings({ ENABLE_COMMAND_VALIDATION: false });
  const session = new InteractiveSession("integration-check", 256 * 1024, settings);

  // ── 1. Spawn ────────────────────────────────────────────────────────────────
  console.log("1. Session lifecycle");
  try {
    await session.start(["openroad", "-no_init"]);
    check("start() succeeds", true);
    check("state is ACTIVE after start", session.state === "active", session.state);
    check("isAlive() returns true", session.checkAlive());
    check("writer task running", session.isRunning());
  } catch (e) {
    check("start() succeeds", false, String(e));
    process.exit(1);
  }

  // ── 2. Initial prompt ───────────────────────────────────────────────────────
  console.log("\n2. Initial prompt");
  const banner = await waitForPrompt(session, 6000);
  check("received output after spawn", banner.length > 0, `${banner.length} chars`);
  check(
    "OpenROAD banner present",
    banner.includes("OpenROAD") || banner.includes("openroad"),
    banner.slice(0, 80).replace(/\n/g, " "),
  );

  // ── 3. puts echo ────────────────────────────────────────────────────────────
  console.log("\n3. Command round-trip");
  await session.sendCommand('puts "hello_integration"');
  const echoResult = await session.readOutput(3000);
  check("sendCommand does not throw", true);
  check(
    "output contains echo",
    echoResult.output.includes("hello_integration"),
    echoResult.output.replace(/\n/g, " ").slice(0, 100),
  );
  check("commandCount incremented", session.commandCount >= 1, String(session.commandCount));

  // ── 4. Error detection ──────────────────────────────────────────────────────
  console.log("\n4. Error detection");
  await session.sendCommand("nonexistent_command_xyz");
  const errResult = await session.readOutput(3000);
  check(
    "error field populated for bad command",
    errResult.error !== null,
    errResult.error ?? "(null)",
  );

  // ── 5. Multiple commands ────────────────────────────────────────────────────
  console.log("\n5. Multiple sequential commands");
  const before = session.commandCount;
  await session.sendCommand('puts "cmd1"');
  await session.readOutput(1000);
  await session.sendCommand('puts "cmd2"');
  await session.readOutput(1000);
  check("commandCount advances correctly", session.commandCount === before + 2, String(session.commandCount));

  // ── 6. Buffer ───────────────────────────────────────────────────────────────
  console.log("\n6. Output buffer");
  const stats = await session.outputBuffer.getStats();
  check("buffer maxSize is set", stats.maxSize > 0, `${stats.maxSize} chars`);

  // ── 7. Graceful termination ─────────────────────────────────────────────────
  console.log("\n7. Termination");
  await session.sendCommand("exit");
  await new Promise<void>((r) => setTimeout(r, 500));
  await session.cleanup();
  check("cleanup() does not throw", true);
  check("state is TERMINATED after cleanup", session.state === "terminated", session.state);
  check("isAlive() returns false after cleanup", !session.checkAlive());

  // ── Summary ─────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n${"─".repeat(48)}`);
  console.log(`  ${passed}/${total} checks passed`);
  if (passed < total) {
    console.log(`\n  Failed:`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`    ${FAIL}  ${r.label}`));
    process.exit(1);
  }
  console.log();
}

run().catch((e) => {
  console.error("\nUnexpected error:", e);
  process.exit(1);
});
