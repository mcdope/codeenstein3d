// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The guard that makes `COMBAT_BALANCE` and `TRAP_BALANCE` worth having.
 *
 * jsdom, only because reading `SIMULATION_BALANCE` means importing `engine.ts`,
 * which pulls the renderer and builds canvas-backed textures at module load.
 * Nothing here touches the DOM itself.
 *
 * `SIMULATION_BALANCE` folds both in wholesale precisely so nobody has to
 * remember to register a new constant — but each table is itself a
 * hand-written list, so "wholesale" is a claim, not a property. These tests
 * enumerate the modules' actual exports and fail when a scalar is missing.
 *
 * The failure they exist to prevent is silent in the worst way: a tuned
 * constant that no hash covers means every shipped replay still validates and
 * then plays back a differently balanced world, showing a run that no longer
 * matches its own recorded score. That is exactly the `ELITE_HP_MULTIPLIER`
 * bug `balanceHash.ts` was written for, arriving through a door it did not
 * cover. The rocket sub-step fix walked through the same door in 2026-08-19
 * (it changed collision arithmetic rather than a constant, which no hash can
 * see — so this guard is necessary, not sufficient).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { stubCanvasGetContext } from "../../test/mocks/canvas";
import * as combatConstants from "./combatConstants";
import * as traps from "./traps";
import { COMBAT_BALANCE } from "./combatConstants";
import { TRAP_BALANCE } from "./traps";
import { computeSimulationHash } from "./balanceHash";

// engine.ts builds canvas-backed textures at module load, before any test
// setup can run — so stub the context first and import it dynamically. Same
// gotcha, same fix, as engine.test.ts.
let SIMULATION_BALANCE: typeof import("./engine").SIMULATION_BALANCE;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ SIMULATION_BALANCE } = await import("./engine"));
});

/** Numeric exports of a module, which is what "a balance constant" looks like
 * here — functions, types and interfaces are not simulation scalars. */
function numericExports(mod: Record<string, unknown>): string[] {
  return Object.entries(mod)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k)
    .sort();
}

describe("COMBAT_BALANCE covers combatConstants.ts", () => {
  it("names every numeric export of the module", () => {
    const missing = numericExports(combatConstants).filter((k) => !(k in COMBAT_BALANCE));
    // Named individually in the message so a failure says *which* constant to
    // add rather than only that the counts differ.
    expect(missing, `add these to COMBAT_BALANCE: ${missing.join(", ")}`).toEqual([]);
  });

  it("names nothing the module does not actually export, so the table cannot rot", () => {
    const exported = new Set(numericExports(combatConstants));
    const stale = Object.keys(COMBAT_BALANCE).filter((k) => !exported.has(k));
    expect(stale, `these are in COMBAT_BALANCE but not exported: ${stale.join(", ")}`).toEqual([]);
  });

  it("carries the module's own values, not a drifted copy", () => {
    for (const [key, value] of Object.entries(COMBAT_BALANCE)) {
      expect(value, key).toBe((combatConstants as Record<string, unknown>)[key]);
    }
  });
});

describe("TRAP_BALANCE covers traps.ts", () => {
  // traps.ts keeps its constants module-private on purpose (see TRAP_BALANCE's
  // own comment), so the "every export" check cannot apply — only
  // MINE_BLAST_RADIUS is exported at all. What is checkable is that the one
  // exported scalar is in the table and that nothing in it has drifted.
  it("includes the one balance scalar the module exports", () => {
    for (const key of numericExports(traps)) {
      expect(TRAP_BALANCE, `traps.ts exports ${key}; add it to TRAP_BALANCE`).toHaveProperty(key);
    }
  });

  it("agrees with the module for every exported value", () => {
    for (const key of numericExports(traps)) {
      expect((TRAP_BALANCE as Record<string, unknown>)[key], key).toBe((traps as Record<string, unknown>)[key]);
    }
  });

  it("is non-empty, so an emptied table cannot pass the checks above vacuously", () => {
    expect(Object.keys(TRAP_BALANCE).length).toBeGreaterThan(0);
  });
});

describe("SIMULATION_BALANCE folds both tables in", () => {
  it("carries them by reference, so a constant change reaches the hash", () => {
    expect(SIMULATION_BALANCE.COMBAT_BALANCE).toBe(COMBAT_BALANCE);
    expect(SIMULATION_BALANCE.TRAP_BALANCE).toBe(TRAP_BALANCE);
  });

  it("produces a different simulation hash when an enemy constant moves", async () => {
    // The point of the whole change, asserted end to end rather than inferred:
    // perturb one enemy scalar inside the nested table and the fingerprint the
    // leaderboard compares against must move.
    const before = await computeSimulationHash(SIMULATION_BALANCE);
    const after = await computeSimulationHash({
      ...SIMULATION_BALANCE,
      COMBAT_BALANCE: { ...COMBAT_BALANCE, PROJECTILE_SPEED: COMBAT_BALANCE.PROJECTILE_SPEED + 1 },
    });
    expect(after).not.toBe(before);
  });

  it("produces a different simulation hash when a trap constant moves", async () => {
    const before = await computeSimulationHash(SIMULATION_BALANCE);
    const after = await computeSimulationHash({
      ...SIMULATION_BALANCE,
      TRAP_BALANCE: { ...TRAP_BALANCE, SPIKE_DPS: TRAP_BALANCE.SPIKE_DPS + 1 },
    });
    expect(after).not.toBe(before);
  });
});
