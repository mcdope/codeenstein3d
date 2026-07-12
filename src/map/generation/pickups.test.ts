// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { placeAmmoPickups } from "./pickups";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

/** Always returns 0 — every rng() draw is the "best case" (chance rolls
 * always succeed, index-based picks always take the first candidate). */
function alwaysZero(): number {
  return 0;
}

describe("placeAmmoPickups", () => {
  it("never places a pickup in the spawn room (index 0)", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    const pickups = placeAmmoPickups([spawnRoom], g, [], alwaysZero, false, false);
    expect(pickups).toEqual([]);
  });

  it("places a pickup in a non-spawn room when the roll succeeds", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], alwaysZero, false, false);
    expect(pickups).toHaveLength(1);
    expect(pickups[0].collected).toBe(false);
  });

  it("skips a room when the room-chance roll fails", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const alwaysOne = () => 0.999999;
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], alwaysOne, false, false);
    expect(pickups).toEqual([]);
  });

  it("skips a room when findPropSpot can't find an open tile", () => {
    const g = grid(20); // never carved — every tile stays a wall
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], alwaysZero, false, false);
    expect(pickups).toEqual([]);
  });

  it("defaults to bullets when there's no rocket launcher owned", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], alwaysZero, false, false);
    expect(pickups[0].kind).toBe("bullets");
    expect(pickups[0].amount).toBe(11);
  });

  it("can roll rockets when a rocket launcher is owned and the rocket-chance roll succeeds", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], alwaysZero, false, true);
    expect(pickups[0].kind).toBe("rockets");
    expect(pickups[0].amount).toBe(3);
  });

  it("stays bullets even with a rocket launcher owned when the rocket-chance roll fails", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    // First draw (room-chance) succeeds at 0; later draws for the prop spot
    // (x, y) also use 0; the final rocket-chance draw needs to fail — feed a
    // sequence that keeps early draws at 0 and only the rocket-chance draw high.
    let call = 0;
    const scripted = () => (call++ === 3 ? 0.999 : 0);
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], scripted, false, true);
    expect(pickups[0]?.kind).toBe("bullets");
  });

  it("boosts room chance and amount on a bonus level", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(10, 1, 6, 6, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    // First draw (the room-chance roll) is fixed at 0.5 — fails the normal
    // 0.22 chance but passes the bonus 0.65 one; every later draw (used by
    // findPropSpot's own candidate search) comes from a real varying rng, so
    // it isn't stuck re-picking the exact same (always-rejected) center tile.
    const midRollThenReal = (): (() => number) => {
      const real = mulberry32(1);
      let first = true;
      return () => {
        if (first) {
          first = false;
          return 0.5;
        }
        return real();
      };
    };
    expect(placeAmmoPickups([spawnRoom, room], g, [], midRollThenReal(), false, false)).toEqual([]);
    const pickups = placeAmmoPickups([spawnRoom, room], g, [], midRollThenReal(), true, false);
    expect(pickups).toHaveLength(1);
    expect(pickups[0].amount).toBe(Math.round(11 * 1.5));
  });

  it("avoids clustering multiple pickups too close together across rooms", () => {
    const g = grid(30);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const rooms = [spawnRoom, makeRoom(10, 1, 8, 8, entity()), makeRoom(10, 15, 8, 8, entity())];
    for (const r of rooms) carveRoom(g, r);
    const pickups = placeAmmoPickups(rooms, g, [], mulberry32(9), false, false);
    expect(() => pickups).not.toThrow();
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const rooms = [makeRoom(1, 1, 4, 4, entity()), makeRoom(10, 1, 8, 8, entity())];
      for (const r of rooms) carveRoom(g, r);
      return placeAmmoPickups(rooms, g, [], mulberry32(23), false, false);
    };
    expect(build()).toEqual(build());
  });
});
