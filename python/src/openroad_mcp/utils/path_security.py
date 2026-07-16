"""Path security validation utilities to prevent directory traversal attacks."""

from pathlib import Path

from ..core.exceptions import ValidationError


def validate_path_segment(segment: str, segment_name: str) -> None:
    """Validate a path segment to prevent directory traversal attacks.

    Rejects empty strings, '.', '..', path separators, null bytes,
    and glob characters (*, ?, [, ]).
    """
    if not segment:
        raise ValidationError(f"{segment_name} cannot be empty")

    if segment in (".", ".."):
        raise ValidationError(f"{segment_name} cannot be '.' or '..'")

    if "/" in segment or "\\" in segment:
        raise ValidationError(f"{segment_name} cannot contain path separators")

    if "\x00" in segment:
        raise ValidationError(f"{segment_name} cannot contain null bytes")

    if any(char in segment for char in "*?[]"):
        raise ValidationError(f"{segment_name} cannot contain glob characters (* ? [ ])")


def validate_safe_path_containment(target_path: Path, base_path: Path, context: str) -> None:
    """Validate that resolved target path is safely contained within base path.

    Uses Path.resolve() to handle symlinks and relative paths, then verifies
    the resolved target is a child of the base path using relative_to().
    """
    try:
        resolved_target = target_path.resolve()
        resolved_base = base_path.resolve()
    except (OSError, RuntimeError) as e:
        raise ValidationError(f"Failed to resolve {context} path: {e}") from e

    try:
        resolved_target.relative_to(resolved_base)
    except ValueError as e:
        raise ValidationError(f"{context} path {target_path} is not contained within {base_path}") from e
