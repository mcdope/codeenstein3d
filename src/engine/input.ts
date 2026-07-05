// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Keyboard + mouse input for the engine.
 *
 * Tracks held keys (polled each frame by the game loop) and accumulates
 * relative mouse motion while the canvas holds a pointer lock. Clicking the
 * canvas requests the lock; Esc releases it (handled by the browser).
 */
/** Movement/strafe/rotation keys whose default browser behavior we suppress so
 * gameplay never fights the page. */
const MOVEMENT_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE"]);

export class InputController {
  private readonly keys = new Set<string>();
  /** Accumulated horizontal mouse delta since the last poll. */
  private mouseDX = 0;
  /** Edge-triggered fire request, set on click / Space press. */
  private fireQueued = false;
  /** Edge-triggered weapon selection (0-based index), or null. */
  private weaponRequest: number | null = null;
  /** Edge-triggered automap toggle, set on a Tab press. */
  private mapToggleQueued = false;
  /** Edge-triggered pause toggle, set on an Escape press. */
  private escapeQueued = false;
  /** Edge-triggered "the window just lost focus" signal, set on blur. */
  private blurQueued = false;
  /** Edge-triggered "the canvas was clicked" signal — resumes from pause. */
  private clickQueued = false;
  private attached = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("click", this.onCanvasClick);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mousemove", this.onMouseMove);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("click", this.onCanvasClick);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mousemove", this.onMouseMove);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (document.fullscreenElement === this.canvas) void document.exitFullscreen();
    this.keys.clear();
    this.mouseDX = 0;
    this.fireQueued = false;
    this.weaponRequest = null;
    this.mapToggleQueued = false;
    this.escapeQueued = false;
    this.blurQueued = false;
    this.clickQueued = false;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Return accumulated mouse-x since last call and reset it. */
  consumeMouseDX(): number {
    const dx = this.mouseDX;
    this.mouseDX = 0;
    return dx;
  }

  /** Return true at most once per fire trigger (click / Space press). */
  consumeFire(): boolean {
    const fired = this.fireQueued;
    this.fireQueued = false;
    return fired;
  }

  /** Return a requested weapon index (once) from a number-key press, or null. */
  consumeWeaponRequest(): number | null {
    const req = this.weaponRequest;
    this.weaponRequest = null;
    return req;
  }

  /** Return true at most once per Tab press (toggles the automap). */
  consumeMapToggle(): boolean {
    const toggled = this.mapToggleQueued;
    this.mapToggleQueued = false;
    return toggled;
  }

  /** Return true at most once per Escape press (toggles the pause overlay). */
  consumeEscape(): boolean {
    const pressed = this.escapeQueued;
    this.escapeQueued = false;
    return pressed;
  }

  /** Return true at most once per time the window lost focus (forces a pause,
   * rather than toggling — losing focus should never accidentally resume). */
  consumeBlur(): boolean {
    const blurred = this.blurQueued;
    this.blurQueued = false;
    return blurred;
  }

  /** Return true at most once per canvas click (resumes from pause). */
  consumeClick(): boolean {
    const clicked = this.clickQueued;
    this.clickQueued = false;
    return clicked;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Space fires once per physical press (ignore OS auto-repeat).
    if (e.code === "Space") {
      if (!e.repeat) this.fireQueued = true;
      e.preventDefault();
    }
    // Number keys select a weapon (Digit1/Numpad1 -> 0, Digit2/Numpad2 -> 1, …).
    const digit = digitKeyIndex(e.code);
    if (digit !== null) this.weaponRequest = digit;

    // Tab toggles the automap; prevent the browser from shifting focus away.
    if (e.code === "Tab") {
      if (!e.repeat) this.mapToggleQueued = true;
      e.preventDefault();
    }

    // Escape toggles the engine's own pause overlay. Deliberately not
    // preventDefault()'d — the browser also uses Escape to drop pointer lock
    // and exit fullscreen natively, and both should still happen.
    if (e.code === "Escape" && !e.repeat) this.escapeQueued = true;

    // F toggles fullscreen. requestFullscreen()/exitFullscreen() must be
    // called synchronously from a real user-gesture handler — not deferred
    // to a later polled flag consumed inside the rAF-driven game loop, which
    // browsers reject — so this happens directly here, the same way
    // `onCanvasClick` requests the pointer lock directly.
    if (e.code === "KeyF" && !e.repeat) {
      e.preventDefault();
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void this.canvas.requestFullscreen();
      }
    }

    this.keys.add(e.code);
    if (MOVEMENT_KEYS.has(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  // Dropping focus (alt-tab, etc.) should release all keys to avoid "stuck"
  // input, and forces the engine into its paused state.
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.blurQueued = true;
  };

  private readonly onCanvasClick = (): void => {
    this.clickQueued = true;
    if (document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock();
    }
  };

  // Fire only when the pointer is already locked; the first click just captures
  // the mouse (so aiming to lock doesn't waste a shot).
  private readonly onMouseDown = (): void => {
    if (document.pointerLockElement === this.canvas) {
      this.fireQueued = true;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === this.canvas) {
      this.mouseDX += e.movementX;
    }
  };
}

/** Map Digit1..9 / Numpad1..9 to a 0-based weapon index, else null. */
function digitKeyIndex(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match ? Number(match[1]) - 1 : null;
}
