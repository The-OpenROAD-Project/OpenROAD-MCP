import { describe, it, expect } from "vitest";
import { CircularBuffer } from "../../src/interactive/buffer.js";

describe("CircularBuffer", () => {
  describe("basic operations", () => {
    it("starts empty", () => {
      const buf = new CircularBuffer(100);
      expect(buf.size).toBe(0);
      expect(buf.chunkCount).toBe(0);
    });

    it("appends and drains a single chunk", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("hello");
      expect(buf.size).toBe(5);
      expect(buf.chunkCount).toBe(1);

      const chunks = await buf.drainAll();
      expect(chunks).toEqual(["hello"]);
      expect(buf.size).toBe(0);
    });

    it("handles multiple chunks with peek and drain", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("chunk1");
      await buf.append("chunk2");
      await buf.append("chunk3");

      expect(buf.chunkCount).toBe(3);
      expect(buf.size).toBe(18);

      const peeked = await buf.peekAll();
      expect(peeked).toEqual(["chunk1", "chunk2", "chunk3"]);
      expect(buf.size).toBe(18);

      const drained = await buf.drainAll();
      expect(drained).toEqual(["chunk1", "chunk2", "chunk3"]);
      expect(buf.size).toBe(0);
    });
  });

  describe("eviction", () => {
    it("evicts oldest chunks when limit is exceeded", async () => {
      const buf = new CircularBuffer(10);
      await buf.append("12345");
      await buf.append("67890");
      await buf.append("ABCDE");

      const chunks = await buf.drainAll();
      expect(chunks).toEqual(["67890", "ABCDE"]);
    });

    it("truncates a single oversized chunk to the last maxSize characters", async () => {
      const buf = new CircularBuffer(10);
      await buf.append("12345");
      await buf.append("67890");
      await buf.append("LARGE_CHUNK_EXCEEDS");

      const chunks = await buf.drainAll();
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("NK_EXCEEDS");
      expect(buf.size).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("ignores empty string appends", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("");
      expect(buf.size).toBe(0);
      expect(buf.chunkCount).toBe(0);

      await buf.append("hello");
      await buf.append("");
      expect(buf.size).toBe(5);
      expect(buf.chunkCount).toBe(1);
    });

    it("zero-size buffer discards all data", async () => {
      const buf = new CircularBuffer(0);
      await buf.append("test");
      expect(buf.size).toBe(0);
    });

    it("very small buffer truncates oversized chunk to maxSize", async () => {
      const buf = new CircularBuffer(1);
      await buf.append("ab");
      const chunks = await buf.drainAll();
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("b");
      expect(buf.size).toBe(0);
    });
  });

  describe("toText", () => {
    it("joins chunks into a single string", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("hello");
      await buf.append(" ");
      await buf.append("world");

      const chunks = await buf.drainAll();
      expect(buf.toText(chunks)).toBe("hello world");
    });

    it("returns empty string for empty array", () => {
      const buf = new CircularBuffer(100);
      expect(buf.toText([])).toBe("");
    });
  });

  describe("waitForData", () => {
    it("returns false when no data arrives within timeout", async () => {
      const buf = new CircularBuffer(100);
      const result = await buf.waitForData(10);
      expect(result).toBe(false);
    });

    it("returns true immediately when data is already present", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("test");
      const result = await buf.waitForData(10);
      expect(result).toBe(true);
    });

    it("wakes up when data arrives asynchronously", async () => {
      const buf = new CircularBuffer(100);
      await buf.clear();

      const addTask = (async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        await buf.append("delayed");
      })();

      const result = await buf.waitForData(100);
      expect(result).toBe(true);
      await addTask;
    });

    it("returns true when append fires between fast-path check and runExclusive callback (re-check prevents missed wakeup)", async () => {
      const buf = new CircularBuffer(100);

      // Start waitForData (fast-path sees _dataAvailable = false and enters the Promise)
      const waiter = buf.waitForData(5000);

      // append() fires before runExclusive's callback can push wakeUp into
      // _resolvers. Without the re-check inside runExclusive, wakeUp would
      // land in _resolvers after append() already drained an empty list, and
      // the caller would wait the full 5-second timeout.
      await buf.append("raced data");

      const result = await waiter;
      expect(result).toBe(true);
    });
  });

  describe("clear", () => {
    it("removes all data and resets size", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("test1");
      await buf.append("test2");

      await buf.clear();
      expect(buf.size).toBe(0);
      expect(buf.chunkCount).toBe(0);
    });

    it("wakes pending waitForData() immediately with false so callers do not hang", async () => {
      const buf = new CircularBuffer(100);

      // Large timeout: clear() must unblock waitForData before it fires.
      const waiter = buf.waitForData(5000);
      await buf.clear();

      const result = await waiter;
      expect(result).toBe(false);
    });
  });

  describe("getStats", () => {
    it("returns zero stats on empty buffer", async () => {
      const buf = new CircularBuffer(100);
      const stats = await buf.getStats();
      expect(stats.totalChars).toBe(0);
      expect(stats.chunkCount).toBe(0);
      expect(stats.maxSize).toBe(100);
      expect(stats.utilizationPercent).toBe(0);
    });

    it("reflects data added to the buffer", async () => {
      const buf = new CircularBuffer(100);
      await buf.append("test_data");
      const stats = await buf.getStats();
      expect(stats.totalChars).toBe(9);
      expect(stats.chunkCount).toBe(1);
      expect(stats.utilizationPercent).toBe(9);
    });
  });

  describe("concurrent access", () => {
    it("handles concurrent writers and a reader", async () => {
      const buf = new CircularBuffer(1000);

      const writer = async (prefix: string, count: number) => {
        for (let i = 0; i < count; i++) {
          await buf.append(`${prefix}_${i}`);
          await new Promise<void>((r) => setTimeout(r, 1));
        }
      };

      const reader = async () => {
        const all: string[] = [];
        for (let i = 0; i < 10; i++) {
          const chunks = await buf.drainAll();
          all.push(...chunks);
          await new Promise<void>((r) => setTimeout(r, 2));
        }
        return all;
      };

      const [, , collected] = await Promise.all([writer("A", 5), writer("B", 5), reader()]);

      expect(collected.length).toBeGreaterThan(0);
      const text = buf.toText(collected);
      expect(text).toContain("A_");
      expect(text).toContain("B_");
    });
  });
});
