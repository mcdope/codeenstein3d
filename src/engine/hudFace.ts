// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The status bar's face: DOOM's `STFACE`, in this game's palette.
 *
 * Two things here are load-bearing and neither is the art.
 *
 * **The faces are pixel matrices, not paths.** `drawGlyph` pre-renders to an
 * offscreen surface when one exists — but when it does not, it falls back to
 * running the glyph's own `draw` *against the passed-in context*, which is the
 * scene canvas. A path-based face would therefore issue real `fill()` calls on
 * the scene canvas in that environment, and `fill()` is the expensive class
 * `perf-review-2026-08-02.md` identifies: geometry Skia cannot emit as
 * axis-aligned quads, costing a fixed ~11fps whether it happens once or sixty
 * times a frame. A matrix emits `fillRect` runs, which are identical on both
 * paths and measured free by the thousand. It is also authentically chunky.
 *
 * **Selection is a pure function.** `faceKeyFor` takes stats and returns a
 * string; everything stateful lives in the engine. That is what makes the
 * expression rules testable without a canvas, and it is why the hurt direction
 * is resolved to a bucket at *capture* time rather than re-derived here.
 */
import type { Glyph } from "./pathSprites";

/** Which way the face looks while hurt. Resolved when the damage lands, not
 * when it is drawn — a bearing recomputed at draw time would swing as the
 * player turned, which reads as the attacker moving. */
export type HurtDir = -1 | 0 | 1;

/** Frames the hurt expression holds. ~1s at 60fps, matching DOOM's
 * `ST_FACETIME` of 35 tics. Frame-counted rather than `dt`-scaled, like
 * `flashFrames` and every other presentation timer in the engine. */
export const HURT_FACE_FRAMES = 60;

/** How many health bands the idle face has. */
const TIERS = 5;

/** The subset of `EngineStats` the face reads — narrow on purpose, so the
 * selector cannot quietly grow a dependency on the rest of the frame. */
export interface FaceInputs {
  health: number;
  maxHealth: number;
  hurtFrames: number;
  hurtDir: HurtDir;
  godMode: boolean;
  status: string;
}

/**
 * Which face to draw. Pure, exported, and the highest-value unit test in this
 * module.
 *
 * Precedence is deliberate: dead beats god beats hurt beats idle. A dead
 * player who was cheating is still dead, and a hurt face on a corpse reads as
 * a bug.
 */
export function faceKeyFor(s: FaceInputs): string {
  if (s.status === "dead") return "dead";
  if (s.godMode) return "god";
  const frac = s.maxHealth > 0 ? s.health / s.maxHealth : 0;
  const tier = Math.max(0, Math.min(TIERS - 1, Math.floor(frac * TIERS)));
  if (s.hurtFrames > 0) return `hurt${tier}_${s.hurtDir}`;
  return `idle${tier}`;
}

/**
 * Which way an attacker at (`ax`, `ay`) lies relative to a player at
 * (`px`, `py`) facing (`dirX`, `dirY`).
 *
 * Front and rear both return 0: the face has no "behind you" expression, and
 * inventing one would claim information a portrait cannot convey. Left and
 * right are the 90-degree wedges either side.
 *
 * No trigonometry — a dot product against the facing separates front/back and
 * a dot against the right-vector separates left/right, so there is no angle to
 * wrap and no `atan2` on the damage path. The right-vector is `(-dirY, dirX)`,
 * the same convention `dodgeStrafeKey` uses in the bot; the compass shipped
 * with this sign inverted once, which is why both directions are pinned in the
 * tests rather than one.
 */
export function damageBucket(px: number, py: number, dirX: number, dirY: number, ax: number, ay: number): HurtDir {
  const tx = ax - px;
  const ty = ay - py;
  const forward = tx * dirX + ty * dirY;
  const right = tx * -dirY + ty * dirX;
  // Inside the +-45 degree front or rear wedge the sideways component never
  // exceeds the forward one, so this is the wedge test without an angle.
  if (Math.abs(right) <= Math.abs(forward)) return 0;
  return right > 0 ? 1 : -1;
}

/**
 * Palette. `.` is transparent.
 *
 * Five skin values rather than two. The first version had one skin tone, one
 * shadow, and a hair block, and the result read as a cartoon animal head: with
 * no brow, no cheekbone and no jaw shading, the only structure left was a
 * rounded outline around a flat beige field, and a rounded outline around a
 * flat field is a muzzle. Serious faces are built from the shadows, not the
 * outline — which is why `b` (brow) exists as its own value and is the darkest
 * thing on the face apart from the pupils.
 */
const COLORS: Record<string, string> = {
  k: "#1b1410", // outline
  h: "#3a2a1c", // hair
  b: "#33220f", // brow ridge — the darkest skin-adjacent value, deliberately
  d: "#96603c", // skin shadow: jaw, sockets, cheek hollow
  s: "#c98d5f", // skin mid
  S: "#e3ab7b", // skin highlight: forehead, nose bridge, cheekbone
  w: "#cdc2ae", // eye white — deliberately off-white; see note in BASE
  e: "#191310", // pupil, mouth line, nostril
  m: "#5a1c16", // open mouth
  t: "#e8dcc0", // teeth
  r: "#8c1a14", // blood
  R: "#c62828", // fresh blood
};

/** God mode keeps every value the face is built from and shifts the skin and
 * hair ramps to green, so the structure survives the recolour. */
const GOD_COLORS: Record<string, string> = {
  ...COLORS,
  k: "#123a1e",
  h: "#1f6b34",
  b: "#17532a",
  d: "#2f9448",
  s: "#63dd7e",
  S: "#a6f7b4",
};

/**
 * 22x27 cells at 2px, so 44x54 — DOOM's `STFACE` is 24x29, and this is the
 * nearest thing that still clears the bar's accent with a margin.
 *
 * The previous face was 13x15 at 3px. That is not enough resolution for a
 * brow ridge, and without a brow ridge a face cannot look serious: there is
 * nowhere to put the one shadow that does most of the work. Trading cell size
 * for cell count buys the structure at the same physical size.
 */
const SCALE = 2;
const GRID_W = 22;
const GRID_H = 27;

/**
 * The head, before eyes, mouth and wounds are stamped on.
 *
 * Read it as bands: hair (0-5), forehead (6-9), brow (10), sockets (11),
 * eyes (12-13), lower lids (14), cheeks and nose bridge (15-16), nose
 * (17-18), lips (19-21), chin (22), jaw (23-24), neck (25) and shoulders
 * (26). The jaw narrows over three rows and the shoulders are squared off,
 * which is what stops it reading as a head floating in the bezel.
 */
const BASE: readonly string[] = [
  "......hhhhhhhhhh......",
  "....hhhhhhhhhhhhhh....",
  "...hhhhhhhhhhhhhhhh...",
  "..hhhhhhhhhhhhhhhhhh..",
  "..hhhhhhhhhhhhhhhhhh..",
  "..hhhhhhhhhhhhhhhhhh..",
  "..hhSSSSSSSSSSSSSShh..",
  "..hdSSSSSSSSSSSSSSdh..",
  "..hdSSSSSSSSSSSSSSdh..",
  "..hdSSSSSSSSSSSSSSdh..",
  "..hdbbbbbbssbbbbbbdh..",
  "..hdddddbbssbbdddddh..",
  "..hddwwwwdssdwwwwddh..",
  "..hdddddddssdddddddh..",
  "..hddddddsssddddddhh..",
  "..hdssssssSSdsssssdh..",
  "..hdssssssSSdsssssdh..",
  "..hdsssssSSSSdssssdh..",
  "..hdssssseSSesssssdh..",
  "..hdssssddddddssssdh..",
  "..kdsssssssssssssskd..",
  "..kdsssssssssssssskd..",
  "..kddssssssssssssdkd..",
  "...kdssssssssssssdk...",
  "....kddssssssssddk....",
  "......kdssssssdk......",
  "..kkkkkkkkkkkkkkkkkk..",
];

/** Where the stampable features live. Eye whites are 4 cells wide with a
 * 2-cell pupil, so the pupil can move inside the eye rather than the eye
 * moving inside the face — DOOM does the former, and it is the difference
 * between a glance and a head-turn. */
const EYE_ROWS = [12, 13];
const EYE_LEFT_COL = 5;
const EYE_RIGHT_COL = 13;
const MOUTH_ROW = 19;
const MOUTH_COL = 6;

/**
 * Mouths, **indexed by tier, so index 0 is nearly dead** — the same direction
 * as `WOUNDS_BY_TIER`, and the reason both are spelled out here. Writing this
 * array healthiest-first while indexing it by tier put the widest agonised
 * grimace on the full-health face and a calm set jaw on the dying one, which
 * the contact sheet caught immediately and no unit test would have.
 *
 * ' ' leaves whatever the base row had. A shout at the bottom, closing to a
 * clenched grimace and then a set jaw — the mouth is the second-strongest
 * signal after the brow, and at this size far more legible than bending eyes.
 */
const MOUTHS: readonly string[][] = [
  ["eeeeeeeeee", "emmmmmmmme", "etttttttte", " eeeeeeee "],
  [" eeeeeeee ", " emmmmmme ", " etttttte ", "  eeeeee  "],
  [" eeeeeeee ", " etttttte ", " eeeeeeee ", "          "],
  ["          ", " eeeeeeee ", "  dddddd  ", "          "],
  ["          ", "  eeeeee  ", "   dddd   ", "          "],
];

/** The open-mouthed flinch, used for every hurt face regardless of tier — it
 * is a reaction, not a health reading, and the tier is already carried by the
 * wounds and the eyes. */
const MOUTH_OUCH: readonly string[] = ["  eeeeee  ", " emmmmmme ", " emmmmmme ", "  eeeeee  "];

/**
 * Wounds, applied cumulatively worst-last, as `[row, col, colour]`.
 *
 * **These are persistent, not a hit reaction.** The first version only bled
 * while `hurtFrames` was live, so a player on 8 health looked untouched a
 * second after the blow that nearly killed them — the exact moment the face is
 * supposed to be shouting at you. DOOM's face stays wrecked, because the face
 * *is* the health readout for anyone not looking at the number.
 *
 * They are placed, not scattered: a brow cut that trickles down the temple, a
 * cheek gash, blood at the mouth, then a swollen eye and a forehead smear.
 * Random dots read as dirt.
 */
type Wound = readonly [number, number, string];
const WOUND_GROUPS: readonly (readonly Wound[])[] = [
  [[8, 14, "r"], [8, 15, "r"], [9, 14, "R"]],
  [[10, 16, "r"], [11, 17, "r"], [12, 17, "r"], [13, 17, "r"]],
  [[16, 5, "r"], [16, 6, "r"], [17, 5, "R"], [15, 6, "r"]],
  [[20, 8, "r"], [21, 8, "r"], [22, 9, "r"], [21, 13, "r"]],
  [[12, 5, "r"], [12, 6, "r"], [13, 5, "r"], [14, 5, "R"], [14, 6, "r"]],
  [[7, 5, "r"], [7, 6, "r"], [7, 7, "r"], [8, 6, "R"], [6, 11, "r"], [9, 17, "r"]],
];

/** How many wound groups a health tier carries. Index 0 is nearly dead. */
const WOUNDS_BY_TIER = [6, 4, 2, 1, 0];

function stampPupils(rows: string[][], shift: -1 | 0 | 1): void {
  for (const row of EYE_ROWS) {
    for (const eye of [EYE_LEFT_COL, EYE_RIGHT_COL]) {
      // The white is 4 wide; a 2-wide pupil sits at offset 0, 1 or 2, so it
      // stays inside the white at every shift and needs no clamping.
      const p = eye + 1 + shift;
      rows[row][p] = "e";
      rows[row][p + 1] = "e";
    }
  }
}

function stampPatch(rows: string[][], patch: readonly string[], top: number, left: number): void {
  for (let y = 0; y < patch.length; y++) {
    for (let x = 0; x < patch[y].length; x++) {
      const ch = patch[y][x];
      if (ch !== " ") rows[top + y][left + x] = ch;
    }
  }
}

function stampWounds(rows: string[][], groups: number): void {
  for (let i = 0; i < Math.min(groups, WOUND_GROUPS.length); i++) {
    for (const [y, x, ch] of WOUND_GROUPS[i]) rows[y][x] = ch;
  }
}

function matrixFor(key: string): string[] {
  const rows = BASE.map((r) => r.split(""));

  if (key === "dead") {
    stampWounds(rows, WOUND_GROUPS.length);
    // Eyes crossed out and the jaw hanging open. Unmistakable at a glance is
    // the only requirement this expression has.
    for (const row of EYE_ROWS) {
      for (const eye of [EYE_LEFT_COL, EYE_RIGHT_COL]) {
        for (let i = 0; i < 4; i++) rows[row][eye + i] = "e";
      }
    }
    stampPatch(rows, ["  eeeeee  ", " emmmmmme ", " emmmmmme ", " emmmmmme "], MOUTH_ROW, MOUTH_COL);
    return rows.map((r) => r.join(""));
  }

  if (key === "god") {
    // Recoloured through GOD_COLORS rather than flattened to one green: the
    // first version replaced every skin, hair and outline cell with a single
    // value, which erased the brow, sockets and jaw in one go and left a green
    // blob with two eyes. Invulnerable should look lit from within, not melted.
    stampPupils(rows, 0);
    stampPatch(rows, MOUTHS[MOUTHS.length - 1], MOUTH_ROW, MOUTH_COL);
    return rows.map((r) => r.join(""));
  }

  const hurt = key.startsWith("hurt");
  const tier = Number(key.replace(/^(idle|hurt)/, "").split("_")[0]);
  const safeTier = Math.max(0, Math.min(WOUNDS_BY_TIER.length - 1, tier));
  const dir = hurt ? (Number(key.split("_")[1]) as HurtDir) : 0;

  // A hurt face looks *toward* whatever hit it, and takes one extra wound so
  // the blow reads even when it did not cross a tier boundary.
  stampWounds(rows, WOUNDS_BY_TIER[safeTier] + (hurt ? 1 : 0));
  stampPupils(rows, dir);
  stampPatch(rows, hurt ? MOUTH_OUCH : MOUTHS[safeTier], MOUTH_ROW, MOUTH_COL);
  return rows.map((r) => r.join(""));
}

const glyphCache = new Map<string, Glyph>();

/**
 * The `Glyph` for a face key, built once and memoised — the same pattern
 * `raycaster.ts`'s marker glyphs use. Every frame is then one `drawImage`, and
 * which direction the face looks costs nothing at all: it selects a different
 * pre-rendered sprite rather than doing extra work.
 */
export function faceGlyph(key: string): Glyph {
  const cached = glyphCache.get(key);
  if (cached) return cached;
  const rows = matrixFor(key);
  const glyph: Glyph = {
    width: GRID_W * SCALE,
    height: GRID_H * SCALE,
    anchorX: (GRID_W * SCALE) / 2,
    anchorY: (GRID_H * SCALE) / 2,
    draw: (g, ox, oy) => {
      const x0 = ox - (GRID_W * SCALE) / 2;
      const y0 = oy - (GRID_H * SCALE) / 2;
      const palette = key === "god" ? GOD_COLORS : COLORS;
      for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        let x = 0;
        while (x < row.length) {
          const ch = row[x];
          if (ch === ".") {
            x += 1;
            continue;
          }
          // Emit a run rather than a cell per pixel: same pixels, a fifth of
          // the calls, and every one of them an axis-aligned quad.
          let run = 1;
          while (x + run < row.length && row[x + run] === ch) run += 1;
          g.fillStyle = palette[ch];
          g.fillRect(x0 + x * SCALE, y0 + y * SCALE, run * SCALE, SCALE);
          x += run;
        }
      }
    },
  };
  glyphCache.set(key, glyph);
  return glyph;
}

/** Every key the selector can produce — for the perf guard, which has to cover
 * all of them rather than whichever one the default stats happen to pick. */
export function allFaceKeys(): string[] {
  const keys = ["dead", "god"];
  for (let t = 0; t < TIERS; t++) {
    keys.push(`idle${t}`);
    for (const d of [-1, 0, 1]) keys.push(`hurt${t}_${d}`);
  }
  return keys;
}
