// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Keyboard + mouse + gamepad input for the engine.
 *
 * Tracks held keys (polled each frame by the game loop) and accumulates
 * relative mouse motion while the canvas holds a pointer lock. Clicking the
 * canvas requests the lock; Esc releases it (handled by the browser).
 *
 * Gamepad support piggybacks on the same polled/edge-triggered shape as
 * keyboard input, via the HTML5 Gamepad API — which has no events for analog
 * axis/button *state* (only `gamepadconnected`/`disconnected`), so `pollGamepad`
 * must be called once per frame by the game loop (see `RaycasterEngine.advance`)
 * rather than driven by listeners like everything else here.
 */
/** Movement/strafe/rotation keys whose default browser behavior we suppress so
 * gameplay never fights the page. */
const MOVEMENT_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE"]);

/** Standard-mapping gamepad button indices used by this game (Xbox-style
 * layout; PlayStation pads report the same indices under the "standard"
 * mapping, just different physical labels — RT≈R2, LB/RB≈L1/R1, B≈Circle). */
const GAMEPAD_BUTTON_RT = 7;
const GAMEPAD_BUTTON_LB = 4;
const GAMEPAD_BUTTON_RB = 5;
const GAMEPAD_BUTTON_B = 1;
const GAMEPAD_BUTTON_R3 = 11;
/** Stick deflection below this magnitude reads as zero — cheap analog stick
 * drift is common enough that skipping this would cause a slow, uncommanded
 * drift/turn at rest. */
const GAMEPAD_DEADZONE = 0.18;

/** Classic Doom cheat codes this game recognizes — see `consumeCheat()`. */
const CHEAT_CODES = ["IDDQD", "IDKFA", "IDCLIP"] as const;
/** How many trailing letters `cheatBuffer` keeps — the longest code (6) plus
 * a little slack, so it never has to grow unbounded. */
const CHEAT_BUFFER_MAX = 10;

/**
 * The subset of `InputController`'s public API `RaycasterEngine` actually
 * consumes each frame. Exists so the engine can be driven by either a real
 * `InputController` (live play) or a `ReplayPlaybackInput` (see
 * `src/engine/replay.ts`) without knowing which — the replay system depends
 * on the engine treating both identically.
 */
export interface InputSource {
  attach(): void;
  detach(): void;
  pollGamepad(): void;
  isDown(code: string): boolean;
  consumeMouseDX(): number;
  consumeFire(): boolean;
  isFireHeld(): boolean;
  consumeWeaponRequest(): number | null;
  consumeMapToggle(): boolean;
  consumeInteract(): boolean;
  consumeMelee(): boolean;
  consumeWheelSteps(): number;
  consumeFpsToggle(): boolean;
  consumeCheat(): string | null;
  consumeEscape(): boolean;
  consumeBlur(): boolean;
  consumeClick(): boolean;
  gamepadForward(): number;
  gamepadStrafe(): number;
  gamepadTurn(): number;
  captureSnapshot(): InputSnapshot;
}

/**
 * A single frame's worth of digested input state — exactly what
 * `RaycasterEngine.advance()` reads from `InputSource` in one frame, captured
 * as a plain, JSON-serializable snapshot rather than raw DOM events. Recorded
 * once per frame by `ReplayRecorder` (via `InputController.captureSnapshot`,
 * a non-destructive peek — it doesn't clear any of the one-shot flags it
 * reads, so the real `consume*()` calls immediately afterward in the same
 * frame still behave exactly as they would unrecorded) and replayed frame-by-
 * frame by `ReplayPlaybackInput`.
 */
export interface InputSnapshot {
  /** Currently-held codes among the ones the engine ever queries via
   * `isDown()` (movement/turn/sprint) — see `RECORDED_KEYS`. */
  keys: string[];
  mouseDX: number;
  fireQueued: boolean;
  fireHeld: boolean;
  weaponRequest: number | null;
  mapToggle: boolean;
  interact: boolean;
  melee: boolean;
  wheelSteps: number;
  fpsToggle: boolean;
  escape: boolean;
  blur: boolean;
  click: boolean;
  gpForward: number;
  gpStrafe: number;
  gpTurn: number;
}

/** The only codes `RaycasterEngine` ever calls `isDown()` with — the complete
 * key vocabulary `captureSnapshot()` needs to record. */
const RECORDED_KEYS = ["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"];

export class InputController implements InputSource {
  private readonly keys = new Set<string>();
  /** Accumulated horizontal mouse delta since the last poll. */
  private mouseDX = 0;
  /** Edge-triggered fire request, set on click / Space press. */
  private fireQueued = false;
  /** Whether the mouse button is currently held down while pointer-locked —
   * unlike `fireQueued` (consumed once), this stays true for as long as the
   * trigger is held, for automatic weapons (the MP) to poll each frame. */
  private mouseHeld = false;
  /** Edge-triggered weapon selection (0-based index), or null. */
  private weaponRequest: number | null = null;
  /** Edge-triggered automap toggle, set on a Tab press. */
  private mapToggleQueued = false;
  /** Edge-triggered "interact" request, set on an R press (opens a fake wall /
   * reads a nearby lore terminal — see `RaycasterEngine`). Not bound to E,
   * despite that being the more common FPS convention, since E is already the
   * camera-turn-right key in this game's Q/E-turn scheme. */
  private interactQueued = false;
  /** Edge-triggered "quick-melee" request, set on a Left-Ctrl press — fires
   * the knife instantly, independent of whatever ranged weapon is equipped
   * (see `RaycasterEngine`). Left, not Right, so it doesn't collide with the
   * FPS-overlay toggle on `ControlRight`. */
  private meleeQueued = false;
  /** Accumulated mousewheel steps (one per tick, signed) since the last poll —
   * cycles the equipped ranged weapon. Accumulated rather than a single
   * boolean so a fast trackpad/wheel firing several `wheel` events between
   * polls doesn't silently drop ticks (same reasoning as `consumeMouseDX`). */
  private wheelSteps = 0;
  /** Edge-triggered FPS/frame-time overlay toggle, set on a Right-Ctrl press. */
  private fpsToggleQueued = false;
  /** Trailing uppercased letters typed so far, used to detect a classic Doom
   * cheat code (see `onKeyDown`) — reset the instant a code matches. Never
   * reset by a non-letter keypress (movement/digits/etc.), so typing WASD
   * between cheat letters — which happens naturally while moving — can't
   * break an in-progress sequence. */
  private cheatBuffer = "";
  /** Edge-triggered cheat activation, set the instant `cheatBuffer` ends with
   * one of `CHEAT_CODES` — the matched code itself (e.g. "IDDQD"), or null. */
  private cheatQueued: string | null = null;
  /** Edge-triggered pause toggle, set on an Escape press. */
  private escapeQueued = false;
  /** Edge-triggered "the window just lost focus" signal, set on blur. */
  private blurQueued = false;
  /** Edge-triggered "the canvas was clicked" signal — resumes from pause. */
  private clickQueued = false;
  private attached = false;

  /** Left stick X/Y and right stick X, deadzone-applied, refreshed once per
   * frame by `pollGamepad` — 0 whenever no gamepad is connected. */
  private gamepadMoveX = 0;
  private gamepadMoveY = 0;
  private gamepadTurnX = 0;
  /** Whether RT/R2 is currently held — merged into `isFireHeld()`. */
  private gamepadFireHeld = false;
  /** Previous-frame button states, so `pollGamepad` can edge-trigger the
   * one-shot actions (fire/cycle-weapon/melee) the same way key/mouse presses
   * do, instead of re-firing every frame a button stays held. */
  private prevGpFire = false;
  private prevGpLB = false;
  private prevGpRB = false;
  private prevGpMelee = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("click", this.onCanvasClick);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("mousemove", this.onMouseMove);
    // Bound to the canvas specifically (not window/document) so scrolling the
    // file-tree or console sidebar is never hijacked by a wheel over the game.
    this.canvas.addEventListener("wheel", this.onWheel, { passive: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("click", this.onCanvasClick);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("wheel", this.onWheel);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.keys.clear();
    this.mouseDX = 0;
    this.fireQueued = false;
    this.mouseHeld = false;
    this.weaponRequest = null;
    this.mapToggleQueued = false;
    this.interactQueued = false;
    this.meleeQueued = false;
    this.wheelSteps = 0;
    this.fpsToggleQueued = false;
    this.cheatBuffer = "";
    this.cheatQueued = null;
    this.escapeQueued = false;
    this.blurQueued = false;
    this.clickQueued = false;
    this.gamepadMoveX = 0;
    this.gamepadMoveY = 0;
    this.gamepadTurnX = 0;
    this.gamepadFireHeld = false;
    this.prevGpFire = false;
    this.prevGpLB = false;
    this.prevGpRB = false;
    this.prevGpMelee = false;
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

  /** Whether the trigger is currently held down (mouse button, while
   * pointer-locked, or Space, or a gamepad's RT/R2) — polled every frame by
   * automatic weapons, unlike `consumeFire()`'s one-shot-per-press semantics. */
  isFireHeld(): boolean {
    return this.mouseHeld || this.keys.has("Space") || this.gamepadFireHeld;
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

  /** Return true at most once per R press (opens a fake wall / reads a nearby
   * lore terminal). */
  consumeInteract(): boolean {
    const interacted = this.interactQueued;
    this.interactQueued = false;
    return interacted;
  }

  /** Return true at most once per Left-Ctrl press (fires a quick-melee attack). */
  consumeMelee(): boolean {
    const requested = this.meleeQueued;
    this.meleeQueued = false;
    return requested;
  }

  /** Return accumulated mousewheel steps (signed) since the last poll, and
   * reset it. Positive = scrolled down (next weapon), negative = up (previous). */
  consumeWheelSteps(): number {
    const steps = this.wheelSteps;
    this.wheelSteps = 0;
    return steps;
  }

  /** Return true at most once per Right-Ctrl press (toggles the FPS overlay). */
  consumeFpsToggle(): boolean {
    const toggled = this.fpsToggleQueued;
    this.fpsToggleQueued = false;
    return toggled;
  }

  /** Return the matched cheat code (e.g. "IDDQD") at most once per completed
   * sequence, or null if none has just fired — see `onKeyDown`. */
  consumeCheat(): string | null {
    const cheat = this.cheatQueued;
    this.cheatQueued = null;
    return cheat;
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

  /** Left stick, forward axis: -1..1, positive = pushed forward (up). Flips
   * the stick's raw Y (where up reports negative) to match `moveForward`'s
   * sign convention. 0 with no gamepad connected or the stick at rest. */
  gamepadForward(): number {
    return -this.gamepadMoveY;
  }

  /** Left stick, strafe axis: -1..1, positive = pushed right, matching
   * `strafe`'s sign convention. */
  gamepadStrafe(): number {
    return this.gamepadMoveX;
  }

  /** Right stick, turn axis: -1..1, positive = pushed right, matching
   * `Player.rotate`'s "positive = right" convention. */
  gamepadTurn(): number {
    return this.gamepadTurnX;
  }

  /**
   * Refresh gamepad axis/button state for this frame and edge-trigger its
   * one-shot actions (RT fire, bumpers cycle weapons, R3/B quick-melee) into
   * the same queues a key/mouse press would use. Must be called once per
   * frame by the game loop — see this class's doc comment for why (the
   * Gamepad API has no per-axis/button change events to listen for instead).
   * A no-op, and zeroes every analog reading, when no gamepad is connected.
   */
  pollGamepad(): void {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p): p is Gamepad => p !== null);
    if (!pad) {
      this.gamepadMoveX = 0;
      this.gamepadMoveY = 0;
      this.gamepadTurnX = 0;
      this.gamepadFireHeld = false;
      return;
    }

    this.gamepadMoveX = applyDeadzone(pad.axes[0] ?? 0);
    this.gamepadMoveY = applyDeadzone(pad.axes[1] ?? 0);
    this.gamepadTurnX = applyDeadzone(pad.axes[2] ?? 0);

    const fireDown = pad.buttons[GAMEPAD_BUTTON_RT]?.pressed ?? false;
    if (fireDown && !this.prevGpFire) this.fireQueued = true;
    this.gamepadFireHeld = fireDown;
    this.prevGpFire = fireDown;

    const lbDown = pad.buttons[GAMEPAD_BUTTON_LB]?.pressed ?? false;
    if (lbDown && !this.prevGpLB) this.wheelSteps -= 1; // previous weapon
    this.prevGpLB = lbDown;

    const rbDown = pad.buttons[GAMEPAD_BUTTON_RB]?.pressed ?? false;
    if (rbDown && !this.prevGpRB) this.wheelSteps += 1; // next weapon
    this.prevGpRB = rbDown;

    const meleeDown =
      (pad.buttons[GAMEPAD_BUTTON_R3]?.pressed ?? false) || (pad.buttons[GAMEPAD_BUTTON_B]?.pressed ?? false);
    if (meleeDown && !this.prevGpMelee) this.meleeQueued = true;
    this.prevGpMelee = meleeDown;
  }

  /**
   * A non-destructive peek at this frame's full digested input state — see
   * `InputSnapshot`'s doc comment for why this has to be read-only (the real
   * `consume*()` calls right after it in the same frame must see the exact
   * same values, unaffected by having been recorded). Called once per frame,
   * before any of those, by `ReplayRecorder` when one is active.
   */
  captureSnapshot(): InputSnapshot {
    return {
      keys: RECORDED_KEYS.filter((code) => this.keys.has(code)),
      mouseDX: this.mouseDX,
      fireQueued: this.fireQueued,
      fireHeld: this.isFireHeld(),
      weaponRequest: this.weaponRequest,
      mapToggle: this.mapToggleQueued,
      interact: this.interactQueued,
      melee: this.meleeQueued,
      wheelSteps: this.wheelSteps,
      fpsToggle: this.fpsToggleQueued,
      escape: this.escapeQueued,
      blur: this.blurQueued,
      click: this.clickQueued,
      gpForward: this.gamepadForward(),
      gpStrafe: this.gamepadStrafe(),
      gpTurn: this.gamepadTurn(),
    };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Space fires once per physical press (ignore OS auto-repeat).
    if (e.code === "Space") {
      if (!e.repeat) this.fireQueued = true;
      e.preventDefault();
    }
    // Number keys select a weapon slot (Digit1/Numpad1 -> 0, Digit2/Numpad2 -> 1,
    // …) — RaycasterEngine maps the slot to an actual WEAPONS index (see
    // NUMBER_KEY_WEAPONS in weapons.ts), so this is a slot number, not a raw
    // WEAPONS array index.
    const digit = digitKeyIndex(e.code);
    if (digit !== null) this.weaponRequest = digit;

    // Tab toggles the automap; prevent the browser from shifting focus away.
    if (e.code === "Tab") {
      if (!e.repeat) this.mapToggleQueued = true;
      e.preventDefault();
    }

    // R interacts with a fake wall or lore terminal directly ahead/nearby.
    if (e.code === "KeyR" && !e.repeat) this.interactQueued = true;

    // Left-Ctrl fires a quick-melee attack; Right-Ctrl toggles the FPS
    // overlay — deliberately separate keys so a "quick" one-handed melee
    // never fights a debug-display toggle.
    if (e.code === "ControlLeft" && !e.repeat) this.meleeQueued = true;
    if (e.code === "ControlRight" && !e.repeat) this.fpsToggleQueued = true;

    // Escape toggles the engine's own pause overlay. Deliberately not
    // preventDefault()'d — the browser also uses Escape to drop pointer lock
    // and exit fullscreen natively, and both should still happen.
    if (e.code === "Escape" && !e.repeat) this.escapeQueued = true;

    // F toggles fullscreen on the canvas itself — nothing else (no control
    // hints, no HUD overlay DOM, no sidebar). requestFullscreen()/
    // exitFullscreen() must be called synchronously from a real user-gesture
    // handler — not deferred to a later polled flag consumed inside the
    // rAF-driven game loop, which browsers reject — so this happens directly
    // here, the same way `onCanvasClick` requests the pointer lock directly.
    // This only stays correct across level transitions because `main.ts`
    // keeps one `<canvas>` alive for the whole session and reuses it for
    // every level, rather than creating a new one each time — removing the
    // *current* fullscreen element from the document makes the browser
    // auto-exit fullscreen, which a fresh canvas per level used to trigger.
    if (e.code === "KeyF" && !e.repeat) {
      e.preventDefault();
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void this.canvas.requestFullscreen();
      }
    }

    // Classic Doom cheat codes: buffer trailing letters and check for a
    // match on every keystroke. Deliberately independent of every branch
    // above (and never `preventDefault()`'d) — a cheat is spelled out using
    // ordinary gameplay keys (several of which double as real bindings, like
    // Q/E/F/R above), so this only ever *observes* the letter, it never
    // consumes or blocks it.
    if (/^[a-zA-Z]$/.test(e.key)) {
      this.cheatBuffer = (this.cheatBuffer + e.key.toUpperCase()).slice(-CHEAT_BUFFER_MAX);
      const matched = CHEAT_CODES.find((code) => this.cheatBuffer.endsWith(code));
      if (matched) {
        this.cheatQueued = matched;
        this.cheatBuffer = "";
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
    this.mouseHeld = false;
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
      this.mouseHeld = true;
    }
  };

  private readonly onMouseUp = (): void => {
    this.mouseHeld = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === this.canvas) {
      this.mouseDX += e.movementX;
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.wheelSteps += Math.sign(e.deltaY);
  };
}

/** Map Digit1..9 / Numpad1..9 to a 0-based weapon index, else null. */
function digitKeyIndex(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match ? Number(match[1]) - 1 : null;
}

/** Zero out sub-deadzone stick noise/drift; passes through everything else
 * unscaled (a full deflection still reads as exactly ±1). */
function applyDeadzone(value: number): number {
  return Math.abs(value) < GAMEPAD_DEADZONE ? 0 : value;
}
