// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `nextKeyStep` against hand-built grids. Pure — no engine, no canvas, no rng —
 * which is the reason the fixpoint lives in its own module rather than inside
 * `cueLockedDoorHint`: the cases that matter here are *map shapes*, and driving
 * them through a real engine would mean walking a player into a door for each.
 *
 * Grids are `g[y][x]`. `0` floor, `1` wall, `3` door.
 */
import { describe, expect, it } from "vitest";

import { DOOR_TILE, type GameMap, type Gate, type KeyItem } from "../map/types";
import { nextKeyStep } from "./keyRoute";

/** A walled 12x12 room with whatever is layered on top. */
function grid(): number[][] {
  const size = 12;
  const g: number[][] = [];
  for (let y = 0; y < size; y++) {
    g.push([]);
    for (let x = 0; x < size; x++) g[y].push(y === 0 || x === 0 || y === size - 1 || x === size - 1 ? 1 : 0);
  }
  return g;
}

function map(g: number[][], gates: Gate[], keys: KeyItem[]): GameMap {
  return { width: 12, height: 12, grid: g, gates, keys } as unknown as GameMap;
}

const gate = (id: number, colorIndex: number, door: { x: number; y: number }): Gate =>
  ({ id, colorIndex, room: { x: 0, y: 0, w: 1, h: 1 }, doors: [door] }) as Gate;

const key = (gateId: number, x: number, y: number): KeyItem => ({ x: x + 0.5, y: y + 0.5, collected: false, gateId });

/** Seals (1..2, 1..2) behind a single door at (2,3). */
function pocket(g: number[][]): void {
  g[3][2] = DOOR_TILE;
  g[1][3] = 1;
  g[2][3] = 1;
  g[3][3] = 1;
  g[3][1] = 1;
}

const FROM = { x: 6, y: 6 };

describe("nextKeyStep", () => {
  it("returns the asked-for key when it can simply be walked to", () => {
    const g = grid();
    const m = map(g, [gate(0, 0, { x: 9, y: 6 })], [key(0, 5, 9)]);
    expect(nextKeyStep(m, FROM, 0, new Set())).toEqual({ key: m.keys[0], direct: true });
  });

  it("returns the blocking key when the asked-for one is behind another gate", () => {
    // The reported defect: gate 0's key sits inside gate 1's pocket, so the
    // honest answer is "fetch gate 1's key" rather than nothing at all.
    const g = grid();
    pocket(g);
    g[6][9] = DOOR_TILE;
    const m = map(g, [gate(0, 3, { x: 9, y: 6 }), gate(1, 2, { x: 2, y: 3 })], [key(0, 1, 1), key(1, 5, 9)]);
    const step = nextKeyStep(m, FROM, 0, new Set());
    expect(step).toEqual({ key: m.keys[1], direct: false });
  });

  it("treats a door the player already holds the key for as open", () => {
    // `PathField`'s `isWall` calls a still-`DOOR_TILE` solid whether or not its
    // key is in hand. Without this, the hint would send a player after a key
    // they are already carrying.
    const g = grid();
    pocket(g);
    g[6][9] = DOOR_TILE;
    const m = map(g, [gate(0, 3, { x: 9, y: 6 }), gate(1, 2, { x: 2, y: 3 })], [key(0, 1, 1), key(1, 5, 9)]);
    expect(nextKeyStep(m, FROM, 0, new Set([1]))).toEqual({ key: m.keys[0], direct: true });
  });

  it("prefers a lead the target actually depends on over a merely nearer one", () => {
    // Gate 2's key is closer, but opening gate 2 does nothing for gate 0 —
    // naming it would make the toast's "first" a lie. Gate 1 is the dependency.
    const g = grid();
    pocket(g);
    g[6][9] = DOOR_TILE;
    g[8][7] = DOOR_TILE; // gate 2, an unrelated side room
    const m = map(
      g,
      [gate(0, 3, { x: 9, y: 6 }), gate(1, 2, { x: 2, y: 3 }), gate(2, 1, { x: 7, y: 8 })],
      [key(0, 1, 1), key(1, 1, 9), key(2, 6, 7)],
    );
    const step = nextKeyStep(m, FROM, 0, new Set());
    expect(step?.key.gateId).toBe(1);
    expect(step?.direct).toBe(false);
  });

  it("returns null when the asked-for key is sealed off entirely", () => {
    // Not a chain — genuinely walled in, with no other key to offer. Silence
    // is the honest answer, and it is what the hint did before this existed.
    const g = grid();
    g[6][9] = DOOR_TILE;
    for (let x = 1; x <= 3; x++) g[4][x] = 1;
    g[3][1] = 1;
    g[3][3] = 1;
    g[2][1] = 1;
    g[2][3] = 1;
    g[1][1] = 1;
    g[1][3] = 1; // (2,1..3) is a sealed column
    const m = map(g, [gate(0, 0, { x: 9, y: 6 })], [key(0, 2, 2)]);
    expect(nextKeyStep(m, FROM, 0, new Set())).toBeNull();
  });

  it("returns null when the gate's key has already been collected", () => {
    const g = grid();
    const m = map(g, [gate(0, 0, { x: 9, y: 6 })], [{ ...key(0, 5, 9), collected: true }]);
    expect(nextKeyStep(m, FROM, 0, new Set())).toBeNull();
  });

  it("never offers a key the player is already holding as the lead", () => {
    // Holding a gate means its key is off the floor; pointing at it would send
    // the player to bare ground.
    const g = grid();
    pocket(g);
    g[6][9] = DOOR_TILE;
    const m = map(g, [gate(0, 3, { x: 9, y: 6 }), gate(1, 2, { x: 2, y: 3 })], [key(0, 1, 1), key(1, 5, 9)]);
    const step = nextKeyStep(m, FROM, 0, new Set([1]));
    expect(step?.key.gateId).not.toBe(1);
  });
});
