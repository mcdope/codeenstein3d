// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { HUD_HEIGHT, layoutHud } from "./hudLayout";
import { HURT_FACE_FRAMES, allFaceKeys, damageBucket, faceGlyph, faceKeyFor, type FaceInputs } from "./hudFace";

function inputs(over: Partial<FaceInputs> = {}): FaceInputs {
  return { health: 100, maxHealth: 100, hurtFrames: 0, hurtDir: 0, godMode: false, status: "alive", ...over };
}

describe("faceKeyFor", () => {
  it("walks down the health tiers", () => {
    const tiers = [100, 79, 59, 39, 19].map((health) => faceKeyFor(inputs({ health })));
    // Five distinct bands, healthiest first — a face that never changes is a
    // face nobody reads.
    expect(new Set(tiers).size).toBe(5);
    expect(tiers[0]).toBe("idle4");
    expect(tiers[4]).toBe("idle0");
  });

  it("puts dead above god above hurt", () => {
    // A dead player who was cheating is still dead, and a hurt face on a
    // corpse reads as a bug.
    expect(faceKeyFor(inputs({ status: "dead", godMode: true, hurtFrames: 30 }))).toBe("dead");
    expect(faceKeyFor(inputs({ godMode: true, hurtFrames: 30 }))).toBe("god");
    expect(faceKeyFor(inputs({ hurtFrames: 30, hurtDir: -1 }))).toBe("hurt4_-1");
  });

  it("ignores the direction once the hurt timer has run out", () => {
    // hurtDir is deliberately left stale rather than cleared — it is only read
    // behind hurtFrames > 0, so clearing it would be a write with no
    // observable difference. This is what makes that safe.
    expect(faceKeyFor(inputs({ hurtFrames: 0, hurtDir: 1 }))).toBe("idle4");
  });

  it("survives a zero maxHealth without producing a NaN key", () => {
    expect(faceKeyFor(inputs({ health: 0, maxHealth: 0 }))).toBe("idle0");
  });

  it("only ever names a key the sprite set actually has", () => {
    const known = new Set(allFaceKeys());
    for (const health of [100, 80, 60, 40, 20, 1, 0]) {
      for (const hurtFrames of [0, HURT_FACE_FRAMES]) {
        for (const hurtDir of [-1, 0, 1] as const) {
          expect(known).toContain(faceKeyFor(inputs({ health, hurtFrames, hurtDir })));
        }
      }
    }
  });
});

describe("the face's box", () => {
  it("fits inside the bar with clearance from the accent, top and bottom", () => {
    // It shipped once hung from the top, two pixels under the accent, so the
    // hair line collided with it and a band of empty bezel sat underneath.
    // Centred now — and pinned, because "looks fine" is not a regression test.
    const g = faceGlyph("idle4");
    const ACCENT = 2;
    const margin = (HUD_HEIGHT - g.height) / 2;
    expect(g.height).toBeLessThan(HUD_HEIGHT);
    expect(margin).toBeGreaterThan(ACCENT + 6);
  });

  it("is taller than it is wide, like a head", () => {
    const g = faceGlyph("idle4");
    expect(g.height).toBeGreaterThan(g.width);
  });

  it("fits the narrowest face panel the layout can hand it", () => {
    const panel = layoutHud(640, 400).panels.face;
    expect(faceGlyph("idle4").width).toBeLessThanOrEqual(panel.w);
  });
});

describe("the face matrices", () => {
  it("are well-formed for every key the selector can emit", () => {
    // This replaces three unreachable runtime guards that the coverage gate
    // (rightly) flagged as dead branches: an out-of-range eye column, a bleed
    // spot landing on transparency, and an unknown palette character. All
    // three were impossible given the matrices — so the honest place to defend
    // the assumption is here, once, rather than in a branch on every frame.
    const seen: Record<string, number> = {};
    for (const key of allFaceKeys()) {
      const g = faceGlyph(key);
      const cells: string[] = [];
      // Replay the glyph against a recorder to read back what it paints.
      g.draw(
        {
          set fillStyle(v: string) {
            cells.push(v);
          },
          fillRect: () => {},
        } as unknown as CanvasRenderingContext2D,
        0,
        0,
      );
      expect(cells.length, `${key} paints nothing`).toBeGreaterThan(0);
      for (const c of cells) {
        expect(c, `${key} used a colour outside the palette`).toMatch(/^#[0-9a-f]{6}$/i);
        seen[c] = (seen[c] ?? 0) + 1;
      }
    }
    // A hurt face must actually show blood, or the tiers are indistinguishable.
    expect(Object.keys(seen)).toContain("#c03028");
  });
});

describe("damageBucket", () => {
  // Player at the origin facing +x. Right-vector is (-dirY, dirX) = (0, 1),
  // i.e. +y is the player's right — the same convention dodgeStrafeKey uses.
  const at = (ax: number, ay: number) => damageBucket(0, 0, 1, 0, ax, ay);

  it("reads an attacker to the right as right, and to the left as left", () => {
    // Both signs pinned, not one: the compass shipped with this axis inverted
    // once, and a face that looks the wrong way is worse than one that does
    // not move.
    expect(at(0, 5)).toBe(1);
    expect(at(0, -5)).toBe(-1);
  });

  it("reads dead ahead and directly behind as front", () => {
    // There is no "behind you" face, and inventing one would claim information
    // a portrait cannot carry.
    expect(at(5, 0)).toBe(0);
    expect(at(-5, 0)).toBe(0);
  });

  it("splits at the 45-degree diagonals", () => {
    expect(at(5, 4.9)).toBe(0); // just inside the front wedge
    expect(at(5, 5.1)).toBe(1); // just past it
  });

  it("is unaffected by distance, only by bearing", () => {
    expect(at(0, 1)).toBe(at(0, 1000));
  });

  it("follows the player's own facing rather than world axes", () => {
    // Same attacker, player turned 90 degrees: what was ahead is now to one
    // side. This is why the bucket is resolved at capture time.
    expect(damageBucket(0, 0, 1, 0, 5, 0)).toBe(0);
    expect(damageBucket(0, 0, 0, 1, 5, 0)).toBe(-1);
  });

  it("returns front for a blast centred exactly on the player", () => {
    // A point-blank rocket: atan2(0,0) is degenerate, and the dot-product form
    // lands on front rather than producing NaN.
    expect(at(0, 0)).toBe(0);
  });
});
