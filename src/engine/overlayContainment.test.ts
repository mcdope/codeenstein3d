// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One property, checked over every overlay entry point at once: **the overlay
 * layer draws the same picture at every render preset.**
 *
 * The per-module suites check what each draw *says*; this one checks that they
 * all say it in the same space. Three legs, because no one of them is
 * sufficient:
 *
 * 1. **Exactly one `ctx.scale` per entry point.** Zero means an overlay was
 *    left out of the design space and will render at half weight at Sharp —
 *    which `drawHelpPingToast`, whose every coordinate is a literal, would
 *    otherwise pass every other check in this file while being wrong. Two
 *    means a double scale, the design's one real hazard.
 * 2. **Scale invariance.** The recorded draw arguments at Classic and at Sharp
 *    must be *equal*, not merely proportional. This is the property, stated
 *    with no literals in it at all, so it keeps holding as the overlays change.
 * 3. **Containment.** Nothing lands outside the design box at Sharp. Leg 2
 *    cannot see a draw that reads `ctx.canvas.width` and is *consistently*
 *    wrong about it; this can, because such a draw reaches 1280 where the box
 *    ends at 640.
 *
 * The two presets are compared through the same mock, so a difference here is a
 * difference in the code, not in the fixture.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { zeroScoreBreakdown } from "./scoring";
import { emptyPlayerFacingStats } from "./playerStats";
import type { EngineStats } from "./engine";
import type { GameMap, Tile } from "../map/types";
import type { Player } from "./player";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./overlayScale";
import {
  drawAcidOverflowToast,
  drawCheatToast,
  drawCompass,
  drawCrosshair,
  drawExitCountdownToast,
  drawFpsOverlay,
  drawHelpPingToast,
  drawHud,
  drawKillStreakToast,
  drawLockedDoorToast,
  drawLoreOverlay,
  drawOutOfAmmoToast,
  drawPauseOverlay,
  drawSpectatingBanner,
} from "./hud";
import { drawWeapon } from "./viewmodel";
import { drawAutomap } from "./automap";
import { drawBulletTraces, makeBulletTrace } from "./effects";

// `raycaster.ts` imports a real value from `textures.ts`, whose module-level
// singleton calls `getContext("2d")` at import time — before any test code can
// run, since ES imports are hoisted. Stub the context first, then import it
// dynamically. Same dance `raycaster.test.ts` documents at length.
let renderMinimap: typeof import("./raycaster").renderMinimap;
beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ renderMinimap } = await import("./raycaster"));
});

const CLASSIC: [number, number] = [640, 400];
const SHARP: [number, number] = [1280, 800];

function ctxAt(width: number, height: number): MockCanvasContext {
  return createMockCanvasContext({ width, height } as unknown as HTMLCanvasElement);
}
const asCtx = (c: MockCanvasContext): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D;

function fakePlayer(): Player {
  return { posX: 5.5, posY: 5.5, dirX: 1, dirY: 0 } as Player;
}

function fakeMap(size = 10): GameMap {
  return {
    width: size,
    height: size,
    grid: Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]),
    visited: Array.from({ length: size }, () => new Array(size).fill(true) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: size - 1, y: size - 1 },
    shortestPathTiles: 0,
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
  } as unknown as GameMap;
}

function fakeStats(): EngineStats {
  return {
    health: 80,
    maxHealth: 100,
    swap: 0,
    maxSwap: 100,
    hurtFrames: 0,
    hurtDir: 0,
    bullets: 10,
    shells: 4,
    magazine: 9,
    magazineSize: 9,
    reloading: false,
    rockets: 2,
    smg: 20,
    gas: 30,
    heldGates: [0],
    gateColors: [0, 1],
    cheatsUsed: true,
    rollbacksRemaining: 2,
    score: 471750,
    kills: 4,
    weaponIndex: 0,
    ownedWeapons: [0, 1, 2],
    godMode: false,
    noClip: false,
    showFps: false,
    levelScoreBreakdown: zeroScoreBreakdown(),
    runScoreBreakdown: zeroScoreBreakdown(),
    levelPlayerStats: emptyPlayerFacingStats(),
    runPlayerStats: emptyPlayerFacingStats(),
    status: "alive",
    spectateTargetId: null,
  } as unknown as EngineStats;
}

/**
 * Every overlay entry point, with arguments chosen to reach as much of each
 * one as possible — a cheated run holding rollbacks and a six-digit score for
 * the HUD, a gated door for the locked-door toast, a cone weapon for the
 * crosshair. A draw that never runs is a draw this file cannot vouch for.
 */
const ENTRY_POINTS: [string, (ctx: CanvasRenderingContext2D) => void][] = [
  ["drawCrosshair", (c) => drawCrosshair(c, true, 70)],
  ["drawFpsOverlay", (c) => drawFpsOverlay(c, 58, 16.7)],
  ["drawCheatToast", (c) => drawCheatToast(c, "IDDQD", 1)],
  ["drawOutOfAmmoToast", (c) => drawOutOfAmmoToast(c, 1)],
  ["drawAcidOverflowToast", (c) => drawAcidOverflowToast(c, 1)],
  ["drawLockedDoorToast", (c) => drawLockedDoorToast(c, 1, 1, 2)],
  ["drawHelpPingToast", (c) => drawHelpPingToast(c, "Guest-1", "#60a5fa", 1)],
  ["drawKillStreakToast", (c) => drawKillStreakToast(c, "ULTRA KILL", 1, true)],
  ["drawExitCountdownToast", (c) => drawExitCountdownToast(c, 150)],
  ["drawSpectatingBanner", (c) => drawSpectatingBanner(c, null)],
  ["drawPauseOverlay", (c) => drawPauseOverlay(c)],
  ["drawLoreOverlay", (c) => drawLoreOverlay(c, "Some lore about a function.", 0)],
  ["drawCompass", (c) => drawCompass(c, { cx: 78, cy: 78, r: 9 }, 5.5, 5.5, 0, 9.5, 9.5)],
  ["drawHud", (c) => drawHud(c, fakeStats())],
  ["drawWeapon", (c) => drawWeapon(c, { bobX: 0, bobY: 0, recoil: 0.4, flash: true, reloadProgress: 0, kind: "shotgun" })],
  ["drawAutomap", (c) => drawAutomap(c, fakeMap(), fakePlayer())],
  // Bound late: `renderMinimap` is only assigned once `beforeAll` has run.
  ["renderMinimap", (c) => renderMinimap(c, fakeMap(), fakePlayer())],
  [
    "drawBulletTraces",
    (c) => drawBulletTraces(c, [makeBulletTrace(DESIGN_WIDTH, DESIGN_HEIGHT, 400, 120, "#ffd166")]),
  ],
];

/** Every numeric argument of every recorded draw call, in order — the record
 * two presets are compared against. `save`/`restore`/`scale` are excluded:
 * they are the transform itself, and the whole point is that everything else
 * is stated without reference to it. */
const RECORDED = ["fillRect", "strokeRect", "fillText", "strokeText", "moveTo", "lineTo", "rect", "arc", "drawImage", "translate"] as const;

function drawRecord(c: MockCanvasContext): string {
  return RECORDED.flatMap((method) =>
    // Two decimals, not exact equality. A pre-rendered glyph's sprite is
    // allocated in whole *device* pixels (`makeSurface` ceils), so its size
    // expressed back in design pixels can differ between presets by up to
    // `1 / scale` — 0.0002 design px on the compass badge. That is the
    // allocation being honest about the pixel grid, not the overlay disagreeing
    // with itself, and rounding is the only place this file tolerates a gap.
    c[method].mock.calls.map((call: unknown[]) => `${method}(${call.map((a) => (typeof a === "number" ? a.toFixed(2) : typeof a)).join(",")})`),
  ).join("\n");
}

/** The numbers a draw record contains, for the containment leg. */
function numbersIn(c: MockCanvasContext): number[] {
  return RECORDED.flatMap((method) =>
    c[method].mock.calls.flatMap((call: unknown[]) => call.filter((a): a is number => typeof a === "number" && Number.isFinite(a))),
  );
}

describe("the overlay layer draws the same picture at every preset", () => {
  it.each(ENTRY_POINTS)("%s scales exactly once", (_name, draw) => {
    // Zero is an overlay left in device pixels; two is a double scale. Both
    // are silent at Classic, where the factor is 1.
    const c = ctxAt(...SHARP);
    draw(asCtx(c));
    expect(c.scale.mock.calls).toHaveLength(1);
    expect(c.scale.mock.calls[0], "uniform, and by the frame's own factor").toEqual([2, 2]);
  });

  it.each(ENTRY_POINTS)("%s records identical draws at Classic and at Sharp", (_name, draw) => {
    // The property, with no literals in it: same arguments, same order, same
    // count. A draw that read the canvas instead of the design box would differ
    // in every coordinate it derived.
    const classic = ctxAt(...CLASSIC);
    const sharp = ctxAt(...SHARP);
    draw(asCtx(classic));
    draw(asCtx(sharp));
    expect(drawRecord(sharp)).toBe(drawRecord(classic));
  });

  it.each(ENTRY_POINTS)("%s draws something at all", (_name, draw) => {
    // Without this the two legs above both pass vacuously on a draw that was
    // accidentally turned into a no-op — "identical" and "empty" look the same.
    const c = ctxAt(...SHARP);
    draw(asCtx(c));
    expect(numbersIn(c).length, "recorded coordinates").toBeGreaterThan(0);
  });

  it.each(ENTRY_POINTS)("%s stays inside the design box at Sharp", (_name, draw) => {
    // Catches a draw that is *consistently* wrong about the canvas — scale
    // invariance cannot see one, because it is equally wrong at both presets.
    // The bound is generous on purpose: a few overlays legitimately draw a
    // little outside the frame (the weapon's baseline sits on the bottom edge
    // and its recoil pushes past it). What no overlay does is reach 1280.
    const c = ctxAt(...SHARP);
    draw(asCtx(c));
    const limit = Math.max(DESIGN_WIDTH, DESIGN_HEIGHT) * 1.5;
    const worst = Math.max(...numbersIn(c).map(Math.abs));
    expect(worst, `furthest coordinate drawn`).toBeLessThanOrEqual(limit);
  });
});
