// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Feeds a `RaycasterEngine` player input received over the network — every
 * connected player's `PlayerState.input` in a multiplayer session is one of
 * these, local player included (see the netcode spec's input-delay-buffer
 * design: even the local peer's own input is sampled, delayed, and re-fed
 * back through the same finalized-bundle path everyone else's is, so no peer
 * gets a built-in latency advantage). Byte-for-byte the same shape as
 * `src/engine/replay.ts`'s `ReplayPlaybackInput` — both are `InputSource`
 * implementations driven entirely by discrete `loadFrame()` calls rather
 * than live polling, so the engine can't tell the difference. `EMPTY_SNAPSHOT`
 * is reused as-is from `replay.ts` rather than redeclared, per its own doc
 * comment naming this exact reuse case.
 */
import type { InputSnapshot, InputSource } from "../engine/input";
import { EMPTY_SNAPSHOT } from "../engine/replay";

export class NetworkInputSource implements InputSource {
  private current: InputSnapshot = EMPTY_SNAPSHOT;

  loadFrame(snapshot: InputSnapshot): void {
    this.current = snapshot;
  }

  attach(): void {
    // No real hardware to attach to — driven entirely by loadFrame().
  }

  detach(): void {
    this.current = EMPTY_SNAPSHOT;
  }

  pollGamepad(): void {
    // No-op: gamepad state for this tick is already baked into `current`.
  }

  isDown(code: string): boolean {
    return this.current.keys.includes(code);
  }

  consumeMouseDX(): number {
    return this.current.mouseDX;
  }

  consumeFire(): boolean {
    return this.current.fireQueued;
  }

  isFireHeld(): boolean {
    return this.current.fireHeld;
  }

  consumeWeaponRequest(): number | null {
    return this.current.weaponRequest;
  }

  consumeMapToggle(): boolean {
    return this.current.mapToggle;
  }

  consumeInteract(): boolean {
    return this.current.interact;
  }

  consumeMelee(): boolean {
    return this.current.melee;
  }

  isMeleeHeld(): boolean {
    return this.current.meleeHeld;
  }

  consumeWheelSteps(): number {
    return this.current.wheelSteps;
  }

  consumeFpsToggle(): boolean {
    return this.current.fpsToggle;
  }

  /** Permanent no-op — cheats have no `InputSnapshot` wire representation at
   * all, the same reasoning `ReplayPlaybackInput.consumeCheat()` documents:
   * there's nothing meaningful arriving over the network to reproduce. */
  consumeCheat(): string | null {
    return null;
  }

  consumeEscape(): boolean {
    return this.current.escape;
  }

  consumeBlur(): boolean {
    return this.current.blur;
  }

  consumePointerUnlock(): boolean {
    return this.current.pointerUnlock;
  }

  consumeClick(): boolean {
    return this.current.click;
  }

  gamepadForward(): number {
    return this.current.gpForward;
  }

  gamepadStrafe(): number {
    return this.current.gpStrafe;
  }

  gamepadTurn(): number {
    return this.current.gpTurn;
  }

  captureSnapshot(): InputSnapshot {
    return this.current;
  }
}
