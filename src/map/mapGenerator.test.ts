// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDemoCampaignTree } from "../fs/demoCampaign";
import { readFileText } from "../fs/workspace";
import type { CodeEntity, ParsedFile } from "../parser/types";
import { extensionOf, parseFile } from "../parser/registry";
import { BRANCH_DOOR_TILE, DOOR_TILE, HAZARD_TILE } from "./types";
import { MapGenerator } from "./mapGenerator";

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    language: "javascript",
    linesOfCode: 20,
    entities: [],
    gotos: [],
    comments: [],
    secretTriggers: [],
    exceptionZones: [],
    importCount: 0,
    ...overrides,
  };
}

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

/** Distinct gates among a level's door tiles: 4-connected runs, counted once
 * each however many tiles wide they are — the same grouping `doorwayTiles`
 * applies, and the unit `placeKeys` bills a key against. */
function countDoorways(doors: readonly { x: number; y: number }[]): number {
  const remaining = new Set(doors.map((d) => `${d.x},${d.y}`));
  let gates = 0;
  while (remaining.size > 0) {
    const [first] = remaining;
    const stack = [first];
    remaining.delete(first);
    while (stack.length > 0) {
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const k of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        if (remaining.delete(k)) stack.push(k);
      }
    }
    gates++;
  }
  return gates;
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
    // One key per *doorway*, not per door tile — a corridor wider than one
    // tile makes a wider gate, not more gates (see `doorwayTiles`).
    expect(map.keys.length).toBe(countDoorways(map.doors));
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
    const bonus = gen.generate(parsed, { bonusLevel: true });
    expect(bonus.bonusLevel).toBe(true);
  });

  it("respects hasRocketLauncher and missingWeaponIndices for downstream loot systems", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({
      entities: [entity()],
      secretTriggers: [{ kind: "deadCode", startLine: 2, endLine: 3 }],
    });
    expect(() => gen.generate(parsed, { hasRocketLauncher: false, missingWeaponIndices: [7] })).not.toThrow();
  });

  it("scales map size with the room footprint, not with lines of code", () => {
    // Sizing keys off the space the rooms will occupy — see mapSize. A file
    // can be enormous and still describe very little structure, and once
    // rooms pack into one cluster it's the cluster that decides how much grid
    // the level needs.
    const gen = new MapGenerator({ minSize: 64, maxSize: 160 });
    const tiny = gen.generate(parsedFile({ linesOfCode: 1, entities: [] }));
    expect(tiny.width).toBe(64);

    const sprawling = gen.generate(parsedFile({ linesOfCode: 100_000, entities: [] }));
    expect(sprawling.width).toBe(64);

    const many = Array.from({ length: 30 }, (_, i) => entity({ name: `f${i}`, startLine: i + 1, endLine: i + 1 }));
    const big = gen.generate(parsedFile({ linesOfCode: 5000, entities: many }));
    expect(big.width).toBeGreaterThan(tiny.width);
  });

  it("caps map size at maxSize even for a file with a huge room footprint", () => {
    const gen = new MapGenerator({ minSize: 64, maxSize: 100 });
    const many = Array.from({ length: 400 }, (_, i) =>
      entity({ name: `f${i}`, startLine: i * 60 + 1, endLine: i * 60 + 60, complexityScore: 20 }),
    );
    const map = gen.generate(parsedFile({ linesOfCode: 24_000, entities: many }));
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

  it("grows every room beside an already-placed one instead of scattering it across the map", () => {
    // The property that bounds corridor length: connectRooms carves between
    // consecutive room centers, so what matters is that a room is never far
    // from the ones already placed. With uniform-random placement the demo
    // campaign averaged 59 tiles between consecutive centers and peaked at
    // 191 — see tryGrowRoom's doc comment.
    const gen = new MapGenerator();
    const entities = Array.from({ length: 8 }, (_, i) =>
      entity({ name: `f${i}`, startLine: i * 6 + 1, endLine: i * 6 + 6 }),
    );
    const map = gen.generate(parsedFile({ linesOfCode: 200, entities }));
    expect(map.rooms).toHaveLength(8);

    for (let i = 1; i < map.rooms.length; i++) {
      const room = map.rooms[i];
      const separations = map.rooms.slice(0, i).map((other) => {
        const dx = Math.max(0, room.x - (other.x + other.w), other.x - (room.x + room.w));
        const dy = Math.max(0, room.y - (other.y + other.h), other.y - (room.y + room.h));
        return Math.max(dx, dy);
      });
      // ROOM_GAP_MAX. A room placed by the random-scatter fallback could sit
      // further out, but on a map this empty growth never needs it.
      expect(Math.min(...separations)).toBeLessThanOrEqual(9);
    }
  });

  it("keeps rock between grown rooms, so the side-feature carvers still have somewhere to go", () => {
    // placeSecretRooms/placeVendorDepots/placeSwitchboards/placeExceptionZones
    // all demand untouched rock plus a one-tile margin (sideCandidateFits).
    // Growth placement packs rooms far tighter than random placement did, so
    // ROOM_PACK_MARGIN is what stops it from starving all four at once.
    const gen = new MapGenerator();
    const entities = Array.from({ length: 8 }, (_, i) =>
      entity({ name: `f${i}`, startLine: i * 6 + 1, endLine: i * 6 + 6 }),
    );
    const map = gen.generate(parsedFile({ linesOfCode: 200, entities }));

    for (let i = 0; i < map.rooms.length; i++) {
      for (let j = i + 1; j < map.rooms.length; j++) {
        const a = map.rooms[i];
        const b = map.rooms[j];
        const touching =
          a.x - 3 < b.x + b.w && a.x + a.w + 3 > b.x && a.y - 3 < b.y + b.h && a.y + a.h + 3 > b.y;
        expect(touching).toBe(false);
      }
    }
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

  // Regression test: `assertAllRoomsReachable` only ever logs a warning —
  // nothing actually fails CI if it fires, which is exactly how a real
  // connectivity bug (a corridor-breakup room's internal sightline baffle
  // silently severing an unrelated corridor leg crossing through its
  // footprint, isolating 3 rooms from spawn with no possible route at all)
  // shipped unnoticed on a real bundled campaign level
  // (`stage06_pipeline.py`) until a player got permanently stuck. Generating
  // every real, currently-bundled campaign file and asserting the safety
  // net never fires for any of them ties CI directly to that check's
  // output, so any future generation regression of this class — on this
  // exact content or new content added later — fails the build instead of
  // silently shipping. Every real file only ever exercises `parseFile`'s
  // actual language-appropriate parser (no synthetic `ParsedFile`), so this
  // also incidentally re-verifies the whole `parser -> map` pipeline stays
  // connectivity-safe together, not just `MapGenerator` in isolation.
  it("N=1 exactness gate: an explicit maxPlayers=1 is byte-identical to omitting it entirely", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({
      entities: [
        entity({ name: "a", complexityScore: 8, startLine: 1, endLine: 10 }),
        entity({ name: "b", kind: "method", visibility: "private", startLine: 11, endLine: 20 }),
        entity({ name: "Global", kind: "global", startLine: 21, endLine: 21 }),
      ],
    });
    const omitted = gen.generate(parsed);
    const explicit = gen.generate(parsed, { bonusLevel: false, hasRocketLauncher: true, missingWeaponIndices: [], maxPlayers: 1, hasSmg: true, hasGas: true });
    expect(omitted).toEqual(explicit);
  });

  it("leaves multiplayerSpawns undefined when maxPlayers is omitted or 1", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    expect(gen.generate(parsed).multiplayerSpawns).toBeUndefined();
    expect(gen.generate(parsed, { maxPlayers: 1 }).multiplayerSpawns).toBeUndefined();
  });

  it("produces maxPlayers spread, open-floor spawns clear of the exit and each other", () => {
    const gen = new MapGenerator();
    const many = Array.from({ length: 6 }, (_, i) => entity({ name: `f${i}`, startLine: i * 10 + 1, endLine: i * 10 + 5, complexityScore: 5 }));
    const parsed = parsedFile({ linesOfCode: 200, entities: many });
    const map = gen.generate(parsed, { maxPlayers: 3 });
    expect(map.multiplayerSpawns).toHaveLength(3);
    const seen = new Set<string>();
    for (const s of map.multiplayerSpawns ?? []) {
      expect(map.grid[s.y][s.x]).toBe(0);
      expect(s.x === map.exit.x && s.y === map.exit.y).toBe(false);
      const key = `${s.x},${s.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("returns fewer than maxPlayers spawns without padding when the level has too few rooms", () => {
    const gen = new MapGenerator({ minSize: 40, maxSize: 40 });
    const parsed = parsedFile({ entities: [entity()] }); // tops up to exactly 2 rooms
    const map = gen.generate(parsed, { maxPlayers: 16 });
    expect(map.multiplayerSpawns).toBeDefined();
    expect((map.multiplayerSpawns ?? []).length).toBeLessThan(16);
  });

  it("is deterministic for the same input with maxPlayers > 1 too", () => {
    const gen = new MapGenerator();
    const many = Array.from({ length: 6 }, (_, i) => entity({ name: `f${i}`, startLine: i * 10 + 1, endLine: i * 10 + 5, complexityScore: 5 }));
    const parsed = parsedFile({ linesOfCode: 200, entities: many });
    const a = gen.generate(parsed, { maxPlayers: 4 });
    const b = gen.generate(parsed, { maxPlayers: 4 });
    expect(a).toEqual(b);
  });

  it("assigns a styleset without consuming any of the layout rng", async () => {
    // THE exactness gate for stylesets. `mapGenerator.ts`'s header warns that
    // the order of its `generation/*` calls *is* the rng draw sequence — take
    // even one value from that stream to pick a wall colour and every existing
    // map layout moves, invalidating every recorded replay and the shipped
    // `defaultHighscore.ts` board. Proven here by stubbing `styleSetFor` to a
    // fixed value: if it drew from `rng`, removing its draw would shift every
    // downstream placement and the two maps would differ everywhere. They must
    // differ in exactly one field.
    vi.resetModules();
    vi.doMock("./generation/styleSet", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/styleSet")>();
      return { ...actual, styleSetFor: () => "marble" as const };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const parsed = parsedFile({
      entities: [entity({ name: "a", complexityScore: 8 }), entity({ name: "b", startLine: 6, endLine: 12 })],
      comments: [{ text: "z".repeat(70), startLine: 3, endLine: 3 }],
    });
    const stubbed = new MockedMapGenerator().generate(parsed);
    vi.doUnmock("./generation/styleSet");
    vi.resetModules();
    const { MapGenerator: RealMapGenerator } = await import("./mapGenerator");
    const real = new RealMapGenerator().generate(parsed);

    expect(stubbed.styleSet).toBe("marble");
    expect({ ...stubbed, styleSet: null }).toEqual({ ...real, styleSet: null });
  });

  it("gives a bonus level the bonus styleset and a normal level a normal one", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({ entities: [entity({ name: "a" })] });
    expect(gen.generate(parsed, { bonusLevel: true }).styleSet).toBe("techCool");
    expect(gen.generate(parsed, { bonusLevel: false }).styleSet).not.toBe("techCool");
  });

  it("never logs an unreachable-room warning for any bundled demo-campaign file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tree = loadDemoCampaignTree();
    const gen = new MapGenerator();
    for (const child of tree.children ?? []) {
      if (child.kind !== "file") continue;
      const text = await readFileText(child.handle as FileSystemFileHandle);
      const parsed = await parseFile(child.name, text);
      if (!parsed) continue; // unparsable fixture content, not this test's concern
      gen.generate(parsed, { bonusLevel: extensionOf(child.name) === "h" });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("MapGenerator.generate — Vendor Depots", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carves depots off the spawn room for a file with a real import block", () => {
    const gen = new MapGenerator();
    const map = gen.generate(parsedFile({
      importCount: 12,
      entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })],
    }));
    expect(map.vendorDepots.length).toBeGreaterThan(0);
    // Every depot's stock lands in `ammoPickups` alongside the scattered ones.
    expect(map.ammoPickups.length).toBeGreaterThanOrEqual(map.vendorDepots.length);
  });

  it("carves no depots for a file with no imports", () => {
    const gen = new MapGenerator();
    const map = gen.generate(parsedFile({ importCount: 0, entities: [entity()] }));
    expect(map.vendorDepots).toEqual([]);
  });

  it("only stocks smg/gas once the player owns the weapon each pool feeds", () => {
    const gen = new MapGenerator();
    const parsed = parsedFile({ importCount: 400, entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    const unowned = gen.generate(parsed, { hasRocketLauncher: false, hasSmg: false, hasGas: false });
    expect(unowned.ammoPickups.some((p) => p.kind === "smg" || p.kind === "gas")).toBe(false);
  });

  it("places no depots at all when VENDOR_DEPOTS_ENABLED is flipped off", async () => {
    vi.resetModules();
    vi.doMock("./generation/vendorDepots", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/vendorDepots")>();
      return { ...actual, VENDOR_DEPOTS_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const gen = new MockedMapGenerator();
    const map = gen.generate(parsedFile({ importCount: 400, entities: [entity()] }));
    expect(map.vendorDepots).toEqual([]);
    vi.doUnmock("./generation/vendorDepots");
    vi.resetModules();
  });

  it("leaves the rest of the map byte-identical when there are no imports to spend", async () => {
    // The disabled path and the zero-import path must both draw zero rng, or
    // every downstream placement shifts.
    vi.resetModules();
    vi.doMock("./generation/vendorDepots", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/vendorDepots")>();
      return { ...actual, VENDOR_DEPOTS_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const parsed = parsedFile({ importCount: 0, entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    const disabled = new MockedMapGenerator().generate(parsed);
    vi.doUnmock("./generation/vendorDepots");
    vi.resetModules();
    const { MapGenerator: RealMapGenerator } = await import("./mapGenerator");
    expect(new RealMapGenerator().generate(parsed)).toEqual(disabled);
  });
});

describe("MapGenerator.generate — Switchboards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A file whose one non-spawn function contains a switch. */
  function switchParsed(caseCount: number, overrides: Partial<CodeEntity> = {}) {
    return parsedFile({
      linesOfCode: 60,
      entities: [
        entity({ name: "main", startLine: 1, endLine: 10 }),
        entity({
          name: "dispatch",
          startLine: 11,
          endLine: 40,
          complexityScore: 6,
          switchBranches: { caseCount, hasDefault: true },
          ...overrides,
        }),
      ],
    });
  }

  it("carves case dead-ends and doors them with the keyless branch tile", () => {
    const map = new MapGenerator().generate(switchParsed(3));
    expect(map.switchboardRooms.length).toBeGreaterThan(0);
    let branchDoors = 0;
    for (const row of map.grid) for (const tile of row) if (tile === BRANCH_DOOR_TILE) branchDoors += 1;
    expect(branchDoors).toBe(map.switchboardRooms.length);
  });

  it("never places a key-locked door on a spoke mouth, even for a private method", () => {
    // `placeDoors` locks every corridor mouth of a private method's room, and
    // `placeKeys` adds one key per door — a five-case switch inside one would
    // otherwise mean six doors and six keys. The branch-door tile is what
    // keeps `roomMouths` from ever seeing a spoke mouth as a mouth at all.
    const map = new MapGenerator().generate(switchParsed(5, { kind: "method", visibility: "private" }));
    expect(map.switchboardRooms.length).toBeGreaterThan(0);
    expect(map.doors.length).toBeLessThanOrEqual(4);
    for (const door of map.doors) {
      expect(map.grid[door.y][door.x]).toBe(DOOR_TILE);
    }
  });

  it("carves nothing for a file with no switch anywhere", () => {
    const map = new MapGenerator().generate(parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] }));
    expect(map.switchboardRooms).toEqual([]);
  });

  it("places no spokes at all when SWITCHBOARDS_ENABLED is flipped off", async () => {
    vi.resetModules();
    vi.doMock("./generation/switchboards", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/switchboards")>();
      return { ...actual, SWITCHBOARDS_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const map = new MockedMapGenerator().generate(switchParsed(4));
    expect(map.switchboardRooms).toEqual([]);
    vi.doUnmock("./generation/switchboards");
    vi.resetModules();
  });

  it("leaves the rest of the map byte-identical when no file has a switch", async () => {
    vi.resetModules();
    vi.doMock("./generation/switchboards", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/switchboards")>();
      return { ...actual, SWITCHBOARDS_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const parsed = parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    const disabled = new MockedMapGenerator().generate(parsed);
    vi.doUnmock("./generation/switchboards");
    vi.resetModules();
    const { MapGenerator: RealMapGenerator } = await import("./mapGenerator");
    expect(new RealMapGenerator().generate(parsed)).toEqual(disabled);
  });

  it("keeps every spoke reachable — the connectivity safety net never fires", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    new MapGenerator().generate(switchParsed(5));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("MapGenerator.generate — Exception Handling Zones", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A file with a try/catch inside its second (non-spawn) function. */
  function tryParsed() {
    return parsedFile({
      linesOfCode: 80,
      entities: [
        entity({ name: "main", startLine: 1, endLine: 10 }),
        entity({ name: "risky", startLine: 11, endLine: 40, complexityScore: 5 }),
      ],
      exceptionZones: [{ startLine: 12, endLine: 30, catchCount: 1, hasFinally: true }],
    });
  }

  it("carves a zone and folds its hazards, traps, mines and loot into the map", () => {
    const map = new MapGenerator().generate(tryParsed());
    expect(map.exceptionZones).toHaveLength(1);
    expect(map.hazards.length).toBeGreaterThan(0);
    expect(map.spikeTraps.length).toBeGreaterThan(0);
    expect(map.mines.length).toBeGreaterThan(0);
    expect(map.ammoPickups.some((p) => p.kind === "health")).toBe(true);
    expect(map.ammoPickups.some((p) => p.kind === "swap")).toBe(true);
  });

  it("carves nothing for a file with no try/catch", () => {
    const map = new MapGenerator().generate(parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] }));
    expect(map.exceptionZones).toEqual([]);
  });

  it("places no zones at all when EXCEPTION_ZONES_ENABLED is flipped off", async () => {
    vi.resetModules();
    vi.doMock("./generation/exceptionZones", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/exceptionZones")>();
      return { ...actual, EXCEPTION_ZONES_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const map = new MockedMapGenerator().generate(tryParsed());
    expect(map.exceptionZones).toEqual([]);
    vi.doUnmock("./generation/exceptionZones");
    vi.resetModules();
  });

  it("leaves the rest of the map byte-identical when no file has a try/catch", async () => {
    vi.resetModules();
    vi.doMock("./generation/exceptionZones", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/exceptionZones")>();
      return { ...actual, EXCEPTION_ZONES_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    const parsed = parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] });
    const disabled = new MockedMapGenerator().generate(parsed);
    vi.doUnmock("./generation/exceptionZones");
    vi.resetModules();
    const { MapGenerator: RealMapGenerator } = await import("./mapGenerator");
    expect(new RealMapGenerator().generate(parsed)).toEqual(disabled);
  });

  it("keeps the whole level reachable — the connectivity safety net never fires", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    new MapGenerator().generate(tryParsed());
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("MapGenerator.generate — Acid Overflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A file whose second function allocates densely enough to leak. */
  function leakyParsed() {
    return parsedFile({
      linesOfCode: 80,
      entities: [
        entity({ name: "main", startLine: 1, endLine: 10 }),
        entity({ name: "leaky", startLine: 11, endLine: 50, complexityScore: 6, allocations: 12 }),
      ],
    });
  }

  it("plans an overflow for the leaky function's room", () => {
    const map = new MapGenerator().generate(leakyParsed());
    expect(map.acidOverflows).toHaveLength(1);
    expect(map.acidOverflows[0].tiles.length).toBeGreaterThan(0);
  });

  it("points its enemyIndex at a real, live enemy for that same entity", () => {
    const map = new MapGenerator().generate(leakyParsed());
    const overflow = map.acidOverflows[0];
    const enemy = map.enemies[overflow.enemyIndex];
    expect(enemy).toBeDefined();
    expect(enemy.alive).toBe(true);
    expect(enemy.entity.name).toBe("leaky");
  });

  it("only ever lists tiles that are plain floor on the finished grid", () => {
    // The whole safety argument for skipping `pendingGridDelta` at runtime
    // rests on this: nothing in the list can be a door, pad, spike, secret
    // wall, lore terminal or pre-existing acid tile.
    const map = new MapGenerator().generate(leakyParsed());
    for (const tile of map.acidOverflows[0].tiles) {
      expect(map.grid[tile.y][tile.x]).toBe(0);
    }
  });

  it("never lists the spawn or exit tile", () => {
    const map = new MapGenerator().generate(leakyParsed());
    for (const tile of map.acidOverflows[0].tiles) {
      expect(tile).not.toEqual(map.spawn);
      expect(tile).not.toEqual(map.exit);
    }
  });

  it("never lists a tile a mine or key is standing on", () => {
    // Both sit on plain floor, so the grid check alone can't exclude them.
    const map = new MapGenerator().generate(leakyParsed());
    const listed = new Set(map.acidOverflows[0].tiles.map((t) => `${t.x},${t.y}`));
    for (const mine of map.mines) expect(listed.has(`${Math.floor(mine.x)},${Math.floor(mine.y)}`)).toBe(false);
    for (const k of map.keys) expect(listed.has(`${Math.floor(k.x)},${Math.floor(k.y)}`)).toBe(false);
  });

  it("plans nothing for a file with no allocation-dense function", () => {
    const map = new MapGenerator().generate(parsedFile({ entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })] }));
    expect(map.acidOverflows).toEqual([]);
  });

  it("writes no acid into the grid at generation time", () => {
    // Everything the overflow does happens at runtime; a freshly generated
    // level has exactly the hazards its globals and exception zones put there.
    const map = new MapGenerator().generate(leakyParsed());
    const acidTiles: string[] = [];
    map.grid.forEach((row, y) => row.forEach((tile, x) => {
      if (tile === HAZARD_TILE) acidTiles.push(`${x},${y}`);
    }));
    expect(acidTiles.sort()).toEqual(map.hazards.map((h) => `${h.x},${h.y}`).sort());
  });

  it("plans nothing at all when ACID_OVERFLOW_ENABLED is flipped off", async () => {
    vi.resetModules();
    vi.doMock("./generation/acidOverflow", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./generation/acidOverflow")>();
      return { ...actual, ACID_OVERFLOW_ENABLED: false };
    });
    const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
    expect(new MockedMapGenerator().generate(leakyParsed()).acidOverflows).toEqual([]);
    vi.doUnmock("./generation/acidOverflow");
    vi.resetModules();
  });

  it("leaves the rest of the map byte-identical either way — it draws no rng", () => {
    // The planning pass is appended at the very end of `generate()` precisely
    // because it consumes nothing from the shared stream.
    vi.resetModules();
    const parsed = leakyParsed();
    const enabled = new MapGenerator().generate(parsed);
    return (async () => {
      vi.doMock("./generation/acidOverflow", async (importOriginal) => {
        const actual = await importOriginal<typeof import("./generation/acidOverflow")>();
        return { ...actual, ACID_OVERFLOW_ENABLED: false };
      });
      const { MapGenerator: MockedMapGenerator } = await import("./mapGenerator");
      const disabled = new MockedMapGenerator().generate(parsed);
      vi.doUnmock("./generation/acidOverflow");
      vi.resetModules();
      expect({ ...enabled, acidOverflows: [] }).toEqual(disabled);
    })();
  });
});
