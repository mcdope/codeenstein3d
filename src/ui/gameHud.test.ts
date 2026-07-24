// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import { GameHud, type StatsScreenInfo } from "./gameHud";
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
