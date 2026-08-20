// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Geometry for the status bar, as pure arithmetic with no canvas context.
 *
 * Split out of `hud.ts` for one reason: the bar's panel positions used to be
 * hard-coded literals (12 / 205 / 275 / 375, score right-aligned at `w - 12`),
 * so it did not scale. At the "Sharp" 1280x800 preset that left roughly 800
 * blank pixels between the keys and the score. A layout that is a *pure
 * function of the canvas width* can be tested at every preset without the
 * canvas mock, which is what makes that defect regressible rather than
 * re-discoverable.
 *
 * Returning rects rather than drawing is the same convention `renderMinimap`
 * already follows with `MinimapPanelRect` — the caller gets geometry and
 * decides what to put in it. It is also the hook a future WAD `STBAR` skin
 * would blit into, instead of re-deriving positions.
 */

/** One panel's box, in canvas pixels. */
export interface HudPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Panels, left to right. DOOM's order where an equivalent exists: ammo far
 * left, the face centred as the bar's anchor, ARMS/ARMOR (here TOOLS/SWAP)
 * flanking it, keys after. `score` has no DOOM counterpart and takes the slot
 * before the table; `table` terminates the bar as DOOM's does. */
export type HudPanelKey = "ammo" | "stabil" | "tools" | "face" | "swap" | "keys" | "score" | "table";

export interface HudLayout {
  /** The full-width strip, including the 2px top accent. */
  bar: HudPanelRect;
  panels: Record<HudPanelKey, HudPanelRect>;
  /** x of each 1px bezel rule between panels. */
  dividers: number[];
}

/**
 * Height, in canvas pixels, of the native status bar at the bottom.
 *
 * **Derived from the ammo table, not chosen.** Five rows at a 12px pitch put
 * baselines at +16/+28/+40/+52/+64; 8px of bottom margin clears the descenders
 * on the last row, and the 2px accent sits on top. 58 (the pre-2026-08-20
 * value) cannot hold five rows at any legible pitch, and 64 forces an 8px
 * pitch that collides with descenders at the 9px label font.
 *
 * This is 18% of a 400px frame against DOOM's 16% — the extra is our 9px
 * labels against DOOM's 6px `STYSNUM`, which is a consequence of keeping this
 * game's vocabulary rather than DOOM's four-letter words.
 */
export const HUD_HEIGHT = 72;

/** Horizontal padding inside a panel, and the gap the bezel rules sit in. */
export const HUD_PAD = 8;

/**
 * The bar's contents stop widening past this, and centre instead.
 *
 * Classic (640) and Sharp (1280) both stretch fully, so every real preset uses
 * the whole width. It exists for the measurement-only `?renderRes=2560x1600`
 * case, where eight panels sharing 2,560px would each be ~300px wide holding
 * one 9px label — the bar would read as empty rather than as a status bar.
 */
export const HUD_MAX_CONTENT_W = 1280;

/**
 * Minimum width and surplus share per panel.
 *
 * `min` is what the panel needs to be legible; `weight` distributes whatever
 * is left over. The sum of `min` plus the dividers is 613, so 640 fits with
 * slack and the squeeze branch below is unreachable at any real preset — it
 * exists only so `?renderRes=160x100` degrades instead of producing negative
 * widths.
 */
const PANEL_SPECS: readonly { key: HudPanelKey; min: number; weight: number }[] = [
  { key: "ammo", min: 92, weight: 1.0 },
  { key: "stabil", min: 120, weight: 1.2 },
  { key: "tools", min: 90, weight: 0.8 },
  { key: "face", min: 48, weight: 0.3 },
  { key: "swap", min: 64, weight: 0.8 },
  { key: "keys", min: 68, weight: 0.8 },
  { key: "score", min: 76, weight: 0.9 },
  { key: "table", min: 76, weight: 0.9 },
];

/** Panel labels. Named so a rename moves one string — the settled shorthands
 * (see `doc/dev/game-design.md`): our words, DOOM's layout. `STAB` was
 * rejected for health because it reads as a melee verb in a shooter. */
export const LABEL_AMMO = "AMMO";
export const LABEL_STABIL = "STABIL";
export const LABEL_TOOLS = "TOOLS";
export const LABEL_SWAP = "SWAP";
export const LABEL_KEYS = "KEYS";
export const LABEL_SCORE = "SCORE";

/**
 * Where every panel sits, for a canvas of `canvasW` x `canvasH`.
 *
 * Pure and cheap — called once per frame rather than cached, because a cache
 * keyed on width would add an invalidation surface for arithmetic that costs
 * nothing. `canvasH` is read only to place the bar against the bottom edge.
 */
/**
 * **The bar is fixed-pixel, deliberately, and does not scale with resolution.**
 *
 * Every other overlay is too — the minimap's `maxPixels`, the viewmodel's
 * fixed travel, the crosshair, the toasts. The "Sharp" preset is exactly 2x
 * and CSS-scales back to the same display size, so the whole overlay layer is
 * uniformly half-size there. Scaling only the HUD would hand it twice the
 * visual weight of the weapon in your hands.
 *
 * The defect this module fixes was *horizontal* — panels clustered left with
 * dead space after them — and that is fixed at every width. Making the overlay
 * layer scale as a whole is a separate item touching `viewmodel.ts` and
 * `renderMinimap` as well as this, and it should move all three together or
 * none.
 */
export function layoutHud(canvasW: number, canvasH: number): HudLayout {
  const bar: HudPanelRect = { x: 0, y: canvasH - HUD_HEIGHT, w: canvasW, h: HUD_HEIGHT };
  const dividerCount = PANEL_SPECS.length - 1;
  const contentW = Math.min(canvasW - HUD_PAD * 2, HUD_MAX_CONTENT_W);
  const usable = contentW - dividerCount;
  const totalMin = PANEL_SPECS.reduce((sum, p) => sum + p.min, 0);
  const totalWeight = PANEL_SPECS.reduce((sum, p) => sum + p.weight, 0);

  // Below the minimum the only honest option is a uniform squeeze: every panel
  // shrinks by the same ratio, so the order and relative emphasis survive even
  // though nothing is legible. Reachable only via `?renderRes` far below any
  // shipped preset.
  const squeeze = usable < totalMin ? usable / totalMin : 1;
  const surplus = usable > totalMin ? usable - totalMin : 0;

  const startX = Math.round((canvasW - contentW) / 2);
  const panels = {} as Record<HudPanelKey, HudPanelRect>;
  const dividers: number[] = [];
  let x = startX;
  PANEL_SPECS.forEach((spec, i) => {
    const w = Math.max(1, Math.round(spec.min * squeeze + (surplus * spec.weight) / totalWeight));
    panels[spec.key] = { x, y: bar.y, w, h: HUD_HEIGHT };
    x += w;
    if (i < dividerCount) {
      dividers.push(x);
      x += 1;
    }
  });
  return { bar, panels, dividers };
}
