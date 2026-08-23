// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import { GameHud, overlayLayout, WIDE_BOX_W, type OverlayContent, type StatsScreenInfo } from "./gameHud";
import { emptyPlayerFacingStats } from "../engine/playerStats";
import { zeroScoreBreakdown } from "../engine/scoring";

function fakeStatsScreenInfo(): StatsScreenInfo {
  return {
    scoreBreakdown: { ...zeroScoreBreakdown(), healthBonus: 500, accuracyBonus: 180, total: 680 },
    playerStats: { ...emptyPlayerFacingStats(), kills: 12, shotsFired: 20, hits: 15, weaponAccuracyPct: 75, lootCollectedTotal: 8, timeSurvivedSec: 222, minHealthReached: 8 },
  };
}

/** The same shape, filled with the values that make every grouped string as
 * long as it can get — the widest content any of these screens can be asked to
 * draw. `fakeStatsScreenInfo` above is a *typical* run; this one is the one the
 * layout has to survive. */
function worstCaseStatsScreenInfo(): StatsScreenInfo {
  return {
    scoreBreakdown: {
      ...zeroScoreBreakdown(),
      healthBonus: 500,
      accuracyBonus: 180,
      pathBonus: 250,
      mapCompletionBonus: 100,
      loreBonus: 50,
      secretRoomBonus: 200,
      multikillBonus: 300,
      total: 1580,
    },
    playerStats: {
      ...emptyPlayerFacingStats(),
      kills: 128,
      weaponAccuracyPct: 75,
      lootCollectedTotal: 88,
      timeSurvivedSec: 3722,
      minHealthReached: 8,
      damageTakenBySource: { ...emptyPlayerFacingStats().damageTakenBySource, enemyMelee: 120, enemyRanged: 340, trapSpike: 40, trapMine: 20 },
    },
  };
}

const DISMISS_LOCK_MS = 1200;

let raf: RafController;
let ctx: MockCanvasContext;
let canvas: HTMLCanvasElement;
let hud: GameHud;

beforeEach(() => {
  raf = installRaf({ stubClock: true });
  canvas = document.createElement("canvas");
  // A real preset, not jsdom's 300x150 default. The overlay's box is sized and
  // its text wrapped against the canvas, so a fixture smaller than any shipped
  // preset makes every layout assertion a statement about a screen that does
  // not exist — which is how the squeezed stat rows went unnoticed.
  canvas.width = 640;
  canvas.height = 400;
  ctx = createMockCanvasContext(canvas);
  canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
  hud = new GameHud(canvas);
});

afterEach(() => {
  raf.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Gamepad stubs below are assigned directly onto `navigator` (not via
  // vi.stubGlobal, since only the property is being overridden, not the
  // whole global object) — clean up explicitly so one test's fake gamepad
  // doesn't leak into the next.
  delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
});

/** Advances the shared fake clock well past DISMISS_LOCK_MS by flushing the
 * gamepad-poll rAF once with a large step — harmless with no gamepad wired
 * up (pressed reads false), and doesn't consume any queued keyboard/mouse
 * dismiss triggers since those aren't rAF-driven. */
function passLockWindow(): void {
  raf.flush(1, DISMISS_LOCK_MS + 100);
}

function fillTextCalls(): string[] {
  return ctx.fillText.mock.calls.map(([text]) => text as string);
}

/** Every `fillText` that was given a `maxWidth`, with that width kept — the
 * one thing `fillTextCalls` throws away, and the only place the suite can see
 * whether a string was squeezed to fit (`doc/dev/testing.md`). The font size
 * comes from the call's own `ctx.font`, recorded per call by the mock. */
function clampedDraws(): { text: string; fontPx: number; maxWidth: number }[] {
  return ctx.fillText.mock.calls
    .map((c, i) => ({
      text: c[0] as string,
      // The mock returns the font it drew with — see `test/mocks/canvas.ts`.
      fontPx: Number(/(\d+(?:\.\d+)?)px/.exec(String(ctx.fillText.mock.results[i]?.value ?? "13px"))?.[1] ?? 13),
      maxWidth: c[3] as number,
    }))
    .filter((d) => typeof d.maxWidth === "number");
}

/** Asserts nothing currently on the overlay had to be horizontally squeezed
 * by `fillText`'s `maxWidth`. The 0.62 mirrors `CHAR_EM` deliberately rather
 * than importing it: the overlay is monospace, 0.602em/char measured in
 * Chromium across all three of its fonts, so this is an independent statement
 * of the same physical fact. Lowering `CHAR_EM` below what glyphs actually
 * need would fail here, which is the direction that reintroduces the bug. */
function expectNothingSqueezed(): void {
  for (const { text, fontPx, maxWidth } of clampedDraws()) {
    expect(maxWidth, `"${text}" (${fontPx}px) was squeezed`).toBeGreaterThanOrEqual(text.length * fontPx * 0.62);
  }
}

describe("GameHud — overlay content per method", () => {
  it("showKernelPanic draws the expected title/lines/button, no stats", () => {
    hud.showKernelPanic(undefined, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("KERNEL PANIC");
    expect(texts).toContain("System stability reached 0%.");
    expect(texts).toContain("Return to file tree");
  });

  it("showBuildSuccessful draws its own title/lines/button", () => {
    hud.showBuildSuccessful(undefined, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("BUILD SUCCESSFUL");
    expect(texts).toContain("return statement reached. Exit code 0 —");
  });

  it("showKernelPanic draws the curated stat rows when given stats", () => {
    hud.showKernelPanic(fakeStatsScreenInfo(), vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("Kills");
    expect(texts).toContain("12");
    expect(texts).toContain("Weapon accuracy");
    expect(texts).toContain("75%");
    expect(texts).toContain("Loot collected");
    expect(texts).toContain("Closest call");
  });

  it("showBuildSuccessful draws the curated stat rows when given stats", () => {
    hud.showBuildSuccessful(fakeStatsScreenInfo(), vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("Kills");
    expect(texts).toContain("Score bonuses");
    expect(texts).toContain("Bonus features");
  });

  it("showLevelStart draws the campaign title and room/enemy/secret stats", () => {
    hud.showLevelStart({ campaign: "demo", levelName: "main.c", roomCount: 5, enemyCount: 8, secretRoomCount: 2 }, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("demo");
    expect(texts).toContain("Compiling main.c…");
    expect(texts).toContain("Rooms");
    expect(texts).toContain("5");
    expect(texts).toContain("Enemies");
    expect(texts).toContain("8");
    expect(texts).toContain("Secrets");
    expect(texts).toContain("2");
    expect(texts).toContain("Start");
  });

  it("showCommitSummary draws its stats and has no body lines", () => {
    hud.showCommitSummary({ linesRefactored: 120, bugsSquashed: 3 }, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("COMMIT SUMMARY");
    expect(texts).toContain("Lines refactored");
    expect(texts).toContain("120");
    expect(texts).toContain("Bugs squashed");
    expect(texts).toContain("3");
    expect(texts).toContain("Continue");
  });

  it("showCommitSummary also draws the curated stat rows when given stats", () => {
    hud.showCommitSummary({ linesRefactored: 120, bugsSquashed: 3, stats: fakeStatsScreenInfo() }, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("Weapon accuracy");
    expect(texts).toContain("Time survived");
    expect(texts).toContain("Damage taken");
  });

  it("showMultiplayerResults draws the given title/color and one row per player", () => {
    hud.showMultiplayerResults(
      "MULTIPLAYER: CAMPAIGN COMPLETE",
      "#37d24a",
      [
        ["Host", "1234 pts · 5 kills"],
        ["Guest", "987 pts · 3 kills (disconnected)"],
      ],
      vi.fn(),
    );
    const texts = fillTextCalls();
    expect(texts).toContain("MULTIPLAYER: CAMPAIGN COMPLETE");
    expect(texts).toContain("Host");
    expect(texts).toContain("1234 pts · 5 kills");
    expect(texts).toContain("Guest");
    expect(texts).toContain("987 pts · 3 kills (disconnected)");
    expect(texts).toContain("Return to file tree");
  });

  it("showReplayEnded draws the given reason as its body line", () => {
    hud.showReplayEnded("Recorded file could not be relocated.", vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("REPLAY ENDED");
    expect(texts).toContain("Recorded file could not be relocated.");
    expect(texts).toContain("Return to file tree");
  });

  it("does nothing but still wires up dismissal when the canvas has no 2D context", () => {
    canvas.getContext = vi.fn(() => null) as unknown as typeof canvas.getContext;
    const onAck = vi.fn();
    expect(() => hud.showKernelPanic(undefined, onAck)).not.toThrow();
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — dismiss lock", () => {
  it("ignores every dismiss trigger before DISMISS_LOCK_MS has elapsed", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("honors a dismiss trigger once the lock has expired", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — keyboard dismiss", () => {
  it.each(["Enter", "Space", "Escape"])("dismisses on %s and prevents its default", (code) => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    const event = new KeyboardEvent("keydown", { code, cancelable: true });
    window.dispatchEvent(event);
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores an unrelated key", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("removes its keydown listener after dismissing, so a later key press doesn't re-fire onAck", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — mouse dismiss", () => {
  it("dismisses on a canvas mousedown", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("removes its mousedown listener after dismissing", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — gamepad dismiss", () => {
  function stubGamepad(pressed: boolean): void {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [
      { buttons: [{ pressed }] } as unknown as Gamepad,
    ];
  }

  it("does nothing when no gamepad is connected", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [null];
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    raf.flush(3);
    expect(onAck).not.toHaveBeenCalled();
  });

  it("treats a missing navigator.getGamepads as no gamepads connected", () => {
    (navigator as unknown as { getGamepads?: unknown }).getGamepads = undefined;
    const onAck = vi.fn();
    expect(() => hud.showKernelPanic(undefined, onAck)).not.toThrow();
    passLockWindow();
    expect(() => raf.flush(3)).not.toThrow();
    expect(onAck).not.toHaveBeenCalled();
  });

  it("dismisses on a fresh button press once the lock has expired", () => {
    stubGamepad(false);
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    stubGamepad(true);
    raf.flush(1);
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss while a button is already held through the lock window (no edge)", () => {
    stubGamepad(true);
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    // Several polls while still locked and still held — the edge (pressed
    // transitioning from false) already happened before the lock cleared.
    raf.flush(5, 300); // 1500ms total, past the lock, button held throughout
    expect(onAck).not.toHaveBeenCalled();

    // Release, then a fresh press is a real edge and should dismiss.
    stubGamepad(false);
    raf.flush(1);
    stubGamepad(true);
    raf.flush(1);
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("cancels the gamepad poll loop after a keyboard dismissal", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(undefined, onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
    // The poll loop's own rAF was cancelled by dismiss() — nothing left to flush.
    expect(raf.flush(5)).toBe(0);
  });
});


/** A two-button Kernel Panic, with the canvas sized so rects are predictable. */
function panicWithRollback(remaining = 2): { onReturn: ReturnType<typeof vi.fn>; onRollback: ReturnType<typeof vi.fn> } {
  const onReturn = vi.fn();
  const onRollback = vi.fn();
  hud.showKernelPanic(undefined, onReturn, { rollback: { remaining, onRollback } });
  return { onReturn, onRollback };
}

/**
 * The two button rects, read back out of what was actually drawn.
 *
 * Recovered from the mock rather than recomputed with a synthetic
 * `OverlayContent`, because the synthetic version has to guess how many *rows*
 * the real copy occupies — and once a long line wraps, a stand-in of three
 * dummy lines silently stops describing the screen under test, moving the
 * buttons out from under every click the test makes.
 *
 * The primary is the last 4-argument `fillRect` (the box and scrim precede it);
 * the secondary is the only `strokeRect` with a 1px line width.
 */
function drawnButtons(): { x: number; y: number; w: number; h: number }[] {
  const fills = ctx.fillRect.mock.calls;
  const [px, py, pw, ph] = fills[fills.length - 1] as number[];
  const strokes = ctx.strokeRect.mock.calls;
  const [sx, sy, sw, sh] = strokes[strokes.length - 1] as number[];
  // The secondary's outline is inset by half a line width — undo it, so both
  // entries describe the same thing the hit test compares against.
  return [
    { x: px, y: py, w: pw, h: ph },
    { x: sx - 0.5, y: sy - 0.5, w: sw + 1, h: sh + 1 },
  ];
}

/** The centre of a drawn button, as a click target. */
function buttonCentre(i: number): [number, number] {
  const b = drawnButtons()[i];
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/** Dispatch a mousedown at a point in *canvas* pixels, through a stubbed
 * bounding rect so the CSS-scaling path in `show()` is the one under test. */
function mouseDownAtCanvasPoint(x: number, y: number, cssScale = 1): void {
  canvas.getBoundingClientRect = (() => ({
    left: 0,
    top: 0,
    width: canvas.width * cssScale,
    height: canvas.height * cssScale,
  })) as unknown as typeof canvas.getBoundingClientRect;
  canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: x * cssScale, clientY: y * cssScale }));
}

describe("GameHud — Kernel Panic offering a rollback", () => {
  beforeEach(() => {
    canvas.width = 640;
    canvas.height = 400;
  });

  it("draws both buttons and says what is left after this one", () => {
    panicWithRollback(2);
    const texts = fillTextCalls();
    expect(texts).toContain("KERNEL PANIC");
    expect(texts).toContain("Roll back");
    expect(texts).toContain("Give up");
    expect(texts.some((t) => t.includes("2 more rollbacks after this one"))).toBe(true);
    expect(texts).not.toContain("Return to file tree");
  });

  it("says 'rollback' rather than 'rollbacks' when one follows this one", () => {
    panicWithRollback(1);
    expect(fillTextCalls().some((t) => t.includes("1 more rollback after this one"))).toBe(true);
  });

  it("never reads as a bare count that contradicts the button", () => {
    // The reported bug: `remaining` is the count *after* this rollback is
    // spent, so on the last one the screen said "0 rollbacks left" directly
    // above a live "Roll back" button. Whatever the wording, it must never
    // announce zero of something it is simultaneously offering.
    panicWithRollback(0);
    const texts = fillTextCalls();
    expect(texts).toContain("Roll back"); // the offer is real
    expect(texts.some((t) => t.includes("last rollback"))).toBe(true);
    expect(texts.some((t) => /\b0 rollback/.test(t))).toBe(false);
  });

  it("keeps the wording honest at every count the game can produce", () => {
    // Easy grants 2, so 1 and 0 are the counts a real run reaches; 2 is
    // covered above. None of them may contain a bare "0".
    for (const remaining of [0, 1, 2]) {
      vi.clearAllMocks();
      panicWithRollback(remaining);
      const texts = fillTextCalls();
      expect(texts, `remaining=${remaining}`).toContain("Roll back");
      expect(texts.some((t) => /\b0 rollback/.test(t)), `remaining=${remaining}`).toBe(false);
    }
  });

  it("stays exactly as it was when no rollback is offered", () => {
    // The regression guard for the replay viewer, which shares this method.
    hud.showKernelPanic(undefined, vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("Return to file tree");
    expect(texts).toContain("The process was terminated.");
    expect(texts).not.toContain("Give up");
  });

  it("Enter and Space pick Roll back, the primary", () => {
    for (const code of ["Enter", "Space"]) {
      vi.clearAllMocks();
      const { onReturn, onRollback } = panicWithRollback();
      passLockWindow();
      window.dispatchEvent(new KeyboardEvent("keydown", { code }));
      expect(onRollback).toHaveBeenCalledTimes(1);
      expect(onReturn).not.toHaveBeenCalled();
    }
  });

  it("Escape picks Give up", () => {
    const { onReturn, onRollback } = panicWithRollback();
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("ignores every key until the dismiss lock expires", () => {
    const { onReturn, onRollback } = panicWithRollback();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(onRollback).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("clicking each button picks that button", () => {
    const first = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(...buttonCentre(0));
    expect(first.onRollback).toHaveBeenCalledTimes(1);
    expect(first.onReturn).not.toHaveBeenCalled();

    const second = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(...buttonCentre(1));
    expect(second.onReturn).toHaveBeenCalledTimes(1);
    expect(second.onRollback).not.toHaveBeenCalled();
  });

  it("maps a click through the CSS scale, so a scaled-up canvas still hits", () => {
    // The canvas renders at 640x400 and is CSS-scaled by canvasFit.ts; a
    // handler reading clientX raw would land in the wrong place (or nowhere)
    // on every real viewport.
    const { onReturn, onRollback } = panicWithRollback();
    passLockWindow();
    const secondary = drawnButtons()[1];
    mouseDownAtCanvasPoint(secondary.x + secondary.w / 2, secondary.y + 4, 2);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("a click that misses both buttons does nothing and leaves the overlay up", () => {
    const { onReturn, onRollback } = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(5, 5);
    expect(onRollback).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
    // Still live: a follow-up press on a real button must still resolve.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it("falls back to 1:1 when the canvas reports a zero-sized rect", () => {
    // jsdom's default, and a display:none canvas — must not divide by zero.
    const { onRollback } = panicWithRollback();
    passLockWindow();
    const [primaryX, primaryY] = buttonCentre(0);
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: primaryX, clientY: primaryY }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it("gamepad button 0 rolls back and button 1 gives up", () => {
    const padWith = (index: number) => ({
      buttons: [0, 1, 2, 3].map((i) => ({ pressed: i === index })),
    });
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [padWith(0)];
    const first = panicWithRollback();
    passLockWindow();
    raf.flush(1, 16);
    expect(first.onRollback).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [padWith(1)];
    const second = panicWithRollback();
    passLockWindow();
    raf.flush(1, 16);
    expect(second.onReturn).toHaveBeenCalledTimes(1);
  });

  it("ignores gamepad buttons other than the two face buttons", () => {
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [
      { buttons: [0, 1, 2, 3].map((i) => ({ pressed: i === 3 })) },
    ];
    const { onReturn, onRollback } = panicWithRollback();
    passLockWindow();
    raf.flush(2, 16);
    expect(onRollback).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("still wires input when the canvas has no 2D context", () => {
    canvas.getContext = vi.fn(() => null) as unknown as typeof canvas.getContext;
    const { onRollback } = panicWithRollback();
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — Kernel Panic after a cheated run", () => {
  /** The line itself is a joke and may well get reworded; what must hold is
   * that it appears exactly when a cheat has fired and nowhere else, so these
   * assert the property rather than pinning the whole sentence. */
  const stillDied = (texts: string[]): boolean => texts.some((t) => t.includes("still died"));

  it("says something about it when a cheat fired this run", () => {
    hud.showKernelPanic(undefined, vi.fn(), { cheated: true });
    const texts = fillTextCalls();
    expect(texts).toContain("KERNEL PANIC");
    expect(texts).toContain("The process was terminated.");
    expect(stillDied(texts)).toBe(true);
  });

  it("says nothing on a clean run", () => {
    hud.showKernelPanic(undefined, vi.fn(), { cheated: false });
    expect(stillDied(fillTextCalls())).toBe(false);
  });

  it("says nothing when no options are passed at all", () => {
    // The replay viewer's path, and every caller that predates the flag — a
    // cheated run never becomes a replay in the first place (highscore
    // recording, and with it the recorder, is disabled once a cheat fires).
    hud.showKernelPanic(undefined, vi.fn());
    expect(stillDied(fillTextCalls())).toBe(false);
  });

  it("stays out of the way when a rollback is on offer", () => {
    // Deliberate, not incidental: that screen is a decision the player has to
    // read, and every line on it is required to describe the choice and what
    // follows it. The punchline waits for the death that actually ends the run.
    hud.showKernelPanic(undefined, vi.fn(), { cheated: true, rollback: { remaining: 1, onRollback: vi.fn() } });
    const texts = fillTextCalls();
    expect(texts).toContain("Roll back");
    expect(stillDied(texts)).toBe(false);
  });

  it("adds exactly one line and disturbs nothing else", () => {
    hud.showKernelPanic(undefined, vi.fn());
    const clean = fillTextCalls();
    vi.clearAllMocks();
    hud.showKernelPanic(undefined, vi.fn(), { cheated: true });
    const cheated = fillTextCalls();
    expect(cheated.length).toBe(clean.length + 1);
    for (const t of clean) expect(cheated).toContain(t);
  });
});

describe("GameHud — no overlay squeezes its own text", () => {
  // `fillText`'s `maxWidth` compresses glyphs horizontally instead of
  // overflowing, so an oversized line renders squashed and still passes any
  // test that only asks *what* text was drawn — which is how the rollback
  // death screen shipped with its three longest lines squeezed into a 388px
  // box that needed 556. These assert the width every drawn string was
  // actually given, which is what `doc/dev/testing.md` records as the blind
  // spot this closes.
  beforeEach(() => {
    // Roomy on purpose: the canvas edge (`w - 48`) is the documented last
    // resort, and a box pinned against it can still squeeze. These tests are
    // about the sizing rule, not about that fallback.
    canvas.width = 1600;
    canvas.height = 900;
  });

  it("Kernel Panic fits its lines — including the longest rollback wording", () => {
    for (const remaining of [0, 1, 2]) {
      vi.clearAllMocks();
      hud.showKernelPanic(undefined, vi.fn(), { rollback: { remaining, onRollback: vi.fn() } });
      expect(clampedDraws().length, `remaining=${remaining}`).toBeGreaterThan(0);
      expectNothingSqueezed();
    }
  });

  it("Kernel Panic fits the cheated line, with and without stats", () => {
    for (const stats of [undefined, fakeStatsScreenInfo()]) {
      vi.clearAllMocks();
      hud.showKernelPanic(stats, vi.fn(), { cheated: true });
      expectNothingSqueezed();
    }
  });

  it("fits the stat rows, whose grouped values are the longest strings any overlay draws", () => {
    // "Path … · Map … · Lore … · Secrets … · Streaks …" needs 446px against
    // the 286px each side gets in a 620-wide box — the one case that was
    // squeezed even *with* `wide` set, so no fixed width could have fixed it.
    hud.showCommitSummary({ linesRefactored: 1234, bugsSquashed: 567, stats: fakeStatsScreenInfo() }, vi.fn());
    expectNothingSqueezed();
  });

  it("fits every other overlay's own copy", () => {
    const draw: [string, () => void][] = [
      ["build successful", () => hud.showBuildSuccessful(fakeStatsScreenInfo(), vi.fn())],
      ["level start", () => hud.showLevelStart({ campaign: "stage06_pipeline.py", levelName: "stage06_pipeline.py", roomCount: 12, enemyCount: 34, secretRoomCount: 2 }, vi.fn())],
      ["recording notice", () => hud.showRecordingNotice(vi.fn())],
      // The real worst case in the repo, and by a distance: this reason
      // interpolates a file path and needs 986px against the 388px an
      // un-`wide` box gave it (`main.ts`'s balance-mismatch `endReplay`).
      ["replay ended", () => hud.showReplayEnded('"src/stage06_pipeline.py" was recorded under different game balance — this replay can\'t be trusted to match its score anymore.', vi.fn())],
      // Not a case that was ever broken — this screen always passes `wide`,
      // so its longest title had 588px for 397. Here to keep it that way.
      ["mp results", () => hud.showMultiplayerResults("MULTIPLAYER: HOST DISCONNECTED", "#f2c14e", [["a-very-long-player-name", "12450 pts · 87 kills (disconnected)"]], vi.fn())],
    ];
    for (const [name, run] of draw) {
      vi.clearAllMocks();
      run();
      expect(clampedDraws().length, name).toBeGreaterThan(0);
      expectNothingSqueezed();
    }
  });

  it.each([
    [640, 400],
    [1280, 800],
  ])("squeezes nothing on any screen at %ix%i, with the widest content each can hold", (w, h) => {
    // The check the rest of this file's squeeze tests should always have been.
    // They ran at 1600x900 — a canvas no preset produces — and so passed while
    // two stat rows were being squeezed at the Classic preset the whole time.
    // Both shipped presets, every screen, worst-case content, one table of
    // failures rather than the first one found.
    canvas.width = w;
    canvas.height = h;
    const stats = worstCaseStatsScreenInfo();
    const screens: [string, () => void][] = [
      ["kernel panic", () => hud.showKernelPanic(stats, vi.fn(), { cheated: true })],
      ["kernel panic + rollback", () => hud.showKernelPanic(undefined, vi.fn(), { rollback: { remaining: 2, onRollback: vi.fn() } })],
      ["commit summary", () => hud.showCommitSummary({ linesRefactored: 1234, bugsSquashed: 567, stats }, vi.fn())],
      ["build successful", () => hud.showBuildSuccessful(stats, vi.fn())],
      ["level start", () => hud.showLevelStart({ campaign: "stage06_pipeline.py", levelName: "stage06_pipeline.py", roomCount: 12, enemyCount: 34, secretRoomCount: 2 }, vi.fn())],
      // The worst string in the repo by a distance: `main.ts`'s balance-mismatch
      // `endReplay` reason interpolates a file path and needs 1,016px in a
      // 592px box. No box could hold it — it has to wrap.
      ["replay ended", () => hud.showReplayEnded('"src/stage06_pipeline.py" was recorded under different game balance — this replay can\'t be trusted to match its score anymore.', vi.fn())],
      ["mp results", () => hud.showMultiplayerResults("MULTIPLAYER: HOST DISCONNECTED", "#f2c14e", [["a-very-long-player-name", "12450 pts · 87 kills (disconnected)"]], vi.fn())],
      ["recording notice", () => hud.showRecordingNotice(vi.fn())],
    ];

    const squeezed: string[] = [];
    let measured = 0;
    for (const [name, run] of screens) {
      vi.clearAllMocks();
      run();
      for (const { text, fontPx, maxWidth } of clampedDraws()) {
        measured++;
        const need = text.length * fontPx * 0.62;
        if (need > maxWidth) squeezed.push(`${name}: "${text}" (${fontPx}px) needs ${need.toFixed(0)}, has ${maxWidth.toFixed(0)}`);
      }
    }
    // Without this the whole test passes vacuously the day `maxWidth` stops
    // being passed — "nothing was squeezed" and "nothing was measured" look
    // identical from the outside.
    expect(measured, "draws actually measured").toBeGreaterThan(20);
    expect(squeezed, `squeezed at ${w}x${h}:\n${squeezed.join("\n")}`).toEqual([]);
  });

  it("leaves a box alone when its content already fits", () => {
    // The regression pin for every screen that was never squeezed: content
    // drives the width only upward, from the same two floors as before.
    expect(overlayLayout(1600, 900, { title: "KERNEL PANIC", color: "#f00", lines: ["System stability reached 0%.", "The process was terminated."], buttonLabel: "Return to file tree" }).boxW).toBe(420);
    expect(overlayLayout(1600, 900, { title: "COMMIT SUMMARY", color: "#f00", lines: [], stats: [["Rooms", "12"]], buttonLabel: "Continue", wide: true }).boxW).toBe(WIDE_BOX_W);
  });

  it("never grows past the canvas, however long the content", () => {
    const box = overlayLayout(640, 400, { title: "T", color: "#f00", lines: ["x".repeat(400)], buttonLabel: "OK" });
    expect(box.boxW).toBe(640 - 48);
    expect(box.boxX).toBe(24);
  });
});

describe("overlayLayout", () => {
  const base: OverlayContent = {
    title: "T",
    color: "#fff",
    lines: ["one", "two"],
    buttonLabel: "OK",
  };

  it("puts a single button exactly where it has always been", () => {
    // Byte-for-byte the old formula, so no existing overlay moves a pixel.
    const { buttons } = overlayLayout(640, 400, base);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].x).toBe(640 / 2 - 170 / 2);
    expect(buttons[0].w).toBe(170);
  });

  it("centres two buttons about the canvas midline without overlapping them", () => {
    const { buttons, boxX, boxW } = overlayLayout(640, 400, {
      ...base,
      secondary: { label: "No", onPick: () => {} },
    });
    expect(buttons).toHaveLength(2);
    const left = buttons[0];
    const right = buttons[1];
    expect(left.x + left.w).toBeLessThan(right.x); // a real gap between them
    expect(left.x + left.w / 2 + (right.x + right.w / 2)).toBeCloseTo(640, 5); // symmetric about 320
    expect(left.x).toBeGreaterThanOrEqual(boxX + 16); // inside the box, with padding
    expect(right.x + right.w).toBeLessThanOrEqual(boxX + boxW - 16);
    expect(left.y).toBe(right.y);
  });

  it("shrinks both buttons equally rather than spilling out of a narrow box", () => {
    const { buttons, boxX, boxW } = overlayLayout(360, 400, {
      ...base,
      secondary: { label: "No", onPick: () => {} },
    });
    expect(buttons[0].w).toBe(buttons[1].w);
    expect(buttons[0].w).toBeLessThan(170);
    expect(buttons[0].x).toBeGreaterThanOrEqual(boxX);
    expect(buttons[1].x + buttons[1].w).toBeLessThanOrEqual(boxX + boxW);
  });

  it("keeps two full-width buttons on the wide (stats) box", () => {
    // The Kernel Panic screen widens to 620 whenever PLAYER_STATS_ENABLED is
    // on; both buttons must still get their full 170.
    const { buttons } = overlayLayout(1280, 800, {
      ...base,
      wide: true,
      stats: [["a", "1"]],
      secondary: { label: "No", onPick: () => {} },
    });
    expect(buttons[0].w).toBe(170);
    expect(buttons[1].w).toBe(170);
  });

  it("leaves room between the last content row and the buttons", () => {
    const { boxY, contentEnd, buttons, boxH } = overlayLayout(640, 400, {
      ...base,
      stats: [["a", "1"], ["b", "2"]],
    });
    expect(buttons[0].y).toBeGreaterThan(boxY + contentEnd);
    expect(buttons[0].y + buttons[0].h).toBeLessThanOrEqual(boxY + boxH);
  });
});
