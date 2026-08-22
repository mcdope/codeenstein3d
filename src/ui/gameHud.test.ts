// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import { GameHud, overlayLayout, type OverlayContent, type StatsScreenInfo } from "./gameHud";
import { emptyPlayerFacingStats } from "../engine/playerStats";
import { zeroScoreBreakdown } from "../engine/scoring";

function fakeStatsScreenInfo(): StatsScreenInfo {
  return {
    scoreBreakdown: { ...zeroScoreBreakdown(), healthBonus: 500, accuracyBonus: 180, total: 680 },
    playerStats: { ...emptyPlayerFacingStats(), kills: 12, shotsFired: 20, hits: 15, weaponAccuracyPct: 75, lootCollectedTotal: 8, timeSurvivedSec: 222, minHealthReached: 8 },
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
  hud.showKernelPanic(undefined, onReturn, { remaining, onRollback });
  return { onReturn, onRollback };
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

  it("draws both buttons and names the remaining count", () => {
    panicWithRollback(2);
    const texts = fillTextCalls();
    expect(texts).toContain("KERNEL PANIC");
    expect(texts).toContain("Roll back");
    expect(texts).toContain("Give up");
    expect(texts.some((t) => t.includes("2 rollbacks left"))).toBe(true);
    expect(texts).not.toContain("Return to file tree");
  });

  it("says 'rollback' rather than 'rollbacks' on the last one", () => {
    panicWithRollback(1);
    expect(fillTextCalls().some((t) => t.includes("1 rollback left"))).toBe(true);
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
    const geom = overlayLayout(640, 400, {
      title: "KERNEL PANIC",
      color: "#ff4d4d",
      lines: ["a", "b", "c"],
      buttonLabel: "Roll back",
      secondary: { label: "Give up", onPick: () => {} },
    } as OverlayContent);
    const centre = (i: number): [number, number] => [
      geom.buttons[i].x + geom.buttons[i].w / 2,
      geom.buttons[i].y + geom.buttons[i].h / 2,
    ];

    const first = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(...centre(0));
    expect(first.onRollback).toHaveBeenCalledTimes(1);
    expect(first.onReturn).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const second = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(...centre(1));
    expect(second.onReturn).toHaveBeenCalledTimes(1);
    expect(second.onRollback).not.toHaveBeenCalled();
  });

  it("maps a click through the CSS scale, so a scaled-up canvas still hits", () => {
    // The canvas renders at 640x400 and is CSS-scaled by canvasFit.ts; a
    // handler reading clientX raw would land in the wrong place (or nowhere)
    // on every real viewport.
    const geom = overlayLayout(640, 400, {
      title: "KERNEL PANIC",
      color: "#ff4d4d",
      lines: ["a", "b", "c"],
      buttonLabel: "Roll back",
      secondary: { label: "Give up", onPick: () => {} },
    } as OverlayContent);
    const { onReturn, onRollback } = panicWithRollback();
    passLockWindow();
    mouseDownAtCanvasPoint(geom.buttons[1].x + geom.buttons[1].w / 2, geom.buttons[1].y + 4, 2);
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
    const geom = overlayLayout(640, 400, {
      title: "KERNEL PANIC",
      color: "#ff4d4d",
      lines: ["a", "b", "c"],
      buttonLabel: "Roll back",
      secondary: { label: "Give up", onPick: () => {} },
    } as OverlayContent);
    canvas.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: geom.buttons[0].x + geom.buttons[0].w / 2,
        clientY: geom.buttons[0].y + geom.buttons[0].h / 2,
      }),
    );
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
