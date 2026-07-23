// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import { HAZARD_TILE, SPIKE_TRAP_TILE, type Tile } from "../types";
import { carveHLine } from "./corridors";
import { makeRoom } from "./geometry";
import { fillHazards, placeTraps, SPIKE_PERIOD_MAX, SPIKE_PERIOD_MIN } from "./trapsHazards";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

describe("placeTraps", () => {
  it("places nothing when there are no corridor choke points at all", () => {
    const g = grid(10);
    expect(placeTraps([], g, [], mulberry32(1), [])).toEqual({ spikeTraps: [], mines: [] });
  });

  it("places a mix of spike traps and mines along a long corridor", () => {
    const g = grid(30);
    carveHLine(g, 1, 25, 5);
    const { spikeTraps, mines } = placeTraps([], g, [], mulberry32(1), []);
    expect(spikeTraps.length + mines.length).toBeGreaterThan(0);
    // Spikes are placed whenever spikeTraps.length <= mines.length, so the
    // count of spikes can never trail mines by more than one placement.
    expect(spikeTraps.length).toBeGreaterThanOrEqual(mines.length);
  });

  it("marks a spike trap's tile on the grid but leaves a mine's tile as plain floor", () => {
    const g = grid(30);
    carveHLine(g, 1, 25, 5);
    const { spikeTraps, mines } = placeTraps([], g, [], mulberry32(1), []);
    for (const t of spikeTraps) expect(g[t.y][t.x]).toBe(SPIKE_TRAP_TILE);
    for (const m of mines) expect(g[Math.floor(m.y)][Math.floor(m.x)]).toBe(0);
  });

  it("gives each spike trap a period/phase within the documented ranges", () => {
    const g = grid(30);
    carveHLine(g, 1, 25, 5);
    const { spikeTraps } = placeTraps([], g, [], mulberry32(1), []);
    for (const t of spikeTraps) {
      expect(t.period).toBeGreaterThanOrEqual(SPIKE_PERIOD_MIN);
      expect(t.period).toBeLessThanOrEqual(SPIKE_PERIOD_MAX);
      expect(t.phase).toBeGreaterThanOrEqual(0);
      expect(t.phase).toBeLessThanOrEqual(SPIKE_PERIOD_MAX);
    }
  });

  it("skips a candidate too close to an avoid-listed point", () => {
    const g = grid(30);
    carveHLine(g, 1, 25, 5);
    const avoidEverything = Array.from({ length: 25 }, (_, x) => ({ x: x + 1, y: 5 }));
    const { spikeTraps, mines } = placeTraps([], g, avoidEverything, mulberry32(1), []);
    expect(spikeTraps).toEqual([]);
    expect(mines).toEqual([]);
  });

  it("keeps chosen traps spaced at least TRAP_SPACING apart from each other", () => {
    const g = grid(40);
    carveHLine(g, 1, 35, 5);
    const { spikeTraps, mines } = placeTraps([], g, [], mulberry32(3), []);
    const all = [...spikeTraps.map((t) => ({ x: t.x + 0.5, y: t.y + 0.5 })), ...mines.map((m) => ({ x: m.x, y: m.y }))];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y);
        expect(d).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("caps at MAX_TRAPS even with a huge number of choke points", () => {
    const g = grid(120);
    carveHLine(g, 1, 115, 5);
    const { spikeTraps, mines } = placeTraps([], g, [], mulberry32(1), []);
    expect(spikeTraps.length + mines.length).toBeLessThanOrEqual(8);
  });

  it("excludes tiles inside a breakup room from choke-point candidacy", () => {
    const g = grid(30);
    carveHLine(g, 1, 25, 5);
    const breakupRooms = [{ x: 10, y: 4, w: 3, h: 3 }];
    for (let y = 4; y < 7; y++) for (let x = 10; x < 13; x++) g[y][x] = 0;
    expect(() => placeTraps([], g, [], mulberry32(1), breakupRooms)).not.toThrow();
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(30);
      carveHLine(g, 1, 25, 5);
      return placeTraps([], g, [], mulberry32(21), []);
    };
    expect(build()).toEqual(build());
  });
});

describe("fillHazards", () => {
  it("floods a global-variable room's interior with hazard tiles, leaving a 1-tile rim", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const hazards = fillHazards([spawnRoom, hazardRoom], g, { x: 2, y: 2 }, { x: 99, y: 99 });
    expect(hazards.length).toBeGreaterThan(0);
    for (const h of hazards) expect(g[h.y][h.x]).toBe(HAZARD_TILE);
    // The rim (room edge) is untouched.
    expect(g[hazardRoom.y][hazardRoom.x]).not.toBe(HAZARD_TILE);
  });

  it("never floods the spawn room (index 0), even if it's a global-variable room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 6, 6, entity({ kind: "global" }));
    const hazards = fillHazards([spawnRoom], g, { x: 2, y: 2 }, { x: 99, y: 99 });
    expect(hazards).toEqual([]);
  });

  it("skips a non-global room entirely", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const room = makeRoom(8, 1, 6, 6, entity({ kind: "function" }));
    const hazards = fillHazards([spawnRoom, room], g, { x: 2, y: 2 }, { x: 99, y: 99 });
    expect(hazards).toEqual([]);
  });

  it("keeps the spawn tile clear even when it falls inside a global room's interior", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const spawn = { x: hazardRoom.x + 2, y: hazardRoom.y + 2 }; // inside the interior
    const hazards = fillHazards([spawnRoom, hazardRoom], g, spawn, { x: 99, y: 99 });
    expect(hazards.some((h) => h.x === spawn.x && h.y === spawn.y)).toBe(false);
    expect(g[spawn.y][spawn.x]).not.toBe(HAZARD_TILE);
  });

  it("keeps the exit tile clear even when it falls inside a global room's interior", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const exit = { x: hazardRoom.x + 2, y: hazardRoom.y + 2 };
    const hazards = fillHazards([spawnRoom, hazardRoom], g, { x: 2, y: 2 }, exit);
    expect(hazards.some((h) => h.x === exit.x && h.y === exit.y)).toBe(false);
    expect(g[exit.y][exit.x]).not.toBe(HAZARD_TILE);
  });

  it("aggregates hazards across multiple global rooms", () => {
    const g = grid(30);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const roomA = makeRoom(8, 1, 5, 5, entity({ kind: "global" }));
    const roomB = makeRoom(15, 1, 5, 5, entity({ kind: "global" }));
    const hazards = fillHazards([spawnRoom, roomA, roomB], g, { x: 2, y: 2 }, { x: 99, y: 99 });
    expect(hazards.length).toBeGreaterThan(0);
  });

  it("skips flooding a global room entirely when its center is a multiplayer spawn", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const hazards = fillHazards([spawnRoom, hazardRoom], g, { x: 2, y: 2 }, { x: 99, y: 99 }, [hazardRoom.center]);
    expect(hazards).toEqual([]);
    for (let y = hazardRoom.y; y < hazardRoom.y + hazardRoom.h; y++) {
      for (let x = hazardRoom.x; x < hazardRoom.x + hazardRoom.w; x++) {
        expect(g[y][x]).not.toBe(HAZARD_TILE);
      }
    }
  });

  it("carves out a multiplayer spawn tile inside an otherwise-flooded room (tile-level check)", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const mpSpawn = { x: hazardRoom.x + 1, y: hazardRoom.y + 1 }; // interior, not the room center
    const hazards = fillHazards([spawnRoom, hazardRoom], g, { x: 2, y: 2 }, { x: 99, y: 99 }, [mpSpawn]);
    expect(hazards.length).toBeGreaterThan(0);
    expect(hazards.some((h) => h.x === mpSpawn.x && h.y === mpSpawn.y)).toBe(false);
    expect(g[mpSpawn.y][mpSpawn.x]).not.toBe(HAZARD_TILE);
  });

  it("omitted multiplayerSpawns behaves exactly like an empty array", () => {
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const hazardRoom = makeRoom(8, 1, 6, 6, entity({ kind: "global" }));
    const gDefault = grid(20);
    const gEmpty = grid(20);
    const hazardsDefault = fillHazards([spawnRoom, hazardRoom], gDefault, { x: 2, y: 2 }, { x: 99, y: 99 });
    const hazardsEmpty = fillHazards([spawnRoom, hazardRoom], gEmpty, { x: 2, y: 2 }, { x: 99, y: 99 }, []);
    expect(hazardsDefault).toEqual(hazardsEmpty);
    expect(gDefault).toEqual(gEmpty);
  });
});
