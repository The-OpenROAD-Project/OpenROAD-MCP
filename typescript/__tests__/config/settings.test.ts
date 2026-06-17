import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { Settings } from "../../src/config/settings.js";

const ENV_KEYS = [
  "OPENROAD_COMMAND_TIMEOUT",
  "OPENROAD_COMMAND_COMPLETION_DELAY",
  "OPENROAD_DEFAULT_BUFFER_SIZE",
  "OPENROAD_MAX_SESSIONS",
  "OPENROAD_SESSION_QUEUE_SIZE",
  "OPENROAD_SESSION_IDLE_TIMEOUT",
  "OPENROAD_READ_CHUNK_SIZE",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "ORFS_FLOW_PATH",
  "OPENROAD_ALLOWED_COMMANDS",
  "OPENROAD_ENABLE_COMMAND_VALIDATION",
  "OPENROAD_WHITELIST_ENABLED",
];

describe("Settings", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("defaults", () => {
    it("uses correct numeric defaults", () => {
      const s = Settings.fromEnv();
      expect(s.COMMAND_TIMEOUT).toBe(30.0);
      expect(s.COMMAND_COMPLETION_DELAY).toBe(0.1);
      expect(s.DEFAULT_BUFFER_SIZE).toBe(128 * 1024);
      expect(s.MAX_SESSIONS).toBe(50);
      expect(s.SESSION_QUEUE_SIZE).toBe(128);
      expect(s.SESSION_IDLE_TIMEOUT).toBe(300.0);
      expect(s.READ_CHUNK_SIZE).toBe(8192);
    });

    it("uses correct string defaults", () => {
      const s = Settings.fromEnv();
      expect(s.LOG_LEVEL).toBe("INFO");
      expect(s.LOG_FORMAT).toBe("%(asctime)s - %(name)s - %(levelname)s - %(message)s");
    });

    it("uses correct boolean defaults", () => {
      const s = Settings.fromEnv();
      expect(s.ENABLE_COMMAND_VALIDATION).toBe(true);
      expect(s.WHITELIST_ENABLED).toBe(true);
    });

    it("defaults ALLOWED_COMMANDS to ['openroad']", () => {
      const s = Settings.fromEnv();
      expect(s.ALLOWED_COMMANDS).toEqual(["openroad"]);
    });

    it("defaults ORFS_FLOW_PATH to ~/OpenROAD-flow-scripts/flow", () => {
      const s = Settings.fromEnv();
      expect(s.ORFS_FLOW_PATH).toBe(path.join(os.homedir(), "OpenROAD-flow-scripts", "flow"));
    });
  });

  describe("fromEnv() overrides", () => {
    it("reads OPENROAD_COMMAND_TIMEOUT as float", () => {
      process.env["OPENROAD_COMMAND_TIMEOUT"] = "60.5";
      expect(Settings.fromEnv().COMMAND_TIMEOUT).toBe(60.5);
    });

    it("reads OPENROAD_MAX_SESSIONS as int", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "10";
      expect(Settings.fromEnv().MAX_SESSIONS).toBe(10);
    });

    it("reads LOG_LEVEL as string", () => {
      process.env["LOG_LEVEL"] = "DEBUG";
      expect(Settings.fromEnv().LOG_LEVEL).toBe("DEBUG");
    });

    it("reads OPENROAD_ALLOWED_COMMANDS as comma-separated list", () => {
      process.env["OPENROAD_ALLOWED_COMMANDS"] = "openroad, yosys , abc";
      expect(Settings.fromEnv().ALLOWED_COMMANDS).toEqual(["openroad", "yosys", "abc"]);
    });

    it.each([
      ["true", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
    ])("parses OPENROAD_WHITELIST_ENABLED=%s as %s", (val, expected) => {
      process.env["OPENROAD_WHITELIST_ENABLED"] = val;
      expect(Settings.fromEnv().WHITELIST_ENABLED).toBe(expected);
    });

    it.each([
      ["true", true],
      ["false", false],
    ])("parses OPENROAD_ENABLE_COMMAND_VALIDATION=%s as %s", (val, expected) => {
      process.env["OPENROAD_ENABLE_COMMAND_VALIDATION"] = val;
      expect(Settings.fromEnv().ENABLE_COMMAND_VALIDATION).toBe(expected);
    });

    it("throws on invalid float", () => {
      process.env["OPENROAD_COMMAND_TIMEOUT"] = "notanumber";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_COMMAND_TIMEOUT");
    });

    it("rejects Infinity for float fields", () => {
      process.env["OPENROAD_COMMAND_TIMEOUT"] = "Infinity";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_COMMAND_TIMEOUT");
    });

    it("rejects negative floats", () => {
      process.env["OPENROAD_COMMAND_TIMEOUT"] = "-1";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_COMMAND_TIMEOUT");
    });

    it("throws on invalid int", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "3.7";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_MAX_SESSIONS");
    });

    it("rejects negative integers for int fields", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "-1";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_MAX_SESSIONS");
    });

    it("rejects decimal strings for int fields", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "50.0";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_MAX_SESSIONS");
    });

    it("rejects exponential notation for int fields", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "1e2";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_MAX_SESSIONS");
    });

    it("falls back to default ORFS_FLOW_PATH when env var is empty string", () => {
      process.env["ORFS_FLOW_PATH"] = "";
      const s = Settings.fromEnv();
      expect(s.ORFS_FLOW_PATH).toBe(path.join(os.homedir(), "OpenROAD-flow-scripts", "flow"));
    });

    it("falls back to default ORFS_FLOW_PATH when env var is whitespace", () => {
      process.env["ORFS_FLOW_PATH"] = "   ";
      const s = Settings.fromEnv();
      expect(s.ORFS_FLOW_PATH).toBe(path.join(os.homedir(), "OpenROAD-flow-scripts", "flow"));
    });

    it("throws on empty string for float field", () => {
      process.env["OPENROAD_COMMAND_TIMEOUT"] = "";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_COMMAND_TIMEOUT");
    });

    it("throws on empty string for int field", () => {
      process.env["OPENROAD_MAX_SESSIONS"] = "";
      expect(() => Settings.fromEnv()).toThrow("OPENROAD_MAX_SESSIONS");
    });

    it("falls back to default ALLOWED_COMMANDS when env var is empty string", () => {
      process.env["OPENROAD_ALLOWED_COMMANDS"] = "";
      expect(Settings.fromEnv().ALLOWED_COMMANDS).toEqual(["openroad"]);
    });

    it("falls back to default ALLOWED_COMMANDS when env var is all commas/spaces", () => {
      process.env["OPENROAD_ALLOWED_COMMANDS"] = " , , ";
      expect(Settings.fromEnv().ALLOWED_COMMANDS).toEqual(["openroad"]);
    });
  });

  describe("flowPath", () => {
    it("resolves ~ in ORFS_FLOW_PATH", () => {
      const s = new Settings({ ORFS_FLOW_PATH: "~/my-flow" });
      expect(s.flowPath).toBe(path.join(os.homedir(), "my-flow"));
    });

    it("resolves an absolute path unchanged", () => {
      const s = new Settings({ ORFS_FLOW_PATH: "/tmp/flow" });
      expect(s.flowPath).toBe("/tmp/flow");
    });
  });

  describe("platforms / designs", () => {
    it("returns [] for platforms when flowPath does not exist", () => {
      const s = new Settings({ ORFS_FLOW_PATH: "/nonexistent/path/flow" });
      expect(s.platforms).toEqual([]);
    });

    it("returns [] for designs when flowPath does not exist", () => {
      const s = new Settings({ ORFS_FLOW_PATH: "/nonexistent/path/flow" });
      expect(s.designs("sky130hd")).toEqual([]);
    });
  });
});
