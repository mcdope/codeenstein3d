// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  hashRun,
  loadHighscores,
  loadHighscoresForDisplay,
  recordHighscore,
  truncateHash,
  type HighscoreEntry,
} from "./highscores";

const HIGHSCORE_KEY = "codeenstein-highscores";

// jsdom's built-in `crypto` global has no SubtleCrypto implementation —
// swap in Node's real webcrypto so hashRun()'s crypto.subtle.digest() call
// works the same as it does in an actual browser.
beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function makeEntry(overrides: Partial<HighscoreEntry> = {}): HighscoreEntry {
  return {
    score: 100,
    campaignName: "demo",
    levelName: "main.c",
    levelsCleared: 1,
    hash: "abc123",
    achievedAt: 1000,
    ...overrides,
  };
}

describe("hashRun", () => {
  it("returns a 64-character hex SHA-256 digest", async () => {
    const hash = await hashRun("{}", "demo");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    expect(await hashRun("{}", "demo")).toBe(await hashRun("{}", "demo"));
  });

  it("differs when the campaign name differs", async () => {
    expect(await hashRun("{}", "demo")).not.toBe(await hashRun("{}", "other"));
  });

  it("differs when the AST JSON differs", async () => {
    expect(await hashRun("{}", "demo")).not.toBe(await hashRun("{\"a\":1}", "demo"));
  });
});

describe("truncateHash", () => {
  it("truncates to the display length", () => {
    expect(truncateHash("0123456789abcdef")).toBe("0123456789ab"); // 12 chars
  });
});

describe("loadHighscores", () => {
  it("returns an empty list when nothing is stored", async () => {
    expect(await loadHighscores()).toEqual([]);
  });

  it("returns an empty list on corrupt/invalid stored JSON", async () => {
    localStorage.setItem(HIGHSCORE_KEY, "not json{{{");
    expect(await loadHighscores()).toEqual([]);
  });

  it("returns an empty list when the stored value isn't an array", async () => {
    localStorage.setItem(HIGHSCORE_KEY, JSON.stringify({ not: "an array" }));
    expect(await loadHighscores()).toEqual([]);
  });

  it("filters out malformed entries while keeping valid ones", async () => {
    localStorage.setItem(
      HIGHSCORE_KEY,
      JSON.stringify([makeEntry({ score: 1 }), { score: "not a number" }, null, "garbage"]),
    );
    const loaded = await loadHighscores();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].score).toBe(1);
  });

  it("round-trips a board saved via recordHighscore", async () => {
    await recordHighscore(makeEntry({ score: 50 }));
    const loaded = await loadHighscores();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].score).toBe(50);
  });

  it("accepts entries whose optional codebase fields are present and numeric", async () => {
    localStorage.setItem(
      HIGHSCORE_KEY,
      JSON.stringify([makeEntry({ codebaseLinesOfCode: 500, codebaseComplexity: 42 })]),
    );
    const loaded = await loadHighscores();
    expect(loaded).toHaveLength(1);
  });

  it("rejects an entry whose optional codebase fields are present but non-numeric", async () => {
    localStorage.setItem(
      HIGHSCORE_KEY,
      JSON.stringify([{ ...makeEntry(), codebaseLinesOfCode: "not a number" }]),
    );
    expect(await loadHighscores()).toEqual([]);
  });
});

describe("loadHighscoresForDisplay", () => {
  it("returns the real board when it has entries", async () => {
    await recordHighscore(makeEntry({ score: 77 }));
    const displayed = await loadHighscoresForDisplay();
    expect(displayed).toHaveLength(1);
    expect(displayed[0].score).toBe(77);
  });

  it("falls back to the shipped default entries when the real board is empty", async () => {
    const displayed = await loadHighscoresForDisplay();
    expect(displayed.length).toBeGreaterThan(0);
  }, 30000);
});

describe("recordHighscore", () => {
  it("saves and returns the board sorted best-score-first", async () => {
    await recordHighscore(makeEntry({ score: 10 }));
    const board = await recordHighscore(makeEntry({ score: 90 }));
    expect(board.map((e) => e.score)).toEqual([90, 10]);
  });

  it("truncates the board to the top MAX_ENTRIES entries", async () => {
    let board: HighscoreEntry[] = [];
    for (let i = 0; i < 11; i++) {
      board = await recordHighscore(makeEntry({ score: i }));
    }
    expect(board).toHaveLength(10);
    expect(board.map((e) => e.score)).not.toContain(0); // lowest score dropped
  });

  it("retries without this run's replay when the full board doesn't fit, leaving other entries' replays untouched", async () => {
    // Seed a pre-existing entry with its own replay so the retry's
    // `board.map` has to distinguish "this run's entry" from "some other
    // entry" rather than mapping over a single-element board.
    await recordHighscore(
      makeEntry({ score: 20, replay: { version: 2, campaignName: "demo", levels: [] } }),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realSetItem = Storage.prototype.setItem;
    let call = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      call++;
      if (call === 1) throw new DOMException("quota exceeded", "QuotaExceededError");
      return realSetItem.call(this, key, value);
    });

    const entryWithReplay = makeEntry({
      score: 5,
      replay: { version: 2, campaignName: "demo", levels: [] },
    });
    const board = await recordHighscore(entryWithReplay);
    expect(board).toHaveLength(2);
    const thisRun = board.find((e) => e.score === 5)!;
    const otherRun = board.find((e) => e.score === 20)!;
    expect(thisRun.replay).toBeUndefined();
    expect(otherRun.replay).toBeDefined(); // untouched by the retry
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("retrying without it");
  });

  it("drops every entry's replay when even the single-entry retry doesn't fit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realSetItem = Storage.prototype.setItem;
    let call = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      call++;
      if (call <= 2) throw new DOMException("quota exceeded", "QuotaExceededError");
      return realSetItem.call(this, key, value);
    });

    const entryWithReplay = makeEntry({
      score: 5,
      replay: { version: 2, campaignName: "demo", levels: [] },
    });
    const board = await recordHighscore(entryWithReplay);
    expect(board).toHaveLength(1);
    expect(board[0].replay).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up and returns the unsaved board when nothing fits even with every replay dropped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    const entryWithReplay = makeEntry({
      score: 5,
      replay: { version: 2, campaignName: "demo", levels: [] },
    });
    const board = await recordHighscore(entryWithReplay);
    expect(board).toHaveLength(1);
    expect(board[0].replay).toBeDefined(); // never actually saved, so unmodified
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[2][0]).toContain("Failed to save");
  });
});
