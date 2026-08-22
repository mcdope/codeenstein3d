// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { EngineStats } from "./engine";
import { HUD_PAD, KEY_COLS, KEY_ROWS, layoutHud, TOOL_SLOTS } from "./hudLayout";
import { GATE_COLOR_COUNT } from "../map/types";
import { emptyPlayerFacingStats } from "./playerStats";
import { NUMBER_KEY_WEAPONS } from "./weapons";
import { zeroScoreBreakdown } from "./scoring";
import {
  drawAcidOverflowToast,
  drawLockedDoorToast,
  drawCheatToast,
  drawCompass,
  drawCrosshair,
  drawExitCountdownToast,
  drawFpsOverlay,
  drawHud,
  drawKillStreakToast,
  drawLoreOverlay,
  drawOutOfAmmoToast,
  drawPauseOverlay,
  HUD_HEIGHT,
} from "./hud";

function ctx(width = 800, height = 600): MockCanvasContext {
  return createMockCanvasContext({ width, height } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

/** The same trick for text: `[drawnString, fillStyleAtThatMoment]` per call.
 *
 * Needed because the bar now draws eight panels, so asserting the context's
 * *final* `fillStyle` says nothing about the panel under test — it reports
 * whatever the last panel happened to set. That is how the dry-ammo colour
 * assertion below became vacuous when the bar grew. */
function fillTextStylesLog(c: MockCanvasContext): [string, string][] {
  const log: [string, string][] = [];
  c.fillText.mockImplementation((text: unknown) => {
    log.push([String(text), c.fillStyle as string]);
  });
  return log;
}

function fakeStats(overrides: Partial<EngineStats> = {}): EngineStats {
  return {
    health: 80,
    maxHealth: 100,
    swap: 0,
    maxSwap: 100,
    hurtFrames: 0,
    hurtDir: 0,
    bullets: 10,
    shells: 4,
    magazine: 9,
    magazineSize: 9,
    reloading: false,
    rockets: 2,
    smg: 20,
    gas: 30,
    heldGates: [],
    gateColors: [],
    cheatsUsed: false,
    rollbacksRemaining: 0,
    score: 500,
    kills: 4,
    weaponIndex: 0, // pistol -> bullets
    ownedWeapons: [0, 1, 2],
    godMode: false,
    noClip: false,
    showFps: false,
    levelScoreBreakdown: zeroScoreBreakdown(),
    runScoreBreakdown: zeroScoreBreakdown(),
    levelPlayerStats: emptyPlayerFacingStats(),
    runPlayerStats: emptyPlayerFacingStats(),
    status: "alive",
    spectateTargetId: null,
    ...overrides,
  };
}

/** The four gate colours as `drawKeysPanel` writes them. Hardcoded rather
 * than imported because `HUD_GATE_COLORS` is module-private in `hud.ts` — and
 * a test that read the same table it is checking would pin nothing. */
const GATE_HEXES = ["#d63a30", "#3470d6", "#34b25c", "#a848d6"];

/** The presets the game ships. 160/320 are `?renderRes` extremes that fall
 * through `layoutHud`'s uniform squeeze on purpose, where nothing is legible
 * and nothing fits — the same restriction `hudLayout.test.ts` makes. */
const SHIPPED_WIDTHS = [640, 800, 1280, 2560];

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

describe("drawAcidOverflowToast", () => {
  it("clamps alpha into [0,1] and resets textAlign before restoring", () => {
    const c = ctx();
    drawAcidOverflowToast(asCtx(c), 5);
    expect(c.globalAlpha).toBe(1);
    expect(c.textAlign).toBe("start");
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);

    const c2 = ctx();
    drawAcidOverflowToast(asCtx(c2), -1);
    expect(c2.globalAlpha).toBe(0);
  });

  it("sits below the out-of-ammo toast without overlapping it", () => {
    // Both are triggered by things the player did (walking in, pulling an
    // empty trigger) and can genuinely land in the same second, so the two
    // rows have to stay clear of each other. Verified against real canvas
    // metrics in a browser too — the message is ~243px wide in a 640px
    // frame — but the row geometry is what's worth pinning here.
    const ammo = ctx();
    drawOutOfAmmoToast(asCtx(ammo), 1);
    const acid = ctx();
    drawAcidOverflowToast(asCtx(acid), 1);

    const boxOf = (c: ReturnType<typeof ctx>) => {
      const [, y, , h] = c.fillRect.mock.calls[0] as [number, number, number, number];
      return { top: y, bottom: y + h };
    };
    const ammoBox = boxOf(ammo);
    const acidBox = boxOf(acid);
    expect(acidBox.top).toBeGreaterThanOrEqual(ammoBox.bottom);
  });

  it("uses the hazard tiles' own orange, not the out-of-ammo red", () => {
    // The colour is the cue: it points at what changed underfoot.
    const c = ctx();
    let textColor = "";
    let borderColor = "";
    c.fillText.mockImplementation(() => {
      textColor = String(c.fillStyle);
    });
    // The border is four `outlineRect` edge fills rather than a `strokeRect`
    // (see `pathSprites.ts`), so the colour it actually paints with is the
    // fillStyle at those calls — `outlineRect` sources it from `strokeStyle`.
    c.fillRect.mockImplementation(() => {
      const style = String(c.fillStyle);
      if (style.includes("255,157,31")) borderColor = style;
    });
    drawAcidOverflowToast(asCtx(c), 1);
    expect(textColor.toLowerCase()).toBe("#ff9d1f");
    expect(borderColor).toContain("255,157,31");
    expect(c.strokeRect).not.toHaveBeenCalled();
  });
});

describe("drawLockedDoorToast", () => {
  it("names the gate's colour and clamps alpha into [0,1]", () => {
    const c = ctx();
    drawLockedDoorToast(asCtx(c), 5, 1);
    expect(c.fillText).toHaveBeenCalledWith("You need the blue key!", expect.any(Number), expect.any(Number));
    expect(c.globalAlpha).toBe(1);
    expect(c.textAlign).toBe("start");
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);

    const c2 = ctx();
    drawLockedDoorToast(asCtx(c2), -1, 1);
    expect(c2.globalAlpha).toBe(0);
  });

  it("adds a second line naming the blocking key, tinted as that gate", () => {
    // The lead the player follows when the key they asked for is itself locked
    // away. Tinted as the *blocker*, since that is the door colour they will be
    // matching against the world.
    const c = ctx();
    drawLockedDoorToast(asCtx(c), 1, 3, 2); // want violet, fetch green first
    expect(c.fillText).toHaveBeenCalledWith("You need the violet key!", expect.any(Number), expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("→ find the green key first", expect.any(Number), expect.any(Number));
    expect(c.fillStyle).toBe("#34b25c"); // green — last colour set is the lead's
  });

  it("stays one line, at its original height, when the asked-for key is reachable", () => {
    // -1 is the case this toast has always covered; the box must not grow for
    // it, or every ordinary locked door suddenly gets a taller banner.
    const one = ctx();
    drawLockedDoorToast(asCtx(one), 1, 1);
    const two = ctx();
    drawLockedDoorToast(asCtx(two), 1, 1, 0);
    const heightOf = (c: ReturnType<typeof ctx>) => (c.fillRect.mock.calls[0] as number[])[3];
    expect(heightOf(one)).toBe(24);
    expect(heightOf(two)).toBeGreaterThan(24);
    expect(one.fillText).toHaveBeenCalledTimes(1);
    expect(two.fillText).toHaveBeenCalledTimes(2);
  });

  it("sits below the acid warning, which already sits below the out-of-ammo one", () => {
    // Dry-firing while shoving a locked door is an ordinary thing to do, so
    // this and the out-of-ammo toast genuinely land in the same second — the
    // same collision the acid row was moved down to avoid. Three rows, no
    // overlap, in a fixed order.
    const boxOf = (draw: (c: CanvasRenderingContext2D) => void) => {
      const c = ctx();
      draw(asCtx(c));
      const [, y, , h] = c.fillRect.mock.calls[0] as [number, number, number, number];
      return { top: y, bottom: y + h };
    };
    const ammo = boxOf((c) => drawOutOfAmmoToast(c, 1));
    const acid = boxOf((c) => drawAcidOverflowToast(c, 1));
    const door = boxOf((c) => drawLockedDoorToast(c, 1, 1));

    expect(acid.top).toBeGreaterThanOrEqual(ammo.bottom);
    expect(door.top).toBeGreaterThanOrEqual(acid.bottom);
  });

  it("uses the pushed gate's own colour, not the acid orange or the ammo red", () => {
    // The colour is the cue: it matches the door the player just bounced off,
    // as it's painted on the minimap and automap.
    const c = ctx();
    let textColor = "";
    c.fillText.mockImplementation(() => {
      textColor = String(c.fillStyle);
    });
    drawLockedDoorToast(asCtx(c), 1, 1);
    expect(textColor.toLowerCase()).toBe("#3470d6"); // gate 1 = blue
    expect(String(c.strokeStyle).toLowerCase()).toBe("#3470d6"); // border matches
    expect(c.strokeRect).not.toHaveBeenCalled(); // outlineRect, per renderCost

    // A different gate gets a different colour — that is the entire cue.
    const red = ctx();
    red.fillText.mockImplementation(() => {
      textColor = String(red.fillStyle);
    });
    drawLockedDoorToast(asCtx(red), 1, 0);
    expect(textColor.toLowerCase()).toBe("#d63a30");
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

describe("drawExitCountdownToast", () => {
  it("rounds ticks up to the nearest whole second (COUNTDOWN_DISPLAY_HZ=30)", () => {
    const c = ctx();
    drawExitCountdownToast(asCtx(c), 150);
    expect(c.fillText).toHaveBeenCalledWith("Build finishing in 5s…", 400, 40);
    drawExitCountdownToast(asCtx(c), 121); // 4.03s -> rounds up to 5s, not down to 4s
    expect(c.fillText).toHaveBeenCalledWith("Build finishing in 5s…", 400, 40);
    expect(c.textAlign).toBe("start"); // reset before restore()
    expect(c.save).toHaveBeenCalledTimes(2);
    expect(c.restore).toHaveBeenCalledTimes(2);
  });

  it("floors a non-positive tick count at 0s rather than showing a negative number", () => {
    const c = ctx();
    drawExitCountdownToast(asCtx(c), 0);
    expect(c.fillText).toHaveBeenCalledWith("Build finishing in 0s…", 400, 40);
    drawExitCountdownToast(asCtx(c), -5);
    expect(c.fillText).toHaveBeenCalledWith("Build finishing in 0s…", 400, 40);
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
    // The line *count* is not the property — it moves with the body font and
    // used to be pinned at 2 only because the canvas mock reported a flat 6px
    // per character whatever font was set. What has to hold is that the
    // paragraph breaks at all and that no line it produces is wider than the
    // box, measured the same way `wrapText` measures it.
    const c = ctx(800, 600);
    const words = Array.from({ length: 5 }, () => "a".repeat(20));
    const result = drawLoreOverlay(asCtx(c), words.join(" "), 0);
    expect(result.maxScrollLines).toBe(0);
    const lines = bodyLines(c);
    expect(lines.length).toBeGreaterThan(1);
    c.font = "13px ui-monospace, monospace";
    const widest = Math.max(...lines.map((l) => asCtx(c).measureText(l).width));
    // `drawLoreOverlay`'s own inner width: a 520px box (capped by the canvas)
    // less 48px of padding.
    expect(widest).toBeLessThanOrEqual(Math.min(520, 800 - 48) - 48);
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


  it("draws the cheated-run badge only once a cheat has fired", () => {
    const clean = ctx();
    drawHud(asCtx(clean), fakeStats({ cheatsUsed: false }));
    expect(clean.fillText.mock.calls.map((call) => call[0]).join(" ")).not.toContain("NOT RECORDED");

    const cheated = ctx();
    drawHud(asCtx(cheated), fakeStats({ cheatsUsed: true }));
    const texts = cheated.fillText.mock.calls.map((call) => call[0] as string);
    expect(texts.some((t) => t.includes("CHEATS USED") && t.includes("RUN NOT RECORDED"))).toBe(true);
  });

  it("keeps the badge clear of the HUD panel and of the transient toasts' top-centre strip", () => {
    // The two places it must not be: among the HUD's own slots (their spacing
    // varies with canvas width) or where drawCheatToast/drawOutOfAmmoToast sit.
    const c = ctx(800, 600);
    drawHud(asCtx(c), fakeStats({ cheatsUsed: true }));
    const badge = c.fillText.mock.calls.find((call) => String(call[0]).includes("CHEATS USED"))!;
    const badgeY = badge[2] as number;
    const panelTop = 600 - HUD_HEIGHT;
    expect(badgeY).toBeLessThan(panelTop);
    expect(badgeY).toBeGreaterThan(50); // below the toast strip (y 26-50)
  });

  it("draws no rollback badge when none are left", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ rollbacksRemaining: 0 }));
    expect(c.fillText.mock.calls.map((call) => String(call[0])).join(" ")).not.toContain("ROLLBACK");
  });

  it("draws the rollback badge, pluralised, when the run is holding some", () => {
    const many = ctx();
    drawHud(asCtx(many), fakeStats({ rollbacksRemaining: 2 }));
    expect(many.fillText.mock.calls.map((call) => String(call[0]))).toContain("↩ 2 ROLLBACKS LEFT");

    const one = ctx();
    drawHud(asCtx(one), fakeStats({ rollbacksRemaining: 1 }));
    expect(one.fillText.mock.calls.map((call) => String(call[0]))).toContain("↩ 1 ROLLBACK LEFT");
  });

  it("stacks the rollback badge above the cheats badge instead of on top of it", () => {
    // A run can be both cheated and holding rollbacks. Both badges are drawn
    // from the bar's top edge, so without the stacking handoff they land at
    // the identical y and the second paints straight over the first.
    const c = ctx(800, 600);
    drawHud(asCtx(c), fakeStats({ cheatsUsed: true, rollbacksRemaining: 2 }));
    const at = (needle: string): number =>
      c.fillText.mock.calls.find((call) => String(call[0]).includes(needle))![2] as number;
    const cheatsY = at("CHEATS USED");
    const rollbackY = at("ROLLBACK");
    expect(rollbackY).toBeLessThan(cheatsY);
    expect(cheatsY - rollbackY).toBeGreaterThanOrEqual(13); // at least a full box apart, never overlapping
    expect(rollbackY).toBeGreaterThan(50); // still clear of the toast strip (y 26-50)
  });

  it("puts the cheats badge at the same y whether or not rollbacks are showing", () => {
    // The stacking must grow upward. If it grew downward instead, the cheat
    // badge would move into the HUD panel on any run that also had rollbacks.
    const alone = ctx(800, 600);
    drawHud(asCtx(alone), fakeStats({ cheatsUsed: true }));
    const both = ctx(800, 600);
    drawHud(asCtx(both), fakeStats({ cheatsUsed: true, rollbacksRemaining: 3 }));
    const yOf = (c: MockCanvasContext): number =>
      c.fillText.mock.calls.find((call) => String(call[0]).includes("CHEATS USED"))![2] as number;
    expect(yOf(both)).toBe(yOf(alone));
  });

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
    expect(c.fillText).toHaveBeenCalledWith("5", expect.any(Number), expect.any(Number));
  });

  it("shows BULLETS as loaded / in reserve for a bullets-type weapon", () => {
    const c = ctx();
    // `bullets` is everything owned; 9 of it is in the magazine, so the
    // reserve shown beside it is the remaining 31.
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, bullets: 40, magazine: 9, magazineSize: 9 }));
    expect(c.fillText).toHaveBeenCalledWith("AMMO", expect.any(Number), expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("9/31", expect.any(Number), expect.any(Number));
  });

  it("shows a part-spent magazine and an empty one without calling either dry", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, bullets: 40, magazine: 3, magazineSize: 9 }));
    expect(c.fillText).toHaveBeenCalledWith("3/37", expect.any(Number), expect.any(Number));

    const empty = ctx();
    drawHud(asCtx(empty), fakeStats({ weaponIndex: 0, bullets: 31, magazine: 0, magazineSize: 9 }));
    expect(empty.fillText).toHaveBeenCalledWith("0/31", expect.any(Number), expect.any(Number));
  });

  it("says RELOADING in place of the pool name while reloading", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, bullets: 40, magazine: 0, magazineSize: 9, reloading: true }));
    expect(c.fillText).toHaveBeenCalledWith("RELOADING", expect.any(Number), expect.any(Number));
    expect(c.fillText).not.toHaveBeenCalledWith("AMMO", expect.any(Number), expect.any(Number));
  });

  it("colors the readout red only when nothing is left to load either", () => {
    // An empty magazine with a reserve behind it is a one-second problem, not
    // a crisis — only a genuinely dry pool turns red.
    const notDry = ctx();
    const notDryLog = fillTextStylesLog(notDry);
    drawHud(asCtx(notDry), fakeStats({ weaponIndex: 0, bullets: 31, magazine: 0, magazineSize: 9 }));
    // The colour *of the ammo numeral itself*, not whatever style the last
    // panel left behind.
    expect(notDryLog).toContainEqual(["0/31", "#4cff6a"]);
    expect(notDryLog.find(([text]) => text === "0/31")?.[1]).not.toBe("#ff5a4a");

    const dry = ctx();
    const dryLog = fillTextStylesLog(dry);
    drawHud(asCtx(dry), fakeStats({ weaponIndex: 0, bullets: 0, magazine: 0, magazineSize: 9 }));
    expect(dryLog).toContainEqual(["0/0", "#ff5a4a"]);
  });

  it("shows ROCKETS for a rockets-type weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 4, rockets: 3, magazine: 1, magazineSize: 1 }));
    expect(c.fillText).toHaveBeenCalledWith("AMMO", expect.any(Number), expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("1/2", expect.any(Number), expect.any(Number));
  });

  it("colors rockets red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 4, rockets: 0, magazine: 0, magazineSize: 1 }));
    expect(c.fillText).toHaveBeenCalledWith("0/0", expect.any(Number), expect.any(Number));
  });

  it("shows SMG AMMO for an smg-type weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 3, smg: 12 }));
    expect(c.fillText).toHaveBeenCalledWith("AMMO", expect.any(Number), expect.any(Number));
  });

  it("colors smg ammo red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 3, smg: 0, magazine: 0, magazineSize: 45 }));
    expect(c.fillText).toHaveBeenCalledWith("0/0", expect.any(Number), expect.any(Number));
  });

  it("shows GAS for a gas-type weapon, floored for a fractional value", () => {
    const c = ctx();
    // Friday Hotfix has no magazine, so it keeps the single bare number.
    drawHud(asCtx(c), fakeStats({ weaponIndex: 5, gas: 37.5, magazine: 0, magazineSize: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("AMMO", expect.any(Number), expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("37", expect.any(Number), expect.any(Number));
  });

  it("colors gas red once empty", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 5, gas: 0, magazine: 0, magazineSize: 0 }));
    expect(c.fillText).toHaveBeenCalledWith("0", expect.any(Number), expect.any(Number));
  });

  it("shows MELEE with an infinity mark for an ammo-less weapon", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 2 }));
    expect(c.fillText).toHaveBeenCalledWith("MELEE", expect.any(Number), expect.any(Number));
    expect(c.fillText).toHaveBeenCalledWith("∞", expect.any(Number), expect.any(Number));
  });

  it("draws one key pip per gate, filled only for the ones held", () => {
    const c = ctx();
    const filled: string[] = [];
    c.fillRect.mockImplementation(() => filled.push(c.fillStyle as string));
    // Three gates, holding the first and third.
    drawHud(asCtx(c), fakeStats({ heldGates: [0, 2], gateColors: [0, 1, 2], score: 1234 }));
    // Filled pips use fillRect in the gate's colour; the unheld one is an
    // outline, so its colour reaches strokeStyle instead.
    expect(filled).toContain("#d63a30"); // gate 0, held
    expect(filled).toContain("#34b25c"); // gate 2, held
    expect(c.fillText).toHaveBeenCalledWith("1234", expect.any(Number), expect.any(Number));
    expect(c.textAlign).toBe("left"); // reset after the right-aligned score
  });

  /**
   * The bounding box of every pip `drawHud` drew, one entry per pip.
   *
   * Grouped by colour rather than counted as fills, because the two pip states
   * are different shapes: a held pip is one 12x12 `fillRect`, an unheld one is
   * the four thin quads `outlineRect` emits instead of stroking (see its doc in
   * `pathSprites.ts`). Colour is also the only reliable discriminator — the
   * chrome, the two bars and every TOOLS cell are `fillRect`s too — and gate
   * colours are distinct within a level, so one colour is one pip.
   */
  function pipBoxes(width: number, gateColors: number[], heldGates: number[]) {
    const c = ctx(width, 400);
    const byColour = new Map<string, { x: number; y: number; right: number; bottom: number }>();
    let bandY = -1;
    c.fillRect.mockImplementation((x: unknown, y: unknown, w: unknown, h: unknown) => {
      const colour = c.fillStyle as string;
      // The stability bar's unfilled track, drawn once, is the strip band's own
      // top edge — the thing a one-row level has to stay level with.
      if (colour === "#071007") bandY = Number(y);
      if (!GATE_HEXES.includes(colour)) return;
      const [px, py, pw, ph] = [Number(x), Number(y), Number(w), Number(h)];
      const box = byColour.get(colour);
      if (!box) {
        byColour.set(colour, { x: px, y: py, right: px + pw, bottom: py + ph });
        return;
      }
      box.x = Math.min(box.x, px);
      box.y = Math.min(box.y, py);
      box.right = Math.max(box.right, px + pw);
      box.bottom = Math.max(box.bottom, py + ph);
    });
    drawHud(asCtx(c), fakeStats({ gateColors, heldGates }));
    return { pips: [...byColour.values()], bandY };
  }

  /** Every preset x every gate count the generator can emit. The single-width
   * test this replaces ran at 800 only — where the defect it was meant to catch
   * does not reproduce — and filtered out-of-panel pips away *before* asserting,
   * so it could not have failed on one. Both axes are enumerated now. */
  const PIP_CASES = SHIPPED_WIDTHS.flatMap((w) => [1, 2, 3, 4].map((n) => [w, n] as const));

  it.each(PIP_CASES)("at %ipx with %i gate(s): every pip is inside the KEYS panel", (w, gates) => {
    const keys = layoutHud(w, 400).panels.keys;
    const { pips } = pipBoxes(w, [0, 1, 2, 3].slice(0, gates), [0, 2]);
    // Counted, not filtered: a pip that escaped the panel still has to be here.
    expect(pips).toHaveLength(gates);
    for (const b of pips) {
      expect(b.x, `left edge at ${w}px`).toBeGreaterThanOrEqual(keys.x + HUD_PAD);
      expect(b.right, `right edge at ${w}px`).toBeLessThanOrEqual(keys.x + keys.w - HUD_PAD);
      // The label is 9px with no descenders on a +14 baseline, so its em box
      // ends around +16; the bar's own bottom is the other bound.
      expect(b.y, `top edge at ${w}px`).toBeGreaterThanOrEqual(keys.y + 17);
      expect(b.bottom, `bottom edge at ${w}px`).toBeLessThanOrEqual(keys.y + HUD_HEIGHT);
    }
  });

  it("has exactly one grid slot per gate colour", () => {
    // `hudLayout.ts` sizes the panel from KEY_COLS/KEY_ROWS and cannot import
    // the map types to check the cap itself — the same split that is spelled
    // out for TOOL_SLOTS. If a fifth key colour is ever added, this is what
    // says the grid has to grow before it can be drawn.
    expect(KEY_COLS * KEY_ROWS).toBe(GATE_COLOR_COUNT);
  });

  it("draws at most a full grid, however many gates it is handed", () => {
    // The cap is enforced by generation (`MAX_GATE_ROOMS`), so this is not
    // reachable in a real level — but the panel is 72px tall and a third row
    // would stack straight through the KEYS label, so the renderer bounds its
    // own block rather than trusting its caller.
    const { pips } = pipBoxes(640, [0, 1, 2, 3, 0, 1], []);
    const keys = layoutHud(640, 400).panels.keys;
    expect(pips).toHaveLength(KEY_COLS * KEY_ROWS);
    for (const b of pips) expect(b.y).toBeGreaterThanOrEqual(keys.y + 17);
  });

  it("keeps a one-row level on the same strip band as the bars beside it", () => {
    // Two gates is the median level, and the grid grows *upward*, so that case
    // keeps the row it has always had — level with the stability and swap bars
    // and the TOOLS cells, not floating above them.
    const { pips, bandY } = pipBoxes(640, [0, 1], [0]);
    expect(pips).toHaveLength(2);
    for (const b of pips) expect(b.y).toBe(bandY);
  });

  /**
   * Every right-aligned string `drawHud` drew, with the box it occupies.
   *
   * Right-aligned is the interesting set: a numeral is anchored at its panel's
   * right pad and grows *leftward*, so an overlong one runs into the panel
   * before it rather than the one after. That is why the AMMO readout appeared
   * clipped at the canvas edge — it is the leftmost panel, so there was no
   * neighbour left to run into.
   */
  function rightAlignedBoxes(width: number, stats: EngineStats) {
    const c = ctx(width, 400);
    const drawn: { text: string; font: string; right: number }[] = [];
    c.fillText.mockImplementation((text: unknown, x: unknown) => {
      if (c.textAlign !== "right") return;
      drawn.push({ text: String(text), font: c.font as string, right: Number(x) });
    });
    drawHud(asCtx(c), stats);
    return drawn.map((d) => {
      c.font = d.font;
      return { ...d, left: d.right - asCtx(c).measureText(d.text).width };
    });
  }

  /** Values the game can really produce, at the top of their range.
   *
   * Not invented: the ammo pools have no cap anywhere in this game, and the
   * campaign score is a running total whose *mean* final value across
   * `balancing_runs_overnight-2026-08-04` is 47,175 — so a six-digit SCORE is
   * an ordinary end state and a five-digit reserve is an ordinary mid-game
   * one. The seven-digit score is the deliberate overshoot. */
  const WIDE_VALUES: [string, Partial<EngineStats>][] = [
    ["a four-digit reserve — the reported case", { weaponIndex: 0, bullets: 1262, magazine: 9, magazineSize: 9, score: 1450 }],
    ["a five-digit reserve", { weaponIndex: 0, bullets: 11250, magazine: 9, magazineSize: 9 }],
    ["a full SMG magazine over a five-digit reserve", { weaponIndex: 3, smg: 11286, magazine: 45, magazineSize: 45 }],
    ["a six-digit campaign score", { score: 471750 }],
    ["a seven-digit campaign score", { score: 1234567 }],
    ["every pool five digits at once", { bullets: 11241, shells: 10500, smg: 12345, rockets: 99999, gas: 54321, score: 987654 }],
    ["the values a fresh run starts on", {}],
  ];

  const WIDE_CASES = SHIPPED_WIDTHS.flatMap((w) => WIDE_VALUES.map(([name, over]) => [w, name, over] as const));

  it.each(WIDE_CASES)("at %ipx with %s: no readout is drawn outside its own panel", (w, _name, over) => {
    const { panels } = layoutHud(w, 400);
    const rects = Object.values(panels);
    const boxes = rightAlignedBoxes(w, fakeStats(over));
    // The bar always has readouts; a mock that silently drew none would pass
    // every containment assertion below.
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      const panel = rects.find((r) => box.right > r.x && box.right <= r.x + r.w);
      expect(panel, `"${box.text}" is anchored outside every panel at ${w}px`).toBeDefined();
      expect(box.left, `"${box.text}" overflows its panel at ${w}px`).toBeGreaterThanOrEqual(panel!.x + HUD_PAD);
    }
  });

  it("keeps the full-size numeral whenever it fits, and only steps down when it cannot", () => {
    // The point of the ladder is that a normal bar is untouched. STABIL's
    // widest possible reading is `100%` and SWAP's is `100`, so neither can
    // ever shrink; a four-digit score at the Classic preset still cannot.
    const normal = rightAlignedBoxes(640, fakeStats({ score: 1450, weaponIndex: 0, bullets: 40, magazine: 9, magazineSize: 9 }));
    for (const box of normal) {
      if (box.font.includes("9px") || box.font.includes("11px")) continue; // labels and table rows
      expect(box.font, `"${box.text}" shrank when it did not have to`).toContain("22px");
    }
    // And a six-digit score at the same preset does step down.
    const wide = rightAlignedBoxes(640, fakeStats({ score: 471750 }));
    const scoreBox = wide.find((b) => b.text === "471750");
    expect(scoreBox?.font).not.toContain("22px");
  });

  it("shows a dash instead of pips on a level with no gates at all", () => {
    // Most levels: C sources produce no private/protected members, so no gates.
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ heldGates: [], gateColors: [] }));
    expect(c.fillText).toHaveBeenCalledWith("—", expect.any(Number), expect.any(Number));
  });
});

describe("the ammo table", () => {
  it("draws every pool, in the renderer's own display order", () => {
    // Pinned independently of AMMO_TYPES, whose order is a replay-determinism
    // constant. If someone ever "tidies" that array to match this, or this to
    // match that, one of these two facts breaks loudly instead of silently
    // changing the disconnect-drop sequence.
    const c = ctx();
    drawHud(asCtx(c), fakeStats());
    const drawn = c.fillText.mock.calls.map((call) => String(call[0]));
    const rows = drawn.filter((t) => ["BULL", "SHEL", "SMG", "RCKT", "GAS"].includes(t));
    expect(rows).toEqual(["BULL", "SHEL", "SMG", "RCKT", "GAS"]);
  });

  it("shows the pooled total per row, with no invented maximum", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ bullets: 40, shells: 12, smg: 40, rockets: 4, gas: 40 }));
    const drawn = c.fillText.mock.calls.map((call) => String(call[0]));
    for (const v of ["40", "12", "4"]) expect(drawn).toContain(v);
    // No "x/y" anywhere in the table — that is the AMMO panel's form, and
    // there is no cap in the game to be the denominator.
    expect(drawn.filter((t) => t.includes("/"))).toHaveLength(1);
  });

  it("floors the one fractional pool", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ gas: 37.5 }));
    expect(c.fillText.mock.calls.map((call) => String(call[0]))).toContain("37");
  });

  it("agrees with the AMMO panel by construction: loaded + reserve is the pooled total", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, bullets: 40, magazine: 9, magazineSize: 9 }));
    const drawn = c.fillText.mock.calls.map((call) => String(call[0]));
    expect(drawn).toContain("9/31"); // AMMO panel
    expect(drawn).toContain("40"); // table row — and 9 + 31 = 40
  });

  it("lights only the equipped weapon's row", () => {
    const c = ctx();
    const log = fillTextStylesLog(c);
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0 })); // pistol -> bullets
    expect(log.find(([t]) => t === "BULL")?.[1]).toBe("#4cff6a");
    expect(log.find(([t]) => t === "GAS")?.[1]).not.toBe("#ff8a4a");
  });
});

describe("the TOOLS grid", () => {
  it("lights the cell for the number key that equips the weapon, not its array index", () => {
    // The trap: WEAPONS[3] is gdb but its number key is 3, not 4. A grid keyed
    // by WEAPONS index lights the wrong cell for everything past the knife —
    // the same off-by-one that once made the bot's Digit3 equip ghidra.
    const c = ctx();
    const log = fillTextStylesLog(c);
    drawHud(asCtx(c), fakeStats({ weaponIndex: 3, ownedWeapons: [0, 1, 2, 3] }));
    expect(log.find(([t]) => t === "3")?.[1]).toBe("#8effa0"); // gdb = slot 3, lit
    expect(log.find(([t]) => t === "4")?.[1]).toBe("#2f4a33"); // ghidra unowned
  });

  it("draws one cell per number-key weapon, not a hardcoded five", () => {
    const c = ctx();
    drawHud(asCtx(c), fakeStats());
    const drawn = c.fillText.mock.calls.map((call) => String(call[0]));
    const digits = NUMBER_KEY_WEAPONS.map((_, i) => String(i + 1));
    for (const d of digits) expect(drawn).toContain(d);
  });

  it("distinguishes owned from unowned", () => {
    const c = ctx();
    const log = fillTextStylesLog(c);
    drawHud(asCtx(c), fakeStats({ weaponIndex: 0, ownedWeapons: [0, 1, 2] }));
    expect(log.find(([t]) => t === "1")?.[1]).toBe("#8effa0"); // equipped
    expect(log.find(([t]) => t === "2")?.[1]).toBe("#5aa869"); // owned
    expect(log.find(([t]) => t === "5")?.[1]).toBe("#2f4a33"); // not owned
  });
});

describe("HUD_HEIGHT", () => {
  it("is a fixed 72px", () => {
    expect(HUD_HEIGHT).toBe(72);
  });
});

describe("TOOLS grid", () => {
  /** Every string the bar draws, in call order. */
  function drawnText(stats: EngineStats): string[] {
    const c = ctx();
    const seen: string[] = [];
    c.fillText.mockImplementation((text: unknown) => {
      seen.push(String(text));
    });
    drawHud(asCtx(c), stats);
    return seen;
  }

  it("has exactly one cell per number-key weapon", () => {
    // The grid's width is derived from TOOL_SLOTS in `hudLayout.ts`, which
    // cannot import the weapon table without a cycle. If a weapon is ever
    // added to the number keys, this is what says the panel has to grow.
    expect(TOOL_SLOTS).toBe(NUMBER_KEY_WEAPONS.length);
  });

  it("draws the slot digits and no melee letter", () => {
    // Regression: the grid used to end in a `K`/`T` cell for the knife or
    // Toolchain. Melee has no number key — it is bound to Space — so a letter
    // in a row of key digits read as a keybind that does not exist, and the
    // cell overflowed the panel into the face besides.
    const drawn = drawnText(fakeStats({ ownedWeapons: [0, 1, 2, 6], weaponIndex: 0 }));
    for (const slot of ["1", "2", "3", "4", "5"]) expect(drawn).toContain(slot);
    expect(drawn).not.toContain("K");
    expect(drawn).not.toContain("T");
  });

  it("still shows melee elsewhere, so removing the cell lost no information", () => {
    // The knife/Toolchain distinction is carried by the AMMO panel, which is
    // why the grid does not need to carry it: it reads MELEE with an infinity
    // mark whenever one is in your hands.
    const drawn = drawnText(fakeStats({ ownedWeapons: [0, 1, 2], weaponIndex: 2 }));
    expect(drawn).toContain("MELEE");
  });
});
