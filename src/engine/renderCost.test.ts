// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Regression guard for the 2026-08 performance audit's finding P1
 * (`doc/dev/perf-review-2026-08-02.md`).
 *
 * On a GPU-accelerated Canvas 2D, geometry the rasteriser cannot emit as
 * axis-aligned quads needs a coverage pass, which flushes the batched quad
 * stream and resolves the render target. Measured on the reference machine,
 * **one** such call anywhere in a frame costs ~10ms of a 16.7ms budget — the
 * penalty is fixed, independent of how many you make and of where in the
 * frame they land. Three separate rounds of that audit reached three
 * different wrong conclusions about which calls are in the class, so the
 * membership here is measured, not reasoned:
 *
 * - `fill()` / `stroke()` of a path: 1 per frame → 48fps (59 without).
 * - `strokeRect()` while `lineJoin` is `"round"`: 1 per frame → 48fps.
 * - `strokeRect()` under the default miter join: free at 24 per frame.
 * - `strokeText()`, `fillRect()` (thousands), `drawImage()` (scaled or not),
 *   and an axis-aligned rect `clip()`: all free.
 *
 * So this bans exactly the three calls that actually rasterise
 * (`fill`/`stroke`/`strokeRect`) from every renderer that runs on a normal
 * frame. Path *building* (`beginPath`/`moveTo`/`lineTo`/`arc`/`rect`) is
 * allowed — it costs nothing until something fills or strokes it, and the
 * automap's viewport `clip()` legitimately builds a rect path.
 *
 * **Why this test and not a code review rule:** the expensive case is
 * invisible at the call site. `ctx.strokeRect(...)` is free or costs a
 * quarter of the frame budget depending on a `lineJoin` set by whatever drew
 * before it — `drawWeapon` sets exactly that. Nothing about the source of a
 * regression would look wrong.
 *
 * The renderers must be exercised on their **fast path**, which only engages
 * when `pathSprites.ts` can verify a real offscreen surface — hence the
 * painting stub and the fresh module graph below. Without that they take the
 * direct-draw fallback, which is *supposed* to use paths, and this would pass
 * vacuously.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { GameMap, Mine, Tile } from "../map/types";
import type { Player } from "./player";

/** The three calls that rasterise. Everything else measured free. */
const RASTERISING_CALLS = ["fill", "stroke", "strokeRect"] as const;

type Renderers = {
  drawWeapon: typeof import("./viewmodel").drawWeapon;
  renderMinimap: typeof import("./raycaster").renderMinimap;
  drawCompass: typeof import("./hud").drawCompass;
  drawHud: typeof import("./hud").drawHud;
  faceGlyph: typeof import("./hudFace").faceGlyph;
  allFaceKeys: typeof import("./hudFace").allFaceKeys;
  drawCrosshair: typeof import("./hud").drawCrosshair;
  drawCheatToast: typeof import("./hud").drawCheatToast;
  drawOutOfAmmoToast: typeof import("./hud").drawOutOfAmmoToast;
  drawAcidOverflowToast: typeof import("./hud").drawAcidOverflowToast;
  drawLockedDoorToast: typeof import("./hud").drawLockedDoorToast;
  drawKillStreakToast: typeof import("./hud").drawKillStreakToast;
  drawExitCountdownToast: typeof import("./hud").drawExitCountdownToast;
  drawSpectatingBanner: typeof import("./hud").drawSpectatingBanner;
  drawAutomap: typeof import("./automap").drawAutomap;
  drawHelpPingToast: typeof import("./hud").drawHelpPingToast;
  drawBulletTraces: typeof import("./effects").drawBulletTraces;
  drawFlameStreams: typeof import("./effects").drawFlameStreams;
  renderExplosions: typeof import("./effects").renderExplosions;
  renderBlood: typeof import("./effects").renderBlood;
  renderBurnParticles: typeof import("./effects").renderBurnParticles;
  renderExplosionParticles: typeof import("./effects").renderExplosionParticles;
  drawDamageFlash: typeof import("./effects").drawDamageFlash;
  makeBulletTrace: typeof import("./effects").makeBulletTrace;
  spawnFlameStream: typeof import("./effects").spawnFlameStream;
  collectLootBillboards: typeof import("./sprites").collectLootBillboards;
  collectTeleporterBillboards: typeof import("./sprites").collectTeleporterBillboards;
  collectEnemyBillboards: typeof import("./sprites").collectEnemyBillboards;
  collectMineBillboards: typeof import("./sprites").collectMineBillboards;
  collectKeyBillboards: typeof import("./sprites").collectKeyBillboards;
  collectExitBillboard: typeof import("./sprites").collectExitBillboard;
  offscreenSpritesAvailable: typeof import("./pathSprites").offscreenSpritesAvailable;
  PlayerCtor: typeof import("./player").Player;
  textures: typeof import("./textures").textures;
};

let R: Renderers;

const WIDTH = 640;
const HEIGHT = 400;

/** Offscreen contexts that actually "paint", so `pathSprites`' load-time
 * capability probe passes and every renderer takes its pre-rendered path. */
function stubPaintingOffscreen(): void {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = function (this: HTMLCanvasElement) {
    const ctx = createMockCanvasContext(this);
    ctx.getImageData = vi.fn((_sx: number, _sy: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }));
    return ctx;
  };
}

beforeAll(async () => {
  stubPaintingOffscreen();
  vi.resetModules();
  const [viewmodel, raycaster, hud, automap, effects, sprites, pathSprites, player, textures] = await Promise.all([
    import("./viewmodel"), import("./raycaster"), import("./hud"), import("./automap"),
    import("./effects"), import("./sprites"), import("./pathSprites"), import("./player"), import("./textures"),
  ]);
  const hudFace = await import("./hudFace");
  R = {
    ...viewmodel, ...raycaster, ...hud, ...automap, ...effects, ...sprites, ...hudFace,
    offscreenSpritesAvailable: pathSprites.offscreenSpritesAvailable,
    PlayerCtor: player.Player,
    textures: textures.textures,
  } as unknown as Renderers;
});

/**
 * The canvas size the current `describe.each` arm is running at.
 *
 * Module-level rather than threaded through every `sceneCtx()` call because
 * there are two dozen of them and the alternative is two dozen chances to
 * forget one — which would look like coverage of both presets while silently
 * testing only the first.
 */
let preset: readonly [number, number] = [WIDTH, HEIGHT];

/** A scene context distinct from every offscreen one, so what reaches the
 * real canvas is what gets asserted on. */
function sceneCtx(): MockCanvasContext {
  return createMockCanvasContext({ width: preset[0], height: preset[1] } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

function expectNoRasterisingCalls(c: MockCanvasContext, what: string): void {
  for (const call of RASTERISING_CALLS) {
    const times = c[call].mock.calls.length;
    expect(
      times,
      `${what} issued ${times} ctx.${call}() call(s) on the scene canvas. ` +
        `Each one costs ~10ms of a 16.7ms frame budget (see this file's header and finding P1). ` +
        `Use a pre-rendered Glyph via drawGlyph/drawRotatedGlyph, outlineRect, fillLine or drawDisc instead.`,
    ).toBe(0);
  }
}

function grid(size: number, fill: Tile = 0): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(fill) as Tile[]);
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 12): GameMap {
  return {
    width: size, height: size, grid: grid(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(true) as boolean[]),
    rooms: [], breakupRooms: [], spawn: { x: 1, y: 1 }, enemies: [],
    exit: { x: size - 1, y: size - 1 }, shortestPathTiles: 0, hazards: [], doors: [], gates: [],
    keys: [], decorations: [], teleporters: [], spikeTraps: [], mines: [], ammoPickups: [],
    loreTerminals: [], bonusLevel: false, styleSet: "stone", secretRoomCount: 0,
    switchboardRooms: [], exceptionZones: [], vendorDepots: [], acidOverflows: [],
    ...overrides,
  } as GameMap;
}

function fakePlayer(overrides: Partial<Player> = {}): Player {
  return { posX: 5.5, posY: 5.5, dirX: 1, dirY: 0, planeX: 0, planeY: 0.66, ...overrides } as Player;
}

function zBuffer(value = Infinity): Float64Array {
  return new Float64Array(WIDTH).fill(value);
}

/**
 * Both shipped presets.
 *
 * Not decoration: the overlay layer now pre-renders its glyphs at the
 * context's own scale (`pathSprites.ts`), so Sharp bakes different-sized
 * sprites and can take a different branch — an atlas that no longer fits its
 * strip falls back to live rotation, which is exactly the rasterising geometry
 * this file exists to forbid. Running at 640 alone could not see that.
 */
const PRESETS = [
  [640, 400],
  [1280, 800],
] as const;

describe.each(PRESETS)("per-frame renderers issue no rasterising path geometry at %ix%i", (w, h) => {
  beforeEach(() => {
    preset = [w, h];
  });

  it("takes the pre-rendered fast path in this environment (otherwise the guard is vacuous)", () => {
    expect(R.offscreenSpritesAvailable()).toBe(true);
  });

  it("drawWeapon — every kind, both flash states, rest and full recoil, mid-reload", () => {
    const kinds = ["pistol", "shotgun", "mp", "rocket", "flamethrower", "knife", "chainsaw"] as const;
    for (const kind of kinds) {
      for (const flash of [false, true]) {
        for (const recoil of [0, 0.5, 1]) {
          // The reload dip is a pure anchor translation today, so it cannot
          // add geometry — this dimension exists so that a future reload
          // animation that draws live paths per frame is caught here.
          for (const reloadProgress of [0, 0.5]) {
            const c = sceneCtx();
            R.drawWeapon(asCtx(c), { bobX: 3.4, bobY: -2.1, recoil, flash, reloadProgress, kind });
            expectNoRasterisingCalls(c, `drawWeapon(${kind}, flash=${flash}, recoil=${recoil}, reload=${reloadProgress})`);
          }
        }
      }
    }
  });

  it("renderMinimap — player marker and compass badge", () => {
    const c = sceneCtx();
    const map = fakeMap();
    R.renderMinimap(asCtx(c), map, new R.PlayerCtor(map));
    expectNoRasterisingCalls(c, "renderMinimap");
  });

  it("renderMinimap — the key ping's sonar ring", () => {
    // The ring is the one marker on this panel big enough that `strokeRect`
    // would be the obvious way to draw it. It has to go through `outlineRect`.
    const c = sceneCtx();
    const map = fakeMap();
    R.renderMinimap(
      asCtx(c),
      map,
      new R.PlayerCtor(map),
      0,
      70,
      undefined,
      0,
      [],
      [],
      undefined,
      { x: 4.5, y: 4.5 },
    );
    expectNoRasterisingCalls(c, "renderMinimap(pingedKey)");
  });

  it("drawCompass — the rotating needle", () => {
    for (const bearing of [0, 1.2, -2.7, Math.PI]) {
      const c = sceneCtx();
      R.drawCompass(asCtx(c), { cx: 90, cy: 90, r: 13 }, 5, 5, bearing, 10, 5);
      expectNoRasterisingCalls(c, `drawCompass(bearing=${bearing})`);
    }
  });

  it("drawAutomap — tiles, markers and the player triangle", () => {
    const c = sceneCtx();
    R.drawAutomap(asCtx(c), fakeMap({ mines: [{ x: 5, y: 5, alive: true, visible: true, closeTimer: 0 } as Mine] }), fakePlayer());
    expectNoRasterisingCalls(c, "drawAutomap");
  });

  it("renderMinimap — a help-pinging teammate's sonar ring", () => {
    // Same reasoning as the key ping above: the ring is the one marker big
    // enough that `strokeRect` would be the obvious way to draw it, and there
    // is now a second renderer drawing one.
    const c = sceneCtx();
    const map = fakeMap();
    R.renderMinimap(asCtx(c), map, new R.PlayerCtor(map), 0, 70, undefined, 0, [], [], undefined, null, [
      { x: 4.5, y: 4.5, color: "#60a5fa", helpPing: true },
    ]);
    expectNoRasterisingCalls(c, "renderMinimap(teammates)");
  });

  it("drawAutomap — a help-pinging teammate's sonar ring", () => {
    const c = sceneCtx();
    R.drawAutomap(asCtx(c), fakeMap(), fakePlayer(), 0, [], [
      { x: 4.5, y: 4.5, color: "#60a5fa", helpPing: true },
    ]);
    expectNoRasterisingCalls(c, "drawAutomap(teammates)");
  });

  it("drawHud and drawCrosshair", () => {
    const c = sceneCtx();
    R.drawCrosshair(asCtx(c), true, 12);
    R.drawHud(asCtx(c), {
      health: 55, maxHealth: 100, swap: 3, bullets: 40, rockets: 2, smg: 10, gas: 8,
      heldGates: [0], gateColors: [0, 1], score: 1234, kills: 7, weaponIndex: 0, ownedWeapons: [0],
      godMode: false, noClip: false, showFps: false, status: "alive", spectateTargetId: null,
    } as never);
    expectNoRasterisingCalls(c, "drawHud + drawCrosshair");
  });

  it("every face sprite, not just the one the default stats pick", () => {
    // The face is by far the likeliest thing here to reintroduce a path fill,
    // and `drawGlyph` falls back to running a glyph's own `draw` against *this*
    // context when no offscreen surface exists — so a path-based face would
    // issue real fill() calls on the scene canvas in that environment. Loop
    // every key the selector can emit rather than trusting one sample.
    for (const key of R.allFaceKeys()) {
      const c = sceneCtx();
      R.faceGlyph(key).draw(asCtx(c), 40, 40);
      expectNoRasterisingCalls(c, `faceGlyph(${key})`);
    }
  });

  it("the transient toasts and standing banners", () => {
    const c = sceneCtx();
    R.drawCheatToast(asCtx(c), "IDKFA — Full arsenal", 1);
    R.drawOutOfAmmoToast(asCtx(c), 1);
    R.drawAcidOverflowToast(asCtx(c), 1);
    R.drawLockedDoorToast(asCtx(c), 1, 1);
    R.drawHelpPingToast(asCtx(c), "Guest-1", "#60a5fa", 1);
    R.drawKillStreakToast(asCtx(c), "ULTRA KILL!", 1, true);
    R.drawExitCountdownToast(asCtx(c), 90);
    R.drawSpectatingBanner(asCtx(c), "guest-1");
    expectNoRasterisingCalls(c, "toasts and banners");
  });

  it("combat effects — tracers, flame streams, explosions, particles, damage flash", () => {
    const c = sceneCtx();
    const p = fakePlayer();
    const z = zBuffer();
    R.drawDamageFlash(asCtx(c), 0.8);
    R.drawBulletTraces(asCtx(c), [
      R.makeBulletTrace(WIDTH, HEIGHT, 50, 20, "#ff0000"),
      R.makeBulletTrace(WIDTH, HEIGHT, 600, 180, "#00ff00"),
    ]);
    R.drawFlameStreams(asCtx(c), WIDTH, HEIGHT, [R.spawnFlameStream(HEIGHT, 200, 440, "#ffaa00")]);
    R.renderExplosions(asCtx(c), p, [{ x: 6.5, y: 5.5, radius: 2, life: 0.2, maxLife: 0.35 }], z);
    R.renderExplosionParticles(asCtx(c), p, [{ x: 6.5, y: 5.5, z: 0.3, vx: 0, vy: 0, vz: 0, life: 0.2, maxLife: 0.4 }], z);
    R.renderBurnParticles(asCtx(c), p, [{ x: 6.5, y: 5.5, z: 0, vx: 0, vy: 0, vz: 0, life: 1, settled: true }], z);
    R.renderBlood(asCtx(c), p, [{ x: 6.5, y: 5.5, z: 0, vx: 0, vy: 0, vz: 0, life: 1, settled: true }], z, 1);
    expectNoRasterisingCalls(c, "combat effects");
  });

  it("world billboards — loot rings, teleporter pads, enemies, mines, keys, exit", () => {
    const c = sceneCtx();
    const map = fakeMap();
    const p = new R.PlayerCtor(map);
    const z = zBuffer();
    const jobs = [
      ...R.collectLootBillboards(asCtx(c), p, [{ x: p.posX + 3, y: p.posY, kind: "weapon" }], z),
      ...R.collectTeleporterBillboards(asCtx(c), p, [{ x: p.posX + 3, y: p.posY, targetX: 0, targetY: 0, label: "goto" }], z),
      ...R.collectMineBillboards(asCtx(c), p, [{ x: p.posX + 3, y: p.posY, alive: true, visible: true, closeTimer: 0 } as Mine], z),
      ...R.collectKeyBillboards(asCtx(c), p, [{ x: p.posX + 3, y: p.posY, collected: false, gateId: 0 } as never], z),
      ...R.collectExitBillboard(asCtx(c), p, { x: Math.floor(p.posX) + 3, y: Math.floor(p.posY) }, z),
    ];
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) job.draw();
    expectNoRasterisingCalls(c, "world billboards");
  });
});
