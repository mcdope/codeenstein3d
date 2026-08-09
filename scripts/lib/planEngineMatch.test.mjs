// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { checkPlanMatchesEngine, gridDiffCount, scorePlansAgainstGrid } from "./planEngineMatch.mjs";

/** Minimal stand-in for a Playwright page: `evaluate` just yields the grid. */
const fakePage = (grid) => ({ evaluate: async () => grid });
const planOf = (filename, grid) => ({ filename, map: { grid } });

const A = [
  [1, 1, 1],
  [1, 0, 1],
  [1, 1, 1],
];
const B = [
  [1, 1, 1],
  [0, 0, 0],
  [1, 1, 1],
];

describe("gridDiffCount", () => {
  it("is zero for identical grids", () => {
    expect(gridDiffCount(A, A.map((r) => [...r]))).toEqual({ total: 0, solid: 0 });
  });

  it("counts every differing tile, and how many change traversability", () => {
    expect(gridDiffCount(A, B)).toEqual({ total: 2, solid: 2 });
  });

  it("does not count a walkable-to-walkable change as solid", () => {
    // The false positive this split exists for: `planLevels` generates with a
    // fixed loadout while the engine uses the real progression, which moves a
    // few spike traps (0<->5). Measured 8 such tiles on serilog level 12, none
    // affecting a route. Killing a capture for that would be wrong.
    const spikes = [
      [1, 1, 1],
      [1, 5, 1],
      [1, 1, 1],
    ];
    expect(gridDiffCount(A, spikes)).toEqual({ total: 1, solid: 0 });
  });

  it("treats a missing row or column as differing rather than throwing", () => {
    // A truncated live grid is a real possibility if the engine hands back a
    // smaller map; it must register as a mismatch, not crash the capture.
    expect(gridDiffCount(A, [[1, 1, 1]])).toMatchObject({ total: 6 });
    expect(gridDiffCount(A, undefined)).toMatchObject({ total: 9 });
  });
});

describe("scorePlansAgainstGrid", () => {
  it("ranks an exact match first and names it", () => {
    const plans = [planOf("00_planned.c", A), planOf("01_other.c", B)];
    const scored = scorePlansAgainstGrid(plans, B);
    expect(scored[0]).toMatchObject({ index: 1, filename: "01_other.c", diffs: 0, solidDiffs: 0 });
    expect(scored[1].diffs).toBe(2);
  });
});

describe("checkPlanMatchesEngine", () => {
  it("passes when the engine is playing the planned map", async () => {
    const result = await checkPlanMatchesEngine(fakePage(A.map((r) => [...r])), { grid: A });
    expect(result.ok).toBe(true);
    expect(result.diffs).toBe(0);
  });

  it("passes when the only differences are walkable-to-walkable", async () => {
    const spikes = [
      [1, 1, 1],
      [1, 5, 1],
      [1, 1, 1],
    ];
    const result = await checkPlanMatchesEngine(fakePage(spikes), { grid: A });
    expect(result.ok).toBe(true);
    expect(result.diffs).toBe(1);
    expect(result.solid).toBe(0);
  });

  it("fails and names the level the engine is actually playing", async () => {
    // The curl case in miniature: the bot routes with plan 0 while the engine
    // has plan 1 loaded. Enemy counts could be identical here — only the grid
    // separates them, which is the whole reason this check exists.
    const plans = [planOf("01_projects_OS400_make-docs.sh", A), planOf("03_docs_examples_pop3-stat.c", B)];
    const result = await checkPlanMatchesEngine(fakePage(B), plans[0].map, { levelNo: 1, levelPlans: plans });

    expect(result.ok).toBe(false);
    expect(result.diffs).toBe(2);
    expect(result.scored[0].filename).toBe("03_docs_examples_pop3-stat.c");
    expect(result.message).toContain("Refusing to continue");
    expect(result.message).toContain("on level 1");
    expect(result.message).toContain("03_docs_examples_pop3-stat.c");
  });

  it("still reports a mismatch without levelPlans, just without naming a culprit", async () => {
    const result = await checkPlanMatchesEngine(fakePage(B), { grid: A });
    expect(result.ok).toBe(false);
    expect(result.scored).toBeNull();
    expect(result.message).toContain("2 of 2 differing tiles");
  });

  it("says so explicitly when nothing matches exactly", async () => {
    const live = [
      [1, 1, 1],
      [0, 1, 0],
      [1, 1, 1],
    ];
    const plans = [planOf("a.c", A), planOf("b.c", B)];
    const result = await checkPlanMatchesEngine(fakePage(live), plans[0].map, { levelPlans: plans });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No planned level matches");
  });
});
