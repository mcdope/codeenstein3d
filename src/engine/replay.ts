// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Deterministic replay: recording every level's worth of input during a real
 * run, and playing the whole campaign back later against freshly-regenerated
 * copies of the same maps. This only works because every simulation-relevant
 * random draw (map layout, enemy AI timing/roam targets, loot rolls, weapon
 * spread) goes through a seeded PRNG rather than `Math.random()` — see
 * `src/prng.ts`'s doc comment for the full seeded/cosmetic split this depends
 * on.
 *
 * A replay is a sequence of per-level `ReplayLevelSegment`s, one per level
 * actually played this run (see `CampaignReplayRecorder`). "Watch Replay"
 * walks the sequence in order, re-locating/re-verifying/regenerating each
 * level in turn and carrying the recorded `carryover` forward between them —
 * the same shape `main.ts`'s own `advanceToNextLevel` already uses for live
 * play, just driven from recorded data instead. Still an R&D feature: a
 * replay recorded before this was campaign-scoped (`version: 1`, a single
 * level) is intentionally left unsupported — see `HighscoreEntry.replay`'s
 * doc comment.
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
export interface ReplayLevelSegment {
  /** Workspace-relative path of the file this level was generated from —
   * needed to relocate it in a freshly re-picked workspace (same idea as
   * `CampaignSave.filePath` in `main.ts`). */
  filePath: string;
  bonusLevel: boolean;
  /** Seeds `RaycasterEngine`'s own `rng` (loot rolls, enemy AI timing/roam
   * targets, weapon spread) — NOT the map layout, which is deterministic from
   * the parsed AST alone and needs no separate seed (see `mapGenerator.ts`). */
  gameplaySeed: number;
  /** SHA-256 hex digest of this level's parsed AST JSON + campaign name (see
   * `highscores.ts`'s `hashRun`) — lets "Watch Replay" verify a re-parsed file
   * is really the same source before trusting it to regenerate the map.
   * Recorded per-level (not once for the whole payload) since a campaign
   * spans a different source file, and potentially a since-edited one, at
   * every step. */
  astHash: string;
  /** Whichever difficulty/gore preference was active while *this* level was
   * played — either can be changed mid-campaign (they take effect "on the
   * next level load"), so a single run can genuinely span more than one of
   * each. */
  difficulty: DifficultyLevel;
  gore: GoreLevel;
  /** Health/armor/ammo/weapons this level started with — undefined only for
   * a fresh campaign's very first level. */
  carryover?: EngineCarryover;
  frames: ReplayFrame[];
}

/** Everything needed to reproduce an entire run, level by level. */
export interface ReplayPayload {
  /** Bumped if this shape ever changes, so a future version can refuse to
   * play back an older (or newer) payload it can't interpret correctly
   * rather than silently misbehaving. `1` was a single-level-only shape and
   * is deliberately left unsupported — see `HighscoreEntry.replay`'s doc
   * comment. */
  version: 2;
  campaignName: string;
  /** One entry per level actually played this run, spawn to the one the run
   * ended on, in order. */
  levels: ReplayLevelSegment[];
}

/** Hard cap on recorded frames *per level* — bounds a replay's worst-case
 * size in `localStorage` (each frame is a small JSON object; a very long,
 * slow-played level could otherwise grow unbounded). ~6 minutes at 60fps,
 * generous for a normal level. A level that exceeds it simply doesn't get a
 * segment recorded for it — see `LevelRecorder.finish` — which in turn means
 * the whole run's replay is dropped (a replay with a hole in the middle of
 * its campaign isn't watchable), same as if recording had never started. */
const MAX_REPLAY_FRAMES_PER_LEVEL = 21600;

/** Hard cap on how many levels a single replay can span — bounds worst-case
 * total size for an extremely long multi-level campaign run. A run beyond
 * this simply stops recording further levels (whatever was captured up to
 * the cap is still saved and watchable, just not the tail end of the run). */
const MAX_REPLAY_LEVELS = 100;

/** Static metadata a `LevelRecorder` needs, known up front at level launch —
 * everything in `ReplayLevelSegment` except `astHash` and `frames`. `astHash`
 * is deliberately excluded: it's only known once `hashRun` resolves, so the
 * recorder takes a `Promise<string>` instead of blocking level launch on it. */
export type ReplayLevelMeta = Omit<ReplayLevelSegment, "astHash" | "frames">;

/** Records one level's input, one frame at a time. Internal to
 * `CampaignReplayRecorder` — see that class for the public recording API. */
class LevelRecorder {
  private readonly frames: ReplayFrame[] = [];
  private overflowed = false;

  constructor(
    private readonly meta: ReplayLevelMeta,
    private readonly astHashPromise: Promise<string>,
  ) {}

  record(dt: number, input: InputSnapshot): void {
    if (this.overflowed) return;
    if (this.frames.length >= MAX_REPLAY_FRAMES_PER_LEVEL) {
      this.overflowed = true;
      console.warn(
        `%c[replay] "${this.meta.filePath}" exceeded ${MAX_REPLAY_FRAMES_PER_LEVEL} frames — this run's replay won't be saved`,
        "color:#e0a04a",
      );
      return;
    }
    this.frames.push({ dt, input });
  }

  /** This level's finished segment, or `null` if it never captured a single
   * frame or overflowed the cap above. */
  async finish(): Promise<ReplayLevelSegment | null> {
    if (this.overflowed || this.frames.length === 0) return null;
    const astHash = await this.astHashPromise;
    return { ...this.meta, astHash, frames: this.frames };
  }
}

/**
 * Records an entire run's input, one level at a time. `main.ts`'s
 * `launchLevel` calls `startLevel()` once per level (fresh campaign start, or
 * carrying over from the previous level/a resumed save); `RaycasterEngine`
 * calls `record()` once per `advance()` step, always against whichever level
 * is currently active. `finish()` (called once the run actually ends) resolves
 * every level's AST hash and assembles the final payload.
 */
export class CampaignReplayRecorder {
  private readonly levels: LevelRecorder[] = [];
  private current: LevelRecorder | null = null;

  constructor(private readonly campaignName: string) {}

  /** Start recording a new level, becoming the target of every subsequent
   * `record()` call until the next `startLevel()`. Silently stops recording
   * further levels once `MAX_REPLAY_LEVELS` is reached — whatever was
   * captured before that point is still saved. */
  startLevel(meta: ReplayLevelMeta, astHashPromise: Promise<string>): void {
    if (this.levels.length >= MAX_REPLAY_LEVELS) {
      this.current = null;
      return;
    }
    this.current = new LevelRecorder(meta, astHashPromise);
    this.levels.push(this.current);
  }

  /** Record this frame's input into whichever level is currently active —
   * a no-op if none is (e.g. past `MAX_REPLAY_LEVELS`). */
  record(dt: number, input: InputSnapshot): void {
    this.current?.record(dt, input);
  }

  /** The finished payload, or `null` if not one level of this run produced a
   * savable segment — either way, nothing worth attaching to a highscore
   * entry. */
  async finish(): Promise<ReplayPayload | null> {
    const resolved = await Promise.all(this.levels.map((level) => level.finish()));
    const levels = resolved.filter((level): level is ReplayLevelSegment => level !== null);
    if (levels.length === 0) return null;
    return { version: 2, campaignName: this.campaignName, levels };
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

  /** Permanent no-op — cheats aren't part of `InputSnapshot`/recorded frames
   * at all, since a run that ever used one is barred from saving a replay in
   * the first place (see `cheatsUsed` in `main.ts`), so there's nothing
   * meaningful to reproduce during playback. */
  consumeCheat(): string | null {
    return null;
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
