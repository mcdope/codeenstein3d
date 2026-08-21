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
 * Inset from the canvas edge to the first and last panel.
 *
 * Half `HUD_PAD`, and a separate constant because it answers a different
 * question: `HUD_PAD` keeps a panel's text off its own bezel, while this keeps
 * the bar's contents off the screen edge, where there is no neighbouring panel
 * to collide with. Sharing one value cost 8px of usable width at 640 — enough,
 * on its own, to push the minimums past what that preset can hold.
 */
export const HUD_BAR_MARGIN = 4;

/**
 * The TOOLS grid's cell geometry, here rather than in `hud.ts` because the
 * panel's minimum width is *derived* from it below. Keeping the two in
 * separate modules is what let the grid grow wider than the panel holding it:
 * the melee cell overflowed 20px into the face panel, and the face — drawn
 * afterwards — painted over it, leaving a letter poking out from behind the
 * head. Change a cell size here and the minimum follows.
 */
export const TOOL_CELL = 14;
export const TOOL_GAP = 3;
/** Cells in the grid. Pinned against `NUMBER_KEY_WEAPONS.length` by a test in
 * `hud.test.ts`; this module must not import the weapon table. */
export const TOOL_SLOTS = 5;
const TOOLS_MIN = HUD_PAD * 2 + TOOL_SLOTS * TOOL_CELL + (TOOL_SLOTS - 1) * TOOL_GAP;

/**
 * The KEYS grid's pip geometry, here for the same reason the TOOLS cells are:
 * the panel's minimum is *derived* from it below.
 *
 * The pips used to be laid out in `hud.ts` on a single row while this module
 * declared a width that had never been measured against them — four pips at a
 * 16px pitch need 68px and the panel was granted 57 at the Classic preset, so
 * the violet one hung 11px into SCORE. Two columns is what makes the block
 * bounded by the *grid* rather than by the gate count.
 */
export const KEY_PIP = 12;
export const KEY_PIP_GAP = 4;
export const KEY_PIP_PITCH = KEY_PIP + KEY_PIP_GAP;
export const KEY_COLS = 2;
/** Rows in the grid. Pinned against `GATE_COLOR_COUNT` by a test in
 * `hud.test.ts`; this module must not import the map types. */
export const KEY_ROWS = 2;
const KEYS_MIN = HUD_PAD * 2 + KEY_COLS * KEY_PIP + (KEY_COLS - 1) * KEY_PIP_GAP;

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
 * is left over.
 *
 * **These are measured, not guessed.** The first set was guessed, summed to
 * 634 against the 617 usable at 640x400, and so ran the squeeze branch below
 * at the game's own default preset — every panel 2.7% under its minimum, with
 * the doc comment here asserting the opposite. The numbers now come from
 * `measureText` against the real fonts: 9px labels are 22px for `AMMO` and
 * 33px for the widest, `STABIL`; the face glyph is 39px. The KEYS minimum is
 * the one that was *not* measured — it is derived from the pips now, above.
 *
 * `hudLayout.test.ts` pins the sum against 640 directly, because a comment
 * claiming they fit is exactly what was wrong before.
 */
export const PANEL_SPECS: readonly { key: HudPanelKey; min: number; weight: number }[] = [
  { key: "ammo", min: 100, weight: 1.0 },
  // "STABIL" is 33px and "100%" 53px, so 112 is still generous — it is sized
  // for the bar strip beneath them, not the text, and the face needed the 8px
  // more than the strip did.
  { key: "stabil", min: 112, weight: 1.2 },
  { key: "tools", min: TOOLS_MIN, weight: 0.8 },
  // The glyph is 44px wide and has no label row to clear, so it needs the
  // sprite plus a hair of bezel and nothing else.
  { key: "face", min: 48, weight: 0.3 },
  { key: "swap", min: 60, weight: 0.8 },
  // Derived, not guessed: the 2x2 grid is 28px and "KEYS" is 22px, so the
  // grid governs. The guessed 56 that stood here was never checked against
  // the one-row strip it was meant to hold, which is how the fourth pip
  // escaped the panel at 640.
  { key: "keys", min: KEYS_MIN, weight: 0.8 },
  { key: "score", min: 76, weight: 0.9 },
  // A row is the 22px `BULL` plus a 20px three-digit count, with a gap.
  { key: "table", min: 64, weight: 0.9 },
];

/** Panel labels. Named so a rename moves one string — the settled shorthands
 * (see `doc/dev/game-design.md`): our words, DOOM's layout. `STAB` was
 * rejected for health because it reads as a melee verb in a shooter. */
/** Each panel's minimum, keyed — so a test can assert the layout actually
 * grants it rather than trusting the comment above, which was wrong. */
export const PANEL_MIN_WIDTHS: Readonly<Record<HudPanelKey, number>> = Object.freeze(
  Object.fromEntries(PANEL_SPECS.map((p) => [p.key, p.min])),
) as Readonly<Record<HudPanelKey, number>>;

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
  const contentW = Math.min(canvasW - HUD_BAR_MARGIN * 2, HUD_MAX_CONTENT_W);
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
  // Widths come from *rounded cumulative edges*, not from rounding each width
  // on its own. Rounding independently lets eight half-pixels accumulate, and
  // the total then overshoots the usable width by up to four pixels — which is
  // how the bar came to exceed HUD_MAX_CONTENT_W by 2px at 2560. Deriving each
  // width as the gap between two rounded edges makes the widths absorb the
  // rounding instead, so the sum is exact by construction at every width.
  let x = startX;
  let ideal = 0;
  PANEL_SPECS.forEach((spec, i) => {
    const edge = Math.round(ideal);
    ideal += spec.min * squeeze + (surplus * spec.weight) / totalWeight;
    const w = Math.max(1, Math.round(ideal) - edge);
    panels[spec.key] = { x, y: bar.y, w, h: HUD_HEIGHT };
    x += w;
    if (i < dividerCount) {
      dividers.push(x);
      x += 1;
    }
  });
  return { bar, panels, dividers };
}
