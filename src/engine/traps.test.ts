// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { GameMap, Mine, SpikeTrap, Tile } from "../map/types";
import { Player } from "./player";
import {
  activeSpikeTileKeys,
  detonateMine,
  isSpikeActive,
  MINE_BLAST_RADIUS,
  spikeDamage,
  updateMines,
} from "./traps";

function fakeMap(spawn = { x: 5, y: 5 }): GameMap {
  const grid: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
  return {
    width: 10,
    height: 10,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn,
    enemies: [],
    exit: { x: 0, y: 0 },
    shortestPathTiles: 0,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
  };
}

function playerAt(x: number, y: number): Player {
  const player = new Player(fakeMap());
  player.posX = x;
  player.posY = y;
  return player;
}

function spike(overrides: Partial<SpikeTrap> = {}): SpikeTrap {
  return { x: 5, y: 5, period: 4, phase: 0, ...overrides };
}

function mine(overrides: Partial<Mine> = {}): Mine {
  return { x: 5, y: 5, alive: true, visible: false, closeTimer: 0, ...overrides };
}

describe("isSpikeActive", () => {
  it("is inactive in the first half of its cycle", () => {
    expect(isSpikeActive(spike({ period: 4, phase: 0 }), 1)).toBe(false);
  });

  it("is active in the second half of its cycle", () => {
    expect(isSpikeActive(spike({ period: 4, phase: 0 }), 2)).toBe(true);
  });

  it("wraps using the trap's phase offset", () => {
    // phase=2 shifts the cycle so levelTime=0 lands in what would otherwise
    // be the second half: (0 + 2) % 4 = 2 >= 4/2 -> active.
    expect(isSpikeActive(spike({ period: 4, phase: 2 }), 0)).toBe(true);
  });
});

describe("activeSpikeTileKeys", () => {
  it("returns an empty set for no traps", () => {
    expect(activeSpikeTileKeys([], 0)).toEqual(new Set());
  });

  it("includes only currently-active traps' tile keys", () => {
    const traps = [spike({ x: 1, y: 2, period: 4, phase: 0 }), spike({ x: 3, y: 4, period: 4, phase: 0 })];
    const keys = activeSpikeTileKeys(traps, 2); // active half
    expect(keys.has("1,2")).toBe(true);
    expect(keys.has("3,4")).toBe(true);
  });

  it("excludes inactive traps", () => {
    const traps = [spike({ x: 1, y: 2, period: 4, phase: 0 })];
    const keys = activeSpikeTileKeys(traps, 0); // inactive half
    expect(keys.has("1,2")).toBe(false);
  });
});

describe("spikeDamage", () => {
  it("returns 0 when the player isn't standing on any spike tile", () => {
    const traps = [spike({ x: 1, y: 1 })];
    const player = playerAt(5.5, 5.5);
    expect(spikeDamage(traps, player, 2, 0.1)).toBe(0);
  });

  it("returns 0 when standing on a spike tile that's currently inactive", () => {
    const traps = [spike({ x: 5, y: 5, period: 4, phase: 0 })];
    const player = playerAt(5.5, 5.5);
    expect(spikeDamage(traps, player, 0, 0.1)).toBe(0);
  });

  it("returns dt-scaled damage when standing on an active spike tile", () => {
    const traps = [spike({ x: 5, y: 5, period: 4, phase: 0 })];
    const player = playerAt(5.5, 5.5);
    expect(spikeDamage(traps, player, 2, 0.5)).toBe(10); // SPIKE_DPS(20) * 0.5
  });
});

describe("detonateMine", () => {
  it("always marks the mine dead", () => {
    const m = mine({ alive: true });
    detonateMine(m, playerAt(5, 5));
    expect(m.alive).toBe(false);
  });

  it("deals max damage at ground zero", () => {
    const m = mine({ x: 5, y: 5 });
    const dmg = detonateMine(m, playerAt(5, 5));
    expect(dmg).toBe(32); // MINE_MAX_DAMAGE * falloff(1)
  });

  it("returns 0 for a player exactly at or beyond the blast radius", () => {
    const m = mine({ x: 5, y: 5 });
    const dmg = detonateMine(m, playerAt(5 + MINE_BLAST_RADIUS, 5));
    expect(dmg).toBe(0);
  });

  it("floors falloff damage near the edge of the blast radius instead of trailing to 0", () => {
    const m = mine({ x: 5, y: 5 });
    const dmg = detonateMine(m, playerAt(5 + MINE_BLAST_RADIUS - 0.01, 5));
    expect(dmg).toBeCloseTo(32 * 0.35, 1); // MINE_DAMAGE_FALLOFF_FLOOR clamp
  });
});

describe("updateMines", () => {
  it("skips dead mines entirely", () => {
    const mines = [mine({ alive: false, x: 5, y: 5 })];
    const player = playerAt(5, 5);
    const detonations = updateMines(mines, player, 0.1);
    expect(detonations).toEqual([]);
    expect(mines[0].closeTimer).toBe(0);
  });

  it("marks a mine visible once the player enters sight radius", () => {
    const m = mine({ x: 5, y: 5, visible: false });
    updateMines([m], playerAt(8, 5), 0.1); // within MINE_SIGHT_RADIUS(4.5), outside fuse radius
    expect(m.visible).toBe(true);
  });

  it("leaves an unseen mine invisible while the player is out of sight radius", () => {
    const m = mine({ x: 5, y: 5, visible: false });
    updateMines([m], playerAt(20, 5), 0.1);
    expect(m.visible).toBe(false);
  });

  it("keeps a spotted mine visible even after the player backs out of sight radius (sticky)", () => {
    const m = mine({ x: 5, y: 5, visible: true });
    updateMines([m], playerAt(20, 5), 0.1);
    expect(m.visible).toBe(true);
  });

  it("resets the fuse timer once the player steps back outside the fuse radius", () => {
    const m = mine({ x: 5, y: 5, closeTimer: 0.5 });
    updateMines([m], playerAt(8, 5), 0.1); // outside MINE_FUSE_RADIUS(1.8)
    expect(m.closeTimer).toBe(0);
  });

  it("accumulates the fuse timer while inside the fuse radius, without detonating early", () => {
    const m = mine({ x: 5, y: 5, closeTimer: 0 });
    const detonations = updateMines([m], playerAt(5.5, 5), 0.3);
    expect(m.closeTimer).toBeCloseTo(0.3);
    expect(detonations).toEqual([]);
    expect(m.alive).toBe(true);
  });

  it("detonates once the fuse timer reaches the threshold", () => {
    const m = mine({ x: 5, y: 5, closeTimer: 0.85 });
    const detonations = updateMines([m], playerAt(5, 5), 0.1); // closeTimer -> 0.95 >= 0.9
    expect(detonations).toHaveLength(1);
    expect(detonations[0]).toEqual({ x: 5, y: 5, damage: expect.any(Number) });
    expect(m.alive).toBe(false);
  });

  it("can detonate more than one mine in the same frame", () => {
    const mines = [
      mine({ x: 5, y: 5, closeTimer: 0.85 }),
      mine({ x: 6, y: 6, closeTimer: 0.85 }),
    ];
    const player = playerAt(5.5, 5.5); // close enough to both fuse radii
    const detonations = updateMines(mines, player, 0.1);
    expect(detonations).toHaveLength(2);
  });
});
