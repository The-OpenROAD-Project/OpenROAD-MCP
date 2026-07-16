"""Generate golden wire-format JSON files from the Python result models.

These golden files are the shared serialization contract between the Python
(`python/src/openroad_mcp`) and TypeScript (`typescript/src`) implementations. The
TypeScript suite reads the same files in
`typescript/__tests__/golden/schema_parity.test.ts` and asserts its own
serialization matches, so schema drift (renamed fields, `null` vs missing keys,
enum-vs-string, nesting changes) fails CI before it can reach an AI client.

The values here are fixed and deterministic on purpose — every field is set
explicitly (including the ones that default) so the golden captures the full
wire shape, not just the non-default subset. Live/nondeterministic values
(timestamps, pids, cpu, memory) are stubbed with fixed sentinels; the parity
test compares structure and these stubbed values, not real runtime output.

Run from the repo root:

    make golden

(equivalently: `cd python && uv run python tests/golden/generate_golden.py`)

Regenerate and commit the `python/tests/golden/*.json` files whenever a result
model changes on purpose.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from openroad_mcp.core.models import (
    ImageInfo,
    ImageMetadata,
    InteractiveExecResult,
    InteractiveSessionInfo,
    InteractiveSessionListResult,
    ListImagesResult,
    ReadImageResult,
    SessionHistoryResult,
    SessionInspectionResult,
    SessionMetricsResult,
    SessionTerminationResult,
)
from openroad_mcp.core.models import (
    SessionState,
)

GOLDEN_DIR = Path(__file__).parent

# --- Fixed sentinels (kept identical in the TypeScript parity test) ---------
TS = "2026-01-01T00:00:00"
SID = "sess-0001"


def _detailed_metrics(session_id: str = SID) -> dict:
    """Structure mirrors InteractiveSession.get_detailed_metrics()."""
    return {
        "session_id": session_id,
        "state": "active",
        "is_alive": True,
        "created_at": TS,
        "last_activity": TS,
        "uptime_seconds": 12.5,
        "idle_seconds": 3.25,
        "commands": {
            "total_executed": 4,
            "current_count": 4,
            "history_length": 4,
        },
        "performance": {
            "total_cpu_time": 1.5,
            "peak_memory_mb": 128.0,
            "current_memory_mb": 96.0,
        },
        "buffer": {
            "current_size": 2048,
            "max_size": 131072,
            "utilization_percent": 1.5625,
        },
        "timeout": {
            "configured_seconds": 300.0,
            "is_timed_out": False,
        },
    }


def _manager_metrics() -> dict:
    """Structure mirrors OpenROADManager.session_metrics()."""
    return {
        "manager": {
            "total_sessions": 2,
            "active_sessions": 1,
            "terminated_sessions": 1,
            "max_sessions": 10,
            "utilization_percent": 10.0,
        },
        "aggregate": {
            "total_commands": 4,
            "total_cpu_time": 1.5,
            "total_memory_mb": 96.0,
            "avg_memory_per_session": 96.0,
        },
        "sessions": [_detailed_metrics()],
    }


def _history_entry() -> dict:
    """Structure mirrors the command_history entries in session.py."""
    return {
        "command": "place_design",
        "timestamp": TS,
        "command_number": 1,
        "execution_start": 1767225600.0,
        "execution_time": 0.75,
        "output_length": 42,
    }


def _cases() -> dict[str, object]:
    """Every result model that crosses the MCP wire, success + error variants."""
    active_info = InteractiveSessionInfo(
        session_id=SID,
        created_at=TS,
        is_alive=True,
        command_count=5,
        buffer_size=4096,
        uptime_seconds=12.5,
        state=SessionState.ACTIVE,
    )
    dead_info = InteractiveSessionInfo(
        session_id="sess-0002",
        created_at=TS,
        is_alive=False,
        command_count=0,
        buffer_size=0,
        uptime_seconds=None,
        state=None,
        error="Session failed to start",
    )

    return {
        # query / exec tools
        "interactive_exec_result_success": InteractiveExecResult(
            output="OpenROAD v2.0",
            session_id=SID,
            timestamp=TS,
            execution_time=1.5,
            command_count=3,
            buffer_size=2048,
        ),
        "interactive_exec_result_error": InteractiveExecResult(
            output="",
            session_id=SID,
            timestamp=TS,
            execution_time=0.0,
            command_count=0,
            buffer_size=0,
            error="CommandBlocked: 'exit'",
        ),
        # create_interactive_session
        "interactive_session_info_success": active_info,
        "interactive_session_info_error": dead_info,
        # list_interactive_sessions
        "interactive_session_list": InteractiveSessionListResult(
            sessions=[active_info, dead_info],
            total_count=2,
            active_count=1,
        ),
        # terminate_interactive_session
        "session_termination": SessionTerminationResult(
            session_id=SID,
            terminated=True,
            was_alive=True,
            force=False,
        ),
        # inspect_interactive_session
        "session_inspection": SessionInspectionResult(
            session_id=SID,
            metrics=_detailed_metrics(),
        ),
        # get_session_history
        "session_history": SessionHistoryResult(
            session_id=SID,
            history=[_history_entry()],
            total_commands=1,
            limit=10,
            search="place",
        ),
        # get_session_metrics
        "session_metrics": SessionMetricsResult(metrics=_manager_metrics()),
        # list_report_images
        "list_images": ListImagesResult(
            run_path="/reports/nangate45/gcd/base",
            total_images=2,
            images_by_stage={
                "floorplan": [
                    ImageInfo(
                        filename="floorplan.webp",
                        path="/reports/nangate45/gcd/base/floorplan.webp",
                        size_bytes=15000,
                        modified_time=TS,
                        type="floorplan",
                    ),
                ],
                "route": [
                    ImageInfo(
                        filename="route.webp",
                        path="/reports/nangate45/gcd/base/route.webp",
                        size_bytes=22000,
                        modified_time=TS,
                        type="route",
                    ),
                ],
            },
        ),
        "list_images_empty": ListImagesResult(message="No images found"),
        # read_report_image
        "read_image": ReadImageResult(
            image_data="aGVsbG8=",
            metadata=ImageMetadata(
                filename="floorplan.webp",
                format="webp",
                size_bytes=15000,
                width=1024,
                height=768,
                modified_time=TS,
                stage="floorplan",
                type="floorplan",
                compression_applied=True,
                original_size_bytes=48000,
                original_width=2048,
                original_height=1536,
                compression_ratio=0.3125,
            ),
        ),
        "read_image_error": ReadImageResult(error="Image not found: foo.png"),
    }


def _canonical_type(prop: dict) -> str | None:
    """Reduce a JSON-schema property to its base type name.

    Optional params render differently across implementations — Pydantic emits
    `anyOf: [{type}, {type: null}]`, zod emits a bare `{type}` — so we collapse
    both to the single non-null base type. Extra keys (min/max/items/default)
    are incidental and dropped.
    """
    if "type" in prop:
        return prop["type"]
    if "anyOf" in prop:
        for branch in prop["anyOf"]:
            if branch.get("type") != "null":
                return branch.get("type")
    return None


def _canonical_tool(input_schema: dict, annotations: object) -> dict:
    props = input_schema.get("properties", {})
    required = set(input_schema.get("required", []))
    params = {
        name: {"type": _canonical_type(prop), "required": name in required}
        for name, prop in props.items()
    }
    hints = None
    if annotations is not None:
        hints = {
            "readOnlyHint": annotations.readOnlyHint,
            "destructiveHint": annotations.destructiveHint,
            "idempotentHint": annotations.idempotentHint,
            "openWorldHint": annotations.openWorldHint,
        }
    return {"params": params, "annotations": hints}


async def _tool_manifest() -> dict:
    """Canonical name -> {params, annotations} manifest for all 10 tools.

    The TypeScript suite normalizes its own MCP tools/list output the same way
    and asserts an exact match, so a renamed param, a flipped required flag, or
    a changed annotation hint fails CI.
    """
    from openroad_mcp.server import mcp

    tools = await mcp.list_tools()
    manifest = {}
    for tool in tools:
        mcp_tool = tool.to_mcp_tool()
        manifest[mcp_tool.name] = _canonical_tool(mcp_tool.inputSchema, mcp_tool.annotations)
    return dict(sorted(manifest.items()))


def main() -> None:
    for name, model in _cases().items():
        wire = model.model_dump() if hasattr(model, "model_dump") else model
        path = GOLDEN_DIR / f"{name}.json"
        path.write_text(json.dumps(wire, indent=2) + "\n")
        print(f"wrote {path.relative_to(GOLDEN_DIR.parent.parent)}")

    manifest = asyncio.run(_tool_manifest())
    manifest_path = GOLDEN_DIR / "tool_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {manifest_path.relative_to(GOLDEN_DIR.parent.parent)}")


if __name__ == "__main__":
    main()
