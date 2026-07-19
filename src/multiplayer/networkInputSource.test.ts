// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { InputSnapshot } from "../engine/input";
import { NetworkInputSource } from "./networkInputSource";

function snapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    keys: [],
    mouseDX: 0,
    fireQueued: false,
    fireHeld: false,
    weaponRequest: null,
    mapToggle: false,
    interact: false,
    melee: false,
    meleeHeld: false,
    wheelSteps: 0,
    fpsToggle: false,
    escape: false,
    blur: false,
    pointerUnlock: false,
    click: false,
    gpForward: 0,
    gpStrafe: 0,
    gpTurn: 0,
    ...overrides,
  };
}

describe("NetworkInputSource", () => {
  it("starts at the neutral/idle snapshot before any frame is loaded", () => {
    const input = new NetworkInputSource();
    expect(input.isDown("KeyW")).toBe(false);
    expect(input.consumeMouseDX()).toBe(0);
    expect(input.consumeFire()).toBe(false);
    expect(input.consumeWeaponRequest()).toBeNull();
  });

  it("reflects the loaded frame's state through every consume*/is* method", () => {
    const input = new NetworkInputSource();
    input.loadFrame(
      snapshot({
        keys: ["KeyW"],
        mouseDX: 5,
        fireQueued: true,
        fireHeld: true,
        weaponRequest: 2,
        mapToggle: true,
        interact: true,
        melee: true,
        meleeHeld: true,
        wheelSteps: 1,
        fpsToggle: true,
        escape: true,
        blur: true,
        pointerUnlock: true,
        click: true,
        gpForward: 0.5,
        gpStrafe: -0.5,
        gpTurn: 0.25,
      }),
    );
    expect(input.isDown("KeyW")).toBe(true);
    expect(input.isDown("KeyS")).toBe(false);
    expect(input.consumeMouseDX()).toBe(5);
    expect(input.consumeFire()).toBe(true);
    expect(input.isFireHeld()).toBe(true);
    expect(input.consumeWeaponRequest()).toBe(2);
    expect(input.consumeMapToggle()).toBe(true);
    expect(input.consumeInteract()).toBe(true);
    expect(input.consumeMelee()).toBe(true);
    expect(input.isMeleeHeld()).toBe(true);
    expect(input.consumeWheelSteps()).toBe(1);
    expect(input.consumeFpsToggle()).toBe(true);
    expect(input.consumeEscape()).toBe(true);
    expect(input.consumeBlur()).toBe(true);
    expect(input.consumePointerUnlock()).toBe(true);
    expect(input.consumeClick()).toBe(true);
    expect(input.gamepadForward()).toBe(0.5);
    expect(input.gamepadStrafe()).toBe(-0.5);
    expect(input.gamepadTurn()).toBe(0.25);
  });

  it("always returns null from consumeCheat(), regardless of loaded state", () => {
    const input = new NetworkInputSource();
    input.loadFrame(snapshot());
    expect(input.consumeCheat()).toBeNull();
  });

  it("attach() and pollGamepad() are no-ops", () => {
    const input = new NetworkInputSource();
    input.loadFrame(snapshot({ mouseDX: 3 }));
    expect(() => input.attach()).not.toThrow();
    expect(() => input.pollGamepad()).not.toThrow();
    expect(input.consumeMouseDX()).toBe(3); // unaffected
  });

  it("detach() resets to the neutral/idle snapshot", () => {
    const input = new NetworkInputSource();
    input.loadFrame(snapshot({ mouseDX: 3, fireQueued: true }));
    input.detach();
    expect(input.consumeMouseDX()).toBe(0);
    expect(input.consumeFire()).toBe(false);
  });

  it("captureSnapshot() returns the currently loaded snapshot", () => {
    const input = new NetworkInputSource();
    const s = snapshot({ mouseDX: 7 });
    input.loadFrame(s);
    expect(input.captureSnapshot()).toBe(s);
  });
});
