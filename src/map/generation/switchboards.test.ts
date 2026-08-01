// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity, SwitchBranchSummary } from "../../parser/types";
import {
  BRANCH_DOOR_TILE,
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
import { placeSwitchboardEncounters, placeSwitchboards, SWITCHBOARDS_ENABLED } from "./switchboards";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function switchEntity(branches: SwitchBranchSummary, overrides: Partial<CodeEntity> = {}): CodeEntity {
  return entity({ switchBranches: branches, ...overrides });
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function carve(g: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
  }
}

/** A spawn room at index 0 plus one hub — the minimum shape `placeSwitchboards`
 * needs, since it always skips index 0. */
function hubSetup(size: number, branches: SwitchBranchSummary, hubOverrides: Partial<CodeEntity> = {}) {
  const g = grid(size);
  const spawnRoom = makeRoom(2, 2, 4, 4, entity({ name: "spawn" }));
  const hub = makeRoom(Math.floor(size / 2) - 3, Math.floor(size / 2) - 3, 6, 6, switchEntity(branches, hubOverrides));
  carve(g, spawnRoom);
  carve(g, hub);
  return { g, rooms: [spawnRoom, hub], hub };
}

function countingRng(seed: number): { rng: () => number; calls: () => number } {
  const inner = mulberry32(seed);
  let calls = 0;
  return { rng: () => { calls += 1; return inner(); }, calls: () => calls };
}

describe("SWITCHBOARDS_ENABLED", () => {
  it("is on by default", () => {
    expect(SWITCHBOARDS_ENABLED).toBe(true);
  });
});

describe("placeSwitchboards", () => {
  it("carves one dead-end room per case branch", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 3, hasDefault: true });
    expect(placeSwitchboards(rooms, g, 40, mulberry32(1))).toHaveLength(3);
  });

  it("gives the default branch no room of its own", () => {
    // Same case count, default present or not — the spoke count must match the
    // *case* count either way, since default is the path that continues on.
    const withDefault = hubSetup(40, { caseCount: 2, hasDefault: true });
    const without = hubSetup(40, { caseCount: 2, hasDefault: false });
    expect(placeSwitchboards(withDefault.rooms, withDefault.g, 40, mulberry32(2))).toHaveLength(2);
    expect(placeSwitchboards(without.rooms, without.g, 40, mulberry32(2))).toHaveLength(2);
  });

  it("caps a 30-case enum at five spokes, no more than two on any one side", () => {
    const { g, rooms, hub } = hubSetup(48, { caseCount: 30, hasDefault: true });
    const spokes = placeSwitchboards(rooms, g, 48, mulberry32(3));
    expect(spokes).toHaveLength(5);

    const sideOf = (r: Rect): string => {
      if (r.y + r.h <= hub.y) return "top";
      if (r.y >= hub.y + hub.h) return "bottom";
      return r.x + r.w <= hub.x ? "left" : "right";
    };
    const perSide = new Map<string, number>();
    for (const spoke of spokes) perSide.set(sideOf(spoke), (perSide.get(sideOf(spoke)) ?? 0) + 1);
    for (const count of perSide.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it("puts a keyless branch door on every spoke's mouth", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 3, hasDefault: true });
    const spokes = placeSwitchboards(rooms, g, 40, mulberry32(4));
    expect(spokes.length).toBeGreaterThan(0);
    let doors = 0;
    for (const row of g) for (const tile of row) if (tile === BRANCH_DOOR_TILE) doors += 1;
    expect(doors).toBe(spokes.length);
  });

  it("never uses a key-locked door for a spoke", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 4, hasDefault: true });
    placeSwitchboards(rooms, g, 40, mulberry32(5));
    expect(g.some((row) => row.includes(DOOR_TILE))).toBe(false);
  });

  it("connects every spoke back to its hub through the branch door", () => {
    const { g, rooms, hub } = hubSetup(40, { caseCount: 3, hasDefault: true });
    const spokes = placeSwitchboards(rooms, g, 40, mulberry32(6));
    // Flood fill treating a branch door as passable — which is exactly what
    // `reachableTiles` does, since it costs no key.
    const seen = new Set<string>();
    const queue = [{ x: hub.center.x, y: hub.center.y }];
    while (queue.length > 0) {
      const p = queue.pop()!;
      const k = `${p.x},${p.y}`;
      const tile = g[p.y]?.[p.x];
      if (seen.has(k) || (tile !== 0 && tile !== BRANCH_DOOR_TILE)) continue;
      seen.add(k);
      queue.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
    }
    for (const spoke of spokes) expect(seen.has(`${spoke.x},${spoke.y}`)).toBe(true);
  });

  it("does build a hub on the spawn room — unlike the hazard-carving features", () => {
    // Deliberately allowed: a spur carves no unavoidable damage (its worst
    // content is one weak enemy behind a closed door), so
    // `decisions.md#hazard-placement-spawn-safety` doesn't apply the way it
    // does to exception zones and acid overflows. Excluding it silently cost
    // any level whose first entity holds the switch.
    const g = grid(40);
    const spawnRoom = makeRoom(16, 16, 6, 6, switchEntity({ caseCount: 4, hasDefault: true }, { name: "spawn" }));
    carve(g, spawnRoom);
    expect(placeSwitchboards([spawnRoom], g, 40, mulberry32(7)).length).toBeGreaterThan(0);
  });

  it("ignores a class room, even though its summary aggregates its methods' switches", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 4, hasDefault: true }, { kind: "class" });
    expect(placeSwitchboards(rooms, g, 40, mulberry32(8))).toEqual([]);
  });

  it("builds a hub for a method, not just a plain function", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 2, hasDefault: true }, { kind: "method" });
    expect(placeSwitchboards(rooms, g, 40, mulberry32(9)).length).toBeGreaterThan(0);
  });

  it("places nothing — and draws no rng — for a room with no switch at all", () => {
    const g = grid(40);
    const spawnRoom = makeRoom(2, 2, 4, 4, entity({ name: "spawn" }));
    const plain = makeRoom(16, 16, 6, 6, entity({ name: "plain" }));
    carve(g, spawnRoom);
    carve(g, plain);
    const { rng, calls } = countingRng(10);
    expect(placeSwitchboards([spawnRoom, plain], g, 40, rng)).toEqual([]);
    expect(calls()).toBe(0);
  });

  it("places nothing for a switch that has only a default arm", () => {
    const { g, rooms } = hubSetup(40, { caseCount: 0, hasDefault: true });
    expect(placeSwitchboards(rooms, g, 40, mulberry32(11))).toEqual([]);
  });

  it("never overwrites a tile another system already claimed", () => {
    const { g, rooms, hub } = hubSetup(40, { caseCount: 4, hasDefault: true });
    const claimed: Tile[] = [DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE, HAZARD_TILE];
    let i = 0;
    for (let x = hub.x - 1; x <= hub.x + hub.w; x++) {
      g[hub.y - 1][x] = claimed[i++ % claimed.length];
      g[hub.y + hub.h][x] = claimed[i++ % claimed.length];
    }
    for (let y = hub.y - 1; y <= hub.y + hub.h; y++) {
      g[y][hub.x - 1] = claimed[i++ % claimed.length];
      g[y][hub.x + hub.w] = claimed[i++ % claimed.length];
    }
    const before = g.map((row) => [...row]);
    expect(placeSwitchboards(rooms, g, 40, mulberry32(12))).toEqual([]);
    expect(g).toEqual(before);
  });

  it("returns empty instead of throwing when there is no free rock at all", () => {
    const size = 16;
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 0 as Tile));
    const spawnRoom = makeRoom(1, 1, 3, 3, entity({ name: "spawn" }));
    const hub = makeRoom(6, 6, 4, 4, switchEntity({ caseCount: 3, hasDefault: true }));
    expect(() => placeSwitchboards([spawnRoom, hub], g, size, mulberry32(13))).not.toThrow();
    expect(placeSwitchboards([spawnRoom, hub], g, size, mulberry32(13))).toEqual([]);
  });

  it("is deterministic for the same rng seed", () => {
    const run = () => {
      const { g, rooms } = hubSetup(40, { caseCount: 3, hasDefault: true });
      return placeSwitchboards(rooms, g, 40, mulberry32(42));
    };
    expect(run()).toEqual(run());
  });

  it("produces different layouts for different seeds", () => {
    const run = (seed: number) => {
      const { g, rooms } = hubSetup(40, { caseCount: 3, hasDefault: true });
      return placeSwitchboards(rooms, g, 40, mulberry32(seed));
    };
    expect(run(1)).not.toEqual(run(777));
  });
});

describe("placeSwitchboardEncounters", () => {
  /** A carved 2x2 spoke far from spawn, on an otherwise-solid grid. */
  function spokeSetup(size = 40): { g: Tile[][]; spoke: Rect } {
    const g = grid(size);
    const spoke = { x: 20, y: 20, w: 2, h: 2 };
    for (let y = spoke.y; y < spoke.y + spoke.h; y++) {
      for (let x = spoke.x; x < spoke.x + spoke.w; x++) g[y][x] = 0;
    }
    return { g, spoke };
  }

  const FAR_SPAWN = { x: 2, y: 2 };
  const FAR_EXIT = { x: 38, y: 38 };

  it("populates every spoke with exactly one encounter", () => {
    // Sampled across seeds so all three outcomes (enemy / trap-or-mine /
    // pickup) are exercised rather than whichever one seed 1 happens to roll.
    for (let seed = 1; seed <= 12; seed++) {
      const { g, spoke } = spokeSetup();
      const r = placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(seed));
      const total = r.enemies.length + r.spikeTraps.length + r.mines.length + r.pickups.length;
      expect(total).toBe(1);
    }
  });

  it("produces all three encounter kinds across seeds", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const { g, spoke } = spokeSetup();
      const r = placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(seed));
      if (r.enemies.length) kinds.add("enemy");
      if (r.spikeTraps.length) kinds.add("trap");
      if (r.mines.length) kinds.add("mine");
      if (r.pickups.length) kinds.add("pickup");
    }
    expect(kinds).toEqual(new Set(["enemy", "trap", "mine", "pickup"]));
  });

  it("tags its enemies as Edge Case tier, never as real parsed code", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { g, spoke } = spokeSetup();
      const r = placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(seed));
      for (const e of r.enemies) {
        expect(e.edgeCase).toBe(true);
        expect(e.elite).toBe(false);
        // `kind: "class"` is what keeps a synthetic entity out of every
        // "real code" eligibility check elsewhere in generation/.
        expect(e.entity.kind).toBe("class");
      }
    }
  });

  it("marks a spike trap on the grid but leaves a mine's tile plain floor", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { g, spoke } = spokeSetup();
      const r = placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(seed));
      for (const t of r.spikeTraps) expect(g[t.y][t.x]).toBe(SPIKE_TRAP_TILE);
      for (const m of r.mines) expect(g[Math.floor(m.y)][Math.floor(m.x)]).toBe(0);
    }
  });

  it("never places a trap or mine within trap spacing of spawn", () => {
    // Spawn placed right on top of the spoke — every damaging outcome must be
    // suppressed (`decisions.md#hazard-placement-spawn-safety`).
    for (let seed = 1; seed <= 40; seed++) {
      const { g, spoke } = spokeSetup();
      const r = placeSwitchboardEncounters([spoke], g, { x: spoke.x, y: spoke.y }, FAR_EXIT, mulberry32(seed));
      expect(r.spikeTraps).toEqual([]);
      expect(r.mines).toEqual([]);
    }
  });

  it("still places its encounter when the spoke's only free tile is the exit", () => {
    // Falls back to the exit tile rather than skipping the spoke entirely —
    // the exit is never inside a spoke in a real map (spokes are carved from
    // untouched rock, `pickExit` only ever picks a room center), so this is
    // the degenerate-input path, not a scenario to design around.
    const { g, spoke } = spokeSetup();
    g[spoke.y][spoke.x + 1] = 1;
    g[spoke.y + 1][spoke.x] = 1;
    g[spoke.y + 1][spoke.x + 1] = 1;
    const exit = { x: spoke.x, y: spoke.y };
    let placed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const fresh = spokeSetup();
      fresh.g[spoke.y][spoke.x + 1] = 1;
      fresh.g[spoke.y + 1][spoke.x] = 1;
      fresh.g[spoke.y + 1][spoke.x + 1] = 1;
      const r = placeSwitchboardEncounters([spoke], fresh.g, FAR_SPAWN, exit, mulberry32(seed));
      placed += r.enemies.length + r.pickups.length + r.spikeTraps.length + r.mines.length;
    }
    expect(placed).toBe(20);
  });

  it("places nothing for a spoke with no free floor left", () => {
    const { g, spoke } = spokeSetup();
    for (let y = spoke.y; y < spoke.y + spoke.h; y++) {
      for (let x = spoke.x; x < spoke.x + spoke.w; x++) g[y][x] = 1;
    }
    const r = placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(1));
    expect(r).toEqual({ enemies: [], spikeTraps: [], mines: [], pickups: [] });
  });

  it("places nothing when there are no spokes", () => {
    const { g } = spokeSetup();
    const { rng, calls } = countingRng(1);
    expect(placeSwitchboardEncounters([], g, FAR_SPAWN, FAR_EXIT, rng)).toEqual({
      enemies: [], spikeTraps: [], mines: [], pickups: [],
    });
    expect(calls()).toBe(0);
  });

  it("is deterministic for the same rng seed", () => {
    const run = () => {
      const { g, spoke } = spokeSetup();
      return placeSwitchboardEncounters([spoke], g, FAR_SPAWN, FAR_EXIT, mulberry32(42));
    };
    expect(run()).toEqual(run());
  });
});
