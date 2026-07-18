"""Tests for CircularBuffer implementation."""

import asyncio

import pytest

from openroad_mcp.interactive.buffer import CircularBuffer


@pytest.mark.asyncio
class TestCircularBuffer:
    """Test suite for CircularBuffer."""

    async def test_basic_append_and_drain(self):
        """Test basic append and drain operations."""
        buffer = CircularBuffer(max_size=100)

        # Test empty buffer
        assert await buffer.get_size() == 0
        assert await buffer.get_chunk_count() == 0
        assert not bool(buffer)

        # Add data
        await buffer.append(b"hello")
        assert await buffer.get_size() == 5
        assert await buffer.get_chunk_count() == 1
        assert bool(buffer)

        # Drain data
        chunks = await buffer.drain_all()
        assert len(chunks) == 1
        assert chunks[0] == b"hello"
        assert await buffer.get_size() == 0

    async def test_multiple_chunks(self):
        """Test multiple chunk operations."""
        buffer = CircularBuffer(max_size=100)

        # Add multiple chunks
        chunks_to_add = [b"chunk1", b"chunk2", b"chunk3"]
        for chunk in chunks_to_add:
            await buffer.append(chunk)

        assert await buffer.get_chunk_count() == 3
        assert await buffer.get_size() == sum(len(c) for c in chunks_to_add)

        # Peek without removing
        peeked = await buffer.peek_all()
        assert peeked == chunks_to_add
        assert await buffer.get_size() == sum(len(c) for c in chunks_to_add)  # Still there

        # Drain all
        drained = await buffer.drain_all()
        assert drained == chunks_to_add
        assert await buffer.get_size() == 0

    async def test_size_limit_eviction(self):
        """Test that old data is evicted when size limit is exceeded."""
        buffer = CircularBuffer(max_size=10)  # Small buffer

        # Add data that exceeds limit
        await buffer.append(b"12345")  # 5 bytes
        await buffer.append(b"67890")  # 5 bytes, total 10
        await buffer.append(b"ABCDE")  # 5 bytes, should evict first chunk

        chunks = await buffer.drain_all()
        # First chunk should be evicted
        assert len(chunks) == 2
        assert chunks[0] == b"67890"
        assert chunks[1] == b"ABCDE"

    async def test_large_chunk_eviction(self):
        """Test behavior when single chunk exceeds buffer size."""
        buffer = CircularBuffer(max_size=10)

        # Add small chunks first
        await buffer.append(b"12345")
        await buffer.append(b"67890")
        assert await buffer.get_size() == 10

        # Add large chunk that exceeds entire buffer
        await buffer.append(b"LARGE_CHUNK_EXCEEDS")  # 19 bytes

        chunks = await buffer.drain_all()
        # All previous chunks should be evicted
        assert len(chunks) == 1
        assert chunks[0] == b"LARGE_CHUNK_EXCEEDS"

    async def test_empty_data_handling(self):
        """Test handling of empty data."""
        buffer = CircularBuffer(max_size=100)

        # Adding empty data should not change buffer
        await buffer.append(b"")
        assert await buffer.get_size() == 0
        assert await buffer.get_chunk_count() == 0

        # Add real data then empty
        await buffer.append(b"hello")
        await buffer.append(b"")
        assert await buffer.get_size() == 5
        assert await buffer.get_chunk_count() == 1

    async def test_to_bytes_conversion(self):
        """Test conversion of chunks to bytes."""
        buffer = CircularBuffer(max_size=100)

        chunks = [b"hello", b" ", b"world"]
        for chunk in chunks:
            await buffer.append(chunk)

        drained = await buffer.drain_all()
        combined = buffer.to_bytes(drained)
        assert combined == b"hello world"

        # Test empty chunks
        empty_result = buffer.to_bytes([])
        assert empty_result == b""

    async def test_to_string_conversion(self):
        """Test conversion of chunks to string with encoding."""
        buffer = CircularBuffer(max_size=100)

        # Test normal UTF-8
        chunks = [b"hello", b" ", b"world"]
        for chunk in chunks:
            await buffer.append(chunk)

        drained = await buffer.drain_all()
        text = buffer.to_string(drained)
        assert text == "hello world"

        # Test with invalid UTF-8 (should use replacement character)
        invalid_chunks = [b"hello", b"\xff\xfe", b"world"]
        text_with_errors = buffer.to_string(invalid_chunks, errors="replace")
        assert "hello" in text_with_errors
        assert "world" in text_with_errors

    async def test_wait_for_data(self):
        """Test waiting for data availability."""
        buffer = CircularBuffer(max_size=100)

        # Test timeout when no data
        result = await buffer.wait_for_data(timeout=0.01)
        assert result is False

        # Test immediate return when data available
        await buffer.append(b"test")
        result = await buffer.wait_for_data(timeout=0.01)
        assert result is True

        # Clear and test async notification
        await buffer.clear()

        async def add_data_later():
            await asyncio.sleep(0.01)
            await buffer.append(b"delayed")

        # Start background task to add data
        task = asyncio.create_task(add_data_later())

        # Wait for data (should complete when background task adds data)
        result = await buffer.wait_for_data(timeout=0.1)
        assert result is True

        await task

    async def test_clear_operation(self):
        """Test buffer clearing."""
        buffer = CircularBuffer(max_size=100)

        # Add some data
        await buffer.append(b"test1")
        await buffer.append(b"test2")
        assert await buffer.get_size() > 0

        # Clear and verify
        await buffer.clear()
        assert await buffer.get_size() == 0
        assert await buffer.get_chunk_count() == 0
        assert not bool(buffer)

    async def test_buffer_stats(self):
        """Test buffer statistics."""
        buffer = CircularBuffer(max_size=100)

        # Test empty stats
        stats = await buffer.get_stats()
        assert stats["total_bytes"] == 0
        assert stats["chunk_count"] == 0
        assert stats["max_size"] == 100
        assert stats["utilization_percent"] == 0

        # Add data and check stats
        await buffer.append(b"test_data")  # 9 bytes
        stats = await buffer.get_stats()
        assert stats["total_bytes"] == 9
        assert stats["chunk_count"] == 1
        assert stats["utilization_percent"] == 9  # 9/100 * 100

    async def test_concurrent_access(self):
        """Test concurrent access to buffer."""
        buffer = CircularBuffer(max_size=1000)

        async def writer(data_prefix: str, count: int):
            for i in range(count):
                data = f"{data_prefix}_{i}".encode()
                await buffer.append(data)
                await asyncio.sleep(0.001)  # Small delay

        async def reader():
            all_chunks = []
            for _ in range(10):  # Read 10 times
                chunks = await buffer.drain_all()
                all_chunks.extend(chunks)
                await asyncio.sleep(0.002)  # Small delay
            return all_chunks

        # Start concurrent writers and reader
        tasks = [
            asyncio.create_task(writer("A", 5)),
            asyncio.create_task(writer("B", 5)),
            asyncio.create_task(reader()),
        ]

        results = await asyncio.gather(*tasks)
        collected_chunks = results[2]  # Reader result

        # Verify we got some data (exact order may vary due to concurrency)
        assert len(collected_chunks) > 0
        collected_text = buffer.to_string(collected_chunks)
        assert "A_" in collected_text
        assert "B_" in collected_text

    async def test_max_size_edge_cases(self):
        """Test edge cases with max_size."""
        # Zero size buffer
        buffer = CircularBuffer(max_size=0)
        await buffer.append(b"test")
        assert await buffer.get_size() == 0  # Should immediately evict

        # Very small buffer
        buffer = CircularBuffer(max_size=1)
        await buffer.append(b"ab")  # 2 bytes
        chunks = await buffer.drain_all()
        assert len(chunks) == 1
        assert chunks[0] == b"ab"  # Should keep even if exceeds limit


@pytest.mark.asyncio
class TestCircularBufferAsync:
    """Async test runner for CircularBuffer."""

    async def test_all_buffer_functionality(self):
        """Run all buffer tests."""
        test_instance = TestCircularBuffer()

        await test_instance.test_basic_append_and_drain()
        await test_instance.test_multiple_chunks()
        await test_instance.test_size_limit_eviction()
        await test_instance.test_large_chunk_eviction()
        await test_instance.test_empty_data_handling()
        await test_instance.test_to_bytes_conversion()
        await test_instance.test_to_string_conversion()
        await test_instance.test_wait_for_data()
        await test_instance.test_clear_operation()
        await test_instance.test_buffer_stats()
        await test_instance.test_concurrent_access()
        await test_instance.test_max_size_edge_cases()
