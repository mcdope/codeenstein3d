// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeComment, CodeEntity } from "../../parser/types";
import { LORE_TILE, SPIKE_TRAP_TILE, type Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { placeLoreTerminals } from "./lore";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 20, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function comment(overrides: Partial<CodeComment> = {}): CodeComment {
  return { text: "a long ordinary comment with no special markers at all", startLine: 6, endLine: 6, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

describe("placeLoreTerminals", () => {
  it("returns all-empty results for zero comments", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const result = placeLoreTerminals([room], g, [], mulberry32(1), { x: 1, y: 1 });
    expect(result).toEqual({ terminals: [], todoTraps: [], todoMines: [], todoEnemies: [] });
  });

  it("carves a lore terminal wall tile for an ordinary (non-TODO) comment, with no encounter", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const result = placeLoreTerminals([room], g, [comment()], mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals).toHaveLength(1);
    expect(g[result.terminals[0].y][result.terminals[0].x]).toBe(LORE_TILE);
    expect(result.terminals[0].text).toBe(comment().text);
    expect(result.todoTraps).toEqual([]);
    expect(result.todoMines).toEqual([]);
    expect(result.todoEnemies).toEqual([]);
  });

  it("caps at MAX_LORE_TERMINALS (6) even with more comments", () => {
    const g = grid(30);
    const room = makeRoom(2, 2, 20, 20, entity());
    carveRoom(g, room);
    const comments = Array.from({ length: 10 }, (_, i) => comment({ startLine: i + 1 }));
    const result = placeLoreTerminals([room], g, comments, mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals.length).toBeLessThanOrEqual(6);
  });

  it("falls back to rooms[0] when a comment's line falls outside every entity", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity({ startLine: 1, endLine: 3 }));
    carveRoom(g, room);
    const result = placeLoreTerminals([room], g, [comment({ startLine: 999 })], mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals).toHaveLength(1);
  });

  it("skips a comment entirely when there are no rooms at all", () => {
    const g = grid(20);
    const result = placeLoreTerminals([], g, [comment()], mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals).toEqual([]);
  });

  it("skips a comment when the room has no free wall perimeter tile left", () => {
    const g = grid(10);
    // Room fills the ENTIRE grid, touching all 4 edges with zero margin —
    // every perimeter candidate (room.y-1, room.y+room.h, etc.) falls
    // outside the grid entirely, so none can ever be a wall(1) tile.
    const room = makeRoom(0, 0, 10, 10, entity());
    carveRoom(g, room);
    const result = placeLoreTerminals([room], g, [comment()], mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals).toEqual([]);
  });

  it("places a spike trap encounter for a TODO comment (seed found empirically)", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const todoComment = comment({ text: "TODO: fix this", startLine: 6 });
    const result = placeLoreTerminals([room], g, [todoComment], mulberry32(1), { x: 1, y: 1 });
    expect(result.todoTraps).toHaveLength(1);
    const t = result.todoTraps[0];
    expect(g[t.y][t.x]).toBe(SPIKE_TRAP_TILE);
    expect(result.todoMines).toEqual([]);
    expect(result.todoEnemies).toEqual([]);
  });

  it("places a mine encounter for a TODO comment (seed found empirically)", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const todoComment = comment({ text: "TODO: fix this", startLine: 6 });
    const result = placeLoreTerminals([room], g, [todoComment], mulberry32(2), { x: 1, y: 1 });
    expect(result.todoMines).toHaveLength(1);
    const m = result.todoMines[0];
    expect(g[Math.floor(m.y)][Math.floor(m.x)]).toBe(0); // mines stay invisible on plain floor
    expect(result.todoTraps).toEqual([]);
    expect(result.todoEnemies).toEqual([]);
  });

  it("places a 'Bug' enemy encounter for a TODO comment (seed found empirically)", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const todoComment = comment({ text: "TODO: fix this", startLine: 6 });
    const result = placeLoreTerminals([room], g, [todoComment], mulberry32(3), { x: 1, y: 1 });
    expect(result.todoEnemies).toHaveLength(1);
    expect(result.todoEnemies[0].entity.name).toBe("Bug");
    expect(result.todoEnemies[0].hp).toBe(10);
    expect(result.todoTraps).toEqual([]);
    expect(result.todoMines).toEqual([]);
  });

  it("skips the TODO encounter (but keeps the terminal) when every candidate is too close to spawn", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 4, 4, entity());
    carveRoom(g, room);
    const todoComment = comment({ text: "TODO: fix this", startLine: 6 });
    const spawn = { x: room.center.x, y: room.center.y };
    const result = placeLoreTerminals([room], g, [todoComment], mulberry32(1), spawn);
    expect(result.terminals).toHaveLength(1);
    expect(result.todoTraps).toEqual([]);
    expect(result.todoMines).toEqual([]);
    expect(result.todoEnemies).toEqual([]);
  });

  it("also recognizes a FIXME marker as TODO-flagged", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const fixmeComment = comment({ text: "FIXME: this is broken", startLine: 6 });
    const result = placeLoreTerminals([room], g, [fixmeComment], mulberry32(1), { x: 1, y: 1 });
    const totalEncounters = result.todoTraps.length + result.todoMines.length + result.todoEnemies.length;
    expect(totalEncounters).toBe(1);
  });

  it("finds a wall spot on the room's bottom side too, for a TODO comment (interiorNeighborOf's bottom branch)", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 6, 6, entity());
    carveRoom(g, room);
    const todoComment = comment({ text: "TODO: fix this thing please", startLine: 6 });
    const result = placeLoreTerminals([room], g, [todoComment], mulberry32(11), { x: 1, y: 1 });
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].y).toBe(room.y + room.h);
    const totalEncounters = result.todoTraps.length + result.todoMines.length + result.todoEnemies.length;
    expect(totalEncounters).toBe(1);
  });

  it("skips already-used wall spots when placing several terminals on a 1x1 room (only 4 candidates)", () => {
    const g = grid(20);
    const room = makeRoom(5, 5, 1, 1, entity({ startLine: 1, endLine: 30 }));
    carveRoom(g, room);
    const comments = Array.from({ length: 4 }, (_, i) =>
      comment({ startLine: i + 1, text: `plain comment text number ${i} that is long enough to qualify xxxxxxxxxxxxxxxxxxxx` }),
    );
    const result = placeLoreTerminals([room], g, comments, mulberry32(1), { x: 1, y: 1 });
    expect(result.terminals.length).toBeGreaterThanOrEqual(2);
    const keys = result.terminals.map((t) => `${t.x},${t.y}`);
    expect(new Set(keys).size).toBe(keys.length); // every terminal landed on a distinct tile
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const room = makeRoom(5, 5, 6, 6, entity());
      carveRoom(g, room);
      return placeLoreTerminals([room], g, [comment({ text: "TODO: x" })], mulberry32(7), { x: 1, y: 1 });
    };
    expect(build()).toEqual(build());
  });
});
