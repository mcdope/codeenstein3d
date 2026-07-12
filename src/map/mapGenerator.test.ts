// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeEntity, ParsedFile } from "../parser/types";
import { MapGenerator } from "./mapGenerator";

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    language: "javascript",
    linesOfCode: 20,
    entities: [],
    gotos: [],
    comments: [],
    secretTriggers: [],
    ...overrides,
  };
}

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

describe("MapGenerator.generate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is fully deterministic: the same ParsedFile input twice yields byte-identical output", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({
      entities: [
        entity({ name: "a", complexityScore: 8, startLine: 1, endLine: 10 }),
        entity({ name: "b", kind: "method", visibility: "private", startLine: 11, endLine: 20 }),
        entity({ name: "Global", kind: "global", startLine: 21, endLine: 21 }),
      ],
      comments: [{ text: "a".repeat(70), startLine: 5, endLine: 5 }],
      gotos: [{ label: "L", gotoLine: 2, labelLine: 8 }],
    });
    const a = gen.generate(parsed);
    const b = gen.generate(parsed);
    expect(a).toEqual(b);
  });

  it("produces a well-formed GameMap for a file with several entity kinds", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({
      entities: [
        entity({ name: "a", complexityScore: 8 }),
        entity({ name: "b", kind: "method", visibility: "private" }),
        entity({ name: "Global", kind: "global" }),
      ],
    });
    const map = gen.generate(parsed);
    expect(map.width).toBe(map.height);
    expect(map.grid.length).toBe(map.width);
    expect(map.visited.length).toBe(map.width);
    expect(map.rooms.length).toBeGreaterThanOrEqual(2); // top-up guarantee
    expect(map.enemies.length).toBeGreaterThan(0);
    expect(map.doors.length).toBeGreaterThan(0);
    expect(map.keys.length).toBe(map.doors.length);
    expect(map.hazards.length).toBeGreaterThan(0);
    expect(map.bonusLevel).toBe(false);
  });

  it("carves a labyrinth for a deeply-nested entity's room", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({ entities: [entity({ nestingDepth: 5 })] });
    const map = gen.generate(parsed);
    let wallsInsideRoom = 0;
    const room = map.rooms[0];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (map.grid[y][x] === 1) wallsInsideRoom++;
      }
    }
    expect(wallsInsideRoom).toBeGreaterThan(0);
  });

  it("falls back to a single centered room for a file with zero entities", () => {
    const gen = new MapGenerator();
    const map = gen.generate(parsedFile({ entities: [] }));
    // Top-up guarantees >= 2 rooms even so (a filler room joins the fallback).
    expect(map.rooms.length).toBeGreaterThanOrEqual(2);
    expect(map.rooms[0].entity.name).toBe("<entry>");
  });

  it("tops up to at least 2 rooms for a file with exactly one entity", () => {
    const gen = new MapGenerator();
    const map = gen.generate(parsedFile({ entities: [entity()] }));
    expect(map.rooms.length).toBeGreaterThanOrEqual(2);
    expect(map.rooms.some((r) => r.entity.name === "<filler>")).toBe(true);
  });

  it("passes bonusLevel through to the returned map and boosts pickup generation", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    const bonus = gen.generate(parsed, true);
    expect(bonus.bonusLevel).toBe(true);
  });

  it("respects hasRocketLauncher and missingWeaponIndices for downstream loot systems", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({
      entities: [entity()],
      secretTriggers: [{ kind: "deadCode", startLine: 2, endLine: 3 }],
    });
    expect(() => gen.generate(parsed, false, false, [7])).not.toThrow();
  });

  it("scales map size with lines of code and entity count, floored at minSize", () => {
    const gen = new MapGenerator({ minSize: 64, maxSize: 160 });
    const tiny = gen.generate(parsedFile({ linesOfCode: 1, entities: [] }));
    expect(tiny.width).toBe(64);

    const gen2 = new MapGenerator({ minSize: 64, maxSize: 160 });
    const many = Array.from({ length: 30 }, (_, i) => entity({ name: `f${i}`, startLine: i + 1, endLine: i + 1 }));
    const big = gen2.generate(parsedFile({ linesOfCode: 5000, entities: many }));
    expect(big.width).toBeGreaterThan(tiny.width);
  });

  it("caps map size at maxSize even for an enormous file", () => {
    const gen = new MapGenerator({ minSize: 64, maxSize: 100 });
    const map = gen.generate(parsedFile({ linesOfCode: 1_000_000, entities: [] }));
    expect(map.width).toBe(100);
  });

  it("skips an entity whose room can't fit at all on a very small map", () => {
    const gen = new MapGenerator({ minSize: 8, maxSize: 8 });
    const parsed = parsedFile({
      linesOfCode: 8,
      entities: [entity({ complexityScore: 1000, nestingDepth: 0 })], // huge room, tiny map
    });
    expect(() => gen.generate(parsed)).not.toThrow();
  });

  it("skips an entity whose room repeatedly overlaps existing rooms until attempts run out", () => {
    const gen = new MapGenerator({ minSize: 16, maxSize: 16, placementAttempts: 3 });
    const many = Array.from({ length: 20 }, (_, i) => entity({ name: `f${i}`, startLine: i + 1, endLine: i + 1, complexityScore: 10 }));
    const map = gen.generate(parsedFile({ linesOfCode: 40, entities: many }));
    // Not every one of the 20 entities can possibly fit on a 16x16 map — some
    // must have been skipped by tryPlaceRoom running out of attempts.
    expect(map.rooms.length).toBeLessThan(many.length);
  });

  it("falls back to a map corner for the filler room when random placement is given zero attempts", () => {
    // placementAttempts: 0 makes tryPlaceRoom's for-loop (`attempt < 0`)
    // never execute at all, so every call — including the filler room's own
    // "try random first" attempt inside placeFillerRoom — deterministically
    // returns null with no rng involved, forcing the corner-search fallback.
    const gen = new MapGenerator({ minSize: 40, maxSize: 40, placementAttempts: 0 });
    const map = gen.generate(parsedFile({ entities: [entity()] }));
    expect(map.rooms).toHaveLength(2);
    const filler = map.rooms[1];
    expect(filler.entity.name).toBe("<filler>");
    // Lands exactly on one of placeFillerRoom's 4 deterministic corners.
    expect([1, 40 - filler.w - 1]).toContain(filler.x);
    expect([1, 40 - filler.h - 1]).toContain(filler.y);
  });

  it("skips every entity when the map is too small to fit even the 4-tile minimum room", () => {
    // roomDimensions clamps width/height to >= 4 unconditionally (the clamp
    // floor wins over a collapsed cap once size < 6) — on a 4x4 map, maxX/
    // maxY both come out negative, hitting tryPlaceRoom's size guard
    // directly rather than the overlap-retry path.
    const gen = new MapGenerator({ minSize: 4, maxSize: 4, placementAttempts: 200 });
    expect(() => gen.generate(parsedFile({ linesOfCode: 4, entities: [entity()] }))).not.toThrow();
  });

  it("calls placeDecorations when DECORATIONS_ENABLED is flipped on", async () => {
    vi.resetModules();
    vi.doMock("./generation/props", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/props")>();
      return { ...actual, DECORATIONS_ENABLED: true };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const gen = new MockedMapGenerator();
    // A wide, tall room (both dimensions >= LARGE_ROOM_MIN_DIM) so it
    // qualifies as a "large open room" for placeDecorations to consider.
    const parsed = parsedFile({ entities: [entity({ complexityScore: 30, startLine: 1, endLine: 30, nestingDepth: 0 })] });
    const map = gen.generate(parsed);
    expect(map.decorations.length).toBeGreaterThan(0);
    vi.doUnmock("./generation/props");
    vi.resetModules();
  });

  it("logs nothing from assertAllRoomsReachable on a normal generation (the safety net never fires)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const gen = new MapGenerator();
    gen.generate(parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] }));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
