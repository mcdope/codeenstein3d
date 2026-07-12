// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputController } from "./input";

let canvas: HTMLCanvasElement;
let controller: InputController;

function setPointerLockElement(el: Element | null): void {
  Object.defineProperty(document, "pointerLockElement", { value: el, configurable: true });
}

function setFullscreenElement(el: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
}

function kd(code: string, key: string, opts: { repeat?: boolean } = {}): void {
  canvas.dispatchEvent(new KeyboardEvent("keydown", { code, key, repeat: opts.repeat ?? false, bubbles: true, cancelable: true }));
}

function ku(code: string, key: string): void {
  canvas.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true, cancelable: true }));
}

function windowEscape(opts: { repeat?: boolean } = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", repeat: opts.repeat ?? false, bubbles: true, cancelable: true }));
}

function mousemove(movementX: number): void {
  // jsdom's MouseEvent constructor doesn't wire `movementX` through its init
  // dict (it stays 0 regardless), so it's patched on afterward.
  const e = new MouseEvent("mousemove");
  Object.defineProperty(e, "movementX", { value: movementX, configurable: true });
  document.dispatchEvent(e);
}

function fakeGamepad(overrides: Partial<{ axes: number[]; buttons: Array<{ pressed: boolean }> }> = {}): Gamepad {
  return {
    axes: overrides.axes ?? [0, 0, 0],
    buttons: overrides.buttons ?? [],
  } as unknown as Gamepad;
}

beforeEach(() => {
  canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  canvas.requestPointerLock = vi.fn();
  canvas.requestFullscreen = vi.fn().mockResolvedValue(undefined);
  document.exitPointerLock = vi.fn(() => setPointerLockElement(null));
  document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
  setPointerLockElement(null);
  setFullscreenElement(null);
  (navigator as unknown as { getGamepads?: () => (Gamepad | null)[] }).getGamepads = vi.fn(() => []);
  controller = new InputController(canvas);
});

afterEach(() => {
  controller.detach();
  document.body.removeChild(canvas);
  vi.restoreAllMocks();
});

describe("InputController.attach() / detach()", () => {
  it("is idempotent — a second attach() doesn't add duplicate listeners", () => {
    const addSpy = vi.spyOn(canvas, "addEventListener");
    controller.attach();
    const callsAfterFirst = addSpy.mock.calls.length;
    controller.attach();
    expect(addSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("detach() before any attach() is a safe no-op", () => {
    expect(() => controller.detach()).not.toThrow();
  });

  it("detach() releases pointer lock when this canvas currently holds it", () => {
    controller.attach();
    setPointerLockElement(canvas);
    controller.detach();
    expect(document.exitPointerLock).toHaveBeenCalledTimes(1);
  });

  it("detach() does not release pointer lock held by something else", () => {
    controller.attach();
    setPointerLockElement(null);
    controller.detach();
    expect(document.exitPointerLock).not.toHaveBeenCalled();
  });

  it("detach() clears held keys and every queued edge-trigger", () => {
    controller.attach();
    kd("KeyW", "w");
    kd("Digit3", "3");
    expect(controller.isDown("KeyW")).toBe(true);
    controller.detach();
    expect(controller.isDown("KeyW")).toBe(false);
    expect(controller.consumeWeaponRequest()).toBeNull();
  });
});

describe("InputController movement keys", () => {
  beforeEach(() => controller.attach());

  it("tracks a movement key as held between keydown and keyup", () => {
    kd("KeyW", "w");
    expect(controller.isDown("KeyW")).toBe(true);
    ku("KeyW", "w");
    expect(controller.isDown("KeyW")).toBe(false);
  });

  it("prevents default on movement keys but not on a non-movement key", () => {
    const wEvent = new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true, cancelable: true });
    canvas.dispatchEvent(wEvent);
    expect(wEvent.defaultPrevented).toBe(true);

    const rEvent = new KeyboardEvent("keydown", { code: "KeyR", key: "r", bubbles: true, cancelable: true });
    canvas.dispatchEvent(rEvent);
    expect(rEvent.defaultPrevented).toBe(false);
  });
});

describe("InputController cheat codes", () => {
  beforeEach(() => controller.attach());

  it("recognizes IDDQD typed letter by letter", () => {
    for (const letter of "IDDQD") kd(`Key${letter}`, letter.toLowerCase());
    expect(controller.consumeCheat()).toBe("IDDQD");
  });

  it("recognizes IDKFA", () => {
    for (const letter of "IDKFA") kd(`Key${letter}`, letter.toLowerCase());
    expect(controller.consumeCheat()).toBe("IDKFA");
  });

  it("recognizes IDCLIP", () => {
    for (const letter of "IDCLIP") kd(`Key${letter}`, letter.toLowerCase());
    expect(controller.consumeCheat()).toBe("IDCLIP");
  });

  it("consumeCheat() is edge-triggered — only returns non-null once per completed code", () => {
    for (const letter of "IDDQD") kd(`Key${letter}`, letter.toLowerCase());
    expect(controller.consumeCheat()).toBe("IDDQD");
    expect(controller.consumeCheat()).toBeNull();
  });

  it("swallows letters that keep extending a valid cheat prefix — they never reach movement state", () => {
    for (const letter of "IDDQD") kd(`Key${letter}`, letter.toLowerCase());
    // "D" (KeyD) is a movement key, but every D typed here was consumed as
    // part of the cheat sequence, never added to the held-keys set.
    expect(controller.isDown("KeyD")).toBe(false);
    expect(controller.isDown("KeyQ")).toBe(false);
  });

  it("resets and falls through to ordinary input once a letter breaks every prefix", () => {
    kd("KeyI", "i");
    kd("KeyD", "d"); // "ID" is a valid prefix of all three codes
    kd("KeyX", "x"); // "IDX" matches no cheat code -> buffer resets, X treated as ordinary input
    expect(controller.consumeCheat()).toBeNull();
    expect(controller.isDown("KeyX")).toBe(true);
  });

  it("ignores non-letter keys entirely for cheat-buffer purposes", () => {
    kd("Digit1", "1");
    expect(controller.consumeWeaponRequest()).toBe(0);
    expect(controller.consumeCheat()).toBeNull();
  });
});

describe("InputController weapon selection", () => {
  beforeEach(() => controller.attach());

  it("maps Digit1..Digit9 to 0-based weapon indices", () => {
    kd("Digit1", "1");
    expect(controller.consumeWeaponRequest()).toBe(0);
    kd("Digit9", "9");
    expect(controller.consumeWeaponRequest()).toBe(8);
  });

  it("maps Numpad1..Numpad9 the same way", () => {
    kd("Numpad5", "5");
    expect(controller.consumeWeaponRequest()).toBe(4);
  });

  it("consumeWeaponRequest() is edge-triggered", () => {
    kd("Digit2", "2");
    expect(controller.consumeWeaponRequest()).toBe(1);
    expect(controller.consumeWeaponRequest()).toBeNull();
  });

  it("ignores a non-digit key for weapon selection", () => {
    kd("KeyZ", "z");
    expect(controller.consumeWeaponRequest()).toBeNull();
  });
});

describe("InputController Tab (automap toggle)", () => {
  beforeEach(() => controller.attach());

  it("queues a map toggle on a non-repeat Tab press, and prevents default", () => {
    const e = new KeyboardEvent("keydown", { code: "Tab", key: "Tab", bubbles: true, cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(controller.consumeMapToggle()).toBe(true);
    expect(controller.consumeMapToggle()).toBe(false);
  });

  it("does not re-queue on OS auto-repeat", () => {
    kd("Tab", "Tab", { repeat: true });
    expect(controller.consumeMapToggle()).toBe(false);
  });
});

describe("InputController R (interact)", () => {
  beforeEach(() => controller.attach());

  it("queues an interact request on a non-repeat R press", () => {
    kd("KeyR", "r");
    expect(controller.consumeInteract()).toBe(true);
  });

  it("does not re-queue on auto-repeat", () => {
    kd("KeyR", "r", { repeat: true });
    expect(controller.consumeInteract()).toBe(false);
  });
});

describe("InputController Right-Ctrl (FPS overlay toggle)", () => {
  beforeEach(() => controller.attach());

  it("queues an FPS toggle on a non-repeat press", () => {
    kd("ControlRight", "Control");
    expect(controller.consumeFpsToggle()).toBe(true);
  });

  it("does not re-queue on auto-repeat", () => {
    kd("ControlRight", "Control", { repeat: true });
    expect(controller.consumeFpsToggle()).toBe(false);
  });
});

describe("InputController Space (quick-melee)", () => {
  beforeEach(() => controller.attach());

  it("queues melee and prevents default on a non-repeat press", () => {
    const e = new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(controller.consumeMelee()).toBe(true);
  });

  it("does not re-queue on auto-repeat", () => {
    kd("Space", " ");
    controller.consumeMelee();
    kd("Space", " ", { repeat: true });
    expect(controller.consumeMelee()).toBe(false);
  });

  it("isMeleeHeld() reflects whether Space is currently held", () => {
    kd("Space", " ");
    expect(controller.isMeleeHeld()).toBe(true);
    ku("Space", " ");
    expect(controller.isMeleeHeld()).toBe(false);
  });
});

describe("InputController Backquote (undocumented automation fire key)", () => {
  beforeEach(() => controller.attach());

  it("queues fire and reports isFireHeld() true while held", () => {
    kd("Backquote", "`");
    expect(controller.consumeFire()).toBe(true);
    expect(controller.isFireHeld()).toBe(true);
    ku("Backquote", "`");
    expect(controller.isFireHeld()).toBe(false);
  });

  it("does not re-queue consumeFire() on auto-repeat, but isFireHeld() stays true", () => {
    kd("Backquote", "`");
    controller.consumeFire();
    kd("Backquote", "`", { repeat: true });
    expect(controller.consumeFire()).toBe(false);
    expect(controller.isFireHeld()).toBe(true);
  });
});

describe("InputController F (fullscreen toggle)", () => {
  beforeEach(() => controller.attach());

  it("requests fullscreen when not currently fullscreen, and prevents default", () => {
    const e = new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true, cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(canvas.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(document.exitFullscreen).not.toHaveBeenCalled();
  });

  it("exits fullscreen when already fullscreen", () => {
    setFullscreenElement(canvas);
    kd("KeyF", "f");
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(canvas.requestFullscreen).not.toHaveBeenCalled();
  });

  it("does nothing on auto-repeat", () => {
    kd("KeyF", "f", { repeat: true });
    expect(canvas.requestFullscreen).not.toHaveBeenCalled();
    expect(document.exitFullscreen).not.toHaveBeenCalled();
  });
});

describe("InputController Escape (window-scoped pause toggle)", () => {
  beforeEach(() => controller.attach());

  it("queues escape on a non-repeat press", () => {
    windowEscape();
    expect(controller.consumeEscape()).toBe(true);
  });

  it("does not re-queue on auto-repeat", () => {
    windowEscape({ repeat: true });
    expect(controller.consumeEscape()).toBe(false);
  });
});

describe("InputController pointerlockchange", () => {
  beforeEach(() => controller.attach());

  it("queues a pointer-unlock signal when the lock is no longer held by this canvas", () => {
    setPointerLockElement(null);
    document.dispatchEvent(new Event("pointerlockchange"));
    expect(controller.consumePointerUnlock()).toBe(true);
  });

  it("does not queue when this canvas still holds the lock", () => {
    setPointerLockElement(canvas);
    document.dispatchEvent(new Event("pointerlockchange"));
    expect(controller.consumePointerUnlock()).toBe(false);
  });
});

describe("InputController blur", () => {
  beforeEach(() => controller.attach());

  it("window blur clears held keys, mouse-held, and queues a blur signal", () => {
    kd("KeyW", "w");
    window.dispatchEvent(new Event("blur"));
    expect(controller.isDown("KeyW")).toBe(false);
    expect(controller.consumeBlur()).toBe(true);
  });

  it("canvas blur (e.g. focus moved to a sidebar control) does the same", () => {
    kd("KeyA", "a");
    canvas.dispatchEvent(new Event("blur"));
    expect(controller.isDown("KeyA")).toBe(false);
    expect(controller.consumeBlur()).toBe(true);
  });
});

describe("InputController canvas click (pointer-lock request)", () => {
  beforeEach(() => controller.attach());

  it("queues a click, focuses the canvas, and requests pointer lock when unlocked", () => {
    const focusSpy = vi.spyOn(canvas, "focus");
    canvas.dispatchEvent(new Event("click"));
    expect(controller.consumeClick()).toBe(true);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
  });

  it("does not re-request pointer lock if this canvas already holds it", () => {
    setPointerLockElement(canvas);
    canvas.dispatchEvent(new Event("click"));
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
  });
});

describe("InputController mouse fire + look", () => {
  beforeEach(() => controller.attach());

  it("fires and holds the trigger on mousedown while pointer-locked", () => {
    setPointerLockElement(canvas);
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(controller.consumeFire()).toBe(true);
    expect(controller.isFireHeld()).toBe(true);
  });

  it("does nothing on mousedown while not pointer-locked", () => {
    setPointerLockElement(null);
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    expect(controller.consumeFire()).toBe(false);
    expect(controller.isFireHeld()).toBe(false);
  });

  it("releases the trigger on mouseup regardless of lock state", () => {
    setPointerLockElement(canvas);
    canvas.dispatchEvent(new MouseEvent("mousedown"));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(controller.isFireHeld()).toBe(false);
  });

  it("accumulates mouse movement into mouseDX while locked, and resets on consume", () => {
    setPointerLockElement(canvas);
    mousemove(5);
    mousemove(-2);
    expect(controller.consumeMouseDX()).toBe(3);
    expect(controller.consumeMouseDX()).toBe(0);
  });

  it("ignores mouse movement while not locked", () => {
    setPointerLockElement(null);
    mousemove(5);
    expect(controller.consumeMouseDX()).toBe(0);
  });
});

describe("InputController mouse wheel", () => {
  beforeEach(() => controller.attach());

  it("accumulates signed wheel steps and resets on consume", () => {
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
    expect(controller.consumeWheelSteps()).toBe(1); // +1 +1 -1
    expect(controller.consumeWheelSteps()).toBe(0);
  });
});

describe("InputController.pollGamepad()", () => {
  beforeEach(() => controller.attach());

  it("zeroes every gamepad reading when navigator.getGamepads is not a function", () => {
    (navigator as unknown as { getGamepads?: unknown }).getGamepads = undefined;
    controller.pollGamepad();
    expect(controller.gamepadForward()).toBeCloseTo(0);
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadTurn()).toBe(0);
    expect(controller.isFireHeld()).toBe(false);
    expect(controller.isMeleeHeld()).toBe(false);
  });

  it("zeroes every reading when no gamepad is connected", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [null, null];
    controller.pollGamepad();
    expect(controller.gamepadForward()).toBeCloseTo(0);
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadTurn()).toBe(0);
  });

  it("applies the deadzone to sub-threshold stick input but passes through a full deflection", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [
      fakeGamepad({ axes: [0.05, -0.05, 0.9] }),
    ];
    controller.pollGamepad();
    expect(controller.gamepadStrafe()).toBe(0); // below deadzone
    expect(controller.gamepadForward()).toBeCloseTo(0); // below deadzone
    expect(controller.gamepadTurn()).toBe(0.9); // passthrough unscaled
  });

  it("flips the raw Y axis so pushing the stick forward reads as positive gamepadForward()", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [
      fakeGamepad({ axes: [0, -0.8, 0] }),
    ];
    controller.pollGamepad();
    expect(controller.gamepadForward()).toBe(0.8);
  });

  it("falls back to 0 for missing axes entries", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [fakeGamepad({ axes: [] })];
    controller.pollGamepad();
    expect(controller.gamepadForward()).toBeCloseTo(0);
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadTurn()).toBe(0);
  });

  it("edge-triggers fire on RT press, holds while pressed, and doesn't re-queue while still held", () => {
    let pad = fakeGamepad({ buttons: [] });
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [pad];

    controller.pollGamepad(); // no button pressed yet
    expect(controller.consumeFire()).toBe(false);

    pad = fakeGamepad({ buttons: Array(8).fill({ pressed: false }).map((b, i) => (i === 7 ? { pressed: true } : b)) });
    controller.pollGamepad(); // rising edge
    expect(controller.consumeFire()).toBe(true);
    expect(controller.isFireHeld()).toBe(true);

    controller.pollGamepad(); // still held, same button state -> no re-trigger
    expect(controller.consumeFire()).toBe(false);
    expect(controller.isFireHeld()).toBe(true);

    pad = fakeGamepad({ buttons: [] }); // released
    controller.pollGamepad();
    expect(controller.isFireHeld()).toBe(false);
    expect(controller.consumeFire()).toBe(false); // release doesn't queue a fire
  });

  it("treats a missing RT/LB/RB/R3/B button entry as not pressed", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [
      fakeGamepad({ buttons: [{ pressed: false }] }), // way shorter than every button index this code reads
    ];
    expect(() => controller.pollGamepad()).not.toThrow();
    expect(controller.isFireHeld()).toBe(false);
    expect(controller.isMeleeHeld()).toBe(false);
  });

  it("edge-triggers a previous-weapon wheel step on LB press", () => {
    const buttons = (lbPressed: boolean) => {
      const arr = Array(8).fill({ pressed: false });
      arr[4] = { pressed: lbPressed };
      return arr;
    };
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [fakeGamepad({ buttons: buttons(true) })];
    controller.pollGamepad();
    expect(controller.consumeWheelSteps()).toBe(-1);
  });

  it("edge-triggers a next-weapon wheel step on RB press", () => {
    const buttons = (rbPressed: boolean) => {
      const arr = Array(8).fill({ pressed: false });
      arr[5] = { pressed: rbPressed };
      return arr;
    };
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [fakeGamepad({ buttons: buttons(true) })];
    controller.pollGamepad();
    expect(controller.consumeWheelSteps()).toBe(1);
  });

  it("edge-triggers melee on R3 press alone", () => {
    const arr = Array(12).fill({ pressed: false });
    arr[11] = { pressed: true };
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [fakeGamepad({ buttons: arr })];
    controller.pollGamepad();
    expect(controller.consumeMelee()).toBe(true);
    expect(controller.isMeleeHeld()).toBe(true);
  });

  it("edge-triggers melee on B press alone", () => {
    const arr = Array(12).fill({ pressed: false });
    arr[1] = { pressed: true };
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [fakeGamepad({ buttons: arr })];
    controller.pollGamepad();
    expect(controller.consumeMelee()).toBe(true);
    expect(controller.isMeleeHeld()).toBe(true);
  });
});

describe("InputController.captureSnapshot()", () => {
  beforeEach(() => controller.attach());

  it("only records keys from the game's recorded vocabulary, not every held key", () => {
    kd("KeyW", "w");
    kd("KeyR", "r"); // interact key, not part of RECORDED_KEYS
    const snap = controller.captureSnapshot();
    expect(snap.keys).toContain("KeyW");
    expect(snap.keys).not.toContain("KeyR");
  });

  it("is a non-destructive peek — a real consume*() call right after still sees the original value", () => {
    kd("Digit2", "2");
    const snap = controller.captureSnapshot();
    expect(snap.weaponRequest).toBe(1);
    expect(controller.consumeWeaponRequest()).toBe(1); // unaffected by the snapshot peek
  });

  it("reflects fireHeld/meleeHeld as the merged keyboard+gamepad state", () => {
    kd("Space", " ");
    const snap = controller.captureSnapshot();
    expect(snap.meleeHeld).toBe(true);
  });

  it("includes the current gamepad axis readings", () => {
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [
      fakeGamepad({ axes: [0.5, -0.5, 0.25] }),
    ];
    controller.pollGamepad();
    const snap = controller.captureSnapshot();
    expect(snap.gpStrafe).toBe(0.5);
    expect(snap.gpForward).toBe(0.5);
    expect(snap.gpTurn).toBe(0.25);
  });
});
