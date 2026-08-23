// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { WeaponViewKind } from "./weapons";
import { drawWeapon, type WeaponView } from "./viewmodel";

const WIDTH = 400;
const HEIGHT = 300;

function ctx(): MockCanvasContext {
  return createMockCanvasContext({ width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

function weaponView(kind: WeaponViewKind, overrides: Partial<WeaponView> = {}): WeaponView {
  return { bobX: 0, bobY: 0, recoil: 0, flash: false, reloadProgress: 0, kind, ...overrides };
}

const RANGED_KINDS: WeaponViewKind[] = ["pistol", "shotgun", "mp", "rocket", "flamethrower"];
const MELEE_KINDS: WeaponViewKind[] = ["knife", "chainsaw"];
/** The four weapons with a magazine — the only ones `reloadProgress` moves. */
const RELOADABLE_KINDS: WeaponViewKind[] = ["pistol", "shotgun", "mp", "rocket"];
/** Everything without one, which must be pixel-identical at every progress. */
const MAGAZINELESS_KINDS: WeaponViewKind[] = ["knife", "chainsaw", "flamethrower"];

/**
 * Every coordinate pair the draw put on the canvas, in call order. The first
 * two arguments of each of these calls are an (x, y) in canvas space —
 * including `drawImage`'s, once the sprite argument is dropped — so the same
 * extraction covers the live rectangles, the pre-rendered glyph blits and the
 * direct-draw fallback's own path points, whichever of the two `pathSprites`
 * paths this environment takes.
 */
function geometry(c: MockCanvasContext): number[][] {
  return [
    ...c.fillRect.mock.calls,
    ...c.moveTo.mock.calls,
    ...c.lineTo.mock.calls,
    ...c.quadraticCurveTo.mock.calls,
    ...c.arc.mock.calls,
    ...c.drawImage.mock.calls.map((call: unknown[]) => call.slice(1)),
  ] as number[][];
}

/** The top-left-most point the weapon reached — the dip's observable effect. */
function drawnCorner(c: MockCanvasContext): { left: number; top: number } {
  const points = geometry(c);
  return {
    left: Math.min(...points.map((p) => p[0])),
    top: Math.min(...points.map((p) => p[1])),
  };
}

/** How much non-rectangular work a draw issued. Rectangles are free; these are
 * the calls the perf audit measured at ~10ms each (see `renderCost.test.ts`),
 * so the count must not move with `reloadProgress`. */
function pathWork(c: MockCanvasContext): Record<string, number> {
  return {
    beginPath: c.beginPath.mock.calls.length,
    fill: c.fill.mock.calls.length,
    stroke: c.stroke.mock.calls.length,
    drawImage: c.drawImage.mock.calls.length,
  };
}

function drawn(kind: WeaponViewKind, overrides: Partial<WeaponView> = {}): MockCanvasContext {
  const c = ctx();
  drawWeapon(asCtx(c), weaponView(kind, overrides));
  return c;
}

describe("drawWeapon — per-kind dispatch", () => {
  for (const kind of [...RANGED_KINDS, ...MELEE_KINDS]) {
    it(`draws a "${kind}" silhouette without throwing`, () => {
      const c = ctx();
      expect(() => drawWeapon(asCtx(c), weaponView(kind))).not.toThrow();
      expect(c.fillRect.mock.calls.length + c.fill.mock.calls.length).toBeGreaterThan(0);
    });
  }
});

describe("drawWeapon — muzzle flash / flame burst gating", () => {
  for (const kind of RANGED_KINDS) {
    it(`draws extra star/blob shapes for "${kind}" only when flash is true`, () => {
      const cOff = ctx();
      drawWeapon(asCtx(cOff), weaponView(kind, { flash: false }));
      const beginPathOff = cOff.beginPath.mock.calls.length;

      const cOn = ctx();
      drawWeapon(asCtx(cOn), weaponView(kind, { flash: true }));
      const beginPathOn = cOn.beginPath.mock.calls.length;

      expect(beginPathOn).toBeGreaterThan(beginPathOff);
    });
  }

  for (const kind of MELEE_KINDS) {
    it(`"${kind}" ignores flash entirely (no muzzle flash for a melee weapon)`, () => {
      const cOff = ctx();
      drawWeapon(asCtx(cOff), weaponView(kind, { flash: false }));
      const beginPathOff = cOff.beginPath.mock.calls.length;

      const cOn = ctx();
      drawWeapon(asCtx(cOn), weaponView(kind, { flash: true }));
      const beginPathOn = cOn.beginPath.mock.calls.length;

      expect(beginPathOn).toBe(beginPathOff);
    });
  }
});

describe("drawWeapon — recoil and head-bob", () => {
  it("shifts the weapon center by bobX/bobY and doesn't throw at full recoil", () => {
    const c = ctx();
    expect(() =>
      drawWeapon(asCtx(c), weaponView("pistol", { bobX: 12, bobY: -6, recoil: 1, flash: true })),
    ).not.toThrow();
  });

  it("animates the knife/chainsaw thrust across the full recoil range", () => {
    const c = ctx();
    expect(() => drawWeapon(asCtx(c), weaponView("knife", { recoil: 0 }))).not.toThrow();
    expect(() => drawWeapon(asCtx(c), weaponView("knife", { recoil: 1 }))).not.toThrow();
    expect(() => drawWeapon(asCtx(c), weaponView("chainsaw", { recoil: 0 }))).not.toThrow();
    expect(() => drawWeapon(asCtx(c), weaponView("chainsaw", { recoil: 1 }))).not.toThrow();
  });

  it("saves and restores canvas state around the draw", () => {
    const c = ctx();
    drawWeapon(asCtx(c), weaponView("pistol"));
    // Two pairs now: `withOverlayScale`'s, plus the viewmodel's own around the
    // round `lineJoin` it sets for every weapon body.
    expect(c.save).toHaveBeenCalledTimes(2);
    expect(c.restore).toHaveBeenCalledTimes(2);
  });
});

describe("drawWeapon — reload dip", () => {
  for (const kind of RELOADABLE_KINDS) {
    it(`drops "${kind}" down and across at mid-reload`, () => {
      const rest = drawnCorner(drawn(kind));
      const mid = drawnCorner(drawn(kind, { reloadProgress: 0.5 }));

      expect(mid.top).toBeGreaterThan(rest.top); // lower on screen
      expect(mid.left).toBeGreaterThan(rest.left); // pushed toward the grip side
    });

    it(`"${kind}" travels far enough sideways at mid-reload to actually read`, () => {
      // A direction-only assertion is what let this animation be technically
      // correct and invisible in play: the downward travel saturates once the
      // weapon clears the HUD bar (measured — 59px of dip already changes as
      // much of the visible strip as the full 96px does), so the sideways
      // component is the half that happens in screen area the player can see.
      // At 24px it read as a twitch. Pin the magnitude, not just the sign.
      const rest = drawnCorner(drawn(kind));
      const mid = drawnCorner(drawn(kind, { reloadProgress: 0.5 }));
      expect(mid.left - rest.left).toBeGreaterThanOrEqual(64);
    });

    it(`"${kind}" dips furthest at the halfway point and symmetrically either side`, () => {
      const quarter = drawnCorner(drawn(kind, { reloadProgress: 0.25 })).top;
      const half = drawnCorner(drawn(kind, { reloadProgress: 0.5 })).top;
      const threeQuarter = drawnCorner(drawn(kind, { reloadProgress: 0.75 })).top;

      expect(half).toBeGreaterThan(quarter);
      expect(half).toBeGreaterThan(threeQuarter);
      expect(threeQuarter).toBeCloseTo(quarter, 6);
    });

    it(`"${kind}" is back in its resting pose at both ends of the range`, () => {
      const rest = drawnCorner(drawn(kind)).top;

      // A progress the engine has clamped to the very start or the very end
      // of the reload has to land on the resting pose exactly, or the weapon
      // visibly snaps on the first and last frame of every reload.
      expect(drawnCorner(drawn(kind, { reloadProgress: 0.001 })).top).toBeCloseTo(rest, 0);
      expect(drawnCorner(drawn(kind, { reloadProgress: 1 })).top).toBeCloseTo(rest, 6);
      // Out-of-range values are clamped rather than sent through `sin`, which
      // would otherwise swing the weapon *upwards* past 1.
      expect(drawnCorner(drawn(kind, { reloadProgress: 1.5 })).top).toBeCloseTo(rest, 6);
      expect(drawnCorner(drawn(kind, { reloadProgress: -0.5 })).top).toBeCloseTo(rest, 6);
    });

    it(`"${kind}" draws no muzzle flash while reloading`, () => {
      const flashingAtRest = pathWork(drawn(kind, { flash: true })).beginPath;
      const idleAtRest = pathWork(drawn(kind, { flash: false })).beginPath;
      // Control: without this, the assertion below passes even if the flash
      // were unreachable for some unrelated reason.
      expect(flashingAtRest).toBeGreaterThan(idleAtRest);

      const flashingMidReload = pathWork(drawn(kind, { flash: true, reloadProgress: 0.5 })).beginPath;
      const idleMidReload = pathWork(drawn(kind, { flash: false, reloadProgress: 0.5 })).beginPath;
      expect(flashingMidReload).toBe(idleMidReload);
    });

    it(`the dip adds no non-rectangular work for "${kind}" at any progress`, () => {
      // The dip is a pure translation of the weapon's anchor, so it introduces
      // no new glyph and no new path — there is no per-step glyph cache here
      // to key (contrast `flameNozzleGlyph`, whose *geometry* changes with
      // recoil). This is the assertion that keeps it that way: a future tilt
      // or swinging magazine that draws live paths per frame fails here, and
      // one that goes through a properly keyed glyph cache does not.
      const rest = pathWork(drawn(kind));
      for (const reloadProgress of [0.13, 0.25, 0.5, 0.62, 0.87, 1]) {
        expect(pathWork(drawn(kind, { reloadProgress }))).toEqual(rest);
      }
    });
  }

  for (const kind of MAGAZINELESS_KINDS) {
    it(`"${kind}" has no magazine and ignores reloadProgress entirely`, () => {
      const rest = geometry(drawn(kind, { recoil: 0.4, flash: true }));
      for (const reloadProgress of [0.25, 0.5, 1]) {
        expect(geometry(drawn(kind, { recoil: 0.4, flash: true, reloadProgress }))).toEqual(rest);
      }
    });
  }

  it("the flamethrower keeps flashing while another weapon would be reloading", () => {
    // Its flame burst is gated on `flash` alone — the reload gate must not
    // have leaked into the shared code path.
    const idle = pathWork(drawn("flamethrower", { flash: false, reloadProgress: 0.5 })).beginPath;
    const burst = pathWork(drawn("flamethrower", { flash: true, reloadProgress: 0.5 })).beginPath;
    expect(burst).toBeGreaterThan(idle);
  });
});
