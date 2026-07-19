// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wraps a real, canvas-attached `InputController` purely for *sampling* —
 * this controller is never wired as any `PlayerState.input` in a multiplayer
 * session (every player's engine-facing input is a `NetworkInputSource`,
 * local player included, per the input-delay-buffer design). Since nothing
 * else ever calls this controller's own `consume*()` methods, one-shot flags
 * (`fireQueued`, `mouseDX`, `wheelSteps`, …) would otherwise never clear —
 * `sampleAndReset()` makes the "peek, then drain" pairing
 * `InputController.captureSnapshot()`'s own doc comment already documents
 * (normally done implicitly by `simulate()`) an explicit, manual step here
 * instead.
 */
import type { InputSnapshot, InputSource } from "../engine/input";

export class LocalInputSampler {
  /** Typed against the `InputSource` interface, not the concrete
   * `InputController` class — everything this wrapper calls is part of that
   * interface, and a plain interface dependency is both more correct and
   * more testable than depending on the concrete class. In real use, the
   * caller always passes a real, canvas-attached `InputController`. */
  constructor(private readonly controller: InputSource) {}

  attach(): void {
    this.controller.attach();
  }

  detach(): void {
    this.controller.detach();
  }

  /**
   * Captures this tick's input and drains every one-shot flag so it doesn't
   * leak into the next sample — then forces `escape`/`blur`/`pointerUnlock`/
   * `click` to their neutral values before returning, per
   * `multiplayer-netcode-spec.md` §6: those four fields must never reach the
   * shared stream (locally applied or sent), or a pause/blur/pointer-unlock
   * on just one peer would freeze only *that* peer's simulation — each peer
   * runs its own independent `RaycasterEngine`, so that's an instant desync,
   * not a shared pause. `interact` deliberately is **not** stripped here —
   * it must stay shared (it also drives secret-wall discovery); the
   * lore-terminal-freeze half of this same problem is fixed instead where it
   * actually happens, inside `RaycasterEngine.simulate()`.
   *
   * `localEscapePressed` is `escape`'s real, undrained value — captured
   * before the field is zeroed on the returned `snapshot`, not discarded:
   * the session driver uses it to call `RaycasterEngine.dismissLoreOverlay()`
   * directly, a genuinely local-only action with no shared-simulation
   * channel to carry it (see that method's own doc comment). Every other
   * neutralized field has no such local-only use, so only this one is
   * surfaced.
   *
   * Cheats need no equivalent handling: `consumeCheat()` is never called
   * here (nothing ever needs it — `InputSnapshot` has no cheat field at
   * all), so a typed cheat code just sits queued on this controller forever,
   * unread. That's an accurate side effect of this design, not a deliberate
   * step-8 "cheats disabled" mechanism to rely on elsewhere.
   */
  sampleAndReset(): { snapshot: InputSnapshot; localEscapePressed: boolean } {
    const snapshot = this.controller.captureSnapshot();
    this.controller.consumeFire();
    this.controller.consumeMouseDX();
    this.controller.consumeWeaponRequest();
    this.controller.consumeMapToggle();
    this.controller.consumeInteract();
    this.controller.consumeMelee();
    this.controller.consumeWheelSteps();
    this.controller.consumeFpsToggle();
    const localEscapePressed = this.controller.consumeEscape();
    this.controller.consumeBlur();
    this.controller.consumePointerUnlock();
    this.controller.consumeClick();
    snapshot.escape = false;
    snapshot.blur = false;
    snapshot.pointerUnlock = false;
    snapshot.click = false;
    return { snapshot, localEscapePressed };
  }
}
