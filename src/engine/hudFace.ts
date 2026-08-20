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
 * Warmer and higher-contrast than a flat two-tone, because the face is drawn
 * at 3px per cell inside a 48px panel — at that size a subtle shade reads as
 * mud. Hair and the jaw shadow are what give it a silhouette at a glance.
 */
const COLORS: Record<string, string> = {
  s: "#e0a878", // skin
  d: "#8a5636", // shadow / jaw
  h: "#4a2f1c", // hair
  e: "#1a1a1a", // eye, mouth, nostril
  w: "#f2f2f2", // eye white
  r: "#c03028", // blood
  g: "#8effa0", // god-mode glow
};

const SCALE = 3;
const GRID_W = 13;
const GRID_H = 15;

/**
 * The head, before eyes and mouth are stamped on.
 *
 * Taller than wide, like DOOM's own 24x29 `STFACE` — a square head reads as a
 * ball. The hair block is doing most of the work: it is what makes the shape
 * legible as a face at 39x45 rather than as a beige rectangle.
 */
const BASE: readonly string[] = [
  "....hhhhh....",
  "..hhhhhhhhh..",
  ".hhhhhhhhhhh.",
  ".hhhhhhhhhhh.",
  ".dsssssssssd.",
  ".dsssssssssd.",
  ".dsssssssssd.",
  ".dsssssssssd.",
  ".dssssesssdd.",
  ".dsssssssssd.",
  ".dsssssssssd.",
  ".dsssssssssd.",
  "..dsssssssd..",
  "...ddddddd...",
  ".............",
];

/** Row the eyes sit on, and the row the mouth sits on. */
const EYE_ROW = 6;
const MOUTH_ROW = 10;

/**
 * Stamp eyes and a mouth onto the head.
 *
 * `eyeShift` moves both eyes together, which is the whole directional tell —
 * DOOM does the same, and it reads far better than rotating or mirroring the
 * head. Shifts of -1..1 keep both 2-wide eyes inside columns 2-10, every one
 * of which is skin, so no bounds check is needed (see the well-formedness
 * test, which is what actually defends that).
 */
function face(eyeShift: -1 | 0 | 1, mouth: string, extra?: (rows: string[][]) => void): string[] {
  const rows = BASE.map((r) => r.split(""));
  for (const start of [3 + eyeShift, 8 + eyeShift]) {
    rows[EYE_ROW][start] = "w";
    rows[EYE_ROW][start + 1] = "e";
  }
  const mStart = Math.floor((GRID_W - mouth.length) / 2);
  for (let i = 0; i < mouth.length; i++) rows[MOUTH_ROW][mStart + i] = mouth[i];
  extra?.(rows);
  return rows.map((r) => r.join(""));
}

/** Blood, growing with the tier so a hurt face reads without a health bar. */
function bleed(amount: number): (rows: string[][]) => void {
  return (rows) => {
    const spots: [number, number][] = [
      [4, 3],
      [5, 9],
      [7, 2],
      [9, 10],
      [4, 8],
      [11, 4],
    ];
    for (let i = 0; i < Math.min(amount, spots.length); i++) {
      const [y, x] = spots[i];
      rows[y][x] = "r";
    }
  };
}

/** Mouths, worst health first: a grimace opens as things get bad. */
const MOUTHS = ["eee", "eeee", "eeeee", "eeeee", "eeeee"];

function matrixFor(key: string): string[] {
  if (key === "dead") {
    // Eyes crossed out and the jaw slack — unmistakable at a glance, which is
    // the one thing this expression has to be.
    const rows = face(0, "eeeeee", bleed(6)).map((r) => r.split(""));
    rows[EYE_ROW][3] = "e";
    rows[EYE_ROW][4] = "e";
    rows[EYE_ROW][8] = "e";
    rows[EYE_ROW][9] = "e";
    rows[MOUTH_ROW + 1][6] = "e";
    return rows.map((r) => r.join(""));
  }
  if (key === "god") return face(0, "eee").map((r) => r.replace(/[sdh]/g, "g"));
  const hurt = key.startsWith("hurt");
  const tier = Number(key.replace(/^(idle|hurt)/, "").split("_")[0]);
  const dir = hurt ? (Number(key.split("_")[1]) as HurtDir) : 0;
  // A hurt face looks *toward* whatever hit it.
  return face(dir, MOUTHS[Math.max(0, Math.min(MOUTHS.length - 1, tier))], hurt ? bleed(5 - tier) : undefined);
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
          g.fillStyle = COLORS[ch];
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
