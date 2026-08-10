// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import { BRANCH_DOOR_TILE, DOOR_TILE, type Enemy, type Point, type Room, type Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { carveHLine, carveVLine } from "./corridors";
import { placeDoors, placeKeys } from "./doorsKeys";
import { reachableTiles } from "./pathing";
import { key } from "./util";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

/** Door tiles across every gate — what `placeDoors` used to return directly. */
function doorTilesOf(gates: { doors: { x: number; y: number }[] }[]) {
  return gates.flatMap((g) => g.doors);
}

describe("placeDoors — the gate budget", () => {
  /** N private rooms in a row, each hanging off one shared corridor. */
  const manyRooms = (n: number) => {
    const g = grid(12 + n * 5);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    carveRoom(g, spawnRoom);
    const rooms = [spawnRoom];
    for (let i = 0; i < n; i++) {
      const r = makeRoom(6 + i * 5, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
      carveRoom(g, r);
      rooms.push(r);
    }
    carveHLine(g, 3, 6 + n * 5, 2);
    return { g, rooms };
  };

  it("caps the number of gates however many rooms qualify", () => {
    // The defect: `isLockableRoom` fires on every private method, so a large
    // source file produced a level made of gates. Measured on ripgrep — level 8
    // carried 64 doors and 38 keys and chained into a 120-leg route that
    // stopped 16 of 18 capture runs there; level 15 reached 2,653 doors.
    const { g, rooms } = manyRooms(30);
    const gates = placeDoors(rooms, g, { maxGates: 6 });
    expect(gates.length).toBeGreaterThan(0);
    // Counted in rooms, not door tiles: a room costs one key however many
    // mouths it has, so six gates can legitimately be more than six tiles.
    expect(gates.length).toBeLessThanOrEqual(6);
    expect(doorTilesOf(gates).length).toBeGreaterThanOrEqual(gates.length);
  });

  it("prefers the bigger room when it has to choose", () => {
    // A locked door should be worth opening; locking a bare alcove is a chore
    // with no payoff. Both rooms hang off the corridor as dead ends, so each
    // costs exactly one doorway and only worth separates them.
    const g = grid(30);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const small = makeRoom(8, 6, 2, 2, entity({ kind: "method", visibility: "private" }));
    const big = makeRoom(16, 6, 6, 6, entity({ kind: "method", visibility: "private" }));
    for (const r of [spawnRoom, small, big]) carveRoom(g, r);
    carveHLine(g, 3, 25, 2); // spine
    carveVLine(g, 3, 6, 8); // stub down to `small`
    carveVLine(g, 3, 6, 16); // stub down to `big`
    const gates = placeDoors([spawnRoom, small, big], g, { maxGates: 1 });
    const doors = doorTilesOf(gates);
    expect(doors).toHaveLength(1);
    expect(doors[0].x).toBeGreaterThanOrEqual(15); // the big room's mouth
  });

  it("keeps a gate on the critical path so progression still needs a key", () => {
    // Otherwise a capped level can put every gate on a side branch and the
    // player walks to the exit never touching a key. Note a room the path runs
    // *through* has two mouths — in and out — so it costs two of the budget,
    // which is why this asks for three rather than one.
    const g = grid(30);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const gateRoom = makeRoom(8, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    const sideRoom = makeRoom(4, 10, 8, 8, entity({ kind: "method", visibility: "private" })); // bigger, but a dead end
    for (const r of [spawnRoom, gateRoom, sideRoom]) carveRoom(g, r);
    carveHLine(g, 3, 8, 2); // spawn -> gateRoom
    carveHLine(g, 11, 24, 2); // gateRoom -> exit, the only way through
    carveVLine(g, 3, 12, 2); // spawn -> sideRoom, a dead end
    const gates = placeDoors([spawnRoom, gateRoom, sideRoom], g, {
      spawn: { x: 2, y: 2 },
      exit: { x: 23, y: 2 },
      maxGates: 3,
    });
    const doors = doorTilesOf(gates);
    // The through-room is locked, so the exit cannot be reached without a key.
    const lockedTheGate = doors.some((d) => d.y <= 4 && d.x >= 6 && d.x <= 12);
    expect(lockedTheGate).toBe(true);
  });

  it("never locks the spawn room", () => {
    const { g, rooms } = manyRooms(3);
    const gates = placeDoors(rooms, g, { maxGates: 6 });
    const doors = doorTilesOf(gates);
    for (const d of doors) expect(d.x).toBeGreaterThan(4);
  });
});

describe("placeDoors", () => {
  it("never locks the spawn room (index 0), even if it's a private method", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 5, 5, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    const gates = placeDoors([spawnRoom], g);
    const doors = doorTilesOf(gates);
    expect(doors).toEqual([]);
  });

  it("locks a private-method room's corridor mouths", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2); // corridor connecting the two, through lockedRoom's left mouth
    const gates = placeDoors([spawnRoom, lockedRoom], g);
    const doors = doorTilesOf(gates);
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) expect(g[d.y][d.x]).toBe(DOOR_TILE);
  });

  it("locks a protected-method room the same way", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "protected" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, lockedRoom], g).length).toBeGreaterThan(0);
  });

  it("does not lock a public-method room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const publicRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "public" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, publicRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, publicRoom], g)).toEqual([]);
  });

  it("does not lock a room with no visibility (undefined defaults public)", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const room = makeRoom(10, 1, 3, 3, entity({ kind: "method" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, room], g)).toEqual([]);
  });

  it("does not lock a non-method entity (class/function/global) even if marked private", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const classRoom = makeRoom(10, 1, 3, 3, entity({ kind: "class", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, classRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, classRoom], g)).toEqual([]);
  });

  it("finds mouths on all four sides of a room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const room = makeRoom(8, 8, 4, 4, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    // Corridor tiles touching all 4 sides of `room`.
    g[7][9] = 0; // top
    g[12][9] = 0; // bottom
    g[9][7] = 0; // left
    g[9][12] = 0; // right
    const gates = placeDoors([spawnRoom, room], g);
    const doors = doorTilesOf(gates);
    expect(doors).toHaveLength(4);
  });
});

describe("placeKeys", () => {
  it("returns [] when there are no doors", () => {
    const g = grid(20);
    expect(placeKeys(g, { x: 1, y: 1 }, { x: 5, y: 5 }, [], [], [], mulberry32(1))).toEqual({ keys: [], gates: [] });
  });

  it("places one key per door, reachable before that door opens", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    const gates = placeDoors([spawnRoom, lockedRoom], g);
    const doors = doorTilesOf(gates);
    expect(doors.length).toBeGreaterThan(0);

    const { keys } = placeKeys(g, spawnRoom.center, lockedRoom.center, [], gates, [], mulberry32(1));
    expect(keys).toHaveLength(doors.length);
    for (const k of keys) expect(k.collected).toBe(false);
  });

  it("never places a key inside an Exception Handling Zone", () => {
    // The `try` gauntlet is unavoidable acid, spikes and a mine, and that is
    // only defensible while entering it is a *choice*. A key past it makes
    // the toll mandatory — measured on the real campaign at 4 of the 7
    // levels that have a zone, and worth 36 recorded health-drain events on
    // stage06_pipeline.py alone.
    const g = grid(24);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(18, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 18, 2);
    // A zone hanging off the corridor: a 1-wide shaft up to a catch alcove
    // and a finally room, all reachable, all only through the shaft.
    const zone = {
      tryRect: { x: 8, y: 4, w: 1, h: 4 },
      catchRect: { x: 8, y: 9, w: 2, h: 2 },
      finallyRect: { x: 7, y: 12, w: 3, h: 3 },
    };
    for (const r of [zone.tryRect, zone.catchRect, zone.finallyRect]) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g[y][x] = 0;
    }
    g[3][8] = 0; // mouth joining the shaft to the corridor
    g[8][8] = 0; // shaft -> catch
    g[11][8] = 0; // catch -> finally

    const gates = placeDoors([spawnRoom, lockedRoom], g);

    const doors = doorTilesOf(gates);
    expect(doors.length).toBeGreaterThan(0);
    const { keys } = placeKeys(g, spawnRoom.center, lockedRoom.center, [], gates, [], mulberry32(5), [zone]);

    expect(keys.length).toBeGreaterThan(0);
    const inside = (x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean =>
      x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    for (const k of keys) {
      for (const r of [zone.tryRect, zone.catchRect, zone.finallyRect]) {
        expect(inside(Math.floor(k.x), Math.floor(k.y), r)).toBe(false);
      }
    }
  });

  it("still places every key when zones are excluded — they move, they aren't dropped", () => {
    const g = grid(24);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(18, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 18, 2);
    const zone = {
      tryRect: { x: 8, y: 4, w: 1, h: 4 },
      catchRect: { x: 8, y: 9, w: 2, h: 2 },
      finallyRect: { x: 7, y: 12, w: 3, h: 3 },
    };
    const gates = placeDoors([spawnRoom, lockedRoom], g);
    const { keys: without } = placeKeys(g, spawnRoom.center, lockedRoom.center, [], gates, [], mulberry32(5));
    const { keys: with_ } = placeKeys(g, spawnRoom.center, lockedRoom.center, [], gates, [], mulberry32(5), [zone]);
    expect(with_).toHaveLength(without.length);
  });

  it("never places a key on spawn, exit, an enemy tile, or a breakup room tile", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    const gates = placeDoors([spawnRoom, lockedRoom], g);
    const enemy = { x: spawnRoom.center.x + 0.5, y: spawnRoom.center.y + 0.5 } as Enemy;

    const { keys } = placeKeys(g, spawnRoom.center, lockedRoom.center, [enemy], gates, [], mulberry32(3));
    for (const k of keys) {
      expect(k).not.toEqual({ x: spawnRoom.center.x + 0.5, y: spawnRoom.center.y + 0.5, collected: false, gateId: 0 });
    }
  });

  it("stops placing keys for doors unreachable from the currently-opened region", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    carveRoom(g, spawnRoom);
    // A gate with no connecting corridor at all — never on the reachable
    // frontier, so it can never be keyed. It is un-gated rather than shipped
    // as a door nobody can open.
    g[15][15] = DOOR_TILE;
    const orphan = { id: 0, colorIndex: 0, room: { x: 15, y: 15, w: 1, h: 1 }, doors: [{ x: 15, y: 15 }] };
    const { keys, gates: survivors } = placeKeys(g, spawnRoom.center, spawnRoom.center, [], [orphan], [], mulberry32(1));
    expect(keys).toEqual([]);
    expect(survivors).toEqual([]);
    expect(g[15][15]).toBe(0); // reverted to floor
  });

  it("un-gates a room rather than ship a door whose key it cannot place", () => {
    const g = grid(10);
    g[1][1] = 0; // the only floor tile reachable before the door opens
    g[1][2] = DOOR_TILE;
    // spawn === exit === the only reachable tile, and both are hard-excluded,
    // so every tier of the widened search comes up empty. Stranding the room
    // is the one outcome that is not acceptable: un-gate instead.
    const gate = { id: 0, colorIndex: 0, room: { x: 3, y: 1, w: 1, h: 1 }, doors: [{ x: 2, y: 1 }] };
    const { keys, gates: survivors } = placeKeys(g, { x: 1, y: 1 }, { x: 1, y: 1 }, [], [gate], [], mulberry32(1));
    expect(keys).toEqual([]);
    expect(survivors).toEqual([]);
    expect(g[1][2]).toBe(0); // the door is gone, so the room is still enterable
  });

  it("finds a spot by relaxing enemy/breakup exclusions rather than giving up", () => {
    // Two reachable floor tiles: spawn (hard-excluded) and one holding an
    // enemy (a convenience exclusion). An enemy standing on a key does not
    // stop a player walking over it, so tier 3 uses that tile instead of
    // stranding the room.
    const g = grid(10);
    g[1][1] = 0;
    g[1][2] = 0;
    g[1][3] = DOOR_TILE;
    const enemy = { x: 2.5, y: 1.5 } as never;
    const gate = { id: 0, colorIndex: 0, room: { x: 4, y: 1, w: 1, h: 1 }, doors: [{ x: 3, y: 1 }] };
    const { keys, gates: survivors } = placeKeys(g, { x: 1, y: 1 }, { x: 9, y: 9 }, [enemy], [gate], [], mulberry32(1));
    expect(keys).toHaveLength(1);
    expect(survivors).toHaveLength(1);
    expect(g[1][3]).toBe(DOOR_TILE); // still gated
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const spawnRoom = makeRoom(1, 1, 3, 3, entity());
      const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
      carveRoom(g, spawnRoom);
      carveRoom(g, lockedRoom);
      carveHLine(g, 3, 10, 2);
      const gates = placeDoors([spawnRoom, lockedRoom], g);
      return placeKeys(g, spawnRoom.center, lockedRoom.center, [], gates, [], mulberry32(77));
    };
    expect(build()).toEqual(build());
  });

  it("handles a room chain with multiple doors in sequence (key-order solvability)", () => {
    const g = grid(30);
    const rooms: Room[] = [
      makeRoom(1, 1, 3, 3, entity()),
      makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" })),
      makeRoom(20, 1, 3, 3, entity({ kind: "method", visibility: "protected" })),
    ];
    for (const r of rooms) carveRoom(g, r);
    carveHLine(g, 3, 10, 2);
    carveHLine(g, 13, 20, 2);
    const gates = placeDoors(rooms, g);
    const doors = doorTilesOf(gates);
    expect(doors.length).toBeGreaterThanOrEqual(2);
    const { keys } = placeKeys(g, rooms[0].center, rooms[2].center, [], gates, [], mulberry32(5));
    expect(keys.length).toBeGreaterThan(0);
  });

  it("confines each later key to area newly reached since the previous door, never back in the initial region", () => {
    const g = grid(30);
    const rooms: Room[] = [
      makeRoom(1, 1, 3, 3, entity()),
      makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" })),
      makeRoom(20, 1, 3, 3, entity({ kind: "method", visibility: "protected" })),
    ];
    for (const r of rooms) carveRoom(g, r);
    carveHLine(g, 3, 10, 2);
    carveHLine(g, 13, 20, 2);
    const gates = placeDoors(rooms, g);
    const doors = doorTilesOf(gates);
    expect(doors.length).toBeGreaterThanOrEqual(2);

    // Snapshot of what's reachable before any door opens at all — under the
    // old cumulative-pool bug, later keys could land back in here.
    const initialReachable = reachableTiles(g, rooms[0].center, new Set());

    const { keys } = placeKeys(g, rooms[0].center, rooms[2].center, [], gates, [], mulberry32(5));
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys.slice(1)) {
      const tileKey = key({ x: Math.floor(k.x), y: Math.floor(k.y) });
      expect(initialReachable.has(tileKey)).toBe(false);
    }
  });

  it("falls back to the full reachable set when the newly-opened area has no usable tile left", () => {
    const g = grid(10);
    // A straight corridor: spawn, two spare floor tiles, door1, an
    // enemy-occupied floor tile (the only tile door1's opening reveals),
    // door2. Door2's newly-opened area is just the door1 tile (excluded,
    // not floor) and the enemy tile (excluded, already used) — empty of
    // usable candidates — so its key must fall back to the wider
    // (still-unused-somewhere) reachable pool instead of being dropped.
    g[1][1] = 0; // spawn
    g[1][2] = 0; // spare floor A
    g[1][3] = 0; // spare floor B
    g[1][4] = DOOR_TILE; // door1
    g[1][5] = 0; // enemy-occupied floor (door1's newly-opened area)
    g[1][6] = DOOR_TILE; // door2
    // Two separate gates, so two keys — one each, not one per doorway.
    const twoGates = [
      { id: 0, colorIndex: 0, room: { x: 5, y: 1, w: 1, h: 1 }, doors: [{ x: 4, y: 1 }] },
      { id: 1, colorIndex: 1, room: { x: 7, y: 1, w: 1, h: 1 }, doors: [{ x: 6, y: 1 }] },
    ];
    const enemy = { x: 5.5, y: 1.5 } as Enemy;

    const { keys } = placeKeys(g, { x: 1, y: 1 }, { x: 9, y: 9 }, [enemy], twoGates, [], mulberry32(1));
    expect(keys).toHaveLength(2);
  });
});

describe("placeDoors — Switchboard branch doors", () => {
  it("never locks a spoke mouth, because a branch door isn't plain floor", () => {
    // `roomMouths` only considers a mouth whose outward tile is plain floor,
    // so a `BRANCH_DOOR_TILE` mouth is skipped with no explicit guard — which
    // is what keeps a private method with a five-case switch from turning into
    // six locked doors and six keys.
    const size = 16;
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
    const spawnRoom = makeRoom(1, 1, 3, 3, entity({ name: "spawn" }));
    const room = makeRoom(6, 6, 4, 4, entity({ name: "m", kind: "method", visibility: "private" }));
    for (const r of [spawnRoom, room]) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g[y][x] = 0;
    }
    // One real corridor mouth (plain floor) and one spoke mouth (branch door).
    g[5][7] = 0;
    g[4][7] = 0;
    g[10][7] = BRANCH_DOOR_TILE;
    g[11][7] = 0;

    const gates = placeDoors([spawnRoom, room], g);

    const doors = doorTilesOf(gates);
    expect(doors).toContainEqual({ x: 7, y: 5 });
    expect(doors).not.toContainEqual({ x: 7, y: 10 });
    expect(g[10][7]).toBe(BRANCH_DOOR_TILE);
  });
});

describe("placeKeys — one key per doorway", () => {
  it("places one key for a multi-tile doorway, not one per tile", () => {
    // `placeDoors` locks every corridor mouth, so a corridor running flush
    // along a room's wall yields a whole column of door tiles. That's one
    // gate to a player, and the engine opens it for one key — the key count
    // has to agree or the level's economy is nonsense (see `doorwayTiles`).
    const size = 20;
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
    // Open area on the left (spawn side), a room on the right, and a 4-tile
    // shared boundary between them that is entirely door.
    for (let y = 4; y <= 12; y++) for (let x = 2; x <= 7; x++) g[y][x] = 0;
    for (let y = 4; y <= 12; y++) for (let x = 9; x <= 15; x++) g[y][x] = 0;
    const doors: Point[] = [];
    for (let y = 6; y <= 9; y++) {
      g[y][8] = DOOR_TILE;
      doors.push({ x: 8, y });
    }
    const oneGate = [{ id: 0, colorIndex: 0, room: { x: 9, y: 4, w: 6, h: 10 }, doors }];
    const { keys } = placeKeys(g, { x: 3, y: 5 }, { x: 14, y: 11 }, [], oneGate, [], mulberry32(1));
    expect(keys).toHaveLength(1);
  });

  it("places ONE key for a room with two separate doorways — the defect this fixes", () => {
    const size = 20;
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
    for (let y = 4; y <= 14; y++) for (let x = 2; x <= 7; x++) g[y][x] = 0;
    for (let y = 4; y <= 14; y++) for (let x = 9; x <= 15; x++) g[y][x] = 0;
    const doors: Point[] = [];
    for (const y of [6, 7, 11, 12]) {
      g[y][8] = DOOR_TILE;
      doors.push({ x: 8, y });
    }
    // (8,6)-(8,7) and (8,11)-(8,12) are two runs separated by wall — two
    // doorways into one room. That used to cost two keys, which is exactly the
    // "pay twice to enter one space" complaint; one room is now one key.
    const oneGate = [{ id: 0, colorIndex: 0, room: { x: 9, y: 4, w: 7, h: 11 }, doors }];
    const { keys } = placeKeys(g, { x: 3, y: 5 }, { x: 14, y: 13 }, [], oneGate, [], mulberry32(2));
    expect(keys).toHaveLength(1);
    expect(keys[0].gateId).toBe(0);
  });
});
