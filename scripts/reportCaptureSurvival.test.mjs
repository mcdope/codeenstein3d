// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The one behaviour this tool exists for: pooling a capture's chunks instead of
 * letting the last one win.
 *
 * `report-balancing-ab.mjs`'s `loadSide` merges the same directory with a
 * spread at the difficulty level, so across `Casual-hard-001.json`,
 * `-002.json`, … the last file read replaces every earlier one — no error,
 * normal-looking output, computed from a fraction of the data. A test that only
 * checked "it returns a number" would pass against that bug, so these assert
 * the *sums*, which is the thing that differs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { poolCapture } from "./report-capture-survival.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A capture directory of `chunks`, each `{attempts, qualifying, reach[]}`. */
function makeCapture(chunks, flagsPerChunk = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-"));
  dirs.push(dir);
  chunks.forEach((chunk, i) => {
    const json = {
      meta: { flags: { effectiveStepMs: 50, effectiveRecordStepMs: 50, effectiveTicksScale: 1, extraQuery: null, ...(flagsPerChunk[i] ?? {}) } },
      profiles: {
        Casual: {
          hard: {
            attemptsUsed: chunk.attempts,
            trueQualifyingCount: chunk.qualifying,
            // `qualifyingRunCount` is floored at the target and must never be
            // the one that gets pooled — set it wrong on purpose so a reader
            // that picks it up fails loudly here.
            qualifyingRunCount: 999,
            levels: chunk.reach.map((n, levelIndex) => ({ levelIndex, filename: `${levelIndex + 1}.c`, runtime: { sampleCount: n } })),
          },
          crossDifficultyFlags: ["ignored"],
        },
      },
    };
    fs.writeFileSync(path.join(dir, `Casual-hard-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(json));
  });
  return dir;
}

describe("poolCapture", () => {
  it("sums attempts across chunks instead of letting the last one win", () => {
    const dir = makeCapture([
      { attempts: 5, qualifying: 5, reach: [5, 4, 2] },
      { attempts: 7, qualifying: 6, reach: [7, 3, 1] },
      { attempts: 4, qualifying: 4, reach: [4, 4, 4] },
    ]);
    const { combos, chunkCount } = poolCapture(dir);
    expect(chunkCount).toBe(3);
    expect(combos).toHaveLength(1);
    const c = combos[0];
    // The whole point: 16, not 4. A spread-merge would report the last chunk.
    expect(c.attempts).toBe(16);
    expect(c.qualifying).toBe(15);
    expect(c.reach).toEqual([16, 11, 7]);
  });

  it("pools trueQualifyingCount, not the floored qualifyingRunCount", () => {
    const dir = makeCapture([
      { attempts: 5, qualifying: 2, reach: [5] },
      { attempts: 5, qualifying: 3, reach: [5] },
    ]);
    expect(poolCapture(dir).combos[0].qualifying).toBe(5);
  });

  it("keeps a level's depth when later chunks never reach it", () => {
    // A chunk whose runs all died early carries fewer level entries. The pooled
    // depth must be the deepest any chunk saw, or the tail of the curve — the
    // part that discriminates — silently disappears.
    const dir = makeCapture([
      { attempts: 3, qualifying: 3, reach: [3, 3, 2, 1] },
      { attempts: 3, qualifying: 3, reach: [3, 1] },
    ]);
    expect(poolCapture(dir).combos[0].reach).toEqual([6, 4, 2, 1]);
  });

  it("ignores the crossDifficultyFlags sibling rather than treating it as a combo", () => {
    const dir = makeCapture([{ attempts: 2, qualifying: 2, reach: [2] }]);
    expect(poolCapture(dir).combos.map((c) => c.key)).toEqual(["Casual/hard"]);
  });

  it("reports chunks that disagree about the arm's configuration", () => {
    // Two configurations pooled into one directory are two arms, and averaging
    // them would produce a number describing neither. Loud, not silent.
    const dir = makeCapture(
      [
        { attempts: 5, qualifying: 5, reach: [5] },
        { attempts: 5, qualifying: 5, reach: [5] },
      ],
      [{}, { effectiveStepMs: 25, effectiveTicksScale: 2 }],
    );
    const { flagMismatches } = poolCapture(dir);
    expect(flagMismatches.length).toBeGreaterThan(0);
    expect(flagMismatches.join(" ")).toContain("effectiveStepMs");
  });

  it("stays quiet when every chunk agrees", () => {
    const dir = makeCapture([
      { attempts: 5, qualifying: 5, reach: [5] },
      { attempts: 5, qualifying: 5, reach: [5] },
    ]);
    expect(poolCapture(dir).flagMismatches).toEqual([]);
  });

  it("throws on a directory with no chunks rather than reporting an empty arm", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-empty-"));
    dirs.push(dir);
    expect(() => poolCapture(dir)).toThrow(/no chunk JSON/);
  });
});
