// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { gateIdAt } from "./gates";
import { DOOR_TILE, type GameMap, type Gate, type Tile } from "./types";

function mapWith(gates: Gate[], size = 8): GameMap {
  const grid: Tile[][] = Array.from({ length: size }, () => new Array<Tile>(size).fill(0));
  for (const gate of gates) for (const d of gate.doors) grid[d.y][d.x] = DOOR_TILE;
  return {
    width: size,
    height: size,
    grid,
    visited: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
    shortestPathTiles: 0,
    hazards: [],
    doors: gates.flatMap((g) => g.doors),
    gates,
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    styleSet: "stone",
    secretRoomCount: 0,
    switchboardRooms: [],
    exceptionZones: [],
    vendorDepots: [],
    acidOverflows: [],
  };
}

const gate = (id: number, doors: { x: number; y: number }[]): Gate => ({
  id,
  colorIndex: id % 4,
  room: { x: 0, y: 0, w: 1, h: 1 },
  doors,
});

describe("gateIdAt", () => {
  it("resolves each gate's own door tiles", () => {
    const map = mapWith([gate(0, [{ x: 2, y: 3 }]), gate(1, [{ x: 5, y: 1 }, { x: 5, y: 2 }])]);
    expect(gateIdAt(map, 2, 3)).toBe(0);
    expect(gateIdAt(map, 5, 1)).toBe(1);
    expect(gateIdAt(map, 5, 2)).toBe(1);
  });

  it("returns -1 for a tile that is not a gate door", () => {
    const map = mapWith([gate(0, [{ x: 2, y: 3 }])]);
    expect(gateIdAt(map, 4, 4)).toBe(-1);
  });

  it("returns -1 off-grid rather than reading out of bounds", () => {
    // Every real caller checks `tile === DOOR_TILE` first, so this is a
    // belt-and-braces bound — but a typed array would happily return
    // `undefined` past its end and poison the colour lookup downstream.
    const map = mapWith([gate(0, [{ x: 2, y: 3 }])]);
    expect(gateIdAt(map, -1, 3)).toBe(-1);
    expect(gateIdAt(map, 2, -1)).toBe(-1);
    expect(gateIdAt(map, 99, 3)).toBe(-1);
    expect(gateIdAt(map, 2, 99)).toBe(-1);
  });

  it("memoises per map, and keeps two maps apart", () => {
    // The memo is a WeakMap rather than a single slot precisely so two maps
    // alive at once (both multiplayer session suites do this) do not thrash.
    const a = mapWith([gate(0, [{ x: 2, y: 3 }])]);
    const b = mapWith([gate(0, [{ x: 6, y: 6 }])]);
    expect(gateIdAt(a, 2, 3)).toBe(0);
    expect(gateIdAt(b, 2, 3)).toBe(-1); // b's gate is elsewhere
    expect(gateIdAt(b, 6, 6)).toBe(0);
    expect(gateIdAt(a, 2, 3)).toBe(0); // still right after b was queried
  });

  it("reports a gate for a door tile that has since been opened", () => {
    // Deliberate: door tiles only ever go DOOR_TILE -> 0, never gain a gate,
    // and every caller has already tested the tile value — so the entry is
    // unreachable rather than wrong, and skipping invalidation is what lets
    // this be built once per level.
    const map = mapWith([gate(0, [{ x: 2, y: 3 }])]);
    expect(gateIdAt(map, 2, 3)).toBe(0);
    map.grid[3][2] = 0;
    expect(gateIdAt(map, 2, 3)).toBe(0);
  });
});
