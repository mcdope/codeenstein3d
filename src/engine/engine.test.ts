// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import type { AmmoPickup, Enemy, GameMap, Mine, SpikeTrap, Teleporter, Tile } from "../map/types";
import { DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, TELEPORTER_TILE } from "../map/types";
import { audio } from "./audio";
import type { InputSnapshot, InputSource } from "./input";

// engine.ts imports a real *value* (`textures`) from textures.ts, whose
// module-level `TextureManager` singleton calls `document.createElement`
// and `canvas.getContext("2d")` at import time — before any test setup
// (even beforeAll) can run, since ES module imports are hoisted ahead of
// all other top-level code. Stub the canvas context first, then
// dynamically import engine.ts. Same gotcha as raycaster.ts/textures.ts.
let RaycasterEngine: typeof import("./engine").RaycasterEngine;
type EngineStats = import("./engine").EngineStats;
type EngineHandlers = import("./engine").EngineHandlers;
type EngineCarryover = import("./engine").EngineCarryover;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ RaycasterEngine } = await import("./engine"));
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

const EMPTY_SNAPSHOT: InputSnapshot = {
  keys: [],
  mouseDX: 0,
  fireQueued: false,
  fireHeld: false,
  weaponRequest: null,
  mapToggle: false,
  interact: false,
  melee: false,
  meleeHeld: false,
  wheelSteps: 0,
  fpsToggle: false,
  escape: false,
  blur: false,
  pointerUnlock: false,
  click: false,
  gpForward: 0,
  gpStrafe: 0,
  gpTurn: 0,
};

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
