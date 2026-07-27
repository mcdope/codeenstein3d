// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity, ExceptionZoneTrigger } from "../../parser/types";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type Rect,
  type Room,
  type Tile,
} from "../types";
import { makeRoom } from "./geometry";
import { EXCEPTION_ZONES_ENABLED, placeExceptionZones } from "./exceptionZones";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function carve(g: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
  }
}

function trigger(overrides: Partial<ExceptionZoneTrigger> = {}): ExceptionZoneTrigger {
  return { startLine: 12, endLine: 20, catchCount: 1, hasFinally: true, ...overrides };
}

/** A spawn room at index 0 plus one anchor whose entity spans lines 10-30 —
 * `placeExceptionZones` always skips index 0, so an anchor is mandatory. */
function anchorSetup(size = 48) {
  const g = grid(size);
  const spawnRoom = makeRoom(2, 2, 4, 4, entity({ name: "spawn", startLine: 1, endLine: 9 }));
  const anchor = makeRoom(Math.floor(size / 2) - 3, Math.floor(size / 2) - 3, 6, 6, entity({ name: "risky", startLine: 10, endLine: 30 }));
  carve(g, spawnRoom);
  carve(g, anchor);
  return { g, rooms: [spawnRoom, anchor], anchor, size };
}

function countingRng(seed: number): { rng: () => number; calls: () => number } {
  const inner = mulberry32(seed);
  let calls = 0;
  return { rng: () => { calls += 1; return inner(); }, calls: () => calls };
}

/** Every tile of a rect, for containment/adjacency assertions. */
function tilesOf(rect: Rect): string[] {
  const out: string[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) out.push(`${x},${y}`);
  }
  return out;
}

describe("EXCEPTION_ZONES_ENABLED", () => {
  it("is on by default", () => {
    expect(EXCEPTION_ZONES_ENABLED).toBe(true);
  });
});

describe("placeExceptionZones", () => {
  it("carves a three-part zone for a try/catch/finally", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(1), true);
    expect(r.zones).toHaveLength(1);
    const zone = r.zones[0];
    expect(zone.tryRect.w * zone.tryRect.h).toBeGreaterThan(0);
    expect(zone.catchRect.w * zone.catchRect.h).toBeGreaterThan(0);
    expect(zone.finallyRect.w * zone.finallyRect.h).toBeGreaterThan(0);
  });

  it("lays the three segments out in order, try nearest the anchor", () => {
    const { g, rooms, anchor, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(2), true);
    const zone = r.zones[0];
    const centerDist = (rect: Rect) =>
      Math.abs(rect.x + rect.w / 2 - (anchor.x + anchor.w / 2)) + Math.abs(rect.y + rect.h / 2 - (anchor.y + anchor.h / 2));
    expect(centerDist(zone.tryRect)).toBeLessThan(centerDist(zone.catchRect));
    expect(centerDist(zone.catchRect)).toBeLessThan(centerDist(zone.finallyRect));
  });

  it("floods the try gauntlet with acid and studs it with spikes and one mine", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(3), true);
    const tryTiles = tilesOf(r.zones[0].tryRect);
    const kinds = tryTiles.map((k) => {
      const [x, y] = k.split(",").map(Number);
      return g[y][x];
    });
    expect(kinds.filter((t) => t === HAZARD_TILE).length).toBeGreaterThan(0);
    expect(kinds.filter((t) => t === SPIKE_TRAP_TILE).length).toBe(r.spikeTraps.length);
    expect(r.spikeTraps.length).toBeGreaterThan(0);
    expect(r.mines).toHaveLength(1);
  });

  it("doesn't double-count a spiked tile as acid", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(4), true);
    // A tile is one hazard kind or the other; a spike that replaced an acid
    // tile must not still be listed as a hazard.
    for (const spike of r.spikeTraps) {
      expect(r.hazards).not.toContainEqual({ x: spike.x, y: spike.y });
    }
    for (const hz of r.hazards) expect(g[hz.y][hz.x]).toBe(HAZARD_TILE);
  });

  it("leaves the catch and finally segments as plain, safe floor", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(5), true);
    for (const key of [...tilesOf(r.zones[0].catchRect), ...tilesOf(r.zones[0].finallyRect)]) {
      const [x, y] = key.split(",").map(Number);
      expect(g[y][x]).toBe(0);
    }
  });

  it("stocks the catch alcove with BOTH health and swap", () => {
    // Never a coin flip: `collectLoot` clamps health at MAX_HEALTH, so a
    // full-health arrival would find a health-only reward doing nothing.
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(6), true);
    const catchTiles = new Set(tilesOf(r.zones[0].catchRect));
    const inCatch = r.pickups.filter((p) => catchTiles.has(`${Math.floor(p.x)},${Math.floor(p.y)}`));
    expect(inCatch.map((p) => p.kind).sort()).toEqual(["health", "swap"]);
  });

  it("stocks the finally room with rockets once the launcher is owned", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(7), true);
    const finallyTiles = new Set(tilesOf(r.zones[0].finallyRect));
    const inFinally = r.pickups.filter((p) => finallyTiles.has(`${Math.floor(p.x)},${Math.floor(p.y)}`));
    expect(inFinally.map((p) => p.kind)).toEqual(["rockets"]);
  });

  it("falls back to bullets in the finally room without the launcher", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(8), false);
    const finallyTiles = new Set(tilesOf(r.zones[0].finallyRect));
    const inFinally = r.pickups.filter((p) => finallyTiles.has(`${Math.floor(p.x)},${Math.floor(p.y)}`));
    expect(inFinally.map((p) => p.kind)).toEqual(["bullets"]);
  });

  it("never anchors a zone on the spawn room", () => {
    // Unavoidable acid plus an invisible mine in the first seconds of a level
    // is exactly what `decisions.md#hazard-placement-spawn-safety` forbids.
    const g = grid(48);
    const spawnRoom = makeRoom(20, 20, 6, 6, entity({ name: "spawn", startLine: 1, endLine: 50 }));
    carve(g, spawnRoom);
    expect(placeExceptionZones([spawnRoom], g, 48, [trigger()], mulberry32(9), true).zones).toEqual([]);
  });

  it("caps at three zones however many try/catches the file has", () => {
    const g = grid(80);
    const rooms: Room[] = [makeRoom(2, 2, 4, 4, entity({ name: "spawn", startLine: 1, endLine: 5 }))];
    carve(g, rooms[0]);
    for (let i = 0; i < 8; i++) {
      const room = makeRoom(12 + (i % 4) * 16, 12 + Math.floor(i / 4) * 30, 6, 6, entity({ name: `f${i}`, startLine: 10 + i * 10, endLine: 15 + i * 10 }));
      carve(g, room);
      rooms.push(room);
    }
    const triggers = Array.from({ length: 8 }, (_, i) => trigger({ startLine: 11 + i * 10, endLine: 14 + i * 10 }));
    expect(placeExceptionZones(rooms, g, 80, triggers, mulberry32(10), true).zones.length).toBeLessThanOrEqual(3);
  });

  it("gives one anchor room at most one zone", () => {
    const { g, rooms, size } = anchorSetup();
    const triggers = [trigger({ startLine: 12 }), trigger({ startLine: 14 }), trigger({ startLine: 16 })];
    expect(placeExceptionZones(rooms, g, size, triggers, mulberry32(11), true).zones).toHaveLength(1);
  });

  it("skips a construct with neither a catch nor a finally clause", () => {
    const { g, rooms, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger({ catchCount: 0, hasFinally: false })], mulberry32(12), true);
    expect(r.zones).toEqual([]);
  });

  it("places nothing — and draws no rng — for a file with no try/catch at all", () => {
    const { g, rooms, size } = anchorSetup();
    const { rng, calls } = countingRng(13);
    const r = placeExceptionZones(rooms, g, size, [], rng, true);
    expect(r).toEqual({ zones: [], hazards: [], spikeTraps: [], mines: [], pickups: [] });
    expect(calls()).toBe(0);
  });

  it("never overwrites a tile another system already claimed", () => {
    const { g, rooms, anchor, size } = anchorSetup();
    const claimed: Tile[] = [DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE, HAZARD_TILE];
    let i = 0;
    for (let x = anchor.x - 1; x <= anchor.x + anchor.w; x++) {
      g[anchor.y - 1][x] = claimed[i++ % claimed.length];
      g[anchor.y + anchor.h][x] = claimed[i++ % claimed.length];
    }
    for (let y = anchor.y - 1; y <= anchor.y + anchor.h; y++) {
      g[y][anchor.x - 1] = claimed[i++ % claimed.length];
      g[y][anchor.x + anchor.w] = claimed[i++ % claimed.length];
    }
    const before = g.map((row) => [...row]);
    expect(placeExceptionZones(rooms, g, size, [trigger()], mulberry32(14), true).zones).toEqual([]);
    expect(g).toEqual(before);
  });

  it("returns empty instead of throwing when the chain can't fit anywhere", () => {
    // A 20-tile map has no room for a 10-tile chain plus margins on any side.
    const size = 20;
    const g = grid(size);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity({ name: "spawn", startLine: 1, endLine: 5 }));
    const anchor = makeRoom(8, 8, 8, 8, entity({ name: "risky", startLine: 10, endLine: 30 }));
    carve(g, spawnRoom);
    carve(g, anchor);
    expect(() => placeExceptionZones([spawnRoom, anchor], g, size, [trigger()], mulberry32(15), true)).not.toThrow();
    expect(placeExceptionZones([spawnRoom, anchor], g, size, [trigger()], mulberry32(15), true).zones).toEqual([]);
  });

  it("connects the whole chain back to its anchor room", () => {
    const { g, rooms, anchor, size } = anchorSetup();
    const r = placeExceptionZones(rooms, g, size, [trigger()], mulberry32(16), true);
    const seen = new Set<string>();
    const queue = [{ x: anchor.center.x, y: anchor.center.y }];
    while (queue.length > 0) {
      const p = queue.pop()!;
      const k = `${p.x},${p.y}`;
      const tile = g[p.y]?.[p.x];
      // Acid and spike tiles are walkable — they hurt, they don't block.
      if (seen.has(k) || (tile !== 0 && tile !== HAZARD_TILE && tile !== SPIKE_TRAP_TILE)) continue;
      seen.add(k);
      queue.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
    }
    for (const key of tilesOf(r.zones[0].finallyRect)) expect(seen.has(key)).toBe(true);
  });

  it("is deterministic for the same rng seed", () => {
    const run = () => {
      const { g, rooms, size } = anchorSetup();
      return placeExceptionZones(rooms, g, size, [trigger()], mulberry32(42), true);
    };
    expect(run()).toEqual(run());
  });

  it("produces different layouts for different seeds", () => {
    const run = (seed: number) => {
      const { g, rooms, size } = anchorSetup();
      return placeExceptionZones(rooms, g, size, [trigger()], mulberry32(seed), true);
    };
    expect(run(1)).not.toEqual(run(555));
  });
});
