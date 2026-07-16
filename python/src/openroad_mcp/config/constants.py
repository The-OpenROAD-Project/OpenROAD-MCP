"""Fixed constants for OpenROAD MCP server."""

# System exit codes
EXIT_CODE_KEYBOARD_INTERRUPT = 130
EXIT_CODE_ERROR = 1

# Context display limits
RECENT_OUTPUT_LINES = 20
LAST_COMMANDS_COUNT = 5

# Memory conversion
BYTES_TO_MB = 1024 * 1024

# Buffer management
UTILIZATION_PERCENTAGE_BASE = 100

# Command completion timing
MAX_COMMAND_COMPLETION_WINDOW = 0.1

# Process management
PROCESS_SHUTDOWN_TIMEOUT = 2.0
FORCE_EXIT_DELAY_SECONDS = 2

# Buffer logging thresholds
LARGE_BUFFER_THRESHOLD = 10 * 1024 * 1024  # 10MB - threshold for logging buffer creation
SIGNIFICANT_LOG_THRESHOLD = 100000  # 100KB - threshold for logging significant operations

# Performance optimization thresholds
CHUNK_JOIN_THRESHOLD = 100  # Number of chunks before using bytearray optimization

# I/O logging thresholds
LARGE_IO_THRESHOLD = 10000  # 10KB - threshold for logging large I/O operations
SLOW_OPERATION_THRESHOLD = 1.0  # 1 second - threshold for logging slow operations

# JS safe integer max (for memory overflow protection)
JS_SAFE_INTEGER_MAX = 2**53
