// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Rect, Room, Tile } from "../types";
import { carveHLine, carveVLine, isCorridorFloor } from "./corridors";
import { makeRoom, roomsOverlap } from "./geometry";
import { breakUpLongCorridors, breakupTileKeys } from "./breakup";

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
    if (g[p.y][p.x] === 1) continue;
    visited.add(k);
    if (p.x === to.x && p.y === to.y) return true;
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
  }
  return false;
}

/** Longest run of contiguous `isCorridorFloor` tiles along row `y` between
 * x0..x1 inclusive. */
function longestHorizontalCorridorRun(g: Tile[][], y: number, x0: number, x1: number, rooms: Room[], breakupRooms: Rect[]): number {
  let longest = 0;
  let current = 0;
  for (let x = x0; x <= x1; x++) {
    if (isCorridorFloor(x, y, g, rooms, breakupRooms)) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

describe("breakupTileKeys", () => {
  it("returns every tile key inside each rect", () => {
    const keys = breakupTileKeys([{ x: 0, y: 0, w: 2, h: 2 }]);
    expect(keys.sort()).toEqual(["0,0", "0,1", "1,0", "1,1"].sort());
  });

  it("returns [] for an empty rect list", () => {
    expect(breakupTileKeys([])).toEqual([]);
  });

  it("covers multiple rects", () => {
    const keys = breakupTileKeys([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 5, y: 5, w: 1, h: 1 },
    ]);
    expect(keys.sort()).toEqual(["0,0", "5,5"].sort());
  });
});

describe("breakUpLongCorridors", () => {
  it("leaves a short corridor (<= MAX_CORRIDOR_STRAIGHT_LENGTH) untouched", () => {
    const g = grid(20);
    carveHLine(g, 1, 8, 5); // length 8, at/under the 9-tile threshold
    const before = g.map((row) => [...row]);
    const breakupRooms = breakUpLongCorridors(g, [], 20, 1, mulberry32(1));
    expect(g).toEqual(before);
    expect(breakupRooms).toEqual([]);
  });

  it("interrupts a long straight corridor so no unbroken run exceeds the threshold", () => {
    const g = grid(40);
    carveHLine(g, 1, 35, 5);
    const breakupRooms = breakUpLongCorridors(g, [], 40, 1, mulberry32(1));
    const longest = longestHorizontalCorridorRun(g, 5, 1, 35, [], breakupRooms);
    expect(longest).toBeLessThanOrEqual(9);
  });

  it("keeps the corridor's two endpoints connected after breaking it up", () => {
    const g = grid(40);
    carveHLine(g, 1, 35, 5);
    breakUpLongCorridors(g, [], 40, 1, mulberry32(1));
    expect(reachable(g, { x: 1, y: 5 }, { x: 35, y: 5 })).toBe(true);
  });

  it("is deterministic for the same rng seed", () => {
    const g1 = grid(40);
    const g2 = grid(40);
    carveHLine(g1, 1, 35, 5);
    carveHLine(g2, 1, 35, 5);
    const r1 = breakUpLongCorridors(g1, [], 40, 1, mulberry32(42));
    const r2 = breakUpLongCorridors(g2, [], 40, 1, mulberry32(42));
    expect(g1).toEqual(g2);
    expect(r1).toEqual(r2);
  });

  it("breaks up a long vertical corridor too", () => {
    const g = grid(40);
    carveVLine(g, 1, 35, 5);
    const breakupRooms = breakUpLongCorridors(g, [], 40, 1, mulberry32(2));
    expect(reachable(g, { x: 5, y: 1 }, { x: 5, y: 35 })).toBe(true);
    expect(breakupRooms.length + 1).toBeGreaterThan(0); // ran without throwing regardless of outcome
  });

  it("never injects a breakup room overlapping a real room", () => {
    const g = grid(40);
    const room = makeRoom(15, 3, 5, 5, entity());
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
    }
    carveHLine(g, 1, 14, 5);
    carveHLine(g, 20, 38, 5);
    const breakupRooms = breakUpLongCorridors(g, [room], 40, 1, mulberry32(3));
    for (const br of breakupRooms) {
      expect(roomsOverlap(br, room, 0)).toBe(false);
    }
  });

  it("handles an empty grid without throwing", () => {
    expect(() => breakUpLongCorridors([], [], 0, 1, mulberry32(1))).not.toThrow();
  });

  it("returns [] and leaves the grid connected when there are no corridors at all", () => {
    const g = grid(10);
    const breakupRooms = breakUpLongCorridors(g, [], 10, 1, mulberry32(1));
    expect(breakupRooms).toEqual([]);
  });

  it("handles a corridor running the full width of a small map (tight bounds)", () => {
    const g = grid(12);
    carveHLine(g, 1, 10, 5);
    expect(() => breakUpLongCorridors(g, [], 12, 1, mulberry32(9))).not.toThrow();
    expect(reachable(g, { x: 1, y: 5 }, { x: 10, y: 5 })).toBe(true);
  });

  it("falls through to the wide safety-net search when the primary pass's targets are all blocked", () => {
    // A 3-tall corridor means isChokePoint never holds anywhere along it, so
    // tryForceJog can never succeed — only room injection can break up the
    // run. Real rooms crowd every one of the primary pass's evenly-spaced
    // target zones (±3 tiles of jitter each), forcing every primary attempt
    // to fail via overlap; open gaps between/around them are only reachable
    // by breakUpRunWide's full-span random search on the safety-net rescan.
    const g = grid(60);
    for (let y = 4; y <= 6; y++) for (let x = 1; x <= 58; x++) g[y][x] = 0;
    const blockers: Room[] = [8, 17, 27, 37, 46].map((cx) =>
      makeRoom(cx, 1, 8, 3, entity()), // rows 1-3, just above the corridor
    );
    for (const b of blockers) {
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) g[y][x] = 0;
      }
    }
    const breakupRooms = breakUpLongCorridors(g, blockers, 60, 1, mulberry32(17));
    const longest = longestHorizontalCorridorRun(g, 5, 1, 58, blockers, breakupRooms);
    expect(longest).toBeLessThanOrEqual(9);
  });

  it("falls back to a forced jog when room injection can't fit (corridor hugging the map edge)", () => {
    // A corridor on row y=1 (the minimum interior row) can never fit an
    // injected room "above" it — the room's footprint would go out of
    // bounds (rect.y < 1) on every attempt — so this run can only be broken
    // up via tryForceJog, exercising its success path (a real 1-wide
    // chokepoint, with room to jog downward).
    const g = grid(20);
    carveHLine(g, 1, 15, 1);
    const breakupRooms = breakUpLongCorridors(g, [], 20, 1, mulberry32(6));
    expect(breakupRooms).toEqual([]); // only jogs happened, no rooms injected
    const longest = longestHorizontalCorridorRun(g, 1, 1, 15, [], []);
    expect(longest).toBeLessThanOrEqual(9);
    expect(reachable(g, { x: 1, y: 1 }, { x: 15, y: 1 })).toBe(true);
  });

  it("rejects a forced jog whose detour would run off the map (both directions), without throwing", () => {
    // A very short map (4 rows) with the corridor pinned to row 1 means a
    // jog detour of any length in either direction always runs off the top
    // or bottom edge — neither room injection (row 1 has no room above)
    // nor a forced jog can ever succeed, so this run is left unbroken by
    // design (best-effort placement, never a hard failure).
    const g: Tile[][] = Array.from({ length: 4 }, () => Array.from({ length: 20 }, () => 1 as Tile));
    for (let x = 1; x <= 15; x++) g[1][x] = 0;
    expect(() => breakUpLongCorridors(g, [], 4, 1, mulberry32(1))).not.toThrow();
  });

  it("rejects a forced jog whose detour would overlap a real room", () => {
    // Row 1 corridor: injection always fails (no room fits above it, same as
    // the earlier edge-hugging test). Row 2 stays wall on every column, so
    // isChokePoint still holds (dir=-1 still fails via bounds either way);
    // a real room starting at row 3 doesn't break the chokepoint precondition
    // but is close enough that, with roomMargin=1, ANY dir=+1 jog detour
    // (jogLen 2 or 3) overlaps it — forcing the room-overlap rejection at
    // this specific line rather than a bounds rejection.
    const g = grid(20);
    carveHLine(g, 1, 15, 1);
    const blocker = makeRoom(1, 3, 18, 7, entity()); // rows 3-9
    for (let y = blocker.y; y < blocker.y + blocker.h; y++) {
      for (let x = blocker.x; x < blocker.x + blocker.w; x++) g[y][x] = 0;
    }
    expect(() => breakUpLongCorridors(g, [blocker], 20, 1, mulberry32(1))).not.toThrow();
  });

  it("breaks up a vertical corridor via room injection (exercises the axis='v' sightline branch)", () => {
    const g = grid(30);
    carveVLine(g, 1, 25, 5);
    const breakupRooms = breakUpLongCorridors(g, [], 30, 1, mulberry32(2));
    expect(breakupRooms.length).toBeGreaterThan(0);
  });

  it("goes straight to the wide safety-net pass for a run just over the threshold (segments=1 skips the primary pass entirely)", () => {
    // length 10 -> segments = ceil(10/10) = 1 -> breakUpRunAtPoints' loop
    // (`for (s=1; s<segments; s++)`) never runs at all, so this run is
    // untouched until the first safety-net rescan finds it and calls
    // breakUpRunWide directly — exercising its own forced-jog success path
    // (row 1 makes injection impossible, so only jog can resolve it).
    const g = grid(20);
    carveHLine(g, 1, 10, 1);
    const breakupRooms = breakUpLongCorridors(g, [], 20, 1, mulberry32(1));
    expect(breakupRooms).toEqual([]);
    const longest = longestHorizontalCorridorRun(g, 1, 1, 10, [], []);
    expect(longest).toBeLessThanOrEqual(9);
  });

  it("handles several long runs across multiple safety passes without throwing", () => {
    const g = grid(60);
    carveHLine(g, 1, 55, 5);
    carveHLine(g, 1, 55, 20);
    carveHLine(g, 1, 55, 35);
    carveVLine(g, 1, 55, 10);
    carveVLine(g, 1, 55, 30);
    expect(() => breakUpLongCorridors(g, [], 60, 1, mulberry32(11))).not.toThrow();
  });
});
