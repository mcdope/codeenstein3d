// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import { Player } from "./player";
import {
  collectProjectileBillboards,
  spawnProjectile,
  updateProjectiles,
  type Projectile,
} from "./projectiles";

const WIDTH = 200;
const HEIGHT = 100;

function fakeMap(overrides: Partial<GameMap> = {}): GameMap {
  const grid: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
  return {
    width: 10,
    height: 10,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn: { x: 5, y: 5 },
    enemies: [],
    exit: { x: 0, y: 0 },
    shortestPathTiles: 0,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
    ...overrides,
  };
}

function facingPlayer(): Player {
  return new Player(fakeMap());
}

function ctx(): MockCanvasContext {
  return createMockCanvasContext({ width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

function clearZBuffer(value: number): Float64Array {
  return new Float64Array(WIDTH).fill(value);
}

describe("spawnProjectile", () => {
  it("aims a bolt's velocity at the target, scaled to the fixed travel speed", () => {
    const list: Projectile[] = [];
    spawnProjectile(list, 0, 0, 3, 4); // 3-4-5 triangle
    expect(list).toHaveLength(1);
    // Unit vector (0.6,0.8) * PROJECTILE_SPEED(5) = (3,4).
    expect(list[0].vx).toBeCloseTo(3);
    expect(list[0].vy).toBeCloseTo(4);
    expect(list[0].damage).toBe(8);
  });

  it("scales damage by the given multiplier", () => {
    const list: Projectile[] = [];
    spawnProjectile(list, 0, 0, 1, 0, 2);
    expect(list[0].damage).toBe(16);
  });

  it("falls back to a zero-length direction without dividing by zero", () => {
    const list: Projectile[] = [];
    expect(() => spawnProjectile(list, 5, 5, 5, 5)).not.toThrow();
    expect(list[0].vx).toBe(0);
    expect(list[0].vy).toBe(0);
  });
});

describe("updateProjectiles", () => {
  function bolt(overrides: Partial<Projectile> = {}): Projectile {
    return { x: 0, y: 0, vx: 0, vy: 0, damage: 8, ...overrides };
  }

  /** One-target roster, the N=1 shape every existing test exercises. */
  function targetsFor(player: Player, id = "p1"): { id: string; player: Player }[] {
    return [{ id, player }];
  }

  it("advances a surviving bolt's position and deals no damage", () => {
    const player = facingPlayer(); // spawn (5,5) -> posX/posY 5.5,5.5
    const map = fakeMap();
    const list = [bolt({ x: 1, y: 1, vx: 1, vy: 0 })];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.size).toBe(0);
    expect(list).toHaveLength(1);
    expect(list[0].x).toBeCloseTo(1.1);
  });

  it("hits the player when within reach, dealing its damage and removing itself", () => {
    const player = facingPlayer();
    const map = fakeMap();
    const list = [bolt({ x: player.posX, y: player.posY, vx: 0, vy: 0, damage: 8 })];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.get("p1")).toBe(8);
    expect(list).toHaveLength(0);
  });

  it("sums damage across multiple simultaneous player hits", () => {
    const player = facingPlayer();
    const map = fakeMap();
    const list = [
      bolt({ x: player.posX, y: player.posY, damage: 8 }),
      bolt({ x: player.posX, y: player.posY, damage: 12 }),
    ];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.get("p1")).toBe(20);
    expect(list).toHaveLength(0);
  });

  it("destroys a bolt that flies into a wall tile, without dealing damage", () => {
    const player = facingPlayer();
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[2][2] = 1; // wall
    const map = fakeMap({ grid: g });
    const list = [bolt({ x: 2.4, y: 2.4, vx: 0, vy: 0 })]; // already sitting in the wall tile
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.size).toBe(0);
    expect(list).toHaveLength(0);
  });

  it("destroys a bolt that flies off the map's edge", () => {
    const player = facingPlayer();
    const map = fakeMap();
    const list = [bolt({ x: -5, y: -5, vx: 0, vy: 0 })];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.size).toBe(0);
    expect(list).toHaveLength(0);
  });

  it("prioritizes a player hit over a simultaneous wall collision", () => {
    const player = facingPlayer();
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[Math.floor(player.posY)][Math.floor(player.posX)] = 1; // player's own tile is (weirdly) a wall
    const map = fakeMap({ grid: g });
    const list = [bolt({ x: player.posX, y: player.posY, damage: 8 })];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.get("p1")).toBe(8); // still counted as a player hit, not silently eaten by the wall check
    expect(list).toHaveLength(0);
  });

  it("processes multiple bolts independently in one call", () => {
    const player = facingPlayer();
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[2][2] = 1;
    const map = fakeMap({ grid: g });
    const list = [
      bolt({ x: 8, y: 8, vx: 0, vy: 0 }), // survives
      bolt({ x: 2.4, y: 2.4, vx: 0, vy: 0 }), // hits wall
      bolt({ x: player.posX, y: player.posY, vx: 0, vy: 0, damage: 8 }), // hits player
    ];
    const damage = updateProjectiles(list, targetsFor(player), map, 0.1);
    expect(damage.get("p1")).toBe(8);
    expect(list).toHaveLength(1);
    expect(list[0].x).toBeCloseTo(8);
  });

  it("resolves a bolt against the first target in sorted order when two players are both in reach", () => {
    const playerA = facingPlayer();
    const playerB = facingPlayer();
    const map = fakeMap();
    const list = [bolt({ x: playerA.posX, y: playerA.posY, damage: 8 })];
    const damage = updateProjectiles(list, [{ id: "a", player: playerA }, { id: "b", player: playerB }], map, 0.1);
    expect(damage.get("a")).toBe(8);
    expect(damage.has("b")).toBe(false);
  });
});

describe("collectProjectileBillboards", () => {
  it("filters out a bolt too close to the player", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectProjectileBillboards(
      asCtx(c),
      player,
      [{ x: player.posX, y: player.posY, vx: 0, vy: 0, damage: 8 }],
      clearZBuffer(Infinity),
    );
    expect(jobs).toHaveLength(0);
  });

  it("returns a draw job for a visible bolt, with the magenta orb palette", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectProjectileBillboards(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, vx: 0, vy: 0, damage: 8 }],
      clearZBuffer(Infinity),
    );
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillStyle).toBe("#ffd0ec"); // last layer drawn: the bright center
    expect(c.fillRect).toHaveBeenCalledTimes(3); // halo + core + center
  });

  it("draws nothing for a bolt occluded by a nearer wall", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectProjectileBillboards(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, vx: 0, vy: 0, damage: 8 }],
      clearZBuffer(0.5),
    );
    expect(jobs).toHaveLength(1); // still a job — occlusion is checked lazily inside draw()
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});
