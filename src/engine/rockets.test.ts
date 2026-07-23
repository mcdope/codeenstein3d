// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import { Player } from "./player";
import {
  collectRocketBillboards,
  ROCKET_BLAST_RADIUS,
  rocketDamageAt,
  spawnRocket,
  updateRockets,
  type Rocket,
  type RocketExplosion,
} from "./rockets";

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

const noEnemiesNear = () => false;

describe("spawnRocket", () => {
  it("launches from a small offset ahead of the muzzle, along the given direction", () => {
    const list: Rocket[] = [];
    spawnRocket(list, 5, 5, 1, 0, 40, "p1");
    expect(list).toHaveLength(1);
    expect(list[0].x).toBeCloseTo(5.4);
    expect(list[0].y).toBeCloseTo(5);
    expect(list[0].vx).toBeCloseTo(18); // ROCKET_SPEED
    expect(list[0].vy).toBe(0);
    expect(list[0].damage).toBe(40);
    expect(list[0].firedBy).toBe("p1");
  });

  it("bakes in the damage at fire time", () => {
    const list: Rocket[] = [];
    spawnRocket(list, 0, 0, 0, 1, 999, "p1");
    expect(list[0].damage).toBe(999);
  });
});

describe("updateRockets", () => {
  function rocket(overrides: Partial<Rocket> = {}): Rocket {
    return { x: 0, y: 0, vx: 0, vy: 0, damage: 40, firedBy: "p1", ...overrides };
  }

  it("advances a surviving rocket's position with no detonation", () => {
    const map = fakeMap();
    const list = [rocket({ x: 5, y: 5, vx: 2, vy: 0 })];
    const explosions = updateRockets(list, noEnemiesNear, map, 0.1);
    expect(explosions).toHaveLength(0);
    expect(list).toHaveLength(1);
    expect(list[0].x).toBeCloseTo(5.2);
  });

  it("detonates on nearing a living enemy", () => {
    const map = fakeMap();
    const list = [rocket({ x: 5, y: 5, damage: 40 })];
    const explosions = updateRockets(list, () => true, map, 0.1);
    expect(explosions).toEqual([{ x: 5, y: 5, damage: 40, firedBy: "p1" }]);
    expect(list).toHaveLength(0);
  });

  it("detonates on hitting a wall", () => {
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[3][3] = 1;
    const map = fakeMap({ grid: g });
    const list = [rocket({ x: 3.5, y: 3.5, vx: 0, vy: 0, damage: 40 })];
    const explosions = updateRockets(list, noEnemiesNear, map, 0.1);
    expect(explosions).toHaveLength(1);
    expect(list).toHaveLength(0);
  });

  it("detonates once even when it both nears an enemy and hits a wall simultaneously", () => {
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[3][3] = 1;
    const map = fakeMap({ grid: g });
    const list = [rocket({ x: 3.5, y: 3.5, vx: 0, vy: 0, damage: 40 })];
    const explosions = updateRockets(list, () => true, map, 0.1);
    expect(explosions).toHaveLength(1);
  });

  it("queries proximity at the rocket's trigger radius, centered on its new position", () => {
    const map = fakeMap();
    const list = [rocket({ x: 5, y: 5, vx: 0, vy: 0 })];
    const near = vi.fn(() => false);
    updateRockets(list, near, map, 0.1);
    expect(near).toHaveBeenCalledWith(5, 5, 0.4); // ROCKET_ENEMY_TRIGGER_RADIUS
  });

  it("processes multiple rockets independently in one call", () => {
    const g: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
    g[3][3] = 1;
    const map = fakeMap({ grid: g });
    const list = [
      rocket({ x: 8, y: 8, vx: 0, vy: 0, damage: 10 }), // survives
      rocket({ x: 3.5, y: 3.5, vx: 0, vy: 0, damage: 20 }), // hits wall
    ];
    const explosions = updateRockets(list, noEnemiesNear, map, 0.1);
    expect(explosions).toEqual([{ x: 3.5, y: 3.5, damage: 20, firedBy: "p1" }]);
    expect(list).toHaveLength(1);
    expect(list[0].damage).toBe(10);
  });

  it("carries firedBy through to the explosion so the engine can exclude teammates from splash", () => {
    const map = fakeMap();
    const list = [rocket({ x: 5, y: 5, damage: 40, firedBy: "hostPlayer" })];
    const explosions = updateRockets(list, () => true, map, 0.1);
    expect(explosions[0].firedBy).toBe("hostPlayer");
  });
});

describe("rocketDamageAt", () => {
  function explosion(overrides: Partial<RocketExplosion> = {}): RocketExplosion {
    return { x: 0, y: 0, damage: 100, firedBy: "p1", ...overrides };
  }

  it("deals max damage at ground zero", () => {
    expect(rocketDamageAt(explosion(), 0, 0)).toBe(100);
  });

  it("deals 0 damage at or beyond the blast radius", () => {
    expect(rocketDamageAt(explosion(), ROCKET_BLAST_RADIUS, 0)).toBe(0);
    expect(rocketDamageAt(explosion(), ROCKET_BLAST_RADIUS + 1, 0)).toBe(0);
  });

  it("floors falloff damage near the edge of the blast instead of trailing to 0", () => {
    const dmg = rocketDamageAt(explosion(), ROCKET_BLAST_RADIUS - 0.01, 0);
    expect(dmg).toBeCloseTo(100 * 0.3, 1); // ROCKET_DAMAGE_FALLOFF_FLOOR
  });
});

describe("collectRocketBillboards", () => {
  it("filters out a rocket too close to the player", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectRocketBillboards(
      asCtx(c),
      player,
      [{ x: player.posX, y: player.posY, vx: 0, vy: 0, damage: 40, firedBy: "p1" }],
      clearZBuffer(Infinity),
    );
    expect(jobs).toHaveLength(0);
  });

  it("returns a draw job for a visible rocket, with the orange orb palette", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectRocketBillboards(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, vx: 0, vy: 0, damage: 40, firedBy: "p1" }],
      clearZBuffer(Infinity),
    );
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillStyle).toBe("#ffd9a0"); // last layer drawn: the bright center
    expect(c.fillRect).toHaveBeenCalledTimes(3);
  });

  it("draws nothing for a rocket occluded by a nearer wall", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectRocketBillboards(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, vx: 0, vy: 0, damage: 40, firedBy: "p1" }],
      clearZBuffer(0.5),
    );
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});
