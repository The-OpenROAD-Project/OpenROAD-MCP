"""ANSI escape code decoder for human-readable terminal output."""

import re


class ANSIDecoder:
    """Decoder for ANSI escape sequences with human-readable translations."""

    # Common ANSI escape sequences and their meanings
    ESCAPE_SEQUENCES: dict[str, str] = {
        # Terminal modes
        r"\x1b\[?\d*h": "Enable terminal mode",
        r"\x1b\[?\d*l": "Disable terminal mode",
        r"\x1b\[\?2004h": "Enable bracketed paste mode",
        r"\x1b\[\?2004l": "Disable bracketed paste mode",
        r"\x1b\[\?1049h": "Enable alternative screen buffer",
        r"\x1b\[\?1049l": "Disable alternative screen buffer",
        r"\x1b\[\?25h": "Show cursor",
        r"\x1b\[\?25l": "Hide cursor",
        # Cursor movement
        r"\x1b\[\d*A": "Move cursor up",
        r"\x1b\[\d*B": "Move cursor down",
        r"\x1b\[\d*C": "Move cursor right",
        r"\x1b\[\d*D": "Move cursor left",
        r"\x1b\[\d*;\d*H": "Move cursor to position",
        r"\x1b\[\d*;\d*f": "Move cursor to position",
        r"\x1b\[H": "Move cursor to home",
        r"\x1b\[2J": "Clear entire screen",
        r"\x1b\[K": "Clear line from cursor to end",
        r"\x1b\[0K": "Clear line from cursor to end",
        r"\x1b\[1K": "Clear line from start to cursor",
        r"\x1b\[2K": "Clear entire line",
        # Text formatting
        r"\x1b\[0m": "Reset all formatting",
        r"\x1b\[1m": "Bold text",
        r"\x1b\[2m": "Dim text",
        r"\x1b\[3m": "Italic text",
        r"\x1b\[4m": "Underline text",
        r"\x1b\[5m": "Blinking text",
        r"\x1b\[7m": "Reverse video",
        r"\x1b\[8m": "Hidden text",
        r"\x1b\[9m": "Strikethrough text",
        # Colors (foreground)
        r"\x1b\[30m": "Black text",
        r"\x1b\[31m": "Red text",
        r"\x1b\[32m": "Green text",
        r"\x1b\[33m": "Yellow text",
        r"\x1b\[34m": "Blue text",
        r"\x1b\[35m": "Magenta text",
        r"\x1b\[36m": "Cyan text",
        r"\x1b\[37m": "White text",
        # Colors (background)
        r"\x1b\[40m": "Black background",
        r"\x1b\[41m": "Red background",
        r"\x1b\[42m": "Green background",
        r"\x1b\[43m": "Yellow background",
        r"\x1b\[44m": "Blue background",
        r"\x1b\[45m": "Magenta background",
        r"\x1b\[46m": "Cyan background",
        r"\x1b\[47m": "White background",
    }

    @staticmethod
    def decode_escape_sequence(sequence: str) -> str:
        """Decode a single ANSI escape sequence to human-readable text.

        Args:
            sequence: The escape sequence to decode

        Returns:
            Human-readable description of the escape sequence
        """
        # Check exact matches first using the actual escape characters
        for pattern, description in ANSIDecoder.ESCAPE_SEQUENCES.items():
            if re.match(pattern, sequence):
                return description

        # Handle specific bracketed paste mode sequences
        if "?2004h" in sequence:
            return "Enable bracketed paste mode"
        elif "?2004l" in sequence:
            return "Disable bracketed paste mode"

        # Handle generic patterns
        if sequence.startswith("\x1b["):
            if "?" in sequence:
                if sequence.endswith("h"):
                    return f"Enable terminal mode ({sequence})"
                elif sequence.endswith("l"):
                    return f"Disable terminal mode ({sequence})"
            elif sequence.endswith("m"):
                return f"Text formatting ({sequence})"
            elif any(c in sequence for c in "ABCD"):
                return f"Cursor movement ({sequence})"
            elif "H" in sequence or "f" in sequence:
                return f"Cursor positioning ({sequence})"
            elif "J" in sequence or "K" in sequence:
                return f"Clear operation ({sequence})"

        return f"Unknown escape sequence ({sequence})"

    @staticmethod
    def translate_output(text: str, mode: str = "annotate") -> str:
        """Translate ANSI escape sequences in text.

        Args:
            text: Text containing ANSI escape sequences
            mode: Translation mode:
                - "annotate": Replace sequences with [human-readable] annotations
                - "remove": Remove all escape sequences
                - "preserve": Keep sequences but add annotations
                - "decode": Show detailed breakdown of each sequence

        Returns:
            Translated text based on the specified mode
        """
        if not text:
            return text

        # Find all ANSI escape sequences
        escape_pattern = r"\x1b\[[0-9;?]*[a-zA-Z]"
        sequences = re.findall(escape_pattern, text)

        if mode == "remove":
            # Simply remove all escape sequences
            result = re.sub(escape_pattern, "", text)
            # Also clean up common control characters
            result = result.replace("\r\n", "\n").replace("\r", "\n")
            return result

        elif mode == "annotate":
            # Replace escape sequences with human-readable annotations
            result = text
            for seq in set(sequences):  # Use set to avoid duplicate processing
                description = ANSIDecoder.decode_escape_sequence(seq)
                annotation = f"[{description}]"
                result = result.replace(seq, annotation)

            # Clean up control characters
            result = result.replace("\r\n", "\n").replace("\r", "")
            return result

        elif mode == "preserve":
            # Keep sequences but add annotations
            result = text
            for seq in set(sequences):
                description = ANSIDecoder.decode_escape_sequence(seq)
                annotation = f"{seq}[{description}]"
                result = result.replace(seq, annotation)
            return result

        elif mode == "decode":
            # Show detailed breakdown
            lines = [text, "\n--- ANSI Escape Sequence Breakdown ---"]
            for seq in set(sequences):
                description = ANSIDecoder.decode_escape_sequence(seq)
                lines.append(f"{repr(seq)} -> {description}")
            return "\n".join(lines)

        else:
            raise ValueError(f"Unknown mode: {mode}")

    @staticmethod
    def clean_openroad_output(output: str) -> str:
        """Clean OpenROAD-specific output for better readability.

        Args:
            output: Raw OpenROAD output with escape sequences

        Returns:
            Cleaned output suitable for display
        """
        if not output:
            return output

        # Remove ANSI escape sequences
        cleaned = ANSIDecoder.translate_output(output, mode="remove")

        # Clean up OpenROAD-specific patterns
        # Remove prompt artifacts
        cleaned = re.sub(r"openroad>\s*", "", cleaned)

        # Clean up extra whitespace and line breaks
        cleaned = re.sub(r"\n\s*\n", "\n", cleaned)  # Remove empty lines
        cleaned = cleaned.strip()

        return cleaned

    @staticmethod
    def get_sequence_stats(text: str) -> dict[str, int]:
        """Get statistics about escape sequences in text.

        Args:
            text: Text to analyze

        Returns:
            Dictionary with sequence counts and descriptions
        """
        escape_pattern = r"\x1b\[[0-9;?]*[a-zA-Z]"
        sequences = re.findall(escape_pattern, text)

        stats: dict[str, int] = {}
        for seq in sequences:
            description = ANSIDecoder.decode_escape_sequence(seq)
            key = f"{repr(seq)} ({description})"
            stats[key] = stats.get(key, 0) + 1

        return stats
