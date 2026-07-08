import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashRun, truncateHash, loadHighscores, recordHighscore } from "./highscores";
import { compressForStorage, decompressFromStorage } from "./storageCompression";

// Mock storageCompression module
vi.mock("./storageCompression", () => ({
  compressForStorage: vi.fn(),
  decompressFromStorage: vi.fn(),
}));

// Mock crypto
const mockDigest = vi.fn().mockImplementation(async (algo, data) => {
  const hash = new Uint8Array(32);
  hash.fill(0);
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    hash[i] = data[i];
  }
  return hash.buffer;
});
Object.defineProperty(globalThis, "crypto", {
  value: {
    subtle: { digest: mockDigest }
  }
});

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => {
      if (value === "THROW") throw new Error("Quota exceeded");
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

describe("highscores", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(compressForStorage).mockReset();
    vi.mocked(decompressFromStorage).mockReset();
  });

  describe("hashRun", () => {
    it("should generate a SHA-256 hash string", async () => {
      const hash = await hashRun("{}", "my-campaign");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should generate different hashes for different inputs", async () => {
      const hash1 = await hashRun("{}", "c1");
      const hash2 = await hashRun("{}", "c2");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("truncateHash", () => {
    it("should truncate hash to 12 characters", () => {
      const hash = "a".repeat(64);
      expect(truncateHash(hash)).toBe("a".repeat(12));
    });
  });

  describe("loadHighscores", () => {
    it("should return empty array if no raw data", async () => {
      localStorageMock.getItem.mockReturnValueOnce(null);
      const scores = await loadHighscores();
      expect(scores).toEqual([]);
    });

    it("should return empty array if decompressFromStorage throws", async () => {
      localStorageMock.getItem.mockReturnValueOnce("some-data");
      vi.mocked(decompressFromStorage).mockRejectedValueOnce(new Error("fail"));
      const scores = await loadHighscores();
      expect(scores).toEqual([]);
    });

    it("should return empty array if decompressed data is not an array", async () => {
      localStorageMock.getItem.mockReturnValueOnce("some-data");
      vi.mocked(decompressFromStorage).mockResolvedValueOnce({ not: "array" });
      const scores = await loadHighscores();
      expect(scores).toEqual([]);
    });

    it("should filter out invalid entries", async () => {
      localStorageMock.getItem.mockReturnValueOnce("some-data");
      const validEntry = {
        score: 100,
        campaignName: "test",
        levelName: "level1",
        levelsCleared: 1,
        hash: "abc",
        achievedAt: 123,
      };
      const validEntryWithCodebaseStats = {
        ...validEntry,
        codebaseLinesOfCode: 1000,
        codebaseComplexity: 50,
      };
      const invalidEntries = [
        null,
        "string",
        { score: 100 },
        { ...validEntry, score: "100" },
        { ...validEntry, codebaseLinesOfCode: "1000" },
        { ...validEntry, codebaseComplexity: "50" },
      ];
      
      vi.mocked(decompressFromStorage).mockResolvedValueOnce([validEntry, validEntryWithCodebaseStats, ...invalidEntries]);
      const scores = await loadHighscores();
      expect(scores).toEqual([validEntry, validEntryWithCodebaseStats]);
    });
  });

  describe("recordHighscore", () => {
    const createEntry = (score, replay) => ({
      score,
      campaignName: "test",
      levelName: "level",
      levelsCleared: 1,
      hash: "abc",
      achievedAt: 123,
      replay,
    });

    it("should successfully record and keep top 10", async () => {
      const existing = Array.from({ length: 10 }, (_, i) => createEntry(i * 10));
      vi.mocked(decompressFromStorage).mockResolvedValueOnce(existing);
      localStorageMock.getItem.mockReturnValueOnce("existing");
      vi.mocked(compressForStorage).mockResolvedValueOnce("compressed");

      const newEntry = createEntry(100);
      const result = await recordHighscore(newEntry);

      expect(result.length).toBe(10);
      expect(result[0]).toEqual(newEntry);
      expect(result[9].score).toBe(10);
      expect(localStorageMock.setItem).toHaveBeenCalledWith("codeenstein-highscores", "compressed");
    });

    it("should retry without current replay if storage fails", async () => {
      vi.mocked(decompressFromStorage).mockResolvedValueOnce([]);
      localStorageMock.getItem.mockReturnValueOnce(null);
      
      vi.mocked(compressForStorage)
        .mockResolvedValueOnce("THROW")
        .mockResolvedValueOnce("compressed2");

      const entry = createEntry(100, { some: "replay" });
      const result = await recordHighscore(entry);

      expect(result[0].replay).toBeUndefined();
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(2);
    });

    it("should retry dropping all replays if storage still fails", async () => {
      const existing = [createEntry(50, { old: "replay" })];
      vi.mocked(decompressFromStorage).mockResolvedValueOnce(existing);
      localStorageMock.getItem.mockReturnValueOnce("existing");
      
      vi.mocked(compressForStorage)
        .mockResolvedValueOnce("THROW")
        .mockResolvedValueOnce("THROW")
        .mockResolvedValueOnce("compressed3");

      const entry = createEntry(100, { new: "replay" });
      const result = await recordHighscore(entry);

      expect(result.length).toBe(2);
      expect(result[0].replay).toBeUndefined();
      expect(result[1].replay).toBeUndefined();
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(3);
    });

    it("should return board even if all saves fail", async () => {
      vi.mocked(decompressFromStorage).mockResolvedValueOnce([]);
      localStorageMock.getItem.mockReturnValueOnce(null);
      
      vi.mocked(compressForStorage).mockResolvedValue("THROW");

      const entry = createEntry(100, { new: "replay" });
      const result = await recordHighscore(entry);

      expect(result.length).toBe(1);
      expect(result[0].score).toBe(100);
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(3);
    });
  });
});