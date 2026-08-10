// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeEntity } from "../../parser/types";
import { BRANCH_DOOR_TILE, DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, type Room, type Tile } from "../types";
import { assertAllRoomsReachable, reachableTiles, shortestPath } from "./pathing";
import { makeRoom } from "./geometry";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

describe("reachableTiles", () => {
  it("finds every open floor tile connected to spawn", () => {
    const g = grid(5);
    g[1][1] = 0;
    g[1][2] = 0;
    g[1][3] = 0;
    const reached = reachableTiles(g, { x: 1, y: 1 }, new Set());
    expect(reached.has("1,1")).toBe(true);
    expect(reached.has("2,1")).toBe(true);
    expect(reached.has("3,1")).toBe(true);
  });

  it("does not cross a wall", () => {
    const g = grid(5);
    g[1][1] = 0;
    // g[1][2] stays a wall
    g[1][3] = 0;
    const reached = reachableTiles(g, { x: 1, y: 1 }, new Set());
    expect(reached.has("3,1")).toBe(false);
  });

  it("blocks an unopened door but passes an opened one", () => {
    const g = grid(5);
    g[1][1] = 0;
    g[1][2] = DOOR_TILE;
    g[1][3] = 0;
    const blocked = reachableTiles(g, { x: 1, y: 1 }, new Set());
    expect(blocked.has("3,1")).toBe(false);

    const opened = reachableTiles(g, { x: 1, y: 1 }, new Set(["2,1"]));
    expect(opened.has("3,1")).toBe(true);
  });

  it("stops at the grid boundary without throwing", () => {
    const g = grid(3);
    g[0][0] = 0;
    expect(() => reachableTiles(g, { x: 0, y: 0 }, new Set())).not.toThrow();
  });
});

describe("shortestPath", () => {
  it("returns 0 when spawn and exit are the same tile", () => {
    const g = grid(5);
    expect(shortestPath(g, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });

  it("counts tiles along a straight open corridor", () => {
    const g = grid(10);
    for (let x = 1; x <= 5; x++) g[1][x] = 0;
    expect(shortestPath(g, { x: 1, y: 1 }, { x: 5, y: 1 })).toBe(4);
  });

  it("treats a locked door as passable", () => {
    const g = grid(10);
    g[1][1] = 0;
    g[1][2] = DOOR_TILE;
    g[1][3] = 0;
    expect(shortestPath(g, { x: 1, y: 1 }, { x: 3, y: 1 })).toBe(2);
  });

  it("treats a secret wall and a lore terminal as blocking", () => {
    const g = grid(10);
    g[1][1] = 0;
    g[1][2] = SECRET_WALL_TILE;
    g[1][3] = 0;
    expect(shortestPath(g, { x: 1, y: 1 }, { x: 3, y: 1 })).toBe(0); // unreachable -> falls back to 0

    const g2 = grid(10);
    g2[1][1] = 0;
    g2[1][2] = LORE_TILE;
    g2[1][3] = 0;
    expect(shortestPath(g2, { x: 1, y: 1 }, { x: 3, y: 1 })).toBe(0);
  });

  it("falls back to 0 when exit is genuinely unreachable", () => {
    const g = grid(10);
    g[1][1] = 0;
    g[8][8] = 0; // isolated, never connected
    expect(shortestPath(g, { x: 1, y: 1 }, { x: 8, y: 8 })).toBe(0);
  });
});

/** A one-gate fixture: `id` owns `doors`, coloured by id. */
function gate(id: number, doors: { x: number; y: number }[]) {
  return { id, colorIndex: id % 4, room: { x: 0, y: 0, w: 1, h: 1 }, doors };
}

/** A key for `gateId` at a tile centre. */
function gateKey(x: number, y: number, gateId: number) {
  return { x, y, collected: false, gateId };
}

describe("assertAllRoomsReachable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log when every room is reachable", () => {
    const g = grid(10);
    const room: Room = makeRoom(1, 1, 4, 4, entity());
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertAllRoomsReachable(g, room.center, [room], [], []);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs a spoiler-free count when a room is unreachable", () => {
    const g = grid(10);
    const spawnRoom: Room = makeRoom(1, 1, 3, 3, entity());
    const isolatedRoom: Room = makeRoom(7, 7, 2, 2, entity());
    for (let y = spawnRoom.y; y < spawnRoom.y + spawnRoom.h; y++) {
      for (let x = spawnRoom.x; x < spawnRoom.x + spawnRoom.w; x++) g[y][x] = 0;
    }
    // isolatedRoom's tiles stay walls — never connected.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertAllRoomsReachable(g, spawnRoom.center, [spawnRoom, isolatedRoom], [], []);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("1 room(s) unreachable"));
  });

  it("counts a door as passable when a matching key is reachable before it", () => {
    const g = grid(10);
    g[1][1] = 0;
    g[1][2] = DOOR_TILE;
    g[1][3] = 0;
    const beyondDoor: Room = makeRoom(3, 1, 1, 1, entity());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The key sits on the one tile reachable before the door opens — exactly
    // what `placeKeys` guarantees in the normal (non-fallback) case.
    assertAllRoomsReachable(g, { x: 1, y: 1 }, [beyondDoor], [gate(0, [{ x: 2, y: 1 }])], [gateKey(1, 1, 0)]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs an error when a gate has no key anywhere", () => {
    const g = grid(10);
    g[1][1] = 0;
    g[1][2] = DOOR_TILE;
    g[1][3] = 0;
    const beyondDoor: Room = makeRoom(3, 1, 1, 1, entity());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same layout as above with no key for the gate. `placeKeys` now un-gates
    // a room rather than shipping this, so it should be unreachable in
    // practice — which is exactly why the check has to still catch it.
    assertAllRoomsReachable(g, { x: 1, y: 1 }, [beyondDoor], [gate(0, [{ x: 2, y: 1 }])], []);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("1 room(s) unreachable"));
  });

  it("opens a chain of two doors, each gated by its own key placed just before it", () => {
    const g = grid(20);
    g[1][1] = 0; // spawn — holds key A
    g[1][2] = DOOR_TILE; // door A
    g[1][3] = 0; // room A floor — holds key B
    g[1][4] = DOOR_TILE; // door B
    g[1][5] = 0; // room B floor
    const roomB: Room = makeRoom(5, 1, 1, 1, entity());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same "solvable in key order" shape `placeKeys` itself guarantees: key A
    // is reachable before door A, key B only becomes reachable once door A
    // is open — the iterative simulation must open door A first to ever see
    // key B, not just check "is there a key somewhere in the whole level."
    assertAllRoomsReachable(
      g,
      { x: 1, y: 1 },
      [roomB],
      [gate(0, [{ x: 2, y: 1 }]), gate(1, [{ x: 4, y: 1 }])],
      [gateKey(1, 1, 0), gateKey(3, 1, 1)],
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("holds a key for the WRONG gate against you — the check a fungible counter could not make", () => {
    // Two gates, two keys, but each key is behind the other's gate. The old
    // simulation counted keys, so two keys and two doors balanced and it
    // passed; per-gate keys make it the deadlock it actually is.
    const g = grid(20);
    g[1][1] = 0; // spawn
    g[1][2] = DOOR_TILE; // gate A
    g[1][3] = 0; // behind A — holds gate B's key
    g[1][4] = DOOR_TILE; // gate B
    g[1][5] = 0; // behind B — holds gate A's key
    const roomB: Room = makeRoom(5, 1, 1, 1, entity());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertAllRoomsReachable(
      g,
      { x: 1, y: 1 },
      [roomB],
      [gate(0, [{ x: 2, y: 1 }]), gate(1, [{ x: 4, y: 1 }])],
      [gateKey(3, 1, 1), gateKey(5, 1, 0)],
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("1 room(s) unreachable"));
  });

  it("does not depend on the order gates are tried in", () => {
    // Keys are permanent and each gate's key sits in the region reachable
    // before it opens, so gate opening is a confluent closure — the fixpoint
    // is the same whichever order the array happens to be in. The route
    // planner leans on this.
    const g = grid(20);
    g[1][1] = 0;
    g[1][2] = DOOR_TILE;
    g[1][3] = 0;
    g[1][4] = DOOR_TILE;
    g[1][5] = 0;
    const roomB: Room = makeRoom(5, 1, 1, 1, entity());
    const gates = [gate(0, [{ x: 2, y: 1 }]), gate(1, [{ x: 4, y: 1 }])];
    const keys = [gateKey(1, 1, 0), gateKey(3, 1, 1)];
    for (const order of [gates, [...gates].reverse()]) {
      const scratch = g.map((row) => [...row]);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      assertAllRoomsReachable(scratch, { x: 1, y: 1 }, [roomB], order, keys);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    }
  });
});

describe("reachableTiles — branch doors", () => {
  it("walks straight through an unopened branch door", () => {
    // A branch door costs no key, so anything behind one is reachable the
    // moment the player walks into it — treating it as blocking would make
    // `assertAllRoomsReachable` report a false isolation for a Switchboard
    // hub whose only mouth is a spoke.
    const g: Tile[][] = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 1 as Tile));
    for (let x = 1; x <= 5; x++) g[3][x] = 0;
    g[3][3] = BRANCH_DOOR_TILE;
    const seen = reachableTiles(g, { x: 1, y: 3 }, new Set());
    expect(seen.has("5,3")).toBe(true);
  });

  it("still stops at an unopened key-locked door on the same row", () => {
    const g: Tile[][] = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 1 as Tile));
    for (let x = 1; x <= 5; x++) g[3][x] = 0;
    g[3][3] = DOOR_TILE;
    const seen = reachableTiles(g, { x: 1, y: 3 }, new Set());
    expect(seen.has("5,3")).toBe(false);
  });
});
