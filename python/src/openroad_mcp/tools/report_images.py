"""Report image reading tools for OpenROAD MCP server."""

import base64
import io
from datetime import datetime
from pathlib import Path

from PIL import Image

from ..config.settings import settings
from ..core.exceptions import ValidationError
from ..core.models import ImageInfo, ImageMetadata, ListImagesResult, ReadImageResult
from ..utils.logging import get_logger
from ..utils.path_security import validate_path_segment, validate_safe_path_containment
from .base import BaseTool

logger = get_logger("report_images")

MAX_BASE64_SIZE_KB = 15
MAX_IMAGE_SIZE_MB = 50

IMAGE_TYPE_MAPPING = {
    "cts_clk": "clock_visualization",
    "cts_clk_layout": "clock_layout",
    "cts_core_clock": "core_clock_visualization",
    "cts_core_clock_layout": "core_clock_layout",
    "final_all": "complete_design",
    "final_clocks": "clock_routing",
    "final_congestion": "congestion_heatmap",
    "final_ir_drop": "ir_drop_analysis",
    "final_placement": "cell_placement",
    "final_resizer": "resizer_results",
    "final_routing": "routing_visualization",
}


def classify_image_type(filename: str) -> tuple[str, str]:
    """Classify image by stage and type based on filename."""
    base_name = filename.rsplit(".", 1)[0]

    stage = base_name.split("_")[0] if "_" in base_name else "unknown"

    image_type = IMAGE_TYPE_MAPPING.get(base_name, "unknown")

    return stage, image_type


def _resolve_run_path(platform: str, design: str, run_slug: str) -> tuple[Path, Path]:
    """Validate inputs and return (reports_base, run_path)."""
    validate_platform_design(platform, design)
    validate_path_segment(run_slug, "run_slug")
    reports_base = settings.flow_path / "reports" / platform / design
    run_path = reports_base / run_slug
    validate_safe_path_containment(run_path, reports_base, "run directory")
    return reports_base, run_path


def validate_platform_design(platform: str, design: str) -> None:
    """Validate platform and design exist in ORFS structure."""
    if platform not in settings.platforms:
        raise ValidationError(
            f"Platform '{platform}' not found. Available: {', '.join(sorted(settings.platforms)) or 'none'}"
        )

    if design not in settings.designs(platform):
        raise ValidationError(
            f"Design '{design}' not found for platform '{platform}'. "
            f"Available: {', '.join(sorted(settings.designs(platform))) or 'none'}"
        )


def load_and_compress_image(
    image_path: Path, max_size_kb: int = MAX_BASE64_SIZE_KB
) -> tuple[bytes, bool, int, int, int | None, int | None, int | None, int | None]:
    """Load image and compress if base64-encoded size would exceed threshold.

    Compression strategy:
    - Threshold: 15KB base64 (~11KB binary) balances quality vs MCP message size
    - Resampling: LANCZOS provides best quality during downscaling
    - Format: WEBP with quality=85 for good compression with minimal artifacts
    - Minimum dimensions: 256px preserves readability of chip layout visualizations
    """
    original_size = image_path.stat().st_size
    estimated_b64_size = (original_size * 4) // 3

    try:
        with Image.open(image_path) as img:
            original_width, original_height = img.size

            if estimated_b64_size <= max_size_kb * 1024:
                with open(image_path, "rb") as f:
                    return (
                        f.read(),
                        False,
                        original_size,
                        original_size,
                        original_width,
                        original_height,
                        original_width,
                        original_height,
                    )

            logger.info(f"Image {image_path.name} ({original_size} bytes) exceeds threshold, compressing...")

            target_bytes = max_size_kb * 1024 * 3 // 4
            scale = (target_bytes / original_size) ** 0.5

            new_width = max(int(original_width * scale), 256)
            new_height = max(int(original_height * scale), 256)

            logger.info(f"Resizing from {original_width}x{original_height} to {new_width}x{new_height}")

            resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

            buffer = io.BytesIO()
            resized.save(buffer, format="WEBP", quality=85)
            compressed_bytes = buffer.getvalue()

            logger.info(f"Compressed from {original_size} to {len(compressed_bytes)} bytes")

            return (
                compressed_bytes,
                True,
                original_size,
                len(compressed_bytes),
                original_width,
                original_height,
                new_width,
                new_height,
            )
    except Exception as e:
        logger.warning(f"Failed to process image with PIL: {e}. Reading as raw bytes.")
        with open(image_path, "rb") as f:
            return f.read(), False, original_size, original_size, None, None, None, None


class ListReportImagesTool(BaseTool):
    """Tool for listing available report images from ORFS runs."""

    async def execute(self, platform: str, design: str, run_slug: str, stage: str = "all") -> str:
        """List available report images for a specific run."""
        try:
            reports_base, run_path = _resolve_run_path(platform, design, run_slug)

            if not run_path.exists():
                logger.warning(f"Run slug not found: {run_slug}")
                available_runs = [d.name for d in reports_base.iterdir() if d.is_dir()]
                return self._format_result(
                    ListImagesResult(
                        error="RunSlugNotFound",
                        message=f"Run slug '{run_slug}' not found in {reports_base}. "
                        f"Available run slugs: {', '.join(sorted(available_runs)[:5]) if available_runs else 'none'}",
                    )
                )

            webp_files = list(run_path.rglob("*.webp"))

            if not webp_files:
                logger.warning(f"No webp images found in {run_path}")
                return self._format_result(
                    ListImagesResult(
                        run_path=str(run_path),
                        total_images=0,
                        images_by_stage={},
                        message=f"No webp images found in {run_path}",
                    )
                )

            images_by_stage: dict[str, list[ImageInfo]] = {}

            for webp_file in webp_files:
                file_stage, file_type = classify_image_type(webp_file.name)

                if stage != "all" and file_stage != stage:
                    continue

                stat = webp_file.stat()

                image_info = ImageInfo(
                    filename=webp_file.name,
                    path=str(webp_file),
                    size_bytes=stat.st_size,
                    modified_time=datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    type=file_type,
                )

                if file_stage not in images_by_stage:
                    images_by_stage[file_stage] = []
                images_by_stage[file_stage].append(image_info)

            for stage_images in images_by_stage.values():
                stage_images.sort(key=lambda x: x.filename)

            total_images = sum(len(images) for images in images_by_stage.values())

            result = ListImagesResult(
                run_path=str(run_path),
                total_images=total_images,
                images_by_stage=images_by_stage,
            )

            return self._format_result(result)
        except ValidationError as e:
            return self._format_result(ListImagesResult(error=type(e).__name__, message=str(e)))
        except Exception as e:
            logger.exception(f"Failed to list report images: {e}")
            return self._format_result(
                ListImagesResult(
                    error="UnexpectedError",
                    message=f"Failed to list report images: {str(e)}",
                )
            )


class ReadReportImageTool(BaseTool):
    """Tool for reading report images and returning base64-encoded data with metadata."""

    async def execute(self, platform: str, design: str, run_slug: str, image_name: str) -> str:
        """Read a specific report image and return base64-encoded data."""
        try:
            reports_base, run_path = _resolve_run_path(platform, design, run_slug)
            validate_path_segment(image_name, "image_name")

            if not image_name.endswith(".webp"):
                raise ValidationError(f"Image filename must have .webp extension: {image_name}")

            if not run_path.exists():
                logger.warning(f"Run slug not found: {run_slug}")
                return self._format_result(
                    ReadImageResult(
                        error="RunSlugNotFound",
                        message=f"Run slug '{run_slug}' not found in {reports_base}. "
                        "Use list_report_images to see available runs.",
                    )
                )

            image_path = run_path / image_name

            validate_safe_path_containment(image_path, run_path, "image file")

            if not image_path.exists():
                logger.warning(f"Image not found: {image_name}")
                available_images = [f.name for f in run_path.rglob("*.webp")]
                return self._format_result(
                    ReadImageResult(
                        error="ImageNotFound",
                        message=f"Image '{image_name}' not found in {run_path}. "
                        f"Available images: {', '.join(available_images) if available_images else 'none'}. "
                        "Use list_report_images to see all available images.",
                    )
                )

            if not image_path.is_file():
                logger.warning(f"Image path is not a file: {image_path}")
                return self._format_result(
                    ReadImageResult(
                        error="InvalidImagePath",
                        message=f"Image path {image_name} is not a regular file.",
                    )
                )
            file_size_mb = image_path.stat().st_size / (1024 * 1024)
            if file_size_mb > MAX_IMAGE_SIZE_MB:
                logger.warning(f"Image too large: {file_size_mb:.2f}MB > {MAX_IMAGE_SIZE_MB}MB")
                return self._format_result(
                    ReadImageResult(
                        error="FileTooLarge",
                        message=f"Image size ({file_size_mb:.2f}MB) exceeds maximum "
                        f"allowed size ({MAX_IMAGE_SIZE_MB}MB).",
                    )
                )

            (
                image_bytes,
                compression_applied,
                original_size,
                compressed_size,
                original_width,
                original_height,
                width,
                height,
            ) = load_and_compress_image(image_path)

            image_data_b64 = base64.b64encode(image_bytes).decode("utf-8")

            stat = image_path.stat()
            file_stage, file_type = classify_image_type(image_name)

            compression_ratio = compressed_size / original_size if compression_applied else None

            metadata = ImageMetadata(
                filename=image_name,
                format="webp",
                size_bytes=compressed_size,
                width=width,
                height=height,
                modified_time=datetime.fromtimestamp(stat.st_mtime).isoformat(),
                stage=file_stage,
                type=file_type,
                compression_applied=compression_applied,
                original_size_bytes=original_size if compression_applied else None,
                original_width=original_width if compression_applied else None,
                original_height=original_height if compression_applied else None,
                compression_ratio=compression_ratio,
            )

            result = ReadImageResult(
                image_data=image_data_b64,
                metadata=metadata,
            )

            return self._format_result(result)
        except ValidationError as e:
            return self._format_result(ReadImageResult(error=type(e).__name__, message=str(e)))
        except Exception as e:
            logger.exception(f"Failed to read report image: {e}")
            return self._format_result(
                ReadImageResult(
                    error="UnexpectedError",
                    message=f"Failed to read report image: {str(e)}",
                )
            )
