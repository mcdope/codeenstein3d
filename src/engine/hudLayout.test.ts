// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The test the old HUD could not have: layout is a pure function of canvas
 * size, so every preset is checkable without the canvas mock.
 *
 * The defect this pins is real and shipped: panel x positions used to be
 * literals (12 / 205 / 275 / 375, score at `w - 12`), which left ~800 blank
 * pixels between the keys and the score at the 1280x800 "Sharp" preset. A
 * literal-substituting rewrite would have re-created it one preset later.
 */
import { describe, expect, it } from "vitest";
import { HUD_HEIGHT, HUD_MAX_CONTENT_W, HUD_PAD, layoutHud } from "./hudLayout";

const KEYS = ["ammo", "stabil", "tools", "face", "swap", "keys", "score", "table"] as const;
/** Every shipped preset, plus the `?renderRes` extremes it clamps to. */
const WIDTHS = [160, 320, 640, 800, 1280, 2560];

describe("layoutHud", () => {
  it.each(WIDTHS)("at %ipx: panels are ordered, non-overlapping and positive", (w) => {
    const { panels } = layoutHud(w, 400);
    let prevRight = -Infinity;
    for (const key of KEYS) {
      const r = panels[key];
      expect(r.w, `${key} width at ${w}`).toBeGreaterThan(0);
      expect(r.x, `${key} starts after the previous panel at ${w}`).toBeGreaterThanOrEqual(prevRight);
      prevRight = r.x + r.w;
    }
  });

  it.each(WIDTHS)("at %ipx: the bar spans the full canvas even when content is capped", (w) => {
    const { bar } = layoutHud(w, 400);
    expect(bar.x).toBe(0);
    expect(bar.w).toBe(w);
    expect(bar.h).toBe(HUD_HEIGHT);
    expect(bar.y).toBe(400 - HUD_HEIGHT);
  });

  it("fills the width at both shipped presets — the 800px-gap regression", () => {
    // The whole point. At 640 and at 1280 the panels must reach the far edge
    // (within the padding), not cluster left with dead space after them.
    for (const w of [640, 1280]) {
      const { panels } = layoutHud(w, 400);
      const right = panels.table.x + panels.table.w;
      const slack = w - HUD_PAD - right;
      expect(slack, `dead space at the right edge at ${w}px`).toBeLessThanOrEqual(2);
    }
  });

  it("centres the content once past the cap instead of stretching panels absurdly", () => {
    const { panels } = layoutHud(2560, 1600);
    const left = panels.ammo.x;
    const right = panels.table.x + panels.table.w;
    expect(right - left).toBeLessThanOrEqual(HUD_MAX_CONTENT_W);
    // Symmetric margins — the bar reads as centred, not left-anchored.
    expect(Math.abs(left - (2560 - right))).toBeLessThanOrEqual(2);
  });

  it("degrades rather than going negative below any real preset", () => {
    // Only reachable via `?renderRes=160x100`. Nothing is legible; nothing is
    // broken either, which is the whole contract.
    const { panels } = layoutHud(160, 100);
    for (const key of KEYS) expect(panels[key].w).toBeGreaterThan(0);
  });

  it("keeps every panel at its minimum at 640, so the squeeze branch is unreachable in practice", () => {
    const { panels } = layoutHud(640, 400);
    // 640 is the Classic preset and the narrowest thing that ships.
    for (const key of KEYS) expect(panels[key].w).toBeGreaterThanOrEqual(40);
  });

  it("puts a divider between each adjacent pair and nowhere else", () => {
    const { panels, dividers } = layoutHud(640, 400);
    expect(dividers).toHaveLength(KEYS.length - 1);
    dividers.forEach((x, i) => {
      expect(x).toBe(panels[KEYS[i]].x + panels[KEYS[i]].w);
    });
  });
});

describe("HUD_HEIGHT", () => {
  it("is 72", () => {
    expect(HUD_HEIGHT).toBe(72);
  });

  it("is tall enough for the five ammo rows it was derived from", () => {
    // The pinned literal above catches a careless edit; this catches the one
    // that matters — a height that silently stops fitting the table. Five rows
    // at a 12px pitch with the last baseline at +64, plus the 2px accent.
    const ROWS = 5;
    const PITCH = 12;
    const FIRST_BASELINE = 16;
    const BOTTOM_MARGIN = 8;
    expect(HUD_HEIGHT).toBeGreaterThanOrEqual(FIRST_BASELINE + (ROWS - 1) * PITCH + BOTTOM_MARGIN);
  });
});
