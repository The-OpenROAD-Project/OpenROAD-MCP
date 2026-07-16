"""Circular buffer for efficient output management with memory bounds."""

import asyncio
import threading
from collections import deque

from ..config.constants import CHUNK_JOIN_THRESHOLD, LARGE_BUFFER_THRESHOLD, SIGNIFICANT_LOG_THRESHOLD
from ..config.settings import settings
from ..utils.logging import get_logger

logger = get_logger("circular_buffer")


class CircularBuffer:
    """Thread-safe circular buffer for output management with automatic eviction.

    Uses dual locking strategy:
    - asyncio.Lock for async operations within the same event loop
    - threading.RLock for synchronous access from any thread

    This ensures true thread safety when accessed from both async and sync contexts.
    """

    def __init__(self, max_size: int = settings.DEFAULT_BUFFER_SIZE) -> None:
        """Initialize circular buffer with maximum size in bytes."""
        self.max_size = max_size
        self.chunks: deque[bytes] = deque()
        self.total_bytes = 0
        self._async_lock = asyncio.Lock()
        self._thread_lock = threading.RLock()
        self._data_available = asyncio.Event()

        if max_size == 0 or max_size > LARGE_BUFFER_THRESHOLD:
            logger.debug(f"Created CircularBuffer with max_size={max_size} bytes")

    async def append(self, data: bytes) -> None:
        """Add data to buffer, evicting oldest chunks if needed."""
        if not data:
            return

        async with self._async_lock:
            if self.max_size == 0:
                return

            # Add new chunk
            self.chunks.append(data)
            self.total_bytes += len(data)

            # Evict oldest chunks if exceeding limit, but keep at least the newest chunk
            evicted_bytes = 0
            while self.total_bytes > self.max_size and len(self.chunks) > 1:
                old_chunk = self.chunks.popleft()
                old_size = len(old_chunk)
                self.total_bytes -= old_size
                evicted_bytes += old_size

            if evicted_bytes > SIGNIFICANT_LOG_THRESHOLD:
                logger.debug(f"Large eviction: {evicted_bytes} bytes, buffer now {self.total_bytes} bytes")

            # Signal data availability only if buffer has data
            if self.chunks:
                self._data_available.set()
            else:
                self._data_available.clear()

    async def drain_all(self) -> list[bytes]:
        """Remove and return all buffered data."""
        async with self._async_lock:
            result = list(self.chunks)
            self.chunks.clear()
            self.total_bytes = 0
            self._data_available.clear()

            if result:
                total_drained = sum(len(chunk) for chunk in result)
                if total_drained > SIGNIFICANT_LOG_THRESHOLD:
                    logger.debug(f"Large drain: {len(result)} chunks ({total_drained} bytes)")

            return result

    async def peek_all(self) -> list[bytes]:
        """Return all buffered data without removing it."""
        async with self._async_lock:
            return list(self.chunks)

    async def get_size(self) -> int:
        """Get current buffer size in bytes."""
        async with self._async_lock:
            return self.total_bytes

    async def get_chunk_count(self) -> int:
        """Get number of chunks in buffer."""
        async with self._async_lock:
            return len(self.chunks)

    async def wait_for_data(self, timeout: float | None = None) -> bool:
        """Wait for new data to be available."""
        try:
            await asyncio.wait_for(self._data_available.wait(), timeout=timeout)
        except TimeoutError:
            return False
        else:
            return True

    async def clear(self) -> None:
        """Clear all buffered data."""
        async with self._async_lock:
            cleared_bytes = self.total_bytes
            self.chunks.clear()
            self.total_bytes = 0
            self._data_available.clear()

            if cleared_bytes > SIGNIFICANT_LOG_THRESHOLD:
                logger.debug(f"Large clear: {cleared_bytes} bytes from buffer")

    @staticmethod
    def to_bytes(chunks: list[bytes]) -> bytes:
        """Convert list of chunks to single bytes object."""
        if not chunks:
            return b""

        # For small number of chunks, direct join is fine
        if len(chunks) < CHUNK_JOIN_THRESHOLD:
            return b"".join(chunks)

        # For large number of chunks, use bytearray to avoid intermediate allocations
        total_size = sum(len(chunk) for chunk in chunks)
        result = bytearray(total_size)
        offset = 0
        for chunk in chunks:
            chunk_len = len(chunk)
            result[offset : offset + chunk_len] = chunk
            offset += chunk_len
        return bytes(result)

    @staticmethod
    def to_string(chunks: list[bytes], encoding: str = "utf-8", errors: str = "replace") -> str:
        """Convert list of chunks to string with error handling."""
        if not chunks:
            return ""

        combined = CircularBuffer.to_bytes(chunks)
        return combined.decode(encoding, errors=errors)

    async def get_stats(self) -> dict[str, int]:
        """Get buffer statistics."""
        async with self._async_lock:
            return {
                "total_bytes": self.total_bytes,
                "chunk_count": len(self.chunks),
                "max_size": self.max_size,
                "utilization_percent": int((self.total_bytes / self.max_size) * 100) if self.max_size > 0 else 0,
            }

    def __len__(self) -> int:
        """Get current buffer size (thread-safe)."""
        with self._thread_lock:
            return self.total_bytes

    def __bool__(self) -> bool:
        """Check if buffer has data (thread-safe)."""
        with self._thread_lock:
            return self.total_bytes > 0
