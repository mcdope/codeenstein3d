// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { installRaf, type RafController } from "../../test/mocks/raf";
import { GameHud } from "./gameHud";

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
    hud.showKernelPanic(vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("KERNEL PANIC");
    expect(texts).toContain("System stability reached 0%.");
    expect(texts).toContain("Return to file tree");
  });

  it("showBuildSuccessful draws its own title/lines/button", () => {
    hud.showBuildSuccessful(vi.fn());
    const texts = fillTextCalls();
    expect(texts).toContain("BUILD SUCCESSFUL");
    expect(texts).toContain("return statement reached. Exit code 0 —");
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
    expect(() => hud.showKernelPanic(onAck)).not.toThrow();
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — dismiss lock", () => {
  it("ignores every dismiss trigger before DISMISS_LOCK_MS has elapsed", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("honors a dismiss trigger once the lock has expired", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — keyboard dismiss", () => {
  it.each(["Enter", "Space", "Escape"])("dismisses on %s and prevents its default", (code) => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    const event = new KeyboardEvent("keydown", { code, cancelable: true });
    window.dispatchEvent(event);
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores an unrelated key", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("removes its keydown listener after dismissing, so a later key press doesn't re-fire onAck", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

describe("GameHud — mouse dismiss", () => {
  it("dismisses on a canvas mousedown", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("removes its mousedown listener after dismissing", () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
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
    hud.showKernelPanic(onAck);
    passLockWindow();
    raf.flush(3);
    expect(onAck).not.toHaveBeenCalled();
  });

  it("treats a missing navigator.getGamepads as no gamepads connected", () => {
    (navigator as unknown as { getGamepads?: unknown }).getGamepads = undefined;
    const onAck = vi.fn();
    expect(() => hud.showKernelPanic(onAck)).not.toThrow();
    passLockWindow();
    expect(() => raf.flush(3)).not.toThrow();
    expect(onAck).not.toHaveBeenCalled();
  });

  it("dismisses on a fresh button press once the lock has expired", () => {
    stubGamepad(false);
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    passLockWindow();
    stubGamepad(true);
    raf.flush(1);
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss while a button is already held through the lock window (no edge)", () => {
    stubGamepad(true);
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
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
    hud.showKernelPanic(onAck);
    passLockWindow();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(onAck).toHaveBeenCalledTimes(1);
    // The poll loop's own rAF was cancelled by dismiss() — nothing left to flush.
    expect(raf.flush(5)).toBe(0);
  });
});
