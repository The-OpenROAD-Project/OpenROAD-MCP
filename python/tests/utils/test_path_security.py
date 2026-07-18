"""Tests for path security validation utilities."""

import pytest

from openroad_mcp.core.exceptions import ValidationError
from openroad_mcp.utils.path_security import (
    validate_path_segment,
    validate_safe_path_containment,
)


class TestValidatePathSegment:
    """Test suite for validate_path_segment function."""

    def test_valid_segment(self):
        """Test valid path segment passes."""
        validate_path_segment("valid_segment", "test_segment")
        validate_path_segment("run-123", "test_segment")
        validate_path_segment("run_456", "test_segment")

    def test_empty_segment(self):
        """Test empty segment is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot be empty"):
            validate_path_segment("", "test_segment")

    def test_dot_segment(self):
        """Test '.' is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot be '.' or '..'"):
            validate_path_segment(".", "test_segment")

    def test_dot_dot_segment(self):
        """Test '..' is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot be '.' or '..'"):
            validate_path_segment("..", "test_segment")

    def test_forward_slash_rejected(self):
        """Test forward slash is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain path separators"):
            validate_path_segment("../evil", "test_segment")

    def test_backslash_rejected(self):
        """Test backslash is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain path separators"):
            validate_path_segment("evil\\path", "test_segment")

    def test_null_byte_rejected(self):
        """Test null byte is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain null bytes"):
            validate_path_segment("evil\x00byte", "test_segment")

    def test_glob_star_rejected(self):
        """Test glob '*' is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain glob characters"):
            validate_path_segment("*.webp", "test_segment")

    def test_glob_question_rejected(self):
        """Test glob '?' is rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain glob characters"):
            validate_path_segment("file?.webp", "test_segment")

    def test_glob_brackets_rejected(self):
        """Test glob brackets are rejected."""
        with pytest.raises(ValidationError, match="test_segment cannot contain glob characters"):
            validate_path_segment("file[0-9].webp", "test_segment")


class TestValidateSafePathContainment:
    """Test suite for validate_safe_path_containment function."""

    def test_valid_contained_path(self, tmp_path):
        """Test valid contained path passes."""
        base = tmp_path / "base"
        base.mkdir()
        target = base / "subdir"
        target.mkdir()

        validate_safe_path_containment(target, base, "test")

    def test_escaped_path_rejected(self, tmp_path):
        """Test path that escapes base is rejected."""
        base = tmp_path / "base"
        base.mkdir()
        target = tmp_path / "outside"
        target.mkdir()

        with pytest.raises(ValidationError, match="test path .* is not contained within"):
            validate_safe_path_containment(target, base, "test")

    def test_symlink_escape_rejected(self, tmp_path):
        """Test symlink that escapes base is rejected."""
        base = tmp_path / "base"
        base.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret")

        symlink = base / "evil_link"
        symlink.symlink_to(outside)

        with pytest.raises(ValidationError, match="test path .* is not contained within"):
            validate_safe_path_containment(symlink, base, "test")

    def test_relative_traversal_rejected(self, tmp_path):
        """Test relative path traversal is rejected."""
        base = tmp_path / "base"
        base.mkdir()
        target = base / ".." / ".." / "etc" / "passwd"

        with pytest.raises(ValidationError, match="test path .* is not contained within"):
            validate_safe_path_containment(target, base, "test")

    def test_nested_valid_path(self, tmp_path):
        """Test deeply nested valid path passes."""
        base = tmp_path / "base"
        base.mkdir()
        nested = base / "level1" / "level2" / "level3"
        nested.mkdir(parents=True)

        validate_safe_path_containment(nested, base, "test")

    def test_nonexistent_path_with_traversal(self, tmp_path):
        """Test nonexistent path with traversal is rejected."""
        base = tmp_path / "base"
        base.mkdir()
        target = base / ".." / "etc" / "passwd"

        with pytest.raises(ValidationError, match="test path .* is not contained within"):
            validate_safe_path_containment(target, base, "test")


class TestPathTraversalAttackVectors:
    """Test suite for common path traversal attack vectors."""

    @pytest.mark.parametrize(
        "malicious_segment",
        [
            "..",
            "../..",
            "..\\",
            "*",
            "?",
            "[test]",
            "dir/subdir",
            "\x00",
        ],
    )
    def test_malicious_path_segment(self, malicious_segment):
        """Test various malicious path segments are rejected."""
        with pytest.raises(ValidationError):
            validate_path_segment(malicious_segment, "test_segment")
