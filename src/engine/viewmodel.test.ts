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
  return { bobX: 0, bobY: 0, recoil: 0, flash: false, kind, ...overrides };
}

const RANGED_KINDS: WeaponViewKind[] = ["pistol", "shotgun", "mp", "rocket", "flamethrower"];
const MELEE_KINDS: WeaponViewKind[] = ["knife", "chainsaw"];

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
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);
  });
});
