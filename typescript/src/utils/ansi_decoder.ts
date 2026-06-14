import stripAnsi from "strip-ansi";

const ESCAPE_SEQUENCES: Record<string, string> = {
  // Private mode sequences (DECSET/DECRST). Specific codes are listed first so
  // they match before the generic private-mode catch-all below.
  "\\x1b\\[\\?2004h": "Enable bracketed paste mode",
  "\\x1b\\[\\?2004l": "Disable bracketed paste mode",
  "\\x1b\\[\\?1049h": "Enable alternative screen buffer",
  "\\x1b\\[\\?1049l": "Disable alternative screen buffer",
  "\\x1b\\[\\?25h": "Show cursor",
  "\\x1b\\[\\?25l": "Hide cursor",
  // Generic private-mode set/reset. The `?` is escaped so `[?` is mandatory,
  // preventing single-char escapes like \x1bh / \x1bl from matching here.
  "\\x1b\\[\\?\\d*h": "Enable terminal mode",
  "\\x1b\\[\\?\\d*l": "Disable terminal mode",
  // Cursor movement
  "\\x1b\\[\\d*A": "Move cursor up",
  "\\x1b\\[\\d*B": "Move cursor down",
  "\\x1b\\[\\d*C": "Move cursor right",
  "\\x1b\\[\\d*D": "Move cursor left",
  "\\x1b\\[\\d*;\\d*H": "Move cursor to position",
  "\\x1b\\[\\d*;\\d*f": "Move cursor to position",
  "\\x1b\\[H": "Move cursor to home",
  "\\x1b\\[2J": "Clear entire screen",
  "\\x1b\\[K": "Clear line from cursor to end",
  "\\x1b\\[0K": "Clear line from cursor to end",
  "\\x1b\\[1K": "Clear line from start to cursor",
  "\\x1b\\[2K": "Clear entire line",
  // Text formatting
  "\\x1b\\[0m": "Reset all formatting",
  "\\x1b\\[1m": "Bold text",
  "\\x1b\\[2m": "Dim text",
  "\\x1b\\[3m": "Italic text",
  "\\x1b\\[4m": "Underline text",
  "\\x1b\\[5m": "Blinking text",
  "\\x1b\\[7m": "Reverse video",
  "\\x1b\\[8m": "Hidden text",
  "\\x1b\\[9m": "Strikethrough text",
  // Colors (foreground)
  "\\x1b\\[30m": "Black text",
  "\\x1b\\[31m": "Red text",
  "\\x1b\\[32m": "Green text",
  "\\x1b\\[33m": "Yellow text",
  "\\x1b\\[34m": "Blue text",
  "\\x1b\\[35m": "Magenta text",
  "\\x1b\\[36m": "Cyan text",
  "\\x1b\\[37m": "White text",
  // Colors (background)
  "\\x1b\\[40m": "Black background",
  "\\x1b\\[41m": "Red background",
  "\\x1b\\[42m": "Green background",
  "\\x1b\\[43m": "Yellow background",
  "\\x1b\\[44m": "Blue background",
  "\\x1b\\[45m": "Magenta background",
  "\\x1b\\[46m": "Cyan background",
  "\\x1b\\[47m": "White background",
};

// Matches the common ANSI escape sequence families so that non-CSI sequences
// (OSC, charset designation, single/two-char escapes) are detected in every
// mode rather than leaking through as raw bytes. Order matters: longer/anchored
// alternatives come first so they win at a given match position.
//   1. OSC:            ESC ] ... (BEL | ST)
//   2. CSI:            ESC [ params final
//   3. Charset/desig.: ESC ( | ) | # <char>
//   4. Single/two-char: ESC <char>
const ESCAPE_PATTERN =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()#][0-9A-Za-z]|\x1b[=>NMcDEH78]/g;

const VALID_MODES = ["remove", "annotate", "preserve", "decode"];

// Pre-compile the escape-sequence patterns once at module load instead of
// allocating ~45 RegExp objects on every decodeEscapeSequence() call.
const COMPILED_SEQUENCES: Array<[RegExp, string]> = Object.entries(ESCAPE_SEQUENCES).map(
  ([pattern, description]) => [new RegExp(`^${pattern}`), description],
);

export class ANSIDecoder {
  static decodeEscapeSequence(sequence: string): string {
    for (const [pattern, description] of COMPILED_SEQUENCES) {
      if (pattern.test(sequence)) return description;
    }

    if (sequence.startsWith("\x1b[")) {
      if (sequence.includes("?")) {
        if (sequence.endsWith("h")) return `Enable terminal mode (${sequence})`;
        if (sequence.endsWith("l")) return `Disable terminal mode (${sequence})`;
      } else if (sequence.endsWith("m")) {
        return `Text formatting (${sequence})`;
      } else if (/[ABCD]/.test(sequence)) {
        return `Cursor movement (${sequence})`;
      } else if (sequence.includes("H") || sequence.includes("f")) {
        return `Cursor positioning (${sequence})`;
      } else if (sequence.includes("J") || sequence.includes("K")) {
        return `Clear operation (${sequence})`;
      }
    }

    return `Unknown escape sequence (${sequence})`;
  }

  static translateOutput(text: string, mode: string = "annotate"): string {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`Unknown mode: ${mode}`);
    }

    if (!text) return text;

    const sequences = text.match(ESCAPE_PATTERN) ?? [];

    if (mode === "remove") {
      return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    if (mode === "annotate") {
      let result = text;
      for (const seq of new Set(sequences)) {
        result = result.replaceAll(seq, `[${ANSIDecoder.decodeEscapeSequence(seq)}]`);
      }
      return result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    if (mode === "preserve") {
      let result = text;
      for (const seq of new Set(sequences)) {
        result = result.replaceAll(seq, `${seq}[${ANSIDecoder.decodeEscapeSequence(seq)}]`);
      }
      return result;
    }

    if (mode === "decode") {
      const lines = [text, "\n--- ANSI Escape Sequence Breakdown ---"];
      for (const seq of new Set(sequences)) {
        lines.push(`${JSON.stringify(seq)} -> ${ANSIDecoder.decodeEscapeSequence(seq)}`);
      }
      return lines.join("\n");
    }

    throw new Error(`Unknown mode: ${mode}`);
  }

  static cleanOpenroadOutput(output: string): string {
    if (!output) return output;

    let cleaned = ANSIDecoder.translateOutput(output, "remove");
    cleaned = cleaned.replace(/openroad>\s*/g, "");
    cleaned = cleaned.replace(/\n\s*\n/g, "\n").trim();
    return cleaned;
  }

  static getSequenceStats(text: string): Record<string, number> {
    const sequences = text.match(ESCAPE_PATTERN) ?? [];
    const stats: Record<string, number> = {};
    for (const seq of sequences) {
      const key = `${JSON.stringify(seq)} (${ANSIDecoder.decodeEscapeSequence(seq)})`;
      stats[key] = (stats[key] ?? 0) + 1;
    }
    return stats;
  }
}
