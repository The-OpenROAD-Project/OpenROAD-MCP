import { describe, it, expect } from "vitest";
import {
  MAX_COMMAND_COMPLETION_WINDOW,
  PROCESS_SHUTDOWN_TIMEOUT,
  FORCE_EXIT_DELAY_SECONDS,
  RECENT_OUTPUT_LINES,
  LAST_COMMANDS_COUNT,
  BYTES_TO_MB,
  UTILIZATION_PERCENTAGE_BASE,
  LARGE_BUFFER_THRESHOLD,
  SIGNIFICANT_LOG_THRESHOLD,
  CHUNK_JOIN_THRESHOLD,
  LARGE_IO_THRESHOLD,
  SLOW_OPERATION_THRESHOLD,
} from "../src/constants.js";

describe("constants", () => {
  it("completion window is 100ms", () => {
    expect(MAX_COMMAND_COMPLETION_WINDOW).toBe(0.1);
  });

  it("process shutdown timeout is 2 seconds", () => {
    expect(PROCESS_SHUTDOWN_TIMEOUT).toBe(2.0);
  });

  it("force exit delay is 2 seconds", () => {
    expect(FORCE_EXIT_DELAY_SECONDS).toBe(2);
  });

  it("recent output lines is 20", () => {
    expect(RECENT_OUTPUT_LINES).toBe(20);
  });

  it("last commands count is 5", () => {
    expect(LAST_COMMANDS_COUNT).toBe(5);
  });

  it("bytes to MB is 1024 * 1024", () => {
    expect(BYTES_TO_MB).toBe(1_048_576);
  });

  it("utilization percentage base is 100", () => {
    expect(UTILIZATION_PERCENTAGE_BASE).toBe(100);
  });

  it("large buffer threshold is 10MB", () => {
    expect(LARGE_BUFFER_THRESHOLD).toBe(10 * 1024 * 1024);
  });

  it("significant log threshold is 100KB", () => {
    expect(SIGNIFICANT_LOG_THRESHOLD).toBe(100_000);
  });

  it("chunk join threshold is 100", () => {
    expect(CHUNK_JOIN_THRESHOLD).toBe(100);
  });

  it("large IO threshold is 10KB", () => {
    expect(LARGE_IO_THRESHOLD).toBe(10_000);
  });

  it("slow operation threshold is 1 second", () => {
    expect(SLOW_OPERATION_THRESHOLD).toBe(1.0);
  });

});
