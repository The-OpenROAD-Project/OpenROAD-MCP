// Command completion timing
export const MAX_COMMAND_COMPLETION_WINDOW = 0.1; // seconds

// Process management
export const PROCESS_SHUTDOWN_TIMEOUT = 2.0;
export const FORCE_EXIT_DELAY_SECONDS = 2;

// Context display limits
export const RECENT_OUTPUT_LINES = 20;
export const LAST_COMMANDS_COUNT = 5;

// Memory conversion
export const BYTES_TO_MB = 1024 * 1024;

// Buffer management
export const UTILIZATION_PERCENTAGE_BASE = 100;
export const LARGE_BUFFER_THRESHOLD = 10 * 1024 * 1024;
export const SIGNIFICANT_LOG_THRESHOLD = 100_000;

// Performance optimization
export const CHUNK_JOIN_THRESHOLD = 100;

// I/O logging thresholds
export const LARGE_IO_THRESHOLD = 10_000;
export const SLOW_OPERATION_THRESHOLD = 1.0;

// Cap on retained per-session command history entries. Bounds memory on
// long-lived sessions; the oldest entries are dropped once the cap is exceeded.
export const MAX_COMMAND_HISTORY = 1000;

