// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import type { InputSnapshot, InputSource } from "../engine/input";
import { LocalInputSampler } from "./localInputSampler";

/** A hand-scripted `InputSource` test double — flip fields directly between
 * calls, same shape as `engine.test.ts`'s own `ScriptedInput` (not shared/
 * exported anywhere, matching this project's per-file-fixture convention). */
class ScriptedInput implements InputSource {
  keys = new Set<string>();
  mouseDX = 0;
  fireQueued = false;
  fireHeld = false;
  weaponRequest: number | null = null;
  mapToggle = false;
  interact = false;
  melee = false;
  meleeHeld = false;
  wheelSteps = 0;
  fpsToggle = false;
  cheat: string | null = null;
  escape = false;
  blur = false;
  pointerUnlock = false;
  click = false;
  gpForward = 0;
  gpStrafe = 0;
  gpTurn = 0;

  attach = vi.fn();
  detach = vi.fn();
  pollGamepad = vi.fn();

  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  consumeMouseDX(): number {
    const v = this.mouseDX;
    this.mouseDX = 0;
    return v;
  }
  consumeFire(): boolean {
    const v = this.fireQueued;
    this.fireQueued = false;
    return v;
  }
  isFireHeld(): boolean {
    return this.fireHeld;
  }
  consumeWeaponRequest(): number | null {
    const v = this.weaponRequest;
    this.weaponRequest = null;
    return v;
  }
  consumeMapToggle(): boolean {
    const v = this.mapToggle;
    this.mapToggle = false;
    return v;
  }
  consumeInteract(): boolean {
    const v = this.interact;
    this.interact = false;
    return v;
  }
  consumeMelee(): boolean {
    const v = this.melee;
    this.melee = false;
    return v;
  }
  isMeleeHeld(): boolean {
    return this.meleeHeld;
  }
  consumeWheelSteps(): number {
    const v = this.wheelSteps;
    this.wheelSteps = 0;
    return v;
  }
  consumeFpsToggle(): boolean {
    const v = this.fpsToggle;
    this.fpsToggle = false;
    return v;
  }
  consumeCheat(): string | null {
    const v = this.cheat;
    this.cheat = null;
    return v;
  }
  consumeEscape(): boolean {
    const v = this.escape;
    this.escape = false;
    return v;
  }
  consumeBlur(): boolean {
    const v = this.blur;
    this.blur = false;
    return v;
  }
  consumePointerUnlock(): boolean {
    const v = this.pointerUnlock;
    this.pointerUnlock = false;
    return v;
  }
  consumeClick(): boolean {
    const v = this.click;
    this.click = false;
    return v;
  }
  gamepadForward(): number {
    return this.gpForward;
  }
  gamepadStrafe(): number {
    return this.gpStrafe;
  }
  gamepadTurn(): number {
    return this.gpTurn;
  }
  captureSnapshot(): InputSnapshot {
    return {
      keys: [...this.keys],
      mouseDX: this.mouseDX,
      fireQueued: this.fireQueued,
      fireHeld: this.fireHeld,
      weaponRequest: this.weaponRequest,
      mapToggle: this.mapToggle,
      interact: this.interact,
      melee: this.melee,
      meleeHeld: this.meleeHeld,
      wheelSteps: this.wheelSteps,
      fpsToggle: this.fpsToggle,
      escape: this.escape,
      blur: this.blur,
      pointerUnlock: this.pointerUnlock,
      click: this.click,
      gpForward: this.gpForward,
      gpStrafe: this.gpStrafe,
      gpTurn: this.gpTurn,
    };
  }
}

describe("LocalInputSampler", () => {
  it("attach()/detach() delegate to the wrapped controller", () => {
    const controller = new ScriptedInput();
    const sampler = new LocalInputSampler(controller);
    sampler.attach();
    sampler.detach();
    expect(controller.attach).toHaveBeenCalledTimes(1);
    expect(controller.detach).toHaveBeenCalledTimes(1);
  });

  it("sampleAndReset() returns the current snapshot's values", () => {
    const controller = new ScriptedInput();
    controller.keys.add("KeyW");
    controller.fireQueued = true;
    controller.mouseDX = 5;
    const sampler = new LocalInputSampler(controller);
    const { snapshot } = sampler.sampleAndReset();
    expect(snapshot.keys).toEqual(["KeyW"]);
    expect(snapshot.fireQueued).toBe(true);
    expect(snapshot.mouseDX).toBe(5);
  });

  it("drains one-shot flags so a second sample doesn't see stale state", () => {
    const controller = new ScriptedInput();
    controller.fireQueued = true;
    controller.mouseDX = 5;
    controller.wheelSteps = 2;
    controller.interact = true;
    const sampler = new LocalInputSampler(controller);
    sampler.sampleAndReset();

    const { snapshot: second } = sampler.sampleAndReset();
    expect(second.fireQueued).toBe(false);
    expect(second.mouseDX).toBe(0);
    expect(second.wheelSteps).toBe(0);
    expect(second.interact).toBe(false);
  });

  it("forces escape/blur/pointerUnlock/click to false even when the controller reports them true", () => {
    const controller = new ScriptedInput();
    controller.escape = true;
    controller.blur = true;
    controller.pointerUnlock = true;
    controller.click = true;
    const sampler = new LocalInputSampler(controller);
    const { snapshot } = sampler.sampleAndReset();
    expect(snapshot.escape).toBe(false);
    expect(snapshot.blur).toBe(false);
    expect(snapshot.pointerUnlock).toBe(false);
    expect(snapshot.click).toBe(false);
  });

  it("still drains the real escape/blur/pointerUnlock/click flags off the controller (not just masking the returned snapshot)", () => {
    const controller = new ScriptedInput();
    controller.escape = true;
    controller.blur = true;
    controller.pointerUnlock = true;
    controller.click = true;
    const sampler = new LocalInputSampler(controller);
    sampler.sampleAndReset();
    expect(controller.escape).toBe(false);
    expect(controller.blur).toBe(false);
    expect(controller.pointerUnlock).toBe(false);
    expect(controller.click).toBe(false);
  });

  it("does not drain interact — it must stay part of the shared stream", () => {
    const controller = new ScriptedInput();
    controller.interact = true;
    const sampler = new LocalInputSampler(controller);
    const { snapshot } = sampler.sampleAndReset();
    expect(snapshot.interact).toBe(true);
  });

  it("returns localEscapePressed as the real, undrained escape value — true when pressed, false otherwise", () => {
    const controller = new ScriptedInput();
    controller.escape = true;
    const sampler = new LocalInputSampler(controller);
    expect(sampler.sampleAndReset().localEscapePressed).toBe(true);
    expect(sampler.sampleAndReset().localEscapePressed).toBe(false); // already drained
  });

  it("never calls consumeCheat() on the wrapped controller", () => {
    const controller = new ScriptedInput();
    const consumeCheatSpy = vi.spyOn(controller, "consumeCheat");
    const sampler = new LocalInputSampler(controller);
    sampler.sampleAndReset();
    expect(consumeCheatSpy).not.toHaveBeenCalled();
  });
});
