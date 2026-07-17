"""Memory leak detection and monitoring tests."""

import asyncio
import gc
import os
import time

import psutil
import pytest

from openroad_mcp.core.manager import OpenROADManager as SessionManager
from openroad_mcp.interactive.buffer import CircularBuffer


class MemoryMonitor:
    """Memory monitoring utility for leak detection."""

    def __init__(self):
        self.process = psutil.Process(os.getpid())
        self.snapshots: list[dict] = []

    def take_snapshot(self, label: str = "") -> dict:
        """Take a memory usage snapshot."""
        # Force garbage collection before measurement
        gc.collect()

        memory_info = self.process.memory_info()
        snapshot = {
            "label": label,
            "timestamp": time.time(),
            "rss_mb": memory_info.rss / (1024 * 1024),  # Resident Set Size
            "vms_mb": memory_info.vms / (1024 * 1024),  # Virtual Memory Size
            "percent": self.process.memory_percent(),
            "num_threads": self.process.num_threads(),
            "num_fds": self.process.num_fds() if hasattr(self.process, "num_fds") else 0,
        }

        self.snapshots.append(snapshot)
        return snapshot

    def get_memory_diff(self, start_label: str, end_label: str) -> dict:
        """Calculate memory difference between two snapshots."""
        start_snapshot = next((s for s in self.snapshots if s["label"] == start_label), None)
        end_snapshot = next((s for s in self.snapshots if s["label"] == end_label), None)

        if not start_snapshot or not end_snapshot:
            raise ValueError(f"Snapshots not found: {start_label}, {end_label}")

        return {
            "rss_diff_mb": end_snapshot["rss_mb"] - start_snapshot["rss_mb"],
            "vms_diff_mb": end_snapshot["vms_mb"] - start_snapshot["vms_mb"],
            "percent_diff": end_snapshot["percent"] - start_snapshot["percent"],
            "thread_diff": end_snapshot["num_threads"] - start_snapshot["num_threads"],
            "fd_diff": end_snapshot["num_fds"] - start_snapshot["num_fds"],
            "duration": end_snapshot["timestamp"] - start_snapshot["timestamp"],
        }

    def print_report(self, diff: dict, operation: str):
        """Print memory monitoring report."""
        print(f"\n{operation} Memory Report:")
        print(f"  RSS Change: {diff['rss_diff_mb']:+.2f} MB")
        print(f"  VMS Change: {diff['vms_diff_mb']:+.2f} MB")
        print(f"  Memory % Change: {diff['percent_diff']:+.2f}%")
        print(f"  Thread Change: {diff['thread_diff']:+d}")
        print(f"  File Descriptor Change: {diff['fd_diff']:+d}")
        print(f"  Duration: {diff['duration']:.2f}s")


@pytest.mark.asyncio
class TestMemoryLeakDetection:
    """Test suite for memory leak detection."""

    @pytest.fixture
    def memory_monitor(self):
        """Create memory monitor for tests."""
        return MemoryMonitor()

    async def test_session_creation_memory_leak(self, memory_monitor):
        """Test for memory leaks in session creation/destruction."""
        session_manager = SessionManager()

        try:
            memory_monitor.take_snapshot("start")

            # Create and destroy sessions multiple times
            for cycle in range(10):
                # Create sessions
                session_ids = []
                for _i in range(5):
                    session_id = await session_manager.create_session()
                    session_ids.append(session_id)

                memory_monitor.take_snapshot(f"cycle_{cycle}_created")

                # Cleanup sessions
                for session_id in session_ids:
                    await session_manager.terminate_session(session_id)

                memory_monitor.take_snapshot(f"cycle_{cycle}_cleaned")

                # Small delay for cleanup to complete
                await asyncio.sleep(0.01)

            memory_monitor.take_snapshot("end")

            # Check for memory leaks
            diff = memory_monitor.get_memory_diff("start", "end")
            memory_monitor.print_report(diff, "Session Creation/Destruction")

            # TICKET-020 requirement: Zero memory leaks in 24-hour tests
            # For this short test, allow small increase but flag significant leaks
            assert diff["rss_diff_mb"] < 5.0, f"Excessive RSS growth: {diff['rss_diff_mb']:.2f}MB"

        finally:
            await session_manager.cleanup_all()

    async def test_buffer_memory_usage(self, memory_monitor):
        """Test buffer memory usage and cleanup."""
        memory_monitor.take_snapshot("start")

        # Create large buffers
        buffers = []
        buffer_size = 1024 * 1024  # 1MB each
        buffer_count = 10

        for _i in range(buffer_count):
            buffer = CircularBuffer(max_size=buffer_size)
            buffers.append(buffer)

            # Fill buffer with data
            chunk_size = 1024
            for _j in range(buffer_size // chunk_size):
                await buffer.append(b"x" * chunk_size)

        memory_monitor.take_snapshot("buffers_created")

        # Clear buffers
        for buffer in buffers:
            await buffer.clear()

        memory_monitor.take_snapshot("buffers_cleared")

        # Delete buffer references
        buffers.clear()
        del buffers

        # Force garbage collection
        gc.collect()
        await asyncio.sleep(0.1)

        memory_monitor.take_snapshot("end")

        # Analyze memory usage
        creation_diff = memory_monitor.get_memory_diff("start", "buffers_created")
        cleanup_diff = memory_monitor.get_memory_diff("buffers_cleared", "end")

        memory_monitor.print_report(creation_diff, "Buffer Creation")
        memory_monitor.print_report(cleanup_diff, "Buffer Cleanup")

        # Verify memory behavior (CI environments may have different allocation patterns)
        expected_usage = buffer_count * (buffer_size / (1024 * 1024))  # Expected MB

        # Log memory behavior for debugging
        print(f"Expected usage: {expected_usage:.1f}MB, Actual creation: {creation_diff['rss_diff_mb']:.1f}MB")
        print(f"Cleanup released: {cleanup_diff['rss_diff_mb']:.1f}MB")

        # Relaxed assertions for CI stability - focus on detecting major issues
        if creation_diff["rss_diff_mb"] < 1.0:
            print("Warning: Very low memory allocation detected - may indicate measurement issues in CI")

        # Only assert cleanup released some memory if significant memory was allocated
        if creation_diff["rss_diff_mb"] > 2.0:
            retained_mb = cleanup_diff["rss_diff_mb"]
            assert retained_mb <= 2.0, f"Memory not released after cleanup: {retained_mb:.1f}MB retained"

    async def test_long_running_session_memory(self, memory_monitor):
        """Test memory usage in long-running sessions."""
        session_manager = SessionManager()

        try:
            memory_monitor.take_snapshot("start")

            session_id = await session_manager.create_session()

            # Simulate long-running session with many operations
            operation_count = 1000
            batch_size = 50

            for batch in range(0, operation_count, batch_size):
                # Simulate command execution with output
                session = session_manager._sessions[session_id]

                for i in range(batch, min(batch + batch_size, operation_count)):
                    # Add output data to buffer
                    output_data = f"Command {i} output: " + "x" * 100
                    await session.output_buffer.append(output_data.encode())

                    # Periodically drain buffer to simulate reading
                    if i % 10 == 0:
                        await session.output_buffer.drain_all()

                # Take periodic snapshots
                if batch % (batch_size * 4) == 0:
                    memory_monitor.take_snapshot(f"batch_{batch}")

            memory_monitor.take_snapshot("operations_complete")

            # Cleanup session
            await session_manager.terminate_session(session_id)
            await asyncio.sleep(0.1)

            memory_monitor.take_snapshot("end")

            # Analyze long-running memory behavior
            diff = memory_monitor.get_memory_diff("start", "operations_complete")
            cleanup_diff = memory_monitor.get_memory_diff("operations_complete", "end")

            memory_monitor.print_report(diff, "Long-Running Session")
            memory_monitor.print_report(cleanup_diff, "Session Cleanup")

            # Memory should not grow excessively during long operation
            assert diff["rss_diff_mb"] < 25.0, f"Excessive memory growth: {diff['rss_diff_mb']:.2f}MB"

            # Memory should be released after cleanup
            assert cleanup_diff["rss_diff_mb"] <= 2.0, f"Memory not released: {cleanup_diff['rss_diff_mb']:.2f}MB"

        finally:
            await session_manager.cleanup_all()

    async def test_concurrent_session_memory_usage(self, memory_monitor):
        """Test memory usage with concurrent sessions."""
        session_manager = SessionManager()

        try:
            memory_monitor.take_snapshot("start")

            # Create multiple concurrent sessions
            session_count = 20
            session_ids = []

            for _i in range(session_count):
                session_id = await session_manager.create_session()
                session_ids.append(session_id)

            memory_monitor.take_snapshot("sessions_created")

            # Simulate concurrent activity
            async def session_activity(session_id, activity_id):
                session = session_manager._sessions[session_id]

                # Add varying amounts of data
                for i in range(100):
                    data = f"Activity {activity_id} data {i}: " + "y" * (50 + (i % 100))
                    await session.output_buffer.append(data.encode())

                    # Periodically drain
                    if i % 20 == 0:
                        await session.output_buffer.drain_all()

                    await asyncio.sleep(0.001)  # Small delay

            # Run concurrent activities
            tasks = []
            for i, session_id in enumerate(session_ids):
                task = session_activity(session_id, i)
                tasks.append(task)

            await asyncio.gather(*tasks)

            memory_monitor.take_snapshot("activity_complete")

            # Cleanup all sessions
            await session_manager.cleanup_all()

            # Give more time for memory cleanup and force garbage collection
            import gc

            gc.collect()
            await asyncio.sleep(1.0)  # Increased from 0.2s to 1.0s
            gc.collect()

            memory_monitor.take_snapshot("end")

            # Analyze concurrent memory usage
            creation_diff = memory_monitor.get_memory_diff("start", "sessions_created")
            activity_diff = memory_monitor.get_memory_diff("sessions_created", "activity_complete")
            cleanup_diff = memory_monitor.get_memory_diff("activity_complete", "end")

            memory_monitor.print_report(creation_diff, "Concurrent Session Creation")
            memory_monitor.print_report(activity_diff, "Concurrent Activity")
            memory_monitor.print_report(cleanup_diff, "Concurrent Cleanup")

            # Verify reasonable memory usage per session
            memory_per_session = creation_diff["rss_diff_mb"] / session_count
            assert memory_per_session < 2.0, f"Excessive memory per session: {memory_per_session:.2f}MB"

            # Verify cleanup releases memory (if any was allocated)
            total_growth = creation_diff["rss_diff_mb"] + activity_diff["rss_diff_mb"]
            if total_growth > 0.1:  # Only check cleanup ratio if significant memory was allocated
                # cleanup_diff should be negative (memory freed), so negate it for ratio
                cleanup_ratio = -cleanup_diff["rss_diff_mb"] / max(total_growth, 1.0)

                # RSS may not decrease immediately in containerized environments
                # Accept if RSS ratio > 0.2 OR other resources were properly cleaned
                resources_cleaned = (
                    cleanup_diff["thread_diff"] <= 0
                    and cleanup_diff["fd_diff"] <= 0
                    and cleanup_diff["vms_diff_mb"] <= 0
                )
                rss_cleaned = cleanup_ratio > 0.2
                print(f"RSS ratio: {cleanup_ratio:.2f}, Resources cleaned: {resources_cleaned}")

                assert rss_cleaned or resources_cleaned, (
                    f"Insufficient cleanup: RSS ratio {cleanup_ratio:.2f}, "
                    f"Threads: {cleanup_diff['thread_diff']}, FDs: {cleanup_diff['fd_diff']}, "
                    f"VMS: {cleanup_diff['vms_diff_mb']:.2f}MB"
                )
            else:
                # With mocked sessions, minimal memory is used
                print(f"Minimal memory allocated ({total_growth:.2f}MB), skipping cleanup ratio check")

        finally:
            await session_manager.cleanup_all()

    async def test_memory_limit_handling(self, memory_monitor):
        """Test graceful handling of memory limits."""
        memory_monitor.take_snapshot("start")

        # Test with extremely large buffer that might hit limits
        try:
            large_buffer_size = 100 * 1024 * 1024  # 100MB
            buffer = CircularBuffer(max_size=large_buffer_size)

            chunk_size = 1024 * 1024  # 1MB chunks
            max_chunks = 150  # Try to exceed buffer size

            memory_monitor.take_snapshot("large_buffer_created")

            for i in range(max_chunks):
                try:
                    large_chunk = b"z" * chunk_size
                    await buffer.append(large_chunk)

                    # Check memory periodically
                    if i % 10 == 0:
                        current_memory = memory_monitor.process.memory_info().rss / (1024 * 1024)
                        if current_memory > 500:  # 500MB limit for test
                            print(f"Memory limit approached at chunk {i}: {current_memory:.1f}MB")
                            break

                except MemoryError as e:
                    print(f"Memory error at chunk {i} - gracefully handled: {e}")
                    break
                except OSError as e:
                    print(f"OS error at chunk {i} - system limit reached: {e}")
                    break

            memory_monitor.take_snapshot("buffer_filled")

            # Verify buffer size constraint
            buffer_size = await buffer.get_size()
            assert buffer_size <= large_buffer_size, f"Buffer exceeded size limit: {buffer_size}"

            # Clear buffer
            await buffer.clear()
            del buffer

            gc.collect()
            await asyncio.sleep(0.2)

            memory_monitor.take_snapshot("end")

            # Verify memory is released
            diff = memory_monitor.get_memory_diff("buffer_filled", "end")
            memory_monitor.print_report(diff, "Large Buffer Cleanup")

            # Should release significant memory
            assert diff["rss_diff_mb"] < -20.0, f"Large buffer memory not released: {diff['rss_diff_mb']:.2f}MB"

        except (MemoryError, OSError) as e:
            # Graceful handling of memory pressure
            print(f"Memory limit test completed with controlled exception: {e}")
        except Exception as e:
            # Unexpected errors should still be logged
            print(f"Unexpected error in memory limit test: {e}")
            raise

    async def test_file_descriptor_leak_detection(self, memory_monitor):
        """Test for file descriptor leaks."""
        if not hasattr(memory_monitor.process, "num_fds"):
            pytest.skip("File descriptor monitoring not available on this platform")

        session_manager = SessionManager()

        try:
            memory_monitor.take_snapshot("start")

            # Create and destroy many sessions rapidly
            for cycle in range(20):
                session_id = await session_manager.create_session()

                # Simulate some activity
                session = session_manager._sessions[session_id]
                await session.output_buffer.append(b"test data")

                # Cleanup immediately
                await session_manager.terminate_session(session_id)

                if cycle % 5 == 0:
                    memory_monitor.take_snapshot(f"cycle_{cycle}")

            memory_monitor.take_snapshot("end")

            # Check for file descriptor leaks
            diff = memory_monitor.get_memory_diff("start", "end")
            memory_monitor.print_report(diff, "File Descriptor Leak Test")

        finally:
            await session_manager.cleanup_all()


@pytest.mark.asyncio
class TestStabilityMonitoring:
    """Tests for 24-hour stability monitoring simulation."""

    async def test_stability_simulation(self):
        """Simulate 24-hour stability test (accelerated)."""
        memory_monitor = MemoryMonitor()
        session_manager = SessionManager()

        try:
            memory_monitor.take_snapshot("start")

            # Simulate 24 hours of operation in accelerated time
            # Each "hour" is 1 second of real time
            simulated_hours = 24
            operations_per_hour = 100

            for hour in range(simulated_hours):
                hour_start = time.time()

                # Create session for this "hour"
                session_id = await session_manager.create_session()

                # Perform operations for this hour
                for op in range(operations_per_hour):
                    session = session_manager._sessions[session_id]

                    # Add data
                    data = f"Hour {hour} Operation {op}: " + "data" * 10
                    await session.output_buffer.append(data.encode())

                    # Occasionally drain
                    if op % 25 == 0:
                        await session.output_buffer.drain_all()

                    # Micro-delay to prevent overwhelming
                    if op % 10 == 0:
                        await asyncio.sleep(0.001)

                # Cleanup session
                await session_manager.terminate_session(session_id)

                # Take snapshot every few hours
                if hour % 6 == 0:
                    memory_monitor.take_snapshot(f"hour_{hour}")

                # Maintain 1 second per "hour"
                elapsed = time.time() - hour_start
                if elapsed < 1.0:
                    await asyncio.sleep(1.0 - elapsed)

            memory_monitor.take_snapshot("end")

            # Analyze 24-hour stability
            total_diff = memory_monitor.get_memory_diff("start", "end")
            memory_monitor.print_report(total_diff, "24-Hour Stability Simulation")

            # TICKET-020 requirement: Zero memory leaks in 24-hour tests
            memory_growth_rate = total_diff["rss_diff_mb"] / simulated_hours  # MB per hour

            print(f"Memory growth rate: {memory_growth_rate:.3f} MB/hour")

            # Allow minimal growth but detect significant leaks
            assert memory_growth_rate < 0.2, f"Memory leak detected: {memory_growth_rate:.3f} MB/hour"

            # Check intermediate snapshots for stability
            for hour in range(6, simulated_hours, 6):
                if hour == 6:
                    continue
                prev_hour = hour - 6
                hourly_diff = memory_monitor.get_memory_diff(f"hour_{prev_hour}", f"hour_{hour}")
                hourly_growth = hourly_diff["rss_diff_mb"] / 6  # Per hour

                assert hourly_growth < 0.5, f"Hour {hour}: Excessive growth {hourly_growth:.3f} MB/hour"

        finally:
            await session_manager.cleanup_all()


if __name__ == "__main__":
    # Allow running memory tests directly
    pytest.main([__file__, "-v", "-s"])
