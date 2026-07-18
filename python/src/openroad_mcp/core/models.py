"""Data models for OpenROAD MCP server."""

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field
from pydantic.functional_serializers import PlainSerializer


class ProcessState(Enum):
    """OpenROAD process states."""

    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    ERROR = "error"


class SessionState(Enum):
    """Interactive session states."""

    CREATING = "creating"
    ACTIVE = "active"
    TERMINATED = "terminated"
    ERROR = "error"


# Type aliases: serialize enum values to strings
SerializableProcessState = Annotated[ProcessState, PlainSerializer(lambda x: x.value if x else None, return_type=str)]
SerializableSessionState = Annotated[SessionState, PlainSerializer(lambda x: x.value if x else None, return_type=str)]


class BaseResult(BaseModel):
    """Base class for all MCP tool result objects with standardized error handling."""

    error: str | None = None


class CommandRecord(BaseModel):
    """Record of a command execution."""

    command: str
    timestamp: str
    id: int


class CommandResult(BaseResult):
    """Result of a command execution."""

    status: str
    message: str | None = None
    stdout: list[str] = Field(default_factory=list)
    stderr: list[str] = Field(default_factory=list)
    execution_time: float | None = None
    pid: int | None = None
    command: str | None = None


class ProcessStatus(BaseResult):
    """OpenROAD process status information."""

    state: SerializableProcessState
    pid: int | None = None
    uptime: float | None = None
    command_count: int = 0
    buffer_stdout_size: int = 0
    buffer_stderr_size: int = 0
    message: str | None = None


class ProcessRestartResult(BaseResult):
    """Result from process restart operation."""

    status: str
    message: str | None = None


class CommandHistoryResult(BaseResult):
    """Result from command history retrieval."""

    total_commands: int
    commands: list[dict] = Field(default_factory=list)


class ContextInfo(BaseResult):
    """Context information for the current session."""

    status: ProcessStatus
    recent_stdout: list[str] = Field(default_factory=list)
    recent_stderr: list[str] = Field(default_factory=list)
    command_count: int = 0
    last_commands: list[CommandRecord] = Field(default_factory=list)


class InteractiveSessionInfo(BaseResult):
    """Information about an interactive session for MCP tools."""

    session_id: str
    created_at: str
    is_alive: bool
    command_count: int
    buffer_size: int
    uptime_seconds: float | None = None
    state: SerializableSessionState | None = None


class InteractiveExecResult(BaseResult):
    """Result from interactive command execution for MCP tools."""

    output: str
    session_id: str | None
    timestamp: str
    execution_time: float
    command_count: int = 0
    buffer_size: int = 0


class InteractiveSessionListResult(BaseResult):
    """Result containing list of interactive sessions."""

    sessions: list[InteractiveSessionInfo] = Field(default_factory=list)
    total_count: int = 0
    active_count: int = 0


class SessionTerminationResult(BaseResult):
    """Result from session termination operation."""

    session_id: str
    terminated: bool
    was_alive: bool = False
    force: bool = False


class SessionInspectionResult(BaseResult):
    """Result from session inspection operation."""

    session_id: str
    metrics: dict | None = None


class SessionHistoryResult(BaseResult):
    """Result from session history retrieval."""

    session_id: str
    history: list[dict] = Field(default_factory=list)
    total_commands: int = 0
    limit: int | None = None
    search: str | None = None


class SessionMetricsResult(BaseResult):
    """Result from session metrics retrieval."""

    metrics: dict | None = None


class ImageInfo(BaseModel):
    """Information about a single report image."""

    filename: str
    path: str
    size_bytes: int
    modified_time: str
    type: str


class ListImagesResult(BaseResult):
    """Result from listing report images."""

    run_path: str | None = None
    total_images: int | None = None
    images_by_stage: dict[str, list[ImageInfo]] | None = None
    message: str | None = None


class ImageMetadata(BaseModel):
    """Metadata for a report image."""

    filename: str
    format: str
    size_bytes: int
    width: int | None = None
    height: int | None = None
    modified_time: str
    stage: str
    type: str
    compression_applied: bool = False
    original_size_bytes: int | None = None
    original_width: int | None = None
    original_height: int | None = None
    compression_ratio: float | None = None


class ReadImageResult(BaseResult):
    """Result from reading a report image."""

    image_data: str | None = None
    metadata: ImageMetadata | None = None
    message: str | None = None
