// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Rect, Room, Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { carveHLine, carveVLine, connectLoops, connectRooms, isChokePoint, isCorridorFloor } from "./corridors";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function reachable(g: Tile[][], from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const k = `${p.x},${p.y}`;
    if (visited.has(k)) continue;
    if (p.y < 0 || p.y >= g.length || p.x < 0 || p.x >= g[p.y].length) continue;
    if (g[p.y][p.x] !== 0) continue;
    visited.add(k);
    if (p.x === to.x && p.y === to.y) return true;
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
  }
  return false;
}

describe("connectRooms", () => {
  it("connects consecutive rooms with a short (single-turn) corridor", () => {
    const g = grid(30);
    const r1 = makeRoom(1, 1, 4, 4, entity());
    const r2 = makeRoom(7, 1, 4, 4, entity());
    carveRoom(g, r1);
    carveRoom(g, r2);
    // manhattan(center1, center2) = 6, at/under CORRIDOR_JOG_THRESHOLD (10).
    connectRooms([r1, r2], g, mulberry32(1));
    expect(reachable(g, r1.center, r2.center)).toBe(true);
  });

  it("connects consecutive rooms with a long (jogged) corridor", () => {
    const g = grid(30);
    const r1 = makeRoom(1, 1, 4, 4, entity());
    const r2 = makeRoom(24, 24, 4, 4, entity());
    carveRoom(g, r1);
    carveRoom(g, r2);
    connectRooms([r1, r2], g, mulberry32(1));
    expect(reachable(g, r1.center, r2.center)).toBe(true);
  });

  it("chains 3+ rooms room[i] <-> room[i-1], not every pair", () => {
    const g = grid(40);
    const rooms: Room[] = [makeRoom(1, 1, 4, 4, entity()), makeRoom(15, 1, 4, 4, entity()), makeRoom(30, 30, 4, 4, entity())];
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(2));
    expect(reachable(g, rooms[0].center, rooms[1].center)).toBe(true);
    expect(reachable(g, rooms[1].center, rooms[2].center)).toBe(true);
    // Transitively reachable end-to-end through the chain too.
    expect(reachable(g, rooms[0].center, rooms[2].center)).toBe(true);
  });

  it("does nothing for a single room (no pairs to connect)", () => {
    const g = grid(10);
    const r = makeRoom(1, 1, 4, 4, entity());
    carveRoom(g, r);
    const before = g.map((row) => [...row]);
    connectRooms([r], g, mulberry32(1));
    expect(g).toEqual(before);
  });

  it("does nothing for zero rooms", () => {
    const g = grid(10);
    expect(() => connectRooms([], g, mulberry32(1))).not.toThrow();
  });

  it("alternates jog direction across multiple long corridors without throwing", () => {
    const g = grid(50);
    const rooms: Room[] = [
      makeRoom(1, 1, 4, 4, entity()),
      makeRoom(45, 1, 4, 4, entity()),
      makeRoom(1, 45, 4, 4, entity()),
    ];
    for (const r of rooms) carveRoom(g, r);
    expect(() => connectRooms(rooms, g, mulberry32(3))).not.toThrow();
    expect(reachable(g, rooms[0].center, rooms[1].center)).toBe(true);
    expect(reachable(g, rooms[1].center, rooms[2].center)).toBe(true);
  });
});

describe("connectLoops", () => {
  const privateMethod = (): CodeEntity => entity({ kind: "method", visibility: "private" });

  /** Four public rooms round a square, so rooms 0 and 3 — three apart along
   * the chain — end up physically adjacent. */
  function squareOfRooms(entities: CodeEntity[]): Room[] {
    return [
      makeRoom(2, 2, 6, 6, entities[0]),
      makeRoom(20, 2, 6, 6, entities[1]),
      makeRoom(20, 20, 6, 6, entities[2]),
      makeRoom(2, 20, 6, 6, entities[3]),
    ];
  }

  it("joins rooms that are close in space but far apart along the chain", () => {
    const g = grid(40);
    const rooms = squareOfRooms([entity(), entity(), entity(), entity()]);
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(5));

    const joined = connectLoops(rooms, g, mulberry32(5));
    expect(joined).toHaveLength(1);
    const [i, j] = joined[0];
    expect(Math.abs(i - j)).toBeGreaterThanOrEqual(2);
    expect(reachable(g, rooms[i].center, rooms[j].center)).toBe(true);
  });

  it("never uses a locked room as a shortcut endpoint", () => {
    // Only room 0 is unlockable (the spawn room never locks), so no candidate
    // pair has two open ends and nothing can be carved.
    const g = grid(40);
    const rooms = squareOfRooms([entity(), privateMethod(), privateMethod(), privateMethod()]);
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(6));

    const before = g.map((row) => [...row]);
    expect(connectLoops(rooms, g, mulberry32(6))).toEqual([]);
    expect(g).toEqual(before);
  });

  it("undoes a shortcut that would open a new doorway into a locked room", () => {
    // Rooms 0 and 3 are 28 tiles apart on the same row with locked room 2
    // sitting between them, so the only candidate shortcut runs straight
    // through it — which would turn its two side walls into doorways, and
    // therefore cost the player another key rather than saving them a walk.
    const g = grid(40);
    const rooms: Room[] = [
      makeRoom(2, 2, 6, 6, entity()),
      makeRoom(2, 30, 6, 6, entity()),
      makeRoom(18, 2, 6, 6, privateMethod()),
      makeRoom(30, 2, 6, 6, entity()),
    ];
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(7));

    const before = g.map((row) => [...row]);
    expect(connectLoops(rooms, g, mulberry32(7))).toEqual([]);
    // Reverted tile for tile, not merely "no pair returned".
    expect(g).toEqual(before);
  });

  it("does nothing when there are too few rooms to earn a shortcut", () => {
    const g = grid(40);
    const rooms = [makeRoom(2, 2, 6, 6, entity()), makeRoom(20, 2, 6, 6, entity())];
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(8));

    const before = g.map((row) => [...row]);
    expect(connectLoops(rooms, g, mulberry32(8))).toEqual([]);
    expect(g).toEqual(before);
  });

  it("leaves rooms too far apart alone rather than carving a long 'shortcut'", () => {
    const g = grid(80);
    const rooms: Room[] = [
      makeRoom(2, 2, 6, 6, entity()),
      makeRoom(40, 2, 6, 6, entity()),
      makeRoom(40, 40, 6, 6, entity()),
      makeRoom(2, 70, 6, 6, entity()),
    ];
    for (const r of rooms) carveRoom(g, r);
    connectRooms(rooms, g, mulberry32(9));

    const before = g.map((row) => [...row]);
    expect(connectLoops(rooms, g, mulberry32(9))).toEqual([]);
    expect(g).toEqual(before);
  });
});

describe("carveHLine / carveVLine", () => {
  it("carves a horizontal line regardless of endpoint order", () => {
    const g = grid(10);
    carveHLine(g, 5, 2, 3);
    for (let x = 2; x <= 5; x++) expect(g[3][x]).toBe(0);
  });

  it("carves a vertical line regardless of endpoint order", () => {
    const g = grid(10);
    carveVLine(g, 6, 1, 4);
    for (let y = 1; y <= 6; y++) expect(g[y][4]).toBe(0);
  });
});

describe("isCorridorFloor", () => {
  it("is true for a floor tile outside every room and breakup room", () => {
    const g = grid(10);
    g[5][5] = 0;
    expect(isCorridorFloor(5, 5, g, [], [])).toBe(true);
  });

  it("is false for a wall tile", () => {
    const g = grid(10);
    expect(isCorridorFloor(5, 5, g, [], [])).toBe(false);
  });

  it("is false for a floor tile inside a room", () => {
    const g = grid(10);
    const room = makeRoom(2, 2, 4, 4, entity());
    carveRoom(g, room);
    expect(isCorridorFloor(3, 3, g, [room], [])).toBe(false);
  });

  it("is false for a floor tile inside a breakup room", () => {
    const g = grid(10);
    g[3][3] = 0;
    const breakup: Rect = { x: 2, y: 2, w: 4, h: 4 };
    expect(isCorridorFloor(3, 3, g, [], [breakup])).toBe(false);
  });
});

describe("isChokePoint", () => {
  it("is true for a horizontal 1-wide passage", () => {
    const g = grid(10);
    g[5][4] = 0;
    g[5][5] = 0;
    g[5][6] = 0;
    expect(isChokePoint(5, 5, g)).toBe(true);
  });

  it("is true for a vertical 1-wide passage", () => {
    const g = grid(10);
    g[4][5] = 0;
    g[5][5] = 0;
    g[6][5] = 0;
    expect(isChokePoint(5, 5, g)).toBe(true);
  });

  it("is false in the open interior of a room (all 4 sides open)", () => {
    const g = grid(10);
    const room = makeRoom(2, 2, 6, 6, entity());
    carveRoom(g, room);
    expect(isChokePoint(5, 5, g)).toBe(false);
  });

  it("is false at a corner (only 2 adjacent sides open)", () => {
    const g = grid(10);
    g[5][5] = 0;
    g[5][6] = 0;
    g[6][5] = 0;
    expect(isChokePoint(5, 5, g)).toBe(false);
  });

  it("treats the grid boundary as blocked", () => {
    const g = grid(10);
    g[0][0] = 0;
    g[0][1] = 0;
    expect(isChokePoint(0, 0, g)).toBe(false);
  });
});
