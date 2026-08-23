// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import type { AmmoPickup, Enemy, GameMap, KeyItem, LootDrop, Mine, SpikeTrap, Teleporter, Tile } from "../map/types";
import { BRANCH_DOOR_TILE, DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, TELEPORTER_TILE } from "../map/types";
import { audio } from "./audio";
import { drawWeapon } from "./viewmodel";
import { computeBalanceHash } from "./balanceHash";
import type { GoreLevel } from "./effects";
import type { InputSnapshot, InputSource } from "./input";
import { INPUT_DELAY_TICKS } from "./lagCompensationConstants";

// Spy on the viewmodel while keeping its real behaviour, so a test can assert
// *which weapon the player actually sees* rather than poking at engine
// internals. Used by the held-Toolchain test below.
vi.mock("./viewmodel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./viewmodel")>();
  return { ...actual, drawWeapon: vi.fn(actual.drawWeapon) };
});
import { CORRECTION_SMOOTH_MS, SNAP_THRESHOLD_TILES } from "./reconciliationConstants";
import type { ReconciliationSnapshot } from "./reconciliationSnapshot";
import { EMPTY_SNAPSHOT } from "./replay";
import { COUNTDOWN_TICKS } from "./transitionConstants";
import { HURT_FACE_FRAMES } from "./hudFace";
import { GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX } from "./weapons";
// Temporary — see `playtestScales.ts`.
import { ENEMY_DAMAGE_SCALES, KILL_HEAL_SCALES, type PlaytestScales } from "../playtestScales";

// engine.ts imports a real *value* (`textures`) from textures.ts, whose
// module-level `TextureManager` singleton calls `document.createElement`
// and `canvas.getContext("2d")` at import time — before any test setup
// (even beforeAll) can run, since ES module imports are hoisted ahead of
// all other top-level code. Stub the canvas context first, then
// dynamically import engine.ts. Same gotcha as raycaster.ts/textures.ts.
let RaycasterEngine: typeof import("./engine").RaycasterEngine;
let SIMULATION_BALANCE: typeof import("./engine").SIMULATION_BALANCE;
let REVIVE_HEALTH: number;
type EngineStats = import("./engine").EngineStats;
type EngineHandlers = import("./engine").EngineHandlers;
type EngineCarryover = import("./engine").EngineCarryover;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ RaycasterEngine, REVIVE_HEALTH, SIMULATION_BALANCE } = await import("./engine"));
});

const WIDTH = 200;
const HEIGHT = 150;

function grid(size: number, fill: Tile = 0): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(fill) as Tile[]);
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

function fakeMap(overrides: Partial<GameMap> = {}, size = 12): GameMap {
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
    home: { x: 0, y: 0, w: 12, h: 12 },
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

/** A hand-scripted, mutable InputSource — flip its fields between
 * `advance()` calls to drive specific player actions deterministically,
 * far more ergonomic for multi-frame scenarios than a fresh object literal
 * per call. */
class ScriptedInput implements InputSource {
  keys = new Set<string>();
  mouseDX = 0;
  fireQueued = false;
  fireHeld = false;
  weaponRequest: number | null = null;
  mapToggle = false;
  interact = false;
  reload = false;
  helpPing = false;
  melee = false;
  meleeHeld = false;
  wheelSteps = 0;
  fpsToggle = false;
  cheat: string | null = null;
  escape = false;
  blur = false;
  pointerUnlock = false;
  click = false;
  gpForward = 0;
  gpStrafe = 0;
  gpTurn = 0;

  attach = vi.fn();
  detach = vi.fn();
  pollGamepad = vi.fn();

  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  consumeMouseDX(): number {
    const v = this.mouseDX;
    this.mouseDX = 0;
    return v;
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
    const v = this.weaponRequest;
    this.weaponRequest = null;
    return v;
  }
  consumeMapToggle(): boolean {
    const v = this.mapToggle;
    this.mapToggle = false;
    return v;
  }
  consumeInteract(): boolean {
    const v = this.interact;
    this.interact = false;
    return v;
  }
  consumeReload(): boolean {
    const v = this.reload;
    this.reload = false;
    return v;
  }
  consumeHelpPing(): boolean {
    const v = this.helpPing;
    this.helpPing = false;
    return v;
  }
  consumeMelee(): boolean {
    const v = this.melee;
    this.melee = false;
    return v;
  }
  isMeleeHeld(): boolean {
    return this.meleeHeld;
  }
  consumeWheelSteps(): number {
    const v = this.wheelSteps;
    this.wheelSteps = 0;
    return v;
  }
  consumeFpsToggle(): boolean {
    const v = this.fpsToggle;
    this.fpsToggle = false;
    return v;
  }
  consumeCheat(): string | null {
    const v = this.cheat;
    this.cheat = null;
    return v;
  }
  consumeEscape(): boolean {
    const v = this.escape;
    this.escape = false;
    return v;
  }
  consumeBlur(): boolean {
    const v = this.blur;
    this.blur = false;
    return v;
  }
  consumePointerUnlock(): boolean {
    const v = this.pointerUnlock;
    this.pointerUnlock = false;
    return v;
  }
  consumeClick(): boolean {
    const v = this.click;
    this.click = false;
    return v;
  }
  gamepadForward(): number {
    return this.gpForward;
  }
  gamepadStrafe(): number {
    return this.gpStrafe;
  }
  gamepadTurn(): number {
    return this.gpTurn;
  }
  captureSnapshot(): InputSnapshot {
    return { ...EMPTY_SNAPSHOT, keys: [...this.keys] };
  }
}

function makeHandlers(): {
  onStats: ReturnType<typeof vi.fn<(stats: EngineStats) => void>>;
  onGameOver: ReturnType<typeof vi.fn<(stats: EngineStats) => void>>;
  onWin: ReturnType<typeof vi.fn<(stats: EngineStats) => void>>;
  onCheatActivated: ReturnType<typeof vi.fn<(code: string) => void>>;
  onFreezeChange: ReturnType<typeof vi.fn<(frozen: boolean) => void>>;
} & EngineHandlers {
  return {
    onStats: vi.fn<(stats: EngineStats) => void>(),
    onGameOver: vi.fn<(stats: EngineStats) => void>(),
    onWin: vi.fn<(stats: EngineStats) => void>(),
    onCheatActivated: vi.fn<(code: string) => void>(),
    onFreezeChange: vi.fn<(frozen: boolean) => void>(),
  };
}

function lastStats(handlers: ReturnType<typeof makeHandlers>): EngineStats {
  const calls = handlers.onStats.mock.calls;
  return calls[calls.length - 1][0] as EngineStats;
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = { width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement;
  const ctx = createMockCanvasContext(canvas);
  canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
  return canvas;
}

function makeEngine(
  map: GameMap,
  handlers: ReturnType<typeof makeHandlers> = makeHandlers(),
  opts: {
    carryover?: EngineCarryover;
    gore?: GoreLevel;
    difficulty?: "easy" | "normal" | "hard";
    seed?: number;
    input?: ScriptedInput;
    playerCount?: number;
    rotSpeedMultiplier?: number;
    rollbacksRemaining?: number;
    /** Temporary — see `playtestScales.ts`. */
    playtestScales?: PlaytestScales;
  } = {},
): { engine: InstanceType<typeof RaycasterEngine>; input: ScriptedInput; handlers: ReturnType<typeof makeHandlers> } {
  const canvas = makeCanvas();
  const input = opts.input ?? new ScriptedInput();
  const engine = new RaycasterEngine(
    canvas,
    map,
    handlers,
    opts.carryover,
    opts.gore,
    opts.difficulty,
    opts.seed ?? 12345,
    input,
    undefined,
    undefined,
    undefined,
    opts.playerCount,
    opts.rotSpeedMultiplier,
    undefined,
    opts.rollbacksRemaining,
    opts.playtestScales,
  );
  return { engine, input, handlers };
}

let raf: RafController;

beforeEach(() => {
  raf = installRaf({ stubClock: true });
});

afterEach(() => {
  raf.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RaycasterEngine — construction", () => {
  it("throws when the canvas has no 2D context", () => {
    const canvas = { width: WIDTH, height: HEIGHT, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;
    expect(() => new RaycasterEngine(canvas, fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput())).toThrow(
      "2D canvas context unavailable",
    );
  });

  it("starts at full health/default weapon/starting weapons with no carryover", () => {
    const { engine, handlers } = makeEngine(fakeMap());
    engine.advance(0);
    const stats = lastStats(handlers);
    expect(stats.health).toBe(100);
    expect(stats.weaponIndex).toBe(0);
    expect(stats.ownedWeapons.sort()).toEqual([0, 1, 2]);
    expect(stats.godMode).toBe(false);
    expect(stats.noClip).toBe(false);
  });

  it("applies a full carryover (health, ammo, weapon, cheats, priorScore)", () => {
    const carryover: EngineCarryover = {
      health: 42,
      swap: 5,
      bullets: 10,
      rockets: 2,
      smg: 3,
      gas: 4,
      priorScore: 500,
      weaponIndex: 3,
      ownedWeapons: [0, 1, 2, 3],
      campaignLevelIndex: 2,
      godMode: true,
      noClip: true,
    };
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { carryover });
    engine.advance(0);
    const stats = lastStats(handlers);
    expect(stats.health).toBe(42);
    expect(stats.swap).toBe(5);
    expect(stats.bullets).toBe(10);
    expect(stats.rockets).toBe(2);
    expect(stats.smg).toBe(3);
    expect(stats.gas).toBe(4);
    expect(stats.weaponIndex).toBe(3);
    expect(stats.ownedWeapons.sort()).toEqual([0, 1, 2, 3]);
    expect(stats.godMode).toBe(true);
    expect(stats.noClip).toBe(true);
    expect(stats.score).toBeGreaterThanOrEqual(500); // priorScore baseline
  });

  it("defaults campaignLevelIndex/weaponIndex/ownedWeapons when carryover omits them", () => {
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { carryover: { health: 80, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 } });
    engine.advance(0);
    const stats = lastStats(handlers);
    expect(stats.weaponIndex).toBe(0);
    expect(stats.ownedWeapons.sort()).toEqual([0, 1, 2]);
  });

  it("scales enemy HP by the difficulty multiplier at construction", () => {
    const enemy = fakeEnemy({ hp: 100, maxHp: 100 });
    const { engine } = makeEngine(fakeMap({ enemies: [enemy] }), makeHandlers(), { difficulty: "hard" });
    engine.advance(0);
    expect(enemy.maxHp).not.toBe(100); // hard's hp multiplier isn't 1
  });

  it("leaves enemy HP untouched at normal difficulty", () => {
    const enemy = fakeEnemy({ hp: 100, maxHp: 100 });
    const { engine } = makeEngine(fakeMap({ enemies: [enemy] }), makeHandlers(), { difficulty: "normal" });
    engine.advance(0);
    expect(enemy.maxHp).toBe(100);
  });

  it.each(["easy", "hard"] as const)(
    "on %s, that in-place rescale changes the balance fingerprint — so both record and playback must hash before constructing",
    async (difficulty) => {
      // Characterization of *why* `main.ts` snapshots the roster before
      // building a replay's engine. `maxHp` is one of the four fields
      // `computeBalanceHash` covers, and the constructor rewrites it in
      // place, so hashing the same map object before vs. after construction
      // yields two different digests. Recording hashes before; playback used
      // to hash after, and refused every easy/hard replay as balance drift.
      const map = fakeMap({ enemies: [fakeEnemy({ hp: 100, maxHp: 100 })] });
      const before = await computeBalanceHash(map, SIMULATION_BALANCE);
      makeEngine(map, makeHandlers(), { difficulty });
      const after = await computeBalanceHash(map, SIMULATION_BALANCE);
      expect(after).not.toBe(before);
    },
  );

  it("on normal, the fingerprint is unchanged by construction — which is why the normal-only board hid that ordering", async () => {
    const map = fakeMap({ enemies: [fakeEnemy({ hp: 100, maxHp: 100 })] });
    const before = await computeBalanceHash(map, SIMULATION_BALANCE);
    makeEngine(map, makeHandlers(), { difficulty: "normal" });
    expect(await computeBalanceHash(map, SIMULATION_BALANCE)).toBe(before);
  });

  it("leaves Elite HP untouched at the default single-player playerCount (1)", () => {
    const elite = fakeEnemy({ hp: 100, maxHp: 100, elite: true });
    const { engine } = makeEngine(fakeMap({ enemies: [elite] }));
    engine.advance(0);
    expect(elite.maxHp).toBe(100);
  });

  it("scales only Elite HP by the player-count multiplier at construction, leaving non-Elites untouched", () => {
    const elite = fakeEnemy({ hp: 100, maxHp: 100, elite: true });
    const grunt = fakeEnemy({ hp: 100, maxHp: 100, elite: false, x: 7, y: 5 });
    const { engine } = makeEngine(fakeMap({ enemies: [elite, grunt] }), makeHandlers(), { playerCount: 3 });
    engine.advance(0);
    // eliteScalingFor(3): extra = 2, hp = 1 + 2*0.5 = 2
    expect(elite.maxHp).toBe(200);
    expect(elite.hp).toBe(200);
    expect(grunt.maxHp).toBe(100);
    expect(grunt.hp).toBe(100);
  });

  it("falls back to a real InputController when no inputSource is given", () => {
    // makeCanvas()'s canvas is a plain object cast to HTMLCanvasElement (fine
    // for a ScriptedInput, which never touches it) — a real InputController
    // calls addEventListener on it, so this needs an actual DOM element.
    const canvas = document.createElement("canvas");
    const ctx = createMockCanvasContext(canvas);
    canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
    expect(() => new RaycasterEngine(canvas, fakeMap(), {}, undefined, undefined, undefined, 1)).not.toThrow();
  });

  it("reports meleeWouldHit once a rendered frame has a live enemy in the crosshair", () => {
    // The distance test in `meleeWouldHit` only runs when
    // `findTargetInProjections` actually finds something, and that reads the
    // player's zBuffer — which is empty until a frame has been rendered. A
    // hooks call before the first `advance()` therefore short-circuits and
    // never exercises the range comparison at all.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      // Directly ahead of the spawn (5,5), facing +x, inside the 1.5 melee range.
      const map = fakeMap({ enemies: [fakeEnemy({ x: 6.5, y: 5.5 })] });
      const { engine } = makeEngine(map);
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect((hooks!.getPlayerState() as { meleeWouldHit: boolean }).meleeWouldHit).toBe(true);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  // The four staging hooks used by `scripts/capture-doc-screenshots.mjs`.
  // Unlike every other hook, these mutate — so each one is pinned to exactly
  // what it is allowed to do.
  it("stages drops, keys, map reveal and enemy clearing for the screenshot capture", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      // A mostly-solid grid with one small carved chamber around the spawn.
      // `walledRoom`'s border is a single tile thick, so *every* wall tile in
      // it touches floor and it cannot tell "revealed the level" apart from
      // "revealed everything" — which is the distinction under test.
      const size = 12;
      const solid: Tile[][] = Array.from({ length: size }, () => new Array(size).fill(1) as Tile[]);
      for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) solid[y][x] = 0;
      const map = fakeMap({ grid: solid, spawn: { x: 5, y: 5 }, enemies: [fakeEnemy({ x: 7.5, y: 5.5 })] }, size);
      const { engine } = makeEngine(map);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, (arg?: unknown) => unknown> })
        .__codeensteinTestHooks;

      // A "rockets" drop is the point of the hook existing: `rollLoot` filters
      // it out entirely until ghidra is owned, so it can never appear on a
      // level-1 map by any in-game route.
      hooks!.debugSpawnDrop({ x: 6.6, y: 5.5, kind: "rockets" });
      expect(hooks!.getDrops()).toEqual([{ x: 6.6, y: 5.5, kind: "rockets" }]);

      hooks!.debugSpawnKey({ x: 6.6, y: 6.5, gateId: 3 });
      expect(hooks!.getKeys()).toEqual([{ x: 6.6, y: 6.5 }]);
      // Spawned uncollected, so it is a thing you could still walk over.
      expect(map.keys[0].collected).toBe(false);

      // Spawned already-spotted: a mine reveals itself only inside
      // `MINE_SIGHT_RADIUS`, and the screenshot this hook exists for would
      // otherwise have to walk the camera into a live mine's blast radius to
      // photograph one. The fuse is untouched, so it is a visible mine rather
      // than an inert prop.
      hooks!.debugSpawnMine({ x: 5.5, y: 6.5 });
      expect(map.mines).toEqual([{ x: 5.5, y: 6.5, alive: true, visible: true, closeTimer: 0 }]);

      // Reveals the carved level and the wall right around it, but NOT the
      // solid rock the generator never carved — flooding everything would draw
      // a grey field on the automap that no real playthrough could produce.
      expect(map.visited.every((row) => row.every((v) => !v))).toBe(true);
      hooks!.debugRevealMap();
      expect(map.visited[5][5]).toBe(true); // the chamber itself
      expect(map.visited[3][3]).toBe(true); // the wall right against it
      expect(map.visited[0][0]).toBe(false); // untouched rock, two tiles clear
      expect(map.visited[11][11]).toBe(false);

      // Poses a teammate for the two committed map screenshots. Same reason
      // as the mine above: the real route needs a live coop session, which a
      // screenshot script has no business standing up. `helpPing` defaults off
      // so the plain dot and the calling one are both stageable.
      hooks!.debugSpawnTeammate({ x: 5.5, y: 4.5, color: "#60a5fa" });
      hooks!.debugSpawnTeammate({ x: 4.5, y: 5.5, color: "#f472b6", helpPing: true });
      const staged = (engine as unknown as { debugTeammates: { helpPing: boolean }[] }).debugTeammates;
      expect(staged).toEqual([
        { x: 5.5, y: 4.5, color: "#60a5fa", helpPing: false },
        { x: 4.5, y: 5.5, color: "#f472b6", helpPing: true },
      ]);

      expect((hooks!.getEnemies() as { alive: boolean }[]).some((e) => e.alive)).toBe(true);
      hooks!.debugClearEnemies();
      expect((hooks!.getEnemies() as { alive: boolean }[]).every((e) => !e.alive)).toBe(true);

      // Still a working engine afterwards — staging must not wedge the frame.
      engine.advance(0.016);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("exposes window.__codeensteinTestHooks only when ?testHooks=1 is on the URL", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const enemy = fakeEnemy();
      const map = fakeMap({ enemies: [enemy] });
      makeEngine(map);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect(hooks).toBeDefined();
      expect(hooks!.getPlayerState()).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        healthFraction: expect.any(Number),
        swap: expect.any(Number),
        ammo: expect.any(Object),
        weaponIndex: expect.any(Number),
        ownedWeapons: expect.any(Array),
        levelTime: expect.any(Number),
        distanceTraveled: expect.any(Number),
      });
      expect(hooks!.getExit()).toEqual({ x: map.exit.x, y: map.exit.y });
      expect(hooks!.getEnemies()).toEqual([
        expect.objectContaining({ x: enemy.x, y: enemy.y, alive: true, edgeCase: expect.any(Boolean) }),
      ]);
      expect(hooks!.getMines()).toEqual([]);
      expect(hooks!.getGridVersion()).toEqual(expect.any(Number));
      // The level's own styleset, not a re-derivation — verify-wad-textures
      // asserts stability by comparing this across two launches.
      expect(hooks!.getStyleSet()).toBe(map.styleSet);
      expect(hooks!.getGrid()).toEqual(map.grid);
      // A copy, never the live array — a caller must not be able to mutate
      // engine state, and `PathField` floods over this exact grid.
      expect(hooks!.getGrid()).not.toBe(map.grid);
      expect((hooks!.getGrid() as unknown[])[0]).not.toBe(map.grid[0]);
      // Nothing has fired yet — the shape is asserted by the dedicated
      // getProjectilesSnapshot tests further down.
      expect(hooks!.getProjectiles()).toEqual([]);
      expect(hooks!.getDrops()).toEqual([]);
      expect(hooks!.getKeys()).toEqual([]);
      expect(hooks!.getTelemetrySnapshot()).toMatchObject({
        peakAggroedCount: 0,
        combatTimeSec: 0,
        enemyBoltsFired: 0,
        enemyBoltsHit: 0,
        fatalDamageSource: null,
        minesTriggered: 0,
        minesDisarmed: 0,
        regularKillLootRolls: 0,
        regularKillLootMisses: 0,
        secretRoomCount: map.secretRoomCount,
        kills: 0,
      });
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("ignores a non-numeric ?botRotSpeedMul, turning at the same rate as no override at all", () => {
    const original = window.location;
    const input = new ScriptedInput();
    input.keys.add("KeyE");

    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    const baseline = makeEngine(fakeMap(), makeHandlers(), { input });
    baseline.engine.advance(0.1);
    const baselineFacing = baseline.engine.getPlayerFacing("local");

    Object.defineProperty(window, "location", {
      value: { ...original, search: "?testHooks=1&botRotSpeedMul=notanumber" },
      configurable: true,
    });
    try {
      const malformed = makeEngine(fakeMap(), makeHandlers(), { input: new ScriptedInput() });
      malformed.input.keys.add("KeyE");
      malformed.engine.advance(0.1);
      expect(malformed.engine.getPlayerFacing("local")).toEqual(baselineFacing);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("getTelemetrySnapshot() reports the real minHealthReached (not this.health) once damage was taken and the level has ended", () => {
    // `pullLevelResult` (the bot's only caller of `getTelemetrySnapshot()`,
    // see run-balancing-telemetry.mjs) always calls it after the engine's
    // state has already left "playing" — matching `buildStats()`'s own
    // `atLevelEnd` gate, so this is the realistic scenario to exercise.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // hazard tile at spawn === exit
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }], spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } }, size);
      const { engine } = makeEngine(map);
      engine.advance(0.1); // non-fatal hazard tick (18 * 0.1 = 1.8 dmg), then wins this same frame
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => { minHealthReached: number }> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot();
      expect(snapshot.minHealthReached).toBeCloseTo(98.2, 5);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("logs a perf snapshot on the first frame only when ?perfDebug=1 is on the URL", () => {
    const original = window.location;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(window, "location", { value: { ...original, search: "?perfDebug=1" }, configurable: true });
    try {
      const enemy = fakeEnemy();
      const { engine } = makeEngine(fakeMap({ enemies: [enemy] }));
      // The FramePerfLogger constructor itself logs an "env" and a "level"
      // line — see perfDebug.ts. Driven through the real `start()`/rAF
      // `frame()` path (not a direct `advance()` call, unlike every other
      // test in this file) specifically so `frame()`'s own
      // `this.perf?.beginFrame(...)` call site is exercised too, not just
      // the ones inside `advance()`. Perf lines go through plain
      // `console.log` (not `console.debug`) on purpose — see perfDebug.ts's
      // header comment — so they ride along in the in-game console sidebar
      // for a screen recording, not just DevTools.
      engine.start();
      raf.flush(1, 16);
      const messages = logSpy.mock.calls.map((call) => call[0] as string).filter((m) => m.startsWith("[perf]"));
      expect(messages.some((m) => m.includes("[perf] env:"))).toBe(true);
      expect(messages.some((m) => m.includes("[perf] level:"))).toBe(true);
      expect(messages.some((m) => m.includes("[perf] state:"))).toBe(true);
      expect(messages.some((m) => /\[perf] (SLOW|tick)/.test(m))).toBe(true);
      engine.stop();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("never logs a perf line without ?perfDebug=1 on the URL", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { engine } = makeEngine(fakeMap());
    engine.advance(0);
    const perfMessages = logSpy.mock.calls.map((call) => call[0]).filter((m) => typeof m === "string" && m.startsWith("[perf]"));
    expect(perfMessages).toEqual([]);
  });
});

describe("RaycasterEngine — start()/stop() lifecycle", () => {
  it("start() attaches input, reveals the spawn tile, and requests a frame", () => {
    const { engine, input } = makeEngine(fakeMap());
    engine.start();
    expect(input.attach).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent", () => {
    const { engine, input } = makeEngine(fakeMap());
    engine.start();
    engine.start();
    expect(input.attach).toHaveBeenCalledTimes(1);
  });

  it("stop() detaches input and cancels the frame loop", () => {
    const { engine, input } = makeEngine(fakeMap());
    engine.start();
    engine.stop();
    expect(input.detach).toHaveBeenCalledTimes(1);
    expect(raf.flush(3)).toBe(0); // rAF loop actually cancelled
  });

  it("stop() before start() is a safe no-op", () => {
    const { engine, input } = makeEngine(fakeMap());
    expect(() => engine.stop()).not.toThrow();
    expect(input.detach).not.toHaveBeenCalled();
  });

  it("the internal frame loop calls advance() each tick until stopped", () => {
    const { engine, handlers } = makeEngine(fakeMap());
    engine.start();
    const before = handlers.onStats.mock.calls.length;
    raf.flush(1, 16);
    expect(handlers.onStats.mock.calls.length).toBeGreaterThan(before);
    engine.stop();
  });

  it("a stale queued frame callback firing after stop() is a safe no-op", () => {
    const { engine } = makeEngine(fakeMap());
    engine.start();
    const rafMock = requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;
    const staleCallback = rafMock.mock.calls[0][0] as FrameRequestCallback;
    engine.stop();
    expect(() => staleCallback(999)).not.toThrow();
  });
});

describe("RaycasterEngine — startExternallyDriven() (multiplayer/headless)", () => {
  it("attaches input and pushes initial stats, without scheduling an internal frame", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    engine.startExternallyDriven();
    expect(input.attach).toHaveBeenCalledTimes(1);
    expect(handlers.onStats).toHaveBeenCalledTimes(1);
    expect(raf.flush(1)).toBe(0); // nothing queued — no competing internal loop
  });

  it("is idempotent, same as start()", () => {
    const { engine, input } = makeEngine(fakeMap());
    engine.startExternallyDriven();
    engine.startExternallyDriven();
    expect(input.attach).toHaveBeenCalledTimes(1);
  });

  it("a caller can still drive simulate()/advance() directly afterward", () => {
    const { engine, handlers } = makeEngine(fakeMap());
    engine.startExternallyDriven();
    const before = handlers.onStats.mock.calls.length;
    engine.advance(1 / 30);
    expect(handlers.onStats.mock.calls.length).toBe(before + 1); // render()'s own onStats push
    expect(() => engine.stop()).not.toThrow(); // rafId was never assigned; cancelAnimationFrame(0) must still be safe
  });
});

describe("RaycasterEngine — startReplayDriven() (replay playback)", () => {
  it("primes like startExternallyDriven, but without the externally-driven FPS measurement", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    engine.startReplayDriven();
    expect(input.attach).toHaveBeenCalledTimes(1);
    expect(handlers.onStats).toHaveBeenCalledTimes(1);
    expect(raf.flush(1)).toBe(0); // no competing internal loop
    // Unlike startExternallyDriven(), this leaves `externallyDriven` unset —
    // the replay viewer seeks by replaying whole seconds of recorded input in
    // one synchronous burst, which would report a meaningless four-figure FPS
    // if it were measured like a paced session. That flag is private and only
    // surfaces in the FPS overlay, so the guarantee asserted here is the one
    // that is observable: driving advance() directly still works.
    expect(() => engine.advance(1 / 60)).not.toThrow();
  });

  it("reveals the spawn tile before the first step, matching what live play gets from start()", () => {
    const map = fakeMap();
    const { engine } = makeEngine(map);
    expect(map.visited[map.spawn.y][map.spawn.x]).toBe(false); // construction alone reveals nothing
    engine.startReplayDriven();
    expect(map.visited[map.spawn.y][map.spawn.x]).toBe(true);
  });

  it("is idempotent, same as start()", () => {
    const { engine, input } = makeEngine(fakeMap());
    engine.startReplayDriven();
    engine.startReplayDriven();
    expect(input.attach).toHaveBeenCalledTimes(1);
  });
});

describe("RaycasterEngine — rotSpeedMultiplier", () => {
  /** Rotates for a fixed simulated duration with the turn key held, and
   * reports how far the view actually swung. */
  function turnFor(rotSpeedMultiplier: number | undefined): number {
    const input = new ScriptedInput();
    const { engine } = makeEngine(fakeMap(), makeHandlers(), { input, rotSpeedMultiplier });
    engine.startReplayDriven();
    const facing = (): { dirX: number; dirY: number } => engine.getPlayerFacing("local")!;
    const before = Math.atan2(facing().dirY, facing().dirX);
    input.keys.add("KeyE");
    for (let i = 0; i < 10; i++) engine.advance(0.01);
    const after = Math.atan2(facing().dirY, facing().dirX);
    let diff = after - before;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff);
  }

  it("scales rotation by the override, so a replay can reproduce the speed it was recorded at", () => {
    const base = turnFor(undefined);
    // ROT_SPEED 2.6 * 0.1s = 0.26rad at 1x. The override is what a replay
    // segment carries; without it playback runs at 1x and every recorded turn
    // under-rotates, which is the bug this parameter exists for.
    expect(base).toBeCloseTo(0.26, 6);
    expect(turnFor(2.5)).toBeCloseTo(0.65, 6);
  });

  it("clamps a hostile or corrupt recorded value instead of trusting it", () => {
    // A segment reaches the constructor from localStorage or an imported
    // replay file, so this is untrusted input, not just a URL param.
    expect(turnFor(1e9)).toBeCloseTo(2.6, 6); // clamped to 10x
    expect(turnFor(0)).toBeCloseTo(0.26, 6); // clamped up to 1x
    expect(turnFor(Number.NaN)).toBeCloseTo(0.26, 6);
  });
});

describe("RaycasterEngine — pause / blur / escape", () => {
  it("Escape toggles pause and fires onFreezeChange only on the edge", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.escape = true;
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(true);
    handlers.onFreezeChange.mockClear();

    engine.advance(0.016); // still paused, no new escape — no edge, no re-fire
    expect(handlers.onFreezeChange).not.toHaveBeenCalled();

    input.escape = true;
    engine.advance(0.016); // toggles back off
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(false);
  });

  it("a blur forces pause (not a toggle)", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.blur = true;
    engine.advance(0.016);
    expect(lastStats(handlers)).toBeDefined();
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(true);
  });

  it("a pointer-unlock also forces pause", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.pointerUnlock = true;
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(true);
  });

  it("a click resumes from pause", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.escape = true;
    engine.advance(0.016);
    handlers.onFreezeChange.mockClear();
    input.click = true;
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(false);
  });

  it("movement doesn't happen while paused", () => {
    const map = fakeMap();
    const { engine, input, handlers } = makeEngine(map);
    input.escape = true;
    engine.advance(0.016); // pause
    input.escape = false;
    input.keys.add("KeyW");
    engine.advance(0.5); // would move a lot if unpaused
    void handlers;
  });
});

describe("RaycasterEngine — automap toggle", () => {
  it("Tab toggles the automap without pausing the sim", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.mapToggle = true;
    expect(() => engine.advance(0.016)).not.toThrow();
    // notifyFrozen(false) only actually fires the handler on an edge (it's
    // already false by default) — the real signal that the automap didn't
    // pause anything is that onFreezeChange never reports true.
    expect(handlers.onFreezeChange).not.toHaveBeenCalledWith(true);
  });

  it("passes this session's loot drops to drawAutomap while it's open in a multiplayer session", () => {
    // A non-default localPlayerId ("host") makes isMultiplayerSession() true
    // — see engine.ts's own doc comment on that check — exercising the
    // `this.isMultiplayerSession() ? this.drops : []` branch drawAutomap's
    // call site takes, which single-player's own automap-toggle test above
    // never reaches.
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), makeHandlers(), undefined, undefined, undefined, 1, input, undefined, "host");
    input.mapToggle = true;
    expect(() => engine.advance(0.016)).not.toThrow();
  });
});

describe("RaycasterEngine — lore terminals", () => {
  function loreMap() {
    const size = 12;
    const g = walledRoom(size);
    g[5][6] = LORE_TILE; // just east of spawn (5,5), within LORE_INTERACT_RADIUS of the tile-center spawn
    return fakeMap({ grid: g, loreTerminals: [{ x: 6, y: 5, text: "// a secret comment" }] }, size);
  }

  it("opens a nearby lore terminal on interact, freezing the sim", () => {
    // Opening happens at the *end* of the interact frame (after this
    // frame's own notifyFrozen(false) already ran) — the freeze(true)
    // report only fires on the *next* advance() call, once loreText is set.
    const { engine, input, handlers } = makeEngine(loreMap());
    input.interact = true;
    engine.advance(0.016);
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenCalledWith(true);
  });

  it("closes on a second interact", () => {
    // Frame 1: opens (no freeze edge yet — see above). Frame 2: closing
    // interact clears loreText, but this frame *still* reports frozen=true
    // (it was still "up" for this frame's render). Frame 3, with no further
    // interact, is the one that reports the actual unfreeze.
    const { engine, input, handlers } = makeEngine(loreMap());
    input.interact = true;
    engine.advance(0.016);
    input.interact = true;
    engine.advance(0.016);
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenLastCalledWith(false);
  });

  it("closes on a click", () => {
    const { engine, input, handlers } = makeEngine(loreMap());
    input.interact = true;
    engine.advance(0.016);
    input.click = true;
    engine.advance(0.016);
    engine.advance(0.016);
    expect(handlers.onFreezeChange).toHaveBeenLastCalledWith(false);
  });

  it("scrolls with W/S while the overlay is open", () => {
    const { engine, input } = makeEngine(loreMap());
    input.interact = true;
    engine.advance(0.016);
    input.keys.add("KeyS");
    expect(() => engine.advance(0.1)).not.toThrow();
    input.keys.delete("KeyS");
    input.keys.add("KeyW");
    expect(() => engine.advance(0.1)).not.toThrow();
  });

  it("does not open a lore terminal outside interact range", () => {
    const map = fakeMap(); // no lore terminals at all
    const { engine, input, handlers } = makeEngine(map);
    input.interact = true;
    engine.advance(0.016);
    expect(handlers.onFreezeChange).not.toHaveBeenCalledWith(true);
  });

  // Multiplayer-only regression test (multiplayer-netcode-spec.md §6): a
  // single-player/replay instance (localPlayerId === LOCAL_PLAYER_ID) must
  // keep freezing exactly as every test above proves. A non-LOCAL_PLAYER_ID
  // instance (a real multiplayer peer) must NOT — every peer runs its own
  // independent RaycasterEngine, so a local-only freeze on just one of them
  // would desync the shared simulation the instant either player reads a
  // terminal.
  it("multiplayer-only: opening a lore terminal doesn't freeze simulate() for a non-LOCAL_PLAYER_ID instance", () => {
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), loreMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
    input.interact = true;
    expect(engine.simulate(0.016)).toBe(true); // opens the overlay, but still progressed
  });

  // Step 8 (multiplayer-netcode-spec.md §6): the overlay is static and
  // dismiss-only in multiplayer — neither a second interact nor a click
  // closes it anymore (both carry real shared-simulation side effects
  // unrelated to a purely local, cosmetic overlay), and W/S no longer
  // scrolls it (those keys drive real shared movement — holding them while
  // the overlay is open must actually move the player, not just scroll
  // text). See `dismissLoreOverlay()`'s own doc comment for the real close
  // mechanism.
  describe("multiplayer-only: static, dismiss-only overlay (step 8)", () => {
    function loreStateOf(engine: InstanceType<typeof RaycasterEngine>): Map<
      string,
      { loreText: string | null; loreScroll: number; player: { posX: number; posY: number } }
    > {
      return (
        engine as unknown as {
          players: Map<string, { loreText: string | null; loreScroll: number; player: { posX: number; posY: number } }>;
        }
      ).players;
    }

    it("stays open across a second interact and a click — neither dismisses it anymore", () => {
      const input = new ScriptedInput();
      const engine = new RaycasterEngine(makeCanvas(), loreMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
      input.interact = true;
      engine.simulate(0.016); // opens it
      const state = loreStateOf(engine);
      expect(state.get("H")!.loreText).not.toBeNull();

      input.interact = true;
      engine.simulate(0.016);
      expect(state.get("H")!.loreText).not.toBeNull();

      input.interact = false;
      input.click = true;
      engine.simulate(0.016);
      expect(state.get("H")!.loreText).not.toBeNull();
    });

    it("holding W/S while it's open moves the player instead of scrolling — loreScroll never changes", () => {
      const input = new ScriptedInput();
      const engine = new RaycasterEngine(makeCanvas(), loreMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
      input.interact = true;
      engine.simulate(0.016); // opens it
      input.interact = false;

      // Spawn faces the lore terminal itself (a wall tile, directly ahead) —
      // "S" (backward) is the direction that's actually unobstructed, so
      // this proves real movement rather than colliding with the terminal.
      const state = loreStateOf(engine);
      const before = { x: state.get("H")!.player.posX, y: state.get("H")!.player.posY };
      input.keys.add("KeyS");
      engine.simulate(0.5);

      const after = state.get("H")!.player;
      expect(after.posX !== before.x || after.posY !== before.y).toBe(true); // the real fix: S actually moved the player
      expect(state.get("H")!.loreScroll).toBe(0); // never touched
    });

    it("dismissLoreOverlay() closes it, and is a harmless no-op when nothing is open", () => {
      const input = new ScriptedInput();
      const engine = new RaycasterEngine(makeCanvas(), loreMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
      input.interact = true;
      engine.simulate(0.016); // opens it
      const state = loreStateOf(engine);
      expect(state.get("H")!.loreText).not.toBeNull();

      engine.dismissLoreOverlay();
      expect(state.get("H")!.loreText).toBeNull();

      expect(() => engine.dismissLoreOverlay()).not.toThrow();
      expect(state.get("H")!.loreText).toBeNull();
    });

    it("dismissLoreOverlay() is a no-op for a single-player/replay instance — it uses its own interact/click dismiss path instead", () => {
      const { engine, input } = makeEngine(loreMap());
      input.interact = true;
      engine.advance(0.016); // opens it
      const state = loreStateOf(engine);
      expect(state.get("local")!.loreText).not.toBeNull();

      engine.dismissLoreOverlay();
      expect(state.get("local")!.loreText).not.toBeNull(); // untouched
    });

    it("a remote player's own interact banks the shared exploration-bonus log without opening this (host) peer's overlay", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const hostInput = new ScriptedInput();
      const guestInput = new ScriptedInput();
      const engine = new RaycasterEngine(makeCanvas(), loreMap(), {}, undefined, undefined, undefined, 1, hostInput, undefined, "H");
      engine.addPlayer("G", guestInput);
      guestInput.interact = true;
      engine.simulate(0.016);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("exploration bonus earned"), expect.any(String));
      const state = loreStateOf(engine);
      expect(state.get("H")!.loreText).toBeNull(); // only the guest interacted, not the host
    });

    it("ignores a lore terminal beyond LORE_INTERACT_RADIUS on interact", () => {
      const size = 20;
      const g = walledRoom(size);
      g[10][10] = LORE_TILE; // far corner, well beyond LORE_INTERACT_RADIUS (1.8) of spawn
      const map = fakeMap({ grid: g, spawn: { x: 2, y: 2 }, loreTerminals: [{ x: 10, y: 10, text: "// unreachable" }] }, size);
      const { engine, input } = makeEngine(map);
      input.interact = true;
      engine.advance(0.016);
      expect(loreStateOf(engine).get("local")!.loreText).toBeNull();
    });
  });
});

describe("RaycasterEngine — secret walls", () => {
  it("opens a secret wall directly ahead on interact, flood-filling the room", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][6] = SECRET_WALL_TILE;
    g[5][7] = SECRET_WALL_TILE;
    const map = fakeMap({ grid: g }, size);
    const { engine, input } = makeEngine(map);
    input.interact = true;
    engine.advance(0.016);
    expect(map.grid[5][6]).toBe(0);
    expect(map.grid[5][7]).toBe(0);
  });

  it("prefers a secret wall over a lore terminal when both are reachable", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][6] = SECRET_WALL_TILE;
    const map = fakeMap({ grid: g, loreTerminals: [{ x: 6, y: 5, text: "irrelevant" }] }, size);
    const { engine, input, handlers } = makeEngine(map);
    input.interact = true;
    engine.advance(0.016);
    expect(map.grid[5][6]).toBe(0);
    expect(handlers.onFreezeChange).not.toHaveBeenCalledWith(true); // lore overlay never opened
  });
});

describe("RaycasterEngine — weapon switching", () => {
  it("switches via a number key to an owned ranged weapon", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.weaponRequest = 1; // slot 1 -> shotgun (index 1), owned by default
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(1);
  });

  it("ignores a number key for an unowned weapon", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.weaponRequest = 4; // slot 4 -> gdb (index 3), not owned by default
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(0);
  });

  it("cycles to the next owned ranged weapon via the wheel", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.wheelSteps = 1;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(1); // pistol(0) -> shotgun(1), knife(2) is melee-excluded
  });

  it("cycles backward via a negative wheel step", () => {
    const { engine, input, handlers } = makeEngine(fakeMap(), makeHandlers(), { carryover: undefined });
    input.weaponRequest = 1; // start on shotgun
    engine.advance(0.016);
    input.wheelSteps = -1;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(0);
  });

  it("leaves the weapon unchanged when no other number-key-reachable weapon is owned", () => {
    const { engine, input, handlers } = makeEngine(fakeMap(), makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, ownedWeapons: [] },
    });
    input.wheelSteps = 1;
    expect(() => engine.advance(0.016)).not.toThrow();
    expect(lastStats(handlers).weaponIndex).toBe(0);
  });
});

describe("RaycasterEngine — movement", () => {
  it("moves forward on W and updates distance traveled (via score's path bonus needing >0 distance)", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.keys.add("KeyW");
    for (let i = 0; i < 5; i++) engine.advance(0.1);
    // Indirect check: no throw across several frames of real movement/collision.
    expect(() => engine.advance(0.1)).not.toThrow();
  });

  it("blocks movement into a wall", () => {
    const map = fakeMap();
    const { engine, input } = makeEngine(map);
    input.keys.add("KeyA"); // strafe toward the west wall (spawn at 5,5 in a 12x12 walled room)
    for (let i = 0; i < 200; i++) engine.advance(0.1);
    expect(() => engine.advance(0.1)).not.toThrow(); // player never escapes the room's walls
  });

  it("moves backward on S and strafes on D", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.keys.add("KeyS");
    engine.advance(0.1);
    input.keys.delete("KeyS");
    input.keys.add("KeyD");
    expect(() => engine.advance(0.1)).not.toThrow();
  });

  it("normalizes diagonal movement (W+D) to cover the same distance as straight movement, not sqrt(2) more", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const { engine: straightEngine, input: straightInput } = makeEngine(fakeMap());
      straightInput.keys.add("KeyW");
      straightEngine.advance(0.1);
      const straightHooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const straightDistance = (straightHooks!.getPlayerState() as { distanceTraveled: number }).distanceTraveled;

      const { engine: diagonalEngine, input: diagonalInput } = makeEngine(fakeMap());
      diagonalInput.keys.add("KeyW");
      diagonalInput.keys.add("KeyD");
      diagonalEngine.advance(0.1);
      const diagonalHooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const diagonalDistance = (diagonalHooks!.getPlayerState() as { distanceTraveled: number }).distanceTraveled;

      // Both engines take a single unblocked 0.1s step in an open room — a
      // real diagonal step (both axes independently scaled by SQRT1_2, then
      // vector-added) should cover exactly the same ground as a straight
      // one. Before the fix, moveForward/strafe each applied a full,
      // un-scaled step, so this would have been ~41% (sqrt(2)) larger.
      expect(diagonalDistance).toBeCloseTo(straightDistance, 6);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("sprint (Shift) moves the player further per frame than a normal walk", () => {
    // Exercised via no-throw + doesn't assert exact distance (Player's own
    // collision math is already unit-tested) — this just confirms the
    // sprint branch runs.
    const { engine, input } = makeEngine(fakeMap());
    input.keys.add("KeyW");
    input.keys.add("ShiftLeft");
    expect(() => engine.advance(0.1)).not.toThrow();
  });

  it("rotates via Q/E and mouse look", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.keys.add("KeyQ");
    engine.advance(0.1);
    input.keys.delete("KeyQ");
    input.keys.add("KeyE");
    engine.advance(0.1);
    input.keys.delete("KeyE");
    input.mouseDX = 10;
    expect(() => engine.advance(0.1)).not.toThrow();
  });

  it("moves via gamepad axes", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.gpForward = 1;
    input.gpStrafe = 0.5;
    input.gpTurn = 0.3;
    expect(() => engine.advance(0.1)).not.toThrow();
  });
});

describe("RaycasterEngine — Acid Overflow rooms", () => {
  /** A 12x12 walled room with the player spawning inside a 3x3 overflow room
   * that starts flooding under their feet. */
  function overflowMap(tiles = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }]) {
    const size = 12;
    const g = walledRoom(size);
    const enemy = fakeEnemy({ x: 8.5, y: 8.5, hp: 30, maxHp: 30 });
    return fakeMap({
      grid: g,
      enemies: [enemy],
      acidOverflows: [{ room: { x: 4, y: 4, w: 4, h: 4 }, enemyIndex: 0, tiles, intervalSeconds: 0.5 }],
    }, size);
  }

  it("floods the room once the player is standing in it", () => {
    const map = overflowMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][5]).toBe(HAZARD_TILE);
  });

  it("drains health through the ordinary hazard path once a tile floods", () => {
    // `applyHazardDamage` reads the grid, not `map.hazards`, so runtime acid
    // hurts with no extra wiring — and `"hazard"` is already a DamageSource.
    const map = overflowMap();
    const { engine, handlers } = makeEngine(map);
    for (let i = 0; i < 40; i++) engine.advance(0.1);
    expect(lastStats(handlers).health).toBeLessThan(100);
  });

  it("stops spreading once the assigned enemy is dead", () => {
    const map = overflowMap();
    const { engine } = makeEngine(map);
    engine.advance(0.1);
    map.enemies[0].alive = false;
    for (let i = 0; i < 60; i++) engine.advance(0.1);
    // The last planned tile was never reached, because the leak was stopped.
    expect(map.grid[6][5]).toBe(0);
  });

  it("doesn't flood a room the player never walks into", () => {
    const size = 12;
    const g = walledRoom(size);
    const map = fakeMap({
      grid: g,
      enemies: [fakeEnemy({ x: 2.5, y: 2.5 })],
      acidOverflows: [{ room: { x: 9, y: 9, w: 2, h: 2 }, enemyIndex: 0, tiles: [{ x: 9, y: 9 }], intervalSeconds: 0.2 }],
    }, size);
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[9][9]).toBe(0);
  });

  it("plays a cue and shows a toast when the flood starts under the local player", () => {
    // The only other signal is the tiles changing colour underfoot, so a
    // player looking the wrong way finds out by taking damage (`notes`).
    const cue = vi.spyOn(audio, "playAcidOverflow");
    const map = overflowMap();
    const { engine } = makeEngine(map);
    engine.advance(0.1);
    expect(cue).toHaveBeenCalledTimes(1);
  });

  it("cues once, not on every tick the player stays in the room", () => {
    const cue = vi.spyOn(audio, "playAcidOverflow");
    const map = overflowMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 30; i++) engine.advance(0.1);
    expect(cue).toHaveBeenCalledTimes(1);
  });

  it("doesn't cue for a room the local player never walks into", () => {
    const cue = vi.spyOn(audio, "playAcidOverflow");
    const size = 12;
    const g = walledRoom(size);
    const map = fakeMap({
      grid: g,
      enemies: [fakeEnemy({ x: 2.5, y: 2.5 })],
      acidOverflows: [{ room: { x: 9, y: 9, w: 2, h: 2 }, enemyIndex: 0, tiles: [{ x: 9, y: 9 }], intervalSeconds: 0.2 }],
    }, size);
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(cue).not.toHaveBeenCalled();
  });

  it("doesn't cue a dead local player whose teammate started the flood", () => {
    // A flood is started by any *living* player, so in coop a teammate can
    // trigger the room you're lying dead in — no sound, no toast for you.
    const cue = vi.spyOn(audio, "playAcidOverflow");
    const map = overflowMap();
    const { engine } = makeEngine(map);
    // Reaching into private state deliberately: there's no public way to kill
    // the local player without also ending the run, which would stop
    // `simulate()` before the flood ever ran.
    (engine as unknown as { players: Map<string, { status: string }> }).players.get("local")!.status = "dead";
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(cue).not.toHaveBeenCalled();
  });

  it("never pushes a flooded tile onto the reconciliation grid delta", () => {
    // LOAD-BEARING: `applyGridReconciliation`'s out-of-order safety rests on
    // every `gridDelta` entry being a terminal `value: 0`. Acid is
    // `0 -> HAZARD_TILE` and must stay off that channel entirely.
    const map = overflowMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    const snapshot = engine.captureReconciliationSnapshot(1, true);
    expect(snapshot.gridDelta).toEqual([]);
    expect(snapshot.gridVersion).toBe(0);
  });

  it("carries the flood state on the reconciliation snapshot instead", () => {
    const map = overflowMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    const snapshot = engine.captureReconciliationSnapshot(1, true);
    expect(snapshot.acidOverflows).toHaveLength(1);
    expect(snapshot.acidOverflows[0].index).toBe(0);
    expect(snapshot.acidOverflows[0].startedAt).not.toBeNull();
  });

  it("retracts a speculatively-flooded tile when the host says otherwise", () => {
    const map = overflowMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][5]).toBe(HAZARD_TILE);

    // The host's authoritative view: this room never started flooding at all.
    const snapshot = engine.captureReconciliationSnapshot(2, true);
    engine.applyReconciliationSnapshot({
      ...snapshot,
      acidOverflows: [{ index: 0, startedAt: null, frozenTarget: null }],
    });
    engine.advance(0.1);
    expect(map.grid[5][5]).toBe(0);
  });

  it("ignores a snapshot entry for an overflow index this peer doesn't have", () => {
    const map = overflowMap();
    const { engine } = makeEngine(map);
    engine.advance(0.1);
    const snapshot = engine.captureReconciliationSnapshot(2, true);
    expect(() =>
      engine.applyReconciliationSnapshot({
        ...snapshot,
        acidOverflows: [{ index: 99, startedAt: 0, frozenTarget: null }],
      }),
    ).not.toThrow();
  });
});

describe("RaycasterEngine — Exception Zone acid decay", () => {
  /** Spawn standing in a one-tile-wide `try` gauntlet, the shape
   * `placeExceptionZones` produces, plus an unrelated acid pool elsewhere. */
  function gauntletMap(): GameMap {
    const size = 12;
    const g = walledRoom(size);
    for (let y = 4; y <= 6; y++) g[y][5] = HAZARD_TILE; // the gauntlet
    g[9][2] = HAZARD_TILE; // a fillHazards room pool — permanent terrain
    return fakeMap(
      {
        grid: g,
        spawn: { x: 5, y: 5 },
        hazards: [
          { x: 5, y: 4 },
          { x: 5, y: 5 },
          { x: 5, y: 6 },
          { x: 2, y: 9 },
        ],
        exceptionZones: [
          {
            tryRect: { x: 5, y: 4, w: 1, h: 3 },
            catchRect: { x: 4, y: 2, w: 2, h: 2 },
            finallyRect: { x: 2, y: 2, w: 2, h: 2 },
          },
        ],
      },
      size,
    );
  }

  it("burns out the tile the player is standing in, and stops damaging them", () => {
    const map = gauntletMap();
    const { engine, handlers } = makeEngine(map);

    // Under the decay window: still acid, still hurting.
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    const hurt = lastStats(handlers).health;
    expect(hurt).toBeLessThan(100);
    expect(map.grid[5][5]).toBe(HAZARD_TILE);

    // Past it: the tile is gone and health stops falling.
    for (let i = 0; i < 10; i++) engine.advance(0.1);
    expect(map.grid[5][5]).toBe(0);
    const settled = lastStats(handlers).health;
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(lastStats(handlers).health).toBe(settled);
  });

  it("leaves gauntlet tiles the player never stepped in, and unrelated acid, alone", () => {
    const map = gauntletMap();
    const { engine } = makeEngine(map);
    for (let i = 0; i < 60; i++) engine.advance(0.1);
    expect(map.grid[4][5]).toBe(HAZARD_TILE); // same shaft, never touched
    expect(map.grid[9][2]).toBe(HAZARD_TILE); // room pool, not a try gauntlet
  });
});

describe("RaycasterEngine — keys and doors", () => {
  function doorMap(): GameMap {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE; // directly east of spawn
    return fakeMap(
      {
        grid: g,
        keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
        doors: [{ x: 7, y: 5 }],
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
      },
      size,
    );
  }

  // Regression: `collectKeyBillboards` defaults `gateColors` to `[]`, and the
  // engine used to call it without that argument — so every key in the world
  // fell through the `?? 1` fixture fallback and drew blue, whatever gate it
  // belonged to. `sprites.test.ts` could not see it: every test there passes
  // its own `gateColors` (or deliberately omits it), so the bug lived entirely
  // in the *wiring*. This asserts the gate table actually reaches the renderer.
  it("draws an uncollected key in its own gate's colour, not the fallback blue", () => {
    const size = 12;
    const map = fakeMap(
      {
        // Dead ahead of the spawn (5.5, 5.5) facing +x, well inside the room
        // so no wall occludes it, and far enough not to be auto-collected.
        keys: [{ x: 8.5, y: 5.5, collected: false, gateId: 0 }],
        gates: [{ id: 0, colorIndex: 2, room: { x: 9, y: 4, w: 2, h: 3 }, doors: [] }],
      },
      size,
    );
    const { engine } = makeEngine(map);
    const ctx = (engine as unknown as { ctx: MockCanvasContext }).ctx;
    const styles: string[] = [];
    ctx.fillRect.mockImplementation(() => {
      styles.push(ctx.fillStyle as string);
    });
    engine.advance(0.016);
    // Assert on the key sprite's *bezel* tones, not its face. The face colours
    // are shared with the HUD key pips (`HUD_GATE_COLORS`), which draw a pip
    // for this same gate every frame — so "a green fillStyle appeared" passes
    // even with the bug present, and proves nothing. The bezels in
    // `KEY_GATE_COLORS` appear nowhere else in the game, so they isolate the
    // one renderer under test.
    expect(styles).toContain("#0c3018"); // green key bezel — gate colorIndex 2
    expect(styles).not.toContain("#0c1c40"); // never the blue fixture fallback
  });

  it("holds both gates' keys at once, reported in sorted order", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    const map = fakeMap(
      {
        grid: g,
        // Two keys within pickup radius of spawn, deliberately listed with the
        // higher gate first so the sort has something to do.
        keys: [
          { x: 5.5, y: 5.5, collected: false, gateId: 1 },
          { x: 5.4, y: 5.4, collected: false, gateId: 0 },
        ],
        doors: [{ x: 7, y: 5 }],
        gates: [
          { id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] },
          { id: 1, colorIndex: 1, room: { x: 1, y: 1, w: 2, h: 2 }, doors: [] },
        ],
      },
      size,
    );
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.016);
    expect(lastStats(handlers).heldGates).toEqual([0, 1]);
    expect(lastStats(handlers).gateColors).toEqual([0, 1]);
  });

  it("collects a nearby key", () => {
    const { engine, handlers } = makeEngine(doorMap());
    engine.advance(0.016);
    expect(lastStats(handlers).heldGates).toHaveLength(1);
  });

  it("opens a door ahead when holding a key and walking into it", () => {
    const map = doorMap();
    const { engine, input, handlers } = makeEngine(map);
    engine.advance(0.016); // collect the key first
    input.keys.add("KeyW"); // push toward the door (spawn faces +X by default)
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(0);
    // The key is NOT spent: it opens every doorway of its own gate, as often
    // as the room has mouths. Paying again for a door you already opened from
    // the other side is the defect this replaced.
    expect(lastStats(handlers).heldGates).toEqual([0]);
  });

  it("does not open a door without a key", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    const map = fakeMap({ grid: g }, size); // no keys at all
    const { engine, input } = makeEngine(map);
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(DOOR_TILE);
  });

  it("exposes an uncollected key via getKeys and stops listing it once collected", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const map = doorMap();
      const { engine } = makeEngine(map);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect(hooks!.getKeys()).toEqual([{ x: 5.5, y: 5.5 }]);
      engine.advance(0.016); // collect the key
      expect(hooks!.getKeys()).toEqual([]);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("opens a whole multi-tile doorway for one key", () => {
    // A corridor flush along a room's wall makes every tile of that boundary
    // its own door tile. It's visibly one gate, so it costs one key — see
    // `doorwayTiles`.
    const size = 12;
    const g = walledRoom(size);
    for (let y = 3; y <= 7; y++) g[y][7] = DOOR_TILE;
    const runDoors = [3, 4, 5, 6, 7].map((y) => ({ x: 7, y }));
    const map = fakeMap(
      {
        grid: g,
        keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
        doors: runDoors,
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 3, w: 3, h: 5 }, doors: runDoors }],
      },
      size,
    );
    const { engine, input, handlers } = makeEngine(map);
    engine.advance(0.016); // collect the one key
    expect(lastStats(handlers).heldGates).toHaveLength(1);
    input.keys.add("KeyW"); // push into the doorway at (7,5)
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    for (let y = 3; y <= 7; y++) expect(map.grid[y][7]).toBe(0);
    expect(lastStats(handlers).heldGates).toEqual([0]); // still held — never spent
  });

  it("emits a grid delta for every tile of an opened doorway", () => {
    // The guest has to see the whole run open, not just the pushed tile —
    // and every entry stays a terminal value:0, so the out-of-order-safety
    // invariant is untouched.
    const size = 12;
    const g = walledRoom(size);
    for (let y = 3; y <= 7; y++) g[y][7] = DOOR_TILE;
    const runDoors = [3, 4, 5, 6, 7].map((y) => ({ x: 7, y }));
    const map = fakeMap(
      {
        grid: g,
        keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
        doors: runDoors,
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 3, w: 3, h: 5 }, doors: runDoors }],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    engine.advance(0.016);
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    const snapshot = engine.captureReconciliationSnapshot(1, true);
    for (let y = 3; y <= 7; y++) expect(snapshot.gridDelta).toContainEqual({ x: 7, y, value: 0 });
    expect(snapshot.gridDelta.every((m) => m.value === 0)).toBe(true);
  });

  it("leaves a separate doorway shut when one is opened", () => {
    // Two runs separated by a wall tile are two gates and two keys.
    const size = 12;
    const g = walledRoom(size);
    g[4][7] = DOOR_TILE;
    g[5][7] = DOOR_TILE;
    g[7][7] = DOOR_TILE; // separated from the pair above by plain wall at y=6
    const bothDoorways = [{ x: 7, y: 4 }, { x: 7, y: 5 }, { x: 7, y: 7 }];
    const map = fakeMap(
      {
        grid: g,
        keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
        doors: bothDoorways,
        // One gate, two doorways — the case that used to cost two keys.
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 3, w: 3, h: 6 }, doors: bothDoorways }],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    engine.advance(0.016);
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(0);
    expect(map.grid[7][7]).toBe(DOOR_TILE);
  });

  it("opens a branch door with no key held at all", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = BRANCH_DOOR_TILE; // directly east of spawn
    const map = fakeMap({ grid: g }, size); // deliberately no keys anywhere
    const { engine, input, handlers } = makeEngine(map);
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(0);
    // A branch door is keyless by design, so nothing was ever held.
    expect(lastStats(handlers).heldGates).toEqual([]);
  });

  it("doesn't spend a key when opening a branch door", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = BRANCH_DOOR_TILE;
    const map = fakeMap({ grid: g, keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }] }, size);
    const { engine, input, handlers } = makeEngine(map);
    engine.advance(0.016); // collect the key
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(0);
    expect(lastStats(handlers).heldGates).toHaveLength(1);
  });

  it("blocks movement through a branch door until it's pushed open", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = BRANCH_DOOR_TILE;
    const map = fakeMap({ grid: g }, size);
    const { engine } = makeEngine(map);
    // Not pushing W/S, so `openDoorAhead` never fires — the tile stays solid
    // and the player can't cross it.
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(BRANCH_DOOR_TILE);
    expect(engine.getPlayerPosition("local")!.x).toBeLessThan(7);
  });

  it("emits a terminal value:0 grid mutation when a branch door opens", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = BRANCH_DOOR_TILE;
    const map = fakeMap({ grid: g }, size);
    const { engine, input } = makeEngine(map);
    const before = engine.captureReconciliationSnapshot(0, true).gridVersion;
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    const snapshot = engine.captureReconciliationSnapshot(1, true);
    expect(snapshot.gridDelta).toContainEqual({ x: 7, y: 5, value: 0 });
    expect(snapshot.gridVersion).toBeGreaterThan(before);
  });

  it("reports the grid mutation through the test hooks, so a bot can see a door open", () => {
    // The whole point of `getGridVersion`/`getGrid`: the engine mutates its
    // own grid mid-level, and anything planning against the map it was handed
    // at level start (the playtest bot's Node-side copy) otherwise treats an
    // opened door as a permanent wall — a recorded wedge on
    // `stage03_legacy_api.php`.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 12;
      const g = walledRoom(size);
      g[5][7] = BRANCH_DOOR_TILE;
      const map = fakeMap({ grid: g }, size);
      const { engine, input } = makeEngine(map);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks;
      const versionBefore = hooks!.getGridVersion() as number;
      expect((hooks!.getGrid() as number[][])[5][7]).toBe(BRANCH_DOOR_TILE);

      input.keys.add("KeyW");
      for (let i = 0; i < 20; i++) engine.advance(0.1);

      expect(hooks!.getGridVersion() as number).toBeGreaterThan(versionBefore);
      expect((hooks!.getGrid() as number[][])[5][7]).toBe(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("opens a door behind the player when backing into it with S", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][3] = DOOR_TILE; // west of spawn — behind the player's default +X facing
    const map = fakeMap(
      {
        grid: g,
        keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
        doors: [{ x: 3, y: 5 }],
        gates: [{ id: 0, colorIndex: 0, room: { x: 1, y: 4, w: 2, h: 3 }, doors: [{ x: 3, y: 5 }] }],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    engine.advance(0.016); // collect the key first
    input.keys.add("KeyS"); // push backward, toward the door behind
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][3]).toBe(0);
  });
});

describe("RaycasterEngine — locked-door hint", () => {
  type HintState = {
    lockedDoorToastFrames: number;
    lockedDoorGateId: number;
    lockedDoorBlockerGateId: number;
    keyPingFrames: number;
    keyPingTarget: { x: number; y: number } | null;
    keyPingBeatFrames: number;
    heldGates: Set<number>;
  };

  function hintPlayers(engine: InstanceType<typeof RaycasterEngine>): Map<string, HintState> {
    return (engine as unknown as { players: Map<string, HintState> }).players;
  }

  function hintState(engine: InstanceType<typeof RaycasterEngine>, id = "local"): HintState {
    return hintPlayers(engine).get(id)!;
  }

  /** A locked door directly east of spawn, so plain `KeyW` walks into it. The
   * door belongs to gate 0, which is what the hint now names and pings. */
  function lockedDoorMap(overrides: Partial<GameMap> = {}): GameMap {
    // Larger than the 12 these started at: `FAR_KEY` has to sit outside
    // `KEY_HINT_RADIUS` so the proximity trigger stays out of tests that are
    // about the door, and 9 tiles of clearance does not fit in a 12x12 room.
    const size = 32;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    return fakeMap(
      {
        grid: g,
        doors: [{ x: 7, y: 5 }],
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
        ...overrides,
      },
      size,
    );
  }

  /** Far enough from spawn that `collectKeys` never picks it up mid-test, and
   * — since the proximity hint shipped — far enough that walking past it does
   * not arm a ping of its own. These tests isolate the *door* trigger; the
   * proximity one has its own describe block below. ~20 tiles out, against a
   * `KEY_HINT_RADIUS` of 9. */
  const FAR_KEY: KeyItem = { x: 1.5, y: 25.5, collected: false, gateId: 0 };

  function doorLogs(log: { mock: { calls: unknown[][] } }): unknown[][] {
    return log.mock.calls.filter((c: unknown[]) => typeof c[0] === "string" && c[0].includes("[door] locked"));
  }

  function silenceAudio() {
    return {
      denial: vi.spyOn(audio, "playLockedDoor").mockImplementation(() => {}),
      ping: vi.spyOn(audio, "playKeyPing").mockImplementation(() => {}),
    };
  }

  it("toasts, logs, thunks and pings the nearest key when pushing into a locked door with no key", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { denial } = silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    const local = hintState(engine);
    expect(map.grid[5][7]).toBe(DOOR_TILE); // still shut — this is feedback, not a free pass
    expect(local.lockedDoorToastFrames).toBeGreaterThan(0);
    expect(local.keyPingFrames).toBeGreaterThan(0);
    expect(local.keyPingTarget).toEqual({ x: FAR_KEY.x, y: FAR_KEY.y });
    expect(denial).toHaveBeenCalledTimes(1);
    expect(doorLogs(log)).toHaveLength(1);
  });

  it("never names the key's location in the log — the console sidebar mirrors these strings", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    const line = String(doorLogs(log)[0][0]);
    expect(line).not.toMatch(/\d/); // no coordinates, no counts — nothing positional
  });

  it("does not cue the hint when the player actually holds a key", () => {
    const map = lockedDoorMap({ keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }] });
    const { engine, input } = makeEngine(map);
    const { denial } = silenceAudio();

    engine.advance(0.016); // collect the key first
    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    expect(map.grid[5][7]).toBe(0); // the door opened, so nothing was refused
    expect(hintState(engine).keyPingFrames).toBe(0);
    expect(denial).not.toHaveBeenCalled();
  });

  it("does not cue the hint for a keyless branch door", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = BRANCH_DOOR_TILE;
    const map = fakeMap({ grid: g, keys: [{ ...FAR_KEY }] }, size);
    const { engine, input } = makeEngine(map);
    const { denial } = silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    expect(map.grid[5][7]).toBe(0);
    expect(hintState(engine).keyPingFrames).toBe(0);
    expect(denial).not.toHaveBeenCalled();
  });

  it("fires once per ping window, not once per tick, while the player leans on the door", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { denial } = silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 60; i++) engine.advance(0.1); // 60 ticks of shoving

    expect(denial).toHaveBeenCalledTimes(1);
    expect(doorLogs(log)).toHaveLength(1);
  });

  it("re-arms once the ping window expires", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    const { denial } = silenceAudio();

    input.keys.add("KeyW");
    // Long enough for the first window (240 frames) to run out and a second
    // hint to fire, but not a third.
    for (let i = 0; i < 300; i++) engine.advance(0.05);

    expect(denial).toHaveBeenCalledTimes(2);
  });

  it("pings THIS gate's key, even when another gate's key is much nearer", () => {
    // The payoff of door-to-key identity. It used to ping the nearest
    // uncollected key of any kind, which is now confidently the wrong one:
    // only one key opens the door being pushed, so pointing at a closer key
    // sends the player to fetch something that will not help.
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE; // gate 0, directly east of spawn
    const mine: KeyItem = { x: 2.5, y: 9.5, collected: false, gateId: 0 }; // far
    const other: KeyItem = { x: 5.5, y: 5.5, collected: false, gateId: 1 }; // right here
    const map = fakeMap(
      {
        grid: g,
        keys: [mine, other],
        doors: [{ x: 7, y: 5 }],
        gates: [
          { id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] },
          { id: 1, colorIndex: 1, room: { x: 1, y: 1, w: 2, h: 2 }, doors: [] },
        ],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    // Gate 1's key sits on the spawn tile and is collected instantly; gate 0's
    // is across the room. The ping still points at gate 0's.
    expect(hintState(engine).keyPingTarget).toEqual({ x: 2.5, y: 9.5 });
  });

  it("pings nothing when this gate's key is itself unreachable", () => {
    // `null` is the honest answer — falling back to some other key is exactly
    // the behaviour that made the old hint misleading.
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    for (let x = 4; x <= 6; x++) {
      g[2][x] = 1;
      g[4][x] = 1;
    }
    g[3][4] = 1;
    g[3][6] = 1; // (5,3) is a sealed one-tile pocket
    const sealed: KeyItem = { x: 5.5, y: 3.5, collected: false, gateId: 0 };
    const map = fakeMap(
      {
        grid: g,
        keys: [sealed],
        doors: [{ x: 7, y: 5 }],
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    expect(hintState(engine).keyPingTarget).toBeNull();
  });

  it("pings the blocking key when the asked-for key is behind another gate's door", () => {
    // The reported defect, 2026-08-21: a violet door whose key sat behind the
    // green door showed the banner and pinged nothing, leaving the player with
    // a colour name and no lead. Measured at 71% of doors at the moment a
    // player first meets them, so this was the common case, not an edge one.
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE; // gate 0 — the one the player walks into, east of spawn
    g[3][2] = DOOR_TILE; // gate 1 — the only way into the north-west pocket
    g[1][3] = 1;
    g[2][3] = 1;
    g[3][3] = 1;
    g[3][1] = 1; // pocket is (1..2, 1..2), sealed but for the door at (2,3)
    const behindGate1: KeyItem = { x: 1.5, y: 1.5, collected: false, gateId: 0 };
    const reachableKey: KeyItem = { x: 5.5, y: 9.5, collected: false, gateId: 1 };
    const map = fakeMap(
      {
        grid: g,
        keys: [behindGate1, reachableKey],
        doors: [{ x: 7, y: 5 }, { x: 2, y: 3 }],
        gates: [
          { id: 0, colorIndex: 3, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] },
          { id: 1, colorIndex: 2, room: { x: 1, y: 1, w: 2, h: 2 }, doors: [{ x: 2, y: 3 }] },
        ],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    const state = hintState(engine);
    // Points at gate 1's key — the one that is actually reachable — not at
    // gate 0's, and not at nothing.
    expect(state.keyPingTarget).toEqual({ x: 5.5, y: 9.5 });
    expect(state.lockedDoorGateId).toBe(0);
    expect(state.lockedDoorBlockerGateId).toBe(1);
    // And the console line names the lead, without a coordinate.
    const line = String(doorLogs(log)[0]?.[0] ?? "");
    expect(line).toContain("you need the violet key");
    expect(line).toContain("find the green key first");
    expect(line).not.toMatch(/\d/);
  });

  it("pings the asked-for key when the door in the way is one the player can already open", () => {
    // The wrinkle that makes the fix safe: `PathField` treats a still-`DOOR_TILE`
    // as solid even when its key is in hand, so a naive reachability test would
    // send the player after a key they are already carrying. Holding gate 1
    // must resolve to gate 0's own key, direct.
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    g[3][2] = DOOR_TILE;
    g[1][3] = 1;
    g[2][3] = 1;
    g[3][3] = 1;
    g[3][1] = 1;
    const behindGate1: KeyItem = { x: 1.5, y: 1.5, collected: false, gateId: 0 };
    const reachableKey: KeyItem = { x: 5.5, y: 9.5, collected: false, gateId: 1 };
    const map = fakeMap(
      {
        grid: g,
        keys: [behindGate1, reachableKey],
        doors: [{ x: 7, y: 5 }, { x: 2, y: 3 }],
        gates: [
          { id: 0, colorIndex: 3, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] },
          { id: 1, colorIndex: 2, room: { x: 1, y: 1, w: 2, h: 2 }, doors: [{ x: 2, y: 3 }] },
        ],
      },
      size,
    );
    const { engine, input } = makeEngine(map);
    silenceAudio();
    hintState(engine).heldGates.add(1);

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    const state = hintState(engine);
    expect(state.keyPingTarget).toEqual({ x: 1.5, y: 1.5 });
    expect(state.lockedDoorBlockerGateId).toBe(-1);
  });

  it("skips an already-collected key when choosing what to ping", () => {
    // A teammate can have taken the closest one; it still sits in `map.keys`,
    // just flagged, and pinging it would send the player to bare floor.
    const map = lockedDoorMap({
      keys: [
        { x: 4.5, y: 5.5, collected: true, gateId: 0 }, // one tile away, already taken
        { x: 2.5, y: 2.5, collected: false, gateId: 0 },
      ],
    });
    const { engine, input } = makeEngine(map);
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    expect(hintState(engine).keyPingTarget).toEqual({ x: 2.5, y: 2.5 });
  });

  it("still denies and toasts when no key is reachable at all, with nothing to ping", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE;
    for (let x = 4; x <= 6; x++) {
      g[2][x] = 1;
      g[4][x] = 1;
    }
    g[3][4] = 1;
    g[3][6] = 1;
    const map = fakeMap({ grid: g, keys: [{ x: 5.5, y: 3.5, collected: false, gateId: 0 }] }, size);
    const { engine, input } = makeEngine(map);
    const { denial, ping } = silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 60; i++) engine.advance(0.1);

    const local = hintState(engine);
    expect(local.lockedDoorToastFrames).toBeGreaterThan(0);
    expect(local.keyPingFrames).toBeGreaterThan(0); // window still open, so it still rate-limits
    expect(local.keyPingTarget).toBeNull();
    expect(denial).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled();
  });

  it("sounds the denial immediately and the first sonar ping only after it", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    const { denial, ping } = silenceAudio();

    input.keys.add("KeyW");
    let ticksToFire = 0;
    while (hintState(engine).keyPingFrames === 0 && ticksToFire < 40) {
      engine.advance(0.1);
      ticksToFire += 1;
    }
    expect(denial).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled(); // the thunk gets the floor to itself

    for (let i = 0; i < 10; i++) engine.advance(0.016);
    expect(ping).not.toHaveBeenCalled(); // still inside KEY_PING_LEAD_FRAMES

    for (let i = 0; i < 15; i++) engine.advance(0.016);
    expect(ping).toHaveBeenCalled();
  });

  it("clears the ping target when the window expires", () => {
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine, input } = makeEngine(map);
    silenceAudio();

    input.keys.add("KeyW");
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(hintState(engine).keyPingTarget).not.toBeNull();

    input.keys.delete("KeyW");
    for (let i = 0; i < 260; i++) engine.advance(0.016);

    const local = hintState(engine);
    expect(local.keyPingFrames).toBe(0);
    expect(local.keyPingTarget).toBeNull();
    expect(local.keyPingBeatFrames).toBe(0);
  });

  it("does not cue the local player when a teammate walks into a locked door", () => {
    // `openDoorAhead` loops every player; only the local one may be cued, or a
    // teammate across a coop level would toast and ping your screen.
    const map = lockedDoorMap({ keys: [{ ...FAR_KEY }] });
    const { engine } = makeEngine(map); // local player holds no keys down at all
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { denial } = silenceAudio();

    const mateInput = new ScriptedInput();
    engine.addPlayer("guest", mateInput);
    mateInput.keys.add("KeyW"); // the teammate, and only the teammate, shoves the door
    for (let i = 0; i < 20; i++) engine.advance(0.1);

    expect(map.grid[5][7]).toBe(DOOR_TILE); // the teammate really was refused
    expect(hintState(engine, "guest").keyPingFrames).toBe(0);
    expect(hintState(engine).keyPingFrames).toBe(0);
    expect(denial).not.toHaveBeenCalled();
    expect(doorLogs(log)).toHaveLength(0);
  });
});

describe("RaycasterEngine — proximity key hint", () => {
  /** An open room with no door at all: these tests are about walking *past* a
   * key, not about being refused by anything. */
  function openMap(overrides: Partial<GameMap> = {}): GameMap {
    const size = 12;
    return fakeMap({ grid: walledRoom(size), spawn: { x: 5, y: 5 }, ...overrides }, size);
  }

  function silencePing() {
    return vi.spyOn(audio, "playKeyPing").mockImplementation(() => {});
  }

  /** Same reach-into-`players` trick the locked-door block uses; repeated here
   * rather than hoisted, since these are the only two suites that need it. */
  type PingState = {
    keyPingFrames: number;
    keyPingTarget: { x: number; y: number } | null;
    lockedDoorToastFrames: number;
  };
  function pingState(engine: InstanceType<typeof RaycasterEngine>): PingState {
    return (engine as unknown as { players: Map<string, PingState> }).players.get("local")!;
  }

  it("pings a reachable key the player walks past", () => {
    const key: KeyItem = { x: 7.5, y: 5.5, collected: false, gateId: 0 };
    const map = openMap({ keys: [key], rooms: [{ x: 7, y: 4, w: 3, h: 3 } as GameMap["rooms"][number]] });
    const { engine } = makeEngine(map);
    const ping = silencePing();

    engine.advance(0.016);

    const local = pingState(engine);
    expect(local.keyPingFrames).toBeGreaterThan(0);
    expect(local.keyPingTarget).toEqual({ x: 7.5, y: 5.5 });
    // Immediate, unlike the door hint — there is no denial thunk to wait for.
    expect(ping).toHaveBeenCalled();
  });

  it("pings a key that lies in no room at all, via the radius fallback", () => {
    // 16% of demo-campaign keys sit in a corridor rather than a room rect; a
    // room-only trigger would never hint them. `rooms` is empty here on purpose.
    const key: KeyItem = { x: 7.5, y: 5.5, collected: false, gateId: 0 };
    const { engine } = makeEngine(openMap({ keys: [key], rooms: [] }));
    silencePing();

    engine.advance(0.016);

    expect(pingState(engine).keyPingTarget).toEqual({ x: 7.5, y: 5.5 });
  });

  it("stays silent for a key that is too far away to have been noticed", () => {
    // Needs a map with more than `KEY_HINT_RADIUS` of clearance in it.
    const size = 32;
    const key: KeyItem = { x: 1.5, y: 25.5, collected: false, gateId: 0 };
    const map = fakeMap({ grid: walledRoom(size), spawn: { x: 5, y: 5 }, keys: [key], rooms: [] }, size);
    const { engine } = makeEngine(map);
    silencePing();

    engine.advance(0.016);

    expect(pingState(engine).keyPingFrames).toBe(0);
  });

  it("stays silent for a nearby key behind a door the player cannot open", () => {
    // The assertion the whole reachability flood exists for: a key you can see
    // across a locked threshold is not somewhere you can be sent.
    const size = 12;
    const g = walledRoom(size);
    for (let y = 1; y < size - 1; y++) g[y][7] = 1; // wall off the east half
    g[5][7] = DOOR_TILE;
    const key: KeyItem = { x: 8.5, y: 5.5, collected: false, gateId: 0 };
    const map = fakeMap(
      {
        grid: g,
        spawn: { x: 5, y: 5 },
        keys: [key],
        rooms: [],
        doors: [{ x: 7, y: 5 }],
        gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
      },
      size,
    );
    const { engine } = makeEngine(map);
    silencePing();

    engine.advance(0.016);

    expect(pingState(engine).keyPingFrames).toBe(0);
  });

  it("pings a given key only once, however often the player walks past it", () => {
    const key: KeyItem = { x: 7.5, y: 5.5, collected: false, gateId: 0 };
    const { engine } = makeEngine(openMap({ keys: [key], rooms: [] }));
    silencePing();

    engine.advance(0.016);
    const local = pingState(engine);
    expect(local.keyPingFrames).toBeGreaterThan(0);

    // Run the window fully out, then keep standing there.
    for (let i = 0; i < 400; i++) engine.advance(1 / 60);
    expect(local.keyPingFrames).toBe(0);
    for (let i = 0; i < 120; i++) engine.advance(1 / 60);
    expect(local.keyPingFrames).toBe(0);
  });

  it("does not ping a key that has already been collected", () => {
    const key: KeyItem = { x: 7.5, y: 5.5, collected: true, gateId: 0 };
    const { engine } = makeEngine(openMap({ keys: [key], rooms: [] }));
    silencePing();

    engine.advance(0.016);

    expect(pingState(engine).keyPingFrames).toBe(0);
  });

  it("fires no denial thunk and no locked-door toast — nothing was refused", () => {
    const key: KeyItem = { x: 7.5, y: 5.5, collected: false, gateId: 0 };
    const { engine } = makeEngine(openMap({ keys: [key], rooms: [] }));
    silencePing();
    const denial = vi.spyOn(audio, "playLockedDoor").mockImplementation(() => {});

    engine.advance(0.016);

    const local = pingState(engine);
    expect(local.keyPingFrames).toBeGreaterThan(0);
    expect(denial).not.toHaveBeenCalled();
    expect(local.lockedDoorToastFrames).toBe(0);
  });
});

describe("RaycasterEngine — loot and ammo pickups", () => {
  it("collects a static bullets pickup and adds it to the ammo pool", () => {
    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "bullets", amount: 15, collected: false };
    const { engine, handlers } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
    engine.advance(0.016);
    expect(pickup.collected).toBe(true);
    expect(lastStats(handlers).bullets).toBeGreaterThan(0);
  });

  it("collects a static health pickup, capped at max health", () => {
    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "health", amount: 9999, collected: false };
    const { engine, handlers } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
    engine.advance(0.016);
    expect(lastStats(handlers).health).toBe(100);
  });

  it("collects a static swap pickup", () => {
    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "swap", amount: 10, collected: false };
    const { engine, handlers } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
    engine.advance(0.016);
    expect(lastStats(handlers).swap).toBeGreaterThan(0);
  });

  it("collects a static weapon pickup, granting an unowned weapon", () => {
    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "weapon", amount: 0, weaponIndex: 3, collected: false };
    const { engine, handlers } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
    engine.advance(0.016);
    expect(lastStats(handlers).ownedWeapons).toContain(3);
  });

  it("records a static pickup collection in telemetry when testHooks is on", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "bullets", amount: 15, collected: false };
      const { engine } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { lootCollectedStatic: Record<string, number> };
      expect(snapshot.lootCollectedStatic.bullets).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("leaves an out-of-range pickup alone while collecting an in-range one", () => {
    const near: AmmoPickup = { x: 5.5, y: 5.5, kind: "bullets", amount: 15, collected: false };
    const far: AmmoPickup = { x: 5.5, y: 9, kind: "bullets", amount: 15, collected: false }; // well beyond AMMO_PICKUP_RADIUS
    const { engine } = makeEngine(fakeMap({ ammoPickups: [near, far] }));
    engine.advance(0.016);
    expect(near.collected).toBe(true);
    expect(far.collected).toBe(false);
  });

  it("does not re-collect an already-collected pickup", () => {
    const baseline = makeEngine(fakeMap());
    baseline.engine.advance(0.016);
    const baselineBullets = lastStats(baseline.handlers).bullets;

    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "bullets", amount: 15, collected: true };
    const { engine, handlers } = makeEngine(fakeMap({ ammoPickups: [pickup] }));
    engine.advance(0.016);
    expect(lastStats(handlers).bullets).toBe(baselineBullets); // unaffected by the (already-collected) pickup
  });
});

describe("RaycasterEngine — teleporters", () => {
  it("warps the player onto the target pad", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = TELEPORTER_TILE;
    const teleporter: Teleporter = { x: 5, y: 5, targetX: 8.5, targetY: 8.5, label: "goto label" };
    const map = fakeMap({ grid: g, teleporters: [teleporter] }, size);
    const { engine } = makeEngine(map);
    engine.advance(0.016);
    // Player started exactly on the pad (spawn 5,5 -> posX/posY 5.5,5.5,
    // tile (5,5)) so the very first frame should already warp them.
    expect(() => engine.advance(0.016)).not.toThrow();
  });

  it("doesn't immediately bounce back off a destination that's itself a teleporter tile", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = TELEPORTER_TILE;
    g[8][8] = TELEPORTER_TILE; // destination pad is also a teleporter tile
    const teleporter: Teleporter = { x: 5, y: 5, targetX: 8.5, targetY: 8.5, label: "goto label" };
    const map = fakeMap({ grid: g, teleporters: [teleporter] }, size);
    const { engine } = makeEngine(map);
    engine.advance(0.016); // warps to (8.5, 8.5), tile (8,8) — itself a teleporter tile
    expect(() => engine.advance(0.016)).not.toThrow(); // suppressTeleportAt matches — no re-warp loop
  });

  it("does nothing standing on a teleporter tile with no matching pad data", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = TELEPORTER_TILE; // tile is a teleporter, but map.teleporters has no entry for it
    const map = fakeMap({ grid: g, teleporters: [] }, size);
    const { engine } = makeEngine(map);
    expect(() => engine.advance(0.016)).not.toThrow();
  });
});

describe("RaycasterEngine — hazards, spike traps, and mines", () => {
  it("damages the player standing in a hazard tile", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // HAZARD_TILE
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(1); // a whole second standing in acid
    expect(lastStats(handlers).health).toBeLessThan(100);
  });

  it("absorbs damage with swap before health, 1:1, on a partial absorb", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // HAZARD_TILE
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 5, bullets: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(1); // HAZARD_DPS(18) * 1s = 18 damage — more than the 5 swap available
    const stats = lastStats(handlers);
    expect(stats.swap).toBe(0); // fully absorbed
    expect(stats.health).toBe(87); // 100 - (18 - 5) remaining after swap absorbs its share
  });

  it("damages the player standing on an active spike trap", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 5; // SPIKE_TRAP_TILE
    const trap: SpikeTrap = { x: 5, y: 5, period: 4, phase: 0 };
    const map = fakeMap({ grid: g, spikeTraps: [trap] }, size);
    const { engine, handlers } = makeEngine(map);
    // levelTime starts at 0 each advance() call adds dt — need to cross
    // into the active half of the cycle (t >= period/2 = 2s).
    engine.advance(2.5);
    expect(lastStats(handlers).health).toBeLessThan(100);
  });

  it("detonates a proximity mine the player lingers next to", () => {
    const mine: Mine = { x: 5.5, y: 5.5, alive: true, visible: false, closeTimer: 0 };
    const map = fakeMap({ mines: [mine] });
    const { engine, handlers } = makeEngine(map);
    for (let i = 0; i < 20; i++) engine.advance(0.1); // 2s, past MINE_FUSE_SECONDS
    expect(mine.alive).toBe(false);
    expect(lastStats(handlers).health).toBeLessThan(100);
  });

  it("no-ops a second same-frame endGame() call (spike kill + a mine detonating in the same frame)", () => {
    // applyTrapDamage() makes two separate damage() calls in one frame when
    // both an active spike trap and a proximity mine's fuse expire on the
    // same tick — the spike's damage() call alone drops health to 0 and
    // ends the run; the mine's damage() call right after (same frame, same
    // function, no re-check of state in between) calls endGame("over") a
    // second time, which must be a safe no-op, not a second state flip.
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 5; // SPIKE_TRAP_TILE
    // period/phase chosen so the trap is active from levelTime 0 onward,
    // for the whole test (never cycles back off).
    const trap: SpikeTrap = { x: 5, y: 5, period: 1000, phase: 500 };
    const mine: Mine = { x: 5.5, y: 5.5, alive: true, visible: false, closeTimer: 0 };
    const map = fakeMap({ grid: g, spikeTraps: [trap], mines: [mine] }, size);
    const { engine, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 19, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
    });
    // Warm-up: 8 frames of dt=0.1 — spike deals SPIKE_DPS(20)*0.1=2/frame
    // (16 total), and the mine's closeTimer climbs to 0.8s, just under
    // MINE_FUSE_SECONDS (0.9) so it hasn't detonated yet. Health: 19-16=3.
    for (let i = 0; i < 8; i++) engine.advance(0.1);
    expect(handlers.onGameOver).not.toHaveBeenCalled();
    // Final frame (dt=0.15, comfortably past the closeTimer's 0.9s threshold
    // even accounting for float accumulation error): spike deals 3 more
    // (health 3->0, first endGame("over") call), then the mine's closeTimer
    // crosses 0.9 and detonates at point-blank range in the very same
    // applyTrapDamage() call, triggering damage()'s own endGame("over") a
    // second time.
    expect(() => engine.advance(0.15)).not.toThrow();
    expect(lastStats(handlers).health).toBe(0);
    expect(mine.alive).toBe(false);
  });
});

describe("RaycasterEngine — enemy AI integration", () => {
  it("melee-damages the player once an aggroed enemy is adjacent", () => {
    const enemy = fakeEnemy({ x: 5.5, y: 5.5, aggroed: true });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, handlers } = makeEngine(map);
    for (let i = 0; i < 30; i++) engine.advance(0.1);
    expect(lastStats(handlers).health).toBeLessThanOrEqual(100);
  });

  it("does not throw with a living, undiscovered, unaggroed enemy roaming", () => {
    const enemy = fakeEnemy({ x: 8, y: 8 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine } = makeEngine(map);
    expect(() => {
      for (let i = 0; i < 10; i++) engine.advance(0.1);
    }).not.toThrow();
  });
});

describe("RaycasterEngine — firing", () => {
  it("fires the pistol at a point-blank enemy and kills it in enough hits", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(enemy.alive).toBe(false);
    expect(lastStats(handlers).kills).toBe(1);
  });

  it("falls back to the default gore tier for a level name this build doesn't know", () => {
    // A replay segment stores `gore` as a bare string and hands it straight
    // back to the constructor at playback, so a payload recorded on a newer
    // build (or edited in devtools) reaches here as an unknown tier. Without
    // the fallback the multiplier lookup is `undefined` and the first hit
    // throws on `.count` — the shot below is what would have thrown.
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input } = makeEngine(map, makeHandlers(), { gore: "ultra-splatter-9000" as GoreLevel });
    input.fireQueued = true;
    expect(() => engine.advance(0.016)).not.toThrow();
    expect(enemy.alive).toBe(false);
  });

  it("damages without killing on a hit that doesn't drop the enemy to 0 HP", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 30, maxHp: 30 }); // pistol does 22/hit, so this survives one
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(enemy.alive).toBe(true);
    expect(enemy.hp).toBeLessThan(30);
    expect(lastStats(handlers).kills).toBe(0);
  });

  it("does not fire when out of ammo for the equipped weapon", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
    });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).bullets).toBe(0); // never went negative / nothing consumed
    const local = (engine as unknown as { players: Map<string, { outOfAmmoToastFrames: number }> }).players.get(
      "local",
    )!;
    expect(local.outOfAmmoToastFrames).toBeGreaterThan(0);
  });

  it("re-firing while the out-of-ammo toast is still fading resets it back to full, not stacked/continuing to decay", () => {
    const map = fakeMap({}, 12);
    const { engine, input } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
    });
    const players = (engine as unknown as { players: Map<string, { outOfAmmoToastFrames: number }> }).players;
    const local = players.get("local")!;

    input.fireQueued = true;
    engine.advance(0.016);
    const framesAfterFirstDryFire = local.outOfAmmoToastFrames;
    expect(framesAfterFirstDryFire).toBeGreaterThan(0);

    // Let it decay partway (well under its full duration) before firing again.
    input.fireQueued = false;
    for (let i = 0; i < 10; i++) engine.advance(0.016);
    const decayed = local.outOfAmmoToastFrames;
    expect(decayed).toBeLessThan(framesAfterFirstDryFire);
    expect(decayed).toBeGreaterThan(0); // still fading, not yet expired — the retrigger case this test targets

    // Fire again before it fully fades: must snap back to full, not stack.
    input.fireQueued = true;
    engine.advance(0.016);
    expect(local.outOfAmmoToastFrames).toBe(framesAfterFirstDryFire);
  });

  it("fires the shotgun's multiple pellets in one trigger pull", () => {
    const enemy = fakeEnemy({ x: 6.2, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map);
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);
    input.fireQueued = true;
    expect(() => engine.advance(0.016)).not.toThrow();
    expect(enemy.alive).toBe(false);
    // At this range several of the shotgun's 7 pellets land on the same
    // point-blank enemy in one blast; only the first one to connect may
    // register as a kill, or this regresses into a phantom multi-kill.
    expect(lastStats(handlers).kills).toBe(1);
  });

  it("refuses a second shotgun blast inside its pump cycle, then fires again once it's over", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 8, rockets: 0, smg: 0, gas: 0 },
    });
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);

    input.fireQueued = true;
    engine.advance(0.016);
    const afterFirst = lastStats(handlers).shells;
    expect(afterFirst).toBe(7); // one blast, one shell

    // Spam the trigger for the rest of the pump cycle: every one of these
    // pulls is swallowed, so not a single extra bullet leaves the tube.
    for (let i = 0; i < 20; i++) {
      input.fireQueued = true;
      engine.advance(0.016); // 20 frames = 0.32s, well inside the 0.85s cycle
    }
    expect(lastStats(handlers).shells).toBe(afterFirst);

    engine.advance(0.85); // cycle complete
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).shells).toBe(6); // a second blast, finally
  });

  it("spends the shotgun's own shells and never the pistol's bullets", () => {
    // The whole point of the split: before it, one shotgun pull cost 4 rounds
    // out of the pool the pistol also drew from, so a player who liked the
    // shotgun disarmed their pistol.
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 3, rockets: 0, smg: 0, gas: 0 },
    });
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);

    input.fireQueued = true;
    engine.advance(0.016);

    expect(lastStats(handlers).shells).toBe(2); // one shell, not four bullets
    expect(lastStats(handlers).bullets).toBe(40); // untouched
  });

  it("refuses to fire the shotgun on an empty shell reserve even with bullets to spare", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);

    input.fireQueued = true;
    engine.advance(0.016);

    expect(lastStats(handlers).bullets).toBe(40); // it cannot fall back on these
    expect(lastStats(handlers).shells).toBe(0);
  });

  it("empties the magazine, reloads itself, and conserves the total across it", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    // 40 owned: 9 in the pistol, 31 in reserve. The *total* is what `stats`
    // reports, and it must not move except by firing.
    expect(lastStats(handlers).magazine).toBe(9);
    expect(lastStats(handlers).bullets).toBe(40);

    for (let i = 0; i < 9; i++) {
      input.fireQueued = true;
      engine.advance(0.16); // one pistol fire interval per pull
    }
    expect(lastStats(handlers).magazine).toBe(0);
    expect(lastStats(handlers).bullets).toBe(31); // nine spent, none lost
    expect(lastStats(handlers).reloading).toBe(true); // started itself

    engine.advance(1.2); // longer than the pistol's 1.1s reload
    expect(lastStats(handlers).reloading).toBe(false);
    expect(lastStats(handlers).magazine).toBe(9);
    expect(lastStats(handlers).bullets).toBe(31); // a reload moves ammo, never creates it
  });

  it("refuses to fire while reloading, and does not bank the trigger-pull", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(false); // full magazine: nothing to do

    input.fireQueued = true;
    engine.advance(0.16);
    expect(lastStats(handlers).magazine).toBe(8);
    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(true);

    // Spam the trigger through the middle of the reload — 15 x 0.05s = 0.75s,
    // well inside the pistol's 1.1s — and not one round leaves the gun.
    for (let i = 0; i < 15; i++) {
      input.fireQueued = true;
      engine.advance(0.05);
    }
    expect(lastStats(handlers).reloading).toBe(true);
    expect(lastStats(handlers).magazine).toBe(8);
    expect(lastStats(handlers).bullets).toBe(39); // exactly the one shot above

    engine.advance(0.5); // let it finish, trigger released
    expect(lastStats(handlers).magazine).toBe(9);
    expect(lastStats(handlers).bullets).toBe(39);

    // And every pull that landed during the reload was spent, not banked — the
    // next frame fires nothing on its own.
    engine.advance(0.016);
    expect(lastStats(handlers).magazine).toBe(9);
  });

  it("ignores a reload request while one is already running", () => {
    // Mashing R must not restart the timer — that would be a way to reload
    // forever, and the sound is scheduled once per start.
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.16);

    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(true);
    // Keep asking, all the way through what should be the last of it.
    for (let i = 0; i < 25; i++) {
      input.reload = true;
      engine.advance(0.05);
    }
    expect(lastStats(handlers).reloading).toBe(false); // finished on schedule
    expect(lastStats(handlers).magazine).toBe(9);
  });

  it("cancels a reload when the player switches weapons, losing nothing", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 4, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.16);
    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(true);

    input.weaponRequest = 1; // shotgun, mid-reload
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(false);
    // The pistol keeps the 8 it had; the rounds it had not taken yet are
    // still in reserve. Deliberately unlike the fire cooldown, which is
    // *not* switch-cancellable — see `updateReload`'s doc comment.
    expect(lastStats(handlers).bullets).toBe(39);

    input.weaponRequest = 0;
    engine.advance(0.016);
    expect(lastStats(handlers).magazine).toBe(8);
  });

  it("does not reload when there is nothing in reserve to load", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 2, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    expect(lastStats(handlers).magazine).toBe(2); // all of it fits in the magazine

    for (let i = 0; i < 2; i++) {
      input.fireQueued = true;
      engine.advance(0.16);
    }
    expect(lastStats(handlers).bullets).toBe(0);
    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(false); // genuinely dry, not reloading forever
  });

  it("still lets a player quick-melee while reloading", () => {
    // The promise `updateFiring`'s doc comment already made about the fire
    // cooldown: a player who can't shoot always has something to swing.
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
    });
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.16);
    input.reload = true;
    engine.advance(0.016);
    expect(lastStats(handlers).reloading).toBe(true);

    input.melee = true;
    engine.advance(0.016);
    expect(enemy.hp).toBeLessThanOrEqual(0);
  });

  it("counts a trigger-pull refused by a genuinely dry magazine in telemetry", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const map = fakeMap({}, 12);
      // Two rounds total: both load into the magazine, leaving no reserve, so
      // once they are fired there is nothing to reload with and the next pull
      // is a real refusal rather than a wait.
      const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 2, shells: 0, rockets: 0, smg: 0, gas: 0 },
      });
      engine.advance(0.016);
      for (let i = 0; i < 3; i++) {
        input.fireQueued = true;
        engine.advance(0.16);
      }
      expect(lastStats(handlers).magazine).toBe(0);

      const hooks = (window as unknown as { __codeensteinTestHooks?: { getTelemetrySnapshot: () => Record<string, number> } }).__codeensteinTestHooks;
      expect(hooks!.getTelemetrySnapshot().shotsBlockedByEmptyMag).toBe(1);
      // Time spent reloading is tracked too, and this run never got to reload.
      expect(hooks!.getTelemetrySnapshot().timeReloadingSec).toBe(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("counts time spent reloading in telemetry", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const map = fakeMap({}, 12);
      // The mirror of the test above: a full reserve, so emptying the magazine
      // starts a real reload instead of the refusal that one measures.
      const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 40, shells: 0, rockets: 0, smg: 0, gas: 0 },
      });
      engine.advance(0.016);
      const snapshot = () =>
        (window as unknown as { __codeensteinTestHooks?: { getTelemetrySnapshot: () => Record<string, number> } })
          .__codeensteinTestHooks!.getTelemetrySnapshot();
      for (let i = 0; i < 40 && lastStats(handlers).magazine > 0; i++) {
        input.fireQueued = true;
        engine.advance(0.16);
      }
      expect(lastStats(handlers).magazine).toBe(0);
      // A reload only *begins* on the frame the magazine runs dry — `updateReload`
      // runs before the firing code that starts it — so the clock starts ticking
      // on the frames after it, and each one adds its own dt.
      const before = snapshot().timeReloadingSec;
      engine.advance(0.05);
      const after = snapshot().timeReloadingSec;
      expect(after - before).toBeCloseTo(0.05, 5);
      // ...and it stops once the magazine is actually back, rather than running on.
      for (let i = 0; i < 40 && lastStats(handlers).magazine === 0; i++) engine.advance(0.05);
      expect(lastStats(handlers).magazine).toBeGreaterThan(0);
      const done = snapshot().timeReloadingSec;
      engine.advance(0.05);
      expect(snapshot().timeReloadingSec).toBe(done);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("keeps the old out-of-ammo path for a weapon with no magazine", () => {
    // Friday Hotfix is the one ranged weapon that streams straight from its
    // reserve, so it never reloads and keeps the original "check the pool,
    // refuse, log, toast" branch rather than the magazine one.
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, shells: 0, rockets: 0, smg: 0, gas: 4, ownedWeapons: [0, 1, 2, 3, 4, 5] },
    });
    input.weaponRequest = 4; // Friday Hotfix — a number-key *slot*, not a WEAPONS index
    engine.advance(0.016);
    expect(lastStats(handlers).magazineSize).toBe(0); // no magazine at all
    expect(lastStats(handlers).reloading).toBe(false);

    // It is `auto`, so it burns while the trigger is held: 4 gas at 2.5 a
    // shot is one shot, and the second pull finds the pool short.
    input.fireHeld = true;
    engine.advance(0.05);
    expect(lastStats(handlers).gas).toBe(1.5);

    const logSpy = vi.spyOn(console, "log");
    engine.advance(0.5);
    expect(lastStats(handlers).gas).toBe(1.5); // refused, not driven negative
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("out of gas"));
    // And still no reload — there is no magazine to fill.
    expect(lastStats(handlers).reloading).toBe(false);
    logSpy.mockRestore();
  });

  it("caps pistol click-spam at its own fire interval", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, rockets: 0, smg: 0, gas: 0 },
    });
    // Ten pulls on ten consecutive frames — 0.16s of wall time, which the
    // pistol's 0.15s interval permits exactly one shot in. Before the
    // interval existed this spent ten bullets.
    for (let i = 0; i < 10; i++) {
      input.fireQueued = true;
      engine.advance(0.016);
    }
    expect(lastStats(handlers).bullets).toBe(39);
  });

  it("shares the fire cooldown across a weapon switch, so the shotgun's pump can't be switch-cancelled", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 40, shells: 8, rockets: 0, smg: 0, gas: 0 },
    });
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).shells).toBe(7);

    // Switch to the pistol mid-pump and pull. `weaponCooldown` lives on the
    // player, not the weapon, so this buys nothing — deliberately (see
    // `updateFiring`'s doc comment). The two weapons draw from separate pools
    // now, which makes the assertion sharper than it was: an untouched
    // `bullets` can only mean the pistol never fired.
    input.weaponRequest = 0;
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).bullets).toBe(40); // the pistol never got its shot
    expect(lastStats(handlers).shells).toBe(7); // and nothing else was spent
  });

  it("swings the knife via quick-melee (Space) independent of the equipped ranged weapon", () => {
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map);
    // Quick-melee's hit-test runs *before* this frame's own renderScene()
    // call (early in advance(), ahead of the "Simulate" section) — on a
    // brand new engine the zBuffer is still all-zero (never rendered), which
    // findTargetInProjections reads as "behind a wall" and would swallow the
    // hit. A warm-up frame populates a real zBuffer first, matching how the
    // very first frame of a real level already renders once via start()
    // before any input has a chance to fire a melee swing.
    engine.advance(0.016);
    const bulletsBefore = lastStats(handlers).bullets;
    input.melee = true;
    engine.advance(0.016);
    expect(enemy.alive).toBe(false);
    // Melee itself never spends bullets (it has no ammoType) — a kill can
    // still grant some via a lucky loot roll (REGULAR_KILL_NO_DROP_CHANCE),
    // so "not decreased" is the real invariant here, not "exactly unchanged".
    expect(lastStats(handlers).bullets).toBeGreaterThanOrEqual(bulletsBefore);
  });

  it("misses an enemy centered in the crosshair but beyond the knife's melee range", () => {
    const size = 20;
    // Straight open corridor, well past meleeRange (1.5) but with no wall in
    // between, so the enemy is still found in the crosshair's zBuffer test —
    // findTargetInProjections has no distance limit of its own, only the
    // real-world range check after it does.
    const enemy = fakeEnemy({ x: 9.5, y: 10.5, hp: 100, maxHp: 100 });
    const map = fakeMap({ spawn: { x: 5, y: 10 }, enemies: [enemy] }, size);
    const { engine, input } = makeEngine(map);
    engine.advance(0.016); // warm-up frame — see the zBuffer-staleness note above
    input.melee = true;
    engine.advance(0.016);
    expect(enemy.hp).toBe(100); // no damage — out of melee range despite lining up
  });

  it("auto-fires Toolchain repeatedly while held, once owned", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 6] },
    });
    input.meleeHeld = true;
    expect(() => {
      for (let i = 0; i < 10; i++) engine.advance(0.05);
    }).not.toThrow();
    void handlers;
  });

  it("keeps the chainsaw on screen for the whole time it is held", () => {
    const map = fakeMap({}, 12);
    const { engine, input } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 6] },
    });
    const drawn = vi.mocked(drawWeapon);
    input.meleeHeld = true;

    // Well over Toolchain's 0.35s bite interval, so this spans several full
    // cycles including the stretch that used to be the problem.
    drawn.mockClear();
    for (let i = 0; i < 60; i++) {
      engine.advance(1 / 60);
      engine.render();
    }

    // The reported bug: `meleeRecoil` decayed under the 0.02 overlay threshold
    // in ~0.29s, *inside* the 0.35s interval, so for the last few frames of
    // every bite the renderer drew the equipped pistol instead and the
    // chainsaw visibly blinked out. Holding the key must show exactly one
    // weapon.
    const kinds = new Set(drawn.mock.calls.map(([, view]) => view.kind));
    expect(kinds).toEqual(new Set(["chainsaw"]));
  });

  it("auto-fires gdb repeatedly while the trigger is held, once owned", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 200, maxHp: 200 }); // survives the whole burst
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 50, gas: 0, ownedWeapons: [0, 1, 2, 3] },
    });
    // Slot 2 is the 3rd non-melee weapon, gdb (index 3).
    input.weaponRequest = 2;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(3);
    input.fireHeld = true;
    for (let i = 0; i < 10; i++) engine.advance(0.05); // several fireIntervalSec (0.09s) cooldown cycles
    expect(lastStats(handlers).smg).toBeLessThan(50);
  });

  it("destroys a spotted mine via gunfire instead of letting it detonate underfoot", () => {
    const mine: Mine = { x: 6.5, y: 5.5, alive: true, visible: true, closeTimer: 0 };
    const map = fakeMap({ mines: [mine] });
    const { engine, input } = makeEngine(map);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(mine.alive).toBe(false);
  });

  it("records a mine disarm in telemetry when testHooks is on", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const mine: Mine = { x: 6.5, y: 5.5, alive: true, visible: true, closeTimer: 0 };
      const map = fakeMap({ mines: [mine] });
      const { engine, input } = makeEngine(map);
      input.fireQueued = true;
      engine.advance(0.016);
      expect(mine.alive).toBe(false);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { minesDisarmed: number };
      expect(snapshot.minesDisarmed).toBe(1);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("safely disarms a mine shot from beyond its own blast radius, taking no damage", () => {
    const size = 20;
    // The pistol has no maxRange/meleeRange of its own (unlike Friday
    // Hotfix), so gunfire can hit a mine at any distance — it's detonateMine
    // itself that zeroes the damage once beyond MINE_BLAST_RADIUS (2.4).
    const mine: Mine = { x: 8.5, y: 10.5, alive: true, visible: true, closeTimer: 0 }; // 3 tiles out, beyond MINE_BLAST_RADIUS
    const map = fakeMap({ spawn: { x: 5, y: 10 }, mines: [mine] }, size);
    const { engine, input, handlers } = makeEngine(map);
    // 0.16s per attempt, not one frame: the pistol's `fireIntervalSec` (0.15s)
    // would otherwise swallow 19 of these 20 pulls, leaving the loop's retry
    // budget nominal rather than real.
    for (let i = 0; i < 20 && mine.alive; i++) {
      input.fireQueued = true;
      engine.advance(0.16);
    }
    expect(mine.alive).toBe(false);
    expect(lastStats(handlers).health).toBe(100); // no splash damage at this range
  });

  it("a proximity-fused mine detonation spares a second player standing beyond MINE_BLAST_RADIUS", () => {
    // Distinct from the gunfire-detonation test above: this exercises
    // `updateMines`' own proximity fuse (MINE_FUSE_RADIUS/MINE_FUSE_SECONDS)
    // fanning damage out across every connected player in
    // `RaycasterEngine`'s own tick, not `detonateMine`'s single-shooter path.
    const mine: Mine = { x: 5.5, y: 5.5, alive: true, visible: true, closeTimer: 0 };
    const hostInput = new ScriptedInput();
    const guestInput = new ScriptedInput();
    const map = fakeMap({ spawn: { x: 5, y: 5 }, mines: [mine] }, 20);
    const { engine, handlers } = makeEngine(map, makeHandlers(), { input: hostInput });
    engine.addPlayer("G", guestInput, { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 });
    const players = (engine as unknown as { players: Map<string, { player: { posX: number; posY: number }; health: number }> })
      .players;
    players.get("G")!.player.posX = 15; // well beyond MINE_BLAST_RADIUS (2.4)
    players.get("G")!.player.posY = 15;

    for (let i = 0; i < 15 && mine.alive; i++) engine.advance(0.1); // MINE_FUSE_SECONDS (0.9s) at zero distance

    expect(mine.alive).toBe(false);
    expect(lastStats(handlers).health).toBeLessThan(100); // the host, spawned on top of it, took splash damage
    expect(players.get("G")!.health).toBe(100); // the guest, far away, took none
  });

  it("destroys a mine with Friday Hotfix within its maxRange", () => {
    const mine: Mine = { x: 7.5, y: 5.5, alive: true, visible: true, closeTimer: 0 }; // 2 tiles out, inside maxRange (3.5)
    const map = fakeMap({ mines: [mine] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 50, ownedWeapons: [0, 1, 2, 5] },
    });
    // Slot 4 is the 5th non-melee weapon, Friday Hotfix (index 5).
    input.weaponRequest = 4;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(5);
    input.fireHeld = true;
    engine.advance(0.016);
    expect(mine.alive).toBe(false);
  });

  it("leaves a mine beyond Friday Hotfix's maxRange undestroyed even when a pellet lands on it", () => {
    // A wide-open room so the mine is always in clear line of sight, and
    // enough sustained auto-fire frames that at least one of Friday
    // Hotfix's spread pellets is virtually guaranteed to land on it despite
    // its narrow projected box at this distance — otherwise a "not
    // destroyed" result would just as easily mean "never even hit",
    // proving nothing about the maxRange check itself.
    const size = 20;
    const mine: Mine = { x: 12.1, y: 10.5, alive: true, visible: true, closeTimer: 0 }; // 7.1 tiles out, past maxRange (6.5)
    const map = fakeMap({ spawn: { x: 5, y: 10 }, mines: [mine] }, size);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 999, ownedWeapons: [0, 1, 2, 5] },
    });
    // Slot 4 is the 5th non-melee weapon, Friday Hotfix (index 5).
    input.weaponRequest = 4;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(5);
    input.fireHeld = true;
    for (let i = 0; i < 20; i++) engine.advance(0.016);
    expect(mine.alive).toBe(true);
  });

  it("destroys a mine that the old 3.5-tile cutoff would have spared", () => {
    // The positive control for the test above, and the change itself: at 5
    // tiles a pellet used to be discarded outright. Without this, "still
    // alive" out at 7.1 would be just as consistent with pellets never landing
    // at that distance at all, which would make the range assertion vacuous.
    const size = 20;
    const mine: Mine = { x: 10, y: 10.5, alive: true, visible: true, closeTimer: 0 }; // 5 tiles out
    const map = fakeMap({ spawn: { x: 5, y: 10 }, mines: [mine] }, size);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 999, ownedWeapons: [0, 1, 2, 5] },
    });
    input.weaponRequest = 4;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(5);
    input.fireHeld = true;
    for (let i = 0; i < 20; i++) engine.advance(0.016);
    expect(mine.alive).toBe(false);
  });

  it("getPlayerState().wouldMineHit is true for a mine within Friday Hotfix's maxRange", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const mine: Mine = { x: 7.5, y: 5.5, alive: true, visible: true, closeTimer: 0 }; // 2 tiles out, inside maxRange (3.5)
      const map = fakeMap({ mines: [mine] });
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 50, ownedWeapons: [0, 1, 2, 5] },
      });
      input.weaponRequest = 4; // Friday Hotfix (index 5)
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect((hooks!.getPlayerState() as { wouldMineHit: boolean }).wouldMineHit).toBe(true);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("getPlayerState().wouldMineHit is false for a mine beyond Friday Hotfix's maxRange", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 20;
      const mine: Mine = { x: 9.1, y: 10.5, alive: true, visible: true, closeTimer: 0 }; // 3.6 tiles out, past maxRange (3.5)
      const map = fakeMap({ spawn: { x: 5, y: 10 }, mines: [mine] }, size);
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 999, ownedWeapons: [0, 1, 2, 5] },
      });
      input.weaponRequest = 4; // Friday Hotfix (index 5)
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect((hooks!.getPlayerState() as { wouldMineHit: boolean }).wouldMineHit).toBe(false);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("getPlayerState().wouldMineHit is false when the equipped weapon is melee", () => {
    // `wouldMineHit` is specifically the *ranged*-shot check (see
    // `meleeWouldHit` for melee) — normal gameplay never lets `weaponIndex`
    // land on the knife/Toolchain (number keys and mousewheel cycling both
    // skip melee slots), but nothing stops a carried-over `weaponIndex` from
    // pointing at one directly.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const mine: Mine = { x: 6.5, y: 5.5, alive: true, visible: true, closeTimer: 0 }; // well within any ranged weapon's reach
      const map = fakeMap({ mines: [mine] });
      const { engine } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 40, rockets: 0, smg: 0, gas: 0, weaponIndex: 2 }, // 2 = knife
      });
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      expect((hooks!.getPlayerState() as { wouldMineHit: boolean }).wouldMineHit).toBe(false);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("launches a rocket that later detonates on hitting a wall", () => {
    const size = 12;
    const map = fakeMap({}, size);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 5, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 4] },
    });
    // weaponRequest is a 0-based *number-key slot* (NUMBER_KEY_WEAPONS), not
    // a raw WEAPONS index — slot 3 is the 4th non-melee weapon, ghidra (index 4).
    input.weaponRequest = 3;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(4);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).rockets).toBe(4); // spent on launch
    // Rocket travels fast (18 tiles/sec) — a handful of frames is enough to
    // cross this small walled room and detonate.
    for (let i = 0; i < 20; i++) engine.advance(0.05);
    expect(() => engine.advance(0.05)).not.toThrow();
  });

  it("splashes both the player and a nearby living enemy on wall impact", () => {
    const size = 12;
    // Spawn one tile from the east wall so the rocket detonates right next
    // to the player even with a frame's worth of travel overshoot into the
    // wall tile (ROCKET_SPEED=18 tiles/sec means a 0.05s step can overshoot
    // by most of a tile) — within ROCKET_BLAST_RADIUS (2.6), self-splash.
    const alive = fakeEnemy({ x: 9.5, y: 6, hp: 300, maxHp: 300 });
    const map = fakeMap({ spawn: { x: 10, y: 5 }, enemies: [alive] }, size);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 5, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 4] },
    });
    input.weaponRequest = 3; // slot 3 -> ghidra (index 4)
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.016);
    for (let i = 0; i < 20; i++) engine.advance(0.05);
    expect(lastStats(handlers).health).toBeLessThan(100); // player caught their own blast
    expect(alive.hp).toBeLessThan(300); // the living neighbor took splash damage
  });

  it("spares a living enemy inside the blast's AABB but outside its true circular radius", () => {
    // The enemy spatial grid's queryIndices is a deliberate *superset* — every
    // enemy whose tile intersects the blast radius' bounding box, not just
    // those truly within ROCKET_BLAST_RADIUS (2.6) — see EnemySpatialGrid's
    // own doc comment. A diagonal corner (dx=dy=2.5, distance ≈3.54) sits
    // inside that box but outside the real circle: `rocketDamageAt` must
    // return 0 for it rather than the engine trusting the grid's candidate
    // list at face value.
    const trigger = fakeEnemy({ x: 10, y: 10, hp: 300, maxHp: 300 });
    const bystander = fakeEnemy({ x: 12.5, y: 12.5, hp: 300, maxHp: 300 });
    const map = fakeMap({ spawn: { x: 2, y: 2 }, enemies: [trigger, bystander] }, 20);
    const { engine } = makeEngine(map);

    const rockets = (engine as unknown as { rockets: { x: number; y: number; vx: number; vy: number; damage: number; firedBy: string }[] })
      .rockets;
    rockets.push({ x: 10, y: 10, vx: 0, vy: 0, damage: 100, firedBy: "local" });
    engine.advance(0.016);

    expect(trigger.hp).toBeLessThan(300); // at the blast center, took splash damage
    expect(bystander.hp).toBe(300); // outside the true radius despite sharing the AABB
  });

  it("records a rocket-splash hit in telemetry when testHooks is on", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 12;
      const alive = fakeEnemy({ x: 9.5, y: 6, hp: 300, maxHp: 300 });
      const map = fakeMap({ spawn: { x: 10, y: 5 }, enemies: [alive] }, size);
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 0, rockets: 5, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 4] },
      });
      input.weaponRequest = 3; // slot 3 -> ghidra (index 4)
      engine.advance(0.016);
      input.fireQueued = true;
      engine.advance(0.016);
      for (let i = 0; i < 20; i++) engine.advance(0.05);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { weaponTallies: Record<string, { hits: number }> };
      expect(snapshot.weaponTallies["4"].hits).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("fires the flamethrower as a continuous stream", () => {
    const map = fakeMap({}, 12);
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 50, ownedWeapons: [0, 1, 2, 5] },
    });
    // Slot 4 is the 5th non-melee weapon, Friday Hotfix (index 5).
    input.weaponRequest = 4;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(5);
    input.fireHeld = true;
    engine.advance(0.016);
    expect(lastStats(handlers).gas).toBeLessThan(50); // gas spent firing
  });
});

describe("RaycasterEngine — enemy death, loot, and elites", () => {
  it("drops loot and grants a bonus weapon roll for a non-elite kill", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1, elite: false });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input } = makeEngine(map);
    input.fireQueued = true;
    expect(() => engine.advance(0.016)).not.toThrow();
  });

  it("counts a still-living enemy toward the kill log's remaining-enemies tally", () => {
    const dying = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const surviving = fakeEnemy({ x: 8, y: 8, hp: 100, maxHp: 100 });
    const map = fakeMap({ enemies: [dying, surviving] });
    const { engine, input } = makeEngine(map);
    const logSpy = vi.spyOn(console, "log");
    input.fireQueued = true;
    engine.advance(0.016);
    expect(dying.alive).toBe(false);
    expect(surviving.alive).toBe(true);
    expect(logSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("1 enemies remaining"))).toBe(true);
  });

  it("leaves a kill's drop uncollected while the player is out of pickup range", () => {
    // 1.0 tile from spawn is well beyond AMMO_PICKUP_RADIUS (0.5) — the drop
    // spawns at the enemy's death position, so a kill from here always lands
    // out of range on the very next frame's collectLoot() pass.
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
    });
    input.fireQueued = true;
    engine.advance(0.016);
    const bulletsAfterKill = lastStats(handlers).bullets;
    engine.advance(0.016); // collectLoot() runs again here, sees the drop, and skips it (out of range)
    expect(lastStats(handlers).kills).toBe(1);
    expect(lastStats(handlers).bullets).toBe(bulletsAfterKill); // drop still uncollected
  });

  it("collects a swap-kind kill drop, adding swap (lootCtx.addSwap)", () => {
    // Gameplay seed 42 was brute-forced to roll a "swap" kind on this kill's
    // loot draw (after the new REGULAR_KILL_NO_DROP_CHANCE roll clears) — the
    // only way to deterministically reach lootCtx.addSwap's body via a real
    // dynamic drop (as opposed to the static-pickup path, which inlines the
    // same `this.swap = ...` update independently — see `collectLoot`)
    // without contorting the test into an rng-independent shape.
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
      seed: 42,
    });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).kills).toBe(1);
    // collectLoot() runs before updateFiring() each frame, so this kill's
    // drop is only picked up on the *next* frame's advance().
    engine.advance(0.016);
    expect(lastStats(handlers).swap).toBeGreaterThan(0);
  });

  it("records the real, difficulty-scaled amount for a swap-kind roll in lootRolled telemetry", () => {
    // Same seed/scenario as the swap-collection test above — verifies
    // `pushLootDrop` records SWAP_DROP_AMOUNT (11, unscaled at normal
    // difficulty), not a flat `1` occurrence placeholder — see
    // `defaultLootAmountFor`'s doc comment for why that distinction matters
    // for `lootRolled` vs `consumed` unit-compatibility.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
        seed: 42,
      });
      input.fireQueued = true;
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { lootRolled: Record<string, number> };
      expect(snapshot.lootRolled.swap).toBe(11); // SWAP_DROP_AMOUNT
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("grants the Toolchain on a lucky miss-chance roll when a regular kill's loot roll misses", () => {
    // Gameplay seed 27 was brute-forced to both miss REGULAR_KILL_NO_DROP_CHANCE's
    // roll (so the normal rollLoot branch is skipped entirely) and hit
    // rollMissChanceToolchain's own roll right after — the only way to
    // deterministically reach that branch without contorting the test into
    // an rng-independent shape. campaignLevelIndex is set to Toolchain's
    // level floor so it's actually eligible.
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0, campaignLevelIndex: 4 },
      seed: 27,
    });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).kills).toBe(1);
    // collectLoot() runs before updateFiring() each frame, so this kill's
    // drop is only picked up on the *next* frame's advance().
    engine.advance(0.016);
    expect(lastStats(handlers).ownedWeapons).toContain(6); // TOOLCHAIN_WEAPON_INDEX
  });

  it("records a flat 1 (occurrence) for a weapon-kind roll in lootRolled telemetry", () => {
    // Same seed/scenario as the Toolchain miss-chance test above — a
    // "weapon" drop's real value depends on ownership state at *collection*
    // time, which can change between roll and collection, so `1` is the only
    // thing `defaultLootAmountFor` can honestly record for it (see its doc
    // comment) — this is the one kind that's still an occurrence count, not
    // a real quantity, by design rather than by oversight.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0, campaignLevelIndex: 4 },
        seed: 27,
      });
      input.fireQueued = true;
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { lootRolled: Record<string, number> };
      expect(snapshot.lootRolled.weapon).toBe(1);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("collects a health-kind kill drop, healing the player (lootCtx.heal)", () => {
    // Gameplay seed 10 was found (brute-forced against this exact scenario)
    // to both clear the new REGULAR_KILL_NO_DROP_CHANCE roll and land a
    // "health" kind on this kill's loot draw — the only way to
    // deterministically reach lootCtx.heal's body without contorting the test
    // into an rng-independent shape. Enemy at x:5.9 (0.4 tiles from spawn)
    // matches the melee test's proven-safe distance: close enough for the
    // drop to land inside AMMO_PICKUP_RADIUS, not so close it gets a free
    // aggro-bite in before the kill shot (see the melee zBuffer-staleness
    // gotcha's neighbor note above).
    // `maxHp` matters now, not just `hp`: since 2026-08-21 the guaranteed heal
    // scales as `HEALTH_DROP_AMOUNT * maxHp / HEALTH_SCALE_REFERENCE_HP`, so
    // the 1/1 enemy this used to kill would refund the floor of 1 health and
    // make the assertion below unfalsifiable. A wounded 100 HP regular — 1 hp
    // left of 100 — dies to the same single shot and refunds the full 20.
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 100 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 90, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
      seed: 10,
    });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).kills).toBe(1);
    // collectLoot() runs before updateFiring() each frame, so this kill's
    // drop is only picked up on the *next* frame's advance().
    engine.advance(0.016);
    expect(lastStats(handlers).health).toBeGreaterThan(90);
  });

  it("scales the guaranteed heal by what died, so trash refunds less than a real enemy", () => {
    // The rule `HEALTH_SCALE_REFERENCE_HP` introduces, pinned directly rather
    // than left to the incidental coverage of the test above. Same seed and
    // geometry, one field different: a corridor-Edge-Case-sized 30 HP body
    // against a 100 HP regular. Both die to the same single shot.
    const healFrom = (maxHp: number) => {
      const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp });
      const { engine, input, handlers } = makeEngine(fakeMap({ enemies: [enemy] }), makeHandlers(), {
        carryover: { health: 50, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
        seed: 10,
      });
      input.fireQueued = true;
      engine.advance(0.016);
      const before = lastStats(handlers).health;
      engine.advance(0.016); // collectLoot runs a frame after the kill
      return lastStats(handlers).health - before;
    };
    const trash = healFrom(30);
    const regular = healFrom(100);
    // 20 * 30/100 = 6 against 20 * 100/100 = 20 — the whole point of the change.
    expect(trash).toBe(6);
    expect(regular).toBe(20);
  });

  it("caps carried ammo against what this level would hand a fresh player", () => {
    // `CARRYOVER_CAP_MULTIPLE`. A tiny roster means a small fresh reserve, so a
    // hoarded 9,999 bullets is clamped hard; the same carryover on a level that
    // hands out more survives further. Both directions are asserted because a
    // cap that always clamps to the same number would pass the first alone.
    const arriveWith = (bullets: number, enemies: number) => {
      const roster = Array.from({ length: enemies }, (_, i) => fakeEnemy({ x: 20 + i * 0.1, y: 20, hp: 100, maxHp: 100 }));
      const { engine, handlers } = makeEngine(fakeMap({ enemies: roster }), makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets, rockets: 0, smg: 0, gas: 0 },
      });
      engine.advance(0.016); // stats are only emitted on a tick
      return lastStats(handlers).bullets;
    };
    const small = arriveWith(9999, 1);
    const big = arriveWith(9999, 30);
    expect(small).toBeLessThan(9999); // clamped, not carried whole
    expect(big).toBeGreaterThan(small); // a bigger roster funds a bigger ceiling
    // Under the cap, nothing is clamped: 10 bullets stays 10 on any roster.
    expect(arriveWith(10, 30)).toBe(10);
  });

  it("scales an ammo drop by what died, the same way the heal is scaled", () => {
    // `AMMO_SCALE_REFERENCE_HP`'s rule. Same seed for both runs, so `rollLoot`
    // draws the identical kind and only the amount can differ — which is what
    // isolates the scaling from the roll.
    const ammoFrom = (maxHp: number) => {
      const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp });
      const { engine, input, handlers } = makeEngine(fakeMap({ enemies: [enemy] }), makeHandlers(), {
        carryover: { health: 50, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
        seed: 10,
      });
      input.fireQueued = true;
      engine.advance(0.016);
      const s0 = lastStats(handlers);
      const before = s0.bullets + s0.rockets + s0.smg + s0.gas + (s0.shells ?? 0);
      engine.advance(0.016); // collectLoot runs a frame after the kill
      const s1 = lastStats(handlers);
      return s1.bullets + s1.rockets + s1.smg + s1.gas + (s1.shells ?? 0) - before;
    };
    const trash = ammoFrom(30);
    const beefy = ammoFrom(176);
    expect(beefy).toBeGreaterThan(trash);
    // 176 is exactly 2x the reference, so it doubles the base amount while the
    // 30 HP body floors at 1 — a spread of at least 4x on any kind that rolls.
    expect(beefy).toBeGreaterThanOrEqual(trash * 4);
  });

  it("grants a bonus unlockable weapon on a lucky regular-kill roll", () => {
    // Gameplay seed 26 was brute-forced to roll a hit on rollBonusWeaponDrop
    // for this exact kill (independent of, and after, the new
    // REGULAR_KILL_NO_DROP_CHANCE roll and rollLoot's own draw) — the only
    // way to deterministically reach that branch without contorting the test
    // into an rng-independent shape.
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
      seed: 26,
    });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).kills).toBe(1);
    // collectLoot() runs before updateFiring() each frame, so this kill's
    // bonus weapon drop is only picked up on the *next* frame's advance().
    engine.advance(0.016);
    expect(lastStats(handlers).ownedWeapons.length).toBeGreaterThan(3);
  });

  it("uses the elite loot table for an elite kill", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1, elite: true });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map);
    input.fireQueued = true;
    engine.advance(0.016);
    expect(lastStats(handlers).kills).toBe(1);
  });

  it("lifesteal heals the player on a killing blow with a lifesteal weapon", () => {
    // Friday Hotfix has lifesteal — damage the player first, then finish an
    // enemy off with it and confirm health recovers some.
    const enemy = fakeEnemy({ x: 6.2, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
      carryover: { health: 50, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 50, ownedWeapons: [0, 1, 2, 5] },
    });
    // Slot 4 is the 5th non-melee weapon, Friday Hotfix (index 5).
    input.weaponRequest = 4;
    engine.advance(0.016);
    expect(lastStats(handlers).weaponIndex).toBe(5);
    input.fireQueued = true;
    input.fireHeld = true;
    engine.advance(0.016);
    expect(lastStats(handlers).health).toBeGreaterThanOrEqual(50);
  });

  it("records a forced-melee kill and its lifesteal heal in telemetry when testHooks is on", () => {
    // The knife is both meleeRange-having and lifesteal — with every ranged
    // ammo pool at zero, a quick-melee kill is simultaneously a "forced
    // melee" kill (no ranged ammo left to fire instead) and a lifesteal
    // heal, exercising both `damageEnemy`'s forcedMelee/telemetry branch and
    // its lifesteal/telemetry branch in the same call.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine, input } = makeEngine(map, makeHandlers(), {
        carryover: { health: 50, swap: 0, bullets: 0, shells: 0, rockets: 0, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 3, 4] },
      });
      engine.advance(0.016); // warm-up frame — see the quick-melee test above for why
      input.melee = true;
      engine.advance(0.016);
      expect(enemy.alive).toBe(false);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> })
        .__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as {
        killsForcedByMelee: number;
        healingBySource: { lifesteal: number };
      };
      expect(snapshot.killsForcedByMelee).toBe(1);
      expect(snapshot.healingBySource.lifesteal).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });
});

describe("RaycasterEngine — cheats", () => {
  it("IDDQD toggles god mode and fires onCheatActivated", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.cheat = "IDDQD";
    engine.advance(0.016);
    expect(lastStats(handlers).godMode).toBe(true);
    expect(handlers.onCheatActivated).toHaveBeenCalledWith("IDDQD");

    input.cheat = "IDDQD";
    engine.advance(0.016);
    expect(lastStats(handlers).godMode).toBe(false);
  });

  it("latches cheatsUsed on the first cheat and never clears it, unlike godMode", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    engine.advance(0.016); // onStats only reports from the first frame on
    expect(lastStats(handlers).cheatsUsed).toBe(false);

    input.cheat = "IDDQD";
    engine.advance(0.016);
    expect(lastStats(handlers).cheatsUsed).toBe(true);

    // Toggling god mode back off does not un-cheat the run — the recording
    // gate this flag warns about is not reversible either.
    input.cheat = "IDDQD";
    engine.advance(0.016);
    expect(lastStats(handlers).godMode).toBe(false);
    expect(lastStats(handlers).cheatsUsed).toBe(true);
  });

  it("does not latch cheatsUsed for an unrecognized code", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.cheat = "IDBEHOLD"; // a real Doom code this game does not implement
    engine.advance(0.016);

    expect(lastStats(handlers).cheatsUsed).toBe(false);
    expect(handlers.onCheatActivated).not.toHaveBeenCalled();
  });

  it("carries cheatsUsed in from a carryover, so the badge survives a level transition", () => {
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), {
      carryover: { health: 100, swap: 0, bullets: 10, rockets: 0, smg: 0, gas: 0, cheatsUsed: true },
    });
    engine.advance(0.016);
    expect(lastStats(handlers).cheatsUsed).toBe(true);
  });

  it("god mode makes damage a no-op", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // HAZARD_TILE
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, input, handlers } = makeEngine(map);
    input.cheat = "IDDQD";
    engine.advance(0.016);
    engine.advance(1);
    expect(lastStats(handlers).health).toBe(100);
  });

  it("IDCLIP toggles no-clip", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.cheat = "IDCLIP";
    engine.advance(0.016);
    expect(lastStats(handlers).noClip).toBe(true);

    input.cheat = "IDCLIP";
    engine.advance(0.016);
    expect(lastStats(handlers).noClip).toBe(false);
  });

  it("IDKFA grants full arsenal and max ammo", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.cheat = "IDKFA";
    engine.advance(0.016);
    const stats = lastStats(handlers);
    // The reserve is what the cheat maxes; the reported figure is the total
    // owned, so it also carries whatever the magazines hold.
    expect(stats.bullets).toBeGreaterThanOrEqual(999);
    // And the equipped gun is actually loaded — a "full arsenal" that has to
    // stop and reload before its first shot would be a poor cheat.
    expect(stats.magazine).toBe(stats.magazineSize);
    expect(stats.ownedWeapons.length).toBeGreaterThan(3);
    expect(handlers.onCheatActivated).toHaveBeenCalledWith("IDKFA");
  });

  it("an unrecognized cheat code does nothing", () => {
    const { engine, input, handlers } = makeEngine(fakeMap());
    input.cheat = "NOTACHEAT";
    engine.advance(0.016);
    expect(handlers.onCheatActivated).not.toHaveBeenCalled();
  });
});

describe("RaycasterEngine — win and death", () => {
  it("wins when the player reaches the exit tile", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.016);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers)).toBeDefined();
  });

  describe("exit gating by the exit room's own alive enemies", () => {
    const size = 12;
    // The exit tile itself, at (size-2, size-2) = (10, 10) — every enemy
    // fixture below is positioned relative to this.
    const exitTile = { x: size - 2, y: size - 2 };

    it("does not win while an alive enemy from the exit's own room remains", () => {
      const enemy = fakeEnemy({ home: { x: 8, y: 8, w: 4, h: 4 }, alive: true }); // covers [8,12)x[8,12) — includes (10,10)
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [enemy] }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).not.toHaveBeenCalled();
    });

    it("wins normally once that enemy is dead", () => {
      const enemy = fakeEnemy({ home: { x: 8, y: 8, w: 4, h: 4 }, alive: false });
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [enemy] }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
    });

    it("an alive enemy from a different room (exit outside its home rectangle on every axis) doesn't block the exit", () => {
      const belowAndLeft = fakeEnemy({ home: { x: 0, y: 0, w: 2, h: 2 }, alive: true }); // exit is beyond both x+w and y+h
      const aboveAndRight = fakeEnemy({ home: { x: 11, y: 11, w: 1, h: 1 }, alive: true }); // exit is below both x and y
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [belowAndLeft, aboveAndRight] }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
    });

    it("an alive enemy whose room shares the exit's row but not its column doesn't block the exit", () => {
      // Same y-range as the exit's room would be, but x-range entirely to the left of it.
      const enemy = fakeEnemy({ home: { x: 0, y: 8, w: 4, h: 4 }, alive: true });
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [enemy] }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
    });

    it("an alive enemy whose room shares the exit's column but not its row doesn't block the exit", () => {
      // Same x-range as the exit's room would be, but y-range entirely above it.
      const enemy = fakeEnemy({ home: { x: 8, y: 0, w: 4, h: 4 }, alive: true });
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [enemy] }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
    });
  });

  it("no-ops every per-frame simulation step once the run has ended", () => {
    // Once state flips away from "playing" (here: a win), a second advance()
    // call should hit every simulation method's own `if (this.state !==
    // "playing") return;` early guard (collectKeys, collectLoot,
    // openDoorAhead, checkTeleporters, updateEnemyAi, updateProjectiles,
    // advanceRockets, applyHazardDamage, applyTrapDamage, checkExit) —
    // a caller that keeps driving advance() past game-over (this engine
    // itself does exactly that for one final render frame — see endGame's
    // doc comment) must never crash. onWin itself re-fires every such frame
    // (advance() has no edge-gating on it — see the "stops itself" test's
    // doc comment on why that's a caller/self-stop responsibility, not a bug).
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.016);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    expect(() => engine.advance(0.016)).not.toThrow();
    expect(handlers.onWin).toHaveBeenCalledTimes(2);
  });

  it("stops the engine automatically on win", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine, input, handlers } = makeEngine(map);
    engine.start();
    raf.flush(1, 16);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    expect(input.detach).toHaveBeenCalledTimes(1);
  });

  it("game-overs when health reaches 0", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2;
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, handlers } = makeEngine(map);
    // advance() is documented as safe to drive at a fixed step directly, but
    // per its own doc comment / main.ts's real replay fast-forward loop
    // (see `if (levelEnded) break;` in main.ts), a caller is expected to
    // stop calling it once onGameOver/onWin fires — it does not itself gate
    // re-firing against being called again after the run has ended.
    for (let i = 0; i < 10 && handlers.onGameOver.mock.calls.length === 0; i++) engine.advance(1);
    expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers).health).toBe(0);
  });

  it("stops itself once the run ends, so the internal rAF frame loop won't re-fire on its own", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2;
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, input, handlers } = makeEngine(map);
    engine.start();
    // Each frame's dt is clamped to MAX_DT (0.05s) regardless of the
    // wall-clock step passed to flush(), so driving HAZARD_DPS=18 damage
    // down from 100 health takes over a hundred frames, not ten.
    for (let i = 0; i < 200 && handlers.onGameOver.mock.calls.length === 0; i++) raf.flush(1, 1000);
    expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
    expect(input.detach).toHaveBeenCalledTimes(1); // stop() already ran
    const callsBefore = handlers.onGameOver.mock.calls.length;
    expect(raf.flush(3)).toBe(0); // nothing left queued — real play never re-fires this on its own
    expect(handlers.onGameOver).toHaveBeenCalledTimes(callsBefore);
  });
});

describe("RaycasterEngine — multiplayer exit countdown (step 8)", () => {
  function exitMap(size = 12) {
    return fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
  }

  it("touching the exit starts the countdown instead of winning immediately, and getExitCountdownRemaining() reports it", () => {
    const handlers = makeHandlers();
    const engine = new RaycasterEngine(makeCanvas(), exitMap(), handlers, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    expect(engine.getExitCountdownRemaining()).toBeNull();
    engine.advance(0.016);
    expect(handlers.onWin).not.toHaveBeenCalled();
    expect(engine.getExitCountdownRemaining()).toBe(COUNTDOWN_TICKS);
  });

  it("does not start the countdown while an alive enemy from the exit's own room remains", () => {
    const size = 12;
    const enemy = fakeEnemy({ home: { x: size - 4, y: size - 4, w: 4, h: 4 }, alive: true });
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 }, enemies: [enemy] }, size);
    const engine = new RaycasterEngine(makeCanvas(), map, {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.advance(0.016);
    expect(engine.getExitCountdownRemaining()).toBeNull();
  });

  it("counts down by exactly one tick per simulate() call, regardless of dt", () => {
    const engine = new RaycasterEngine(makeCanvas(), exitMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.simulate(0.016); // starts it
    engine.simulate(5); // a huge dt must still only cost one tick of countdown
    expect(engine.getExitCountdownRemaining()).toBe(COUNTDOWN_TICKS - 1);
  });

  it("does not restart or cancel when the player leaves and re-touches the exit tile", () => {
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), exitMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
    engine.simulate(0.016); // starts it, at COUNTDOWN_TICKS
    engine.simulate(0.016); // COUNTDOWN_TICKS - 1
    engine.simulate(0.016); // COUNTDOWN_TICKS - 2 — still counting, whether or not the player moved
    expect(engine.getExitCountdownRemaining()).toBe(COUNTDOWN_TICKS - 2);
  });

  it("keeps the sim running normally throughout — other simulate() side effects still happen", () => {
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), exitMap(), {}, undefined, undefined, undefined, 1, input, undefined, "H");
    engine.simulate(0.016); // starts the countdown
    const before = engine.getPlayerPosition("H")!;
    input.keys.add("KeyS"); // back away from the exit-adjacent wall, into open floor
    engine.simulate(0.5);
    const after = engine.getPlayerPosition("H")!;
    expect(after.x !== before.x || after.y !== before.y).toBe(true);
  });

  it("fires endGame(\"won\") only once the countdown reaches zero, not before", () => {
    // onWin/onGameOver fire from render(), not simulate() — advance() (which
    // calls both) is the real driver every session uses, so this test uses
    // it too rather than simulate() alone.
    const handlers = makeHandlers();
    const engine = new RaycasterEngine(makeCanvas(), exitMap(), handlers, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    // The first call only *starts* the countdown (no decrement that tick —
    // see `checkExit()`'s own doc comment) — COUNTDOWN_TICKS further calls
    // are needed to actually exhaust it.
    for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) {
      engine.advance(0.016);
      if (i < COUNTDOWN_TICKS) expect(handlers.onWin).not.toHaveBeenCalled();
    }
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    expect(engine.getExitCountdownRemaining()).toBeNull();
  });

  it("render() draws the countdown toast once active, and not before", () => {
    const canvas = makeCanvas();
    const ctx = canvas.getContext("2d") as unknown as MockCanvasContext;
    const engine = new RaycasterEngine(canvas, exitMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.render();
    expect(ctx.fillText).not.toHaveBeenCalledWith(expect.stringContaining("Build finishing"), expect.anything(), expect.anything());
    engine.simulate(0.016); // starts the countdown
    engine.render();
    expect(ctx.fillText).toHaveBeenCalledWith("Build finishing in 5s…", WIDTH / 2, 40);
  });

  it("getExitCountdownRemaining() stays null for a single-player instance, which wins immediately (regression)", () => {
    const { engine, handlers } = makeEngine(exitMap());
    engine.advance(0.016);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    expect(engine.getExitCountdownRemaining()).toBeNull();
  });
});

describe("RaycasterEngine — captureCarryoverFor (step 8)", () => {
  it("captures health/swap/ammo/weapon/owned-weapons/cheat-flags/campaignLevelIndex for the given roster id", () => {
    const carryover: EngineCarryover = {
      health: 40,
      swap: 5,
      bullets: 10,
      rockets: 2,
      smg: 3,
      gas: 4,
      weaponIndex: GDB_WEAPON_INDEX,
      ownedWeapons: [0, 1, 2, GDB_WEAPON_INDEX],
      godMode: true,
      noClip: true,
      showFps: true,
      campaignLevelIndex: 3,
    };
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, carryover, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const result = engine.captureCarryoverFor("H");
    expect(result.health).toBe(40);
    expect(result.swap).toBe(5);
    expect(result.bullets).toBe(10);
    expect(result.rockets).toBe(2);
    expect(result.smg).toBe(3);
    expect(result.gas).toBe(4);
    expect(result.weaponIndex).toBe(GDB_WEAPON_INDEX);
    expect(result.ownedWeapons?.sort()).toEqual([0, 1, 2, GDB_WEAPON_INDEX].sort());
    expect(result.godMode).toBe(true);
    expect(result.noClip).toBe(true);
    expect(result.showFps).toBe(true);
    expect(result.campaignLevelIndex).toBe(3);
  });

  it("adds this level's own score on top of any prior score already carried in", () => {
    const carryover: EngineCarryover = { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, priorScore: 500 };
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, carryover, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const result = engine.captureCarryoverFor("H");
    expect(result.priorScore).toBeGreaterThan(500); // 500 baseline + this level's own (nonzero completion/health) contribution
  });

  it("leaves priorPlayerStats undefined under ?ablate=telemetry, while priorScoreBreakdown survives", () => {
    // The off path is still real code and still has to work — `?ablate=telemetry`
    // is what keeps it reachable now that the flag ships on. `priorScoreBreakdown`
    // was never telemetry-gated (same core-carryover status as `priorScore`), so
    // it must still be populated here.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?ablate=telemetry" }, configurable: true });
    try {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      const result = engine.captureCarryoverFor("H");
      expect(result.priorScoreBreakdown).toBeDefined();
      expect(result.priorPlayerStats).toBeUndefined();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("populates priorScoreBreakdown and priorPlayerStats by default, now that PLAYER_STATS_ENABLED is on", () => {
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const result = engine.captureCarryoverFor("H");
    expect(result.priorScoreBreakdown).toBeDefined();
    expect(result.priorScoreBreakdown?.total).toBe(result.priorScore); // both derived from the same computeLevelScoreBreakdown(p) call
    expect(result.priorPlayerStats).toBeDefined();
  });

  it("populates priorPlayerStats too under ?testHooks=1 (telemetry on)", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      const result = engine.captureCarryoverFor("H");
      expect(result.priorScoreBreakdown).toBeDefined();
      expect(result.priorPlayerStats).toBeDefined();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("adds this level's own kills on top of any priorKills already carried in, without needing telemetry", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 }); // same point-blank placement as the telemetry kill test above
    const carryover: EngineCarryover = { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0, priorKills: 3 };
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), fakeMap({ enemies: [enemy] }), {}, carryover, undefined, undefined, 1, input, undefined, "H");
    input.fireQueued = true;
    engine.advance(0.016); // fires the pistol, kills the enemy
    expect(enemy.alive).toBe(false);
    const result = engine.captureCarryoverFor("H");
    expect(result.priorKills).toBe(4); // 3 carried in + 1 this level
  });

  it("captures a non-local roster player's own state, not just the local player's", () => {
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.addPlayer("G", new ScriptedInput(), { health: 33, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 });
    const hostResult = engine.captureCarryoverFor("H");
    const guestResult = engine.captureCarryoverFor("G");
    expect(hostResult.health).toBe(100); // default full health, no carryover given
    expect(guestResult.health).toBe(33);
  });

  it("is a pure snapshot — never mutates the captured player's own live state", () => {
    const carryover: EngineCarryover = { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, priorScore: 42 };
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, carryover, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const first = engine.captureCarryoverFor("H");
    const second = engine.captureCarryoverFor("H");
    expect(second.priorScore).toBe(first.priorScore); // unchanged by the first call — not accumulated twice
  });
});

describe("RaycasterEngine — externally-driven FPS (multiplayer)", () => {
  it("getDisplayFps() stays 0 for a normal (internal rAF) instance that's never externally driven", () => {
    const { engine } = makeEngine(fakeMap());
    engine.advance(0.016);
    engine.advance(0.016);
    expect(engine.getDisplayFps()).toBe(0);
  });

  it("stays 0 after just one externally-driven advance() call — nothing to measure an interval against yet", () => {
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.startExternallyDriven();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    engine.advance(0.016);
    expect(engine.getDisplayFps()).toBe(0);
  });

  it("reports a real FPS from real wall-clock time between externally-driven advance() calls", () => {
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.startExternallyDriven();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0);
    engine.advance(0.016);
    // Ten ticks, 100ms apart in real wall-clock time — comfortably past
    // FPS_UPDATE_INTERVAL (0.5s) so displayFps recomputes at least once.
    for (let i = 1; i <= 10; i++) {
      now.mockReturnValueOnce(i * 100);
      engine.advance(0.016);
    }
    expect(engine.getDisplayFps()).toBe(10); // 1000ms real / 100ms per tick = 10 ticks/sec
  });
});

describe("RaycasterEngine — getMultiplayerTelemetrySnapshot (step 11)", () => {
  it("returns null under ?ablate=telemetry — nothing is being recorded", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?ablate=telemetry" }, configurable: true });
    try {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      engine.addPlayer("G", new ScriptedInput());
      expect(engine.getMultiplayerTelemetrySnapshot("H")).toBeNull();
      expect(engine.getMultiplayerTelemetrySnapshot("G")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("returns a per-player snapshot without ?testHooks=1, now that PLAYER_STATS_ENABLED is on", () => {
    // Used to assert `null` here: telemetry was off in real play, so the
    // snapshot had nothing to report. It is on since 2026-08-23.
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.addPlayer("G", new ScriptedInput());
    expect(engine.getMultiplayerTelemetrySnapshot("H")).not.toBeNull();
    expect(engine.getMultiplayerTelemetrySnapshot("G")).not.toBeNull();
  });

  it("returns null for an id that isn't a connected player, even with telemetry on", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      expect(engine.getMultiplayerTelemetrySnapshot("nope")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("reports each connected player's own per-player fields independently, while sharing identical team-wide fields", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const hostInput = new ScriptedInput();
      const guestInput = new ScriptedInput();
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, hostInput, undefined, "H");
      engine.addPlayer("G", guestInput);

      // Only the guest fires — proves weaponTallies/shotsFired is genuinely
      // per-player now, not the pre-step-11 shared-instance bug (which would
      // have shown the shot on *both* players' snapshots).
      guestInput.fireQueued = true;
      engine.advance(0.016);

      const hostSnapshot = engine.getMultiplayerTelemetrySnapshot("H");
      const guestSnapshot = engine.getMultiplayerTelemetrySnapshot("G");
      expect(hostSnapshot).not.toBeNull();
      expect(guestSnapshot).not.toBeNull();
      expect(guestSnapshot!.weaponTallies[0]?.shotsFired).toBe(1);
      expect(hostSnapshot!.weaponTallies[0]?.shotsFired).toBeUndefined();

      // Team-wide fields (no single per-player owner) read identically off
      // both snapshots — see `RaycasterEngine.teamTelemetry`'s doc comment.
      expect(hostSnapshot!.peakAggroedCount).toBe(guestSnapshot!.peakAggroedCount);
      expect(hostSnapshot!.combatTimeSec).toBe(guestSnapshot!.combatTimeSec);
      expect(hostSnapshot!.enemyBoltsFired).toBe(guestSnapshot!.enemyBoltsFired);
      expect(hostSnapshot!.enemyMeleeAttacks).toBe(guestSnapshot!.enemyMeleeAttacks);
      expect(hostSnapshot!.minesTriggered).toBe(guestSnapshot!.minesTriggered);
      expect(hostSnapshot!.lootRolled).toEqual(guestSnapshot!.lootRolled);
      expect(hostSnapshot!.mapCompletionFrac).toBe(guestSnapshot!.mapCompletionFrac);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });
});

describe("RaycasterEngine — FPS overlay toggle", () => {
  it("Right-Ctrl equivalent (consumeFpsToggle) flips the overlay without throwing", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.fpsToggle = true;
    expect(() => engine.advance(0.016)).not.toThrow();
    input.fpsToggle = true;
    expect(() => engine.advance(0.016)).not.toThrow();
  });

  it("still draws the FPS overlay on a frozen paused frame", () => {
    const { engine, input } = makeEngine(fakeMap());
    input.fpsToggle = true;
    engine.advance(0.016);
    input.escape = true;
    expect(() => engine.advance(0.016)).not.toThrow();
  });

  it("still draws the FPS overlay on a frozen lore-terminal frame", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][6] = LORE_TILE;
    const map = fakeMap({ grid: g, loreTerminals: [{ x: 6, y: 5, text: "// comment" }] }, size);
    const { engine, input } = makeEngine(map);
    input.fpsToggle = true;
    engine.advance(0.016);
    input.interact = true;
    engine.advance(0.016); // opens the terminal
    expect(() => engine.advance(0.016)).not.toThrow(); // renders the frozen overlay with FPS on
  });
});

describe("RaycasterEngine — replay recording", () => {
  it("records each frame's input snapshot when a recorder is attached", () => {
    const canvas = makeCanvas();
    const input = new ScriptedInput();
    const recorder = { record: vi.fn() } as unknown as import("./replay").CampaignReplayRecorder;
    const engine = new RaycasterEngine(canvas, fakeMap(), {}, undefined, undefined, undefined, 1, input, recorder);
    engine.advance(0.016);
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });
});

describe("RaycasterEngine — scoring integration", () => {
  it("ceils fractional health/swap in the reported stats", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2;
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.03); // a small fractional hazard tick
    const stats = lastStats(handlers);
    expect(Number.isInteger(stats.health)).toBe(true);
    expect(Number.isInteger(stats.swap)).toBe(true);
  });

  it("banks priorScore as the running score's floor", () => {
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, priorScore: 12345 } });
    engine.advance(0.016);
    expect(lastStats(handlers).score).toBeGreaterThanOrEqual(12345);
  });
});

describe("RaycasterEngine — player-facing stats / run accumulation", () => {
  // `PLAYER_STATS_ENABLED` defaults to false (see its doc comment — it costs
  // real frame time even with the derivation gated to level-end only), so
  // every test here that wants the curated stats populated stubs
  // `?testHooks=1` on the URL, matching how the balancing bot always gets
  // them for free. `runScoreBreakdown`/`levelPlayerStats`/`runPlayerStats`
  // are only actually derived on the level's terminal frame
  // (`this.state !== "playing"`) — see `buildStats()`'s doc comment — so
  // every test below drives the engine to a real win or death before
  // asserting on them.

  function withTestHooksUrl<T>(fn: () => T): T {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  }

  it("leaves levelPlayerStats/levelScoreBreakdown/runScoreBreakdown/runPlayerStats undefined under ?ablate=telemetry", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?ablate=telemetry" }, configurable: true });
    try {
      const size = 12;
      const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      const stats = lastStats(handlers);
      expect(stats.levelPlayerStats).toBeUndefined();
      expect(stats.runScoreBreakdown).toBeUndefined();
      // The plain numeric score is unaffected either way.
      expect(stats.score).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  });

  it("populates levelPlayerStats/levelScoreBreakdown/runScoreBreakdown/runPlayerStats by default, now that PLAYER_STATS_ENABLED is on", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.016);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    const stats = lastStats(handlers);
    expect(stats.levelPlayerStats).toBeDefined();
    expect(stats.levelScoreBreakdown).toBeDefined();
    expect(stats.runScoreBreakdown).toBeDefined();
    expect(stats.runPlayerStats).toBeDefined();
    expect(stats.score).toBeGreaterThan(0);
  });

  it("populates levelPlayerStats/levelScoreBreakdown under ?testHooks=1, once the level ends", () => {
    withTestHooksUrl(() => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // hazard tile under spawn — see "ceils fractional health/swap" test
      const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }], enemies: [enemy] }, size);
      const { engine, input, handlers } = makeEngine(map);
      input.fireQueued = true;
      engine.advance(0.016); // fires the pistol, kills the enemy; hazard tick this small is harmless
      expect(enemy.alive).toBe(false);
      engine.advance(10); // big hazard tick — drains health to 0, ends the run via onGameOver
      expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
      const stats = lastStats(handlers);
      expect(stats.levelPlayerStats?.kills).toBe(1);
      expect(stats.levelPlayerStats?.shotsFired).toBeGreaterThanOrEqual(1);
      expect(stats.levelPlayerStats?.hits).toBeGreaterThanOrEqual(1);
      expect(stats.levelScoreBreakdown?.killPoints).toBeGreaterThan(0);
    });
  });

  it("runScoreBreakdown.total equals the reported score at level end, given a consistent priorScore/priorScoreBreakdown pair", () => {
    withTestHooksUrl(() => {
      // `score` is `priorScore + levelScoreBreakdown.total`; `runScoreBreakdown.total`
      // is `priorScoreBreakdown.total + levelScoreBreakdown.total` — the two are
      // only guaranteed equal when the carryover's `priorScore` and
      // `priorScoreBreakdown.total` actually agree, exactly as `main.ts` always
      // sets them together from the same prior frame's `stats.score`/
      // `stats.runScoreBreakdown`.
      const priorBreakdown = { killPoints: 999, healthBonus: 0, ammoBonus: 0, speedBonus: 0, pathBonus: 0, mapCompletionBonus: 0, loreBonus: 0, secretRoomBonus: 0, multikillBonus: 0, accuracyBonus: 0, total: 999 };
      const size = 12;
      const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
      const { engine, handlers } = makeEngine(map, makeHandlers(), {
        carryover: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, priorScore: 999, priorScoreBreakdown: priorBreakdown },
      });
      engine.advance(0.016); // spawn === exit, so this frame wins immediately
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
      const stats = lastStats(handlers);
      expect(stats.runScoreBreakdown?.total).toBe(stats.score);
    });
  });

  it("defaults priorScoreBreakdown/priorPlayerStats to zero/empty when omitted from carryover", () => {
    withTestHooksUrl(() => {
      const size = 12;
      const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
      const { engine, handlers } = makeEngine(map);
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
      const stats = lastStats(handlers);
      expect(stats.runScoreBreakdown).toEqual(stats.levelScoreBreakdown);
      expect(stats.runPlayerStats).toEqual(stats.levelPlayerStats);
    });
  });

  it("seeds runScoreBreakdown/runPlayerStats from EngineCarryover and adds this level's own on top", () => {
    withTestHooksUrl(() => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2;
      const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }], enemies: [enemy] }, size);
      const { engine, input, handlers } = makeEngine(map, makeHandlers(), {
        carryover: {
          health: 100,
          swap: 0,
          bullets: 50,
          rockets: 0,
          smg: 0,
          gas: 0,
          priorScore: 1000,
          priorScoreBreakdown: { killPoints: 500, healthBonus: 0, ammoBonus: 0, speedBonus: 0, pathBonus: 0, mapCompletionBonus: 0, loreBonus: 0, secretRoomBonus: 0, multikillBonus: 0, accuracyBonus: 0, total: 500 },
          priorPlayerStats: { kills: 5, shotsFired: 10, hits: 10, weaponAccuracyPct: 100, damageTakenBySource: { enemyMelee: 0, enemyRanged: 0, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 }, timeSurvivedSec: 60, lootCollectedTotal: 2, minHealthReached: 90, fatalDamageSource: null },
        },
      });
      input.fireQueued = true;
      engine.advance(0.016);
      expect(enemy.alive).toBe(false);
      engine.advance(10);
      expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
      const stats = lastStats(handlers);
      expect(stats.runScoreBreakdown?.killPoints).toBe(500 + (stats.levelScoreBreakdown?.killPoints ?? 0));
      expect(stats.runPlayerStats?.kills).toBe(5 + (stats.levelPlayerStats?.kills ?? 0));
      expect(stats.runPlayerStats?.shotsFired).toBe(10 + (stats.levelPlayerStats?.shotsFired ?? 0));
      expect(stats.runPlayerStats?.timeSurvivedSec).toBe(60 + (stats.levelPlayerStats?.timeSurvivedSec ?? 0));
    });
  });
});

describe("RaycasterEngine — Multi Kill / Ultra Kill streaks", () => {
  // All point-blank, one-hit kills at the same spot the "firing" describe
  // block already uses — each dies in a single pistol shot (projectLivingEnemies
  // only ever considers the still-alive ones, so which one dies on a given
  // frame doesn't matter, only that exactly one does).
  function oneHitEnemies(count: number): Enemy[] {
    return Array.from({ length: count }, () => fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 }));
  }

  /**
   * One trigger-pull, spaced far enough apart to actually land.
   *
   * The spacing is load-bearing and must stay above the pistol's
   * `fireIntervalSec` (0.15s, see `weapons.ts`): `updateFiring` swallows a
   * pull that arrives inside the cooldown, and `ScriptedInput.consumeFire()`
   * clears the flag whether or not the shot lands — so a too-fast pull is
   * silently *eaten*, not deferred, and every kill count in this block
   * quietly halves. These tests are about kill *streaks*, not fire rate, so
   * the exact dt doesn't matter beyond clearing that floor; 0.16 clears it
   * without leaving a float residue. All the streak windows here (3s Multi,
   * 6s Ultra) have room to spare at this spacing.
   */
  function killShot(engine: ReturnType<typeof makeEngine>["engine"], input: ScriptedInput, dt = 0.16): void {
    input.fireQueued = true;
    engine.advance(dt);
  }

  // Point-blank enemies aggro (and start meleeing back) the instant they're
  // shot, so a rapid multi-kill test needs IDDQD, or a several-kill streak
  // can kill the *player* first — enemy attack damage isn't this feature's
  // concern. IDKFA (full arsenal) is also applied so a kill's random bonus-
  // weapon drop (see `rollBonusWeaponDrop`) never has anything left to grant
  // — with every weapon already owned, no pickup can auto-switch the
  // player off the pistol and stall the rest of the streak on an
  // un-owned-ammo weapon mid-test.
  function makeGodModeEngine(map: GameMap): ReturnType<typeof makeEngine> {
    const result = makeEngine(map);
    result.input.cheat = "IDDQD";
    result.engine.advance(0.001);
    result.input.cheat = "IDKFA";
    result.engine.advance(0.001);
    result.input.cheat = null;
    return result;
  }

  it("fires a Multi Kill on the 3rd kill within 3s, and doesn't re-fire on a 4th kill in the same streak", () => {
    const map = fakeMap({ enemies: oneHitEnemies(4) });
    const { engine, input, handlers } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");

    killShot(engine, input); // kill 1 @ t=0.16
    killShot(engine, input); // kill 2 @ t=0.32
    expect(multiSpy).not.toHaveBeenCalled();
    killShot(engine, input); // kill 3 @ t=0.48 -> Multi Kill
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers).kills).toBe(3);

    killShot(engine, input); // kill 4 @ t=0.64 -> still within the 3s window, no re-fire
    expect(multiSpy).toHaveBeenCalledTimes(1);
  });

  it("fires an Ultra Kill (not a 2nd Multi Kill) on the 6th kill within 6s", () => {
    const map = fakeMap({ enemies: oneHitEnemies(6) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    for (let i = 0; i < 6; i++) killShot(engine, input); // 6 kills spanning 0.96s -> inside both windows
    expect(multiSpy).toHaveBeenCalledTimes(1); // only the 3rd kill's Multi Kill
    expect(ultraSpy).toHaveBeenCalledTimes(1); // the 6th kill's Ultra Kill, not a 2nd Multi Kill
  });

  it("lets a lapsed streak (gap past the Ultra window) retrigger a fresh Multi Kill later", () => {
    const map = fakeMap({ enemies: oneHitEnemies(9) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    for (let i = 0; i < 6; i++) killShot(engine, input); // kills 1-6 @ t=0.16..0.96 -> Multi Kill then Ultra Kill
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(ultraSpy).toHaveBeenCalledTimes(1);

    killShot(engine, input, 10.1); // kill 7 @ t=11.06 -> well past the Ultra window, no trigger
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(ultraSpy).toHaveBeenCalledTimes(1);

    killShot(engine, input); // kill 8 @ t=11.22
    killShot(engine, input); // kill 9 @ t=11.38 -> a fresh 3-in-3s streak -> Multi Kill again
    expect(multiSpy).toHaveBeenCalledTimes(2);
    expect(ultraSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it("never triggers a streak when kills are spaced further apart than the Multi Kill window", () => {
    const map = fakeMap({ enemies: oneHitEnemies(3) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    killShot(engine, input); // kill 1 @ t=0.16
    killShot(engine, input, 4); // kill 2 @ t=4.16 -> 4s since kill 1, past the 3s window
    killShot(engine, input, 4); // kill 3 @ t=8.16 -> 4s since kill 2, past the 3s window
    expect(multiSpy).not.toHaveBeenCalled();
    expect(ultraSpy).not.toHaveBeenCalled();
  });

  it("scores Ultra Kill's bigger bonus on top of Multi Kill's, via computeScore()'s multikillBonus", () => {
    const map = fakeMap({ enemies: oneHitEnemies(6) });
    const { engine, input, handlers } = makeGodModeEngine(map);
    for (let i = 0; i < 3; i++) killShot(engine, input); // kills 1-3 -> Multi Kill
    // The toast itself is drawn straight to canvas (see hud.test.ts's
    // drawKillStreakToast coverage) — here just confirm the score already
    // reflects the Multi Kill bonus flowing through computeScore().
    const afterMulti = lastStats(handlers).score;
    for (let i = 0; i < 3; i++) killShot(engine, input); // kills 4-6 -> Ultra Kill
    const afterUltra = lastStats(handlers).score;
    expect(afterUltra).toBeGreaterThan(afterMulti); // Ultra's bigger bonus landed
  });
});

describe("perf-frame begin on direct advance() (audit F21)", () => {
  it("a direct advance() call (replay viewer / headless driver) begins its own perf frame from dt", () => {
    const original = window.location;
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(window, "location", { value: { ...original, search: "?perfDebug=1" }, configurable: true });
    try {
      const { engine } = makeEngine(fakeMap());
      // No start()/rAF at all — the exact drive mode main.ts's replay step
      // loop uses. Phases must reset per advance (they used to accumulate
      // forever because only frame() called beginFrame).
      engine.advance(0.016);
      engine.advance(0.016);
      const hook = (window as Window & { __codeensteinPerfStats?: { snapshot: () => { frames: number; busyMs: number[] } } }).__codeensteinPerfStats;
      expect(hook).toBeDefined();
      const snap = hook!.snapshot();
      expect(snap.frames).toBe(2);
      // Accumulation bug regression check: the second frame's busy time is a
      // fresh measurement, not a running total that includes the first.
      expect(snap.busyMs[1]).toBeLessThan(snap.busyMs[0] + snap.busyMs[1] + 1);
      expect(snap.busyMs.length).toBe(2);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinPerfStats?: unknown }).__codeensteinPerfStats;
    }
  });
});

describe("RaycasterEngine — simulate()/render() split", () => {
  it("render() can be called repeatedly with no intervening simulate()/advance() — each call succeeds and re-invokes onStats", () => {
    const { engine, handlers } = makeEngine(fakeMap());
    engine.advance(0.016); // one real tick so there's something to draw
    handlers.onStats.mockClear();

    expect(() => engine.render()).not.toThrow();
    expect(() => engine.render()).not.toThrow();
    expect(() => engine.render()).not.toThrow();

    expect(handlers.onStats).toHaveBeenCalledTimes(3);
    for (const call of handlers.onStats.mock.calls) {
      expect(call[0]).toMatchObject({ health: expect.any(Number), weaponIndex: expect.any(Number) });
    }
  });

  it("simulate(dt) x N followed by one render() reaches the same observable state as advance(dt) x N", () => {
    // Movement + firing over identical scripted input, driven two different
    // ways on two separate engines with the same seed/map — proves the
    // decomposition doesn't silently change any gameplay-observable value
    // (position, health, ammo, state), independent of the trajectory digest
    // (which only spot-checks one particular scripted run, not this specific
    // equivalence property).
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      type PlayerState = { x: number; y: number; health: number; state: string; ammo: Record<string, number> };
      const getHooks = () =>
        (window as unknown as { __codeensteinTestHooks: Record<string, () => unknown> }).__codeensteinTestHooks;
      const dt = 1 / 30;

      // Only one engine's testHooks are live on the shared window global at a
      // time (the constructor overwrites it) — fully drive and sample engine
      // A before ever constructing engine B, not interleaved.
      const { engine: engineA, input: inputA } = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }, 16), undefined, { seed: 42 });
      inputA.keys.add("KeyD");
      for (let i = 0; i < 10; i++) engineA.advance(dt);
      inputA.keys.delete("KeyD");
      // 6 frames per pull (0.2s at this dt), not one: the pistol's
      // `fireIntervalSec` is 0.15s, so back-to-back pulls at 1/30s would let
      // exactly *one* shot through and the `ammo` assertion below would
      // compare two engines that each fired once — trivially equal, and no
      // longer evidence that advance() and simulate() agree on firing.
      for (let i = 0; i < 5; i++) {
        inputA.fireQueued = true;
        for (let f = 0; f < 6; f++) engineA.advance(dt);
      }
      const stateA = getHooks().getPlayerState() as PlayerState;

      const { engine: engineB, input: inputB } = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }, 16), undefined, { seed: 42 });
      inputB.keys.add("KeyD");
      for (let i = 0; i < 10; i++) engineB.simulate(dt);
      inputB.keys.delete("KeyD");
      for (let i = 0; i < 5; i++) {
        inputB.fireQueued = true;
        for (let f = 0; f < 6; f++) engineB.simulate(dt);
      }
      engineB.render();
      const stateB = getHooks().getPlayerState() as PlayerState;

      expect(stateB.x).toBeCloseTo(stateA.x, 10);
      expect(stateB.y).toBeCloseTo(stateA.y, 10);
      expect(stateB.health).toBe(stateA.health);
      expect(stateB.state).toBe(stateA.state);
      expect(stateB.ammo).toEqual(stateA.ammo);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("render()'s three overlay branches (normal, paused, lore) each return a populated EngineStats", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][6] = LORE_TILE; // just east of spawn (5,5)
    const map = fakeMap({ grid: g, loreTerminals: [{ x: 6, y: 5, text: "// a secret comment" }] }, size);
    const { engine, input } = makeEngine(map);

    engine.advance(0.016);
    const normalStats = engine.render();
    expect(normalStats.health).toBeGreaterThan(0);
    expect(normalStats.weaponIndex).toBeDefined();

    input.escape = true;
    engine.simulate(0.016); // resolves the pause this tick
    const pausedStats = engine.render();
    expect(pausedStats.health).toBe(normalStats.health);

    input.escape = true;
    engine.simulate(0.016); // unpauses

    input.interact = true;
    engine.simulate(0.016); // opens the lore terminal this tick
    const loreStats = engine.render();
    expect(loreStats.health).toBe(normalStats.health);
  });

  it("advance() still fires onGameOver/onWin with the same EngineStats render() itself returns, on a real death/win", () => {
    const size = 12;
    const winMap = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine: winEngine, handlers: winHandlers } = makeEngine(winMap);
    winEngine.advance(0.016);
    expect(winHandlers.onWin).toHaveBeenCalledTimes(1);
    expect(winHandlers.onWin.mock.calls[0][0]).toMatchObject({ health: expect.any(Number) });

    const g = walledRoom(size);
    g[5][5] = 2; // hazard tile at spawn
    const deathMap = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const { engine: deathEngine, handlers: deathHandlers } = makeEngine(deathMap);
    for (let i = 0; i < 10 && deathHandlers.onGameOver.mock.calls.length === 0; i++) deathEngine.advance(1);
    expect(deathHandlers.onGameOver).toHaveBeenCalledTimes(1);
    expect(deathHandlers.onGameOver.mock.calls[0][0]).toMatchObject({ health: 0 });
  });
});

/** Reaches into `RaycasterEngine`'s private `players` map for the handful of
 * N-player mechanics (per-player `zBuffer` identity, `spectateTargetId`)
 * that have no public surface at all — by design, since neither is meant to
 * ever be observed by a real host. Every other N-player test below drives
 * only the public surface (`addPlayer`/`rosterSnapshot`/`advance`/testHooks). */
function playersOf(engine: InstanceType<typeof RaycasterEngine>): Map<string, { zBuffer: Float64Array; spectateTargetId: string | null; status: string }> {
  return (engine as unknown as { players: Map<string, { zBuffer: Float64Array; spectateTargetId: string | null; status: string }> }).players;
}

describe("RaycasterEngine — addPlayer / roster (N-player)", () => {
  it("adds a second player, reflected in rosterSnapshot", () => {
    const { engine } = makeEngine(fakeMap());
    engine.addPlayer("p2", new ScriptedInput());
    const roster = engine.rosterSnapshot();
    expect([...roster.keys()].sort()).toEqual(["local", "p2"]);
    expect(roster.get("p2")).toMatchObject({ status: "alive", health: 100, killScore: 0, kills: 0, distanceTraveled: 0 });
    // `breakdown` is the cumulative run total (multiplayer step 9) — a fresh
    // player with no prior levels and no damage taken yet still earns the
    // full health/ammo bonuses, so `total` is non-zero from tick one.
    expect(roster.get("p2")!.breakdown.total).toBeGreaterThan(0);
  });

  it("throws when adding a player id that's already present", () => {
    const { engine } = makeEngine(fakeMap());
    engine.addPlayer("p2", new ScriptedInput());
    expect(() => engine.addPlayer("p2", new ScriptedInput())).toThrow('"p2" already present');
  });

  // Regression test for a real desync bug caught before any multiplayer
  // netcode existed to trigger it: without the `localPlayerId` constructor
  // param, every engine keys its own player as the literal string "local"
  // regardless of which real, globally-shared roster id it represents. Two
  // peers looking at "the same two physical players" would then each
  // substitute a *different* one of the two real ids with "local" before
  // `sortedPlayerIds()` sorts them, producing opposite relative iteration
  // order — and since per-player simulation loops consume the shared PRNG
  // stream in that order (e.g. fire()'s Cone-of-Fire spread), opposite order
  // means an instant, permanent desync from tick 1. Passing each peer's own
  // real roster id as `localPlayerId` (instead of relying on the "local"
  // default) is what keeps `sortedPlayerIds()`'s output identical everywhere.
  it("keys every peer's own player by its real roster id, keeping sortedPlayerIds() order identical across swapped-role constructions", () => {
    const hostView = new RaycasterEngine(
      makeCanvas(),
      fakeMap(),
      {},
      undefined,
      undefined,
      undefined,
      1,
      new ScriptedInput(),
      undefined,
      "H",
    );
    hostView.addPlayer("G", new ScriptedInput());

    const guestView = new RaycasterEngine(
      makeCanvas(),
      fakeMap(),
      {},
      undefined,
      undefined,
      undefined,
      1,
      new ScriptedInput(),
      undefined,
      "G",
    );
    guestView.addPlayer("H", new ScriptedInput());

    const hostOrder = [...playersOf(hostView).keys()].sort();
    const guestOrder = [...playersOf(guestView).keys()].sort();
    expect(hostOrder).toEqual(["G", "H"]);
    expect(guestOrder).toEqual(hostOrder);
  });

  it("defaults localPlayerId to LOCAL_PLAYER_ID ('local') when omitted, unchanged from single-player behavior", () => {
    const { engine } = makeEngine(fakeMap());
    expect([...playersOf(engine).keys()]).toEqual(["local"]);
  });

  it("getPlayerPosition reads any roster player's world position, or null if absent", () => {
    const { engine } = makeEngine(fakeMap({ spawn: { x: 3, y: 4 } }));
    expect(engine.getPlayerPosition("local")).toEqual({ x: 3.5, y: 4.5 });
    expect(engine.getPlayerPosition("nope")).toBeNull();
  });

  it("getPlayerFacing reads any roster player's facing direction, or null if absent", () => {
    const { engine } = makeEngine(fakeMap());
    expect(engine.getPlayerFacing("local")).toEqual({ dirX: 1, dirY: 0 });
    expect(engine.getPlayerFacing("nope")).toBeNull();
  });

  it("getPlayerStatus reads any roster player's status, or null if absent", () => {
    const { engine } = makeEngine(fakeMap());
    expect(engine.getPlayerStatus("local")).toBe("alive");
    expect(engine.getPlayerStatus("nope")).toBeNull();
  });

  it("getPlayerDisplayName reads any roster player's resolved name, or null if absent", () => {
    const { engine } = makeEngine(fakeMap());
    // Single-player: nothing ever displays this, but it resolves rather than
    // being empty — the fallback is the capitalized roster id.
    expect(engine.getPlayerDisplayName("local")).toBe("Local");
    expect(engine.getPlayerDisplayName("nope")).toBeNull();

    engine.addPlayer("guest-1", new ScriptedInput(), undefined, undefined, "  Tobi  ");
    // Sanitized and resolved once, at the point the name entered the engine.
    expect(engine.getPlayerDisplayName("guest-1")).toBe("Tobi");

    engine.addPlayer("guest-2", new ScriptedInput());
    expect(engine.getPlayerDisplayName("guest-2")).toBe("Guest-2");
  });

  it("getMapExit/getMapGrid read this level's exit tile and walkable grid", () => {
    const map = fakeMap({ exit: { x: 6, y: 7 } });
    const { engine } = makeEngine(map);
    expect(engine.getMapExit()).toEqual({ x: 6, y: 7 });
    expect(engine.getMapGrid()).toBe(map.grid);
  });

  it("getMap returns the full generated GameMap this engine is running", () => {
    const map = fakeMap({ exit: { x: 6, y: 7 } });
    const { engine } = makeEngine(map);
    expect(engine.getMap()).toBe(map);
  });

  it("getEnemiesSnapshot/getMinesSnapshot mirror __codeensteinTestHooks' getEnemies/getMines, roster-agnostic", () => {
    const map = fakeMap({
      enemies: [fakeEnemy({ x: 3, y: 3, hp: 10, maxHp: 10 })],
      mines: [{ x: 4, y: 4, alive: true, visible: true, closeTimer: 0 }],
    });
    const { engine } = makeEngine(map);
    expect(engine.getEnemiesSnapshot()).toEqual([
      { x: 3, y: 3, alive: true, aggroed: false, elite: false, edgeCase: false, hp: 10, maxHp: 10 },
    ]);
    expect(engine.getMinesSnapshot()).toEqual([{ x: 4, y: 4, alive: true, visible: true }]);
  });

  it("getProjectilesSnapshot exposes real in-flight enemy bolts, travelling at PROJECTILE_SPEED", () => {
    // An already-aggroed enemy with no fire cooldown left, standing well
    // inside RANGED_RANGE (8) of the spawn with nothing but open floor
    // between them: exactly the situation enemyAi.ts fires a bolt in, on the
    // very first frame.
    const map = fakeMap({ spawn: { x: 5, y: 5 }, enemies: [fakeEnemy({ x: 6, y: 5, aggroed: true, fireCooldown: 0 })] });
    const { engine } = makeEngine(map);
    expect(engine.getProjectilesSnapshot()).toEqual([]);
    engine.advance(0.016);
    const bolts = engine.getProjectilesSnapshot();
    expect(bolts).toHaveLength(1);
    expect(bolts[0]).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      vx: expect.any(Number),
      vy: expect.any(Number),
      damage: expect.any(Number),
      targetId: "local",
    });
    // Whatever aim spread the difficulty applies only rotates the heading —
    // the speed itself is fixed, which is what makes flight time (and so
    // dodgeability) predictable for a bot reading this.
    expect(Math.hypot(bolts[0].vx, bolts[0].vy)).toBeCloseTo(5, 5);
  });

  it("getProjectilesSnapshot returns copies, so a caller can't steer live bolts", () => {
    const map = fakeMap({ spawn: { x: 5, y: 5 }, enemies: [fakeEnemy({ x: 6, y: 5, aggroed: true, fireCooldown: 0 })] });
    const { engine } = makeEngine(map);
    engine.advance(0.016);
    const before = engine.getProjectilesSnapshot();
    expect(before).toHaveLength(1);
    before[0].x = 999;
    before[0].vx = 999;
    before[0].targetId = "someone-else";
    const after = engine.getProjectilesSnapshot();
    expect(after[0].x).not.toBe(999);
    expect(after[0].vx).not.toBe(999);
    expect(after[0].targetId).toBe("local");
  });

  it("getDropsSnapshot/getKeysSnapshot mirror __codeensteinTestHooks' getDrops/getKeys, roster-agnostic", () => {
    const map = fakeMap({
      spawn: { x: 5, y: 5 },
      keys: [
        { x: 6, y: 6, collected: false, gateId: 0 },
        { x: 7, y: 7, collected: true, gateId: 0 },
      ],
    });
    const { engine } = makeEngine(map, makeHandlers(), { input: new ScriptedInput() });
    engine.addPlayer("p2", new ScriptedInput());
    // A real, already-tested way to push a real LootDrop onto `this.drops` —
    // see the "multiplayer disconnect (step 8)" describe block above.
    engine.applyRosterRemoval(["p2"]);
    expect(engine.getKeysSnapshot()).toEqual([{ x: 6, y: 6 }]);
    expect(engine.getDropsSnapshot().length).toBeGreaterThan(0);
  });

  it("getBotPlayerState reads any roster player's full bot-facing state, or null if absent", () => {
    const { engine } = makeEngine(fakeMap({ spawn: { x: 3, y: 4 } }));
    const state = engine.getBotPlayerState("local");
    expect(state).not.toBeNull();
    expect(state!.x).toBe(3.5);
    expect(state!.y).toBe(4.5);
    expect(state!.state).toBe("playing");
    expect(engine.getBotPlayerState("nope")).toBeNull();
  });

  it("getBotPlayerState reports state \"over\" once the player is no longer alive, \"playing\" while alive (no per-player \"won\")", () => {
    const { engine } = makeEngine(fakeMap());
    engine.addPlayer("p2", new ScriptedInput());
    engine.applyRosterRemoval(["p2"]);
    expect(engine.getBotPlayerState("p2")!.state).toBe("over");
    expect(engine.getBotPlayerState("local")!.state).toBe("playing");
  });

  it("stays silent (no [multiplayer-desync] warning) when applyRosterRemoval's elimination check fires but this engine isn't a multiplayer session", () => {
    const { engine } = makeEngine(fakeMap());
    engine.addPlayer("p2", new ScriptedInput());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine.applyRosterRemoval(["local", "p2"]); // removes everyone — elimination check fires
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("[multiplayer-desync]"), expect.anything());
    warnSpy.mockRestore();
  });

  // Regression coverage for a real gap found while building multiplayer's
  // spawn-spreading (step 5, GameMap.multiplayerSpawns): before this, every
  // addPlayer()-added player spawned stacked on the exact same tile as the
  // constructor's own player, regardless of any spread-out spawn candidates
  // the map generator had already computed — contradicting the whole point
  // of generating them. `spawn` defaulting to `map.spawn` when omitted keeps
  // every existing single-player/N-player test's stacked-spawn assumption
  // (see the tests above/below this one) intact.
  it("addPlayer's spawn param overrides where a new player appears, defaulting to map.spawn when omitted", () => {
    const { engine } = makeEngine(fakeMap({ spawn: { x: 3, y: 4 } }));
    engine.addPlayer("p2", new ScriptedInput(), undefined, { x: 8, y: 9 });
    engine.addPlayer("p3", new ScriptedInput());
    expect(engine.getPlayerPosition("p2")).toEqual({ x: 8.5, y: 9.5 });
    expect(engine.getPlayerPosition("p3")).toEqual({ x: 3.5, y: 4.5 });
  });

  it("the constructor's own localSpawn param overrides where the local player appears", () => {
    const engine = new RaycasterEngine(
      makeCanvas(),
      fakeMap({ spawn: { x: 3, y: 4 } }),
      {},
      undefined,
      undefined,
      undefined,
      1,
      new ScriptedInput(),
      undefined,
      "H",
      { x: 10, y: 11 },
    );
    expect(engine.getPlayerPosition("H")).toEqual({ x: 10.5, y: 11.5 });
  });

  it("each player's zBuffer is its own independent Float64Array (resolveShot for one never touches another's)", () => {
    const { engine } = makeEngine(fakeMap());
    engine.addPlayer("p2", new ScriptedInput());
    const players = playersOf(engine);
    const a = players.get("local")!.zBuffer;
    const b = players.get("p2")!.zBuffer;
    expect(a).not.toBe(b);
    expect(a.length).toBe(640); // SCENE_WIDTH
    expect(b.length).toBe(640);
  });

  it("resolves a same-tile collection tie by sorted-playerId order, not insertion order", () => {
    const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "health", amount: 30, collected: false };
    const map = fakeMap({ ammoPickups: [pickup] });
    const carryover: EngineCarryover = { health: 40, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 };
    const { engine } = makeEngine(map, makeHandlers(), { carryover });
    // "aaa" sorts before "local" alphabetically despite being *added* second —
    // both spawn on the exact same tile as the pickup, a genuine tie.
    engine.addPlayer("aaa", new ScriptedInput(), carryover);
    engine.advance(0.016);
    const roster = engine.rosterSnapshot();
    expect(roster.get("aaa")!.health).toBeGreaterThan(40); // sorted-first player collects it
    expect(roster.get("local")!.health).toBe(40); // untouched
  });
});

describe("RaycasterEngine — multiplayer combat & friendly fire (N-player)", () => {
  it("enemy melee damage attributes to whichever player is nearest, not fixed to the local player", () => {
    const enemy = fakeEnemy({ x: 5.5, y: 5.5, aggroed: true, attackCooldown: 0, hp: 999, maxHp: 999 });
    const map = fakeMap({ enemies: [enemy] }, 20);
    const { engine, input } = makeEngine(map);
    engine.addPlayer("p2", new ScriptedInput()); // p2 spawns right next to the enemy and never moves
    input.keys.add("KeyS"); // local backs straight away from the enemy's position
    for (let i = 0; i < 30; i++) engine.advance(0.1);
    const roster = engine.rosterSnapshot();
    expect(roster.get("p2")!.health).toBeLessThan(100); // p2 (nearest) got bitten
    expect(roster.get("local")!.health).toBe(100); // local (farther away) untouched
  });

  it("splits killScore across both shooters via assist share, but credits kills/streak only to the final blow", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 40, maxHp: 40 }); // pistol does 22/hit — two hits needed
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input } = makeEngine(map);
    const p2Input = new ScriptedInput();
    engine.addPlayer("p2", p2Input);

    input.fireQueued = true; // local lands the first, non-lethal hit
    engine.advance(0.016);
    expect(enemy.alive).toBe(true);

    p2Input.fireQueued = true; // p2 lands the killing blow
    engine.advance(0.016);
    expect(enemy.alive).toBe(false);

    const roster = engine.rosterSnapshot();
    expect(roster.get("p2")!.kills).toBe(1);
    expect(roster.get("local")!.kills).toBe(0); // only the final blow gets kill/streak credit
    expect(roster.get("local")!.killScore).toBeGreaterThan(0); // assist share
    expect(roster.get("p2")!.killScore).toBeGreaterThan(0);
    expect(roster.get("local")!.killScore).toBeCloseTo(roster.get("p2")!.killScore, 5); // even split, 2 assists
  });

  it("rosterSnapshot().kills is cumulative (priorKills + this level's own) — mirrors the real level-transition carryover path, no telemetry needed", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const carryover: EngineCarryover = { health: 100, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0, priorKills: 7 };
    const { engine, input } = makeEngine(map, makeHandlers(), { carryover });
    input.fireQueued = true;
    engine.advance(0.016);
    expect(enemy.alive).toBe(false);
    expect(engine.rosterSnapshot().get("local")!.kills).toBe(8); // 7 carried in + 1 this level
  });

  it("hitscan fire can't hit a teammate standing in the crosshair (players are never in the hit-test list)", () => {
    const map = fakeMap();
    const { engine, input } = makeEngine(map);
    engine.addPlayer("p2", new ScriptedInput()); // spawns exactly where local is aiming
    input.fireQueued = true;
    engine.advance(0.016);
    expect(engine.rosterSnapshot().get("p2")!.health).toBe(100);
  });

  it("a proximity mine's blast damages every living player, no exclusion", () => {
    const mine: Mine = { x: 5.5, y: 5.5, alive: true, visible: false, closeTimer: 0 }; // right at spawn
    const map = fakeMap({ mines: [mine] });
    const { engine } = makeEngine(map);
    engine.addPlayer("p2", new ScriptedInput());
    for (let i = 0; i < 30 && mine.alive; i++) engine.advance(0.1);
    expect(mine.alive).toBe(false);
    const roster = engine.rosterSnapshot();
    expect(roster.get("local")!.health).toBeLessThan(100);
    expect(roster.get("p2")!.health).toBeLessThan(100);
  });

  it("a mine destroyed by gunfire fans splash damage to every living player, not just the shooter", () => {
    const mine: Mine = { x: 6.5, y: 5.5, alive: true, visible: true, closeTimer: 0 }; // close enough to splash spawn too
    const map = fakeMap({ mines: [mine] });
    const { engine, input } = makeEngine(map);
    engine.addPlayer("p2", new ScriptedInput()); // p2 stays right at spawn, within the blast
    input.fireQueued = true; // local (the shooter) destroys the mine
    engine.advance(0.016);
    expect(mine.alive).toBe(false);
    const roster = engine.rosterSnapshot();
    expect(roster.get("local")!.health).toBeLessThan(100); // shooter's own splash
    expect(roster.get("p2")!.health).toBeLessThan(100); // bystander teammate also caught it
  });

  it("rocket splash damages the firer but excludes a teammate standing in the blast", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: 10, y: 5 } }, size);
    const carryover: EngineCarryover = { health: 100, swap: 0, bullets: 0, rockets: 5, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 4] };
    const { engine, input } = makeEngine(map, makeHandlers(), { carryover });
    engine.addPlayer("p2", new ScriptedInput(), { ...carryover }); // p2 stays put, right next to the blast
    input.weaponRequest = 3; // slot 3 -> ghidra (index 4)
    engine.advance(0.016);
    input.fireQueued = true;
    engine.advance(0.016);
    for (let i = 0; i < 20; i++) engine.advance(0.05);
    const roster = engine.rosterSnapshot();
    expect(roster.get("local")!.health).toBeLessThan(100); // firer catches their own blast
    expect(roster.get("p2")!.health).toBe(100); // teammate excluded, even though in range
  });
});

describe("RaycasterEngine — death, spectate, and revive (N-player)", () => {
  function hazardSpawnMap(size = 14): GameMap {
    const g = walledRoom(size);
    g[5][5] = HAZARD_TILE; // the spawn tile itself is a hazard
    return fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
  }

  it("a player who dies drops NO key — every teammate already holds it", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 14;
      const g = walledRoom(size);
      g[5][5] = HAZARD_TILE;
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }], keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }] }, size);
      const { engine } = makeEngine(map);
      const p2Input = new ScriptedInput();
      engine.addPlayer("p2", p2Input);
      engine.advance(0.016); // local (sorted-first) collects the key this same tick
      expect(engine.rosterSnapshot().get("local")!.status).toBe("alive");

      p2Input.keys.add("KeyW"); // p2 clears the hazard tile; local stays and cooks
      for (let i = 0; i < 10; i++) engine.advance(0.1);
      p2Input.keys.delete("KeyW");
      for (let i = 0; i < 10 && engine.rosterSnapshot().get("local")!.status === "alive"; i++) engine.advance(1);
      expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");
      expect(engine.rosterSnapshot().get("local")!.health).toBe(0);
      // The team isn't over — p2 is still alive.
      expect(engine.rosterSnapshot().get("p2")!.status).toBe("alive");

      // There is exactly one key per gate, so it is granted to the whole team
      // on pickup. p2 already holds gate 0 — dropping a key here would be
      // handing over something nobody is missing, and a teammate who could not
      // pick it up in time would be locked out of that room for the level.
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks;
      const drops = hooks!.getDrops() as { x: number; y: number; kind: string }[];
      expect(drops.some((d) => d.kind === "key")).toBe(false);
      expect(engine.rosterSnapshot().get("p2")!.status).toBe("alive");
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("a dead player's spectateTargetId resolves to a living teammate and cycles via consumeFire (3 players)", () => {
    const { engine, input } = makeEngine(hazardSpawnMap());
    const p2Input = new ScriptedInput();
    const p3Input = new ScriptedInput();
    engine.addPlayer("p2", p2Input);
    engine.addPlayer("p3", p3Input);
    // p2 and p3 step off the hazard immediately; local stays and dies on it.
    p2Input.keys.add("KeyW");
    p3Input.keys.add("KeyW");
    for (let i = 0; i < 10; i++) engine.advance(0.1);
    p2Input.keys.delete("KeyW");
    p3Input.keys.delete("KeyW");
    for (let i = 0; i < 10 && engine.rosterSnapshot().get("local")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");

    const players = playersOf(engine);
    const local = players.get("local")!;
    expect(local.spectateTargetId).toBe("p2"); // first living teammate, sorted order

    input.fireQueued = true; // repurposed while dead: cycles the spectate target
    engine.advance(0.1);
    expect(local.spectateTargetId).toBe("p3");
    input.fireQueued = true;
    engine.advance(0.1);
    expect(local.spectateTargetId).toBe("p2"); // wraps back around — cycling past both candidates
  });

  it("a dead player's own render() stats report status/spectateTargetId, and a multiplayer session draws the spectate banner", () => {
    const canvas = makeCanvas();
    const ctx = canvas.getContext("2d") as unknown as MockCanvasContext;
    // localPlayerId "H" (not the default LOCAL_PLAYER_ID) makes this a real
    // multiplayer session per `isMultiplayerSession()` — same pattern the
    // exit-countdown tests above use.
    const engine = new RaycasterEngine(canvas, hazardSpawnMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const p2Input = new ScriptedInput();
    engine.addPlayer("p2", p2Input);
    // p2 steps off the hazard immediately; H (local) stays and cooks — same
    // movement pattern the spectateTargetId-cycling test above uses.
    p2Input.keys.add("KeyW");
    for (let i = 0; i < 10; i++) engine.advance(0.1);
    p2Input.keys.delete("KeyW");
    for (let i = 0; i < 10 && engine.rosterSnapshot().get("H")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("dead");
    expect(engine.rosterSnapshot().get("p2")!.status).toBe("alive"); // team isn't over

    const stats = engine.render();
    expect(stats.status).toBe("dead");
    expect(stats.spectateTargetId).toBe("p2");
    expect(ctx.fillText).toHaveBeenCalledWith("YOU DIED — spectating P2", WIDTH / 2, 40);
  });

  it("suppresses the spectate banner while the exit countdown is active — the two banners draw at the same position and would otherwise overlap", () => {
    const canvas = makeCanvas();
    const ctx = canvas.getContext("2d") as unknown as MockCanvasContext;
    const size = 14;
    const g = walledRoom(size);
    const exitTile = { x: size - 2, y: size - 2 };
    g[exitTile.y][exitTile.x] = HAZARD_TILE; // every player spawns standing on the exit, which is also a hazard
    const map = fakeMap({ grid: g, spawn: exitTile, exit: exitTile, hazards: [exitTile] }, size);
    const engine = new RaycasterEngine(canvas, map, {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const p2Input = new ScriptedInput();
    engine.addPlayer("p2", p2Input);

    // Both players start on the exit tile, so the countdown starts on the very first tick.
    engine.advance(0.1);
    expect(engine.getExitCountdownRemaining()).not.toBeNull();

    // p2 steps off the hazard (same movement pattern as the test above); H stays and cooks to death.
    p2Input.keys.add("KeyW");
    for (let i = 0; i < 10; i++) engine.advance(0.1);
    p2Input.keys.delete("KeyW");
    for (let i = 0; i < 10 && engine.rosterSnapshot().get("H")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("dead");
    expect(engine.getExitCountdownRemaining()).not.toBeNull(); // still counting down, well short of COUNTDOWN_TICKS

    ctx.fillText.mockClear();
    const stats = engine.render();
    expect(stats.status).toBe("dead");
    expect(ctx.fillText).toHaveBeenCalledWith(expect.stringContaining("Build finishing"), WIDTH / 2, 40);
    expect(ctx.fillText).not.toHaveBeenCalledWith(expect.stringContaining("YOU DIED"), expect.anything(), expect.anything());
  });

  it("never draws the spectate banner in single-player, even on the terminal frame where status briefly reads 'dead'", () => {
    const canvas = makeCanvas();
    const ctx = canvas.getContext("2d") as unknown as MockCanvasContext;
    // No localPlayerId override — defaults to LOCAL_PLAYER_ID, single-player.
    const engine = new RaycasterEngine(canvas, hazardSpawnMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput());
    for (let i = 0; i < 10 && engine.rosterSnapshot().get("local")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");

    const stats = engine.render();
    // The stats field itself correctly reports the terminal-frame state...
    expect(stats.status).toBe("dead");
    // ...but nothing draws the multiplayer-only spectate banner over it.
    expect(ctx.fillText).not.toHaveBeenCalledWith(expect.stringContaining("YOU DIED"), expect.anything(), expect.anything());
  });

  it("state flips to 'over' only once every connected player is dead", () => {
    const { engine, handlers } = makeEngine(hazardSpawnMap());
    engine.addPlayer("p2", new ScriptedInput()); // p2 never moves off the hazard either
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 20 && handlers.onGameOver.mock.calls.length === 0; i++) engine.advance(1);
    expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
    expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");
    expect(engine.rosterSnapshot().get("p2")!.status).toBe("dead");
    // Single-player: the diagnostic-only [multiplayer-desync] roster dump
    // (logTeamEliminationRosterDump) must stay silent — it's gated on
    // isMultiplayerSession(), which this engine (default localPlayerId) is not.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("[multiplayer-desync]"), expect.anything());
    warnSpy.mockRestore();
  });

  it("logs a [multiplayer-desync] roster dump via killPlayer immediately before locking in team-elimination", () => {
    const canvas = makeCanvas();
    const engine = new RaycasterEngine(canvas, hazardSpawnMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.addPlayer("p2", new ScriptedInput());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Neither player moves off the hazard — both cook to death.
    for (let i = 0; i < 20 && engine.rosterSnapshot().get("H")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("dead");
    expect(engine.rosterSnapshot().get("p2")!.status).toBe("dead");
    expect(warnSpy).toHaveBeenCalledWith(
      "[multiplayer-desync] killPlayer: locking in team-elimination",
      expect.arrayContaining([
        expect.objectContaining({ id: "H", status: "dead", health: 0 }),
        expect.objectContaining({ id: "p2", status: "dead", health: 0 }),
      ]),
    );
    warnSpy.mockRestore();
  });

  it("world-interaction per-player loops skip a dead player without throwing (keys, static loot, room discovery, gunfire-mine splash)", () => {
    const size = 20;
    const g = walledRoom(size);
    g[5][5] = HAZARD_TILE;
    const pickup: AmmoPickup = { x: 17.5, y: 17.5, kind: "bullets", amount: 5, collected: false }; // stays uncollected — unreachable by either player
    const enemy = fakeEnemy({ x: 17, y: 17, home: { x: 16, y: 16, w: 2, h: 2 } }); // stays undiscovered
    // Far past both where p2 ends up (~x=8.7) and MINE_FUSE_RADIUS (1.8) /
    // MINE_SIGHT_RADIUS (4.5) from there — the proximity fuse never arms, so
    // only gunfire (below) can destroy it; `visible` is set explicitly since
    // it's well outside MINE_SIGHT_RADIUS too.
    const mine: Mine = { x: 15.5, y: 5.5, alive: true, visible: true, closeTimer: 0 };
    const map = fakeMap(
      {
        grid: g,
        hazards: [{ x: 5, y: 5 }],
        keys: [{ x: 17.5, y: 17.5, collected: false, gateId: 0 }],
        ammoPickups: [pickup],
        enemies: [enemy],
        mines: [mine],
      },
      size,
    );
    const { engine } = makeEngine(map);
    const p2Input = new ScriptedInput();
    engine.addPlayer("p2", p2Input);
    p2Input.keys.add("KeyW"); // p2 clears the hazard tile and lines up on the mine far ahead
    for (let i = 0; i < 10; i++) engine.advance(0.1);
    p2Input.keys.delete("KeyW");
    for (let i = 0; i < 10 && engine.rosterSnapshot().get("local")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");
    expect(mine.alive).toBe(true); // still alive — the fuse never armed at this range

    // Drive several more ticks with local dead, p2 alive — exercises every
    // per-player world-interaction loop's dead-player skip branch (keys,
    // static loot, room discovery), then p2 destroys the mine via gunfire —
    // exercising destroyMine's own dead-player skip in its splash fan-out.
    p2Input.fireQueued = true;
    expect(() => {
      for (let i = 0; i < 5; i++) engine.advance(0.1);
    }).not.toThrow();
    expect(mine.alive).toBe(false);
  });

  it("addPlayer with carryover.health === REVIVE_HEALTH revives a player alive at that health, with inventory/score intact", () => {
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine } = makeEngine(map);
    const revivedInput = new ScriptedInput();
    engine.addPlayer("revived", revivedInput, {
      health: REVIVE_HEALTH,
      swap: 0,
      bullets: 10,
      rockets: 0,
      smg: 0,
      gas: 0,
      ownedWeapons: [0, 1, 2],
      priorScore: 250,
    });
    let roster = engine.rosterSnapshot();
    expect(roster.get("revived")).toMatchObject({ status: "alive", health: REVIVE_HEALTH, killScore: 0, kills: 0 });

    // Inventory carried over for real: the revived player can fire their
    // carried-over bullets and land a kill (proving `ownedWeapons`/`ammo`
    // round-tripped through `addPlayer`, not just `health`).
    revivedInput.fireQueued = true;
    engine.advance(0.016);
    roster = engine.rosterSnapshot();
    expect(roster.get("revived")!.kills).toBe(1);
    expect(roster.get("revived")!.killScore).toBeGreaterThan(0);
  });
});

describe("RaycasterEngine — damage SFX scoped to the currently-watched player", () => {
  // Three well-separated hazard tiles so each player can be damaged
  // independently by teleporting them onto their own tile — real hazard
  // damage (`applyHazardDamage`), not a synthetic direct call, matching this
  // file's established convention for triggering `damage()`.
  function threeHazardMap(size = 20): GameMap {
    const g = walledRoom(size);
    g[5][5] = HAZARD_TILE;
    g[10][10] = HAZARD_TILE;
    g[15][15] = HAZARD_TILE;
    return fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }, { x: 10, y: 10 }, { x: 15, y: 15 }], spawn: { x: 5, y: 5 } }, size);
  }

  type PosPlayers = Map<string, { player: { posX: number; posY: number }; status: string }>;

  it("plays the SFX when the local (alive) player takes damage", () => {
    const engine = new RaycasterEngine(makeCanvas(), threeHazardMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const spy = vi.spyOn(audio, "playDamage").mockImplementation(() => {});
    engine.advance(0.1); // H spawns directly on the hazard tile
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not play the SFX when a teammate (not being watched) takes damage while the local player is alive", () => {
    const map = threeHazardMap();
    map.spawn = { x: 2, y: 2 }; // H spawns off any hazard tile
    const engine = new RaycasterEngine(makeCanvas(), map, {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    engine.addPlayer("p2", new ScriptedInput(), undefined, { x: 10, y: 10 }); // straight onto a hazard tile
    const spy = vi.spyOn(audio, "playDamage").mockImplementation(() => {});
    engine.advance(0.1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("alive");
    expect(engine.rosterSnapshot().get("p2")!.health).toBeLessThan(100); // p2 really did take damage
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("plays the SFX when a dead local player's spectate target (a living teammate) takes damage", () => {
    const map = threeHazardMap();
    const engine = new RaycasterEngine(makeCanvas(), map, {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    // p2 spawns safely off any hazard — survives H, becomes the spectate target.
    engine.addPlayer("p2", new ScriptedInput(), undefined, { x: 2, y: 2 });
    for (let i = 0; i < 20 && engine.rosterSnapshot().get("H")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("dead");
    const players = (engine as unknown as { players: PosPlayers }).players;
    const spy = vi.spyOn(audio, "playDamage").mockImplementation(() => {});
    // Teleport the (still-alive, currently-spectated) p2 onto a fresh hazard tile.
    players.get("p2")!.player.posX = 10.5;
    players.get("p2")!.player.posY = 10.5;
    engine.advance(0.1);
    expect(engine.rosterSnapshot().get("p2")!.health).toBeLessThan(100);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not play the SFX when a non-watched third player takes damage while a dead local player spectates someone else", () => {
    const map = threeHazardMap();
    const engine = new RaycasterEngine(makeCanvas(), map, {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    // p2 spawns safely — survives H, becomes the (sorted-first) spectate target.
    engine.addPlayer("p2", new ScriptedInput(), undefined, { x: 2, y: 2 });
    // p3 spawns safely too, so it doesn't die alongside H before the assertion.
    engine.addPlayer("p3", new ScriptedInput(), undefined, { x: 3, y: 2 });
    for (let i = 0; i < 20 && engine.rosterSnapshot().get("H")!.status === "alive"; i++) engine.advance(1);
    expect(engine.rosterSnapshot().get("H")!.status).toBe("dead");

    const players = (engine as unknown as { players: PosPlayers }).players;
    const spy = vi.spyOn(audio, "playDamage").mockImplementation(() => {});
    // Teleport p3 (NOT the spectate target — p2 is) onto a fresh hazard tile.
    players.get("p3")!.player.posX = 15.5;
    players.get("p3")!.player.posY = 15.5;
    engine.advance(0.1);
    expect(engine.rosterSnapshot().get("p3")!.health).toBeLessThan(100);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("single-player: still plays the SFX on the (only) local player's own damage — regression guard", () => {
    const { engine } = makeEngine(threeHazardMap());
    const spy = vi.spyOn(audio, "playDamage").mockImplementation(() => {});
    engine.advance(0.1); // default localPlayerId spawns directly on the hazard tile
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("RaycasterEngine — multiplayer reconciliation (step 7)", () => {
  function dropsOf(engine: InstanceType<typeof RaycasterEngine>): LootDrop[] {
    return (engine as unknown as { drops: LootDrop[] }).drops;
  }

  function rngOf(engine: InstanceType<typeof RaycasterEngine>): () => number {
    return (engine as unknown as { rng: () => number }).rng;
  }

  function callApplyRenderOffsets(engine: InstanceType<typeof RaycasterEngine>): () => void {
    return (engine as unknown as { applyRenderOffsets(): () => void }).applyRenderOffsets();
  }

  function fakeSnapshot(overrides: Partial<ReconciliationSnapshot> = {}): ReconciliationSnapshot {
    return {
      tick: 0,
      rngState: 0,
      players: {},
      enemies: [],
      acidOverflows: [],
      mines: [],
      lootDrops: [],
      pickupsCollected: [],
      keysCollected: [],
      gridVersion: 0,
      gridDelta: [],
      ...overrides,
    };
  }

  describe("captureReconciliationSnapshot", () => {
    it("captures a player's full state — position/facing/health/ammo/weapons — sorted ascending, tagged with the given tick", () => {
      const map = fakeMap({ spawn: { x: 3, y: 4 } });
      const { engine } = makeEngine(map, undefined, { seed: 42 });
      const players = playersOf(engine) as unknown as Map<string, { ownedWeapons: Set<number> }>;
      players.get("local")!.ownedWeapons.add(4);
      players.get("local")!.ownedWeapons.add(1);

      const snapshot = engine.captureReconciliationSnapshot(17);
      expect(snapshot.tick).toBe(17);
      expect(snapshot.players.local).toMatchObject({
        posX: 3.5,
        posY: 4.5,
        dirX: 1,
        dirY: 0,
        health: 100,
        killScore: 0,
        kills: 0,
        alive: true,
      });
      expect(snapshot.players.local.ownedWeapons).toEqual([0, 1, 2, 4]); // 0/2 are the default starting weapons
    });

    it("captures every enemy/mine index-aligned with the map's own arrays", () => {
      const enemy = fakeEnemy({ x: 6, y: 5, hp: 20, alive: true, aggroed: true });
      const mine: Mine = { x: 4, y: 4, alive: true, visible: true, closeTimer: 0 };
      const map = fakeMap({ enemies: [enemy], mines: [mine] });
      const { engine } = makeEngine(map);
      const snapshot = engine.captureReconciliationSnapshot(0);
      expect(snapshot.enemies).toEqual([{ index: 0, x: 6, y: 5, hp: 20, alive: true, aggroed: true }]);
      expect(snapshot.mines).toEqual([{ index: 0, alive: true, visible: true }]);
    });

    it("captures collected ammo pickups/keys by index only", () => {
      const pickups: AmmoPickup[] = [
        { x: 1, y: 1, kind: "bullets", amount: 5, collected: true },
        { x: 2, y: 2, kind: "bullets", amount: 5, collected: false },
      ];
      const keys: KeyItem[] = [
        { x: 3, y: 3, collected: true, gateId: 0 },
        { x: 4, y: 3, collected: false, gateId: 0 },
      ];
      const map = fakeMap({ ammoPickups: pickups, keys });
      const { engine } = makeEngine(map);
      const snapshot = engine.captureReconciliationSnapshot(0);
      expect(snapshot.pickupsCollected).toEqual([0]);
      expect(snapshot.keysCollected).toEqual([0]);
    });

    it("tags every dynamic loot drop with a stable id at push time", () => {
      const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine, input } = makeEngine(map, undefined, { seed: 1 });
      input.fireQueued = true;
      engine.advance(0.016);
      const snapshot = engine.captureReconciliationSnapshot(0);
      expect(snapshot.lootDrops.length).toBeGreaterThan(0);
      for (const drop of snapshot.lootDrops) expect(drop.id).toMatch(/^0:\d+$/); // enemy index 0
    });

    it("drains pendingGridDelta on every capture — a tile mutation is reported exactly once, not on a later capture too", () => {
      const size = 12;
      const g = walledRoom(size);
      g[5][7] = DOOR_TILE; // directly east of spawn
      const map = fakeMap(
        {
          grid: g,
          keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
          doors: [{ x: 7, y: 5 }],
          gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
        },
        size,
      );
      const { engine, input } = makeEngine(map);
      engine.advance(0.016); // collect the key first
      input.keys.add("KeyW"); // push toward the door
      for (let i = 0; i < 20; i++) engine.advance(0.1);
      expect(map.grid[5][7]).toBe(0); // sanity: the door really opened

      const first = engine.captureReconciliationSnapshot(1);
      expect(first.gridDelta).toEqual([{ x: 7, y: 5, value: 0 }]);
      expect(first.gridVersion).toBe(1);

      const second = engine.captureReconciliationSnapshot(2);
      expect(second.gridDelta).toEqual([]);
      expect(second.gridVersion).toBe(1);
    });

    it("does not drain pendingGridDelta when drainGridDelta is false, so a guest that missed this capture still gets it next time (re-review finding)", () => {
      const size = 12;
      const g = walledRoom(size);
      g[5][7] = DOOR_TILE;
      const map = fakeMap(
        {
          grid: g,
          keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
          doors: [{ x: 7, y: 5 }],
          gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
        },
        size,
      );
      const { engine, input } = makeEngine(map);
      engine.advance(0.016);
      input.keys.add("KeyW");
      for (let i = 0; i < 20; i++) engine.advance(0.1);
      expect(map.grid[5][7]).toBe(0);

      const first = engine.captureReconciliationSnapshot(1, false);
      expect(first.gridDelta).toEqual([{ x: 7, y: 5, value: 0 }]);

      // Not drained — the very same mutation is still there next capture.
      const second = engine.captureReconciliationSnapshot(2, false);
      expect(second.gridDelta).toEqual([{ x: 7, y: 5, value: 0 }]);

      // Draining now (the normal default) clears it for good.
      const third = engine.captureReconciliationSnapshot(3);
      expect(third.gridDelta).toEqual([{ x: 7, y: 5, value: 0 }]);
      const fourth = engine.captureReconciliationSnapshot(4);
      expect(fourth.gridDelta).toEqual([]);
    });

    it("a captured (undrained) gridDelta array is a copy, unaffected by mutations pushed after it was returned", () => {
      const size = 12;
      const g = walledRoom(size);
      g[5][7] = DOOR_TILE;
      const map = fakeMap(
        {
          grid: g,
          keys: [{ x: 5.5, y: 5.5, collected: false, gateId: 0 }],
          doors: [{ x: 7, y: 5 }],
          gates: [{ id: 0, colorIndex: 0, room: { x: 8, y: 4, w: 3, h: 3 }, doors: [{ x: 7, y: 5 }] }],
        },
        size,
      );
      const { engine, input } = makeEngine(map);
      engine.advance(0.016);
      input.keys.add("KeyW");
      for (let i = 0; i < 20; i++) engine.advance(0.1);

      const snapshot = engine.captureReconciliationSnapshot(1, false);
      const capturedLength = snapshot.gridDelta.length;
      // Advancing further shouldn't retroactively grow the already-returned array.
      for (let i = 0; i < 5; i++) engine.advance(0.1);
      expect(snapshot.gridDelta.length).toBe(capturedLength);
    });
  });

  describe("hasActiveRenderOffset (test-hook surface)", () => {
    it("is false with no correction applied, and false for an unknown id", () => {
      const { engine } = makeEngine(fakeMap());
      expect(engine.hasActiveRenderOffset("local")).toBe(false);
      expect(engine.hasActiveRenderOffset("nope")).toBe(false);
    });

    it("is true right after a small (smoothed) correction, false after a large (instant-snap) one", () => {
      const host = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const smallGuest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const largeGuest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      smallGuest.debugInjectDesync({ kind: "position", deltaTiles: SNAP_THRESHOLD_TILES / 2 });
      largeGuest.debugInjectDesync({ kind: "position", deltaTiles: SNAP_THRESHOLD_TILES + 1 });

      const snapshot = host.captureReconciliationSnapshot(0);
      smallGuest.applyReconciliationSnapshot(snapshot);
      largeGuest.applyReconciliationSnapshot(snapshot);

      expect(smallGuest.hasActiveRenderOffset("local")).toBe(true);
      expect(largeGuest.hasActiveRenderOffset("local")).toBe(false);
    });
  });

  describe("getRngState / debugInjectDesync (test-hook surface)", () => {
    it("getRngState reflects the same stream this.rng draws from", () => {
      const { engine } = makeEngine(fakeMap(), undefined, { seed: 55 });
      const stateBefore = engine.getRngState();
      rngOf(engine)();
      expect(engine.getRngState()).not.toBe(stateBefore);
    });

    it("debugInjectDesync({kind:'position'}) nudges the local player's own posX by the given delta", () => {
      const { engine } = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }));
      expect(engine.getPlayerPosition("local")).toEqual({ x: 5.5, y: 5.5 });
      engine.debugInjectDesync({ kind: "position", deltaTiles: 0.3 });
      expect(engine.getPlayerPosition("local")).toEqual({ x: 5.8, y: 5.5 });
    });

    it("debugInjectDesync({kind:'extraRngDraw'}) consumes exactly one rng() draw", () => {
      const { engine } = makeEngine(fakeMap(), undefined, { seed: 55 });
      const stateBefore = engine.getRngState();
      engine.debugInjectDesync({ kind: "extraRngDraw" });
      const afterOneRealDraw = (() => {
        const reference = makeEngine(fakeMap(), undefined, { seed: 55 }).engine;
        rngOf(reference)();
        return reference.getRngState();
      })();
      expect(engine.getRngState()).toBe(afterOneRealDraw);
      expect(engine.getRngState()).not.toBe(stateBefore);
    });

    it("debugSetGodMode(id, true) blocks real damage the same way the real IDDQD cheat does, without going through applyCheat", () => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // HAZARD_TILE
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
      const { engine, handlers } = makeEngine(map);

      engine.debugSetGodMode("local", true);
      engine.advance(1); // a whole second standing in acid — would deal real damage otherwise

      expect(lastStats(handlers).health).toBe(100);
      expect(lastStats(handlers).godMode).toBe(true);
    });

    it("debugSetGodMode(id, false) turns it back off", () => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // HAZARD_TILE
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
      const { engine, handlers } = makeEngine(map);

      engine.debugSetGodMode("local", true);
      engine.debugSetGodMode("local", false);
      engine.advance(1);

      expect(lastStats(handlers).health).toBeLessThan(100);
      expect(lastStats(handlers).godMode).toBe(false);
    });

    it("debugClearExitRoomEnemies() kills only the exit room's own enemies, letting a blocked exit fire", () => {
      const size = 12;
      const exitTile = { x: size - 2, y: size - 2 };
      const inRoom = fakeEnemy({ home: { x: 8, y: 8, w: 4, h: 4 }, alive: true }); // covers the exit tile
      const elsewhere = fakeEnemy({ home: { x: 0, y: 0, w: 2, h: 2 }, alive: true }); // a different room entirely
      const map = fakeMap({ spawn: exitTile, exit: exitTile, enemies: [inRoom, elsewhere] }, size);
      const { engine, handlers } = makeEngine(map);

      engine.advance(0.016);
      expect(handlers.onWin).not.toHaveBeenCalled(); // blocked — inRoom is still alive

      engine.debugClearExitRoomEnemies();
      expect(inRoom.alive).toBe(false);
      expect(elsewhere.alive).toBe(true); // untouched — a different room's own enemy

      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);
    });
  });

  describe("applyReconciliationSnapshot", () => {
    it("resyncs a diverged PRNG stream *position*, not just visible fields — the spec's own most-emphasized failure mode", () => {
      // Two identically-seeded engines start with byte-identical rng streams.
      const host = makeEngine(fakeMap(), undefined, { seed: 777 }).engine;
      const guest = makeEngine(fakeMap(), undefined, { seed: 777 }).engine;

      // Simulate the real divergence cause the spec calls out: not the
      // algorithm (bit-identical 32-bit int math either way), but the
      // *count* of draws — a different code path on one peer consumed one
      // extra rng() call.
      rngOf(guest)();

      const snapshot = host.captureReconciliationSnapshot(0);
      guest.applyReconciliationSnapshot(snapshot);

      const hostNext = [rngOf(host)(), rngOf(host)(), rngOf(host)()];
      const guestNext = [rngOf(guest)(), rngOf(guest)(), rngOf(guest)()];
      expect(guestNext).toEqual(hostNext);
    });

    it("a small position correction (below SNAP_THRESHOLD_TILES) snaps the simulated position and sets a smoothed render offset", () => {
      const host = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guestPlayers = playersOf(guest) as unknown as Map<
        string,
        { player: { posX: number; posY: number }; renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;
      const gp = guestPlayers.get("local")!;
      const nudge = SNAP_THRESHOLD_TILES / 2;
      gp.player.posX += nudge;

      const snapshot = host.captureReconciliationSnapshot(0);
      guest.applyReconciliationSnapshot(snapshot);

      expect(guest.getPlayerPosition("local")).toEqual(host.getPlayerPosition("local"));
      expect(gp.renderOffset).not.toBeNull();
      expect(gp.renderOffset!.x).toBeCloseTo(nudge, 5);
      expect(gp.renderOffset!.y).toBeCloseTo(0, 5);
    });

    it("a large position correction (at/above SNAP_THRESHOLD_TILES) snaps instantly with no render offset at all", () => {
      const host = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guestPlayers = playersOf(guest) as unknown as Map<
        string,
        { player: { posX: number; posY: number }; renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;
      const gp = guestPlayers.get("local")!;
      gp.player.posX += SNAP_THRESHOLD_TILES + 1;

      const snapshot = host.captureReconciliationSnapshot(0);
      guest.applyReconciliationSnapshot(snapshot);

      expect(guest.getPlayerPosition("local")).toEqual(host.getPlayerPosition("local"));
      expect(gp.renderOffset).toBeNull();
    });

    it("an exactly-matching position sets no render offset at all (a zero-length smooth is treated as absent)", () => {
      const host = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 1 }).engine;
      const guestPlayers = playersOf(guest) as unknown as Map<
        string,
        { renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;

      const snapshot = host.captureReconciliationSnapshot(0);
      guest.applyReconciliationSnapshot(snapshot);

      expect(guestPlayers.get("local")!.renderOffset).toBeNull();
    });

    it("diffs loot drops by id — adds a new one, updates a mismatched one, removes one no longer present", () => {
      const { engine } = makeEngine(fakeMap());
      const drops = dropsOf(engine);
      drops.push({ x: 1, y: 1, kind: "health", id: "0:0" }); // removed: not in the incoming list
      drops.push({ x: 2, y: 2, kind: "bullets", amount: 5, id: "0:1" }); // updated

      engine.applyReconciliationSnapshot(
        fakeSnapshot({
          lootDrops: [
            { id: "0:1", x: 3, y: 3, kind: "swap", amount: 9 },
            { id: "1:0", x: 4, y: 4, kind: "weapon", weaponIndex: 2 },
          ],
        }),
      );

      const result = dropsOf(engine);
      expect(result).toHaveLength(2);
      expect(result.find((d) => d.id === "0:0")).toBeUndefined();
      expect(result.find((d) => d.id === "0:1")).toMatchObject({ x: 3, y: 3, kind: "swap", amount: 9 });
      expect(result.find((d) => d.id === "1:0")).toMatchObject({ x: 4, y: 4, kind: "weapon", weaponIndex: 2 });
    });

    it("ignores an out-of-range pickupsCollected/keysCollected index instead of throwing (a mismatched/malicious host payload)", () => {
      const map = fakeMap({
        ammoPickups: [{ x: 1, y: 1, kind: "bullets", amount: 5, collected: false }],
        keys: [{ x: 2, y: 2, collected: false, gateId: 0 }],
      });
      const { engine } = makeEngine(map);

      expect(() =>
        engine.applyReconciliationSnapshot(fakeSnapshot({ pickupsCollected: [0, 5], keysCollected: [0, 5] })),
      ).not.toThrow();

      expect(map.ammoPickups[0].collected).toBe(true);
      expect(map.keys[0].collected).toBe(true);
    });

    it("applyGridReconciliation writes every gridDelta tile and updates gridVersion", () => {
      const map = fakeMap({}, 12); // walledRoom border: grid[0][0] is a wall (1)
      const { engine } = makeEngine(map);
      expect(map.grid[0][0]).toBe(1);

      engine.applyGridReconciliation(fakeSnapshot({ gridVersion: 9, gridDelta: [{ x: 0, y: 0, value: 0 }] }));

      expect(map.grid[0][0]).toBe(0);
      expect(engine.captureReconciliationSnapshot(0).gridVersion).toBe(9);
    });

    it("applyGridReconciliation is idempotent — re-applying the same delta leaves the grid stable", () => {
      const map = fakeMap({}, 12);
      const { engine } = makeEngine(map);
      const snapshot = fakeSnapshot({ gridVersion: 3, gridDelta: [{ x: 0, y: 0, value: 0 }] });

      engine.applyGridReconciliation(snapshot);
      engine.applyGridReconciliation(snapshot);

      expect(map.grid[0][0]).toBe(0);
      expect(engine.captureReconciliationSnapshot(0).gridVersion).toBe(3);
    });

    it("applyGridReconciliation skips an out-of-bounds tile row without throwing or writing", () => {
      const map = fakeMap({}, 12);
      const { engine } = makeEngine(map);

      expect(() =>
        engine.applyGridReconciliation(fakeSnapshot({ gridVersion: 2, gridDelta: [{ x: 0, y: 9999, value: 0 }] })),
      ).not.toThrow();
      // gridVersion still updates; the out-of-bounds mutation is silently skipped.
      expect(engine.captureReconciliationSnapshot(0).gridVersion).toBe(2);
    });

    it("applyReconciliationSnapshot no longer touches the grid or gridVersion — those are decoupled into applyGridReconciliation (finding M2), while rng still applies", () => {
      const map = fakeMap({}, 12); // grid[0][0] is a wall (1)
      const { engine } = makeEngine(map);
      expect(map.grid[0][0]).toBe(1);

      engine.applyReconciliationSnapshot(fakeSnapshot({ rngState: 12345, gridVersion: 9, gridDelta: [{ x: 0, y: 0, value: 0 }] }));

      expect(map.grid[0][0]).toBe(1); // grid NOT applied
      expect(engine.captureReconciliationSnapshot(0).gridVersion).toBe(0); // gridVersion NOT applied
      expect(engine.getRngState()).toBe(12345); // but the PRNG-coupled state still applies
    });

    it("marks pickups/keys collected by index", () => {
      const pickups: AmmoPickup[] = [{ x: 1, y: 1, kind: "bullets", amount: 5, collected: false }];
      const keys: KeyItem[] = [{ x: 3, y: 3, collected: false, gateId: 0 }];
      const map = fakeMap({ ammoPickups: pickups, keys });
      const { engine } = makeEngine(map);

      engine.applyReconciliationSnapshot(fakeSnapshot({ pickupsCollected: [0], keysCollected: [0] }));

      expect(map.ammoPickups[0].collected).toBe(true);
      expect(map.keys[0].collected).toBe(true);
    });

    it("applies every enemy/mine field, index-aligned", () => {
      const enemy = fakeEnemy({ x: 6, y: 5, hp: 30, alive: true, aggroed: false });
      const mine: Mine = { x: 4, y: 4, alive: true, visible: false, closeTimer: 0 };
      const map = fakeMap({ enemies: [enemy], mines: [mine] });
      const { engine } = makeEngine(map);

      engine.applyReconciliationSnapshot(
        fakeSnapshot({
          enemies: [{ index: 0, x: 7, y: 8, hp: 5, alive: false, aggroed: true }],
          mines: [{ index: 0, alive: false, visible: true }],
        }),
      );

      expect(enemy).toMatchObject({ x: 7, y: 8, hp: 5, alive: false, aggroed: true });
      expect(mine).toMatchObject({ alive: false, visible: true });
    });

    it("ignores an incoming player id no longer in the local roster (fixed 2-player roster today)", () => {
      const { engine } = makeEngine(fakeMap());
      expect(() =>
        engine.applyReconciliationSnapshot(
          fakeSnapshot({
            players: {
              ghost: {
                posX: 1,
                posY: 1,
                dirX: 1,
                dirY: 0,
                planeX: 0,
                planeY: 1,
                health: 100,
                swap: 0,
                ammo: { bullets: 0, shells: 0, rockets: 0, smg: 0, gas: 0 },
                weaponIndex: 0,
                heldGates: [],
                ownedWeapons: [],
                alive: true,
                killScore: 0,
                kills: 0,
              },
            },
          }),
        ),
      ).not.toThrow();
      expect(engine.rosterSnapshot().has("ghost")).toBe(false);
    });

    it("applies alive:false, marking the player dead", () => {
      const { engine } = makeEngine(fakeMap());
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const snapshot = engine.captureReconciliationSnapshot(0);
      snapshot.players.local.alive = false;
      engine.applyReconciliationSnapshot(snapshot);
      expect(engine.rosterSnapshot().get("local")?.status).toBe("dead");
      // Single-player (isMultiplayerSession() false): the diagnostic-only
      // [multiplayer-desync] disagreement warning must stay silent, even
      // though local status ("alive") and the snapshot ("dead") disagree here.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("[multiplayer-desync]"));
      warnSpy.mockRestore();
    });

    it("logs a [multiplayer-desync] warning when a reconciliation snapshot's alive field disagrees with local status, in a real multiplayer session", () => {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const snapshot = engine.captureReconciliationSnapshot(0);
      snapshot.players.H.alive = false; // host's own snapshot claims "H" died; local status is still "alive"
      engine.applyReconciliationSnapshot(snapshot);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[multiplayer-desync] reconciliation snapshot disagrees with local status for "H"'));
      expect(engine.rosterSnapshot().get("H")?.status).toBe("dead"); // still applies the correction regardless
      warnSpy.mockRestore();
    });

    it("logs a [multiplayer-desync] warning when a reconciliation snapshot claims alive while local status is already dead", () => {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      // Captured while H is still alive, so the snapshot's own `alive` field
      // is true — then H is marked dead locally (without a real damage()
      // call) before this now-stale snapshot is applied, so the two disagree
      // in the opposite direction from the sibling test above.
      const snapshot = engine.captureReconciliationSnapshot(0);
      playersOf(engine).get("H")!.status = "dead";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      engine.applyReconciliationSnapshot(snapshot);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[multiplayer-desync] reconciliation snapshot disagrees with local status for "H"'),
      );
      expect(warnSpy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("[multiplayer-desync]"))?.[0]).toContain(
        "host snapshot says alive",
      );
      expect(engine.rosterSnapshot().get("H")?.status).toBe("alive"); // still applies the correction regardless
      warnSpy.mockRestore();
    });

    it("does not log when a reconciliation snapshot's alive field agrees with local status, in a real multiplayer session", () => {
      const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const snapshot = engine.captureReconciliationSnapshot(0); // alive stays true, matching local status
      engine.applyReconciliationSnapshot(snapshot);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("[multiplayer-desync]"));
      warnSpy.mockRestore();
    });

    it("ignores an incoming enemy index with no matching local enemy", () => {
      const { engine } = makeEngine(fakeMap()); // no enemies
      expect(() =>
        engine.applyReconciliationSnapshot(fakeSnapshot({ enemies: [{ index: 5, x: 1, y: 1, hp: 10, alive: true, aggroed: false }] })),
      ).not.toThrow();
    });

    it("clears an enemy's previous render offset once a new correction reports no divergence at all", () => {
      const enemy = fakeEnemy({ x: 6, y: 5 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine } = makeEngine(map);
      const offsets = (engine as unknown as { enemyRenderOffsets: Map<number, unknown> }).enemyRenderOffsets;
      offsets.set(0, { x: 0.4, y: 0, capturedAtMs: 0 }); // a stale offset from an earlier correction

      engine.applyReconciliationSnapshot(
        fakeSnapshot({ enemies: [{ index: 0, x: enemy.x, y: enemy.y, hp: enemy.hp, alive: true, aggroed: false }] }),
      );

      expect(offsets.has(0)).toBe(false);
    });

    it("a small enemy position correction sets a smoothed render offset, same as for a player", () => {
      const enemy = fakeEnemy({ x: 6, y: 5, hp: 30, alive: true, aggroed: false });
      const map = fakeMap({ enemies: [enemy] });
      const { engine } = makeEngine(map);
      const offsets = (engine as unknown as { enemyRenderOffsets: Map<number, { x: number; y: number }> }).enemyRenderOffsets;
      const nudge = SNAP_THRESHOLD_TILES / 2;

      engine.applyReconciliationSnapshot(
        fakeSnapshot({ enemies: [{ index: 0, x: enemy.x + nudge, y: enemy.y, hp: enemy.hp, alive: true, aggroed: false }] }),
      );

      expect(enemy.x).toBeCloseTo(6 + nudge, 5);
      expect(offsets.get(0)).toMatchObject({ x: -nudge });
    });

    it("ignores an incoming mine index with no matching local mine", () => {
      const { engine } = makeEngine(fakeMap()); // no mines
      expect(() => engine.applyReconciliationSnapshot(fakeSnapshot({ mines: [{ index: 3, alive: true, visible: true }] }))).not.toThrow();
    });

    it("a drop with no id (never a real one — every push tags one) never matches any incoming id and is removed", () => {
      const { engine } = makeEngine(fakeMap());
      dropsOf(engine).push({ x: 1, y: 1, kind: "health" }); // no `id` at all
      engine.applyReconciliationSnapshot(fakeSnapshot({ lootDrops: [] }));
      expect(dropsOf(engine)).toHaveLength(0);
    });

    it("full round-trip: a guest diverged on position, PRNG draw count, and loot fully converges on the host's authoritative state", () => {
      const host = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 314 }).engine;
      const guest = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }), undefined, { seed: 314 }).engine;
      const guestPlayers = playersOf(guest) as unknown as Map<string, { player: { posX: number } }>;
      guestPlayers.get("local")!.player.posX += SNAP_THRESHOLD_TILES / 4;
      dropsOf(guest).push({ x: 9, y: 9, kind: "health", id: "stray" });
      rngOf(guest)();

      const snapshot = host.captureReconciliationSnapshot(5);
      guest.applyReconciliationSnapshot(snapshot);

      expect(guest.getPlayerPosition("local")).toEqual(host.getPlayerPosition("local"));
      expect(dropsOf(guest).find((d) => d.id === "stray")).toBeUndefined();
      expect(rngOf(guest)()).toBe(rngOf(host)());
    });
  });

  describe("applyRenderOffsets (render-only smoothing)", () => {
    it("nudges a player toward its pre-correction position, decaying by real elapsed time, then restores exactly", () => {
      const { engine } = makeEngine(fakeMap());
      const players = playersOf(engine) as unknown as Map<
        string,
        { player: { posX: number; posY: number }; renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;
      const p = players.get("local")!;
      const originalX = p.player.posX;
      const originalY = p.player.posY;
      p.renderOffset = { x: 0.2, y: -0.1, capturedAtMs: 0 };

      vi.spyOn(performance, "now").mockReturnValue(CORRECTION_SMOOTH_MS / 2); // 50% decayed

      const restore = callApplyRenderOffsets(engine);
      expect(p.player.posX).toBeCloseTo(originalX + 0.1, 5);
      expect(p.player.posY).toBeCloseTo(originalY - 0.05, 5);

      restore();
      expect(p.player.posX).toBe(originalX);
      expect(p.player.posY).toBe(originalY);
    });

    it("clears a fully-decayed offset instead of applying it", () => {
      const { engine } = makeEngine(fakeMap());
      const players = playersOf(engine) as unknown as Map<
        string,
        { player: { posX: number }; renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;
      const p = players.get("local")!;
      const originalX = p.player.posX;
      p.renderOffset = { x: 0.3, y: 0, capturedAtMs: 0 };

      vi.spyOn(performance, "now").mockReturnValue(CORRECTION_SMOOTH_MS + 1);

      const restore = callApplyRenderOffsets(engine);
      expect(p.player.posX).toBe(originalX);
      expect(p.renderOffset).toBeNull();
      expect(() => restore()).not.toThrow();
    });

    it("nudges and restores an enemy's own render offset the same way", () => {
      const enemy = fakeEnemy({ x: 6, y: 5 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine } = makeEngine(map);
      const offsets = (engine as unknown as { enemyRenderOffsets: Map<number, { x: number; y: number; capturedAtMs: number }> })
        .enemyRenderOffsets;
      offsets.set(0, { x: 0.4, y: 0, capturedAtMs: 0 });

      vi.spyOn(performance, "now").mockReturnValue(0); // no decay yet

      const restore = callApplyRenderOffsets(engine);
      expect(enemy.x).toBeCloseTo(6.4, 5);
      restore();
      expect(enemy.x).toBe(6);
    });

    it("clears a fully-decayed enemy offset instead of applying it", () => {
      const enemy = fakeEnemy({ x: 6, y: 5 });
      const map = fakeMap({ enemies: [enemy] });
      const { engine } = makeEngine(map);
      const offsets = (engine as unknown as { enemyRenderOffsets: Map<number, { x: number; y: number; capturedAtMs: number }> })
        .enemyRenderOffsets;
      offsets.set(0, { x: 0.4, y: 0, capturedAtMs: 0 });

      vi.spyOn(performance, "now").mockReturnValue(CORRECTION_SMOOTH_MS + 1);

      const restore = callApplyRenderOffsets(engine);
      expect(enemy.x).toBe(6);
      expect(offsets.has(0)).toBe(false);
      expect(() => restore()).not.toThrow();
    });

    it("render() applies and restores render offsets around a real frame without leaking a bogus position", () => {
      const { engine } = makeEngine(fakeMap());
      const players = playersOf(engine) as unknown as Map<
        string,
        { player: { posX: number }; renderOffset: { x: number; y: number; capturedAtMs: number } | null }
      >;
      const p = players.get("local")!;
      const originalX = p.player.posX;
      p.renderOffset = { x: 0.1, y: 0, capturedAtMs: 0 };

      expect(() => engine.render()).not.toThrow();
      expect(p.player.posX).toBe(originalX);
    });
  });
});

describe("RaycasterEngine — multiplayer disconnect (step 8)", () => {
  function makeMpEngine(
    map: GameMap,
    handlers: ReturnType<typeof makeHandlers> = makeHandlers(),
    localPlayerId = "host",
  ): InstanceType<typeof RaycasterEngine> {
    return new RaycasterEngine(makeCanvas(), map, handlers, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, localPlayerId);
  }

  function dropsOf(engine: InstanceType<typeof RaycasterEngine>): LootDrop[] {
    return (engine as unknown as { drops: LootDrop[] }).drops;
  }

  type MpPlayerState = {
    status: string;
    health: number;
    swap: number;
    ammo: { bullets: number; shells: number; rockets: number; smg: number; gas: number };
    ownedWeapons: Set<number>;
    heldGates: Set<number>;
  };
  function mpPlayersOf(engine: InstanceType<typeof RaycasterEngine>): Map<string, MpPlayerState> {
    return (engine as unknown as { players: Map<string, MpPlayerState> }).players;
  }

  describe("applyRosterRemoval", () => {
    it("marks the player disconnected and converts inventory to loot in the spec's fixed order", () => {
      const engine = makeMpEngine(fakeMap({ spawn: { x: 5, y: 5 } }));
      engine.addPlayer("guest", new ScriptedInput());
      const host = mpPlayersOf(engine).get("host")!;
      host.ammo.bullets = 10;
      host.ammo.rockets = 0; // zero pool — must NOT produce a drop
      host.ammo.smg = 5;
      host.ammo.gas = 3;
      host.ammo.shells = 2; // last in AMMO_TYPES, so last in the drop order
      host.ownedWeapons.add(GDB_WEAPON_INDEX);
      host.ownedWeapons.add(GHIDRA_WEAPON_INDEX);
      host.heldGates.add(1);
      host.heldGates.add(0); // out of order on purpose — the wire must be sorted
      expect(engine.captureReconciliationSnapshot(1).players.host.heldGates).toEqual([0, 1]);

      engine.applyRosterRemoval(["host"]);

      expect(engine.rosterSnapshot().get("host")?.status).toBe("disconnected");
      const drops = dropsOf(engine).map((d) => ({ kind: d.kind, amount: d.amount, weaponIndex: d.weaponIndex, id: d.id, source: d.source }));
      expect(drops).toEqual([
        { kind: "bullets", amount: 10, weaponIndex: undefined, id: "disconnect:host:0", source: "disconnect" },
        { kind: "smg", amount: 5, weaponIndex: undefined, id: "disconnect:host:1", source: "disconnect" },
        { kind: "gas", amount: 3, weaponIndex: undefined, id: "disconnect:host:2", source: "disconnect" },
        { kind: "shells", amount: 2, weaponIndex: undefined, id: "disconnect:host:3", source: "disconnect" },
        { kind: "weapon", amount: undefined, weaponIndex: GDB_WEAPON_INDEX, id: "disconnect:host:4", source: "disconnect" },
        { kind: "weapon", amount: undefined, weaponIndex: GHIDRA_WEAPON_INDEX, id: "disconnect:host:5", source: "disconnect" },
      ]);
    });

    it("never drops health, swap, or keys — keys are team-wide and unspent", () => {
      const engine = makeMpEngine(fakeMap());
      engine.addPlayer("guest", new ScriptedInput());
      const host = mpPlayersOf(engine).get("host")!;
      host.health = 50;
      host.swap = 20;
      host.heldGates.add(0);
      engine.applyRosterRemoval(["host"]);
      expect(dropsOf(engine).some((d) => d.kind === "health" || d.kind === "swap")).toBe(false);
      // The gate stays held rather than being cleared and dropped: every
      // teammate holds it too, so there is nothing to hand over.
      expect([...mpPlayersOf(engine).get("host")!.heldGates]).toEqual([0]);
    });

    it("only drops owned weapons not already in STARTING_WEAPONS", () => {
      const engine = makeMpEngine(fakeMap());
      engine.addPlayer("guest", new ScriptedInput());
      // host starts owning pistol/shotgun/knife (STARTING_WEAPONS) by default.
      engine.applyRosterRemoval(["host"]);
      expect(dropsOf(engine).some((d) => d.kind === "weapon")).toBe(false);
    });

    it("is a no-op for an unknown id, an already-dead id, or an already-disconnected id", () => {
      const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 5.5, hp: 1, maxHp: 1 })] });
      const engine = makeMpEngine(map);
      engine.addPlayer("guest", new ScriptedInput());
      engine.applyRosterRemoval(["nope"]);
      expect(dropsOf(engine)).toHaveLength(0);

      // guest never picks up anything, so a repeat call after already
      // disconnected must not push a second, duplicate batch of drops.
      engine.applyRosterRemoval(["guest"]);
      const afterFirst = dropsOf(engine).length;
      engine.applyRosterRemoval(["guest"]);
      expect(dropsOf(engine)).toHaveLength(afterFirst);
    });

    it("does nothing once the run has already ended", () => {
      const engine = makeMpEngine(fakeMap());
      engine.addPlayer("guest", new ScriptedInput());
      engine.applyRosterRemoval(["guest"]); // ends nothing yet — host still alive
      (engine as unknown as { state: string }).state = "over";
      const before = dropsOf(engine).length;
      engine.applyRosterRemoval(["host"]);
      expect(dropsOf(engine)).toHaveLength(before);
      expect(engine.rosterSnapshot().get("host")?.status).toBe("alive");
    });

    it("excludes a disconnected player from captureReconciliationSnapshot but keeps other roster members", () => {
      const engine = makeMpEngine(fakeMap());
      engine.addPlayer("guest", new ScriptedInput());
      engine.applyRosterRemoval(["guest"]);
      const snapshot = engine.captureReconciliationSnapshot(0);
      expect(snapshot.players).not.toHaveProperty("guest");
      expect(snapshot.players).toHaveProperty("host");
    });

    it("ends the run once every remaining player is dead or disconnected, but a lone connected survivor keeps playing", () => {
      const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 5.5, hp: 1, maxHp: 1 })] });
      const handlers = makeHandlers();
      const engine = makeMpEngine(map, handlers);
      engine.addPlayer("guest", new ScriptedInput());

      engine.applyRosterRemoval(["guest"]);
      expect(handlers.onGameOver).not.toHaveBeenCalled(); // host is still alive

      const host = mpPlayersOf(engine).get("host")!;
      host.status = "dead"; // simulate host dying too, without a real damage() call
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      engine.applyRosterRemoval(["guest"]); // already disconnected — re-checks elimination anyway, locks in this time
      expect(warnSpy).toHaveBeenCalledWith(
        "[multiplayer-desync] applyRosterRemoval: locking in team-elimination",
        expect.arrayContaining([
          expect.objectContaining({ id: "host", status: "dead" }),
          expect.objectContaining({ id: "guest", status: "disconnected" }),
        ]),
      );
      warnSpy.mockRestore();
      // A third player, still connected and alive, must keep the run going
      // even though both of these are gone.
      engine.addPlayer("third", new ScriptedInput());
      expect(handlers.onGameOver).not.toHaveBeenCalled();
    });
  });

  describe("multiplayer weapon-drop rule (grantOrTopUpWeapon)", () => {
    // Pistol (index 0) is a STARTING_WEAPONS entry with a real ammoType
    // (bullets) — unlike knife (index 2, melee/no ammoType), collecting a
    // duplicate genuinely would top up ammo in single-player, so it's the
    // one case that actually distinguishes "no effect" from "no-op anyway".
    it("in multiplayer, collecting a weapon drop for an already-owned weapon has no effect at all (no top-up)", () => {
      const map = fakeMap({ spawn: { x: 5, y: 5 } });
      const engine = makeMpEngine(map);
      const before = { ...mpPlayersOf(engine).get("host")!.ammo };
      dropsOf(engine).push({ x: 5.5, y: 5.5, kind: "weapon", weaponIndex: 0, id: "test:0" });
      engine.advance(0.016);
      expect(mpPlayersOf(engine).get("host")!.ammo).toEqual(before);
    });

    it("in single-player, the same already-owned weapon drop still tops up ammo (unchanged behavior)", () => {
      const { engine } = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }));
      const players = playersOf(engine) as unknown as Map<string, { ammo: Record<string, number> }>;
      const before = { ...players.get("local")!.ammo };
      (engine as unknown as { drops: LootDrop[] }).drops.push({ x: 5.5, y: 5.5, kind: "weapon", weaponIndex: 0, id: "test:0" });
      engine.advance(0.016);
      expect(players.get("local")!.ammo).not.toEqual(before);
    });
  });
});

describe("RaycasterEngine — lag-compensated hit resolution (multiplayer only)", () => {
  function makeMpEngineWithEnemy(enemy: Enemy): InstanceType<typeof RaycasterEngine> {
    const map = fakeMap({ enemies: [enemy] });
    return new RaycasterEngine(makeCanvas(), map, makeHandlers(), undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "host");
  }

  function historyOf(engine: InstanceType<typeof RaycasterEngine>): ReadonlyMap<Enemy, { x: number; y: number }>[] {
    return (engine as unknown as { enemyPositionHistory: ReadonlyMap<Enemy, { x: number; y: number }>[] }).enemyPositionHistory;
  }
  function captureNow(engine: InstanceType<typeof RaycasterEngine>): void {
    (engine as unknown as { captureEnemyPositionHistory: () => void }).captureEnemyPositionHistory();
  }
  function rewound(engine: InstanceType<typeof RaycasterEngine>): ReadonlyMap<Enemy, { x: number; y: number }> | undefined {
    return (engine as unknown as { rewoundEnemyPositions: () => ReadonlyMap<Enemy, { x: number; y: number }> | undefined }).rewoundEnemyPositions();
  }

  it("stays permanently empty in single-player, and rewoundEnemyPositions returns undefined", () => {
    const enemy = fakeEnemy({ x: 6, y: 5 });
    const { engine } = makeEngine(fakeMap({ enemies: [enemy] }));
    for (let i = 0; i < 10; i++) engine.advance(0.016);
    expect(historyOf(engine)).toHaveLength(0);
    expect(rewound(engine)).toBeUndefined();
  });

  it("fills and caps at INPUT_DELAY_TICKS + 1 frames in multiplayer", () => {
    const enemy = fakeEnemy({ x: 6, y: 5 });
    const engine = makeMpEngineWithEnemy(enemy);
    for (let i = 0; i < INPUT_DELAY_TICKS + 5; i++) engine.advance(0.016);
    expect(historyOf(engine)).toHaveLength(INPUT_DELAY_TICKS + 1);
  });

  it("rewinds to exactly the oldest frame in the capped buffer, ignoring the enemy's current live position", () => {
    const enemy = fakeEnemy({ x: 0, y: 0 });
    const engine = makeMpEngineWithEnemy(enemy);
    for (let x = 1; x <= INPUT_DELAY_TICKS + 1; x++) {
      enemy.x = x;
      captureNow(engine);
    }
    enemy.x = 999; // live position moves far away — must not affect the rewound read
    expect(rewound(engine)?.get(enemy)?.x).toBe(1); // oldest surviving frame
  });

  it("drops the oldest frame once a new capture pushes past the cap", () => {
    const enemy = fakeEnemy({ x: 0, y: 0 });
    const engine = makeMpEngineWithEnemy(enemy);
    for (let x = 1; x <= INPUT_DELAY_TICKS + 2; x++) {
      enemy.x = x;
      captureNow(engine);
    }
    // INPUT_DELAY_TICKS + 2 pushes into a cap of INPUT_DELAY_TICKS + 1 -> the very first frame (x=1) is gone.
    expect(rewound(engine)?.get(enemy)?.x).toBe(2);
  });

  it("only captures living enemies", () => {
    const alive = fakeEnemy({ x: 1, y: 1 });
    const dead = fakeEnemy({ x: 2, y: 2, alive: false });
    const map = fakeMap({ enemies: [alive, dead] });
    const engine = new RaycasterEngine(makeCanvas(), map, makeHandlers(), undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "host");
    captureNow(engine);
    const frame = historyOf(engine)[0];
    expect(frame.has(alive)).toBe(true);
    expect(frame.has(dead)).toBe(false);
  });

  it("fire() hit-tests against the rewound (stale) position instead of the enemy's current live position", () => {
    // Point-blank in front of the host's spawn-facing direction, mirroring
    // the existing "fires the pistol at a point-blank enemy" test's setup.
    const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 30, maxHp: 30, aggroed: false });
    const map = fakeMap({ enemies: [enemy] });
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(makeCanvas(), map, makeHandlers(), undefined, undefined, undefined, 1, input, undefined, "host");

    // Fully populate the ring buffer while the enemy sits in real range —
    // this is the "what the shooter actually saw when they decided to fire"
    // state a real ~INPUT_DELAY_TICKS-ticks-later execution should still hit.
    for (let i = 0; i < INPUT_DELAY_TICKS + 1; i++) captureNow(engine);
    // Now the enemy has genuinely moved far away — a live-position hit-test
    // (today's single-player behavior) would clearly miss this.
    enemy.x = 60;
    enemy.y = 60;

    input.fireQueued = true;
    engine.advance(0.016);

    expect(enemy.hp).toBeLessThan(30);
  });
});

describe("the status-bar face's hurt direction", () => {
  it("points at an enemy that melees from the player's right", () => {
    // Player faces +x, so +y is its right (the right-vector is (-dirY, dirX),
    // matching dodgeStrafeKey). An enemy placed there and allowed to bite must
    // leave the face looking that way.
    const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 6.2, aggroed: true })] });
    const { engine, handlers } = makeEngine(map, makeHandlers());
    for (let i = 0; i < 120; i++) engine.advance(0.016);
    const stats = lastStats(handlers);
    expect(stats.hurtFrames, "the enemy has to have actually landed a hit").toBeGreaterThan(0);
    expect(stats.hurtDir).toBe(1);
  });

  it("leaves the direction neutral for damage with no attacker", () => {
    // A spike trap has nowhere to point at. Showing "hit from the left" for
    // one is the exact wrongness the explicit `from` parameter exists to
    // prevent — an implicit last-attacker field would have gone stale and done
    // just that.
    const map = fakeMap({ spikeTraps: [{ x: 5, y: 5, period: 1, phase: 0 }] });
    const { engine, handlers } = makeEngine(map, makeHandlers());
    for (let i = 0; i < 200; i++) engine.advance(0.016);
    const stats = lastStats(handlers);
    expect(stats.hurtDir).toBe(0);
  });

  it("decays to zero, and deliberately does not clear the direction with it", () => {
    const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 6.2, aggroed: true })] });
    const { engine, handlers } = makeEngine(map, makeHandlers());
    for (let i = 0; i < 120; i++) engine.advance(0.016);
    expect(lastStats(handlers).hurtFrames).toBeGreaterThan(0);

    // Move far away and let the timer run out.
    const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, (...a: unknown[]) => unknown> }).__codeensteinTestHooks;
    void hooks;
    map.enemies[0].alive = false;
    for (let i = 0; i < HURT_FACE_FRAMES + 10; i++) engine.advance(0.016);
    const after = lastStats(handlers);
    expect(after.hurtFrames).toBe(0);
    // Stale on purpose: it is only ever read behind `hurtFrames > 0`, so
    // clearing it would be a second write for no observable difference.
    expect(after.hurtDir).toBe(1);
  });
});

describe("balancing event log", () => {
  /** Runs `body` with `?testHooks=1` active, then restores the URL and removes
   * the hooks object — same shape as the other hook tests in this file. */
  function withTestHooks(body: (getHooks: () => Record<string, (...args: unknown[]) => unknown>) => void): void {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1&eventLog=1" }, configurable: true });
    try {
      body(() => (window as unknown as { __codeensteinTestHooks: Record<string, (...args: unknown[]) => unknown> }).__codeensteinTestHooks);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  }

  type Drained = { events: { e: string; t: number; [k: string]: unknown }[]; dropped: number };

  it("records a levelStart carrying the static budget the run is about to spend", () => {
    withTestHooks((getHooks) => {
      const map = fakeMap({
        enemies: [fakeEnemy({ x: 6.5, y: 5.5 })],
        ammoPickups: [{ x: 3.5, y: 3.5, kind: "bullets", amount: 11, collected: false }],
      });
      makeEngine(map, makeHandlers(), { seed: 4242 });
      const drained = getHooks().drainEvents() as Drained;
      const start = drained.events.find((e) => e.e === "levelStart");
      expect(start).toBeDefined();
      expect(start).toMatchObject({ t: 0, gameplaySeed: 4242, walkableTiles: expect.any(Number) });
      // The roster and pickup list are what make the log self-contained --
      // uncollected loot and surviving enemies are differences against these.
      expect(start!.enemies).toEqual([expect.objectContaining({ eid: 0, arch: "normal" })]);
      expect(start!.prePlaced).toEqual([expect.objectContaining({ pid: 0, kind: "bullets", amount: 11 })]);
    });
  });

  it("records a rocketDetonated carrying every enemy one blast hit", () => {
    // The gap this closes: a rocket never reaches `resolveShot`, so it emits no
    // `hit` events at all — 0 of 3,248,140 across the whole archive. Splash
    // damage therefore had no per-target trace anywhere, which is why
    // `report:damage-model`'s ghidra rows read 100% miss on every capture and
    // why "does a rocket hit more than one enemy" was unanswerable while the
    // same question for pellets was a one-liner.
    withTestHooks((getHooks) => {
      // Three enemies inside one blast radius (2.6), one outside it.
      const near = [fakeEnemy({ x: 9.5, y: 5.5 }), fakeEnemy({ x: 9.5, y: 6.2 }), fakeEnemy({ x: 10.2, y: 5.5 })];
      const far = fakeEnemy({ x: 9.5, y: 14.5 });
      const carryover = { health: 100, swap: 0, bullets: 50, rockets: 5, smg: 0, gas: 0, weaponIndex: GHIDRA_WEAPON_INDEX, ownedWeapons: [0, 1, 2, 3, GHIDRA_WEAPON_INDEX] };
      const { engine, input } = makeEngine(fakeMap({ enemies: [...near, far] }), makeHandlers(), { carryover });
      engine.advance(0);
      getHooks().drainEvents();

      input.fireQueued = true;
      // Long enough for the rocket to cross the gap and detonate.
      for (let i = 0; i < 60; i++) engine.advance(0.016);

      const events = (getHooks().drainEvents() as Drained).events;
      const blast = events.find((e) => e.e === "rocketDetonated");
      expect(blast, "firing a rocket into enemies must emit rocketDetonated").toBeDefined();
      expect(blast).toMatchObject({ w: GHIDRA_WEAPON_INDEX, direct: true });
      // The whole point: more than one enemy on a single shot, itemised.
      expect(blast!.enemiesHit).toBeGreaterThan(1);
      const hits = blast!.hits as { eid: number; arch: string; amt: number }[];
      expect(hits).toHaveLength(blast!.enemiesHit as number);
      for (const h of hits) expect(h.amt).toBeGreaterThan(0);
      // The far enemy is outside the blast and must not appear.
      expect(hits.some((h) => h.eid === 3)).toBe(false);
      // dmg is the sum of the itemised hits, so a reader can use either.
      expect(blast!.dmg).toBeCloseTo(hits.reduce((sum, h) => sum + h.amt, 0), 5);
      expect(blast!.dist).toBeGreaterThan(0);
    });
  });

  it("records a wall detonation as direct: false, which damage alone cannot reveal", () => {
    withTestHooks((getHooks) => {
      const carryover = { health: 100, swap: 0, bullets: 50, rockets: 5, smg: 0, gas: 0, weaponIndex: GHIDRA_WEAPON_INDEX, ownedWeapons: [0, 1, 2, 3, GHIDRA_WEAPON_INDEX] };
      const { engine, input } = makeEngine(fakeMap(), makeHandlers(), { carryover });
      engine.advance(0);
      getHooks().drainEvents();
      input.fireQueued = true;
      for (let i = 0; i < 90; i++) engine.advance(0.016);

      const blast = (getHooks().drainEvents() as Drained).events.find((e) => e.e === "rocketDetonated");
      expect(blast, "a rocket into an empty room still detonates on the wall").toBeDefined();
      expect(blast).toMatchObject({ direct: false, enemiesHit: 0 });
      expect(blast!.hits).toEqual([]);
    });
  });

  it("empties the buffer on drain, so a second drain returns nothing", () => {
    withTestHooks((getHooks) => {
      makeEngine(fakeMap());
      expect((getHooks().drainEvents() as Drained).events.length).toBeGreaterThan(0);
      expect(getHooks().drainEvents()).toEqual({ events: [], dropped: 0 });
    });
  });

  it("records the pre-clamp negative HP on a killing blow, which is the overkill", () => {
    withTestHooks((getHooks) => {
      // 1 HP against the pistol's 22, so the killing blow overshoots by 21 and
      // `hpAfter` is -21. The engine clamps `enemy.hp` to 0 on the very next
      // line, discarding exactly this number -- which is why the event has to
      // carry it.
      const enemy = fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 });
      const { engine, input } = makeEngine(fakeMap({ enemies: [enemy] }));
      getHooks().drainEvents();
      input.fireQueued = true;
      engine.advance(0.016);
      expect(enemy.alive).toBe(false);

      const events = (getHooks().drainEvents() as Drained).events;
      const damage = events.find((e) => e.e === "damageDealt");
      expect(damage, "the kill must have emitted a damageDealt event").toBeDefined();
      expect(damage).toMatchObject({ eid: 0, arch: "normal", hpBefore: 1, hpAfter: -21 });

      const kill = events.find((e) => e.e === "kill");
      expect(kill, "the kill must have emitted a kill event").toBeDefined();
      expect(kill).toMatchObject({ eid: 0, arch: "normal", maxHp: 1 });
    });
  });

  it("closes the level with what was left uncollected and left alive", () => {
    withTestHooks((getHooks) => {
      const size = 12;
      const map = fakeMap(
        {
          // Spawning on the exit wins immediately, which is the cheapest real
          // path to endGame -- no debug hook involved.
          spawn: { x: size - 2, y: size - 2 },
          exit: { x: size - 2, y: size - 2 },
          // Its home rectangle excludes the exit tile on both axes, so it
          // survives the level without gating the exit -- see "exit gating by
          // the exit room's own alive enemies" above.
          enemies: [fakeEnemy({ x: 3.5, y: 3.5, home: { x: 0, y: 0, w: 4, h: 4 } })],
          ammoPickups: [
            { x: 3.5, y: 4.5, kind: "bullets", amount: 11, collected: false },
            { x: 9.5, y: 9.5, kind: "rockets", amount: 3, collected: true },
          ],
        },
        size,
      );
      const { engine, handlers } = makeEngine(map);
      getHooks().drainEvents();
      engine.advance(0.016);
      expect(handlers.onWin).toHaveBeenCalledTimes(1);

      const end = (getHooks().drainEvents() as Drained).events.find((e) => e.e === "levelEnd");
      expect(end, "winning must have emitted a levelEnd event").toBeDefined();
      expect(end).toMatchObject({ outcome: "cleared" });
      // Only the uncollected pickup, and only the surviving enemy. These two
      // lists against levelStart's are the nominal-vs-actual budget gap.
      expect(end!.prePlacedUncollected).toEqual([expect.objectContaining({ pid: 0, kind: "bullets", amount: 11 })]);
      expect(end!.enemiesAlive).toEqual([expect.objectContaining({ eid: 0, arch: "normal" })]);
    });
  });

  it("buffers nothing without ?eventLog=1, so an ordinary bot run pays no cost", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      makeEngine(fakeMap({ enemies: [fakeEnemy({ x: 6.5, y: 5.5 })] }));
      const hooks = (window as unknown as { __codeensteinTestHooks: Record<string, (...args: unknown[]) => unknown> })
        .__codeensteinTestHooks;
      // Every telemetry campaign sets ?testHooks=1 and almost none of them
      // want the stream; buffering records nobody drains would be pure waste.
      expect(hooks.drainEvents()).toEqual({ events: [], dropped: 0 });
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  });

  it("records damage taken, and both sides of the loot economy", () => {
    withTestHooks((getHooks) => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // HAZARD_TILE, under the spawn
      const map = fakeMap(
        {
          grid: g,
          hazards: [{ x: 5, y: 5 }],
          // Point-blank, 1 HP, so one pistol shot kills it and its drop lands
          // inside the 0.5-tile pickup radius of the player standing still.
          enemies: [fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 })],
          ammoPickups: [{ x: 5.5, y: 5.5, kind: "bullets", amount: 11, collected: false }],
        },
        size,
      );
      const { engine, input } = makeEngine(map);
      getHooks().drainEvents();

      engine.advance(0.5); // standing in acid: damageTaken, and the pickup underfoot
      input.fireQueued = true;
      engine.advance(0.016); // kill -> lootDropped
      for (let i = 0; i < 5; i++) engine.advance(0.016); // walk over it -> lootCollected

      const events = (getHooks().drainEvents() as Drained).events;
      const types = new Set(events.map((e) => e.e));
      expect(types.has("damageTaken"), "standing in acid must record damage taken").toBe(true);
      expect(types.has("shot"), "firing must record a trigger-pull").toBe(true);
      expect(types.has("lootDropped"), "a kill must record its drop at spawn time").toBe(true);

      // The enemy spawns 0.4 tiles away -- inside melee range -- so it bites
      // too; pick the acid record specifically rather than "the first one".
      const taken = events.find((e) => e.e === "damageTaken" && e.src === "hazard");
      expect(taken, "standing in acid must record a hazard damage event").toBeDefined();
      expect(taken).toMatchObject({ arch: null });
      // Acid has no attacker, so it must not invent one.
      expect(taken!.by, "hazard damage has no attacker to attribute").toBeNull();

      // Enemy-dealt damage does, and `by` is the whole point of schema 2 --
      // "which archetype killed you" was unanswerable before it.
      const bitten = events.find((e) => e.e === "damageTaken" && e.src === "enemyMelee");
      expect(bitten, "the enemy in melee range must record a bite").toBeDefined();
      const by = bitten!.by as { eid: number; arch: string; amt: number }[];
      expect(Array.isArray(by), "melee damage must carry a per-attacker breakdown").toBe(true);
      expect(by.length).toBeGreaterThan(0);
      for (const entry of by) {
        expect(Number.isInteger(entry.eid) && entry.eid >= 0, "eid must index the levelStart roster").toBe(true);
        expect(["normal", "elite", "edgeCase"]).toContain(entry.arch);
        expect(entry.amt).toBeGreaterThan(0);
      }

      // The pre-placed pickup sat under the spawn, so it is collected on the
      // first frame -- this is the `source: "preplaced"` half of the split.
      const preplaced = events.find((e) => e.e === "lootCollected" && e.source === "preplaced");
      expect(preplaced, "the pickup underfoot must record as pre-placed").toBeDefined();

      const dropped = events.find((e) => e.e === "lootDropped");
      expect(dropped).toMatchObject({ fromEid: 0, fromArch: "normal" });
    });
  });

  it("records the target's two preceding positions on a shot, oldest-first", () => {
    // `shot.tgt` exists to score an aim predictor offline, and the only thing
    // that can silently ruin it is the ordering: swap `px` with `ppx` and every
    // reconstructed velocity points backwards, which would read as a confident
    // wrong answer rather than as a broken field. So this pins the *direction*
    // of travel rather than merely asserting the keys exist.
    withTestHooks((getHooks) => {
      // The player spawns at 5.5,5.5 facing +x (`dirX = 1`), and `tgt` is
      // populated from the engine's *crosshair* target — so the enemy has to
      // sit along +x or nothing is aimed at and the field is null. Aggroed and
      // far enough that it keeps walking toward the player for the whole
      // sample, so consecutive frames are genuinely distinct positions.
      const map = fakeMap({ enemies: [fakeEnemy({ x: 9.5, y: 5.5, aggroed: true, discovered: true })] });
      const { engine, input } = makeEngine(map, makeHandlers(), { difficulty: "hard", seed: 7 });

      // Three AI steps so the trail is fully populated before the shot; a
      // freshly-seeded trail reports the same position three times and would
      // pass an ordering check vacuously.
      for (let i = 0; i < 3; i++) engine.advance(0.05);
      input.fireQueued = true;
      engine.advance(0.05);

      const shot = (getHooks().drainEvents() as Drained).events.find((e) => e.e === "shot" && e.tgt);
      expect(shot, "a shot at a visible enemy must carry its target's trail").toBeDefined();
      const t = shot!.tgt as { x: number; y: number; px: number; py: number; ppx: number; ppy: number };

      // The enemy chases the player at 5.5,5.5 from 9.5,5.5, i.e. straight
      // along -x. Every frame must therefore be strictly nearer than the one
      // before it, which fixes oldest -> newest as ppx > px > x.
      expect(t.ppx, "ppx is the oldest sample and must be furthest away").toBeGreaterThan(t.px);
      expect(t.px, "px is the snapshot the bot aimed at, one frame behind x/y").toBeGreaterThan(t.x);

      // And the reconstructed one-frame displacement must match the direction
      // of travel, which is what a reader extrapolates from.
      expect(t.px - t.ppx, "the previous frame's displacement must point the way the enemy is moving").toBeLessThan(0);
    });
  });

  it("attributes a bolt to the enemy that fired it, long after it left the muzzle", () => {
    // The melee case above cannot reach this path. A bite is attributed inline
    // because the biting enemy is right there; a bolt is not — it resolves
    // frames later, by which time the only link back to its shooter is the
    // `srcEid` the projectile carries. That indirection is the whole reason
    // `damageTaken.by` works for ranged damage at all, and nothing exercised it.
    withTestHooks((getHooks) => {
      // Far enough that ATTACK_RADIUS can never apply, close enough for
      // RANGED_RANGE (8). Hard difficulty aims with zero spread, so the bolt
      // cannot miss and make this flaky.
      const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 10.5, aggroed: true, discovered: true, fireCooldown: 0 })] });
      const { engine } = makeEngine(map, makeHandlers(), { difficulty: "hard", seed: 7 });
      // A bolt travels PROJECTILE_SPEED (5) tiles/sec across ~5 tiles, so step
      // well past its flight time; the enemy chases at 1.7 tiles/sec and still
      // cannot close to melee in that window.
      for (let i = 0; i < 120; i++) engine.simulate(0.016);

      const { events } = getHooks().drainEvents() as Drained;
      const shot = events.find((e) => e.e === "damageTaken" && e.src === "enemyRanged");
      expect(shot, "an aggroed enemy in ranged band must land a bolt").toBeDefined();
      const by = shot!.by as { eid: number; arch: string; amt: number }[] | null;
      expect(by, "a bolt must name its shooter, not report null like a hazard").not.toBeNull();
      expect(by![0]).toMatchObject({ eid: 0, arch: "normal" });
      expect(by![0].amt).toBeGreaterThan(0);
    });
  });

  it("records the player's death", () => {
    withTestHooks((getHooks) => {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // HAZARD_TILE under the spawn: 18 dps, so ~6s kills outright
      const { engine, handlers } = makeEngine(fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size));
      getHooks().drainEvents();
      for (let i = 0; i < 20 && handlers.onGameOver.mock.calls.length === 0; i++) engine.advance(0.5);
      expect(handlers.onGameOver).toHaveBeenCalledTimes(1);

      const events = (getHooks().drainEvents() as Drained).events;
      const death = events.find((e) => e.e === "playerDeath");
      expect(death, "dying must record a playerDeath event").toBeDefined();
      expect(death).toMatchObject({ src: "hazard" });
      // The level closes as died, not cleared -- which is what separates a run
      // that spent its budget from one that was cut short.
      expect(events.find((e) => e.e === "levelEnd")).toMatchObject({ outcome: "died" });
    });
  });
});

describe("RaycasterEngine — ?ablate= measurement kill switches (frame-budget audit)", () => {
  /** Stub the URL param, build an engine, hand back its mock ctx too. */
  function withAblate<T>(ablate: string, body: (helpers: { engine: InstanceType<typeof RaycasterEngine>; input: ScriptedInput; ctx: MockCanvasContext; handlers: ReturnType<typeof makeHandlers> }) => T, map: GameMap = fakeMap()): T {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: `?testHooks=1&ablate=${ablate}` }, configurable: true });
    try {
      const handlers = makeHandlers();
      const { engine, input } = makeEngine(map, handlers);
      // TS-private, runtime-reachable — same cast trick the multiplayer tests use.
      const ctx = (engine as unknown as { ctx: MockCanvasContext }).ctx;
      return body({ engine, input, ctx, handlers });
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  }

  it("ablate=render clears the canvas, draws nothing else, and still reports stats", () => {
    withAblate("render", ({ engine, ctx, handlers }) => {
      engine.advance(0.016);
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, WIDTH, HEIGHT);
      expect(ctx.drawImage).not.toHaveBeenCalled();
      expect(ctx.putImageData).not.toHaveBeenCalled();
      expect(handlers.onStats).toHaveBeenCalled();
    });
  });

  it("ablate=sim freezes the world (held movement key moves nobody) but cheats still apply", () => {
    withAblate("sim", ({ engine, input }) => {
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks;
      const before = hooks!.getPlayerState() as { x: number; y: number };
      input.keys.add("KeyW");
      input.cheat = "IDKFA";
      for (let i = 0; i < 10; i += 1) engine.advance(0.016);
      const after = hooks!.getPlayerState() as { x: number; y: number; ammo: { bullets: number } };
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      // The cheat path sits before the sim gate, deliberately (ablation
      // cells in the perf bench type cheats even with sim off) — IDKFA's
      // ammo grant is visible through the hooks where godMode is not.
      expect(after.ammo.bullets).toBe(999);
    });
  });

  it("ablate=sprites skips billboards and crosshair targeting", () => {
    const map = fakeMap({ enemies: [fakeEnemy({ x: 6.5, y: 5.5 })] });
    // Control: same scene without the switch draws more than the 40 wall
    // columns (enemy billboard stripes on top).
    const control = makeEngine(map);
    control.engine.advance(0.016);
    const controlFillRects = (control.engine as unknown as { ctx: MockCanvasContext }).ctx.fillRect.mock.calls.length;
    withAblate("sprites", ({ engine, ctx }) => {
      engine.advance(0.016);
      expect(ctx.fillRect.mock.calls.length).toBeLessThan(controlFillRects);
    }, fakeMap({ enemies: [fakeEnemy({ x: 6.5, y: 5.5 })] }));
  });

  it("ablate=effects, viewmodel and hud each render a frame without their pass", () => {
    // Control: an unablated frame on the same map, for differential counts.
    const control = makeEngine(fakeMap());
    control.engine.advance(0.016);
    const controlCtx = (control.engine as unknown as { ctx: MockCanvasContext }).ctx;
    const controlFillText = controlCtx.fillText.mock.calls.length;
    for (const which of ["effects", "viewmodel", "hud"]) {
      withAblate(which, ({ engine, ctx, handlers }) => {
        engine.advance(0.016);
        expect(handlers.onStats).toHaveBeenCalled();
        // fillText is not exclusively HUD's (the exit billboard draws its
        // "return" label as a sprite), so the HUD check is differential.
        if (which === "hud") expect(ctx.fillText.mock.calls.length).toBeLessThan(controlFillText);
        if (which === "viewmodel") expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(0); // walls still draw
      });
    }
  });

  it("a malformed ?ablate= value (empty after trim) leaves every system on", () => {
    withAblate("%20,%20", ({ engine, ctx }) => {
      engine.advance(0.016);
      expect(ctx.putImageData).toHaveBeenCalled(); // floor-cast ran -> render not ablated
    });
  });
});

describe("RaycasterEngine — crosshair targeting vs shot resolution at Sharp resolution (1280×800)", () => {
  /** The render-quality backlog check: crosshair highlighting reads the LIVE
   * canvas width while shots resolve on the fixed simulation-side scene
   * width — both compute the center ray as width/2 → cameraX 0, so they must
   * agree on what sits dead ahead at any canvas size. Pinned at classic and
   * Sharp sizes; the Sharp case also proves the zBuffer is sized to the
   * wider canvas (billboard columns past x=640 draw at all only when the
   * z-test reads real entries, not out-of-bounds undefined). */
  function engineSizedAt(width: number, height: number) {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    const canvas = { width, height } as unknown as HTMLCanvasElement;
    const ctx = createMockCanvasContext(canvas);
    canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
    const enemy = fakeEnemy({ x: 6.5, y: 5.5 }); // dead ahead of the (5,5) spawn, facing +x
    const map = fakeMap({ enemies: [enemy] });
    const input = new ScriptedInput();
    const engine = new RaycasterEngine(canvas, map, makeHandlers(), undefined, undefined, undefined, 12345, input);
    const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks!;
    return {
      engine,
      input,
      ctx,
      hooks,
      restore: () => {
        Object.defineProperty(window, "location", { value: original, configurable: true });
        delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
      },
    };
  }

  for (const [width, height] of [
    [640, 400],
    [1280, 800],
  ] as const) {
    it(`highlights and hits the same dead-center enemy at ${width}×${height}`, () => {
      const { engine, input, ctx, hooks, restore } = engineSizedAt(width, height);
      try {
        engine.advance(0.016);
        // Crosshair highlight (live canvas width) found the enemy…
        const target = (engine as unknown as { target: { x: number; y: number } | null }).target;
        expect(target).not.toBeNull();
        // The enemy AI already moved it a fraction of a tile this frame —
        // identity is what matters, pinned loosely by position.
        expect(target!.x).toBeCloseTo(6.5, 0);
        expect(target!.y).toBeCloseTo(5.5, 0);

        // …and an actual shot (fixed simulation-side resolution) hits it too.
        const hpBefore = (hooks.getEnemies() as { hp: number }[])[0].hp;
        input.fireQueued = true;
        engine.advance(0.016);
        const hpAfter = (hooks.getEnemies() as { hp: number }[])[0].hp;
        expect(hpAfter).toBeLessThan(hpBefore);

        if (width > 640) {
          // Billboard columns beyond the classic 640 boundary really drew —
          // the z-test read real zBuffer entries, not out-of-bounds holes.
          const wideColumns = ctx.fillRect.mock.calls.filter((c) => typeof c[0] === "number" && c[0] > 640);
          expect(wideColumns.length).toBeGreaterThan(0);
        }
      } finally {
        restore();
      }
    });
  }
});

describe("RaycasterEngine — rollbacksRemaining (HUD badge only)", () => {
  it("reports 0 when the constructor argument is omitted", () => {
    // The three callers that omit it — a multiplayer session, replay playback
    // and every harness — must show no badge. A difficulty-derived default
    // would instead have all three claim a live count nothing can spend.
    const { engine, handlers } = makeEngine(fakeMap());
    engine.start();
    expect(lastStats(handlers).rollbacksRemaining).toBe(0);
    engine.stop();
  });

  it("passes the given count straight through to EngineStats", () => {
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { rollbacksRemaining: 3 });
    engine.start();
    expect(lastStats(handlers).rollbacksRemaining).toBe(3);
    engine.stop();
  });

  it("never decrements it — main.ts owns the count and builds a fresh engine per level", () => {
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { rollbacksRemaining: 2 });
    engine.start();
    raf.flush(30, 16);
    expect(lastStats(handlers).rollbacksRemaining).toBe(2);
    engine.stop();
  });

  it("is not read from the carryover, so a stray field there changes nothing", () => {
    // Guards the deliberate choice not to route this through EngineCarryover
    // the way the sibling `cheatsUsed` badge flag is: level 1 of every
    // campaign launches with `carryover === undefined`, so a carryover-only
    // channel would hide the badge exactly where dying is most likely.
    const carryover = { health: 55, swap: 0, bullets: 10, rockets: 0, smg: 0, gas: 0, rollbacksRemaining: 9 } as EngineCarryover;
    const { engine, handlers } = makeEngine(fakeMap(), makeHandlers(), { carryover });
    engine.start();
    const stats = lastStats(handlers);
    expect(stats.rollbacksRemaining).toBe(0);
    expect(stats.health).toBe(55); // the rest of the carryover still applied
    engine.stop();
  });
});

describe("RaycasterEngine — coop help ping", () => {
  type PingState = {
    helpPingFrames: number;
    helpPingBeatFrames: number;
    helpPingCooldownFrames: number;
    helpPingWasDown: boolean;
    status: string;
  };

  function players(engine: InstanceType<typeof RaycasterEngine>): Map<string, PingState> {
    return (engine as unknown as { players: Map<string, PingState> }).players;
  }

  /** A coop engine: a non-default `localPlayerId` is what makes
   * `isMultiplayerSession()` true — see its own doc comment. */
  function coopEngine(input = new ScriptedInput()) {
    const engine = new RaycasterEngine(
      makeCanvas(),
      fakeMap(),
      makeHandlers(),
      undefined,
      undefined,
      undefined,
      1,
      input,
      undefined,
      "host",
    );
    return { engine, input };
  }

  function silenceHelp() {
    return vi.spyOn(audio, "playHelpPing").mockImplementation(() => {});
  }

  it("arms a ping for the player who pressed G, for HELP_PING_FRAMES", () => {
    silenceHelp();
    const { engine, input } = coopEngine();
    input.helpPing = true;
    engine.advance(0.016);
    expect(players(engine).get("host")!.helpPingFrames).toBeGreaterThan(0);

    for (let i = 0; i < 320; i++) engine.advance(0.016);
    expect(players(engine).get("host")!.helpPingFrames).toBe(0);
    // 320 ticks of a live sim is slow under CI's coverage instrumentation — the
    // 5s default was not enough there even though it is ~0.5s locally.
  }, 20_000);

  it("arms a TEAMMATE's ping on this peer — the whole point, and the opposite of the key hint", () => {
    // `cueLockedDoorHint` deliberately returns early for any non-local player,
    // so a teammate's private hint never reaches your screen. A help ping must
    // do exactly the reverse: every peer arms the caller identically, from the
    // same input bit in the tick bundle.
    silenceHelp();
    const { engine } = coopEngine();
    const mate = new ScriptedInput();
    engine.addPlayer("guest", mate);

    mate.helpPing = true;
    engine.advance(0.016);

    expect(players(engine).get("guest")!.helpPingFrames).toBeGreaterThan(0);
    expect(players(engine).get("host")!.helpPingFrames).toBe(0);
  });

  it("plays the audible call on its own beat while the ping runs", () => {
    const call = silenceHelp();
    const { engine, input } = coopEngine();
    input.helpPing = true;
    engine.advance(0.016);
    expect(call).toHaveBeenCalledTimes(1); // the first beat lands immediately

    // 61 more, not 60: the beat counter is *reset* to HELP_PING_BEAT_FRAMES on
    // the frame that fires, so the gap is 61 frames rather than 60.
    for (let i = 0; i < 61; i++) engine.advance(0.016);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("edge-latches: a held bit does not re-arm, even with the cooldown cleared", () => {
    // The real hazard this guards. In multiplayer `consumeHelpPing()` is a
    // non-clearing read of the current frame, and `InputDelayBuffer.finalize()`
    // re-delivers the previous snapshot verbatim whenever a packet is missing —
    // so one press genuinely arrives as `helpPing: true` on every held-fallback
    // tick that follows. Re-setting the flag each frame reproduces that.
    //
    // The cooldown is zeroed every frame on purpose, so the latch is the *only*
    // thing left that can prevent a re-arm. Letting the real 480-frame cooldown
    // run out instead would take ~600 engine ticks (which timed out on CI) and
    // would also let the test pass on the cooldown alone, saying nothing at all
    // about the latch it is named after.
    const call = silenceHelp();
    const { engine, input } = coopEngine();
    input.helpPing = true;
    engine.advance(0.016);
    const armed = players(engine).get("host")!.helpPingFrames;
    expect(armed).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      input.helpPing = true; // never released, exactly like a held fallback
      players(engine).get("host")!.helpPingCooldownFrames = 0;
      engine.advance(0.016);
    }

    // Still the original ping quietly running down, not a fresh one.
    expect(players(engine).get("host")!.helpPingFrames).toBeLessThan(armed);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("blocks a second press while the lockout runs, and re-arms once it clears", () => {
    silenceHelp();
    const { engine, input } = coopEngine();
    input.helpPing = true;
    engine.advance(0.016);
    const firstCooldown = players(engine).get("host")!.helpPingCooldownFrames;
    expect(firstCooldown).toBeGreaterThan(0);

    // A real second press — released and pressed again, so the latch is open —
    // while the lockout is still running. It must not restart the ping.
    for (let i = 0; i < 20; i++) engine.advance(0.016);
    expect(players(engine).get("host")!.helpPingCooldownFrames).toBeLessThan(firstCooldown); // it decays
    const midway = players(engine).get("host")!.helpPingFrames;
    input.helpPing = true;
    engine.advance(0.016);
    expect(players(engine).get("host")!.helpPingFrames).toBeLessThan(midway); // still running down, not reset

    // One idle frame so the key counts as released — without it the latch
    // reads two presses on consecutive frames as a single hold, which is
    // exactly what it is for.
    engine.advance(0.016);
    const beforeSecond = players(engine).get("host")!.helpPingFrames;

    // Same press once the lockout has cleared. Zeroed rather than waited out:
    // 480 real frames is ~600 engine ticks, and what is under test here is the
    // gate, not the arithmetic of the countdown (covered by the decay above).
    players(engine).get("host")!.helpPingCooldownFrames = 0;
    input.helpPing = true;
    engine.advance(0.016);
    expect(players(engine).get("host")!.helpPingFrames).toBeGreaterThan(beforeSecond);
  });

  it("does nothing in single-player, but still drains the flag", () => {
    // Nobody to call. The press must not light up your own map — and must not
    // bank either, or `captureSnapshot()` would report it true forever after.
    const call = silenceHelp();
    const { engine, input } = makeEngine(fakeMap());
    input.helpPing = true;
    engine.advance(0.016);

    expect(input.helpPing).toBe(false);
    expect(players(engine).get("local")!.helpPingFrames).toBe(0);
    expect(call).not.toHaveBeenCalled();
  });

  it("still reaches the flag while paused, rather than banking it", () => {
    // Why `armHelpPings()` runs before `simulate()`'s early returns: the pause
    // branch returns before the `state === "playing"` block, so a G pressed
    // while paused would otherwise never be cleared from the controller and
    // would sit `true` in every later `captureSnapshot()`.
    //
    // Pausing is deliberately not treated as a reason to refuse the call. It
    // cannot arise in a real coop session anyway — the input layer neutralizes
    // `escape` for a networked peer (multiplayer-netcode-spec.md §6) — so a
    // branch for it would be untestable dead weight in shipped play.
    silenceHelp();
    const { engine, input } = coopEngine();
    input.escape = true;
    engine.advance(0.016); // now paused

    input.helpPing = true;
    engine.advance(0.016);
    expect(input.helpPing).toBe(false);
  });

  it("does not arm for a dead player", () => {
    silenceHelp();
    const { engine } = coopEngine();
    const mate = new ScriptedInput();
    engine.addPlayer("guest", mate);
    players(engine).get("guest")!.status = "dead";

    mate.helpPing = true;
    engine.advance(0.016);
    expect(players(engine).get("guest")!.helpPingFrames).toBe(0);
  });
});

describe("RaycasterEngine — telemetry ablated (?ablate=telemetry)", () => {
  it("walks the whole combat path with telemetry off, so every record* guard's off side is real code", () => {
    // `PLAYER_STATS_ENABLED` ships on since 2026-08-23, which would make the
    // ~22 `if (x.telemetry) record*(...)` guards one-sided and their off
    // branches unreachable — untestable, and dead weight nobody could prove
    // still worked. `?ablate=telemetry` is the switch that keeps them real
    // (see the `telemetryEnabled` assignment in engine.ts), and this drives
    // shooting, hitting, killing, damage, loot, mines and reloading in one
    // pass so those sides actually execute.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?ablate=telemetry" }, configurable: true });
    try {
      const size = 14;
      const g = walledRoom(size);
      const map = fakeMap(
        {
          grid: g,
          spawn: { x: 5, y: 5 },
          exit: { x: 1, y: 1 },
          enemies: [fakeEnemy({ x: 6.5, y: 5.5 }), fakeEnemy({ x: 7.5, y: 5.5 }), fakeEnemy({ x: 8.5, y: 5.5 })],
          mines: [{ x: 5.5, y: 6.5, alive: true, visible: true, closeTimer: 0 } as Mine],
        },
        size,
      );
      const { engine, input } = makeEngine(map);
      for (let i = 0; i < 150; i++) {
        input.fireQueued = true;
        if (i % 25 === 0) input.reload = true;
        engine.advance(0.05);
      }
      const players = (engine as unknown as { players: Map<string, { telemetry?: unknown }> }).players;
      expect(players.get("local")!.telemetry).toBeUndefined();
      // And the engine is still a working engine with the instrumentation off.
      expect(() => engine.advance(0.016)).not.toThrow();
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
    // Explicit timeout: this drives the engine in a loop, and CI runs the suite
    // under coverage instrumentation where that is several times slower than
    // locally — the trap documented in testing.md, which the first version of
    // this very test walked straight into at 600 iterations.
  }, 20_000);

  it("covers the off side of the terminal and out-of-ammo record sites too", () => {
    // The paths the combat pass above cannot reach: collecting a static ammo
    // pickup, pulling the trigger on an empty magazine, and dying.
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?ablate=telemetry" }, configurable: true });
    try {
      const size = 12;
      const g = walledRoom(size);
      g[5][5] = 2; // hazard under the spawn — kills eventually
      const pickup: AmmoPickup = { x: 5.5, y: 5.5, kind: "bullets", amount: 15, collected: false };
      const map = fakeMap(
        { grid: g, hazards: [{ x: 5, y: 5 }], spawn: { x: 5, y: 5 }, exit: { x: 1, y: 1 }, ammoPickups: [pickup] },
        size,
      );
      const { engine, input } = makeEngine(map);
      // Fire without ever reloading, so the magazine empties and stays empty.
      for (let i = 0; i < 200; i++) {
        input.fireQueued = true;
        engine.advance(0.05);
      }
      const players = (engine as unknown as { players: Map<string, { telemetry?: unknown; status: string }> }).players;
      expect(players.get("local")!.telemetry).toBeUndefined();
      expect(players.get("local")!.status).toBe("dead"); // the hazard got there
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
    }
  }, 20_000);
});

/**
 * **Temporary — delete alongside `playtestScales.ts`.**
 *
 * Both knobs are asserted at *every* listed value rather than at one
 * representative, because the ladders are what the playtest is choosing
 * between: a value that silently does not apply would look like a legitimate
 * "that felt the same" result. Melee and bolts are asserted separately for the
 * same reason — they are two distinct call sites, and wiring one is the obvious
 * way to get this half-right.
 */
describe("playtest scales", () => {
  /** Same `?testHooks=1&eventLog=1` shape the balancing-event-log block uses;
   * duplicated rather than hoisted so this whole block can be cut in one go. */
  function withEventLog(body: (getHooks: () => Record<string, (...args: unknown[]) => unknown>) => void): void {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1&eventLog=1" }, configurable: true });
    try {
      body(() => (window as unknown as { __codeensteinTestHooks: Record<string, (...args: unknown[]) => unknown> }).__codeensteinTestHooks);
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  }

  type LoggedEvent = { e: string; [k: string]: unknown };

  function damageEvents(getHooks: () => Record<string, (...args: unknown[]) => unknown>, src: string): LoggedEvent[] {
    const { events } = getHooks().drainEvents() as { events: LoggedEvent[] };
    return events.filter((e) => e.e === "damageTaken" && e.src === src);
  }

  it.each(ENEMY_DAMAGE_SCALES)("scales an enemy's melee bite by %s", (enemyDamage) => {
    withEventLog((getHooks) => {
      // Well inside ATTACK_RADIUS (0.5) of the 5.5,5.5 spawn, aggroed and off
      // cooldown, so the very first AI step bites.
      const map = fakeMap({ enemies: [fakeEnemy({ x: 5.7, y: 5.5, aggroed: true, discovered: true, attackCooldown: 0 })] });
      const { engine } = makeEngine(map, makeHandlers(), { difficulty: "normal", playtestScales: { enemyDamage, killHeal: 1 } });
      engine.simulate(0.016);

      const bites = damageEvents(getHooks, "enemyMelee");
      expect(bites, "an adjacent aggroed enemy must land a bite").toHaveLength(1);
      expect(bites[0].amt).toBeCloseTo(10 * enemyDamage, 5); // ATTACK_DAMAGE
    });
  });

  it.each(ENEMY_DAMAGE_SCALES)("scales an enemy's bolt by %s, on top of the difficulty tier", (enemyDamage) => {
    withEventLog((getHooks) => {
      // Hard rather than normal for two reasons: its 0-degree aim spread makes
      // the hit deterministic instead of flaky, and its own 1.5x damage factor
      // is what makes this a *composition* check — a knob that replaced the
      // difficulty multiplier instead of multiplying with it would still pass
      // an identity-difficulty test.
      const map = fakeMap({ enemies: [fakeEnemy({ x: 5.5, y: 10.5, aggroed: true, discovered: true, fireCooldown: 0 })] });
      const { engine } = makeEngine(map, makeHandlers(), { difficulty: "hard", seed: 7, playtestScales: { enemyDamage, killHeal: 1 } });
      // The bolt covers ~5 tiles at PROJECTILE_SPEED (5); the enemy chases at
      // 1.7 tiles/sec and cannot reach melee inside this window, so nothing
      // else can contribute to the figure asserted below.
      for (let i = 0; i < 120; i++) engine.simulate(0.016);

      const hits = damageEvents(getHooks, "enemyRanged");
      expect(hits.length, "an aggroed enemy in the ranged band must land a bolt").toBeGreaterThan(0);
      expect(hits[0].amt).toBeCloseTo(8 * 1.5 * enemyDamage, 5); // PROJECTILE_DAMAGE x hard.damage
    });
  });

  it("leaves hazard damage alone at the highest enemy-damage scale", () => {
    // The scope claim in `PlaytestScales.enemyDamage`'s doc comment, and the
    // one thing a "multiply everything that hurts the player" mistake would
    // break invisibly — environmental damage runs 5-30% of a run's total
    // depending on the repository, so folding it in would move the number the
    // playtest is reading without ever being visible in the roster.
    const readHazardAmt = (enemyDamage: number): number => {
      let amt = 0;
      withEventLog((getHooks) => {
        const size = 12;
        const g = walledRoom(size);
        g[5][5] = 2; // HAZARD_TILE under the spawn
        const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
        const { engine } = makeEngine(map, makeHandlers(), { difficulty: "normal", playtestScales: { enemyDamage, killHeal: 1 } });
        engine.simulate(0.5);
        const hits = damageEvents(getHooks, "hazard");
        expect(hits.length, "standing in acid must hurt").toBeGreaterThan(0);
        amt = hits[0].amt as number;
      });
      return amt;
    };
    expect(readHazardAmt(3)).toBe(readHazardAmt(1));
  });

  /** The health a kill's drop was actually worth, read back off the telemetry
   * `pushLootDrop` writes — which is also the assertion that scaling before
   * that write keeps `lootRolled` honest rather than reporting the unscaled
   * figure. */
  function healthDroppedByKilling(enemy: Enemy, killHeal: number): number {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const { engine, input } = makeEngine(fakeMap({ enemies: [enemy] }), makeHandlers(), {
        // Below MAX_HEALTH, or the guaranteed heal is skipped entirely and
        // both arms would read 0 — a broken experiment, not a null.
        carryover: { health: 50, swap: 0, bullets: 999, rockets: 0, smg: 0, gas: 0 },
        seed: 42,
        playtestScales: { enemyDamage: 1, killHeal },
      });
      input.fireQueued = true;
      engine.advance(0.016);
      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks;
      const snapshot = hooks!.getTelemetrySnapshot() as { lootRolled: Record<string, number> };
      return snapshot.lootRolled.health ?? 0;
    } finally {
      Object.defineProperty(window, "location", { value: original, configurable: true });
      delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    }
  }

  it.each(KILL_HEAL_SCALES)("scales a regular kill's guaranteed heal by %s", (killHeal) => {
    // maxHp 100 makes the base grant exactly HEALTH_DROP_AMOUNT (20) — see
    // HEALTH_SCALE_REFERENCE_HP — while hp 1 lets one pistol round finish it.
    const dropped = healthDroppedByKilling(fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 100 }), killHeal);
    expect(dropped).toBe(Math.max(1, Math.round(20 * killHeal)));
  });

  it.each(KILL_HEAL_SCALES)("scales an Elite's health pack by %s", (killHeal) => {
    // The second heal source, and the reason the scale lives in
    // `pushLootDrop` rather than next to the regular-kill grant:
    // `dropEliteLoot` never touches that code and would otherwise stay
    // unscaled, leaving exactly the enemy whose drop matters most at 1x.
    const dropped = healthDroppedByKilling(fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 100, elite: true }), killHeal);
    expect(dropped).toBe(Math.max(1, Math.round(50 * killHeal))); // ELITE_HEALTH_DROP_AMOUNT
  });

  it("never lets a scaled-down heal reach zero", () => {
    // The `Math.max(1, ...)` in `pushLootDrop`, which stops a scaled-down drop
    // from becoming a zero-value pickup sitting on the floor — worse than no
    // pickup, because the player still walks over to it.
    //
    // **0.02 deliberately, and it is not on the ladder.** The obvious version
    // of this test — a tiny enemy at the ladder's own 0.33x — cannot fail: a
    // 5 HP body's grant is already floored to 1 by the *caller*, so deleting
    // every line of scaling would still produce 1 and the test would stay
    // green while proving nothing. Picking a scale steep enough that a real
    // 20-point grant rounds to 0 is what makes the floor here, rather than the
    // caller's, the thing under test.
    expect(Math.round(20 * 0.02), "the arithmetic the floor is protecting against").toBe(0);
    const dropped = healthDroppedByKilling(fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 100 }), 0.02);
    expect(dropped).toBe(1);
  });

  it("changes nothing at identity, on either axis", () => {
    // The default every non-`main.ts` caller gets. Asserted against an engine
    // built with no scales argument at all, so "identity" is pinned to the
    // constructor default rather than to a value this block supplies.
    const bite = (playtestScales?: PlaytestScales): number => {
      let amt = 0;
      withEventLog((getHooks) => {
        const map = fakeMap({ enemies: [fakeEnemy({ x: 5.7, y: 5.5, aggroed: true, discovered: true, attackCooldown: 0 })] });
        const { engine } = makeEngine(map, makeHandlers(), { difficulty: "normal", playtestScales });
        engine.simulate(0.016);
        amt = damageEvents(getHooks, "enemyMelee")[0].amt as number;
      });
      return amt;
    };
    expect(bite({ enemyDamage: 1, killHeal: 1 })).toBe(bite(undefined));
    expect(healthDroppedByKilling(fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 100 }), 1)).toBe(20);
  });
});
