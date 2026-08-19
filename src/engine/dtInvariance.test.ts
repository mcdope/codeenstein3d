// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Does the simulation depend on the size of the timestep it is integrated at?
 *
 * **Why this matters, and why it is not a bot question.** The balancing harness
 * pumps exactly one engine frame per bot decision, and `recordStepMs` defaults
 * to the decision window — so every balance number on record was gathered with
 * the engine integrating at **50ms, which is exactly `MAX_DT`**, the largest
 * step it will ever take. A player runs at 60-120fps, i.e. 8-16ms. And
 * `generate-default-highscore.mjs` already records at `1000/60`, so the replays
 * that *ship* are simulated at 60Hz while the numbers that tune them are not.
 *
 * Per 50ms step that means a ghidra rocket crosses **0.90 tiles** between
 * collision checks (0.30 at 60Hz), a sprinting player 0.32, an enemy bolt 0.25.
 * A projectile moving nearly a whole tile per check is tunnelling territory.
 *
 * **The question these tests answer** is whether that changes outcomes. They
 * drive two engines from the same seed and the same scripted input over the
 * *same total simulated time* — one at 50ms steps, one at three 16.67ms steps
 * per 50ms — and compare. `advance()` is called directly, which is faithful:
 * `frame()` only clamps `dt` to `MAX_DT` before calling it, and the harness's
 * pump produces exactly 0.05.
 *
 * **What a failure here means** is not "the engine is broken". Continuous
 * quantities are expected to differ slightly — different accumulation order.
 * What must not differ is *discrete* outcomes: whether a rocket connected,
 * whether an enemy died. Those are asserted exactly; the continuous ones carry
 * a tolerance, and the tolerance is the finding.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import { installRaf } from "../../test/mocks/raf";
import type { Enemy, GameMap, Tile } from "../map/types";
import { HAZARD_TILE } from "../map/types";
import type { InputSource, InputSnapshot } from "./input";

// `textures.ts` builds a `TextureManager` at *module load*, which calls
// `document.createElement("canvas").getContext("2d")` — null in jsdom without
// the `canvas` package. So the engine cannot be imported statically: the
// prototype stub has to be installed first, and a static import would hoist
// above it. Same deferral `engine.test.ts` uses, for the same reason.
type RaycasterEngineType = InstanceType<typeof import("./engine").RaycasterEngine>;
type EngineHandlers = import("./engine").EngineHandlers;
let RaycasterEngine: typeof import("./engine").RaycasterEngine;

const WIDTH = 320;
const HEIGHT = 200;
/** The harness's step: one bot decision, and exactly `MAX_DT`. */
const COARSE_DT = 0.05;
/** A third of it — 60Hz, what a player's browser actually delivers. */
const FINE_DT = COARSE_DT / 3;

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
}

function walledRoom(size: number): Tile[][] {
  const g = grid(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) g[y][x] = 1;
    }
  }
  return g;
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 24): GameMap {
  return {
    width: size,
    height: size,
    grid: walledRoom(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 5, y: 5 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
    shortestPathTiles: 4,
    hazards: [],
    doors: [],
    gates: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    styleSet: "stone",
    secretRoomCount: 0,
    switchboardRooms: [],
    exceptionZones: [],
    vendorDepots: [],
    acidOverflows: [],
    ...overrides,
  };
}

function fakeEnemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 6,
    y: 5,
    hp: 30,
    maxHp: 30,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 24, h: 24 },
    aggroed: false,
    discovered: false,
    roamX: 6,
    roamY: 5,
    fireCooldown: 0,
    entity: { name: "doStuff", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

/** Minimal scripted input — only the fields these scenarios drive. */
class ScriptedInput implements InputSource {
  keys = new Set<string>();
  fireQueued = false;
  fireHeld = false;
  attach = vi.fn();
  detach = vi.fn();
  pollGamepad = vi.fn();
  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  consumeMouseDX(): number {
    return 0;
  }
  consumeFire(): boolean {
    const v = this.fireQueued;
    this.fireQueued = false;
    return v;
  }
  isFireHeld(): boolean {
    return this.fireHeld;
  }
  consumeWeaponRequest(): number | null {
    return null;
  }
  consumeMapToggle(): boolean {
    return false;
  }
  consumeInteract(): boolean {
    return false;
  }
  consumeReload(): boolean {
    return false;
  }
  consumeMelee(): boolean {
    return false;
  }
  isMeleeHeld(): boolean {
    return false;
  }
  consumeWheelSteps(): number {
    return 0;
  }
  consumeFpsToggle(): boolean {
    return false;
  }
  consumeCheat(): string | null {
    return null;
  }
  consumeEscape(): boolean {
    return false;
  }
  consumeBlur(): boolean {
    return false;
  }
  consumePointerUnlock(): boolean {
    return false;
  }
  consumeClick(): boolean {
    return false;
  }
  gamepadForward(): number {
    return 0;
  }
  gamepadStrafe(): number {
    return 0;
  }
  gamepadTurn(): number {
    return 0;
  }
  captureSnapshot(): InputSnapshot {
    return {} as InputSnapshot;
  }
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = { width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement;
  const ctx = createMockCanvasContext(canvas);
  canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
  return canvas;
}

function makeHandlers(): EngineHandlers {
  return {
    onStats: vi.fn(),
    onGameOver: vi.fn(),
    onWin: vi.fn(),
    onCheatActivated: vi.fn(),
    onFreezeChange: vi.fn(),
  } as unknown as EngineHandlers;
}

/**
 * Run one scenario at a given timestep and report what the world looked like
 * afterwards. `steps` is counted in *coarse* steps, so both arms cover the same
 * simulated seconds however finely they subdivide them.
 */
function runScenario(
  buildMap: () => GameMap,
  dt: number,
  coarseSteps: number,
  drive: (input: ScriptedInput, coarseStep: number) => void,
  carryover?: import("./engine").EngineCarryover,
) {
  const input = new ScriptedInput();
  const map = buildMap();
  const engine: RaycasterEngineType = new RaycasterEngine(
    makeCanvas(),
    map,
    makeHandlers(),
    carryover,
    undefined,
    "normal",
    12345,
    input,
  );
  engine.startExternallyDriven();
  const subSteps = Math.round(COARSE_DT / dt);
  for (let s = 0; s < coarseSteps; s++) {
    drive(input, s);
    for (let i = 0; i < subSteps; i++) engine.advance(dt);
  }
  const player = engine.getBotPlayerState("local" as never) ?? null;
  const enemies = engine.getEnemiesSnapshot();
  return {
    x: player?.x ?? NaN,
    y: player?.y ?? NaN,
    health: player?.health ?? NaN,
    weaponIndex: player?.weaponIndex ?? NaN,
    rocketsLeft: player?.ammo?.rockets ?? NaN,
    enemies: enemies.map((e) => ({ x: e.x, y: e.y, hp: e.hp, alive: e.alive })),
    aliveCount: enemies.filter((e) => e.alive).length,
  };
}

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ RaycasterEngine } = await import("./engine"));
});
beforeEach(() => {
  // The engine schedules no rAF of its own here (`startExternallyDriven`), but
  // the stubbed clock keeps anything time-based off the real wall clock.
  installRaf({ stubClock: true });
});

describe("simulation outcomes vs integration timestep", () => {
  it("player movement covers the same ground at 50ms and 60Hz", () => {
    // Position integrates as `pos += speed * dt`, so this should be invariant
    // up to float accumulation. If it is not, nothing below is interpretable.
    const drive = (input: ScriptedInput) => {
      input.keys.add("KeyW");
    };
    const coarse = runScenario(() => fakeMap(), COARSE_DT, 20, drive);
    const fine = runScenario(() => fakeMap(), FINE_DT, 20, drive);
    expect(fine.x).toBeCloseTo(coarse.x, 2);
    expect(fine.y).toBeCloseTo(coarse.y, 2);
  });

  it("an enemy chasing the player ends up in the same place", () => {
    const buildMap = () => fakeMap({ enemies: [fakeEnemy({ x: 9, y: 5, aggroed: true })] });
    const drive = () => {};
    const coarse = runScenario(buildMap, COARSE_DT, 40, drive);
    const fine = runScenario(buildMap, FINE_DT, 40, drive);
    expect(fine.enemies).toHaveLength(coarse.enemies.length);
    expect(fine.enemies[0].x).toBeCloseTo(coarse.enemies[0].x, 1);
    expect(fine.enemies[0].y).toBeCloseTo(coarse.enemies[0].y, 1);
  });

  it("standing in acid drains the same health", () => {
    // Hazard damage is `HAZARD_DPS * dt`, so a difference here would mean the
    // *rate* depends on how finely the second is chopped up.
    const buildMap = () => {
      const map = fakeMap();
      for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) map.grid[y][x] = HAZARD_TILE;
      map.hazards = [{ x: 5, y: 5 }];
      return map;
    };
    const drive = () => {};
    const coarse = runScenario(buildMap, COARSE_DT, 30, drive);
    const fine = runScenario(buildMap, FINE_DT, 30, drive);
    expect(fine.health).toBeCloseTo(coarse.health, 0);
  });

  it("a rocket steps OVER an enemy at 50ms that it hits at 60Hz — the tunnelling case", async () => {
    // Demonstrated on `updateRockets` directly rather than through the engine,
    // because it is a pure function and this is a property of its arithmetic:
    //
    //   r.x += r.vx * dt;                                   // advance
    //   const hitEnemy = nearLivingEnemy(r.x, r.y, 0.4);    // *then* sample
    //
    // There is no sweep. ROCKET_SPEED is 18 t/s, so the sample points are
    // 18 * 0.05 = 0.90 tiles apart, while the trigger window around an enemy is
    // only 2 * ROCKET_ENEMY_TRIGGER_RADIUS = 0.80 tiles wide. 0.80 < 0.90, so
    // there is a band the rocket can straddle entirely. At 60Hz the points are
    // 0.30 apart and the window always catches.
    const { updateRockets } = await import("./rockets");
    const { ROCKET_SPEED, ROCKET_ENEMY_TRIGGER_RADIUS } = await import("./combatConstants");

    // The gap is real, not a rounding artefact — state it as arithmetic first.
    expect(ROCKET_SPEED * COARSE_DT).toBeGreaterThan(2 * ROCKET_ENEMY_TRIGGER_RADIUS);
    expect(ROCKET_SPEED * FINE_DT).toBeLessThan(2 * ROCKET_ENEMY_TRIGGER_RADIUS);

    const map = fakeMap();
    const START_X = 5.9;
    const LANE_Y = 5.5;
    // Put the enemy exactly between two coarse sample points: 0.45 from each,
    // which is outside the 0.4 trigger on both sides.
    const stepsToSkip = 9;
    const enemyX = START_X + ROCKET_SPEED * COARSE_DT * stepsToSkip + (ROCKET_SPEED * COARSE_DT) / 2;
    const nearEnemy = (x: number, y: number, radius: number) => Math.hypot(x - enemyX, y - LANE_Y) <= radius;

    const flyUntilExplosion = (dt: number) => {
      const rockets = [{ x: START_X, y: LANE_Y, vx: ROCKET_SPEED, vy: 0, damage: 100, firedBy: "local" }];
      for (let i = 0; i < 2000 && rockets.length > 0; i++) {
        const explosions = updateRockets(rockets as never, nearEnemy, map, dt);
        if (explosions.length > 0) return explosions[0];
      }
      return null;
    };

    const coarse = flyUntilExplosion(COARSE_DT);
    const fine = flyUntilExplosion(FINE_DT);

    // Both must detonate somewhere — a null would mean the scenario never ran.
    expect(coarse).not.toBeNull();
    expect(fine).not.toBeNull();

    const distFromEnemy = (e: { x: number; y: number }) => Math.hypot(e.x - enemyX, e.y - LANE_Y);
    // 60Hz: caught by the enemy trigger, so it detonates on top of it.
    expect(distFromEnemy(fine!)).toBeLessThanOrEqual(ROCKET_ENEMY_TRIGGER_RADIUS);
    // 50ms — the harness's step: straight past, detonating on the far wall
    // instead, far outside the blast radius that would have damaged it.
    expect(distFromEnemy(coarse!)).toBeGreaterThan(ROCKET_ENEMY_TRIGGER_RADIUS);
  });

  it("the tunnelling band is wide enough to matter, not a knife-edge", async () => {
    // A defect that only fires at one exact offset would be a curiosity. Sweep
    // the enemy across a whole coarse step and count how much of it is missed.
    const { updateRockets } = await import("./rockets");
    const { ROCKET_SPEED, ROCKET_ENEMY_TRIGGER_RADIUS } = await import("./combatConstants");
    const map = fakeMap();
    const START_X = 5.9;
    const LANE_Y = 5.5;
    const stepTiles = ROCKET_SPEED * COARSE_DT;

    let missed = 0;
    const SAMPLES = 90;
    for (let i = 0; i < SAMPLES; i++) {
      const enemyX = START_X + stepTiles * 9 + (stepTiles * i) / SAMPLES;
      const nearEnemy = (x: number, y: number, radius: number) => Math.hypot(x - enemyX, y - LANE_Y) <= radius;
      const rockets = [{ x: START_X, y: LANE_Y, vx: ROCKET_SPEED, vy: 0, damage: 100, firedBy: "local" }];
      let hit = false;
      for (let n = 0; n < 2000 && rockets.length > 0; n++) {
        const ex = updateRockets(rockets as never, nearEnemy, map, COARSE_DT);
        if (ex.length > 0) {
          hit = Math.hypot(ex[0].x - enemyX, ex[0].y - LANE_Y) <= ROCKET_ENEMY_TRIGGER_RADIUS;
          break;
        }
      }
      if (!hit) missed++;
    }
    // 0.90 tiles of travel against a 0.80-tile window: ~11% of positions are
    // unhittable at the timestep every balance number was measured at.
    expect(missed / SAMPLES).toBeGreaterThan(0.05);
    expect(missed / SAMPLES).toBeLessThan(0.30);
  });
});
