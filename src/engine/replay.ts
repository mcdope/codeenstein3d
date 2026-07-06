// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Deterministic replay: recording one level's worth of input during a real
 * run, and playing it back later against a freshly-regenerated copy of the
 * same map. This only works because every simulation-relevant random draw
 * (map layout, enemy AI timing/roam targets, loot rolls, weapon spread) goes
 * through a seeded PRNG rather than `Math.random()` — see `src/prng.ts`'s doc
 * comment for the full seeded/cosmetic split this depends on.
 *
 * Scope, deliberately: a replay covers *one level* — the one active when a
 * run actually ends (death, or finishing the whole campaign) — not an entire
 * multi-level campaign leading up to it. Recording restarts fresh on every
 * level load (see `main.ts`'s `launchLevel`); whichever level's recording is
 * live when the run ends is the one attached to the highscore entry. This is
 * an R&D feature, not a full campaign-replay system — replaying a multi-level
 * run would mean recording/replaying every map transition and its carried-over
 * state too, which is a lot more machinery for a feature nobody has asked to
 * rely on yet.
 */
import type { DifficultyLevel } from "../difficulty";
import type { EngineCarryover } from "./engine";
import type { GoreLevel } from "./effects";
import type { InputSnapshot, InputSource } from "./input";

/** One recorded simulation step: the delta time `RaycasterEngine.advance()`
 * was called with, and the full digested input state for that frame. */
export interface ReplayFrame {
  dt: number;
  input: InputSnapshot;
}

/** Everything needed to reproduce one level's run exactly. */
export interface ReplayPayload {
  /** Bumped if this shape ever changes, so a future version can refuse to
   * play back an older (or newer) payload it can't interpret correctly
   * rather than silently misbehaving. */
  version: 1;
  /** Seeds `RaycasterEngine`'s own `rng` (loot rolls, enemy AI timing/roam
   * targets, weapon spread) — NOT the map layout, which is deterministic from
   * the parsed AST alone and needs no separate seed (see `mapGenerator.ts`). */
  gameplaySeed: number;
  /** SHA-256 hex digest of the parsed AST JSON + campaign name (see
   * `highscores.ts`'s `hashRun`) — lets "Watch Replay" verify a re-parsed file
   * is really the same source before trusting it to regenerate the map. */
  astHash: string;
  /** Workspace-relative path of the file this level was generated from —
   * needed to relocate it in a freshly re-picked workspace (same idea as
   * `CampaignSave.filePath` in `main.ts`). */
  filePath: string;
  campaignName: string;
  bonusLevel: boolean;
  difficulty: DifficultyLevel;
  gore: GoreLevel;
  /** Health/armor/ammo/weapons this level started with, if it wasn't the
   * first level of the run (undefined for a fresh campaign start). */
  carryover?: EngineCarryover;
  frames: ReplayFrame[];
}

/** Hard cap on recorded frames — bounds a replay's worst-case size in
 * `localStorage` (each frame is a small JSON object; a very long, slow-played
 * level could otherwise grow unbounded). ~6 minutes at 60fps, generous for a
 * normal level. A run that exceeds it simply doesn't get a replay attached —
 * see `finish()` — rather than saving a silently-truncated one. */
const MAX_REPLAY_FRAMES = 21600;

/** Static metadata a `ReplayRecorder` needs, known up front at level launch —
 * everything in `ReplayPayload` except `version`, `frames`, and `astHash`.
 * `astHash` is deliberately excluded: it's only known once `hashRun` resolves
 * at run-end time (see `main.ts`'s `recordRunHighscore`, which already
 * computes exactly this hash for the `HighscoreEntry` itself), so `finish()`
 * takes it as a parameter instead of duplicating that hash computation here. */
export type ReplayMeta = Omit<ReplayPayload, "version" | "frames" | "astHash">;

/**
 * Records one level's input, one frame at a time, and produces a finished
 * `ReplayPayload` once the run ends. `RaycasterEngine` calls `record()` once
 * per `advance()` step when one of these is attached (see its constructor).
 */
export class ReplayRecorder {
  private readonly frames: ReplayFrame[] = [];
  private overflowed = false;

  constructor(private readonly meta: ReplayMeta) {}

  record(dt: number, input: InputSnapshot): void {
    if (this.overflowed) return;
    if (this.frames.length >= MAX_REPLAY_FRAMES) {
      this.overflowed = true;
      console.warn(
        `%c[replay] recording exceeded ${MAX_REPLAY_FRAMES} frames — this run's replay won't be saved`,
        "color:#e0a04a",
      );
      return;
    }
    this.frames.push({ dt, input });
  }

  /** The finished payload, or `null` if recording never captured a single
   * frame or overflowed the cap above — either way, nothing worth saving. */
  finish(astHash: string): ReplayPayload | null {
    if (this.overflowed || this.frames.length === 0) return null;
    return { version: 1, astHash, ...this.meta, frames: this.frames };
  }
}

/** An `InputSnapshot` with every field at its neutral/idle value — the
 * `ReplayPlaybackInput`'s state before its first frame is loaded. */
const EMPTY_SNAPSHOT: InputSnapshot = {
  keys: [],
  mouseDX: 0,
  fireQueued: false,
  fireHeld: false,
  weaponRequest: null,
  mapToggle: false,
  interact: false,
  melee: false,
  wheelSteps: 0,
  fpsToggle: false,
  escape: false,
  blur: false,
  click: false,
  gpForward: 0,
  gpStrafe: 0,
  gpTurn: 0,
};

/**
 * Feeds a `RaycasterEngine` recorded input instead of live keyboard/mouse/
 * gamepad state — implements the exact same `InputSource` shape a real
 * `InputController` does, so the engine can't tell the difference. The
 * playback driver (see `main.ts`) calls `loadFrame()` with the next recorded
 * frame's `input` immediately before each `engine.advance(frame.dt)` call,
 * mirroring how `ReplayRecorder.record()` captured it in the first place —
 * once per frame, before any of that frame's `consume*()` calls read it.
 */
export class ReplayPlaybackInput implements InputSource {
  private current: InputSnapshot = EMPTY_SNAPSHOT;

  loadFrame(snapshot: InputSnapshot): void {
    this.current = snapshot;
  }

  attach(): void {
    // No real hardware to attach to — playback is driven entirely by
    // `loadFrame()`.
  }

  detach(): void {
    this.current = EMPTY_SNAPSHOT;
  }

  pollGamepad(): void {
    // No-op: gamepad state for this frame is already baked into `current`.
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

  consumeWheelSteps(): number {
    return this.current.wheelSteps;
  }

  consumeFpsToggle(): boolean {
    return this.current.fpsToggle;
  }

  consumeEscape(): boolean {
    return this.current.escape;
  }

  consumeBlur(): boolean {
    return this.current.blur;
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
