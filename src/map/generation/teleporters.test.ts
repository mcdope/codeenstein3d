// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity, GotoLink } from "../../parser/types";
import { TELEPORTER_TILE, type Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { placeTeleporters } from "./teleporters";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 20, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function link(overrides: Partial<GotoLink> = {}): GotoLink {
  return { label: "done", gotoLine: 3, labelLine: 8, ...overrides };
}

describe("placeTeleporters", () => {
  it("returns [] for zero gotos", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    expect(placeTeleporters([room], g, [], [], mulberry32(1))).toEqual([]);
  });

  it("returns [] for zero rooms", () => {
    const g = grid(20);
    expect(placeTeleporters([], g, [], [link()], mulberry32(1))).toEqual([]);
  });

  it("creates a reciprocal pair of teleporter pads for one goto link", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    const teleporters = placeTeleporters([room], g, [], [link()], mulberry32(1));
    expect(teleporters).toHaveLength(2);
    const [a, b] = teleporters;
    expect(a.targetX).toBe(b.x);
    expect(a.targetY).toBe(b.y);
    expect(b.targetX).toBe(a.x);
    expect(b.targetY).toBe(a.y);
    expect(a.label).toBe("done");
    expect(b.label).toBe("done");
  });

  it("marks both pad tiles as TELEPORTER_TILE on the grid", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    const teleporters = placeTeleporters([room], g, [], [link()], mulberry32(1));
    const [a, b] = teleporters;
    expect(g[Math.floor(a.y)][Math.floor(a.x)]).toBe(TELEPORTER_TILE);
    expect(g[Math.floor(b.y)][Math.floor(b.x)]).toBe(TELEPORTER_TILE);
  });

  it("resolves goto/label lines to different rooms when they fall in different entities", () => {
    const g = grid(30);
    const roomA = makeRoom(1, 1, 8, 8, entity({ startLine: 1, endLine: 10 }));
    const roomB = makeRoom(15, 1, 8, 8, entity({ startLine: 11, endLine: 20 }));
    carveRoom(g, roomA);
    carveRoom(g, roomB);
    const teleporters = placeTeleporters([roomA, roomB], g, [], [link({ gotoLine: 3, labelLine: 15 })], mulberry32(1));
    expect(teleporters).toHaveLength(2);
  });

  it("falls back to rooms[0] when a line falls outside every entity", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity({ startLine: 1, endLine: 5 }));
    carveRoom(g, room);
    const teleporters = placeTeleporters([room], g, [], [link({ gotoLine: 999, labelLine: 998 })], mulberry32(1));
    expect(teleporters).toHaveLength(2);
  });

  it("skips a link entirely when the fromRoom has no open spot", () => {
    const g = grid(20); // never carved -> every room is solid wall
    const room = makeRoom(1, 1, 10, 10, entity());
    const teleporters = placeTeleporters([room], g, [], [link()], mulberry32(1));
    expect(teleporters).toEqual([]);
  });

  it("skips a link when the toRoom has no open spot, without placing the fromSpot's pad either", () => {
    const g = grid(30);
    const fromRoom = makeRoom(1, 1, 8, 8, entity({ startLine: 1, endLine: 10 }));
    const toRoom = makeRoom(15, 1, 8, 8, entity({ startLine: 11, endLine: 20 }));
    carveRoom(g, fromRoom); // fromRoom has space
    // toRoom stays uncarved -> findPropSpot always fails there
    const before = g.map((row) => [...row]);
    const teleporters = placeTeleporters([fromRoom, toRoom], g, [], [link({ gotoLine: 3, labelLine: 15 })], mulberry32(1));
    expect(teleporters).toEqual([]);
    expect(g).toEqual(before); // fromSpot's tile was never marked TELEPORTER_TILE
  });

  it("handles a same-room goto/label pair without the two pads colliding", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    const teleporters = placeTeleporters([room], g, [], [link({ gotoLine: 3, labelLine: 8 })], mulberry32(1));
    expect(teleporters).toHaveLength(2);
    const [a, b] = teleporters;
    expect(a.x === b.x && a.y === b.y).toBe(false);
  });

  it("handles multiple goto links, producing 2 teleporters each", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 15, 15, entity({ startLine: 1, endLine: 40 }));
    carveRoom(g, room);
    const links = [link({ gotoLine: 3, labelLine: 8 }), link({ label: "again", gotoLine: 12, labelLine: 20 })];
    const teleporters = placeTeleporters([room], g, [], links, mulberry32(2));
    expect(teleporters).toHaveLength(4);
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const room = makeRoom(1, 1, 10, 10, entity());
      carveRoom(g, room);
      return placeTeleporters([room], g, [], [link()], mulberry32(55));
    };
    expect(build()).toEqual(build());
  });
});
