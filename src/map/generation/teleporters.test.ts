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
    // Two rooms, and every link crosses between them. Cross-room pairs are the
    // ones that actually shortcut a level and are never capped — this used to
    // use one room for both links, which now exercises the in-room cap instead
    // (see the test below) rather than the "one pair per link" rule it means.
    const g = grid(30);
    const a = makeRoom(1, 1, 10, 10, entity({ startLine: 1, endLine: 10 }));
    const b = makeRoom(15, 1, 10, 10, entity({ name: "g", startLine: 20, endLine: 30 }));
    carveRoom(g, a);
    carveRoom(g, b);
    const links = [link({ gotoLine: 3, labelLine: 22 }), link({ label: "again", gotoLine: 5, labelLine: 25 })];
    const teleporters = placeTeleporters([a, b], g, [], links, mulberry32(2));
    expect(teleporters).toHaveLength(4);
  });

  it("caps pairs whose two pads land in the same room, and never caps cross-room ones", () => {
    // The complaint this implements: a `goto` whose label is in the same
    // function (C's `goto out;` error handling) warps you a few tiles across
    // the room you are already in, which reads as disorienting rather than as a
    // shortcut. Measured across the corpus it is 68-100% of every pair
    // generated, and one vim level produced 39 of them. One is kept on purpose
    // — the mechanic is a joke about `goto` being evil and the joke should still
    // land occasionally.
    const g = grid(30);
    const a = makeRoom(1, 1, 12, 12, entity({ startLine: 1, endLine: 10 }));
    const b = makeRoom(16, 1, 12, 12, entity({ name: "g", startLine: 20, endLine: 30 }));
    carveRoom(g, a);
    carveRoom(g, b);
    const inRoom = [
      link({ gotoLine: 2, labelLine: 4 }),
      link({ label: "two", gotoLine: 5, labelLine: 7 }),
      link({ label: "three", gotoLine: 6, labelLine: 8 }),
    ];
    expect(placeTeleporters([a, b], g, [], inRoom, mulberry32(3))).toHaveLength(2);

    const g2 = grid(30);
    const a2 = makeRoom(1, 1, 12, 12, entity({ startLine: 1, endLine: 10 }));
    const b2 = makeRoom(16, 1, 12, 12, entity({ name: "g", startLine: 20, endLine: 30 }));
    carveRoom(g2, a2);
    carveRoom(g2, b2);
    const crossRoom = [
      link({ gotoLine: 2, labelLine: 22 }),
      link({ label: "two", gotoLine: 5, labelLine: 25 }),
      link({ label: "three", gotoLine: 6, labelLine: 27 }),
    ];
    expect(placeTeleporters([a2, b2], g2, [], crossRoom, mulberry32(3))).toHaveLength(6);
  });

  it("does not spend the cap on an in-room link that could not be placed", () => {
    // A link whose second pad has nowhere to go costs nothing and must not use
    // up the single in-room slot — otherwise a level's one allowed joke is
    // silently eaten by a link that placed nothing at all.
    const g = grid(20);
    const tiny = makeRoom(1, 1, 1, 1, entity({ startLine: 1, endLine: 10 }));
    const room = makeRoom(5, 5, 10, 10, entity({ name: "g", startLine: 20, endLine: 30 }));
    carveRoom(g, tiny);
    carveRoom(g, room);
    const links = [link({ gotoLine: 2, labelLine: 4 }), link({ label: "two", gotoLine: 22, labelLine: 24 })];
    // The 1x1 room cannot fit two pads, so the first link places nothing; the
    // second (in the roomy one) still gets its pair.
    expect(placeTeleporters([tiny, room], g, [], links, mulberry32(4))).toHaveLength(2);
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
