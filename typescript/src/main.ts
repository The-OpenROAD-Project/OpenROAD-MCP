import { initSettings } from "./config/settings.js";

// Initialise settings up front so a misconfigured env var fails fast with
// context rather than crashing later from inside module initialisation.
try {
  initSettings();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
