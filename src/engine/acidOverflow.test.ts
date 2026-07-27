// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { CodeEntity } from "../parser/types";
import { HAZARD_TILE, type AcidOverflow, type Enemy, type Tile } from "../map/types";
import { acidFillTarget, acidTiles, createAcidOverflowStates, updateAcidOverflows, type AcidOverflowActor } from "./acidOverflow";

/** A 4-tile overflow claiming one tile per second, in a 2x2 room at (2,2). */
function overflow(overrides: Partial<AcidOverflow> = {}): AcidOverflow {
  return {
    room: { x: 2, y: 2, w: 2, h: 2 },
    enemyIndex: 0,
    tiles: [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ],
    intervalSeconds: 1,
    ...overrides,
  };
}

function grid(size = 8): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 0 as Tile));
}

const ENTITY: CodeEntity = { name: "leaky", kind: "function", startLine: 1, endLine: 20, complexityScore: 3, nestingDepth: 0 };

function enemy(alive = true): Enemy {
  return {
    x: 2.5, y: 2.5, hp: alive ? 50 : 0, maxHp: 50, alive,
    attackCooldown: 0, hitFlash: 0,
    home: { x: 2, y: 2, w: 2, h: 2 },
    aggroed: false, discovered: false, roamX: 2.5, roamY: 2.5, fireCooldown: 0,
    entity: ENTITY, elite: false, edgeCase: false,
  };
}

/** A player-shaped collision box standing at a given world position. */
function playerAt(posX: number, posY: number): AcidOverflowActor {
  return { posX, posY, radius: 0.2 };
}

const INSIDE = () => playerAt(2.5, 2.5);
const OUTSIDE = () => playerAt(6.5, 6.5);

describe("createAcidOverflowStates", () => {
  it("makes one un-started state per overflow", () => {
    expect(createAcidOverflowStates(2)).toEqual([
      { startedAt: null, frozenTarget: null, applied: 0 },
      { startedAt: null, frozenTarget: null, applied: 0 },
    ]);
  });

  it("makes nothing for a level with no overflow rooms", () => {
    expect(createAcidOverflowStates(0)).toEqual([]);
  });
});

describe("acidFillTarget", () => {
  it("is 0 before anyone has entered the room", () => {
    expect(acidFillTarget(overflow(), { startedAt: null, frozenTarget: null, applied: 0 }, 100)).toBe(0);
  });

  it("claims one more tile per interval once started", () => {
    const state = { startedAt: 10, frozenTarget: null, applied: 0 };
    expect(acidFillTarget(overflow(), state, 10)).toBe(0);
    expect(acidFillTarget(overflow(), state, 11.5)).toBe(1);
    expect(acidFillTarget(overflow(), state, 13)).toBe(3);
  });

  it("never exceeds the planned tile list", () => {
    const state = { startedAt: 0, frozenTarget: null, applied: 0 };
    expect(acidFillTarget(overflow(), state, 9999)).toBe(4);
  });

  it("never goes negative if levelTime somehow precedes the start", () => {
    const state = { startedAt: 10, frozenTarget: null, applied: 0 };
    expect(acidFillTarget(overflow(), state, 5)).toBe(0);
  });
});

describe("updateAcidOverflows", () => {
  it("does nothing while no player has entered the room", () => {
    const g = grid();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([overflow()], states, [enemy()], [OUTSIDE()], g, 100);
    expect(states[0].startedAt).toBeNull();
    expect(g[2][2]).toBe(0);
  });

  it("starts the flood the first tick a living player is inside", () => {
    const g = grid();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([overflow()], states, [enemy()], [INSIDE()], g, 42);
    expect(states[0].startedAt).toBe(42);
  });

  it("keeps the original start time once flooding has begun", () => {
    const g = grid();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([overflow()], states, [enemy()], [INSIDE()], g, 10);
    updateAcidOverflows([overflow()], states, [enemy()], [INSIDE()], g, 20);
    expect(states[0].startedAt).toBe(10);
  });

  it("writes acid into the grid one tile at a time, in the planned order", () => {
    const g = grid();
    const o = overflow();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 2.5);
    expect(g[o.tiles[0].y][o.tiles[0].x]).toBe(HAZARD_TILE);
    expect(g[o.tiles[1].y][o.tiles[1].x]).toBe(HAZARD_TILE);
    expect(g[o.tiles[2].y][o.tiles[2].x]).toBe(0);
    expect(states[0].applied).toBe(2);
  });

  it("stops at the planned tile list and never floods past the room", () => {
    const g = grid();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([overflow()], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([overflow()], states, [enemy()], [INSIDE()], g, 9999);
    expect(states[0].applied).toBe(4);
    // Nothing outside the room's four planned tiles was touched.
    expect(g[6][6]).toBe(0);
  });

  it("freezes the flood at the extent it had reached when the enemy died", () => {
    const g = grid();
    const o = overflow();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 2.5);
    // The tick the kill lands on. The freeze point is derived from the
    // reconciled `startedAt` + `levelTime`, not from the local `applied`
    // count, so every peer freezes at the same tile regardless of how far its
    // own speculative flood had got.
    updateAcidOverflows([o], states, [enemy(false)], [INSIDE()], g, 2.53);
    expect(states[0].frozenTarget).toBe(2);
    expect(states[0].applied).toBe(2);

    // And it stays frozen however long the level runs on.
    updateAcidOverflows([o], states, [enemy(false)], [INSIDE()], g, 100);
    expect(states[0].applied).toBe(2);
    expect(g[o.tiles[2].y][o.tiles[2].x]).toBe(0);
  });

  it("leaves the already-flooded tiles behind once frozen", () => {
    // Killing the leak stops it spreading; it doesn't undo the damage.
    const g = grid();
    const o = overflow();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 2.5);
    updateAcidOverflows([o], states, [enemy(false)], [INSIDE()], g, 2.53);
    expect(g[o.tiles[0].y][o.tiles[0].x]).toBe(HAZARD_TILE);
    expect(g[o.tiles[1].y][o.tiles[1].x]).toBe(HAZARD_TILE);
  });

  it("retracts tiles when the target drops — the guest-mispredicted case", () => {
    // This is the whole reason acid never rides the additive `gridDelta`: a
    // peer that speculatively flooded ahead of the host has to be able to take
    // those tiles back, which `applyReconciliationSnapshot` triggers by
    // rewriting `startedAt`/`frozenTarget` and leaving `applied` alone.
    const g = grid();
    const o = overflow();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 3.5);
    expect(states[0].applied).toBe(3);

    // Host says: actually only one tile had been claimed by then.
    states[0].frozenTarget = 1;
    updateAcidOverflows([o], states, [enemy()], [INSIDE()], g, 3.5);
    expect(states[0].applied).toBe(1);
    expect(g[o.tiles[0].y][o.tiles[0].x]).toBe(HAZARD_TILE);
    expect(g[o.tiles[1].y][o.tiles[1].x]).toBe(0);
    expect(g[o.tiles[2].y][o.tiles[2].x]).toBe(0);
  });

  it("never starts for a room whose enemy is already dead on arrival", () => {
    const g = grid();
    const o = overflow();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([o], states, [enemy(false)], [INSIDE()], g, 5);
    // It records the entry, but freezes at zero tiles immediately.
    expect(states[0].frozenTarget).toBe(0);
    expect(states[0].applied).toBe(0);
    expect(g[o.tiles[0].y][o.tiles[0].x]).toBe(0);
  });

  it("tolerates an enemyIndex that doesn't resolve, rather than freezing", () => {
    // Defensive: `planAcidOverflows` guarantees a real index, so this is a
    // "don't crash if a future change breaks that" path, not a live scenario.
    const g = grid();
    const states = createAcidOverflowStates(1);
    updateAcidOverflows([overflow({ enemyIndex: 99 })], states, [enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([overflow({ enemyIndex: 99 })], states, [enemy()], [INSIDE()], g, 2.5);
    expect(states[0].frozenTarget).toBeNull();
    expect(states[0].applied).toBe(2);
  });

  it("handles a level with no overflow rooms at all", () => {
    const g = grid();
    expect(() => updateAcidOverflows([], [], [enemy()], [INSIDE()], g, 10)).not.toThrow();
  });

  it("advances every overflow in the level independently", () => {
    const g = grid(12);
    const a = overflow();
    const b = overflow({ room: { x: 8, y: 8, w: 2, h: 2 }, enemyIndex: 1, tiles: [{ x: 8, y: 8 }, { x: 9, y: 8 }] });
    const states = createAcidOverflowStates(2);
    updateAcidOverflows([a, b], states, [enemy(), enemy()], [INSIDE()], g, 0);
    updateAcidOverflows([a, b], states, [enemy(), enemy()], [INSIDE()], g, 5);
    expect(states[0].applied).toBe(4);
    // Nobody ever walked into the second room.
    expect(states[1].startedAt).toBeNull();
    expect(states[1].applied).toBe(0);
  });
});

describe("acidTiles", () => {
  it("lists exactly the tiles currently flooded, across every room", () => {
    const g = grid(12);
    const a = overflow();
    const b = overflow({ room: { x: 8, y: 8, w: 2, h: 2 }, enemyIndex: 1, tiles: [{ x: 8, y: 8 }, { x: 9, y: 8 }] });
    const states = createAcidOverflowStates(2);
    updateAcidOverflows([a, b], states, [enemy(), enemy()], [INSIDE(), playerAt(8.5, 8.5)], g, 0);
    updateAcidOverflows([a, b], states, [enemy(), enemy()], [INSIDE(), playerAt(8.5, 8.5)], g, 1.5);
    expect(acidTiles([a, b], states)).toEqual([{ x: 2, y: 2 }, { x: 8, y: 8 }]);
  });

  it("is empty before anything has flooded", () => {
    expect(acidTiles([overflow()], createAcidOverflowStates(1))).toEqual([]);
  });
});
