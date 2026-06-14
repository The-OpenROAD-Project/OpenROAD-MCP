import { initSettings } from "./config/settings.js";

// Eagerly initialise settings at startup so a misconfigured environment variable
// is reported with useful context and a non-zero exit code, rather than crashing
// later from inside module initialisation when settings are first accessed.
try {
  initSettings();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
