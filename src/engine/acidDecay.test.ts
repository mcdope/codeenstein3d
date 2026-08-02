// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { HAZARD_TILE, SPIKE_TRAP_TILE, type ExceptionZone, type Tile } from "../map/types";
import {
  ACID_DECAY_SECONDS,
  acidDecayProgress,
  createAcidDecayState,
  decayableTiles,
  updateAcidDecay,
  type AcidDecayActor,
} from "./acidDecay";

function grid(size = 12): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 0 as Tile));
}

/** A one-tile-wide, 4-tile-long `try` shaft at x=5, y=3..6 — the shape
 * `placeExceptionZones` actually produces. */
function zone(overrides: Partial<ExceptionZone> = {}): ExceptionZone {
  return {
    tryRect: { x: 5, y: 3, w: 1, h: 4 },
    catchRect: { x: 5, y: 1, w: 2, h: 2 },
    finallyRect: { x: 4, y: 8, w: 3, h: 3 },
    ...overrides,
  };
}

function acidShaft(g: Tile[][], z: ExceptionZone): void {
  for (let y = z.tryRect.y; y < z.tryRect.y + z.tryRect.h; y++) {
    for (let x = z.tryRect.x; x < z.tryRect.x + z.tryRect.w; x++) g[y][x] = HAZARD_TILE;
  }
}

/** A player standing dead centre on tile `(x, y)`. */
function actorOn(x: number, y: number): AcidDecayActor {
  return { posX: x + 0.5, posY: y + 0.5, radius: 0.2 };
}

describe("decayableTiles", () => {
  it("collects the acid inside a try gauntlet", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    expect(decayableTiles([z], g)).toEqual([
      { x: 5, y: 3 },
      { x: 5, y: 4 },
      { x: 5, y: 5 },
      { x: 5, y: 6 },
    ]);
  });

  it("ignores a spike tile sitting in the shaft", () => {
    // placeExceptionZones puts spikes *instead of* acid on some tiles of the
    // same shaft — a tile is one hazard kind — and a spike is not ours to
    // clear.
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    g[4][5] = SPIKE_TRAP_TILE;
    expect(decayableTiles([z], g)).toEqual([
      { x: 5, y: 3 },
      { x: 5, y: 5 },
      { x: 5, y: 6 },
    ]);
  });

  it("ignores acid outside any try gauntlet", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    g[9][1] = HAZARD_TILE; // a fillHazards room pool, permanent terrain
    expect(decayableTiles([z], g)).not.toContainEqual({ x: 1, y: 9 });
  });

  it("returns [] for a level with no exception zones", () => {
    expect(decayableTiles([], grid())).toEqual([]);
  });
});

describe("updateAcidDecay", () => {
  it("leaves untouched acid alone forever", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    for (let t = 0; t < 60; t += 1) updateAcidDecay(tiles, state, [], g, t);
    expect(g[3][5]).toBe(HAZARD_TILE);
    expect(g[6][5]).toBe(HAZARD_TILE);
  });

  it("burns a stepped-in tile out after ACID_DECAY_SECONDS, and only that tile", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    updateAcidDecay(tiles, state, [actorOn(5, 4)], g, 0);
    expect(g[4][5]).toBe(HAZARD_TILE); // still burning at the moment of contact

    // Just short of the timer: still acid, so the crossing costs real health.
    updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS - 0.01);
    expect(g[4][5]).toBe(HAZARD_TILE);

    const burned = updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS);
    expect(g[4][5]).toBe(0);
    expect(burned).toEqual([{ x: 5, y: 4 }]);
    // Its neighbours were never stepped in.
    expect(g[3][5]).toBe(HAZARD_TILE);
    expect(g[5][5]).toBe(HAZARD_TILE);
  });

  it("does not restart the clock when the player steps back on", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    updateAcidDecay(tiles, state, [actorOn(5, 4)], g, 0);
    // Standing there the whole time must not keep pushing the deadline out.
    for (let t = 0.1; t < ACID_DECAY_SECONDS; t += 0.1) {
      updateAcidDecay(tiles, state, [actorOn(5, 4)], g, t);
    }
    updateAcidDecay(tiles, state, [actorOn(5, 4)], g, ACID_DECAY_SECONDS);
    expect(g[4][5]).toBe(0);
  });

  it("reports a tile as burned out exactly once", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    updateAcidDecay(tiles, state, [actorOn(5, 4)], g, 0);
    expect(updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS)).toHaveLength(1);
    expect(updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS + 1)).toEqual([]);
  });

  it("retracts a tile decayed early, so a mispredicting guest self-corrects", () => {
    // The property that lets this derive the grid instead of emitting an
    // additive-only mutation it could never take back.
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    g[4][5] = 0; // guest speculatively burned it out
    updateAcidDecay(tiles, state, [], g, 1);
    expect(g[4][5]).toBe(HAZARD_TILE);
  });

  it("burns out under any living player, not just the local one", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    updateAcidDecay(tiles, state, [actorOn(0, 0), actorOn(5, 6)], g, 0);
    updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS);
    expect(g[6][5]).toBe(0);
  });

  it("starts the clock on a player only clipping the tile edge", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    // Centre is on tile y=2 (outside the shaft) but the body overlaps y=3.
    updateAcidDecay(tiles, state, [{ posX: 5.5, posY: 2.95, radius: 0.2 }], g, 0);
    updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS);
    expect(g[3][5]).toBe(0);
  });

  it("does not fire on a player standing next to the shaft", () => {
    const g = grid();
    const z = zone();
    acidShaft(g, z);
    const tiles = decayableTiles([z], g);
    const state = createAcidDecayState();

    updateAcidDecay(tiles, state, [actorOn(4, 4)], g, 0);
    updateAcidDecay(tiles, state, [], g, ACID_DECAY_SECONDS + 5);
    expect(g[4][5]).toBe(HAZARD_TILE);
  });
});

describe("acidDecayProgress", () => {
  it("is 0 for a tile nobody has touched", () => {
    expect(acidDecayProgress(createAcidDecayState(), 5, 4, 10)).toBe(0);
  });

  it("ramps 0 -> 1 across the decay window and clamps past it", () => {
    const state = createAcidDecayState();
    state.set("5,4", 10);
    expect(acidDecayProgress(state, 5, 4, 10)).toBe(0);
    expect(acidDecayProgress(state, 5, 4, 10 + ACID_DECAY_SECONDS / 2)).toBeCloseTo(0.5, 5);
    expect(acidDecayProgress(state, 5, 4, 10 + ACID_DECAY_SECONDS)).toBe(1);
    expect(acidDecayProgress(state, 5, 4, 999)).toBe(1);
  });
});
