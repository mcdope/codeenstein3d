// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { Decoration, Enemy, GameMap, KeyItem, LootDrop, Mine, Teleporter, Tile } from "../map/types";
import type { CodeEntity } from "../parser/types";
import { Player } from "./player";
import {
  collectDecorationBillboards,
  collectEnemyBillboards,
  collectExitBillboard,
  collectKeyBillboards,
  collectLootBillboards,
  collectMineBillboards,
  collectOrbBillboards,
  collectPlayerBillboards,
  collectTeleporterBillboards,
  EDGE_CASE_COLOR,
  enemyColor,
  findMineAtColumn,
  findMineInProjections,
  findTargetAtColumn,
  findTargetInProjections,
  findTargetUnderCrosshair,
  projectEnemy,
  projectLivingEnemies,
  projectPoint,
  projectVisibleMines,
} from "./sprites";

const WIDTH = 100;
const HEIGHT = 60;

function fakeMap(): GameMap {
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

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "doStuff", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0, ...overrides };
}

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 0,
    y: 0,
    hp: 10,
    maxHp: 10,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 10, h: 10 },
    aggroed: false,
    discovered: false,
    roamX: 0,
    roamY: 0,
    fireCooldown: 0,
    entity: entity(),
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

function mine(overrides: Partial<Mine> = {}): Mine {
  return { x: 0, y: 0, alive: true, visible: true, closeTimer: 0, ...overrides };
}

describe("enemyColor", () => {
  it("colors a function red, a method orange, and anything else purple", () => {
    expect(enemyColor("function")).toBe("#e0483a");
    expect(enemyColor("method")).toBe("#e08a2a");
    expect(enemyColor("class")).toBe("#b84ad0");
  });
});

describe("projectPoint", () => {
  it("gives a positive depth and centered screenX for a point straight ahead", () => {
    const player = facingPlayer();
    const proj = projectPoint(player, player.posX + 3, player.posY, WIDTH, HEIGHT);
    expect(proj.depth).toBeCloseTo(3);
    expect(proj.screenX).toBeCloseTo(WIDTH / 2);
  });

  it("gives a negative depth for a point behind the camera", () => {
    const player = facingPlayer();
    const proj = projectPoint(player, player.posX - 3, player.posY, WIDTH, HEIGHT);
    expect(proj.depth).toBeLessThan(0);
  });

  it("shrinks the projected size as distance increases", () => {
    const player = facingPlayer();
    const near = projectPoint(player, player.posX + 1, player.posY, WIDTH, HEIGHT);
    const far = projectPoint(player, player.posX + 10, player.posY, WIDTH, HEIGHT);
    expect(far.right - far.left).toBeLessThan(near.right - near.left);
  });

  it("scales the projected size with sizeFactor", () => {
    const player = facingPlayer();
    const small = projectPoint(player, player.posX + 3, player.posY, WIDTH, HEIGHT, 0.2);
    const large = projectPoint(player, player.posX + 3, player.posY, WIDTH, HEIGHT, 2);
    expect(large.right - large.left).toBeGreaterThan(small.right - small.left);
  });

  it("offsets screenX away from center for a point off to one side", () => {
    const player = facingPlayer();
    const centered = projectPoint(player, player.posX + 3, player.posY, WIDTH, HEIGHT);
    const offset = projectPoint(player, player.posX + 3, player.posY + 1, WIDTH, HEIGHT);
    expect(offset.screenX).not.toBeCloseTo(centered.screenX);
  });
});

describe("projectEnemy", () => {
  it("projects a regular enemy at the default size", () => {
    const player = facingPlayer();
    const regular = projectEnemy(player, enemy({ x: player.posX + 3, y: player.posY }), WIDTH, HEIGHT);
    const asPoint = projectPoint(player, player.posX + 3, player.posY, WIDTH, HEIGHT);
    expect(regular.right - regular.left).toBeCloseTo(asPoint.right - asPoint.left);
  });

  it("projects an Elite larger than a regular enemy", () => {
    const player = facingPlayer();
    const regular = projectEnemy(player, enemy({ x: player.posX + 3, y: player.posY, elite: false }), WIDTH, HEIGHT);
    const elite = projectEnemy(player, enemy({ x: player.posX + 3, y: player.posY, elite: true }), WIDTH, HEIGHT);
    expect(elite.right - elite.left).toBeGreaterThan(regular.right - regular.left);
  });

  it("projects an Edge Case smaller than a regular enemy", () => {
    const player = facingPlayer();
    const regular = projectEnemy(player, enemy({ x: player.posX + 3, y: player.posY, edgeCase: false }), WIDTH, HEIGHT);
    const edgeCase = projectEnemy(player, enemy({ x: player.posX + 3, y: player.posY, edgeCase: true }), WIDTH, HEIGHT);
    expect(edgeCase.right - edgeCase.left).toBeLessThan(regular.right - regular.left);
  });
});

describe("collectEnemyBillboards", () => {
  it("filters out dead enemies", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ alive: false, x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("filters out an enemy too close to the player", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX, y: player.posY })], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("draws a normal enemy's body in its kind color", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("tints a recently-hit enemy's body red regardless of its normal color", () => {
    const player = facingPlayer();
    const c = ctx();
    // fillStyle is a plain mutable field, overwritten again later by the HP
    // bar/label overlay — log which style was active at each fillRect call
    // to check the body-color choice specifically, not just the final state.
    const log: string[] = [];
    c.fillRect.mockImplementation(() => {
      log.push(c.fillStyle as string);
    });
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX + 3, y: player.posY, hitFlash: 3, elite: true })], clearZBuffer(Infinity));
    jobs[0].draw();
    expect(log).toContain("#ff5a4a"); // hit-flash red, not the Elite's gold tint
  });

  it("skips wall-occluded body columns but still draws unoccluded ones", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX + 3, y: player.posY })], clearZBuffer(0.5));
    jobs[0].draw();
    // Fully occluded (zBuffer 0.5 < depth 3 everywhere) -> body loop draws nothing.
    expect(c.fillRect.mock.calls.length).toBe(0);
  });

  it("draws the HP-bar/name overlay only when the sprite's center isn't wall-occluded", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity));
    jobs[0].draw();
    expect(c.fillText).toHaveBeenCalled();
  });

  it("shows the Elite warning caption for an Elite, and the Edge Case caption for an Edge Case", () => {
    const player = facingPlayer();
    const cElite = ctx();
    collectEnemyBillboards(asCtx(cElite), player, [enemy({ x: player.posX + 3, y: player.posY, elite: true })], clearZBuffer(Infinity))[0].draw();
    expect(cElite.fillText).toHaveBeenCalledWith("⚠ ELITE", expect.any(Number), expect.any(Number));

    const cEdge = ctx();
    collectEnemyBillboards(asCtx(cEdge), player, [enemy({ x: player.posX + 3, y: player.posY, edgeCase: true })], clearZBuffer(Infinity))[0].draw();
    expect(cEdge.fillText).toHaveBeenCalledWith("⚠ EDGE CASE", expect.any(Number), expect.any(Number));
  });

  it("shows no warning caption for a plain enemy", () => {
    const player = facingPlayer();
    const c = ctx();
    collectEnemyBillboards(asCtx(c), player, [enemy({ x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity))[0].draw();
    expect(c.fillText).not.toHaveBeenCalledWith("⚠ ELITE", expect.any(Number), expect.any(Number));
    expect(c.fillText).not.toHaveBeenCalledWith("⚠ EDGE CASE", expect.any(Number), expect.any(Number));
  });
});

describe("collectPlayerBillboards", () => {
  it("returns nothing for an empty roster (the N=1 shape — the viewer is never in the list)", () => {
    const viewer = facingPlayer();
    const jobs = collectPlayerBillboards(asCtx(ctx()), viewer, [], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("filters out a teammate too close to the viewer", () => {
    const viewer = facingPlayer();
    const teammate = new Player(fakeMap());
    teammate.posX = viewer.posX;
    teammate.posY = viewer.posY;
    const jobs = collectPlayerBillboards(asCtx(ctx()), viewer, [{ player: teammate, color: "#60a5fa" }], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("draws a visible teammate's body in their own tint color", () => {
    const viewer = facingPlayer();
    const teammate = new Player(fakeMap());
    teammate.posX = viewer.posX + 3;
    teammate.posY = viewer.posY;
    const c = ctx();
    const log: string[] = [];
    c.fillRect.mockImplementation(() => {
      log.push(c.fillStyle as string);
    });
    const jobs = collectPlayerBillboards(asCtx(c), viewer, [{ player: teammate, color: "#60a5fa" }], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillRect).toHaveBeenCalled();
    expect(log).toContain("#60a5fa");
  });

  it("skips wall-occluded body columns", () => {
    const viewer = facingPlayer();
    const teammate = new Player(fakeMap());
    teammate.posX = viewer.posX + 3;
    teammate.posY = viewer.posY;
    const c = ctx();
    const jobs = collectPlayerBillboards(asCtx(c), viewer, [{ player: teammate, color: "#60a5fa" }], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect.mock.calls.length).toBe(0); // fully occluded — zBuffer (0.5) < depth (3) everywhere
  });
});

describe("projectLivingEnemies", () => {
  it("excludes dead enemies and ones behind the camera", () => {
    const player = facingPlayer();
    const result = projectLivingEnemies(
      player,
      [enemy({ alive: false, x: player.posX + 3, y: player.posY }), enemy({ x: player.posX - 3, y: player.posY }), enemy({ x: player.posX + 3, y: player.posY })],
      WIDTH,
      HEIGHT,
    );
    expect(result).toHaveLength(1);
  });
});

describe("findTargetInProjections", () => {
  it("finds the nearest visible enemy under the crosshair", () => {
    const player = facingPlayer();
    const near = enemy({ x: player.posX + 3, y: player.posY });
    const far = enemy({ x: player.posX + 6, y: player.posY });
    const projected = projectLivingEnemies(player, [far, near], WIDTH, HEIGHT);
    const hit = findTargetInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2);
    expect(hit).toBe(near);
  });

  it("returns null when nothing is under the crosshair column", () => {
    const player = facingPlayer();
    const projected = projectLivingEnemies(player, [enemy({ x: player.posX + 3, y: player.posY })], WIDTH, HEIGHT);
    const hit = findTargetInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, 0); // far left edge
    expect(hit).toBeNull();
  });

  it("returns null for an enemy that's wall-occluded", () => {
    const player = facingPlayer();
    const projected = projectLivingEnemies(player, [enemy({ x: player.posX + 3, y: player.posY })], WIDTH, HEIGHT);
    const hit = findTargetInProjections(projected, clearZBuffer(0.5), WIDTH, HEIGHT, WIDTH / 2);
    expect(hit).toBeNull();
  });

  it("misses vertically when the crosshair's fixed mid-height falls outside a (synthetic) box", () => {
    // In real gameplay projectPoint always centers a box symmetrically on
    // height/2, so this branch can never actually trigger through the real
    // pipeline — but findTargetInProjections takes plain projection data as
    // input, so its own vertical-bounds check is still worth exercising
    // directly against a hand-built box.
    const player = facingPlayer();
    const e = enemy({ x: player.posX + 3, y: player.posY });
    const proj = { depth: 3, screenX: WIDTH / 2, left: 0, right: WIDTH, top: 100, bottom: 110 };
    const hit = findTargetInProjections([{ enemy: e, proj }], clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2);
    expect(hit).toBeNull();
  });

  it("re-checks aliveness against the live enemy object, not the stale snapshot", () => {
    const player = facingPlayer();
    const e = enemy({ x: player.posX + 3, y: player.posY });
    const projected = projectLivingEnemies(player, [e], WIDTH, HEIGHT);
    e.alive = false; // killed by an earlier pellet in the same shot
    const hit = findTargetInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2);
    expect(hit).toBeNull();
  });

});

describe("findTargetAtColumn / findTargetUnderCrosshair", () => {
  it("finds a target via the convenience wrappers", () => {
    const player = facingPlayer();
    const e = enemy({ x: player.posX + 3, y: player.posY });
    expect(findTargetAtColumn(player, [e], clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2)).toBe(e);
    expect(findTargetUnderCrosshair(player, [e], clearZBuffer(Infinity), WIDTH, HEIGHT)).toBe(e);
  });
});

describe("projectVisibleMines / findMineInProjections / findMineAtColumn", () => {
  it("only projects alive, visible mines that are in front of the camera", () => {
    const player = facingPlayer();
    const result = projectVisibleMines(
      player,
      [
        mine({ alive: false, x: player.posX + 3, y: player.posY }),
        mine({ visible: false, x: player.posX + 3, y: player.posY }),
        mine({ x: player.posX - 3, y: player.posY }), // behind
        mine({ x: player.posX + 3, y: player.posY }),
      ],
      WIDTH,
      HEIGHT,
    );
    expect(result).toHaveLength(1);
  });

  it("finds the nearest hit mine, re-checking aliveness, and misses/occlusion return null", () => {
    const player = facingPlayer();
    const near = mine({ x: player.posX + 3, y: player.posY });
    const far = mine({ x: player.posX + 6, y: player.posY });
    const projected = projectVisibleMines(player, [far, near], WIDTH, HEIGHT);
    expect(findMineInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2)).toBe(near);
    expect(findMineInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, 0)).toBeNull();
    expect(findMineInProjections(projected, clearZBuffer(0.5), WIDTH, HEIGHT, WIDTH / 2)).toBeNull();

    near.alive = false;
    expect(findMineInProjections(projected, clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2)).toBe(far);
  });

  it("misses vertically when the crosshair's fixed mid-height falls outside a (synthetic) box", () => {
    // Same reasoning as the enemy hit-test's equivalent case: unreachable
    // through the real projectPoint pipeline, but findMineInProjections
    // takes plain projection data as input, so worth exercising directly.
    const player = facingPlayer();
    const m = mine({ x: player.posX + 3, y: player.posY });
    const proj = { depth: 3, screenX: WIDTH / 2, left: 0, right: WIDTH, top: 100, bottom: 110 };
    const hit = findMineInProjections([{ mine: m, proj }], clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2);
    expect(hit).toBeNull();
  });

  it("finds a mine via the convenience wrapper", () => {
    const player = facingPlayer();
    const m = mine({ x: player.posX + 3, y: player.posY });
    expect(findMineAtColumn(player, [m], clearZBuffer(Infinity), WIDTH, HEIGHT, WIDTH / 2)).toBe(m);
  });
});

describe("collectOrbBillboards", () => {
  const palette = { halo: "rgba(1,2,3,0.1)", core: "#111", center: "#eee" };

  it("filters out a point too close to the player", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectOrbBillboards(asCtx(c), player, [{ x: player.posX, y: player.posY }], clearZBuffer(Infinity), palette);
    expect(jobs).toHaveLength(0);
  });

  it("draws the halo/core/center layers for a visible orb", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectOrbBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY }], clearZBuffer(Infinity), palette);
    jobs[0].draw();
    expect(c.fillRect).toHaveBeenCalledTimes(3);
    expect(c.fillStyle).toBe(palette.center);
  });

  it("draws nothing for an occluded orb", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectOrbBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY }], clearZBuffer(0.5), palette);
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("collectExitBillboard", () => {
  it("returns an empty array when the exit is too close/behind the camera", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectExitBillboard(asCtx(c), player, { x: Math.floor(player.posX) - 1, y: Math.floor(player.posY) }, clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("draws the marker body and the 'return' label when unoccluded", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectExitBillboard(asCtx(c), player, { x: Math.floor(player.posX) + 3, y: Math.floor(player.posY) }, clearZBuffer(Infinity));
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillText).toHaveBeenCalledWith("return", expect.any(Number), expect.any(Number));
  });

  it("skips occluded body columns and the label when behind a wall", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectExitBillboard(asCtx(c), player, { x: Math.floor(player.posX) + 3, y: Math.floor(player.posY) }, clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillText).not.toHaveBeenCalled();
  });
});

describe("collectKeyBillboards", () => {
  it("filters out a collected key", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectKeyBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, collected: true } as KeyItem], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(0);
  });

  it("draws an uncollected, unoccluded key", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectKeyBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, collected: false }], clearZBuffer(Infinity));
    jobs[0].draw();
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("draws nothing for an occluded key", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectKeyBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, collected: false }], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("collectLootBillboards", () => {
  const kinds: LootDrop["kind"][] = ["bullets", "rockets", "smg", "gas", "health", "swap", "weapon", "key"];

  for (const kind of kinds) {
    it(`draws a "${kind}" drop without throwing`, () => {
      const player = facingPlayer();
      const c = ctx();
      const jobs = collectLootBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind }], clearZBuffer(Infinity));
      expect(jobs).toHaveLength(1);
      expect(() => jobs[0].draw()).not.toThrow();
    });
  }

  it("adds a pulsing ring specifically for a weapon drop", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectLootBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind: "weapon" }], clearZBuffer(Infinity));
    jobs[0].draw();
    expect(c.strokeRect).toHaveBeenCalledTimes(1);
  });

  it("draws no ring for a non-weapon drop", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectLootBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind: "health" }], clearZBuffer(Infinity));
    jobs[0].draw();
    expect(c.strokeRect).not.toHaveBeenCalled();
  });

  it("draws nothing for an occluded drop", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectLootBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind: "health" }], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("collectDecorationBillboards", () => {
  const kinds: Decoration["kind"][] = ["rack", "plant", "desk", "block"];

  for (const kind of kinds) {
    it(`draws a "${kind}" decoration without throwing`, () => {
      const player = facingPlayer();
      const c = ctx();
      const jobs = collectDecorationBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind }], clearZBuffer(Infinity));
      expect(jobs).toHaveLength(1);
      expect(() => jobs[0].draw()).not.toThrow();
    });
  }

  it("draws nothing for an occluded decoration", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectDecorationBillboards(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, kind: "plant" }], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("collectTeleporterBillboards", () => {
  function teleporter(overrides: Partial<Teleporter> = {}): Teleporter {
    return { x: 0, y: 0, targetX: 0, targetY: 0, label: "goto", ...overrides };
  }

  it("draws a visible, unoccluded teleporter pad", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectTeleporterBillboards(asCtx(c), player, [teleporter({ x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.strokeRect).toHaveBeenCalledTimes(1);
  });

  it("draws nothing for an occluded teleporter", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectTeleporterBillboards(asCtx(c), player, [teleporter({ x: player.posX + 3, y: player.posY })], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("collectMineBillboards", () => {
  it("filters out a dead or invisible mine", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectMineBillboards(
      asCtx(c),
      player,
      [mine({ alive: false, x: player.posX + 3, y: player.posY }), mine({ visible: false, x: player.posX + 3, y: player.posY })],
      clearZBuffer(Infinity),
    );
    expect(jobs).toHaveLength(0);
  });

  it("draws a discovered, still-live mine", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectMineBillboards(asCtx(c), player, [mine({ x: player.posX + 3, y: player.posY })], clearZBuffer(Infinity));
    expect(jobs).toHaveLength(1);
    jobs[0].draw();
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("draws nothing for an occluded mine", () => {
    const player = facingPlayer();
    const c = ctx();
    const jobs = collectMineBillboards(asCtx(c), player, [mine({ x: player.posX + 3, y: player.posY })], clearZBuffer(0.5));
    jobs[0].draw();
    expect(c.fillRect).not.toHaveBeenCalled();
  });
});

describe("EDGE_CASE_COLOR", () => {
  it("is the documented glitch cyan", () => {
    expect(EDGE_CASE_COLOR).toBe("#00FFFF");
  });
});
