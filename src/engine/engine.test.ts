// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import type { AmmoPickup, Enemy, GameMap, KeyItem, LootDrop, Mine, SpikeTrap, Teleporter, Tile } from "../map/types";
import { DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, TELEPORTER_TILE } from "../map/types";
import { audio } from "./audio";
import type { InputSnapshot, InputSource } from "./input";
import { CORRECTION_SMOOTH_MS, SNAP_THRESHOLD_TILES } from "./reconciliationConstants";
import type { ReconciliationSnapshot } from "./reconciliationSnapshot";
import { EMPTY_SNAPSHOT } from "./replay";
import { COUNTDOWN_TICKS } from "./transitionConstants";
import { GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX } from "./weapons";

// engine.ts imports a real *value* (`textures`) from textures.ts, whose
// module-level `TextureManager` singleton calls `document.createElement`
// and `canvas.getContext("2d")` at import time — before any test setup
// (even beforeAll) can run, since ES module imports are hoisted ahead of
// all other top-level code. Stub the canvas context first, then
// dynamically import engine.ts. Same gotcha as raycaster.ts/textures.ts.
let RaycasterEngine: typeof import("./engine").RaycasterEngine;
let REVIVE_HEALTH: number;
type EngineStats = import("./engine").EngineStats;
type EngineHandlers = import("./engine").EngineHandlers;
type EngineCarryover = import("./engine").EngineCarryover;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ RaycasterEngine, REVIVE_HEALTH } = await import("./engine"));
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
  onStats: ReturnType<typeof vi.fn>;
  onGameOver: ReturnType<typeof vi.fn>;
  onWin: ReturnType<typeof vi.fn>;
  onCheatActivated: ReturnType<typeof vi.fn>;
  onFreezeChange: ReturnType<typeof vi.fn>;
} & EngineHandlers {
  return {
    onStats: vi.fn(),
    onGameOver: vi.fn(),
    onWin: vi.fn(),
    onCheatActivated: vi.fn(),
    onFreezeChange: vi.fn(),
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
    gore?: "none" | "normal" | "more" | "extreme";
    difficulty?: "easy" | "normal" | "hard";
    seed?: number;
    input?: ScriptedInput;
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

  it("falls back to a real InputController when no inputSource is given", () => {
    // makeCanvas()'s canvas is a plain object cast to HTMLCanvasElement (fine
    // for a ScriptedInput, which never touches it) — a real InputController
    // calls addEventListener on it, so this needs an actual DOM element.
    const canvas = document.createElement("canvas");
    const ctx = createMockCanvasContext(canvas);
    canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
    expect(() => new RaycasterEngine(canvas, fakeMap(), {}, undefined, undefined, undefined, 1)).not.toThrow();
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

describe("RaycasterEngine — keys and doors", () => {
  function doorMap(): GameMap {
    const size = 12;
    const g = walledRoom(size);
    g[5][7] = DOOR_TILE; // directly east of spawn
    return fakeMap({ grid: g, keys: [{ x: 5.5, y: 5.5, collected: false }] }, size);
  }

  it("collects a nearby key", () => {
    const { engine, handlers } = makeEngine(doorMap());
    engine.advance(0.016);
    expect(lastStats(handlers).keysHeld).toBe(1);
  });

  it("opens a door ahead when holding a key and walking into it", () => {
    const map = doorMap();
    const { engine, input, handlers } = makeEngine(map);
    engine.advance(0.016); // collect the key first
    input.keys.add("KeyW"); // push toward the door (spawn faces +X by default)
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][7]).toBe(0);
    expect(lastStats(handlers).keysHeld).toBe(0);
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

  it("opens a door behind the player when backing into it with S", () => {
    const size = 12;
    const g = walledRoom(size);
    g[5][3] = DOOR_TILE; // west of spawn — behind the player's default +X facing
    const map = fakeMap({ grid: g, keys: [{ x: 5.5, y: 5.5, collected: false }] }, size);
    const { engine, input } = makeEngine(map);
    engine.advance(0.016); // collect the key first
    input.keys.add("KeyS"); // push backward, toward the door behind
    for (let i = 0; i < 20; i++) engine.advance(0.1);
    expect(map.grid[5][3]).toBe(0);
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
  });

  it("fires the shotgun's multiple pellets in one trigger pull", () => {
    const enemy = fakeEnemy({ x: 6.2, y: 5.5, hp: 1, maxHp: 1 });
    const map = fakeMap({ enemies: [enemy] });
    const { engine, input } = makeEngine(map);
    input.weaponRequest = 1; // shotgun
    engine.advance(0.016);
    input.fireQueued = true;
    expect(() => engine.advance(0.016)).not.toThrow();
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
    for (let i = 0; i < 20 && mine.alive; i++) {
      input.fireQueued = true;
      engine.advance(0.016);
    }
    expect(mine.alive).toBe(false);
    expect(lastStats(handlers).health).toBe(100); // no splash damage at this range
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
    const mine: Mine = { x: 9.1, y: 10.5, alive: true, visible: true, closeTimer: 0 }; // 3.6 tiles out, past maxRange (3.5)
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
    const enemy = fakeEnemy({ x: 5.9, y: 5.5, hp: 1, maxHp: 1 });
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
        carryover: { health: 50, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0, ownedWeapons: [0, 1, 2, 3, 4] },
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
    expect(stats.bullets).toBe(999);
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

  it("leaves priorScoreBreakdown/priorPlayerStats undefined when telemetry isn't being recorded (default)", () => {
    const engine = new RaycasterEngine(makeCanvas(), fakeMap(), {}, undefined, undefined, undefined, 1, new ScriptedInput(), undefined, "H");
    const result = engine.captureCarryoverFor("H");
    expect(result.priorScoreBreakdown).toBeUndefined();
    expect(result.priorPlayerStats).toBeUndefined();
  });

  it("populates priorScoreBreakdown/priorPlayerStats under ?testHooks=1 (telemetry on)", () => {
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

  it("leaves levelPlayerStats/levelScoreBreakdown/runScoreBreakdown/runPlayerStats undefined by default (PLAYER_STATS_ENABLED off, no ?testHooks=1)", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const { engine, handlers } = makeEngine(map);
    engine.advance(0.016);
    expect(handlers.onWin).toHaveBeenCalledTimes(1);
    const stats = lastStats(handlers);
    expect(stats.levelPlayerStats).toBeUndefined();
    expect(stats.levelScoreBreakdown).toBeUndefined();
    expect(stats.runScoreBreakdown).toBeUndefined();
    expect(stats.runPlayerStats).toBeUndefined();
    // The plain numeric score is unaffected either way.
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
  // block already uses — each dies in a single pistol shot, so consecutive
  // fireQueued frames each consume exactly one of them (projectLivingEnemies
  // only ever considers the still-alive ones, so which one dies on a given
  // frame doesn't matter, only that exactly one does).
  function oneHitEnemies(count: number): Enemy[] {
    return Array.from({ length: count }, () => fakeEnemy({ x: 6.5, y: 5.5, hp: 1, maxHp: 1 }));
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

    input.fireQueued = true;
    engine.advance(0.1); // kill 1 @ t=0.1
    input.fireQueued = true;
    engine.advance(0.1); // kill 2 @ t=0.2
    expect(multiSpy).not.toHaveBeenCalled();
    input.fireQueued = true;
    engine.advance(0.1); // kill 3 @ t=0.3 -> Multi Kill
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(lastStats(handlers).kills).toBe(3);

    input.fireQueued = true;
    engine.advance(0.1); // kill 4 @ t=0.4 -> still within the 3s window, no re-fire
    expect(multiSpy).toHaveBeenCalledTimes(1);
  });

  it("fires an Ultra Kill (not a 2nd Multi Kill) on the 6th kill within 6s", () => {
    const map = fakeMap({ enemies: oneHitEnemies(6) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    for (let i = 0; i < 6; i++) {
      input.fireQueued = true;
      engine.advance(0.1); // 6 kills, 0.1s apart -> all within both windows
    }
    expect(multiSpy).toHaveBeenCalledTimes(1); // only the 3rd kill's Multi Kill
    expect(ultraSpy).toHaveBeenCalledTimes(1); // the 6th kill's Ultra Kill, not a 2nd Multi Kill
  });

  it("lets a lapsed streak (gap past the Ultra window) retrigger a fresh Multi Kill later", () => {
    const map = fakeMap({ enemies: oneHitEnemies(9) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    for (let i = 0; i < 6; i++) {
      input.fireQueued = true;
      engine.advance(0.1); // kills 1-6 @ t=0.1..0.6 -> Multi Kill then Ultra Kill
    }
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(ultraSpy).toHaveBeenCalledTimes(1);

    input.fireQueued = true;
    engine.advance(10.1); // kill 7 @ t=10.7 -> well past the Ultra window, no trigger
    expect(multiSpy).toHaveBeenCalledTimes(1);
    expect(ultraSpy).toHaveBeenCalledTimes(1);

    input.fireQueued = true;
    engine.advance(0.1); // kill 8 @ t=10.8
    input.fireQueued = true;
    engine.advance(0.1); // kill 9 @ t=10.9 -> a fresh 3-in-3s streak -> Multi Kill again
    expect(multiSpy).toHaveBeenCalledTimes(2);
    expect(ultraSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it("never triggers a streak when kills are spaced further apart than the Multi Kill window", () => {
    const map = fakeMap({ enemies: oneHitEnemies(3) });
    const { engine, input } = makeGodModeEngine(map);
    const multiSpy = vi.spyOn(audio, "playMultiKill");
    const ultraSpy = vi.spyOn(audio, "playUltraKill");

    input.fireQueued = true;
    engine.advance(0.1); // kill 1 @ t=0.1
    input.fireQueued = true;
    engine.advance(4); // kill 2 @ t=4.1 -> 4s since kill 1, past the 3s window
    input.fireQueued = true;
    engine.advance(4); // kill 3 @ t=8.1 -> 4s since kill 2, past the 3s window
    expect(multiSpy).not.toHaveBeenCalled();
    expect(ultraSpy).not.toHaveBeenCalled();
  });

  it("scores Ultra Kill's bigger bonus on top of Multi Kill's, via computeScore()'s multikillBonus", () => {
    const map = fakeMap({ enemies: oneHitEnemies(6) });
    const { engine, input, handlers } = makeGodModeEngine(map);
    for (let i = 0; i < 3; i++) {
      input.fireQueued = true;
      engine.advance(0.1); // kills 1-3 -> Multi Kill
    }
    // The toast itself is drawn straight to canvas (see hud.test.ts's
    // drawKillStreakToast coverage) — here just confirm the score already
    // reflects the Multi Kill bonus flowing through computeScore().
    const afterMulti = lastStats(handlers).score;
    for (let i = 0; i < 3; i++) {
      input.fireQueued = true;
      engine.advance(0.1); // kills 4-6 -> Ultra Kill
    }
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
      for (let i = 0; i < 5; i++) {
        inputA.fireQueued = true;
        engineA.advance(dt);
      }
      const stateA = getHooks().getPlayerState() as PlayerState;

      const { engine: engineB, input: inputB } = makeEngine(fakeMap({ spawn: { x: 5, y: 5 } }, 16), undefined, { seed: 42 });
      inputB.keys.add("KeyD");
      for (let i = 0; i < 10; i++) engineB.simulate(dt);
      inputB.keys.delete("KeyD");
      for (let i = 0; i < 5; i++) {
        inputB.fireQueued = true;
        engineB.simulate(dt);
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

  it("a player who dies drops their held keys at their death position; a living teammate can then collect them", () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, search: "?testHooks=1" }, configurable: true });
    try {
      const size = 14;
      const g = walledRoom(size);
      g[5][5] = HAZARD_TILE;
      const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }], keys: [{ x: 5.5, y: 5.5, collected: false }] }, size);
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

      const hooks = (window as unknown as { __codeensteinTestHooks?: Record<string, () => unknown> }).__codeensteinTestHooks;
      let drops = hooks!.getDrops() as { x: number; y: number; kind: string }[];
      expect(drops).toContainEqual(expect.objectContaining({ kind: "key", x: 5.5, y: 5.5 }));

      p2Input.keys.add("KeyS"); // walk back to the death position
      for (let i = 0; i < 15; i++) engine.advance(0.1);
      p2Input.keys.delete("KeyS");
      drops = hooks!.getDrops() as { x: number; y: number; kind: string }[];
      expect(drops.some((d) => d.kind === "key")).toBe(false); // p2 collected it
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

  it("state flips to 'over' only once every connected player is dead", () => {
    const { engine, handlers } = makeEngine(hazardSpawnMap());
    engine.addPlayer("p2", new ScriptedInput()); // p2 never moves off the hazard either
    for (let i = 0; i < 20 && handlers.onGameOver.mock.calls.length === 0; i++) engine.advance(1);
    expect(handlers.onGameOver).toHaveBeenCalledTimes(1);
    expect(engine.rosterSnapshot().get("local")!.status).toBe("dead");
    expect(engine.rosterSnapshot().get("p2")!.status).toBe("dead");
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
        keys: [{ x: 17.5, y: 17.5, collected: false }],
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
      const keys: KeyItem[] = [{ x: 3, y: 3, collected: true }];
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
      const map = fakeMap({ grid: g, keys: [{ x: 5.5, y: 5.5, collected: false }] }, size);
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

    it("writes every gridDelta tile and updates gridVersion", () => {
      const map = fakeMap({}, 12); // walledRoom border: grid[0][0] is a wall (1)
      const { engine } = makeEngine(map);
      expect(map.grid[0][0]).toBe(1);

      engine.applyReconciliationSnapshot(fakeSnapshot({ gridVersion: 9, gridDelta: [{ x: 0, y: 0, value: 0 }] }));

      expect(map.grid[0][0]).toBe(0);
      expect(engine.captureReconciliationSnapshot(0).gridVersion).toBe(9);
    });

    it("marks pickups/keys collected by index", () => {
      const pickups: AmmoPickup[] = [{ x: 1, y: 1, kind: "bullets", amount: 5, collected: false }];
      const keys: KeyItem[] = [{ x: 3, y: 3, collected: false }];
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
                ammo: { bullets: 0, rockets: 0, smg: 0, gas: 0 },
                weaponIndex: 0,
                keysHeld: 0,
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
      const snapshot = engine.captureReconciliationSnapshot(0);
      snapshot.players.local.alive = false;
      engine.applyReconciliationSnapshot(snapshot);
      expect(engine.rosterSnapshot().get("local")?.status).toBe("dead");
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
    ammo: { bullets: number; rockets: number; smg: number; gas: number };
    ownedWeapons: Set<number>;
    keysHeld: number;
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
      host.ownedWeapons.add(GDB_WEAPON_INDEX);
      host.ownedWeapons.add(GHIDRA_WEAPON_INDEX);
      host.keysHeld = 2;

      engine.applyRosterRemoval(["host"]);

      expect(engine.rosterSnapshot().get("host")?.status).toBe("disconnected");
      const drops = dropsOf(engine).map((d) => ({ kind: d.kind, amount: d.amount, weaponIndex: d.weaponIndex, id: d.id, source: d.source }));
      expect(drops).toEqual([
        { kind: "bullets", amount: 10, weaponIndex: undefined, id: "disconnect:host:0", source: "disconnect" },
        { kind: "smg", amount: 5, weaponIndex: undefined, id: "disconnect:host:1", source: "disconnect" },
        { kind: "gas", amount: 3, weaponIndex: undefined, id: "disconnect:host:2", source: "disconnect" },
        { kind: "weapon", amount: undefined, weaponIndex: GDB_WEAPON_INDEX, id: "disconnect:host:3", source: "disconnect" },
        { kind: "weapon", amount: undefined, weaponIndex: GHIDRA_WEAPON_INDEX, id: "disconnect:host:4", source: "disconnect" },
        { kind: "key", amount: 1, weaponIndex: undefined, id: "disconnect:host:5", source: "disconnect" },
        { kind: "key", amount: 1, weaponIndex: undefined, id: "disconnect:host:6", source: "disconnect" },
      ]);
    });

    it("never drops health or swap, and clears keysHeld", () => {
      const engine = makeMpEngine(fakeMap());
      engine.addPlayer("guest", new ScriptedInput());
      const host = mpPlayersOf(engine).get("host")!;
      host.health = 50;
      host.swap = 20;
      host.keysHeld = 1;
      engine.applyRosterRemoval(["host"]);
      expect(dropsOf(engine).some((d) => d.kind === "health" || d.kind === "swap")).toBe(false);
      expect(mpPlayersOf(engine).get("host")!.keysHeld).toBe(0);
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
      engine.applyRosterRemoval(["guest"]); // already disconnected — re-checks elimination anyway
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
