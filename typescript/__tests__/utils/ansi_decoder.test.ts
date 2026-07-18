import { describe, it, expect } from "vitest";
import { ANSIDecoder } from "../../src/utils/ansi_decoder.js";

describe("ANSIDecoder", () => {
  describe("decodeEscapeSequence", () => {
    it("decodes known sequences", () => {
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[0m")).toBe("Reset all formatting");
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[1m")).toBe("Bold text");
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[31m")).toBe("Red text");
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[2J")).toBe("Clear entire screen");
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[H")).toBe("Move cursor to home");
    });

    it("decodes bracketed paste mode via fallback check", () => {
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[?2004h")).toBe("Enable bracketed paste mode");
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[?2004l")).toBe("Disable bracketed paste mode");
    });

    it("returns generic description for unknown sequences", () => {
      const result = ANSIDecoder.decodeEscapeSequence("\x1b[99z");
      expect(result).toContain("Unknown escape sequence");
    });

    it("returns generic mode description for private mode sequences", () => {
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[?99h")).toMatch(/Enable terminal mode/);
      expect(ANSIDecoder.decodeEscapeSequence("\x1b[?99l")).toMatch(/Disable terminal mode/);
    });
  });

  describe("translateOutput - remove mode", () => {
    it("strips ANSI codes", () => {
      expect(ANSIDecoder.translateOutput("\x1b[31mhello\x1b[0m", "remove")).toBe("hello");
    });

    it("normalises CR LF to LF", () => {
      expect(ANSIDecoder.translateOutput("a\r\nb", "remove")).toBe("a\nb");
    });

    it("normalises lone CR to LF", () => {
      expect(ANSIDecoder.translateOutput("a\rb", "remove")).toBe("a\nb");
    });

    it("returns empty string unchanged", () => {
      expect(ANSIDecoder.translateOutput("", "remove")).toBe("");
    });
  });

  describe("translateOutput - annotate mode", () => {
    it("replaces sequences with bracketed descriptions", () => {
      const result = ANSIDecoder.translateOutput("\x1b[1mtext\x1b[0m", "annotate");
      expect(result).toContain("[Bold text]");
      expect(result).toContain("[Reset all formatting]");
      expect(result).toContain("text");
    });

    it("deduplicates repeated sequences", () => {
      const result = ANSIDecoder.translateOutput("\x1b[1ma\x1b[1mb", "annotate");
      expect(result).toBe("[Bold text]a[Bold text]b");
    });
  });

  describe("translateOutput - preserve mode", () => {
    it("keeps the original sequence and appends annotation", () => {
      const result = ANSIDecoder.translateOutput("\x1b[1mtext", "preserve");
      expect(result).toContain("\x1b[1m[Bold text]");
      expect(result).toContain("text");
    });
  });

  describe("translateOutput - $ replacement safety", () => {
    it("does not reinterpret $& inside an OSC sequence body when annotating", () => {
      // OSC title set with a literal "$&" in the body. With a string replacement
      // the "$&" would expand to the matched sequence and corrupt the output.
      const osc = "\x1b]0;$&title\x07";
      const result = ANSIDecoder.translateOutput(`before${osc}after`, "annotate");
      expect(result).toBe("before[Unknown escape sequence (\x1b]0;$&title\x07)]after");
    });

    it("inserts the original sequence literally in preserve mode", () => {
      const osc = "\x1b]0;$$x\x07";
      const result = ANSIDecoder.translateOutput(osc, "preserve");
      expect(result).toContain(osc);
    });
  });

  describe("translateOutput - decode mode", () => {
    it("includes breakdown header", () => {
      const result = ANSIDecoder.translateOutput("\x1b[1mtext", "decode");
      expect(result).toContain("--- ANSI Escape Sequence Breakdown ---");
    });

    it("includes the original text", () => {
      const input = "\x1b[1mtext";
      const result = ANSIDecoder.translateOutput(input, "decode");
      expect(result.startsWith(input)).toBe(true);
    });
  });

  describe("translateOutput - invalid mode", () => {
    it("throws for unknown mode", () => {
      expect(() => ANSIDecoder.translateOutput("text", "bogus")).toThrow("Unknown mode: bogus");
    });
  });

  describe("cleanOpenroadOutput", () => {
    it("strips ANSI codes and prompt artifacts", () => {
      const raw = "\x1b[32mopenroad> \x1b[0msome output\nopenroad> ";
      const result = ANSIDecoder.cleanOpenroadOutput(raw);
      expect(result).toBe("some output");
    });

    it("collapses multiple blank lines", () => {
      const result = ANSIDecoder.cleanOpenroadOutput("line1\n\n\nline2");
      expect(result).toBe("line1\nline2");
    });

    it("trims leading and trailing whitespace", () => {
      expect(ANSIDecoder.cleanOpenroadOutput("  hello  ")).toBe("hello");
    });

    it("returns empty string for empty input", () => {
      expect(ANSIDecoder.cleanOpenroadOutput("")).toBe("");
    });
  });

  describe("getSequenceStats", () => {
    it("counts each unique sequence", () => {
      const text = "\x1b[1mA\x1b[1mB\x1b[0mC";
      const stats = ANSIDecoder.getSequenceStats(text);
      const boldKey = Object.keys(stats).find((k) => k.includes("Bold text"));
      const resetKey = Object.keys(stats).find((k) => k.includes("Reset all formatting"));
      expect(boldKey).toBeDefined();
      expect(stats[boldKey!]).toBe(2);
      expect(resetKey).toBeDefined();
      expect(stats[resetKey!]).toBe(1);
    });

    it("returns empty object for text with no sequences", () => {
      expect(ANSIDecoder.getSequenceStats("plain text")).toEqual({});
    });
  });
});
