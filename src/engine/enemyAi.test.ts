// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import type { Enemy, GameMap, Tile } from "../map/types";
import { updateEnemies, type EnemyTarget } from "./enemyAi";
import { PathField } from "./pathField";
import { Player } from "./player";
import type { Projectile } from "./projectiles";

function openGrid(size: number): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
}

function fakeMap(grid: Tile[][], spawn = { x: 1, y: 1 }): GameMap {
  return {
    width: grid[0]?.length ?? 0,
    height: grid.length,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn,
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
  };
}

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 5,
    y: 5,
    hp: 100,
    maxHp: 100,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 3, y: 3, w: 6, h: 6 },
    aggroed: false,
    discovered: false,
    roamX: 5,
    roamY: 5,
    fireCooldown: 0,
    entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

function pathFieldFor(map: GameMap, player: Player): PathField {
  const pf = new PathField();
  pf.ensure(map, Math.floor(player.posX), Math.floor(player.posY), 0);
  return pf;
}

/** One-target roster, the N=1 shape every existing test exercises. */
function targetsFor(player: Player, id = "p1"): EnemyTarget[] {
  return [{ id, player }];
}

/** `pathFields` map matching `targetsFor`'s single-entry roster. */
function pathFieldsFor(map: GameMap, player: Player, id = "p1"): ReadonlyMap<string, PathField> {
  return new Map([[id, pathFieldFor(map, player)]]);
}

const noRng = () => 0; // deterministic "always minimum roll"

describe("updateEnemies", () => {
  it("skips a dead enemy entirely", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    const e = enemy({ alive: false, attackCooldown: 5 });
    const damage = updateEnemies([e], targetsFor(player), map, 1, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(0);
    expect(e.attackCooldown).toBe(5); // untouched
  });

  it("cools down attackCooldown and fireCooldown by dt, floored at 0", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 100;
    player.posY = 100; // far away, stays un-aggroed
    const e = enemy({ attackCooldown: 0.3, fireCooldown: 0.5 });
    updateEnemies([e], targetsFor(player), map, 1, [], pathFieldsFor(map, player));
    expect(e.attackCooldown).toBe(0);
    expect(e.fireCooldown).toBe(0);
  });

  it("wakes up (aggroes) once the player is within range and visible", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 6;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: false });
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(e.aggroed).toBe(true);
  });

  it("does not aggro through a wall (no line of sight)", () => {
    const grid = openGrid(20);
    for (let y = 0; y < 20; y++) grid[y][6] = 1; // solid wall column between enemy and player
    const map = fakeMap(grid);
    const player = new Player(map);
    player.posX = 8;
    player.posY = 5;
    const e = enemy({ x: 4, y: 5, aggroed: false });
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(e.aggroed).toBe(false);
  });

  it("does not aggro when the player is outside the aggro radius", () => {
    const map = fakeMap(openGrid(40));
    const player = new Player(map);
    player.posX = 30;
    player.posY = 30;
    const e = enemy({ x: 5, y: 5, aggroed: false });
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(e.aggroed).toBe(false);
  });

  it("stays aggroed (sticky) even if the player leaves range afterward", () => {
    const map = fakeMap(openGrid(40));
    const player = new Player(map);
    player.posX = 30;
    player.posY = 30;
    const e = enemy({ x: 5, y: 5, aggroed: true });
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(e.aggroed).toBe(true);
  });

  it("roams toward its target when not aggroed", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 100;
    player.posY = 100;
    const e = enemy({ x: 5, y: 5, roamX: 8, roamY: 5, aggroed: false });
    const before = { x: e.x, y: e.y };
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player), noRng);
    expect(e.x).not.toBe(before.x);
  });

  it("bails to roam and returns no damage when the target roster is empty (e.g. every player just died)", () => {
    const map = fakeMap(openGrid(20));
    const e = enemy({ x: 5, y: 5, roamX: 8, roamY: 5, aggroed: false });
    const before = { x: e.x, y: e.y };
    const damage = updateEnemies([e], [], map, 0.1, [], new Map(), noRng);
    expect(damage.size).toBe(0);
    expect(e.x).not.toBe(before.x); // still roams toward roamX/roamY
  });

  it("targets whichever of two players is strictly nearest, tie-broken by sorted-id order", () => {
    const map = fakeMap(openGrid(20));
    const near = new Player(map);
    near.posX = 5.2;
    near.posY = 5;
    const far = new Player(map);
    far.posX = 9;
    far.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0 });
    const targets: EnemyTarget[] = [
      { id: "a", player: far },
      { id: "b", player: near },
    ];
    const pathFields = new Map([
      ["a", pathFieldFor(map, far)],
      ["b", pathFieldFor(map, near)],
    ]);
    const damage = updateEnemies([e], targets, map, 0.016, [], pathFields, noRng);
    expect(damage.get("b")).toBeGreaterThan(0); // the nearer player ("b") is bitten
    expect(damage.has("a")).toBe(false); // the farther player is untouched
  });

  it("picks a new roam target once it arrives at the current one", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 100;
    player.posY = 100;
    const e = enemy({ x: 5, y: 5, roamX: 5.01, roamY: 5, home: { x: 3, y: 3, w: 6, h: 6 }, aggroed: false });
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player), () => 0.5);
    // A new target was picked inside home bounds (snapped to a tile center).
    expect(e.roamX).toBeGreaterThanOrEqual(3);
    expect(e.roamX).toBeLessThanOrEqual(9);
  });

  it("picks a new roam target when a wall blocks the stroll", () => {
    const grid = openGrid(20);
    for (let y = 0; y < 20; y++) grid[y][6] = 1;
    const map = fakeMap(grid);
    const player = new Player(map);
    player.posX = 100;
    player.posY = 100;
    const e = enemy({ x: 5.4, y: 5, roamX: 8, roamY: 5, home: { x: 3, y: 3, w: 6, h: 6 }, aggroed: false });
    expect(() => updateEnemies([e], targetsFor(player), map, 0.5, [], pathFieldsFor(map, player), () => 0.5)).not.toThrow();
  });

  it("an Edge Case enemy can abandon its roam target early via the retarget roll", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 100;
    player.posY = 100;
    const e = enemy({
      x: 5,
      y: 5,
      roamX: 8,
      roamY: 5, // far from arrival, so retargeting is the only way roamX/Y changes
      home: { x: 3, y: 3, w: 6, h: 6 },
      aggroed: false,
      edgeCase: true,
    });
    // rng() < EDGE_CASE_RETARGET_RATE * dt with a small dt and rng always
    // returning 0 guarantees the retarget roll succeeds.
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player), () => 0);
    expect(e.roamX).not.toBe(8);
  });

  it("attacks in melee range when the cooldown has elapsed", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.2;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0 });
    const damage = updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(10);
    expect(e.attackCooldown).toBe(0.8);
  });

  it("does not attack again while the melee cooldown is still active", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.2;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0.5 });
    const damage = updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(0);
  });

  it("an Elite deals double melee damage", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.2;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0, elite: true });
    const damage = updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(20);
  });

  it("an Edge Case deals reduced melee damage", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.2;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0, edgeCase: true });
    const damage = updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(4);
  });

  it("fires a ranged bolt at a visible target within range, and sets a new cooldown", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 9;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, fireCooldown: 0 });
    const projectiles: Projectile[] = [];
    updateEnemies([e], targetsFor(player), map, 0.016, projectiles, pathFieldsFor(map, player), () => 0.5);
    expect(projectiles).toHaveLength(1);
    expect(e.fireCooldown).toBeGreaterThan(0);
  });

  it("invokes the optional onAggro/onMeleeAttack event hooks when provided", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.3; // within both aggro range and melee range in one tick
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: false, attackCooldown: 0 });
    const onAggro = vi.fn();
    const onMeleeAttack = vi.fn();
    const onRangedFire = vi.fn();
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player), noRng, { onAggro, onMeleeAttack, onRangedFire });
    expect(onAggro).toHaveBeenCalledWith(e);
    expect(onMeleeAttack).toHaveBeenCalledWith(e);
    expect(onRangedFire).not.toHaveBeenCalled();
  });

  it("invokes the optional onRangedFire event hook when a bolt is fired", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 9;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, fireCooldown: 0 });
    const onRangedFire = vi.fn();
    updateEnemies([e], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player), () => 0.5, { onRangedFire });
    expect(onRangedFire).toHaveBeenCalledWith(e);
  });

  it("falls back to straight-line steering when the nearest target has no entry in pathFields", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 12;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true });
    const before = { x: e.x, y: e.y };
    // "p1" (targetsFor's default id) deliberately has no matching entry here.
    updateEnemies([e], targetsFor(player), map, 0.1, [], new Map());
    expect(e.x).toBeGreaterThan(before.x); // still steers straight toward the player
  });

  it("does not fire while its own fire cooldown is still active", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 9;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, fireCooldown: 1 });
    const projectiles: Projectile[] = [];
    updateEnemies([e], targetsFor(player), map, 0.016, projectiles, pathFieldsFor(map, player));
    expect(projectiles).toHaveLength(0);
  });

  it("does not fire beyond ranged range", () => {
    const map = fakeMap(openGrid(40));
    const player = new Player(map);
    player.posX = 25;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, fireCooldown: 0 });
    const projectiles: Projectile[] = [];
    updateEnemies([e], targetsFor(player), map, 0.016, projectiles, pathFieldsFor(map, player));
    expect(projectiles).toHaveLength(0);
  });

  it("does not fire without line of sight", () => {
    const grid = openGrid(20);
    for (let y = 0; y < 20; y++) grid[y][7] = 1;
    const map = fakeMap(grid);
    const player = new Player(map);
    player.posX = 9;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true, fireCooldown: 0 });
    const projectiles: Projectile[] = [];
    updateEnemies([e], targetsFor(player), map, 0.016, projectiles, pathFieldsFor(map, player));
    expect(projectiles).toHaveLength(0);
  });

  it("moves toward the player while chasing at range", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 12;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true });
    const before = { x: e.x, y: e.y };
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player));
    expect(e.x).not.toBe(before.x);
  });

  it("an Edge Case chases noticeably faster than a regular enemy", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 12;
    player.posY = 5;
    const regular = enemy({ x: 5, y: 5, aggroed: true, edgeCase: false });
    const edge = enemy({ x: 5, y: 5, aggroed: true, edgeCase: true });
    updateEnemies([regular], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player));
    updateEnemies([edge], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player));
    const regularDist = Math.hypot(regular.x - 5, regular.y - 5);
    const edgeDist = Math.hypot(edge.x - 5, edge.y - 5);
    expect(edgeDist).toBeGreaterThan(regularDist);
  });

  it("aggregates damage across multiple enemies in one call", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    player.posX = 5.2;
    player.posY = 5;
    const a = enemy({ x: 5, y: 5, aggroed: true, attackCooldown: 0 });
    const b = enemy({ x: 5, y: 5.1, aggroed: true, attackCooldown: 0 });
    const damage = updateEnemies([a, b], targetsFor(player), map, 0.016, [], pathFieldsFor(map, player));
    expect(damage.get("p1") ?? 0).toBe(20);
  });

  it("falls back to straight-line steering when the player's tile is outside the pathing window", () => {
    const map = fakeMap(openGrid(60));
    const player = new Player(map);
    player.posX = 55;
    player.posY = 5;
    // Force aggro directly (far beyond real aggro radius) to exercise chase
    // steering with a waypoint that nextWaypoint() can't resolve (null).
    const e = enemy({ x: 5, y: 5, aggroed: true });
    const before = { x: e.x, y: e.y };
    expect(() => updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player))).not.toThrow();
    expect(e.x === before.x && e.y === before.y).toBe(false);
  });

  it("steers straight at the player when both stand on the same tile but outside melee range", () => {
    const map = fakeMap(openGrid(20));
    const player = new Player(map);
    // Same floor tile (5,5) as the enemy, but far enough apart within it that
    // the melee-range check doesn't fire first.
    player.posX = 5.95;
    player.posY = 5.95;
    const e = enemy({ x: 5.05, y: 5.05, aggroed: true });
    const before = { x: e.x, y: e.y };
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player));
    expect(e.x === before.x && e.y === before.y).toBe(false);
  });

  it("falls back to straight-line steering when the player's own tile is a wall (e.g. noClip)", () => {
    const grid = openGrid(20);
    grid[7][7] = 1;
    const map = fakeMap(grid);
    const player = new Player(map);
    player.noClip = true;
    player.posX = 7.5;
    player.posY = 7.5;
    const e = enemy({ x: 5, y: 5, aggroed: true });
    expect(() => updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player))).not.toThrow();
  });

  it("stops moving (holds position) when every steering heading is blocked", () => {
    const grid = openGrid(20);
    // Box the enemy in on all 4 sides so no candidate heading makes progress.
    grid[4][5] = 1;
    grid[6][5] = 1;
    grid[5][4] = 1;
    grid[5][6] = 1;
    const map = fakeMap(grid);
    const player = new Player(map);
    player.posX = 12;
    player.posY = 5;
    const e = enemy({ x: 5, y: 5, aggroed: true });
    updateEnemies([e], targetsFor(player), map, 0.1, [], pathFieldsFor(map, player));
    expect(e.x).toBe(5);
    expect(e.y).toBe(5);
  });
});
