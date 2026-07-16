"""Test unicode decoding fixes."""

from openroad_mcp.core.manager import OpenROADManager


class TestUnicodeDecoding:
    """Test unicode decoding in OpenROAD manager."""

    def test_safe_decode_valid_utf8(self):
        """Test safe_decode with valid UTF-8 data."""
        valid_data = b"hello world"
        result = OpenROADManager.safe_decode(valid_data)
        assert result == "hello world"

    def test_safe_decode_invalid_utf8(self):
        """Test safe_decode with invalid UTF-8 data."""
        # Invalid UTF-8 bytes
        invalid_data = b"hello \xff\xfe world"
        result = OpenROADManager.safe_decode(invalid_data)

        # Should replace invalid bytes with Unicode replacement character
        assert "hello" in result
        assert "world" in result
        assert "\ufffd" in result  # Unicode replacement character

    def test_safe_decode_mixed_content(self):
        """Test safe_decode with mixed valid/invalid content."""
        mixed_data = b"Valid: \xc3\xa9 Invalid: \xff\xfe More valid"
        result = OpenROADManager.safe_decode(mixed_data)

        # Should preserve valid UTF-8 and replace invalid bytes
        assert "Valid:" in result
        assert "é" in result  # Valid UTF-8 character
        assert "More valid" in result
        assert "\ufffd" in result  # Replacement for invalid bytes

    def test_safe_decode_empty_data(self):
        """Test safe_decode with empty data."""
        empty_data = b""
        result = OpenROADManager.safe_decode(empty_data)
        assert result == ""

    def test_safe_decode_only_invalid(self):
        """Test safe_decode with only invalid bytes."""
        invalid_data = b"\xff\xfe\xfd"
        result = OpenROADManager.safe_decode(invalid_data)

        # Should be only replacement characters
        assert all(c == "\ufffd" for c in result)
        assert len(result) == 3

    def test_safe_decode_custom_encoding(self):
        """Test safe_decode with custom encoding."""
        # Latin-1 encoded data
        latin1_data = "café".encode("latin-1")

        # Should work with UTF-8 (with replacement for incompatible chars)
        result_utf8 = OpenROADManager.safe_decode(latin1_data)
        assert "caf" in result_utf8

        # Should work perfectly with latin-1
        result_latin1 = OpenROADManager.safe_decode(latin1_data, encoding="latin-1")
        assert result_latin1 == "café"

    def test_safe_decode_custom_error_handling(self):
        """Test safe_decode with custom error handling."""
        invalid_data = b"hello \xff\xfe world"

        # Test with ignore errors
        result_ignore = OpenROADManager.safe_decode(invalid_data, errors="ignore")
        assert result_ignore == "hello  world"  # Invalid bytes are ignored

        # Test with replace errors (default)
        result_replace = OpenROADManager.safe_decode(invalid_data, errors="replace")
        assert "hello" in result_replace
        assert "world" in result_replace
        assert "\ufffd" in result_replace
