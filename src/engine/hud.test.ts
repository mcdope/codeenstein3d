// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { EngineStats } from "./engine";
import { emptyPlayerFacingStats } from "./playerStats";
import { zeroScoreBreakdown } from "./scoring";
import {
  drawCheatToast,
  drawCompass,
  drawCrosshair,
  drawFpsOverlay,
  drawHud,
  drawKillStreakToast,
  drawLoreOverlay,
  drawPauseOverlay,
  HUD_HEIGHT,
} from "./hud";

function ctx(width = 800, height = 600): MockCanvasContext {
  return createMockCanvasContext({ width, height } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

function fakeStats(overrides: Partial<EngineStats> = {}): EngineStats {
  return {
    health: 80,
    maxHealth: 100,
    swap: 0,
    bullets: 10,
    rockets: 2,
    smg: 20,
    gas: 30,
    keysHeld: 1,
    keysTotal: 3,
    score: 500,
    kills: 4,
    weaponIndex: 0, // pistol -> bullets
    ownedWeapons: [0, 1, 2],
    godMode: false,
    noClip: false,
    levelScoreBreakdown: zeroScoreBreakdown(),
    runScoreBreakdown: zeroScoreBreakdown(),
    levelPlayerStats: emptyPlayerFacingStats(),
    runPlayerStats: emptyPlayerFacingStats(),
    ...overrides,
  };
}

describe("drawCrosshair", () => {
  it("draws white when nothing is targeted, with no spread ticks by default", () => {
    const c = ctx();
    drawCrosshair(asCtx(c), false);
    expect(c.fillStyle).toBe("rgba(255,255,255,0.6)");
    expect(c.fillRect).toHaveBeenCalledTimes(2); // horizontal + vertical bar only
  });

  it("draws red when a target is acquired", () => {
    const c = ctx();
    drawCrosshair(asCtx(c), true);
    expect(c.fillStyle).toBe("rgba(255,60,60,0.95)");
  });

  it("adds spread ticks when spreadPx > 0", () => {
    const c = ctx();
    drawCrosshair(asCtx(c), false, 8);
    expect(c.fillRect).toHaveBeenCalledTimes(4);
  });
});

describe("drawFpsOverlay", () => {
  it("colors a low FPS reading red", () => {
    const c = ctx();
    drawFpsOverlay(asCtx(c), 15, 66.7);
    expect(c.fillText).toHaveBeenCalledWith("15", 800 - 8, 30);
    expect(c.fillText).toHaveBeenCalledWith("66.7ms", 800 - 8, 44);
  });

  it("colors a healthy FPS reading green, and resets textAlign afterward", () => {
    const c = ctx();
    drawFpsOverlay(asCtx(c), 60, 16.7);
    expect(c.textAlign).toBe("start");
  });
});

describe("drawCheatToast", () => {
  it("sizes the toast box from the measured text width", () => {
    const c = ctx();
    drawCheatToast(asCtx(c), "IDDQD", 1);
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);
    expect(c.globalAlpha).toBe(1);
    expect(c.textAlign).toBe("start"); // reset before restore()
  });

  it("clamps alpha above 1 down to 1", () => {
    const c = ctx();
    drawCheatToast(asCtx(c), "IDKFA", 5);
    expect(c.globalAlpha).toBe(1);
  });

  it("clamps negative alpha up to 0", () => {
    const c = ctx();
    drawCheatToast(asCtx(c), "IDCLIP", -1);
    expect(c.globalAlpha).toBe(0);
  });
});

describe("drawKillStreakToast", () => {
  it("sizes and colors a Multi Kill (big=false) smaller/duller than an Ultra Kill", () => {
    const c = ctx();
    drawKillStreakToast(asCtx(c), "MULTI KILL!", 1, false);
    expect(c.font).toBe("bold 36px ui-monospace, monospace");
    expect(c.fillStyle).toBe("#ffcf4d");
    expect(c.strokeStyle).toBe("#5a3d0d");
    expect(c.lineWidth).toBe(4);
    expect(c.textAlign).toBe("start"); // reset before restore()
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);
  });

  it("sizes and colors an Ultra Kill (big=true) bigger/more intense than a Multi Kill", () => {
    const c = ctx();
    drawKillStreakToast(asCtx(c), "ULTRA KILL!", 1, true);
    expect(c.font).toBe("bold 48px ui-monospace, monospace");
    expect(c.fillStyle).toBe("#ff4d4d");
    expect(c.strokeStyle).toBe("#7a0d0d");
    expect(c.lineWidth).toBe(6);
  });

  it("clamps alpha above 1 down to 1, and negative alpha up to 0", () => {
    const c = ctx();
    drawKillStreakToast(asCtx(c), "MULTI KILL!", 5, false);
    expect(c.globalAlpha).toBe(1);
    drawKillStreakToast(asCtx(c), "MULTI KILL!", -1, false);
    expect(c.globalAlpha).toBe(0);
  });
});

describe("drawPauseOverlay", () => {
  it("draws the scrim and both lines of text, resetting textAlign", () => {
    const c = ctx();
    drawPauseOverlay(asCtx(c));
    expect(c.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(c.fillText).toHaveBeenCalledWith("PAUSED", 400, 300 - 6);
    expect(c.textAlign).toBe("start");
  });
});

describe("drawCompass", () => {
  it("points straight up (bearing 0) when the exit is dead ahead of the player's facing", () => {
    const c = ctx();
    // Player facing +X (angle 0), exit due east -> angle-to-exit is also 0.
    drawCompass(asCtx(c), { cx: 50, cy: 50, r: 10 }, 5, 5, 0, 10, 5);
    expect(c.rotate).toHaveBeenCalledWith(0);
    expect(c.translate).toHaveBeenCalledWith(50, 50);
    expect(c.fill).toHaveBeenCalledTimes(1);
  });

  it("rotates by the bearing when the exit isn't dead ahead", () => {
    const c = ctx();
    drawCompass(asCtx(c), { cx: 50, cy: 50, r: 10 }, 5, 5, 0, 5, 10); // exit due south, player facing east
    expect(c.rotate).toHaveBeenCalledWith(Math.PI / 2);
  });
});

describe("drawLoreOverlay", () => {
  function bodyLines(c: MockCanvasContext): string[] {
    // fillText call order is fixed: header, then each visible body line
    // top-to-bottom, then the footer — slice off the two fixed ends.
    return c.fillText.mock.calls.slice(1, -1).map(([text]) => text as string);
  }

  it("fits short text on one line with no scrollbar and the non-scrolling footer", () => {
    const c = ctx(800, 600);
    const result = drawLoreOverlay(asCtx(c), "Hello world", 0);
    expect(result.maxScrollLines).toBe(0);
    expect(bodyLines(c)).toEqual(["Hello world"]);
    expect(c.fillText).toHaveBeenLastCalledWith("Press R (or click) to close", 400, expect.any(Number));
  });

  it("keeps a single overlong word (no spaces) intact rather than force-splitting it", () => {
    const c = ctx(800, 600);
    const longWord = "x".repeat(200);
    const result = drawLoreOverlay(asCtx(c), longWord, 0);
    expect(result.maxScrollLines).toBe(0);
    expect(bodyLines(c)).toEqual([longWord]);
  });

  it("word-wraps a long paragraph across multiple lines", () => {
    const c = ctx(800, 600);
    const words = Array.from({ length: 5 }, () => "a".repeat(20));
    const result = drawLoreOverlay(asCtx(c), words.join(" "), 0);
    expect(result.maxScrollLines).toBe(0);
    expect(bodyLines(c)).toHaveLength(2);
  });

  it("treats explicit newlines as hard paragraph breaks", () => {
    const c = ctx(800, 600);
    const result = drawLoreOverlay(asCtx(c), "line one\nline two\nline three", 0);
    expect(result.maxScrollLines).toBe(0);
    expect(bodyLines(c)).toEqual(["line one", "line two", "line three"]);
  });

  it("caps the box height and enables scrolling once text overflows the available space", () => {
    const c = ctx(800, 200); // short canvas -> boxH is capped well below the full content height
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    const result = drawLoreOverlay(asCtx(c), text, 0);
    expect(result.maxScrollLines).toBeGreaterThan(0);
    expect(bodyLines(c)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
    expect(c.fillText).toHaveBeenLastCalledWith("W/S to scroll · R (or click) to close", 400, expect.any(Number));
  });

  it("clamps a negative scroll offset up to 0", () => {
    const c = ctx(800, 200);
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    drawLoreOverlay(asCtx(c), text, -5);
    expect(bodyLines(c)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("clamps an out-of-range scroll offset down to maxScrollLines", () => {
    const c = ctx(800, 200);
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    const result = drawLoreOverlay(asCtx(c), text, 999);
    expect(bodyLines(c)).toEqual(["L15", "L16", "L17", "L18", "L19"]);
    expect(result.maxScrollLines).toBe(15);
  });

  it("draws a scrollbar track and thumb only when scrolling is actually possible", () => {
    const cNoScroll = ctx(800, 600);
    drawLoreOverlay(asCtx(cNoScroll), "short", 0);
    const noScrollFillRectCount = cNoScroll.fillRect.mock.calls.length;

    const cScroll = ctx(800, 200);
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    drawLoreOverlay(asCtx(cScroll), text, 0);
    // +2 extra fillRect calls for the scrollbar track + thumb.
    expect(cScroll.fillRect.mock.calls.length).toBe(noScrollFillRectCount + 2);
  });
});

describe("drawHud", () => {
  /** fillStyle is a plain mutable field on the mock, not tracked per-call —
   * wrap fillRect to snapshot which style was active at each call, so a
   * specific fillRect (the stability bar's fill) can be checked honestly. */
  function fillRectStylesLog(c: MockCanvasContext): string[] {
    const log: string[] = [];
    c.fillRect.mockImplementation(() => {
      log.push(c.fillStyle as string);
    });
    return log;
  }

  it("fills the stability bar red at/below 30%", () => {
    const c = ctx();
    const log = fillRectStylesLog(c);
    drawHud(asCtx(c), fakeStats({ health: 30, maxHealth: 100 }));
    expect(log).toContain("#ff5a4a");
    expect(log).not.toContain("#4cff6a");
  });

  it("fills the stability bar green above 30%", () => {
    const c = ctx();
    const log = fillRectStylesLog(c);
    drawHud(asCtx(c), fakeStats({ health: 100, maxHealth: 100 }));
    expect(log).toContain("#4cff6a");
    expect(log).not.toContain("#ff5a4a");
  });

  it("clamps stability percentage into [0,100] even for out-of-range health", () => {
    const c = ctx();
    expect(() => drawHud(asCtx(c), fakeStats({ health: 150, maxHealth: 100 }))).not.toThrow();
    expect(() => drawHud(asCtx(c), fakeStats({ health: -20, maxHealth: 100 }))).not.toThrow();
  });

  it("colors swap blue when positive, grey when zero", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ swap: 5 }));
    expect(c.fillText).toHaveBeenCalledWith("5", 205, expect.any(Number));
  });

  it("shows BULLETS for a bullets-type weapon, red when empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, bullets: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("BULLETS", 275, expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("0", 275, expect.any(Number));
  });

  it("shows ROCKETS for a rockets-type weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 4, rockets: 3 }));
    expect(c.fillText).toHaveBeenCalledWith("ROCKETS", 275, expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("3", 275, expect.any(Number));
  });

  it("colors rockets red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 4, rockets: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("0", 275, expect.any(Number));
  });

  it("shows SMG AMMO for an smg-type weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 3, smg: 12 }));
    expect(c.fillText).toHaveBeenCalledWith("SMG AMMO", 275, expect.any(Number));
  });

  it("colors smg ammo red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 3, smg: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("0", 275, expect.any(Number));
  });

  it("shows GAS for a gas-type weapon, floored for a fractional value", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 5, gas: 37.5 }));
    expect(c.fillText).toHaveBeenCalledWith("GAS", 275, expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("37", 275, expect.any(Number));
  });

  it("colors gas red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 5, gas: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("0", 275, expect.any(Number));
  });

  it("shows MELEE with an infinity mark for an ammo-less weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 2 }));
    expect(c.fillText).toHaveBeenCalledWith("MELEE", 275, expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("∞", 275, expect.any(Number));
  });

  it("shows keys held/total and the right-aligned score", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ keysHeld: 2, keysTotal: 5, score: 1234 }));
    expect(c.fillText).toHaveBeenCalledWith("2/5", 375, expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("1234", 800 - 12, expect.any(Number));
    expect(c.textAlign).toBe("left"); // reset after the right-aligned score
  });
});

describe("HUD_HEIGHT", () => {
  it("is a fixed 58px", () => {
    expect(HUD_HEIGHT).toBe(58);
  });
});
