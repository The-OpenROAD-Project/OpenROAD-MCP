export const MAX_COMMAND_COMPLETION_WINDOW = 0.1;

export const PROCESS_SHUTDOWN_TIMEOUT = 2.0;
export const FORCE_EXIT_DELAY_SECONDS = 2;

export const RECENT_OUTPUT_LINES = 20;
export const LAST_COMMANDS_COUNT = 5;

export const BYTES_TO_MB = 1024 * 1024;

export const UTILIZATION_PERCENTAGE_BASE = 100;
export const LARGE_BUFFER_THRESHOLD = 10 * 1024 * 1024;
export const SIGNIFICANT_LOG_THRESHOLD = 100_000;

export const CHUNK_JOIN_THRESHOLD = 100;

export const LARGE_IO_THRESHOLD = 10_000;
export const SLOW_OPERATION_THRESHOLD = 1.0;

// Bounds memory on long-lived sessions; oldest entries are dropped when
// exceeded.
export const MAX_COMMAND_HISTORY = 1000;
