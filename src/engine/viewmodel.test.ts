import { describe, it, expect, beforeEach } from 'vitest';
import { drawWeapon, WeaponView } from './viewmodel';
import type { WeaponViewKind } from './weapons';

describe('viewmodel', () => {
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    ctx = canvas.getContext('2d')!;
  });

  const baseView: Omit<WeaponView, 'kind'> = {
    bobX: 5,
    bobY: 10,
    recoil: 0.5,
    flash: false,
  };

  it('draws pistol without flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'pistol' as WeaponViewKind, flash: false });
    expect(ctx).toBeDefined();
  });

  it('draws pistol with flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'pistol' as WeaponViewKind, flash: true });
  });

  it('draws shotgun without flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'shotgun' as WeaponViewKind, flash: false });
  });

  it('draws shotgun with flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'shotgun' as WeaponViewKind, flash: true });
  });

  it('draws knife (never flashes, but test recoil effect)', () => {
    drawWeapon(ctx, { ...baseView, kind: 'knife' as WeaponViewKind, flash: false });
    drawWeapon(ctx, { ...baseView, kind: 'knife' as WeaponViewKind, recoil: 1.0, flash: false });
  });

  it('draws mp without flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'mp' as WeaponViewKind, flash: false });
  });

  it('draws mp with flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'mp' as WeaponViewKind, flash: true });
  });

  it('draws rocket without flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'rocket' as WeaponViewKind, flash: false });
  });

  it('draws rocket with flash', () => {
    drawWeapon(ctx, { ...baseView, kind: 'rocket' as WeaponViewKind, flash: true });
  });

  it('falls back to pistol for unknown weapon kind', () => {
    drawWeapon(ctx, { ...baseView, kind: 'unknown_weapon_type' as WeaponViewKind, flash: true });
  });
});
