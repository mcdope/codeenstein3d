// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * RaycasterEngine: owns the render loop, player, input, and game state for one
 * level.
 *
 * All motion is scaled by delta time so movement speed is identical whether the
 * display runs at 60, 120, or 30 fps. The engine tracks health ("System
 * Stability") and ammo ("Heap / RAM"), runs the enemy AI (enemies chase and
 * melee the player), and ends the run on death (Kernel Panic) or reaching the
 * exit (Build Successful). It reports state to the host via `EngineHandlers`
 * and leaves the DOM HUD/overlays to the caller.
 */
import { DEFAULT_DIFFICULTY, DIFFICULTY_MULTIPLIERS, type DifficultyLevel, type DifficultyMultipliers } from "../difficulty";
import { createResumablePrng, randomSeed } from "../prng";
import { CORRECTION_SMOOTH_MS, SNAP_THRESHOLD_TILES } from "./reconciliationConstants";
import { COUNTDOWN_TICKS } from "./transitionConstants";
import type {
  EnemySnapshot,
  LootDropSnapshot,
  MineSnapshot,
  PlayerSnapshot,
  ReconciliationSnapshot,
  TileMutation,
} from "./reconciliationSnapshot";
import { Player, isHazard } from "./player";
import { updateEnemies, type EnemyAiEvents, type EnemyTarget } from "./enemyAi";
import { collectProjectileBillboards, updateProjectiles, type Projectile, type ProjectileTarget } from "./projectiles";
import { InputController, type InputSource } from "./input";
import type { CampaignReplayRecorder } from "./replay";
import { castWallDistances, FOG_FAR, renderMinimap, renderScene } from "./raycaster";
import { textures } from "./textures";
import {
  collectDecorationBillboards,
  collectEnemyBillboards,
  collectExitBillboard,
  collectKeyBillboards,
  collectLootBillboards,
  collectMineBillboards,
  collectPlayerBillboards,
  collectTeleporterBillboards,
  findMineInProjections,
  findTargetInProjections,
  findTargetUnderCrosshair,
  projectLivingEnemies,
  projectVisibleMines,
  type BillboardJob,
  type OtherPlayerBillboard,
} from "./sprites";
import {
  drawCheatToast,
  drawCompass,
  drawCrosshair,
  drawExitCountdownToast,
  drawFpsOverlay,
  drawHud,
  drawKillStreakToast,
  drawLoreOverlay,
  drawPauseOverlay,
} from "./hud";
import { drawWeapon } from "./viewmodel";
import { drawAutomap } from "./automap";
import {
  DAMAGE_FLASH_FRAMES,
  DEFAULT_GORE_LEVEL,
  GORE_MULTIPLIERS,
  HIT_FLASH_FRAMES,
  drawBulletTraces,
  drawDamageFlash,
  drawFlameStreams,
  makeBulletTrace,
  renderBlood,
  renderBurnParticles,
  renderExplosionParticles,
  renderExplosions,
  spawnBlood,
  spawnBurnParticles,
  spawnExplosion,
  spawnExplosionParticles,
  spawnFlameStream,
  tickBulletTraces,
  tickFlameStreams,
  updateBlood,
  updateBurnParticles,
  updateExplosionParticles,
  updateExplosions,
  type BloodParticle,
  type BulletTrace,
  type BurnParticle,
  type Explosion,
  type ExplosionParticle,
  type FlameStream,
  type GoreLevel,
  type GoreMultipliers,
} from "./effects";
import { audio } from "./audio";
import { computeScore, killPoints, sumScoreBreakdowns, zeroScoreBreakdown, type ScoreBreakdown } from "./scoring";
import {
  PLAYER_STATS_ENABLED,
  buildPlayerFacingStats,
  emptyPlayerFacingStats,
  mergePlayerFacingStats,
  type PlayerFacingStats,
} from "./playerStats";
import {
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  NUMBER_KEY_WEAPONS,
  STARTING_WEAPONS,
  TOOLCHAIN_WEAPON_INDEX,
  UNLOCKABLE_WEAPONS,
  WEAPONS,
  currentMeleeWeapon,
  pelletOffsets,
  type Weapon,
} from "./weapons";
import { HEALTH_DROP_AMOUNT, MAX_SWAP, REGULAR_KILL_NO_DROP_CHANCE, SWAP_DROP_AMOUNT, rollBonusWeaponDrop, rollLoot } from "./loot";
import { AMMO_META, AMMO_TYPES, startingAmmo, type AmmoPools } from "./ammo";
import { applyLootDrop, dropEliteLoot, grantOrTopUpWeapon, rollMissChanceToolchain, type LootContext } from "./lootApply";
import { collectRocketBillboards, rocketDamageAt, spawnRocket, updateRockets, ROCKET_BLAST_RADIUS, type Rocket } from "./rockets";
import { EnemySpatialGrid } from "./spatialGrid";
import { PathField } from "./pathField";
import { detonateMine, mineDamageAt, spikeDamage, updateMines, MINE_BLAST_RADIUS } from "./traps";
import { FramePerfLogger } from "./perfDebug";
import {
  createTelemetryState,
  recordDamage,
  recordEnemyAggro,
  recordEnemyBoltFired,
  recordEnemyBoltHit,
  recordEnemyDeath,
  recordEnemyMeleeAttack,
  recordFatalDamage,
  recordHeal,
  recordHit,
  recordKill,
  recordKillForcedByMelee,
  recordLootCollected,
  recordLootRolled,
  recordMineDisarmed,
  recordMineTriggered,
  recordRegularKillLootRoll,
  recordShot,
  updateMinHealth,
  updatePerFrame as updateTelemetryPerFrame,
  type DamageSource,
  type EnemyTtkRecord,
  type TelemetryState,
} from "./telemetry";
import {
  DOOR_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  TELEPORTER_TILE,
  type Enemy,
  type GameMap,
  type LootDrop,
  type LootKind,
  type LoreTerminal,
  type Mine,
  type Point,
  type Tile,
} from "../map/types";

/** Movement speed in tiles per second. */
const MOVE_SPEED = 3.2;
/** Speed multiplier while sprinting (holding Shift). */
const SPRINT_MULTIPLIER = 2.0;
/** Keyboard rotation speed in radians per second. */
const ROT_SPEED = 2.6;
/** Mouse rotation sensitivity in radians per pixel of movement. */
const MOUSE_SENSITIVITY = 0.0025;
/** Clamp per-frame dt so a background tab / long stall can't teleport the player. */
const MAX_DT = 0.05;
/** How often (seconds) the FPS overlay's averaged reading recomputes — often
 * enough to feel live, slow enough not to jitter every frame. */
const FPS_UPDATE_INTERVAL = 0.5;
/** Starting / maximum System Stability (health), as a percentage. */
const MAX_HEALTH = 100;
/** IDKFA's ammo grant — a clearly-a-cheat round number; ammo otherwise has no
 * upper cap at all (only loot/pickups increment it). */
const CHEAT_MAX_AMMO = 999;
/** How many frames the "cheat activated" toast stays visible for — frame-
 * counted like `flashFrames`/`muzzleFrames` below, not `dt`-scaled, so it
 * needs no change to `tickEffects()`'s signature. ~2s at 60fps. */
const CHEAT_TOAST_FRAMES = 120;
/** Same frame-counted convention as `CHEAT_TOAST_FRAMES`, for the "Multi/
 * Ultra Kill" banner. */
const KILL_STREAK_TOAST_FRAMES = 120;
/** Kills within this many real seconds of each other trigger a "Multi
 * Kill" (see `damageEnemy`'s rolling-window check) — not Unreal
 * Tournament's own continuously-extending streak/tier algorithm, just this
 * project's own simpler fixed-window spec. */
const MULTI_KILL_WINDOW_SEC = 3;
/** How many kills within `MULTI_KILL_WINDOW_SEC` triggers a "Multi Kill". */
const MULTI_KILL_COUNT = 3;
/** Kills within this many real seconds of each other trigger the bigger
 * "Ultra Kill" tier instead of "Multi Kill". */
const ULTRA_KILL_WINDOW_SEC = 6;
/** How many kills within `ULTRA_KILL_WINDOW_SEC` triggers an "Ultra Kill". */
const ULTRA_KILL_COUNT = 6;
/** Health lost per second while standing in an acid (hazard) tile. */
const HAZARD_DPS = 18;
/**
 * Cone-of-Fire: maximum screen-px of random aim deviation, reached only at
 * `FOG_FAR` (the same distance the world fades to black at — "maximum visual
 * range"). Scaled by `(range / FOG_FAR)³`, not linearly or quadratically, so
 * deviation stays small through medium range and only really opens up in the
 * last stretch before the fog line — playtest feedback was that a linear
 * scale ruined medium-range accuracy, and even the quadratic follow-up still
 * made the pistol/gdb feel unreliable well short of extreme range. Both the
 * lower max (56px → 38px) and the steeper (cubic) curve are tuned toward the
 * same goal: medium range should feel reliable, and only the last stretch
 * before the world fades to black should miss with any regularity (see
 * `fire()`). This is the shared default; an individual weapon can tighten it
 * via `Weapon.maxConeDeviationPx` (currently only gdb does) rather than
 * everything sharing one curve tuned primarily around the pistol.
 */
const MAX_CONE_DEVIATION_PX = 38;
/** Tiles the player must cover between footstep sounds. */
const STRIDE_LENGTH = 1.2;
/** Head-bob angular frequency while moving (radians/sec). */
const BOB_FREQUENCY = 8.5;
/** How fast the bob amplitude eases in/out as movement starts/stops. */
const BOB_EASE = 8;
/** Peak camera horizon bob, in pixels. */
const CAMERA_BOB_PX = 3;
/** Peak weapon bob, in pixels (horizontal, vertical). */
const WEAPON_BOB_X_PX = 10;
const WEAPON_BOB_Y_PX = 8;
/** How fast the weapon recoil eases back to rest (per second). */
const RECOIL_RECOVERY = 12;
/** Frames the muzzle flash is drawn after firing. */
const MUZZLE_FLASH_FRAMES = 3;
/** Fraction of max stability below which the low-health alarm sounds. */
const LOW_HEALTH_FRACTION = 0.25;
/** Seconds between low-health alarm beeps. */
const LOW_HEALTH_BEEP_INTERVAL = 1;
/** How close (tiles) the player must get to pick up a key. */
const KEY_PICKUP_RADIUS = 0.5;
/** How close (tiles) the player must get to pick up a dropped loot item or a
 * statically-placed map ammo pickup. */
const AMMO_PICKUP_RADIUS = 0.5;
/** How close (tiles) the player must be to a lore terminal for "R" to read
 * it — proximity, not facing, matching "pressing R nearby" from the spec. */
const LORE_INTERACT_RADIUS = 1.8;
/** Wrapped lines per second scrolled while holding W/S in the lore overlay. */
const LORE_SCROLL_SPEED = 6;
/** How far ahead of the player (tiles) "R" reaches to open a fake wall —
 * generous enough to trigger from a normal standing distance, unlike the
 * door's much tighter walk-into-it reach. */
const SECRET_WALL_REACH = 0.9;
/** Fog-of-war reveal radius (tiles) around the player each frame — feeds
 * `map.visited`, which drives both the automap and the map-completion score
 * bonus's numerator (`visitedWalkableCount`). The always-on corner minimap
 * is a separate, unrelated "radar" that ignores fog of war entirely. */
const VISITED_REVEAL_RADIUS = 5;
/** Internal render/shot-resolution resolution — matches `main.ts`'s own
 * private (unexported) `SCENE_WIDTH`/`SCENE_HEIGHT` constants exactly, but
 * defined separately here since `engine.ts` has no existing import from
 * `main.ts` and this step doesn't introduce one (see `resolveShot`'s doc
 * comment). Every `PlayerState.zBuffer` is sized to `SCENE_WIDTH`, and
 * `fire()`/`resolveShot()` and the `?testHooks=1` debug closures resolve
 * screen columns against these, not the live canvas size — `render()`'s own
 * calls stay on `this.ctx.canvas.width/height`, untouched (see §4 of the
 * N-player refactor plan). */
const SCENE_WIDTH = 640;
const SCENE_HEIGHT = 400;
/** Health a coop player revives at, at the next level transition, after
 * dying mid-level (see `addPlayer`'s doc comment) — a balance value to
 * validate via telemetry like everything else here. Exported so a later
 * session-lifecycle step (and this step's own tests) can pass
 * `{ ...carryover, health: REVIVE_HEALTH }` to `addPlayer` without
 * duplicating the constant. */
export const REVIVE_HEALTH = 50;

/** Opaque per-connection player identifier — a plain string so it flows
 * through JSON (replay/network snapshots) unchanged. No netcode module
 * exists yet to import this from, so it's declared locally here. */
export type PlayerId = string;

/** Sentinel id for the one player in an N=1 session — assigned automatically
 * by the constructor. Real multi-peer sessions (later steps) never use this
 * literal for anyone but this engine's own local peer. */
export const LOCAL_PLAYER_ID: PlayerId = "local";

/** `"disconnected"` is a real, distinct terminal state from `"dead"` — a
 * transport-layer disconnect (`multiplayer-netcode-spec.md` §5), not a
 * combat death. Both are excluded from world simulation/rendering the same
 * way (every relevant loop already gates on `status === "alive"`, not
 * `status !== "dead"`), but only a disconnected player is excluded from the
 * *wire-level* roster (`captureReconciliationSnapshot()`) — a dead player
 * stays a full roster member, spectating; a disconnected one is genuinely
 * gone. Never single-player: nothing there ever sets this value. */
export type PlayerStatus = "alive" | "dead" | "disconnected";

/** Everything `RaycasterEngine` used to track as a single `this.*` field for
 * "the player" now lives here, one instance per connected player — single-
 * player is just the N=1 case of `players: Map<PlayerId, PlayerState>`
 * (`LOCAL_PLAYER_ID` → one `PlayerState`), not a separate code path. See
 * `createPlayerState`. */
interface PlayerState {
  readonly id: PlayerId;
  readonly player: Player;
  readonly input: InputSource;
  status: PlayerStatus;
  /** While dead: which living teammate's camera this player's render pass
   * follows — cycled by `consumeFire()` (repurposed while dead, see
   * `simulate()`). `null` only as a same-tick transient before the
   * team-over check resolves, or once no living teammate remains. */
  spectateTargetId: PlayerId | null;
  health: number;
  swap: number;
  godMode: boolean;
  readonly ammo: AmmoPools;
  readonly startingAmmoRef: AmmoPools;
  weaponIndex: number;
  readonly ownedWeapons: Set<number>;
  readonly campaignLevelIndex: number;
  weaponCooldown: number;
  meleeCooldown: number;
  keysHeld: number;
  kills: number;
  killScore: number;
  recentKillTimes: number[];
  multiKillCount: number;
  ultraKillCount: number;
  killStreakText: string | null;
  killStreakFrames: number;
  killStreakBig: boolean;
  readonly priorScore: number;
  readonly priorScoreBreakdown: ScoreBreakdown;
  readonly priorPlayerStats: PlayerFacingStats;
  distanceTraveled: number;
  stepDistance: number;
  moving: boolean;
  bobTime: number;
  bobAmount: number;
  recoil: number;
  meleeRecoil: number;
  muzzleFrames: number;
  viewOffsets: { horizonShift: number; bobX: number; bobY: number };
  rotSpeedMultiplier: number;
  /** A drift correction's render-only smoothing — `null` when this player's
   * rendered position matches its simulated one exactly (the overwhelming
   * majority of the time). Set by `applyReconciliationSnapshot()` the moment
   * a below-`SNAP_THRESHOLD_TILES` correction snaps the *simulated* position;
   * `x`/`y` is the (world-units) gap the render pass still owes, decaying to
   * zero over `CORRECTION_SMOOTH_MS` real milliseconds from `capturedAtMs` —
   * see `render()`'s own read site. Never set for a correction at or above
   * the threshold: that one snaps the render position too, instantly, no
   * offset object created at all (`multiplayer-netcode-spec.md` §4). Never
   * read or written in single-player. */
  renderOffset: { x: number; y: number; capturedAtMs: number } | null;
  /** Always `SCENE_WIDTH`-sized, for every player, local or remote — see
   * `SCENE_WIDTH`'s doc comment. */
  readonly zBuffer: Float64Array;
  readonly pathField: PathField;
  suppressTeleportAt: string | null;
  alarmCountdown: number;
  flashFrames: number;
  cheatToastText: string | null;
  cheatToastFrames: number;
  isMapActive: boolean;
  isPaused: boolean;
  loreText: string | null;
  loreScroll: number;
  showFps: boolean;
  readonly lootCtx: LootContext;
}

/** One ranged pellet's resolved outcome — see `resolveShot`. */
type PelletOutcome = { kind: "enemy"; target: Enemy } | { kind: "mine"; target: Mine } | { kind: "miss" };

/** `resolveShot`'s full result for one trigger pull — `fire()` applies ammo
 * cost, damage, loot, telemetry, traces, and audio on top of this. */
interface ShotResolution {
  /** One per `pelletOffsets(weapon)`, in order. */
  pellets: PelletOutcome[];
  /** Screen columns to draw a bullet trace at (empty for melee/flame weapons
   * — see `fire()`). */
  traceColumns: number[];
  /** Widest flame-stream spread any pellet landed on, post-Cone-of-Fire
   * deviation — `Infinity`/`-Infinity` (an empty range) for a non-flame
   * weapon or a weapon whose loop never ran a pellet. */
  flameLeft: number;
  flameRight: number;
}

/** Live stats pushed to the host each frame. */
export interface EngineStats {
  /** System Stability, 0–100. */
  health: number;
  maxHealth: number;
  /** Swap points, absorbed 1:1 before health on any hit (see `damage()`). */
  swap: number;
  /** Bullets remaining (pistol/shotgun). */
  bullets: number;
  /** Rockets remaining (ghidra). */
  rockets: number;
  /** gdb's own ammo remaining — a separate pool from `bullets` (see
   * `AmmoType`). */
  smg: number;
  /** Friday Hotfix's own ammo remaining — a separate pool from `bullets`/
   * `smg`/`rockets` (see `AmmoType`). */
  gas: number;
  /** Dependency keys currently held (unused, in inventory). */
  keysHeld: number;
  /** Total keys placed on this level. */
  keysTotal: number;
  /** Running campaign score: points banked from every level already cleared
   * this run (see `EngineCarryover.priorScore`), plus the current level's own
   * kill points and bonuses for remaining health/ammo, completion speed, and
   * route efficiency — see `./scoring.ts`. The current level's contribution is
   * recomputed live every frame from the run's current state, so this rises
   * (and, within the current level, can fluctuate) until the exit is reached,
   * at which point it becomes the baseline the next level carries forward. */
  score: number;
  /** Enemies defeated this level ("bugs squashed" for the commit summary). */
  kills: number;
  /** Index into `WEAPONS` of the currently-equipped weapon. */
  weaponIndex: number;
  /** Indices into `WEAPONS` the player currently owns/can switch to. */
  ownedWeapons: number[];
  /** IDDQD cheat state — see `EngineHandlers.onCheatActivated`. */
  godMode: boolean;
  /** IDCLIP cheat state. */
  noClip: boolean;
  /** FPS/frame-time overlay state (Right-Ctrl) — see `EngineCarryover.showFps`. */
  showFps: boolean;
  /** This level's own score breakdown by category (kill points plus every
   * bonus) — see `./scoring.ts`. `undefined` whenever telemetry isn't being
   * recorded at all (`PLAYER_STATS_ENABLED` off and no `?testHooks=1` — see
   * `playerStats.ts`'s doc comment); all four of these fields are either all
   * present or all `undefined` together. */
  levelScoreBreakdown?: ScoreBreakdown;
  /** `levelScoreBreakdown` summed with every level already cleared this
   * campaign (see `EngineCarryover.priorScoreBreakdown`) — the run-end stats
   * screen's cumulative breakdown. `runScoreBreakdown.total` always equals
   * `score` above, when present. */
  runScoreBreakdown?: ScoreBreakdown;
  /** Curated player-facing stats (kills, weapon accuracy, damage taken by
   * source, time survived, loot collected, closest call) for this level
   * only — see `./playerStats.ts`. */
  levelPlayerStats?: PlayerFacingStats;
  /** `levelPlayerStats` merged with every level already cleared this
   * campaign (see `EngineCarryover.priorPlayerStats`) — the run-end stats
   * screen's cumulative totals. */
  runPlayerStats?: PlayerFacingStats;
}

/** Host callbacks. All optional. */
export interface EngineHandlers {
  onStats?: (stats: EngineStats) => void;
  /** Fired on death; receives the final stats so the host can record a
   * highscore entry for the run (score, and how far the campaign got). */
  onGameOver?: (stats: EngineStats) => void;
  /** Fired when the player reaches the exit; receives the final stats so the
   * host can carry health/ammo into the next level. */
  onWin?: (stats: EngineStats) => void;
  /** Fired the instant a Doom cheat code (IDDQD/IDKFA/IDCLIP) is typed —
   * separate from the engine's own internal `godMode`/`noClip` state, this is
   * how the host learns a cheat fired at all, so it can bar the run from
   * saving a highscore/replay for the rest of the campaign. */
  onCheatActivated?: (code: string) => void;
  /** Fired only on the paused/lore-frozen ↔ running edge (not every frame),
   * so the host can e.g. silence ambient console hints while the sim isn't
   * actually advancing. */
  onFreezeChange?: (frozen: boolean) => void;
}

/** Health/ammo/weapon carried over from a previous level, for multi-level
 * runs or resuming a saved campaign. */
export interface EngineCarryover {
  health: number;
  swap: number;
  bullets: number;
  rockets: number;
  smg: number;
  gas: number;
  /** Score banked from every level already cleared this campaign — the
   * baseline `EngineStats.score` adds this level's own live score on top of,
   * so the running total never resets at a level transition. Defaults to 0
   * for a genuinely fresh run. */
  priorScore?: number;
  /** Score breakdown, by category, summed across every level already
   * cleared this campaign — the run-end stats screen's cumulative breakdown
   * adds this level's own on top of. `priorScore` above stays the single
   * source of truth for the live per-frame total; this is purely additive,
   * only consumed by the stats screens. Defaults to a zeroed breakdown for a
   * genuinely fresh run. */
  priorScoreBreakdown?: ScoreBreakdown;
  /** Curated player-facing stats (kills, accuracy, damage taken, loot,
   * survival time, closest call) accumulated across every level already
   * cleared this campaign — see `./playerStats.ts`'s
   * `mergePlayerFacingStats`. Defaults to an empty accumulator for a
   * genuinely fresh run. */
  priorPlayerStats?: PlayerFacingStats;
  /** Index into `WEAPONS`; defaults to the pistol (0) when omitted. */
  weaponIndex?: number;
  /** Defaults to `STARTING_WEAPONS` when omitted. */
  ownedWeapons?: number[];
  /** 1-based campaign level position, mirroring `main.ts`'s own
   * `campaignLevelIndex` — the only thing this engine instance needs it for
   * is gating Toolchain's Elite-kill bonus drop by `TOOLCHAIN_MIN_LEVEL` (see
   * `dropEliteLoot`). Defaults to 1 (matching a fresh run) when omitted.
   * Round-trips through a recorded replay's `carryover` for free, since a
   * `ReplayLevelSegment` carries exactly this type. */
  campaignLevelIndex?: number;
  /** Doom-style cheat flags carried across a level transition — a fresh
   * `RaycasterEngine`/`Player` is constructed for every level (see
   * `main.ts`'s `launchLevel`), so an active toggle would otherwise silently
   * reset at the next file. Omitted on a genuinely fresh run. IDKFA needs no
   * equivalent field — its effect already persists via `bullets`/`rockets`/
   * `smg`/`gas`/`ownedWeapons` above. */
  godMode?: boolean;
  noClip?: boolean;
  /** Whether the FPS/frame-time overlay (Right-Ctrl) was showing — carried
   * across a level transition for the same reason the cheat flags above are:
   * a fresh `RaycasterEngine` is constructed per level, so the toggle would
   * otherwise silently reset and need re-activating every level. Omitted on
   * a genuinely fresh run. */
  showFps?: boolean;
}

type GameState = "playing" | "over" | "won";

export class RaycasterEngine {
  private readonly ctx: CanvasRenderingContext2D;
  /** One `PlayerState` per connected player — single-player is the N=1 case
   * of this map (`LOCAL_PLAYER_ID` → one entry), not a separate code path.
   * See `createPlayerState`/`addPlayer`. */
  private readonly players: Map<PlayerId, PlayerState>;
  /** Which `players` entry is *this* engine instance's own local peer — the
   * one with a real canvas/render pass. Every render-facing read
   * (`render()`, `buildStats()`, the `?testHooks=1` hooks) resolves through
   * this id; only `players` itself and `sortedPlayerIds()`'s per-player
   * simulation loops (§7) touch every player, local or remote. */
  private readonly localPlayerId: PlayerId;
  /** Seeded PRNG for every simulation-relevant random draw this engine itself
   * makes (weapon spread, elite-loot coinflip) — plus what it hands down to
   * `updateEnemies`/`rollLoot`. Never `Math.random()` directly; see
   * `src/prng.ts`'s doc comment for why. Backed by `rngHandle` (see below) —
   * `this.rng` itself stays a plain callable, unchanged from before
   * multiplayer reconciliation existed, so none of its many call sites need
   * to know or care that the stream is resumable underneath. */
  private readonly rng: () => number;
  /** The same stream `this.rng` draws from, via its `next` — kept alongside
   * it only so `captureReconciliationSnapshot()`/`applyReconciliationSnapshot()`
   * can read/resume its raw internal state (`multiplayer-netcode-spec.md`
   * §3, "the PRNG state gap"). Never read in single-player. */
  private readonly rngHandle: ReturnType<typeof createResumablePrng>;
  /** Records this level's input for the replay system, if a run is actively
   * being tracked (see `main.ts`'s `launchLevel`) — `undefined` during replay
   * playback itself, which never re-records what it's replaying. Only ever
   * records the local player's own input (see `simulate()`) — replay/session
   * recording for a real multi-peer run is a later netcode step's job. */
  private readonly replayRecorder?: CampaignReplayRecorder;
  private readonly enemies: Enemy[];
  /** Tile-bucketed index over living enemies for proximity queries — rebuilt
   * lazily on frames with rockets in flight (see `advanceRockets`). */
  private readonly enemyGrid = new EnemySpatialGrid();
  /** An enemy's own drift-correction render offset, keyed by index into
   * `this.enemies` — same shape/decay/threshold rules as
   * `PlayerState.renderOffset`, kept as a side-map rather than a field on the
   * shared `Enemy` map-type since `Enemy` has no other engine-instance-only
   * (as opposed to map-data) fields today. Absence of an entry means no
   * offset owed, same as `null` there. Never read in single-player. */
  private readonly enemyRenderOffsets = new Map<number, { x: number; y: number; capturedAtMs: number }>();
  /** Bumped on every runtime mutation of `map.grid` (a door opening, a
   * secret wall sliding away) — every player's own `pathField`'s
   * invalidation signal. */
  private gridVersion = 0;
  /** Every individual tile mutation since the last drained
   * `captureReconciliationSnapshot()` call — `gridVersion` alone tells a
   * guest *that* something changed, not *what*; multiplayer-reconciliation-
   * only bookkeeping, drained (not just read) on capture. Never read in
   * single-player. */
  private readonly pendingGridDelta: TileMutation[] = [];

  private running = false;
  private rafId = 0;
  private lastTime = 0;
  /** Enemy under the crosshair this frame, if any — populated only by
   * `findTargetUnderCrosshair` inside `renderNormalFrame()`, which stays
   * strictly local-player (see `render()`). */
  private target: Enemy | null = null;

  /** Seconds/frame-count accumulated since the last `displayFps` update. */
  private fpsAccumTime = 0;
  private fpsAccumFrames = 0;
  /** Rolling-averaged FPS, recomputed every `FPS_UPDATE_INTERVAL` seconds. */
  private displayFps = 0;
  /** Last frame's raw (unaveraged) time in milliseconds — jitter/stutter is
   * useful signal the averaged FPS alone would hide. */
  private displayFrameMs = 0;

  /** Team-composite game state — `"playing"` until every player is dead
   * (`"over"`) or any one living player reaches the exit (`"won"`); see
   * `checkExit()`/`killPlayer()`. Per-player life/death instead lives on
   * `PlayerState.status`. */
  private state: GameState = "playing";
  /** Multiplayer-only: ticks remaining in the exit countdown, or `null` when
   * none is active — set once, by the first living player to touch
   * `map.exit`, never restarted by a later touch or reset by leaving the
   * tile (see `checkExit()`). Always `null` for a single-player instance,
   * which never starts one at all (`endGame("won")` fires immediately on
   * touch, byte-identical to pre-step-8 behavior). */
  private exitCountdownRemaining: number | null = null;
  /** Tracks who has damaged which still-live enemy this "engagement" (from
   * first hit to death), for `killScore`'s assist split — see
   * `damageEnemy()`. Keyed by index into `this.enemies` (stable for a given
   * enemy's whole lifetime); the entry is deleted the instant that enemy
   * dies, so this only ever holds currently-live, currently-damaged enemies. */
  private readonly enemyAssists = new Map<number, Set<PlayerId>>();
  /** Count of unique walkable tiles (see `isWalkableTile`) revealed by
   * `markVisited` so far — the numerator of the "100% Clear" completion
   * fraction (see `./scoring.ts`). Updated incrementally there rather than
   * rescanned every frame, since `map.visited` only ever grows. Team-shared:
   * any player's own reveal radius counts toward it. */
  private visitedWalkableCount = 0;
  /** Total walkable tiles on this level, counted once at construction — the
   * completion fraction's denominator. */
  private readonly totalWalkableTiles: number;
  /** Tile keys ("x,y") of lore terminals read at least once this level —
   * feeds the scoring system's flat per-terminal bonus. Team-shared. */
  private readonly loreRead = new Set<string>();
  /** Tile keys ("x,y") of the door tile of every secret room opened at least
   * once this level — feeds the scoring system's flat per-room bonus. Keyed
   * by the door tile (not any interior tile), since that's the one cell
   * `tryOpenSecretWall` always has in hand and it's unique per room.
   * Team-shared. */
  private readonly secretRoomsOpened = new Set<string>();
  /** Loot dropped by defeated enemies (and by a player dying holding keys —
   * see `killPlayer()`), awaiting collection. Team-shared world state. */
  private readonly drops: LootDrop[] = [];
  /** Per-source drop counters feeding each `LootDrop.id`'s `dropSeq` half
   * (`${enemyIndex}:${dropSeq}` / `player:${playerId}:${dropSeq}`) — a single
   * kill/death can push more than one drop (a guaranteed Elite drop plus a
   * separate bonus-weapon roll; a death's key drop is its own scope), so the
   * source alone isn't a unique id on its own. Multiplayer-reconciliation-only
   * bookkeeping — never read in single-player. */
  private readonly dropSeqByEnemyIndex = new Map<number, number>();
  private readonly dropSeqByPlayerId = new Map<PlayerId, number>();
  /** Live weapon bullet tracers, fading over a few frames. Team-shared VFX. */
  private readonly traces: BulletTrace[] = [];
  /** Live flamethrower flame streams (Friday Hotfix's tracer replacement),
   * fading over a few frames — see `FlameStream`. Team-shared VFX. */
  private readonly flameStreams: FlameStream[] = [];
  /** Live "digital blood" particles falling to the floor. Team-shared VFX. */
  private readonly blood: BloodParticle[] = [];
  /** Gore-level count/size/floor-stain-duration multipliers, read once at
   * construction (see the constructor's `gore` parameter). */
  private readonly goreMultipliers: GoreMultipliers;
  /** HP/damage/ammo-drop-rate multipliers for the current difficulty, read
   * once at construction (see the constructor's `difficulty` parameter). */
  private readonly difficultyMultipliers: DifficultyMultipliers;
  /** The raw difficulty level itself, kept alongside `difficultyMultipliers`
   * since `rollLoot`'s drop-kind odds (Normal only — see `./loot.ts`) need the
   * level name, not just its numeric multipliers. */
  private readonly difficultyLevel: DifficultyLevel;
  /** In-flight enemy projectiles (ranged bolts). Team-shared world state. */
  private readonly projectiles: Projectile[] = [];
  /** In-flight player-fired rockets. Team-shared world state. */
  private readonly rockets: Rocket[] = [];
  /** Live rocket-blast VFX circles. Team-shared VFX. */
  private readonly explosions: Explosion[] = [];
  /** Live rocket-blast debris/spark particles (see `spawnExplosionParticles`). */
  private readonly explosionParticles: ExplosionParticle[] = [];
  /** Live flamethrower-hit burn embers, settling and lingering on the floor
   * (see `spawnBurnParticles`). Team-shared VFX. */
  private readonly burnParticles: BurnParticle[] = [];
  /** Seconds elapsed in this level's simulation; drives timed spike traps. */
  private levelTime = 0;
  /** Last value reported via `onFreezeChange`, so that handler only fires on
   * an actual edge instead of every frame the sim happens to be paused. */
  private wasFrozen = false;
  /** Per-frame timing/entity-count profiler — only constructed when
   * `?perfDebug=1` is present (see the constructor), for tracking down the
   * unreproduced magento2/"nightmare" shooting-framedrop report (see
   * `notes`). Every call site elsewhere in this class is `this.perf?.…`, so
   * it's a complete no-op (not even a function call) in normal play. */
  private readonly perf?: FramePerfLogger;
  /** This frame's raw (unclamped) wall-clock delta in ms, set by `frame()`
   * right before `advance()` runs — `advance()` itself only ever sees the
   * clamped `dt`, but `perf.endFrame` specifically wants the *unclamped*
   * value so a real stall isn't hidden by `MAX_DT`. Unused when `perf` is
   * unset. */
  private lastRawDtMs = 0;
  /** One-shot handoff of `frame()`'s unclamped delta to `advance()`'s
   * perf-frame begin — `undefined` whenever `advance()` is driven directly
   * (replay viewer, headless), which then falls back to its own `dt`. */
  private perfRawDtMs: number | undefined;

  /** Balancing telemetry — populated when `?testHooks=1` gates it on (for
   * the bot) or when `PLAYER_STATS_ENABLED` is flipped on (for the
   * player-facing stats screen — off by default, see its doc comment: even
   * with the derived stats gated to only compute at level-end, the ~20
   * individual recording call sites below measurably slow real gameplay).
   * Every recording call elsewhere in this class is a no-op guarded by
   * `if (this.telemetry)` when it's `undefined`, so normal play with the
   * flag off carries zero extra cost. */
  private readonly telemetry?: TelemetryState;
  /** Links a live `Enemy` to its open time-to-kill window — see
   * `telemetry.ts`'s `recordEnemyAggro`/`recordEnemyDeath`. Kept off
   * `TelemetryState` itself since a `WeakMap` can't cross the
   * `getTelemetrySnapshot()` structured-clone boundary. */
  private readonly enemyTtkIndex = new WeakMap<Enemy, EnemyTtkRecord>();
  /** Bound once (not reallocated per frame) and always passed to
   * `updateEnemies()` — each closure no-ops internally when `this.telemetry`
   * is unset, same pattern as every other recording call site. */
  private readonly enemyAiEvents: EnemyAiEvents = {
    onAggro: (enemy) => {
      if (this.telemetry) recordEnemyAggro(this.telemetry, this.enemyTtkIndex, enemy, this.levelTime);
    },
    onMeleeAttack: () => {
      if (this.telemetry) recordEnemyMeleeAttack(this.telemetry);
    },
    onRangedFire: () => {
      if (this.telemetry) recordEnemyBoltFired(this.telemetry);
    },
  };
  private readonly onEnemyBoltHit = (): void => {
    if (this.telemetry) recordEnemyBoltHit(this.telemetry);
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: GameMap,
    private readonly handlers: EngineHandlers = {},
    carryover?: EngineCarryover,
    gore: GoreLevel = DEFAULT_GORE_LEVEL,
    difficulty: DifficultyLevel = DEFAULT_DIFFICULTY,
    /** Seeds every simulation-relevant random draw this run makes (see
     * `this.rng`'s doc comment) — defaults to a fresh, non-deterministic seed
     * for live play. `main.ts` always generates and passes one explicitly so
     * it can record the same value into that level's replay payload; replay
     * playback passes back the recorded value instead, reproducing the exact
     * same random stream. */
    gameplaySeed: number = randomSeed(),
    /** Swaps in a `ReplayPlaybackInput` during replay playback instead of a
     * live `InputController` — see `this.input`'s doc comment. */
    inputSource?: InputSource,
    replayRecorder?: CampaignReplayRecorder,
    /** Which `PlayerId` this instance's own player is keyed as — defaults to
     * `LOCAL_PLAYER_ID` ("local"), today's single-player behavior. A
     * multiplayer session must override this to the peer's real, globally-
     * shared roster id: every peer's `players` map has to use the *same* key
     * strings for the *same* physical players, or `sortedPlayerIds()`
     * produces a different relative order on each peer (each one would
     * otherwise substitute a different player's real id with the literal
     * string "local"), desyncing the shared PRNG stream from tick 1 — see
     * `sortedPlayerIds()`'s own doc comment. */
    localPlayerId: PlayerId = LOCAL_PLAYER_ID,
    /** Where this instance's own player spawns — defaults to `map.spawn`
     * (today's single-player behavior). A multiplayer session passes one of
     * `GameMap.multiplayerSpawns`'s spread-out points instead, matching
     * `addPlayer`'s own `spawn` parameter for every other connected player. */
    localSpawn?: Point,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    // Nearest-neighbor scaling for wall/door texture columns — cheaper than
    // bilinear and correct for the game's existing chunky low-res look.
    this.ctx.imageSmoothingEnabled = false;
    this.rngHandle = createResumablePrng(gameplaySeed);
    this.rng = this.rngHandle.next;
    this.replayRecorder = replayRecorder;
    this.enemies = map.enemies;
    this.totalWalkableTiles = countWalkableTiles(map);
    this.goreMultipliers = GORE_MULTIPLIERS[gore];
    this.difficultyMultipliers = DIFFICULTY_MULTIPLIERS[difficulty];
    this.difficultyLevel = difficulty;
    // Enemy HP is "baked in" data on the map's Enemy objects (set once at
    // generation time) rather than something the engine recomputes every
    // frame — rescale it in place here, once, instead of threading difficulty
    // through MapGenerator.generate() (which would cross the map/engine
    // layering boundary for no benefit — see difficulty.ts's doc comment).
    if (this.difficultyMultipliers.hp !== 1) {
      for (const enemy of this.enemies) {
        enemy.hp = Math.round(enemy.hp * this.difficultyMultipliers.hp);
        enemy.maxHp = Math.round(enemy.maxHp * this.difficultyMultipliers.hp);
      }
    }
    // See `this.telemetry`'s doc comment — `PLAYER_STATS_ENABLED` opts real
    // play into the same instrumentation `?testHooks=1` always gets.
    if (PLAYER_STATS_ENABLED || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("testHooks") === "1")) {
      this.telemetry = createTelemetryState();
    }

    this.localPlayerId = localPlayerId;
    this.players = new Map([
      [localPlayerId, this.createPlayerState(localPlayerId, inputSource ?? new InputController(canvas), carryover, localSpawn)],
    ]);

    // Opt-in frame-timing/entity-count diagnostics — see `perfDebug.ts`'s doc
    // comment and `this.perf`'s. Deliberately a separate gate from
    // `?testHooks=1` below: this is for a real affected player's own browser
    // (a debug build/URL handed to them), not headless automation.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perfDebug") === "1") {
      this.perf = new FramePerfLogger();
      this.perf.logLevelScale(
        map.width,
        map.height,
        this.enemies.length,
        this.enemies.filter((e) => e.elite).length,
        this.enemies.filter((e) => e.edgeCase).length,
        map.mines.length,
        canvas.width,
        canvas.height,
      );
    }

    // Test-only instrumentation for headless campaign automation
    // (scripts/verify-campaign-playthrough.mjs, scripts/generate-default-
    // highscore.mjs): exposes just enough read-only state to steer the
    // player toward a known exit and fight back without a pixel-scraping or
    // blind dead-reckoning hack. Inert unless the page URL carries
    // `?testHooks=1` — never touched by normal play. `this.telemetry` is
    // already created above whenever this param is on (it also gates that,
    // see its doc comment) — only the window-hook exposure below (and the
    // bot's rotation-speed override, applied inside `createPlayerState`) is
    // exclusive to this param. Every read below resolves through
    // `this.players.get(this.localPlayerId)!` (the local peer — the only one
    // a real bot/headless harness ever drives) rather than a bare `this.*`.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("testHooks") === "1") {
      (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks = {
        getPlayerState: () => {
          const p = this.players.get(this.localPlayerId)!;
          const { meleeWouldHit, wouldMineHit } = this.computeMeleeAndMineHitChecks(this.localPlayerId);
          return {
            x: p.player.posX,
            y: p.player.posY,
            dirX: p.player.dirX,
            dirY: p.player.dirY,
            health: p.health,
            healthFraction: p.health / MAX_HEALTH,
            swap: p.swap,
            state: this.state,
            ammo: { ...p.ammo },
            weaponIndex: p.weaponIndex,
            meleeWouldHit,
            wouldMineHit,
            ownedWeapons: [...p.ownedWeapons],
            levelTime: this.levelTime,
            distanceTraveled: p.distanceTraveled,
          };
        },
        getExit: () => ({ x: map.exit.x, y: map.exit.y }),
        getEnemies: () =>
          this.enemies.map((e) => ({
            x: e.x,
            y: e.y,
            alive: e.alive,
            aggroed: e.aggroed,
            elite: e.elite,
            edgeCase: e.edgeCase,
            hp: e.hp,
            maxHp: e.maxHp,
          })),
        getMines: () => this.map.mines.map((m) => ({ x: m.x, y: m.y, alive: m.alive, visible: m.visible })),
        // Dynamic kill-drop loot — distinct from the map's static
        // `AmmoPickup`s (which `scripts/lib/staticLevelAnalysis.mjs` already
        // knows about from Node-side map generation, before any enemy has
        // died). Without this, a bot driven purely by pre-planned static
        // pickup positions has no way to know an enemy just dropped
        // something and will walk right past it.
        getDrops: () => this.drops.map((d) => ({ x: d.x, y: d.y, kind: d.kind })),
        // Uncollected dependency keys — without this, a bot's opportunistic
        // loot detour (which already covers ammo/health/weapon pickups) has
        // no way to see keys at all and only ever picks one up when its
        // pre-planned route to a specific locked door happens to pass over
        // it. See `scripts/run-balancing-telemetry.mjs`'s `maybeDetourForLoot`.
        getKeys: () => this.map.keys.filter((k) => !k.collected).map((k) => ({ x: k.x, y: k.y })),
        getTelemetrySnapshot: () => {
          // Unreachable: `this.telemetry` is always created whenever
          // `?testHooks=1` gates this whole block on (see the constructor) —
          // whenever this hook is callable at all, it's already set.
          /* v8 ignore next */
          if (!this.telemetry) return null;
          const p = this.players.get(this.localPlayerId)!;
          const t = this.telemetry;
          const stats = this.buildStats();
          // Reuse the curated player-facing derivation for the fields it
          // already computes (accuracy inputs, damage-by-source, closest
          // call, fatal source), then splice the bot-only extras on top —
          // see `playerStats.ts`'s doc comment for why the two stay separate
          // types rather than one sharing every field. Derived directly from
          // `t` (not `stats.levelPlayerStats`, which is only populated when
          // it's cheap to — see `buildStats()`'s `atLevelEnd` gate) since
          // this hook is always called after the level has already ended
          // (see `pullLevelResult` in run-balancing-telemetry.mjs).
          const player = buildPlayerFacingStats(t, this.levelTime, p.kills);
          return {
            ttkRecords: [...t.ttkFinished, ...t.ttkPending].map((r) => ({ ...r })),
            peakAggroedCount: t.peakAggroedCount,
            combatTimeSec: t.combatTimeSec,
            levelTimeSec: this.levelTime,
            enemyBoltsFired: t.enemyBoltsFired,
            enemyBoltsHit: t.enemyBoltsHit,
            enemyMeleeAttacks: t.enemyMeleeAttacks,
            minHealthReached: player.minHealthReached === Infinity ? p.health : player.minHealthReached,
            timeBelow25PctHealthSec: t.timeBelow25PctHealthSec,
            damageBySource: { ...player.damageTakenBySource },
            healingBySource: { ...t.healingBySource },
            weaponTallies: Object.fromEntries(Object.entries(t.weaponTallies).map(([i, tally]) => [i, { ...tally }])),
            lootRolled: { ...t.lootRolled },
            lootCollectedDynamic: { ...t.lootCollectedDynamic },
            lootCollectedStatic: { ...t.lootCollectedStatic },
            timeAtZeroRangedAmmoSec: t.timeAtZeroRangedAmmoSec,
            killsForcedByMelee: t.killsForcedByMelee,
            minesTriggered: t.minesTriggered,
            minesDisarmed: t.minesDisarmed,
            regularKillLootRolls: t.regularKillLootRolls,
            regularKillLootMisses: t.regularKillLootMisses,
            fatalDamageSource: player.fatalDamageSource,
            distanceTraveled: p.distanceTraveled,
            mapCompletionFrac: this.visitedWalkableCount / this.totalWalkableTiles,
            secretRoomsOpened: this.secretRoomsOpened.size,
            secretRoomCount: map.secretRoomCount,
            kills: player.kills,
            score: stats.score,
          };
        },
      };
    }
  }

  /**
   * Build one player's full state — identical logic to what a pre-N-player
   * constructor did inline for "the" player, just returning a `PlayerState`
   * instead of writing to `this.*`. Everything that stays engine-shared
   * (`map`, `enemies`, `rng`, `drops`, …) is built once in the constructor,
   * outside this method.
   */
  private createPlayerState(id: PlayerId, inputSource: InputSource, carryover?: EngineCarryover, spawn?: Point): PlayerState {
    const player = new Player(this.map, {}, spawn);
    player.noClip = carryover?.noClip ?? false;
    const startingAmmoRef = startingAmmo(this.map.enemies);
    const ammo: AmmoPools = {
      bullets: carryover?.bullets ?? startingAmmoRef.bullets,
      rockets: carryover?.rockets ?? startingAmmoRef.rockets,
      smg: carryover?.smg ?? startingAmmoRef.smg,
      gas: carryover?.gas ?? startingAmmoRef.gas,
    };
    const ownedWeapons = new Set(carryover?.ownedWeapons ?? STARTING_WEAPONS);
    const campaignLevelIndex = carryover?.campaignLevelIndex ?? 1;
    let health = MAX_HEALTH;
    let swap = 0;
    if (carryover) {
      health = carryover.health;
      swap = carryover.swap;
    }
    let weaponIndex = 0;
    if (carryover?.weaponIndex !== undefined) weaponIndex = carryover.weaponIndex;
    // See `PlayerState.rotSpeedMultiplier`'s doc comment — only ever applies
    // to the local peer (the only one a headless bot ever drives).
    let rotSpeedMultiplier = 1;
    if (id === this.localPlayerId && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("testHooks") === "1") {
      const rotMul = Number(new URLSearchParams(window.location.search).get("botRotSpeedMul"));
      if (Number.isFinite(rotMul)) rotSpeedMultiplier = Math.min(10, Math.max(1, rotMul));
    }

    const state = {} as PlayerState;
    Object.assign(state, {
      id,
      player,
      input: inputSource,
      status: "alive" as PlayerStatus,
      spectateTargetId: null,
      health,
      swap,
      godMode: carryover?.godMode ?? false,
      ammo,
      startingAmmoRef,
      weaponIndex,
      ownedWeapons,
      campaignLevelIndex,
      weaponCooldown: 0,
      meleeCooldown: 0,
      keysHeld: 0,
      kills: 0,
      killScore: 0,
      recentKillTimes: [],
      multiKillCount: 0,
      ultraKillCount: 0,
      killStreakText: null,
      killStreakFrames: 0,
      killStreakBig: false,
      priorScore: carryover?.priorScore ?? 0,
      priorScoreBreakdown: carryover?.priorScoreBreakdown ?? zeroScoreBreakdown(),
      priorPlayerStats: carryover?.priorPlayerStats ?? emptyPlayerFacingStats(),
      distanceTraveled: 0,
      stepDistance: 0,
      moving: false,
      bobTime: 0,
      bobAmount: 0,
      recoil: 0,
      meleeRecoil: 0,
      muzzleFrames: 0,
      viewOffsets: { horizonShift: 0, bobX: 0, bobY: 0 },
      renderOffset: null,
      rotSpeedMultiplier,
      zBuffer: new Float64Array(SCENE_WIDTH),
      pathField: new PathField(),
      suppressTeleportAt: null,
      alarmCountdown: 0,
      flashFrames: 0,
      cheatToastText: null,
      cheatToastFrames: 0,
      isMapActive: false,
      isPaused: false,
      loreText: null,
      loreScroll: 0,
      showFps: carryover?.showFps ?? false,
    });

    const lootCtx: LootContext = {
      ammo: state.ammo,
      scaledAmount: (base) => this.scaledLootAmount(base),
      heal: (amount) => {
        state.health = Math.min(MAX_HEALTH, state.health + amount);
      },
      addSwap: (amount) => {
        state.swap = Math.min(MAX_SWAP, state.swap + amount);
      },
      addKey: (amount) => {
        state.keysHeld += amount;
      },
      healthAtMax: () => state.health >= MAX_HEALTH,
      ownedWeapons: state.ownedWeapons,
      equip: (index) => {
        state.weaponIndex = index;
      },
      pushDrop: (drop, enemy) => this.pushLootDrop(drop, enemy),
      rng: this.rng,
      campaignLevelIndex: state.campaignLevelIndex,
      recordApplied: (kind, amount, origin) => {
        if (this.telemetry) recordLootCollected(this.telemetry, origin, kind, amount);
      },
      isMultiplayerSession: this.isMultiplayerSession(),
    };
    Object.assign(state, { lootCtx });

    return state;
  }

  /**
   * Add a new connected player mid-session — the real revive mechanism too:
   * a later session-lifecycle step calls this with
   * `{ ...carryover, health: REVIVE_HEALTH }` for a player who died the
   * level before (see `REVIVE_HEALTH`'s doc comment). `spawn` defaults to
   * `map.spawn` (today's exact stacked-spawn behavior) — a multiplayer
   * session passes one of `GameMap.multiplayerSpawns`'s spread-out points
   * instead, per `multiplayer-game-state-spec.md` §2's assignment rule.
   */
  addPlayer(id: PlayerId, inputSource: InputSource, carryover?: EngineCarryover, spawn?: Point): void {
    if (this.players.has(id)) throw new Error(`RaycasterEngine.addPlayer: "${id}" already present`);
    this.players.set(id, this.createPlayerState(id, inputSource, carryover, spawn));
  }

  /** Determinism primitive every per-player simulation loop uses — iterating
   * `this.players` in `Map` insertion order would depend on connection
   * order, which two peers can observe differently; sorting by id gives
   * every player-order-dependent tie-break (first-match loot pickup,
   * nearest-target ties, …) the same deterministic answer everywhere. */
  private sortedPlayerIds(): PlayerId[] {
    return [...this.players.keys()].sort();
  }

  /** True for a real multiplayer session (host or guest), false for
   * single-player/replay — promotes the `localPlayerId !== LOCAL_PLAYER_ID`
   * comparison already used inline for the lore-terminal freeze bypass
   * (step 6c) into a named helper, reused by the multiplayer-only rules
   * added in step 8 (loot-drop no-op-if-owned, lore-overlay dismiss-only,
   * exit countdown). */
  private isMultiplayerSession(): boolean {
    return this.localPlayerId !== LOCAL_PLAYER_ID;
  }

  /** Multiplayer-only: closes this peer's own lore overlay, if one is open —
   * a no-op for a single-player instance (which dismisses its overlay
   * through the ordinary `simulate()` input pipeline instead, via
   * `interacted`/`clicked`) or if no overlay is open. Called directly by the
   * session driver, entirely outside `simulate()`'s per-tick pipeline — a
   * real Escape press is the one local, purely-cosmetic action with no
   * shared-simulation channel to carry it: `LocalInputSampler.sampleAndReset()`
   * forces `escape` to `false` before it ever reaches the shared input
   * stream (multiplayer-netcode-spec.md §6), so `local.input.consumeEscape()`
   * inside `simulate()` can never observe a real press for a multiplayer
   * peer. Reusing `interacted`/`clicked` instead (as single-player does)
   * isn't safe here: both carry real shared-simulation side effects (secret-
   * wall discovery, `fireQueued`) unrelated to closing a purely local
   * overlay. */
  dismissLoreOverlay(): void {
    if (!this.isMultiplayerSession()) return;
    const local = this.players.get(this.localPlayerId);
    if (local) local.loreText = null;
  }

  /** Read-only per-player snapshot for a session-lifecycle layer above this
   * engine to build an end-of-run comparison table from — not consumed by
   * anything in this step itself (deciding when/how to show it is later
   * steps' job), exercised only by this step's own tests. */
  rosterSnapshot(): ReadonlyMap<PlayerId, { status: PlayerStatus; health: number; killScore: number; kills: number; distanceTraveled: number }> {
    const snapshot = new Map<PlayerId, { status: PlayerStatus; health: number; killScore: number; kills: number; distanceTraveled: number }>();
    for (const [id, p] of this.players) {
      snapshot.set(id, { status: p.status, health: p.health, killScore: p.killScore, kills: p.kills, distanceTraveled: p.distanceTraveled });
    }
    return snapshot;
  }

  /** A specific roster player's current world position, or `null` if `id`
   * isn't a connected player — the only public way to read a *non-local*
   * player's position (every `?testHooks=1` position hook resolves
   * exclusively through `this.localPlayerId`). Needed by a multiplayer
   * session driver to verify two peers' simulations actually agree. */
  getPlayerPosition(id: PlayerId): { x: number; y: number } | null {
    const p = this.players.get(id);
    return p ? { x: p.player.posX, y: p.player.posY } : null;
  }

  /** A specific roster player's current facing direction, or `null` if `id`
   * isn't a connected player — read-only introspection, same spirit as
   * `getPlayerPosition`. Lets a verify script compute how far to turn toward
   * a target tile without needing to dead-reckon it from held-key duration,
   * which real (jittery, worker-timer-paced) wall-clock ticking can't
   * guarantee precisely, unlike the fixed-step unit-test environment. */
  getPlayerFacing(id: PlayerId): { dirX: number; dirY: number } | null {
    const p = this.players.get(id);
    return p ? { dirX: p.player.dirX, dirY: p.player.dirY } : null;
  }

  /** A specific roster player's current status, or `null` if `id` isn't a
   * connected player — read-only introspection, same spirit as
   * `getPlayerPosition`. Lets `scripts/verify-multiplayer-disconnect.mjs`
   * observe a peer flipping from `"alive"` to `"disconnected"`. */
  getPlayerStatus(id: PlayerId): PlayerStatus | null {
    return this.players.get(id)?.status ?? null;
  }

  /** Every currently-live loot drop, world-space, read-only. Lets
   * `scripts/verify-multiplayer-disconnect.mjs` observe a disconnected
   * player's inventory converting to loot (`source: "disconnect"`) at their
   * last known position — the only external way to read `this.drops`, which
   * has no other public surface (drops are collected/removed purely by
   * `simulate()`'s own per-tick loop). */
  getLootDrops(): readonly LootDrop[] {
    return this.drops;
  }

  /** This level's exit tile — read-only introspection, same spirit as
   * `getPlayerPosition`. Lets `scripts/verify-multiplayer-transition.mjs`
   * navigate a real peer onto the exit without needing a fake/simplified
   * map: the real, generated level's exit position, straight from the
   * engine actually running it. */
  getMapExit(): Point {
    return this.map.exit;
  }

  /** This level's walkable grid (`grid[y][x]`) — read-only introspection,
   * same spirit as `getMapExit`. Lets a verify script compute its own
   * walls-aware route to the exit client-side, the same way
   * `main.test.ts`'s own `bfsPath` helper does for single-player. */
  getMapGrid(): readonly Tile[][] {
    return this.map.grid;
  }

  /** The full generated `GameMap` this engine is running — read-only
   * introspection, same spirit as `getMapExit`/`getMapGrid` but exposing
   * everything real route-planning (`scripts/lib/routePlanner.mjs`'s
   * `planRoute`, driven by `scripts/lib/multiplayerBot.mjs`) needs —
   * doors/keys/rooms included, not just the two fields a plain bfs walker
   * needs. */
  getMap(): GameMap {
    return this.map;
  }

  /** Multiplayer-only equivalent of `__codeensteinTestHooks.getEnemies()` —
   * roster-agnostic (enemies aren't owned by any one player), identical
   * shape. Built for `scripts/lib/multiplayerBot.mjs`, the same way the
   * single-player hook was built for `scripts/lib/bot.mjs`. */
  getEnemiesSnapshot(): { x: number; y: number; alive: boolean; aggroed: boolean; elite: boolean; edgeCase: boolean; hp: number; maxHp: number }[] {
    return this.enemies.map((e) => ({
      x: e.x,
      y: e.y,
      alive: e.alive,
      aggroed: e.aggroed,
      elite: e.elite,
      edgeCase: e.edgeCase,
      hp: e.hp,
      maxHp: e.maxHp,
    }));
  }

  /** Multiplayer-only equivalent of `__codeensteinTestHooks.getMines()` —
   * roster-agnostic, identical shape. */
  getMinesSnapshot(): { x: number; y: number; alive: boolean; visible: boolean }[] {
    return this.map.mines.map((m) => ({ x: m.x, y: m.y, alive: m.alive, visible: m.visible }));
  }

  /** Multiplayer-only equivalent of `__codeensteinTestHooks.getPlayerState()`
   * for an arbitrary roster `id` — read-only introspection built for
   * `scripts/lib/multiplayerBot.mjs` to drive combat and navigation the same
   * way the single-player balancing bot already does. `state` maps this
   * player's own `PlayerStatus` onto the same `"playing"`/`"over"`
   * vocabulary `scripts/lib/bot.mjs`'s decision logic already expects —
   * multiplayer has no per-player `"won"` (a win is a whole-team, countdown-
   * gated event, see `checkExit()`), so a caller driving this bot toward the
   * exit needs to watch for that separately (e.g. `getExitCountdownRemaining()`)
   * once navigation itself completes. Returns `null` if `id` isn't a
   * connected player. */
  getBotPlayerState(id: PlayerId): {
    x: number;
    y: number;
    dirX: number;
    dirY: number;
    health: number;
    healthFraction: number;
    swap: number;
    state: "playing" | "over";
    ammo: AmmoPools;
    weaponIndex: number;
    meleeWouldHit: boolean;
    wouldMineHit: boolean;
    ownedWeapons: number[];
    levelTime: number;
    distanceTraveled: number;
  } | null {
    const p = this.players.get(id);
    if (!p) return null;
    const { meleeWouldHit, wouldMineHit } = this.computeMeleeAndMineHitChecks(id);
    return {
      x: p.player.posX,
      y: p.player.posY,
      dirX: p.player.dirX,
      dirY: p.player.dirY,
      health: p.health,
      healthFraction: p.health / MAX_HEALTH,
      swap: p.swap,
      state: p.status === "alive" ? "playing" : "over",
      ammo: { ...p.ammo },
      weaponIndex: p.weaponIndex,
      meleeWouldHit,
      wouldMineHit,
      ownedWeapons: [...p.ownedWeapons],
      levelTime: this.levelTime,
      distanceTraveled: p.distanceTraveled,
    };
  }

  /** Whether a quick-melee swing / the currently equipped ranged weapon
   * would connect right now, for `id` — shared by `__codeensteinTestHooks`'s
   * `getPlayerState()` (always `this.localPlayerId`) and
   * `getBotPlayerState(id)` (multiplayer, arbitrary roster id).
   *
   * `meleeWouldHit` mirrors `fire()`'s own crosshair-column hit test
   * (`findTargetInProjections` against the exact center column, in front of
   * the nearest wall) rather than a bot-side angle-only guess. A fixed
   * angle tolerance can't work here: a melee swing only lands within the
   * target's on-screen width, which shrinks with distance (even inside
   * melee range) and with an Edge Case's smaller sprite scale — a bot-side
   * static epsilon was found to let it "fire" while aimed well off the
   * target's actual hitbox, especially against Edge Cases near the far edge
   * of melee range (observed: hundreds of whiffed swings against one enemy
   * before giving up). See `scripts/run-balancing-telemetry.mjs`'s `tick()`
   * for the consumer.
   *
   * `wouldMineHit` is whether firing the *currently equipped ranged weapon*
   * right now is guaranteed to destroy whatever mine is at the crosshair —
   * mine hits go through the same screen-projection hit test as an enemy
   * (`findMineInProjections`, mirroring `findTargetInProjections`), but for
   * a *ranged* shot that also means the Cone-of-Fire deviation applies
   * (unlike melee, which is exempt). A bot picking its shot purely by angle
   * tolerance has no way to know the mine's on-screen width is narrower
   * than that tolerance at typical disarm range, so it can "fire" many
   * times while only occasionally actually connecting (confirmed via
   * trace: ~30 fire attempts at one stationary, perfectly-angle-aligned
   * mine before it finally died). Rather than expose the RNG'd deviation
   * itself (which would let a bot "peek" at the seeded PRNG's next draw
   * without consuming it, desyncing determinism from a real shot), this
   * checks the *worst case* deviation magnitude deterministically: only
   * true if the mine's projected width is wide enough that no possible
   * random deviation could miss it.
   */
  private computeMeleeAndMineHitChecks(id: PlayerId): { meleeWouldHit: boolean; wouldMineHit: boolean } {
    const p = this.players.get(id)!;
    // Self-sufficient, like `resolveShot()` — recomputed fresh here (rather
    // than reusing whatever `render()` last left in `p.zBuffer`, which is
    // only ever populated up to `this.ctx.canvas.width`, not necessarily
    // `SCENE_WIDTH`) so both checks below are correct regardless of the real
    // canvas's size or render timing.
    castWallDistances(this.map, p.player, SCENE_WIDTH, p.zBuffer);
    const meleeWouldHit = (() => {
      const melee = currentMeleeWeapon(p.ownedWeapons);
      // Unreachable: `currentMeleeWeapon` only ever returns the knife or
      // Toolchain, both hardcoded with `meleeRange: 1.5` — there's no
      // owned-weapons state that makes this undefined.
      /* v8 ignore next */
      if (melee.meleeRange === undefined) return false;
      const projections = projectLivingEnemies(p.player, this.enemies, SCENE_WIDTH, SCENE_HEIGHT);
      const target = findTargetInProjections(projections, p.zBuffer, SCENE_WIDTH, SCENE_HEIGHT, SCENE_WIDTH / 2);
      if (!target?.alive) return false;
      const dist = Math.hypot(target.x - p.player.posX, target.y - p.player.posY);
      return dist <= melee.meleeRange;
    })();
    const wouldMineHit = (() => {
      const weapon = WEAPONS[p.weaponIndex];
      if (weapon.meleeRange !== undefined) return false; // this is the ranged-shot check; see meleeWouldHit for melee
      const center = SCENE_WIDTH / 2;
      const mineProjections = projectVisibleMines(p.player, this.map.mines, SCENE_WIDTH, SCENE_HEIGHT);
      const target = findMineInProjections(mineProjections, p.zBuffer, SCENE_WIDTH, SCENE_HEIGHT, center);
      if (!target?.alive) return false;
      if (weapon.maxRange !== undefined) {
        const dist = Math.hypot(target.x - p.player.posX, target.y - p.player.posY);
        if (dist > weapon.maxRange) return false;
      }
      const proj = mineProjections.find((mp) => mp.mine === target)?.proj;
      // Unreachable: `target` is itself one of `mineProjections`' own
      // `mine` references (returned by `findMineInProjections` from that
      // exact array), so `.find` above always matches by identity.
      /* v8 ignore next */
      if (!proj) return false;
      const baseCol = Math.min(SCENE_WIDTH - 1, Math.max(0, Math.round(center)));
      const range = p.zBuffer[baseCol];
      const rangeFraction = Math.min(1, range / FOG_FAR);
      const maxDeviation = weapon.maxConeDeviationPx ?? MAX_CONE_DEVIATION_PX;
      const worstCaseDeviation = rangeFraction * rangeFraction * rangeFraction * maxDeviation;
      return center - worstCaseDeviation >= proj.left && center + worstCaseDeviation <= proj.right;
    })();
    return { meleeWouldHit, wouldMineHit };
  }

  /** Whether a player currently has a live, still-decaying drift-correction
   * render offset (`PlayerState.renderOffset`) — read-only introspection,
   * same spirit as `getPlayerPosition`. Lets
   * `scripts/verify-multiplayer-reconciliation.mjs` prove a below-
   * `SNAP_THRESHOLD_TILES` correction actually took the smoothed path, not
   * just that the simulated position converged (which `getPlayerPosition`
   * alone can't distinguish from an instant snap — the offset only affects
   * what's *rendered*, never the simulation value it returns). */
  hasActiveRenderOffset(id: PlayerId): boolean {
    return this.players.get(id)?.renderOffset != null;
  }

  /** The shared PRNG stream's current raw internal state — read-only
   * introspection, same spirit as `getPlayerPosition`. Needed by
   * `scripts/verify-multiplayer-reconciliation.mjs`: position/health alone
   * can't prove the PRNG stream itself resynced after a correction, since
   * two peers' *visible* state can coincidentally agree while their stream
   * *positions* have already diverged (see `applyReconciliationSnapshot`'s
   * own doc comment). */
  getRngState(): number {
    return this.rngHandle.getState();
  }

  /**
   * Test-only: deliberately perturbs local simulation state to synthesize a
   * cross-peer divergence, for `scripts/verify-multiplayer-reconciliation.mjs`
   * to prove the correction mechanism actually converges it back. Real
   * cross-engine float drift (confirmed by `scripts/poc-cross-browser-determinism.mjs`)
   * doesn't reliably appear within a short end-to-end run — it compounds
   * from single-ULP errors, which took roughly the first 1% of a
   * 500,000-iteration stress loop to surface there — so this stands in for
   * it under test. Unlike every other `?testHooks=1` hook (read-only
   * introspection, or a permanent no-op like `consumeCheat()`), this one
   * genuinely *mutates* simulation state — never called from real gameplay
   * code, only from a verify script working against its own `localPlayerId`.
   */
  debugInjectDesync(injection: { kind: "position"; deltaTiles: number } | { kind: "extraRngDraw" }): void {
    if (injection.kind === "position") {
      const local = this.players.get(this.localPlayerId)!;
      local.player.posX += injection.deltaTiles;
    } else {
      this.rng();
    }
  }

  /**
   * Host-only: build this tick's authoritative `ReconciliationSnapshot`
   * (`multiplayer-netcode-spec.md` §3) from live engine state, for
   * `multiplayerSessionHost.ts` to broadcast once every
   * `RECONCILE_INTERVAL_TICKS`. Drains `pendingGridDelta` — every tile
   * mutation since the *last* capture, not the last-ever mutation — so a
   * guest applying every successive snapshot in order sees every change
   * exactly once, cumulatively.
   */
  captureReconciliationSnapshot(tick: number): ReconciliationSnapshot {
    const players: Record<PlayerId, PlayerSnapshot> = {};
    for (const [id, p] of this.players) {
      // A disconnected player is no longer a *wire-level* roster member
      // (`multiplayer-netcode-spec.md` §5) — their `PlayerState` stays in
      // `this.players` forever (frozen, matching a dead player's own
      // treatment, so their final score survives for a later comparison
      // table), but they're excluded here, from bundle-building, and from
      // the elimination check.
      if (p.status === "disconnected") continue;
      players[id] = {
        posX: p.player.posX,
        posY: p.player.posY,
        dirX: p.player.dirX,
        dirY: p.player.dirY,
        planeX: p.player.planeX,
        planeY: p.player.planeY,
        health: p.health,
        swap: p.swap,
        ammo: { ...p.ammo },
        weaponIndex: p.weaponIndex,
        keysHeld: p.keysHeld,
        ownedWeapons: [...p.ownedWeapons].sort((a, b) => a - b),
        alive: p.status === "alive",
        killScore: p.killScore,
        kills: p.kills,
      };
    }

    const enemies: EnemySnapshot[] = this.enemies.map((e, index) => ({
      index,
      x: e.x,
      y: e.y,
      hp: e.hp,
      alive: e.alive,
      aggroed: e.aggroed,
    }));

    const mines: MineSnapshot[] = this.map.mines.map((m, index) => ({ index, alive: m.alive, visible: m.visible }));

    // Every drop was id-tagged at push time (pushLootDrop / killPlayer's own
    // key-drop path) — the `!` trusts that internal invariant rather than
    // filtering, matching this codebase's usual stance on guarantees the
    // engine itself upholds (see CLAUDE.md's "trust internal code" guidance).
    const lootDrops: LootDropSnapshot[] = this.drops.map((d) => ({
      id: d.id!,
      x: d.x,
      y: d.y,
      kind: d.kind,
      amount: d.amount,
      weaponIndex: d.weaponIndex,
      source: d.source,
    }));

    const pickupsCollected: number[] = [];
    this.map.ammoPickups.forEach((pickup, index) => {
      if (pickup.collected) pickupsCollected.push(index);
    });
    const keysCollected: number[] = [];
    this.map.keys.forEach((key, index) => {
      if (key.collected) keysCollected.push(index);
    });

    const gridDelta = this.pendingGridDelta.splice(0, this.pendingGridDelta.length);

    return {
      tick,
      rngState: this.rngHandle.getState(),
      players,
      enemies,
      mines,
      lootDrops,
      pickupsCollected,
      keysCollected,
      gridVersion: this.gridVersion,
      gridDelta,
    };
  }

  /**
   * Guest-only: overwrite local simulation state with the host's
   * authoritative `snapshot` (§4). Every field snaps immediately and in
   * full — continuing to simulate from a known-wrong value even one more
   * tick lets that tick's own `Math.sin`/`cos`/`atan2` calls compound *more*
   * drift on top of what's being corrected, the opposite of the goal.
   * Position specifically also captures a render-only offset (below
   * `SNAP_THRESHOLD_TILES`) or snaps the render position too (at/above it,
   * no offset at all) — see `PlayerState.renderOffset`'s doc comment.
   *
   * `rngState` is always overwritten unconditionally, with no magnitude
   * threshold: a PRNG stream position is either already byte-identical (the
   * write is a no-op) or it's completely wrong from this point forward,
   * never "off by a little" — skipping this because the *visible* fields
   * already matched would fix the symptom for exactly one tick and
   * guarantee a fresh divergence on the very next `rng()`-consuming
   * decision (how many draws a tick takes is itself state-dependent — see
   * `reconciliationSnapshot.ts`'s own doc comment).
   */
  applyReconciliationSnapshot(snapshot: ReconciliationSnapshot): void {
    const now = performance.now();

    for (const [id, ps] of Object.entries(snapshot.players)) {
      const p = this.players.get(id);
      if (!p) continue; // fixed 2-player roster today — a future roster change is a later step's job
      p.renderOffset = this.correctionRenderOffset({ x: p.player.posX, y: p.player.posY }, { x: ps.posX, y: ps.posY }, now);
      p.player.posX = ps.posX;
      p.player.posY = ps.posY;
      p.player.dirX = ps.dirX;
      p.player.dirY = ps.dirY;
      p.player.planeX = ps.planeX;
      p.player.planeY = ps.planeY;
      p.health = ps.health;
      p.swap = ps.swap;
      Object.assign(p.ammo, ps.ammo);
      p.weaponIndex = ps.weaponIndex;
      p.keysHeld = ps.keysHeld;
      p.ownedWeapons.clear();
      for (const w of ps.ownedWeapons) p.ownedWeapons.add(w);
      p.status = ps.alive ? "alive" : "dead";
      p.killScore = ps.killScore;
      p.kills = ps.kills;
    }

    for (const es of snapshot.enemies) {
      const e = this.enemies[es.index];
      if (!e) continue;
      const offset = this.correctionRenderOffset({ x: e.x, y: e.y }, { x: es.x, y: es.y }, now);
      if (offset) this.enemyRenderOffsets.set(es.index, offset);
      else this.enemyRenderOffsets.delete(es.index);
      e.x = es.x;
      e.y = es.y;
      e.hp = es.hp;
      e.alive = es.alive;
      e.aggroed = es.aggroed;
    }

    for (const ms of snapshot.mines) {
      const m = this.map.mines[ms.index];
      if (!m) continue;
      m.alive = ms.alive;
      m.visible = ms.visible;
    }

    const incomingIds = new Set(snapshot.lootDrops.map((d) => d.id));
    for (let i = this.drops.length - 1; i >= 0; i--) {
      // "" is never a real id (every drop is tagged at push time — see
      // pushLootDrop/killPlayer) — a safe sentinel for the optional-`id`
      // type without weakening the Set's element type to `string | undefined`.
      if (!incomingIds.has(this.drops[i].id ?? "")) this.drops.splice(i, 1);
    }
    for (const ds of snapshot.lootDrops) {
      const existing = this.drops.find((d) => d.id === ds.id);
      if (existing) {
        existing.x = ds.x;
        existing.y = ds.y;
        existing.kind = ds.kind;
        existing.amount = ds.amount;
        existing.weaponIndex = ds.weaponIndex;
        existing.source = ds.source;
      } else {
        this.drops.push({ ...ds });
      }
    }

    for (const index of snapshot.pickupsCollected) {
      const pickup = this.map.ammoPickups[index];
      if (pickup) pickup.collected = true;
    }
    for (const index of snapshot.keysCollected) {
      const key = this.map.keys[index];
      if (key) key.collected = true;
    }

    for (const mutation of snapshot.gridDelta) {
      if (this.map.grid[mutation.y]) this.map.grid[mutation.y][mutation.x] = mutation.value;
    }
    this.gridVersion = snapshot.gridVersion;

    this.rngHandle.setState(snapshot.rngState);
  }

  /**
   * A synchronized lockstep event (`multiplayer-netcode-spec.md` §5):
   * called by both session drivers for the tick a `TickInputBundle` carries
   * `rosterRemove`, so every peer — host included — applies the exact same
   * removal at the exact same tick. Marks each id `"disconnected"` (never
   * deleted from `this.players` — see `PlayerStatus`'s own doc comment) and
   * converts their inventory to ordinary `LootDrop`s at their last known
   * position, in the spec's fixed order: one entry per non-zero ammo pool,
   * then one `"weapon"` entry per owned-but-not-starting weapon (in
   * `WEAPONS`-index order), then one `"key"` entry per held key. Health/swap
   * are deliberately never dropped — no precedent elsewhere for handing
   * health between entities. A no-op for an id that's already gone or
   * already dead (nothing left to convert, and re-marking would be wrong).
   */
  applyRosterRemoval(ids: PlayerId[]): void {
    if (this.state !== "playing") return;
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p || p.status !== "alive") continue;
      p.status = "disconnected";

      let dropSeq = 0;
      for (const type of AMMO_TYPES) {
        if (p.ammo[type] <= 0) continue;
        this.drops.push({
          x: p.player.posX,
          y: p.player.posY,
          kind: type,
          amount: p.ammo[type],
          id: `disconnect:${id}:${dropSeq++}`,
          source: "disconnect",
        });
      }
      for (const weaponIndex of [...p.ownedWeapons].sort((a, b) => a - b)) {
        if (STARTING_WEAPONS.includes(weaponIndex)) continue;
        this.drops.push({
          x: p.player.posX,
          y: p.player.posY,
          kind: "weapon",
          weaponIndex,
          id: `disconnect:${id}:${dropSeq++}`,
          source: "disconnect",
        });
      }
      for (let i = 0; i < p.keysHeld; i++) {
        this.drops.push({
          x: p.player.posX,
          y: p.player.posY,
          kind: "key",
          amount: 1,
          id: `disconnect:${id}:${dropSeq++}`,
          source: "disconnect",
        });
      }
      p.keysHeld = 0;
    }
    if ([...this.players.values()].every((q) => q.status !== "alive")) this.endGame("over");
  }

  /** Shared position-correction decision for both players and enemies (§4):
   * a small delta returns a smoothed render offset for the caller to store;
   * a zero or large one returns `null` (no offset at all — not a
   * zero-length smooth, genuinely absent) so the render pass falls straight
   * back to reading the just-snapped simulation position. */
  private correctionRenderOffset(
    oldPos: { x: number; y: number },
    newPos: { x: number; y: number },
    nowMs: number,
  ): { x: number; y: number; capturedAtMs: number } | null {
    const x = oldPos.x - newPos.x;
    const y = oldPos.y - newPos.y;
    const distance = Math.hypot(x, y);
    if (distance === 0 || distance >= SNAP_THRESHOLD_TILES) return null;
    return { x, y, capturedAtMs: nowMs };
  }

  start(): void {
    if (this.running) return;
    this.primeForPlay();
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  /**
   * Everything `start()` does except scheduling the internal rAF loop —
   * attaching every player's input, warming up audio, revealing the spawn
   * tile, and the initial stats push. Split out so a multiplayer session can
   * get these same "ready to play" side effects without ever letting the
   * internal loop compete with (or feed a measured, non-fixed `dt` into) the
   * tick-driven `advance(FIXED_DT)` calls it makes itself.
   */
  private primeForPlay(): void {
    this.running = true;
    for (const p of this.players.values()) p.input.attach();
    // Warm up the audio context now, while we're still inside the user gesture
    // (the click that launched this level) so playback isn't blocked later.
    audio.resume();
    this.markVisited(); // reveal the spawn tile before the first step
    this.handlers.onStats?.(this.buildStats());
  }

  /**
   * For an externally-driven session (multiplayer, headless harnesses) that
   * calls `simulate()`/`render()`/`advance()` itself on its own pacing —
   * runs exactly the same "ready to play" side effects `start()` does,
   * without touching `rafId` or scheduling a frame. `stop()` still applies
   * afterward the same way (it's already idempotent on `running`), and
   * `advance()`'s own end-of-run handling already calls `stop()` for real
   * once the run ends, since `primeForPlay()` sets `running = true` here too.
   */
  startExternallyDriven(): void {
    if (this.running) return;
    this.primeForPlay();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const p of this.players.values()) p.input.detach();
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    let dt = rawDt;
    if (dt > MAX_DT) dt = MAX_DT;

    // Measured from the real, unclamped delta — using the clamped `dt` would
    // floor the reported FPS at a misleadingly-low ~20fps ceiling during any
    // real stutter or background-tab throttling.
    this.updateFpsCounter(rawDt);
    this.lastRawDtMs = rawDt * 1000;
    // Hand the unclamped delta to `advance()`'s own perf-frame begin (see
    // there) — a clamped `dt` would hide exactly the stalls perfDebug exists
    // to catch.
    this.perfRawDtMs = this.lastRawDtMs;
    this.advance(dt);

    if (this.running) this.rafId = requestAnimationFrame(this.frame);
  };

  /** Accumulate raw frame time toward the next averaged `displayFps` update,
   * and record this frame's raw time directly (no averaging — a single
   * stutter should be visible, not smoothed away). */
  private notifyFrozen(frozen: boolean): void {
    if (frozen === this.wasFrozen) return;
    this.wasFrozen = frozen;
    this.handlers.onFreezeChange?.(frozen);
  }

  private updateFpsCounter(rawDt: number): void {
    this.fpsAccumTime += rawDt;
    this.fpsAccumFrames += 1;
    this.displayFrameMs = rawDt * 1000;
    if (this.fpsAccumTime >= FPS_UPDATE_INTERVAL) {
      this.displayFps = Math.round(this.fpsAccumFrames / this.fpsAccumTime);
      this.fpsAccumTime = 0;
      this.fpsAccumFrames = 0;
    }
  }

  /**
   * Advance the simulation by one fixed tick, mutating all gameplay state
   * (position, AI, combat, effects physics) — draws nothing. Returns whether
   * this tick reached the full simulation path: `false` if it hit the
   * pause/lore-open early return (only input/overlay-state resolution ran),
   * `true` otherwise. `render()` always runs after this regardless of the
   * return value (see `advance()`) — `simulate()` resolves `isPaused`/
   * `loreText` to their final-for-this-tick values before returning either
   * way, and `render()` picks its own overlay variant from those, rather
   * than relying on this return value to skip drawing.
   */
  simulate(dt: number): boolean {
    // Gamepad axis/button state has no change events to listen for (unlike
    // keyboard/mouse), so it must be actively polled once per frame, for
    // every connected player's own input source — and before any of the
    // below reads any of the one-shot queues it can feed (fire/weapon-cycle/
    // melee), or a gamepad press made this frame would sit unconsumed until
    // the *next* frame's reads instead.
    for (const id of this.sortedPlayerIds()) this.players.get(id)!.input.pollGamepad();

    const local = this.players.get(this.localPlayerId)!;

    // Record this frame's full input state for the replay system, before
    // anything below consumes any of its one-shot flags — a non-destructive
    // peek (see `InputSnapshot`'s doc comment), so this has zero effect on
    // live play whether or not a recorder is actually attached. The explicit
    // guard (not `?.`) matters: an argument is evaluated before optional
    // chaining can short-circuit, so `?.` would still build the ~18-field
    // snapshot + filtered key array every frame of every recorder-less run.
    // Only ever records the local player's own input — see
    // `replayRecorder`'s doc comment.
    if (this.replayRecorder) this.replayRecorder.record(dt, local.input.captureSnapshot());

    // The FPS overlay toggles independent of pause/map/lore state, so it's
    // consumed unconditionally right here rather than gated behind any of
    // the early-return branches below. Local-only, same as pause/automap/
    // lore/cheats (see `simulate()`'s N-player scope note above).
    if (local.input.consumeFpsToggle()) local.showFps = !local.showFps;

    // Doom cheat codes are a debug/fun feature independent of pause/automap
    // state too, same reasoning as the FPS toggle above.
    const cheat = local.input.consumeCheat();
    if (cheat) this.applyCheat(local, cheat);
    this.perf?.mark("input-poll");

    // A blur (window losing focus entirely, or the canvas losing focus to
    // some other on-page control) or a pointer-lock release always forces a
    // pause — never a toggle, you can't "un-blur" by pressing something while
    // unfocused; Escape toggles it explicitly, and a click resumes it. Always
    // drain the click flag regardless of pause state, so a stale click can't
    // instantly resume some later, unrelated pause. Checked first so a pause
    // always wins over the automap and normal play.
    //
    // Escape is resolved as authoritative over a blur/pointer-unlock that
    // lands in the same frame, rather than as three independent writes — see
    // `InputController.onPointerLockChange`'s doc comment for why a
    // pointer-lock release is even tracked as its own signal separate from
    // Escape's own (unreliable, during real pointer-locked play) keydown.
    // Whenever a real Escape keydown *does* also land in the same frame
    // (e.g. the player wasn't pointer-locked in the first place), resolving
    // both as independent `isPaused` writes would let them cancel each other
    // out depending on order (one sets `true`, the other flips it back to
    // `false`) — Escape taking priority whenever it fires avoids that.
    //
    // Pause/automap/lore stay strictly local-player, byte-identical to
    // single-player: real coop pause semantics (should one player pausing
    // freeze a teammate's simulation?) are a later netcode step's job — this
    // step keeps the single early-return gate exactly as it always was, which
    // at N=1 is trivially "the same thing" as a real per-team pause.
    const clicked = local.input.consumeClick();
    const blurred = local.input.consumeBlur();
    const pointerUnlocked = local.input.consumePointerUnlock();
    const escaped = local.input.consumeEscape();
    if (escaped) {
      local.isPaused = !local.isPaused;
    } else if (blurred || pointerUnlocked) {
      local.isPaused = true;
    }
    if (local.isPaused && clicked) local.isPaused = false;
    if (local.isPaused) {
      this.notifyFrozen(true);
      return false;
    }

    // Tab toggles the automap. Non-blocking — sim keeps running (movement,
    // combat, hazards) while it's shown; only a few purely-visual layers are
    // suppressed while it's open (see `renderNormalFrame`).
    if (local.input.consumeMapToggle()) local.isMapActive = !local.isMapActive;

    // Lore terminal overlay: opened/closed by "R", independent of Tab/Esc.
    // Checked before weapon switching / simulation so both freeze the sim the
    // same way the automap does. A second interact (or a click) dismisses it;
    // otherwise holding W/S scrolls the text (movement is never simulated
    // this frame, so repurposing those keys here doesn't fight `handleMovement`).
    //
    // Multiplayer-only exception (see `multiplayer-netcode-spec.md` §6): none
    // of this — freeze, dismiss, scroll — applies to a non-`LOCAL_PLAYER_ID`
    // instance. The tick keeps simulating underneath the overlay (never
    // frozen), it's static (no W/S scroll: those keys drive real shared
    // movement, so repurposing them here would actually move the player in
    // the live simulation while the overlay is open), and it's dismissed
    // exclusively via `dismissLoreOverlay()`, called directly by the session
    // driver — see that method's own doc comment for why.
    const interacted = local.input.consumeInteract();
    if (local.loreText !== null && !this.isMultiplayerSession()) {
      if (interacted || clicked) {
        local.loreText = null;
      } else {
        if (local.input.isDown("KeyS")) local.loreScroll += LORE_SCROLL_SPEED * dt;
        if (local.input.isDown("KeyW")) local.loreScroll = Math.max(0, local.loreScroll - LORE_SCROLL_SPEED * dt);
      }
      this.notifyFrozen(true);
      return false;
    }
    this.notifyFrozen(false);
    // Secret-wall/lore-terminal *discovery* runs for any living player's own
    // interact (shared world state — see `tryOpenSecretWall`'s doc comment);
    // only the local player's own interact can open the *overlay* (freezing
    // this tick) — a remote player's terminal read still banks the shared
    // score bonus but doesn't freeze/return for this peer's tick.
    if (this.state === "playing") {
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        // Secret walls are checked first: that check is facing/reach-based
        // (only the exact tile directly ahead, within `SECRET_WALL_REACH`), a
        // far more deliberate action than the lore terminal's generous
        // omnidirectional proximity radius — without this ordering, any lore
        // terminal within `LORE_INTERACT_RADIUS` (which is more than double
        // the secret-wall reach) would always win, even while squarely facing
        // a fake wall.
        const pInteracted = id === this.localPlayerId ? interacted : p.input.consumeInteract();
        if (!pInteracted) continue;
        if (this.tryOpenSecretWall(p)) continue;
        const terminal = findNearbyLoreTerminal(this.map.loreTerminals, p.player.posX, p.player.posY);
        if (!terminal) continue;
        audio.playSecret();
        const key = `${terminal.x},${terminal.y}`;
        if (!this.loreRead.has(key)) {
          this.loreRead.add(key);
          console.log("%c[lore] terminal logged — exploration bonus earned", "color:#78c8d2");
        }
        if (id === this.localPlayerId) {
          local.loreText = terminal.text;
          local.loreScroll = 0;
          // See the multiplayer-only exception noted above this loop's own
          // sibling branch: same bypass, same reasoning.
          if (!this.isMultiplayerSession()) return false;
        }
      }
    }

    // Weapon switching (1/2/… or mousewheel) can happen even while lining up
    // a shot — but only among ranged weapons that player actually owns (see
    // `ownedWeapons`); an unearned slot just does nothing, rather than
    // switching to a weapon with no way to have gotten it yet. Melee is
    // structurally excluded (see `canWieldViaNumberKey`) — it's bound to
    // Space as its own quick-attack action instead (below). `requested`
    // is a 0-based number-key *slot* (digit 1 -> 0), not a raw `WEAPONS`
    // index — routed through `NUMBER_KEY_WEAPONS` so the melee exclusion
    // above doesn't leave a dead key in the middle of the number row (see
    // its doc comment). Every living player switches independently.
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      const requested = p.input.consumeWeaponRequest();
      if (requested !== null) {
        const targetIndex = NUMBER_KEY_WEAPONS[requested];
        if (targetIndex !== undefined && this.canWieldViaNumberKey(p, targetIndex)) {
          p.weaponIndex = targetIndex;
        }
      }

      const wheelSteps = p.input.consumeWheelSteps();
      if (wheelSteps !== 0) {
        const direction = wheelSteps > 0 ? 1 : -1; // scroll down = next weapon
        for (let i = 0; i < Math.abs(wheelSteps); i++) this.cycleWeapon(p, direction);
      }
    }

    // Quick-melee: an instant swing (or, for Toolchain, a held-down chain of
    // them) independent of whatever ranged weapon is equipped/owned/cooling
    // down — see `fire()`'s doc comment and the `meleeRecoil`-driven
    // viewmodel overlay in `renderNormalFrame`. `currentMeleeWeapon`
    // resolves to the knife until Toolchain is owned, then Toolchain
    // permanently (it replaces the knife on Space, not a second slot). Every
    // living player swings independently.
    if (this.state === "playing") {
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const melee = currentMeleeWeapon(p.ownedWeapons);
        if (p.meleeCooldown > 0) p.meleeCooldown = Math.max(0, p.meleeCooldown - dt);
        if (melee.auto) {
          // Drain the one-shot edge so it can't "replay" as a stray knife
          // swing if the player somehow loses Toolchain mid-swing.
          p.input.consumeMelee();
          if (p.input.isMeleeHeld() && p.meleeCooldown <= 0) {
            this.fire(p, melee);
            p.meleeRecoil = 1;
            // Not reachable via current WEAPONS data — Toolchain, the only
            // `auto: true` melee weapon today, always defines fireIntervalSec —
            // but a future auto melee weapon omitting it should still get a
            // sane cooldown instead of firing every frame.
            /* v8 ignore next */
            p.meleeCooldown = melee.fireIntervalSec ?? 0.15;
          }
        } else if (p.input.consumeMelee()) {
          this.fire(p, melee);
          p.meleeRecoil = 1;
        }
      }
    }
    this.perf?.mark("input-actions");

    // Simulate (may end the game via damage or reaching the exit).
    this.levelTime += dt;
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status === "dead") {
        // Repurpose `consumeFire()` to cycle which living teammate's camera
        // this dead player's render pass follows (see `cycleSpectateTarget`).
        // Every other one-shot input flag still drains so nothing queues up
        // and "replays" on revive; `handleMovement` is skipped entirely —
        // position stays frozen exactly where they died (see `killPlayer`'s
        // doc comment).
        if (p.input.consumeFire()) this.cycleSpectateTarget(p);
        p.input.consumeMouseDX();
        p.input.consumeWeaponRequest();
        p.input.consumeMapToggle();
        p.input.consumeInteract();
        p.input.consumeMelee();
        p.input.consumeWheelSteps();
        p.input.consumeFpsToggle();
        p.input.consumeCheat();
        p.input.consumeEscape();
        p.input.consumeBlur();
        p.input.consumePointerUnlock();
        p.input.consumeClick();
        continue;
      }
      this.handleMovement(p, dt);
    }
    this.markVisited();
    this.updateRoomDiscovery();
    this.collectKeys();
    this.collectLoot();
    this.openDoorAhead();
    this.checkTeleporters();
    this.updateEnemyAi(dt);
    this.updateProjectiles(dt);
    this.advanceRockets(dt);
    this.applyHazardDamage(dt);
    this.applyTrapDamage(dt);
    if (this.telemetry) {
      updateMinHealth(this.telemetry, local.health);
      updateTelemetryPerFrame(this.telemetry, dt, local.health / MAX_HEALTH, local.ammo.bullets + local.ammo.smg + local.ammo.gas);
    }
    this.updateLowHealthAlarm(dt);
    this.checkExit();
    this.perf?.mark("sim");

    // Head-bob / recoil offsets for this frame (camera + weapon) — stashed
    // on each player's own `viewOffsets` for `render()` to read, since it has
    // no `dt` of its own to integrate against.
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      p.viewOffsets = this.updateViewmodel(p, dt);
    }
    this.perf?.mark("viewmodel");

    if (this.state === "playing") this.updateFiring(dt);
    this.perf?.mark("firing");

    // Physics integration for in-world impact particles (falling blood,
    // rocket-blast VFX rings, burn embers) — dt-integrated, so like
    // `updateViewmodel` above it has to run here rather than in `render()`.
    // `renderNormalFrame()` only draws whatever this leaves behind.
    updateBlood(this.blood, dt, this.goreMultipliers.stainDuration);
    updateExplosions(this.explosions, dt);
    updateExplosionParticles(this.explosionParticles, dt);
    updateBurnParticles(this.burnParticles, dt);

    return true;
  }

  /**
   * Draw exactly one frame from whatever `simulate()` last left in `this` —
   * no `dt`, no gameplay-state mutation. Picks its own overlay variant from
   * state rather than trusting `simulate()`'s return value, since
   * `advance()` calls this unconditionally regardless of which path
   * `simulate()` took this tick — see `simulate()`'s doc comment for why
   * that still reproduces today's exact pause-beats-lore-beats-normal
   * precedence.
   */
  render(): EngineStats {
    const restoreOffsets = this.applyRenderOffsets();
    try {
      const local = this.players.get(this.localPlayerId)!;
      if (local.isPaused) return this.renderPausedOverlay();
      if (local.loreText !== null) return this.renderLoreOverlay();
      return this.renderNormalFrame();
    } finally {
      restoreOffsets();
    }
  }

  /**
   * Temporarily nudges every player/enemy with a live drift-correction
   * render offset (`PlayerState.renderOffset`/`enemyRenderOffsets`) toward
   * their real simulated position, for exactly the duration of one render
   * pass — restored immediately after via the returned closure, so the next
   * `simulate()` tick always resumes from the true, already-snapped
   * position (§4: the *simulation* value is never perturbed, only what's
   * drawn). Mutating the live `Player`/`Enemy` objects directly, rather than
   * threading an offset through every render helper (`renderScene`,
   * `collectEnemyBillboards`, `collectPlayerBillboards`, the minimap, …),
   * since all of those already read straight off `this.players`/
   * `this.enemies` — this is the one seam that reaches every one of them at
   * once, no render-path restructuring needed.
   *
   * Decays each offset by real elapsed wall-clock time
   * (`performance.now() - capturedAtMs`) against `CORRECTION_SMOOTH_MS`,
   * clearing it once fully decayed — independent of the simulation tick
   * rate even though render itself still runs tick-paced today (see step
   * 7's own render-cadence decision, flagged for revisit once full render
   * decoupling has a concrete reason to exist).
   */
  private applyRenderOffsets(): () => void {
    const now = performance.now();
    const restores: Array<() => void> = [];

    for (const p of this.players.values()) {
      const offset = p.renderOffset;
      if (!offset) continue;
      const elapsedMs = now - offset.capturedAtMs;
      if (elapsedMs >= CORRECTION_SMOOTH_MS) {
        p.renderOffset = null;
        continue;
      }
      const factor = 1 - elapsedMs / CORRECTION_SMOOTH_MS;
      const dx = offset.x * factor;
      const dy = offset.y * factor;
      p.player.posX += dx;
      p.player.posY += dy;
      restores.push(() => {
        p.player.posX -= dx;
        p.player.posY -= dy;
      });
    }

    for (const [index, offset] of this.enemyRenderOffsets) {
      const enemy = this.enemies[index];
      // Unreachable: an offset is only ever added (applyReconciliationSnapshot)
      // for an index already checked against this.enemies, and this.enemies
      // never shrinks at runtime (entries go alive: false, never removed) —
      // kept as a defensive guard against a future change to either
      // invariant, not because this can happen today.
      /* v8 ignore next 4 */
      if (!enemy) {
        this.enemyRenderOffsets.delete(index);
        continue;
      }
      const elapsedMs = now - offset.capturedAtMs;
      if (elapsedMs >= CORRECTION_SMOOTH_MS) {
        this.enemyRenderOffsets.delete(index);
        continue;
      }
      const factor = 1 - elapsedMs / CORRECTION_SMOOTH_MS;
      const dx = offset.x * factor;
      const dy = offset.y * factor;
      enemy.x += dx;
      enemy.y += dy;
      restores.push(() => {
        enemy.x -= dx;
        enemy.y -= dy;
      });
    }

    return () => {
      for (const restore of restores) restore();
    };
  }

  /**
   * Advance the simulation and render exactly one frame over `dt` seconds.
   * Normally called by the internal rAF loop; exposed so the game can also be
   * driven at a fixed step (e.g. headless/deterministic runs). A thin
   * composition of `simulate()`/`render()` — kept as one public entry point
   * so every existing caller (the internal rAF `frame()`, the replay
   * viewer's `step`/`burstTo`, headless harnesses) needs zero changes.
   */
  advance(dt: number): void {
    // Begin the perf-debug frame here, not in `frame()` — `advance()` is
    // public and also driven directly by the replay viewer (`main.ts`'s
    // `step`/`burstTo`) and headless harnesses, and those callers used to
    // skip `beginFrame` entirely, leaving `FramePerfLogger`'s phase map
    // accumulating monotonically across the whole session (garbage
    // `?perfDebug=1` output during replay watching — audit finding F21).
    // `frame()` stashes the real unclamped delta in `perfRawDtMs`; a direct
    // caller's best equivalent is its own `dt`.
    if (this.perf) {
      this.perf.beginFrame(this.perfRawDtMs ?? dt * 1000);
      this.perfRawDtMs = undefined;
    }
    const progressed = this.simulate(dt);
    const stats = this.render();
    this.perf?.endFrame(() => {
      const local = this.players.get(this.localPlayerId)!;
      return {
        enemiesAlive: this.enemies.filter((e) => e.alive).length,
        enemiesTotal: this.enemies.length,
        eliteEnemies: this.enemies.filter((e) => e.elite).length,
        edgeCaseEnemies: this.enemies.filter((e) => e.edgeCase).length,
        mines: this.map.mines.length,
        enemyBolts: this.projectiles.length,
        rockets: this.rockets.length,
        traces: this.traces.length,
        flameStreams: this.flameStreams.length,
        blood: this.blood.length,
        explosions: this.explosions.length,
        explosionParticles: this.explosionParticles.length,
        burnParticles: this.burnParticles.length,
        ammo: { ...local.ammo },
        weaponName: WEAPONS[local.weaponIndex].name,
        audioShotCount: audio.getShotCount(),
        audioCtxState: audio.getContextState(),
      };
    });

    // Age the frame-based effect timers now that this frame is drawn — only
    // on ticks that reached the full simulation path (`progressed`): a
    // paused/lore-open tick already skipped this before the split too, and
    // must keep doing so, since `tickEffects()`'s frame-counted decay
    // (muzzle flash, cheat toast, hit flash) has to freeze while paused
    // rather than keep ticking toward zero underneath the overlay. This
    // can't fold into `simulate()` itself either: `cheatToastFrames` is SET
    // (via `applyCheat`, unconditionally, before pause is even resolved)
    // strictly before `simulate()` knows whether this tick is about to
    // pause — a same-tick decrement there would shave the cheat toast one
    // frame short on its first visible tick. NOTE for a future
    // decoupled-render step: this bracketing relies on `render()` running
    // exactly once immediately after every `simulate()` call — once
    // rendering decouples to its own cadence, this most likely moves fully
    // inside `simulate()` (running unconditionally once per tick), since the
    // byte-identical "visible for exactly N frames" concern this solves
    // stops applying once render is decoupled and smoothed by construction.
    if (progressed) this.tickEffects();

    // Fire the end-of-run handler last, once this frame is fully painted —
    // see `endGame()`'s doc comment for why this can't happen any earlier.
    if (this.state !== "playing") {
      this.stop();
      if (this.state === "over") this.handlers.onGameOver?.(stats);
      else this.handlers.onWin?.(stats);
    }
  }

  /**
   * The normal (not paused, not lore-open) render path — walls, billboards,
   * particle/effect draws, weapon viewmodel, minimap/automap, HUD. One final
   * frozen frame is still drawn after the game ends (`advance()` fires the
   * end-of-run handlers only after `render()` returns).
   */
  private renderNormalFrame(): EngineStats {
    const local = this.players.get(this.localPlayerId)!;
    const camera = this.effectiveCameraFor(this.localPlayerId);
    const view = local.viewOffsets;
    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, camera, local.zBuffer, textures.getActiveSet(), view.horizonShift, this.levelTime, this.loreRead);
    this.perf?.mark("raycast-walls");
    this.renderWorldBillboards(camera, local.zBuffer);

    this.target = findTargetUnderCrosshair(
      camera,
      this.enemies,
      local.zBuffer,
      width,
      height,
    );
    this.perf?.mark("billboards+targeting");

    // In-world impact effects (above sprites): falling "digital blood", the
    // muzzle→impact tracer lines from any shot fired this frame, and any live
    // rocket-blast VFX circles. The physics integration for these already ran
    // in `simulate()` (right after `updateFiring`) — this only draws
    // whatever that left behind.
    renderBlood(this.ctx, camera, this.blood, local.zBuffer, this.goreMultipliers.size);
    drawBulletTraces(this.ctx, this.traces);
    drawFlameStreams(this.ctx, width, height, this.flameStreams);
    renderExplosions(this.ctx, camera, this.explosions, local.zBuffer);
    renderExplosionParticles(this.ctx, camera, this.explosionParticles, local.zBuffer);
    renderBurnParticles(this.ctx, camera, this.burnParticles, local.zBuffer);
    this.perf?.mark("particle-effects");

    // Full-screen red flash when the player is taking damage.
    drawDamageFlash(this.ctx, local.flashFrames / DAMAGE_FLASH_FRAMES);

    // First-person weapon and corner minimap/compass: visual clutter the
    // automap would immediately cover, so they're skipped while it's open
    // rather than drawn and instantly painted over. A quick-melee swing
    // briefly overlays the knife's viewmodel on top of whatever ranged
    // weapon is actually equipped — weaponIndex, ammo, and the HUD are
    // untouched throughout (see `meleeRecoil`'s doc comment).
    if (!local.isMapActive) {
      const meleeOverlayActive = local.meleeRecoil > 0.02;
      drawWeapon(this.ctx, {
        bobX: view.bobX,
        bobY: view.bobY,
        recoil: meleeOverlayActive ? local.meleeRecoil : local.recoil,
        flash: meleeOverlayActive ? false : local.muzzleFrames > 0,
        kind: meleeOverlayActive ? currentMeleeWeapon(local.ownedWeapons).viewKind : WEAPONS[local.weaponIndex].viewKind,
      });

      const minimapPanel = renderMinimap(this.ctx, this.map, camera, this.levelTime, 70, this.loreRead, this.gridVersion);
      drawCompass(
        this.ctx,
        minimapPanel.compassBadge,
        camera.posX,
        camera.posY,
        Math.atan2(camera.dirY, camera.dirX),
        this.map.exit.x + 0.5,
        this.map.exit.y + 0.5,
      );
    }

    // Diablo-style automap overlay: drawn on top of the still-live 3D scene
    // (sim never stops for it, unlike `isPaused`/`loreText`) — see automap.ts.
    if (local.isMapActive) {
      drawAutomap(this.ctx, this.map, camera, this.levelTime);
    }

    // Crosshair stays visible (and on top of the automap, not dimmed by its
    // translucent panel) even with the map open — the player can still aim
    // and fire while it's up, so the aim point should still be shown.
    drawCrosshair(this.ctx, this.target !== null, WEAPONS[local.weaponIndex].spreadPx);

    // Native HUD sits on top of the whole scene, automap included, so
    // health/ammo/keys always stay visible and live.
    const stats = this.buildStats();
    drawHud(this.ctx, stats);
    if (local.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    // Transient feedback only — not drawn in the paused/automap/lore render
    // branches, unlike the FPS overlay, since a 2-second confirmation
    // toast isn't meant to persist across those states the way a standing
    // debug readout is.
    if (local.cheatToastText && local.cheatToastFrames > 0) {
      drawCheatToast(this.ctx, local.cheatToastText, local.cheatToastFrames / CHEAT_TOAST_FRAMES);
    }
    // Same "transient feedback only" treatment as the cheat toast above.
    if (local.killStreakText && local.killStreakFrames > 0) {
      drawKillStreakToast(
        this.ctx,
        local.killStreakText,
        local.killStreakFrames / KILL_STREAK_TOAST_FRAMES,
        local.killStreakBig,
      );
    }
    // Multiplayer-only (see `checkExit()`) — a quiet, standing readout
    // (unlike the transient toasts above) while any player counts down to
    // the level ending. Only drawn on this normal-frame path, same as the
    // toasts above — automap/lore/paused each render through their own
    // separate branch below and skip it, matching this file's existing
    // convention for every other transient/standing overlay.
    if (this.exitCountdownRemaining !== null) {
      drawExitCountdownToast(this.ctx, this.exitCountdownRemaining);
    }
    this.handlers.onStats?.(stats);
    this.perf?.mark("hud");
    return stats;
  }

  /**
   * Render one frozen frame with the "PAUSED" scrim on top — triggered by
   * window blur or Escape. Distinct from the Tab automap, which no longer
   * freezes the sim — see `simulate()`.
   */
  private renderPausedOverlay(): EngineStats {
    const local = this.players.get(this.localPlayerId)!;
    const camera = this.effectiveCameraFor(this.localPlayerId);
    renderScene(this.ctx, this.map, camera, local.zBuffer, textures.getActiveSet(), 0, this.levelTime, this.loreRead);
    this.renderWorldBillboards(camera, local.zBuffer);
    drawPauseOverlay(this.ctx);
    if (local.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    const stats = this.buildStats();
    this.handlers.onStats?.(stats);
    return stats;
  }

  /**
   * Render one frozen frame with a lore terminal's comment text on top —
   * triggered by "R" near a `LORE_TILE` (see `simulate()`), dismissed by
   * another interact or a click. Only ever called by `render()`'s own
   * `local.loreText !== null` guard, so `loreText` is always a real string
   * here — unlike pre-split code, which also called this directly at the
   * exact moment `simulate()`'s dismiss branch had just nulled it out
   * (rendering one stray blank-text overlay frame before falling back to
   * normal next tick); `render()` re-deriving its overlay choice from
   * current state instead removes that one-frame flash rather than
   * preserving it — a deliberate, harmless side effect of `render()` being a
   * pure function of state (required so it can be called repeatedly with no
   * intervening `simulate()`, once rendering decouples from the tick rate).
   */
  private renderLoreOverlay(): EngineStats {
    const local = this.players.get(this.localPlayerId)!;
    const camera = this.effectiveCameraFor(this.localPlayerId);
    renderScene(this.ctx, this.map, camera, local.zBuffer, textures.getActiveSet(), 0, this.levelTime, this.loreRead);
    this.renderWorldBillboards(camera, local.zBuffer);
    const { maxScrollLines } = drawLoreOverlay(this.ctx, local.loreText as string, local.loreScroll);
    local.loreScroll = Math.max(0, Math.min(local.loreScroll, maxScrollLines));
    if (local.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    const stats = this.buildStats();
    this.handlers.onStats?.(stats);
    return stats;
  }

  /**
   * Open the fake wall directly ahead of `p`, if there is one — the whole
   * secret room behind it (not just the one tile faced) is carved as
   * `SECRET_WALL_TILE` (see `placeSecretRooms`/`trySecretRoomOffAnchor`), so
   * every 4-connected `SECRET_WALL_TILE` cell reachable from the tile opened
   * is flood-filled to plain floor at once, revealing the room in full for
   * the whole team. Also logs the door tile into `secretRoomsOpened`, feeding
   * the scoring system's flat per-room discovery bonus (same pattern as
   * `loreRead`) — any living player's own interact can trigger this (see
   * `simulate()`), and the shared flood-fill/`secretRoomsOpened` add apply
   * once, regardless of who triggered it. Returns whether a wall was
   * actually opened, so the interact handler can fall back to checking for a
   * nearby lore terminal when it wasn't.
   */
  private tryOpenSecretWall(p: PlayerState): boolean {
    const px = p.player.posX + p.player.dirX * SECRET_WALL_REACH;
    const py = p.player.posY + p.player.dirY * SECRET_WALL_REACH;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (this.map.grid[cy]?.[cx] !== SECRET_WALL_TILE) return false;

    this.secretRoomsOpened.add(`${cx},${cy}`);
    const grid = this.map.grid;
    const stack: Point[] = [{ x: cx, y: cy }];
    while (stack.length > 0) {
      const { x, y } = stack.pop()!;
      if (grid[y]?.[x] !== SECRET_WALL_TILE) continue;
      grid[y][x] = 0;
      this.pendingGridDelta.push({ x, y, value: 0 });
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }
    this.gridVersion += 1;
    audio.playSecret();
    console.log(
      "%c[secret] a section of wall slides open — a hidden room lies beyond — exploration bonus earned",
      "color:#e06aff;font-weight:bold",
    );
    return true;
  }

  /** A living, connected teammate `viewerId` can see — never the viewer
   * themselves and never a dead teammate (see `OtherPlayerBillboard`'s doc
   * comment). Sorted-order, stable per-id color. */
  private collectOtherPlayerBillboards(viewerId: PlayerId): OtherPlayerBillboard[] {
    const others: OtherPlayerBillboard[] = [];
    for (const id of this.sortedPlayerIds()) {
      if (id === viewerId) continue;
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      others.push({ player: p.player, color: colorForPlayer(id) });
    }
    return others;
  }

  /**
   * Draw every world billboard category (enemies, projectiles, rockets, keys,
   * loot drops, static ammo pickups, the exit marker, teleporters,
   * decorations, mines, other players) in one combined pass, sorted
   * furthest-to-nearest so nearer items always paint over farther ones —
   * regardless of which category they belong to. Drawing category-by-category
   * in a fixed order used to let a later category (e.g. the exit marker,
   * always drawn last) paint over a nearer item from an earlier one (e.g. a
   * loot drop), making it vanish even though it was actually closer to the
   * player. `camera`/`zBuffer` are the local player's own effective camera
   * (see `effectiveCameraFor`) and zBuffer — `render()` stays strictly
   * local-player (see its doc comment), so "the viewer" for
   * `collectOtherPlayerBillboards`'s exclusion is always `this.localPlayerId`.
   */
  private renderWorldBillboards(camera: Player, zBuffer: Float64Array): void {
    const jobs: BillboardJob[] = [
      ...collectDecorationBillboards(this.ctx, camera, this.map.decorations, zBuffer),
      ...collectTeleporterBillboards(this.ctx, camera, this.map.teleporters, zBuffer),
      ...collectMineBillboards(this.ctx, camera, this.map.mines, zBuffer),
      ...collectEnemyBillboards(this.ctx, camera, this.enemies, zBuffer),
      ...collectProjectileBillboards(this.ctx, camera, this.projectiles, zBuffer),
      ...collectRocketBillboards(this.ctx, camera, this.rockets, zBuffer),
      ...collectKeyBillboards(this.ctx, camera, this.map.keys, zBuffer),
      ...collectLootBillboards(this.ctx, camera, this.drops, zBuffer),
      ...collectLootBillboards(
        this.ctx,
        camera,
        this.map.ammoPickups.filter((p) => !p.collected),
        zBuffer,
      ),
      ...collectPlayerBillboards(this.ctx, camera, this.collectOtherPlayerBillboards(this.localPlayerId), zBuffer),
      ...collectExitBillboard(this.ctx, camera, this.map.exit, zBuffer),
    ];
    jobs.sort((a, b) => b.depth - a.depth);
    for (const job of jobs) job.draw();
  }

  /** Fog of war: reveal every tile within `VISITED_REVEAL_RADIUS` tiles of the
   * player (a circle, not a square, so the reveal is a clean disc rather than
   * a diamond-cornered blob). Also feeds `visitedWalkableCount` (the
   * map-completion score bonus's numerator) incrementally, counting a tile
   * only the first time it's newly revealed. */
  private markVisited(): void {
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      this.markVisitedAround(p.player.posX, p.player.posY);
    }
  }

  /** The actual disc-reveal for one point — factored out of `markVisited` so
   * every living player's own radius can reveal for the whole team (shared
   * `map.visited`/`visitedWalkableCount` — see §5's fog-of-war decision). */
  private markVisitedAround(px: number, py: number): void {
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const r = VISITED_REVEAL_RADIUS;
    const rSq = r * r;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= this.map.height) continue;
      const dy = y - cy;
      const row = this.map.visited[y];
      const tileRow = this.map.grid[y];
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= this.map.width || row[x]) continue;
        const dx = x - cx;
        if (dx * dx + dy * dy > rSq) continue;
        row[x] = true;
        if (isWalkableTile(tileRow[x])) this.visitedWalkableCount += 1;
      }
    }
  }

  /**
   * Reveal each not-yet-discovered enemy once any living player's collision
   * box (an AABB centered on their position) intersects that enemy's room —
   * its `home` rectangle. Sticky: a discovered enemy stays visible on the
   * minimap even after every player leaves the room.
   */
  private updateRoomDiscovery(): void {
    for (const enemy of this.enemies) {
      if (enemy.discovered) continue;
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const r = p.player.radius;
        const px = p.player.posX;
        const py = p.player.posY;
        const home = enemy.home;
        const intersects =
          px + r > home.x && px - r < home.x + home.w && py + r > home.y && py - r < home.y + home.h;
        if (intersects) {
          enemy.discovered = true;
          break;
        }
      }
    }
  }

  /** Advance the frame-based visual-effect timers by one frame, for every
   * connected player (dead or alive — a residual flash/toast still fades out
   * normally after death). */
  private tickEffects(): void {
    for (const p of this.players.values()) {
      if (p.flashFrames > 0) p.flashFrames -= 1;
      if (p.muzzleFrames > 0) p.muzzleFrames -= 1;
      if (p.cheatToastFrames > 0) p.cheatToastFrames -= 1;
      if (p.killStreakFrames > 0) p.killStreakFrames -= 1;
    }
    tickBulletTraces(this.traces);
    tickFlameStreams(this.flameStreams);
    for (const enemy of this.enemies) {
      if (enemy.hitFlash > 0) enemy.hitFlash -= 1;
    }
  }

  private handleMovement(p: PlayerState, dt: number): void {
    const sprinting = p.input.isDown("ShiftLeft") || p.input.isDown("ShiftRight");
    const step = MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1) * dt;
    const startX = p.player.posX;
    const startY = p.player.posY;
    let forwardSign = 0;
    if (p.input.isDown("KeyW")) forwardSign += 1;
    if (p.input.isDown("KeyS")) forwardSign -= 1;
    let strafeSign = 0;
    if (p.input.isDown("KeyD")) strafeSign += 1;
    if (p.input.isDown("KeyA")) strafeSign -= 1;
    // `moveForward`/`strafe` each apply their own full `step` independently,
    // so holding a forward and a strafe key together covered sqrt(2) (~41%)
    // more ground per frame than either alone — the classic unnormalized-
    // diagonal-movement bug. Scale both axes down when moving on both at
    // once so diagonal movement covers the same distance as straight
    // movement, matching player expectations (and keeping e.g. the mine
    // danger-detection radius reliable against someone closing distance
    // faster than intended).
    const diagonalScale = forwardSign !== 0 && strafeSign !== 0 ? Math.SQRT1_2 : 1;
    if (forwardSign !== 0) p.player.moveForward(step * diagonalScale * forwardSign, this.map);
    if (strafeSign !== 0) p.player.strafe(step * diagonalScale * strafeSign, this.map);

    // Gamepad left stick: analog move/strafe, additive with keyboard (both
    // read as 0 when idle/absent, so this is a no-op without a pad plugged in).
    const gpForward = p.input.gamepadForward();
    const gpStrafe = p.input.gamepadStrafe();
    if (gpForward !== 0) p.player.moveForward(step * gpForward, this.map);
    if (gpStrafe !== 0) p.player.strafe(step * gpStrafe, this.map);

    // Camera rotation is exclusively Q/E + mouse (+ the gamepad's right
    // stick) — A/D strafe instead, so turning stays a keyboard key away from
    // WASD rather than an arrow-key reach.
    const rot = ROT_SPEED * p.rotSpeedMultiplier * dt;
    if (p.input.isDown("KeyQ")) p.player.rotate(-rot);
    if (p.input.isDown("KeyE")) p.player.rotate(rot);

    const gpTurn = p.input.gamepadTurn();
    if (gpTurn !== 0) p.player.rotate(rot * gpTurn);

    const mouseDX = p.input.consumeMouseDX();
    if (mouseDX !== 0) p.player.rotate(mouseDX * MOUSE_SENSITIVITY);

    // Footsteps: accumulate ground actually covered (blocked moves count for
    // nothing) and tick a quiet step once per stride.
    const moved = Math.hypot(p.player.posX - startX, p.player.posY - startY);
    p.moving = moved > 1e-4 && this.state === "playing";
    if (p.moving) {
      p.distanceTraveled += moved;
      p.stepDistance += moved;
      if (p.stepDistance >= STRIDE_LENGTH) {
        audio.playStep();
        p.stepDistance -= STRIDE_LENGTH;
      }
    }
  }

  /**
   * Advance the head-bob and recoil animation for one player. The bob phase
   * only runs while moving; its amplitude eases in/out so starting and
   * stopping is smooth. The recoil lerps back to rest every frame. Returns
   * the derived offsets for this frame (camera horizon shift plus weapon
   * bob), consumed by the renderer.
   */
  private updateViewmodel(p: PlayerState, dt: number): { horizonShift: number; bobX: number; bobY: number } {
    if (p.moving) p.bobTime += dt;
    const target = p.moving ? 1 : 0;
    p.bobAmount += (target - p.bobAmount) * Math.min(1, dt * BOB_EASE);
    p.recoil += (0 - p.recoil) * Math.min(1, dt * RECOIL_RECOVERY);
    p.meleeRecoil += (0 - p.meleeRecoil) * Math.min(1, dt * RECOIL_RECOVERY);

    const phase = p.bobTime * BOB_FREQUENCY;
    // Horizontal sway is one cycle per stride; vertical bounces twice (a dip on
    // each footfall) — the classic head-bob relationship.
    const bobH = Math.sin(phase) * p.bobAmount;
    const bobV = Math.sin(phase * 2) * p.bobAmount;
    return {
      horizonShift: bobV * CAMERA_BOB_PX,
      bobX: bobH * WEAPON_BOB_X_PX,
      bobY: bobV * WEAPON_BOB_Y_PX,
    };
  }

  /**
   * Run the enemy chase/attack AI for this frame and apply any melee damage it
   * dealt to living players. Enemies home in on whichever living player is
   * nearest (strict tie-break by sorted-`id` order) and bite on a per-enemy
   * cooldown once adjacent.
   */
  private updateEnemyAi(dt: number): void {
    if (this.state !== "playing") return;
    const targets: EnemyTarget[] = [];
    const pathFields = new Map<PlayerId, PathField>();
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      p.pathField.ensure(this.map, Math.floor(p.player.posX), Math.floor(p.player.posY), this.gridVersion);
      targets.push({ id, player: p.player });
      pathFields.set(id, p.pathField);
    }
    const beforeShots = this.projectiles.length;
    const damageByPlayer = updateEnemies(
      this.enemies,
      targets,
      this.map,
      dt,
      this.projectiles,
      pathFields,
      this.rng,
      this.enemyAiEvents,
      this.difficultyMultipliers.enemyAimSpreadDeg,
    );
    if (this.projectiles.length > beforeShots) audio.playEnemyShoot();
    // Difficulty scales enemy-*dealt* damage only — melee bites and ranged
    // bolts, not trap/hazard/self-inflicted (rocket splash) damage.
    for (const [id, dmg] of damageByPlayer) {
      if (dmg > 0) this.damage(id, dmg * this.difficultyMultipliers.damage, "enemyMelee");
    }

    if (this.telemetry) {
      let aggroedNow = 0;
      for (const e of this.enemies) if (e.alive && e.aggroed) aggroedNow += 1;
      if (aggroedNow > this.telemetry.peakAggroedCount) this.telemetry.peakAggroedCount = aggroedNow;
      if (aggroedNow > 0) this.telemetry.combatTimeSec += dt;
    }
  }

  /** Advance enemy bolts; apply any that struck a living player this frame. */
  private updateProjectiles(dt: number): void {
    if (this.state !== "playing") return;
    const targets: ProjectileTarget[] = [];
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      targets.push({ id, player: p.player });
    }
    const damageByPlayer = updateProjectiles(this.projectiles, targets, this.map, dt, this.onEnemyBoltHit);
    for (const [id, dmg] of damageByPlayer) {
      if (dmg > 0) this.damage(id, dmg * this.difficultyMultipliers.damage, "enemyRanged");
    }
  }

  /**
   * Advance in-flight player rockets, detonating any that hit a wall or a
   * living enemy this frame. Each explosion fans distance-scaled splash
   * damage out across every living enemy and the player (see
   * `rocketDamageAt`) — a rocket doesn't just hurt whatever it directly
   * struck, and standing too close to your own blast still hurts you too.
   */
  private advanceRockets(dt: number): void {
    if (this.state !== "playing") return;
    // No rockets in flight — the overwhelmingly common frame — costs
    // nothing: no grid rebuild, no update pass. Enemy positions are stable
    // from here to the end of the frame (the AI step already ran), which is
    // what makes one rebuild per frame safe for every query below.
    if (this.rockets.length === 0) return;
    this.enemyGrid.rebuild(this.enemies, this.map.width);

    const blasts = updateRockets(
      this.rockets,
      (x, y, radius) => this.enemyGrid.anyWithin(x, y, radius, (e) => Math.hypot(e.x - x, e.y - y) < radius),
      this.map,
      dt,
    );
    for (const blast of blasts) {
      audio.playRocketExplosion();
      spawnExplosion(this.explosions, blast.x, blast.y, ROCKET_BLAST_RADIUS);
      spawnExplosionParticles(this.explosionParticles, blast.x, blast.y);

      // Rocket splash excludes teammates, not the firer — every connected
      // player is a teammate (no FFA teams in this design), so "excludes
      // teammates but not the firer" reduces to exactly this one condition.
      const shooter = this.players.get(blast.firedBy)!;
      const firerDmg = rocketDamageAt(blast, shooter.player.posX, shooter.player.posY);
      if (firerDmg > 0) this.damage(blast.firedBy, firerDmg, "selfRocket");

      // Ascending candidate indices == the old full-array scan order
      // restricted to the blast's neighborhood, so kills (and the seeded
      // loot rolls they draw) happen in exactly the order they always did.
      for (const index of this.enemyGrid.queryIndices(blast.x, blast.y, ROCKET_BLAST_RADIUS)) {
        const enemy = this.enemies[index];
        // Defends against two rockets detonating within ROCKET_BLAST_RADIUS
        // of each other in the same advanceRockets() call — enemyGrid is
        // only rebuilt once per call, so a later blast's query can still
        // list an enemy an earlier blast in the *same* call already killed.
        // Not reachable with today's tuning: ghidra's fireIntervalSec (1.1s)
        // times ROCKET_SPEED (18 tiles/s) forces consecutive player rockets
        // at least ~19.8 tiles apart, well outside 2x the blast radius —
        // but a faster rocket or shorter cooldown could close that gap.
        /* v8 ignore next */
        if (!enemy.alive) continue;
        const dmg = rocketDamageAt(blast, enemy.x, enemy.y);
        if (dmg > 0) {
          if (this.telemetry) recordHit(this.telemetry, GHIDRA_WEAPON_INDEX);
          this.damageEnemy(enemy, dmg, undefined, undefined, GHIDRA_WEAPON_INDEX, undefined, shooter);
        }
      }
    }
  }

  /** Drain stability while a living player stands in an acid (hazard) tile. */
  private applyHazardDamage(dt: number): void {
    if (this.state !== "playing") return;
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      const cx = Math.floor(p.player.posX);
      const cy = Math.floor(p.player.posY);
      if (isHazard(this.map, cx, cy)) this.damage(id, HAZARD_DPS * dt, "hazard");
    }
  }

  /**
   * Drain stability while a living player stands on an active spike trap, and
   * detonate any proximity mine whose fuse no living player backed away from
   * in time — a mine's blast is environmental, damaging every living player
   * in range, not just whoever triggered it (unlike a rocket's splash).
   */
  private applyTrapDamage(dt: number): void {
    if (this.state !== "playing") return;
    const aliveTargets: Player[] = [];
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      aliveTargets.push(p.player);
      const spike = spikeDamage(this.map.spikeTraps, p.player, this.levelTime, dt);
      if (spike > 0) this.damage(id, spike, "trapSpike");
    }

    for (const detonation of updateMines(this.map.mines, aliveTargets, dt)) {
      audio.playExplosion();
      spawnExplosion(this.explosions, detonation.x, detonation.y, MINE_BLAST_RADIUS);
      spawnExplosionParticles(this.explosionParticles, detonation.x, detonation.y);
      if (this.telemetry) recordMineTriggered(this.telemetry);
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const dmg = mineDamageAt(detonation, p.player.posX, p.player.posY);
        if (dmg > 0) this.damage(id, dmg, "trapMine");
      }
    }
  }

  /** Pick up any key the player has walked onto. */
  /** Pick up any key a living player has walked onto — first living player
   * (sorted order) in radius of a given key wins. */
  private collectKeys(): void {
    if (this.state !== "playing") return;
    for (const item of this.map.keys) {
      if (item.collected) continue;
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const dx = item.x - p.player.posX;
        const dy = item.y - p.player.posY;
        if (dx * dx + dy * dy < KEY_PICKUP_RADIUS * KEY_PICKUP_RADIUS) {
          item.collected = true;
          p.keysHeld += 1;
          console.log(
            `%c[key] dependency key acquired — ${p.keysHeld} in inventory`,
            "color:#f2d64b",
          );
          break;
        }
      }
    }
  }

  /**
   * Pick up any dynamic loot drop or statically-placed map ammo pickup a
   * living player has walked onto, applying whatever it grants — first
   * living player (sorted order) in radius of a given item wins.
   */
  private collectLoot(): void {
    if (this.state !== "playing") return;
    const r2 = AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const dx = drop.x - p.player.posX;
        const dy = drop.y - p.player.posY;
        if (dx * dx + dy * dy >= r2) continue;
        this.drops.splice(i, 1);
        applyLootDrop(drop, p.lootCtx);
        break;
      }
    }

    for (const pickup of this.map.ammoPickups) {
      if (pickup.collected) continue;
      for (const id of this.sortedPlayerIds()) {
        const p = this.players.get(id)!;
        if (p.status !== "alive") continue;
        const dx = pickup.x - p.player.posX;
        const dy = pickup.y - p.player.posY;
        if (dx * dx + dy * dy >= r2) continue;
        pickup.collected = true;
        audio.playPickup();
        if (pickup.kind === "weapon") {
          // Own message/amount logic (unlock vs. already-owned top-up) — the
          // generic "+N kind found" log below doesn't apply to it.
          if (pickup.weaponIndex !== undefined) grantOrTopUpWeapon(pickup.weaponIndex, p.lootCtx, "static");
          break;
        }
        // Correction from review, preserved deliberately: unlike the
        // `"weapon"` branch above, this doesn't route through `p.lootCtx` —
        // matches the pre-N-player engine's own inconsistency exactly rather
        // than "cleaning it up" as part of this refactor.
        const amount = this.scaledLootAmount(pickup.amount);
        if (pickup.kind === "health") p.health = Math.min(MAX_HEALTH, p.health + amount);
        else if (pickup.kind === "swap") p.swap = Math.min(MAX_SWAP, p.swap + amount);
        else p.ammo[pickup.kind] += amount;
        if (this.telemetry) recordLootCollected(this.telemetry, "static", pickup.kind, amount);
        console.log(`%c[pickup] +${amount} ${pickup.kind} found`, "color:#3fd0e0");
        break;
      }
    }
  }

  /** Scale a base loot/pickup amount by the difficulty's `ammoDropRate`
   * (Easy is more generous, Hard scarcer) — always at least 1, so rounding
   * down on Hard can never zero out a pickup entirely. */
  private scaledLootAmount(baseAmount: number): number {
    return Math.max(1, Math.round(baseAmount * this.difficultyMultipliers.ammoDropRate));
  }

  /** The real amount a fresh (not-already-owned) drop of `kind` will actually
   * grant, before difficulty scaling — mirrors `applyLootDrop`'s own
   * `drop.amount ?? <default>` fallback exactly, so `pushLootDrop` below can
   * record what a drop is *really* worth instead of a placeholder. `"weapon"`
   * has no real quantity — whether it tops up ammo (already owned) or grants
   * the weapon outright depends on ownership state at *collection* time, not
   * roll time, which can change in between (a different weapon could be
   * picked up first) — so `1` (an occurrence) is the only thing that can
   * honestly be recorded for it, roll-time or not. `"key"` is never actually
   * routed through this (see `pushLootDrop`'s doc comment) but still needs a
   * value for `LootKind` exhaustiveness. */
  private defaultLootAmountFor(kind: LootKind): number {
    if (kind === "weapon") return 1;
    if (kind === "health") return HEALTH_DROP_AMOUNT;
    if (kind === "swap") return SWAP_DROP_AMOUNT;
    // Unreachable: "key" drops are only ever pushed directly by killPlayer()
    // (see pushLootDrop's doc comment), never via pushLootDrop, so this
    // branch has no live caller — kept only for LootKind exhaustiveness.
    /* v8 ignore next */
    if (kind === "key") return 1;
    return AMMO_META[kind].dropAmount;
  }

  /** Leave a dynamic loot drop in the world — the single place enemy-kill/
   * loot-roll drops are ever pushed to `this.drops`, so telemetry's "rolled"
   * counter (see `lootRolled`) never has to be duplicated across call sites.
   * (The one exception: `killPlayer`'s key-drop-on-death pushes directly —
   * a player's own keys aren't "rolled" loot, so double-counting them here
   * would misrepresent what `lootRolled` measures.) Records the real,
   * difficulty-scaled amount the drop is worth (via `defaultLootAmountFor`
   * for the common unset-`amount` case, matching `applyLootDrop`'s own
   * fallback, or the drop's own explicit `amount` when set — Elite drops)
   * — not a placeholder. A prior version of this recorded a flat `1`
   * ("an occurrence") for every unset-amount drop regardless of kind, which
   * made `lootRolled` unit-incompatible with `consumed` (a real-amount
   * total) for anything but Elite drops; confirmed via balance telemetry as
   * the reason an `ammo_starvation_*` flag built on comparing the two had to
   * be removed rather than fixed. */
  private pushLootDrop(drop: LootDrop, enemy: Enemy): void {
    const enemyIndex = this.enemies.indexOf(enemy);
    const dropSeq = this.dropSeqByEnemyIndex.get(enemyIndex) ?? 0;
    this.dropSeqByEnemyIndex.set(enemyIndex, dropSeq + 1);
    drop.id = `${enemyIndex}:${dropSeq}`;
    this.drops.push(drop);
    const amount = this.scaledLootAmount(drop.amount ?? this.defaultLootAmountFor(drop.kind));
    if (this.telemetry) recordLootRolled(this.telemetry, drop.kind, amount);
  }

  /**
   * If a living player is walking into a locked door and holds a key, spend
   * the key and open the door (its tile becomes plain floor).
   */
  private openDoorAhead(): void {
    if (this.state !== "playing") return;
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive" || p.keysHeld <= 0) continue;

      // Which way is the player pushing? Forward (W) or backward (S) along dir.
      let sign = 0;
      if (p.input.isDown("KeyW")) sign += 1;
      if (p.input.isDown("KeyS")) sign -= 1;
      if (sign === 0) continue;

      const reach = p.player.radius + 0.15;
      const px = p.player.posX + p.player.dirX * sign * reach;
      const py = p.player.posY + p.player.dirY * sign * reach;
      const cx = Math.floor(px);
      const cy = Math.floor(py);

      if (this.map.grid[cy]?.[cx] === DOOR_TILE) {
        this.map.grid[cy][cx] = 0;
        this.pendingGridDelta.push({ x: cx, y: cy, value: 0 });
        this.gridVersion += 1;
        p.keysHeld -= 1;
        console.log(
          `%c[door] unlocked with a dependency key — ${p.keysHeld} left`,
          "color:#568ebe;font-weight:bold",
        );
      }
    }
  }

  /**
   * Warp a living player when they step onto a goto/label teleporter pad.
   * Tracked by tile rather than a cooldown timer: arriving on a pad
   * suppresses only that exact tile until that player leaves it, so the
   * destination pad (itself a teleporter tile) can't immediately bounce them
   * back, however long they linger there — inherently per-player, no
   * cross-player coordination needed.
   */
  private checkTeleporters(): void {
    if (this.state !== "playing") return;
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      const cx = Math.floor(p.player.posX);
      const cy = Math.floor(p.player.posY);
      if (this.map.grid[cy]?.[cx] !== TELEPORTER_TILE) {
        p.suppressTeleportAt = null;
        continue;
      }

      const tileKey = `${cx},${cy}`;
      if (tileKey === p.suppressTeleportAt) continue;

      const pad = this.map.teleporters.find((t) => Math.floor(t.x) === cx && Math.floor(t.y) === cy);
      if (!pad) continue;

      p.player.posX = pad.targetX;
      p.player.posY = pad.targetY;
      p.suppressTeleportAt = `${Math.floor(pad.targetX)},${Math.floor(pad.targetY)}`;
      audio.playTeleport();
      console.log(`%c[goto] warped via label "${pad.label}"`, "color:#c86dff;font-weight:bold");
    }
  }

  /**
   * Sound a pulsing warning beep once per second while a living player's
   * stability is critically low (below 25%), for every living player — each
   * on their own countdown. Resets when a player's health recovers or the
   * run ends, so re-entering the low band beeps immediately. `audio.playAlarm()`
   * may fire more than once per tick across players — harmless, matches the
   * "audio stays unscoped" decision (see `EngineHandlers`'s doc comment).
   */
  private updateLowHealthAlarm(dt: number): void {
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      const critical = this.state === "playing" && p.health > 0 && p.health < MAX_HEALTH * LOW_HEALTH_FRACTION;
      if (!critical) {
        p.alarmCountdown = 0;
        continue;
      }
      if (p.alarmCountdown <= 0) {
        audio.playAlarm();
        p.alarmCountdown = LOW_HEALTH_BEEP_INTERVAL;
      }
      p.alarmCountdown -= dt;
    }
  }

  /**
   * Apply `amount` of stability loss to `playerId`; kills that player on
   * reaching 0 (see `killPlayer`). Swap absorbs damage 1:1 before health
   * does, so it's spent down first. `source` is telemetry-only (see
   * `telemetry.ts`'s `DamageSource`) — every call site is a first-party
   * literal, never derived from player input.
   */
  private damage(playerId: PlayerId, amount: number, source: DamageSource): void {
    const p = this.players.get(playerId)!;
    if (p.godMode || amount <= 0 || p.status !== "alive") return;
    if (this.telemetry) recordDamage(this.telemetry, source, amount);
    // Kick the red screen flash back to full strength on any damage taken.
    p.flashFrames = DAMAGE_FLASH_FRAMES;
    audio.playDamage();
    let remaining = amount;
    if (p.swap > 0) {
      const absorbed = Math.min(p.swap, remaining);
      p.swap -= absorbed;
      remaining -= absorbed;
    }
    p.health -= remaining;
    if (p.health <= 0) {
      p.health = 0;
      if (this.telemetry) recordFatalDamage(this.telemetry, source);
      this.killPlayer(p);
    }
  }

  /**
   * Take a player out of the world simulation on reaching 0 health: drops
   * any keys they were holding at their death position (a `"key"` `LootDrop`
   * — see `map/types.ts`'s `LootKind`), starts them spectating a living
   * teammate (see `cycleSpectateTarget`), and ends the run for the whole team
   * once nobody's left alive. `p.player` itself is never touched here or
   * afterward — stays frozen exactly where they died — see
   * `effectiveCameraFor`'s doc comment for why that's load-bearing, not just
   * incidental.
   */
  private killPlayer(p: PlayerState): void {
    p.status = "dead";
    if (p.keysHeld > 0) {
      const dropSeq = this.dropSeqByPlayerId.get(p.id) ?? 0;
      this.dropSeqByPlayerId.set(p.id, dropSeq + 1);
      this.drops.push({ x: p.player.posX, y: p.player.posY, kind: "key", amount: p.keysHeld, id: `player:${p.id}:${dropSeq}` });
      p.keysHeld = 0;
    }
    this.cycleSpectateTarget(p);
    // A strict generalization of the old `every(status === "dead")` check —
    // identical for the no-disconnect case, but also correctly ends the run
    // once every *remaining* player is dead even if a teammate already
    // disconnected (a `[dead, disconnected]` team must still end the run;
    // literal `every(=== "dead")` never would, since "disconnected" isn't
    // "dead"). A still-connected survivor alone keeps playing regardless of
    // how many teammates disconnected — this predicate is false as long as
    // at least one player is genuinely `"alive"`.
    if ([...this.players.values()].every((q) => q.status !== "alive")) this.endGame("over");
  }

  /**
   * Which living teammate's camera a dead player's render pass follows —
   * their own `Player` stays frozen (see `killPlayer`'s doc comment), so a
   * spectate camera is resolved separately here instead. Cycled by
   * `consumeFire()` while dead (see `simulate()`), and set to the first
   * living teammate (sorted order) the instant a player dies.
   */
  private cycleSpectateTarget(p: PlayerState): void {
    const living = this.sortedPlayerIds().filter((id) => this.players.get(id)!.status === "alive");
    if (living.length === 0) {
      p.spectateTargetId = null;
      return;
    }
    const i = p.spectateTargetId ? living.indexOf(p.spectateTargetId) : -1;
    p.spectateTargetId = living[(i + 1) % living.length];
  }

  /** The `Player` whose position/facing `id`'s own render pass (or, for the
   * local player, `render()`) should treat as the camera this frame — that
   * player's own `Player` while alive, or their current spectate target's
   * while dead. See `killPlayer`'s doc comment for why a dead player's own
   * `Player` is never overwritten to mirror this instead: every per-player
   * world-interaction loop reads `p.player.posX/posY` directly, gated only by
   * `status === "alive"` — mutating a dead player's own position would
   * corrupt what should be inert death-position data, since the `status`
   * gate alone wouldn't stop it. */
  private effectiveCameraFor(id: PlayerId): Player {
    const p = this.players.get(id)!;
    if (p.status === "alive" || p.spectateTargetId === null) return p.player;
    return this.players.get(p.spectateTargetId)!.player;
  }

  /**
   * Apply a classic Doom cheat code once its full sequence has been typed by
   * `p` (see `InputController.onKeyDown`). IDDQD/IDCLIP toggle (re-typing
   * turns them back off, exactly like real Doom); IDKFA is a one-time grant,
   * not a toggle (also matching real Doom — re-typing it is a harmless
   * no-op). Local-player-only in practice — see `simulate()`'s doc comment.
   */
  private applyCheat(p: PlayerState, code: string): void {
    switch (code) {
      case "IDDQD":
        p.godMode = !p.godMode;
        this.showCheatToast(p, `IDDQD — God mode ${p.godMode ? "ON" : "OFF"}`);
        break;
      case "IDCLIP":
        p.player.noClip = !p.player.noClip;
        this.showCheatToast(p, `IDCLIP — No-clip ${p.player.noClip ? "ON" : "OFF"}`);
        break;
      case "IDKFA":
        for (let i = 0; i < WEAPONS.length; i++) p.ownedWeapons.add(i);
        for (const type of AMMO_TYPES) p.ammo[type] = CHEAT_MAX_AMMO;
        p.swap = MAX_SWAP;
        this.showCheatToast(p, "IDKFA — Full arsenal");
        break;
      default:
        return;
    }
    this.handlers.onCheatActivated?.(code);
  }

  private showCheatToast(p: PlayerState, text: string): void {
    p.cheatToastText = text;
    p.cheatToastFrames = CHEAT_TOAST_FRAMES;
  }

  /** Same shape as `showCheatToast`, own state — see `killStreakText`'s
   * doc comment for why. */
  private showKillStreakToast(p: PlayerState, text: string, big: boolean): void {
    p.killStreakText = text;
    p.killStreakFrames = KILL_STREAK_TOAST_FRAMES;
    p.killStreakBig = big;
  }

  /**
   * Single-player: win for the whole team the instant any one living player
   * stands on the exit tile (sorted order) — byte-identical to before step 8.
   *
   * Multiplayer (`multiplayer-netcode-spec.md` §7): the first living player
   * to touch the exit starts a fixed `COUNTDOWN_TICKS` countdown instead of
   * winning immediately — a later host-driven step (level transition) needs
   * that window to generate and hand off the next level before the win
   * actually lands. Once started, the countdown is unconditional: it is
   * never cancelled or restarted by a later touch, and it decrements every
   * tick regardless of where any player currently stands (leaving the exit
   * tile doesn't pause or reset it) — the sim keeps running normally
   * throughout, exactly like every other tick. `endGame("won")` fires only
   * once it reaches zero.
   */
  private checkExit(): void {
    if (this.state !== "playing") return;
    if (this.isMultiplayerSession() && this.exitCountdownRemaining !== null) {
      this.exitCountdownRemaining -= 1;
      if (this.exitCountdownRemaining <= 0) {
        this.exitCountdownRemaining = null;
        this.endGame("won");
      }
      return;
    }
    const touching = this.sortedPlayerIds().some((id) => {
      const p = this.players.get(id)!;
      return p.status === "alive" && Math.floor(p.player.posX) === this.map.exit.x && Math.floor(p.player.posY) === this.map.exit.y;
    });
    if (!touching) return;
    if (this.isMultiplayerSession()) {
      this.exitCountdownRemaining = COUNTDOWN_TICKS;
    } else {
      this.endGame("won");
    }
  }

  /** Multiplayer-only: ticks remaining in the exit countdown, or `null` if
   * none is active — read-only introspection for a "Build finishing in N…"
   * overlay (`multiplayer-research.md` step 8's own UI, built alongside the
   * host-driven transition itself), polled once per render frame rather
   * than a new `EngineHandlers` callback, same spirit as
   * `getRngState()`/`hasActiveRenderOffset()`. Always `null` for a
   * single-player instance. */
  getExitCountdownRemaining(): number | null {
    return this.exitCountdownRemaining;
  }

  /**
   * Whether `index` is a ranged weapon `p` currently owns and can switch to
   * via a number key or the mousewheel — melee weapons (anything with
   * `meleeRange` set) are structurally excluded, since the knife is bound
   * exclusively to Space's quick-melee action instead of a slot.
   */
  private canWieldViaNumberKey(p: PlayerState, index: number): boolean {
    return index >= 0 && index < WEAPONS.length && WEAPONS[index].meleeRange === undefined && p.ownedWeapons.has(index);
  }

  /**
   * Switch `p` to the next/previous number-key-reachable weapon from the
   * currently equipped one, wrapping around, skipping melee and unowned
   * slots (see `canWieldViaNumberKey`). Does nothing if no other reachable
   * weapon is owned.
   */
  private cycleWeapon(p: PlayerState, direction: 1 | -1): void {
    const n = WEAPONS.length;
    let i = p.weaponIndex;
    for (let steps = 0; steps < n; steps++) {
      i = (i + direction + n) % n;
      if (this.canWieldViaNumberKey(p, i)) {
        p.weaponIndex = i;
        return;
      }
    }
  }

  /**
   * Resolve firing for this frame: automatic weapons (the MP) re-fire on
   * their own every `fireIntervalSec` while the trigger is held; everything
   * else fires once per press, gated by the same cooldown (mainly there to
   * stop the rocket launcher being click-spammed faster than its own
   * `fireIntervalSec` — the pistol/shotgun have none, so they're unaffected
   * and fire exactly as fast as the player can press/click). Quick-melee
   * (Space) is a separate, always-available action handled in `advance()`
   * — it never goes through this cooldown/auto-fire gating at all.
   */
  private updateFiring(dt: number): void {
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      if (p.weaponCooldown > 0) p.weaponCooldown = Math.max(0, p.weaponCooldown - dt);
      const weapon = WEAPONS[p.weaponIndex];
      const pressed = p.input.consumeFire();

      if (weapon.auto) {
        if (p.input.isFireHeld() && p.weaponCooldown <= 0) {
          this.fire(p);
          // Not reachable via current WEAPONS data — every `auto: true`
          // ranged weapon today (gdb, Friday Hotfix) defines
          // fireIntervalSec — but a future auto weapon omitting it should
          // still get a sane cooldown instead of firing every frame.
          /* v8 ignore next */
          p.weaponCooldown = weapon.fireIntervalSec ?? 0.1;
        }
      } else if (pressed && p.weaponCooldown <= 0) {
        this.fire(p);
        if (weapon.fireIntervalSec) p.weaponCooldown = weapon.fireIntervalSec;
      }
    }
  }

  /**
   * Resolve one shot's zBuffer refresh, per-pellet Cone-of-Fire deviation,
   * and hit-selection for an arbitrary `camera` — the camera-parameterized
   * generalization `refreshFiringZBuffer` used to leave as a step-4 TODO,
   * needed because a remote player's shot has no local render pass to reuse
   * a zBuffer from at all. Recomputes `zBuffer` fresh from `camera`'s exact
   * current position every call (self-sufficient regardless of call site —
   * quick-melee's early call in `simulate()`, before `handleMovement` even
   * runs that tick, or `updateFiring`'s later call, after movement), so it's
   * never relying on whatever `render()` last drew, which may be a whole
   * tick — or, once netcode decouples ticks from renders, many ticks —
   * stale. Deliberately doesn't apply ammo cost, damage, loot, telemetry,
   * traces, or audio — those stay in `fire()`, since they need per-player
   * mutable state this function doesn't touch.
   */
  private resolveShot(camera: Player, weapon: Weapon, rng: () => number, zBuffer: Float64Array): ShotResolution {
    castWallDistances(this.map, camera, SCENE_WIDTH, zBuffer);
    const enemyProjections = projectLivingEnemies(camera, this.enemies, SCENE_WIDTH, SCENE_HEIGHT);
    const mineProjections = projectVisibleMines(camera, this.map.mines, SCENE_WIDTH, SCENE_HEIGHT);
    const center = SCENE_WIDTH / 2;
    const isFlame = weapon.ammoType === "gas";
    const pellets: PelletOutcome[] = [];
    const traceColumns: number[] = [];
    let flameLeft = Infinity;
    let flameRight = -Infinity;

    for (const offset of pelletOffsets(weapon)) {
      // Cone of Fire: ranged weapons get a small random aim deviation that
      // grows with how far away whatever's down this column actually is (the
      // z-buffer depth there, wall or otherwise), instead of a hard max-range
      // cutoff — a shot lined up on a distant target can still go wide, while
      // point-blank shots stay accurate. The scale is cubic in range (not
      // linear or quadratic), so medium-range shots stay reliable and only
      // the last stretch before `FOG_FAR` (max visual range) spreads
      // noticeably. Melee has no business missing this way (it can't even
      // reach past its own tiny range), so it's exempt.
      const baseColumn = center + offset;
      let column = baseColumn;
      if (weapon.meleeRange === undefined) {
        const baseCol = Math.min(SCENE_WIDTH - 1, Math.max(0, Math.round(baseColumn)));
        const range = zBuffer[baseCol];
        const rangeFraction = Math.min(1, range / FOG_FAR);
        const maxDeviation = weapon.maxConeDeviationPx ?? MAX_CONE_DEVIATION_PX;
        const deviation = (rng() * 2 - 1) * rangeFraction ** 3 * maxDeviation;
        column = Math.min(SCENE_WIDTH - 1, Math.max(0, baseColumn + deviation));
      }

      // Tracer from the muzzle (bottom center) to this pellet's aim column at
      // crosshair height, in the weapon's own tracer color — drawn whether or
      // not it connects. Friday Hotfix skips this in favor of one flame
      // stream for the whole shot, pushed after the loop below (see
      // `flameLeft`/`flameRight`). Melee (the knife, Toolchain) skips it
      // entirely — a swing isn't a fired projectile, so a line drawn from
      // the screen center to the crosshair never made sense for it visually.
      if (isFlame) {
        flameLeft = Math.min(flameLeft, column);
        flameRight = Math.max(flameRight, column);
      } else if (weapon.meleeRange === undefined) {
        traceColumns.push(column);
      }

      const enemy = findTargetInProjections(enemyProjections, zBuffer, SCENE_WIDTH, SCENE_HEIGHT, column);
      if (enemy?.alive) {
        // Melee only actually connects within its stabbing range, even if the
        // column lines up with something farther away down the same
        // sightline; Friday Hotfix's `maxRange` is the same idea for a
        // flamethrower's genuinely short reach.
        const rangeLimit = weapon.meleeRange ?? weapon.maxRange;
        if (rangeLimit !== undefined && Math.hypot(enemy.x - camera.posX, enemy.y - camera.posY) > rangeLimit) {
          pellets.push({ kind: "miss" });
          continue;
        }
        pellets.push({ kind: "enemy", target: enemy });
        continue;
      }

      if (weapon.meleeRange === undefined) {
        const mine = findMineInProjections(mineProjections, zBuffer, SCENE_WIDTH, SCENE_HEIGHT, column);
        if (mine) {
          if (weapon.maxRange !== undefined && Math.hypot(mine.x - camera.posX, mine.y - camera.posY) > weapon.maxRange) {
            pellets.push({ kind: "miss" });
            continue;
          }
          pellets.push({ kind: "mine", target: mine });
          continue;
        }
      }
      pellets.push({ kind: "miss" });
    }
    return { pellets, traceColumns, flameLeft, flameRight };
  }

  /**
   * Fire `weapon` (defaulting to `shooter`'s own equipped weapon) on
   * `shooter`'s behalf — the quick-melee action passes the knife/Toolchain
   * directly, bypassing `weaponIndex` entirely (see the Space handling in
   * `simulate()`). Spends its ammo cost from the right pool (a no-op for the
   * knife, which has none), then either resolves one hitscan per pellet
   * across its cone (the pistol is a single centered ray; the shotgun sprays
   * several pellets that each independently hit whatever's under their
   * offset screen column) via `resolveShot`, or, for the rocket launcher,
   * launches a real projectile instead (see `rockets.ts`). A hitscan pellet
   * hits an enemy first, or failing that a spotted proximity mine, which a
   * shot destroys outright (see `destroyMine`).
   */
  private fire(shooter: PlayerState, weapon?: Weapon): void {
    const w = weapon ?? WEAPONS[shooter.weaponIndex];
    if (w.ammoType) {
      if (shooter.ammo[w.ammoType] < w.ammoPerShot) {
        console.log(`[${w.name}] out of ${w.ammoType} — need ${w.ammoPerShot}`);
        return;
      }
      shooter.ammo[w.ammoType] -= w.ammoPerShot;
    }

    const weaponIndex = WEAPONS.indexOf(w);
    // "Forced melee": true only when a melee weapon fires because every
    // ranged pool was empty at the moment of firing — telemetry-only (see
    // `killsForcedByMelee`), computed here since this is the only place that
    // still knows the ammo state *before* this shot.
    const forcedMelee = w.meleeRange !== undefined && shooter.ammo.bullets === 0 && shooter.ammo.smg === 0 && shooter.ammo.gas === 0;
    if (this.telemetry) recordShot(this.telemetry, weaponIndex);

    audio.playShoot(w.viewKind);
    // Kick the viewmodel: full recoil, easing back over the next frames. No
    // muzzle flash for the knife — a stab doesn't have one. A melee call
    // (w.meleeRange !== undefined) never touches `recoil` — the caller
    // already drives its own `meleeRecoil` overlay instead, so a quick-melee
    // swing can't stomp whatever ranged weapon's recoil animation was
    // actually mid-flight.
    if (w.meleeRange === undefined) shooter.recoil = 1;
    if (w.ammoType) shooter.muzzleFrames = MUZZLE_FLASH_FRAMES;

    if (w.isRocket) {
      spawnRocket(this.rockets, shooter.player.posX, shooter.player.posY, shooter.player.dirX, shooter.player.dirY, w.damagePerPellet, shooter.id);
      console.log(`[${w.name}] launched`);
      return;
    }

    const resolution = this.resolveShot(shooter.player, w, this.rng, shooter.zBuffer);
    const isFlame = w.ammoType === "gas";
    for (const outcome of resolution.pellets) {
      if (outcome.kind === "enemy") {
        if (this.telemetry) recordHit(this.telemetry, weaponIndex);
        this.damageEnemy(outcome.target, w.damagePerPellet, w.lifesteal, isFlame, weaponIndex, forcedMelee, shooter);
      } else if (outcome.kind === "mine") {
        this.destroyMine(outcome.target, shooter);
      }
    }
    if (!isFlame) {
      for (const col of resolution.traceColumns) this.traces.push(makeBulletTrace(SCENE_WIDTH, SCENE_HEIGHT, col, SCENE_HEIGHT / 2, w.tracerColor));
    }
    if (isFlame && resolution.flameRight >= resolution.flameLeft) {
      this.flameStreams.push(spawnFlameStream(SCENE_HEIGHT, resolution.flameLeft, resolution.flameRight, w.tracerColor));
    }
  }

  /**
   * Destroy a spotted proximity mine hit by gunfire instead of letting it
   * detonate underfoot — the same distance-scaled blast a proximity
   * detonation applies fans out to every living player (environmental, like
   * a fuse-triggered detonation — see `applyTrapDamage`'s doc comment), so
   * shooting one from beyond its blast radius is a genuinely safe disarm for
   * the whole team, while shooting one at point-blank still hurts whoever's
   * close. `shooter`'s own splash is what the gunfire-destroyed log reports,
   * matching the pre-N-player engine's single-player wording.
   */
  private destroyMine(mine: Mine, shooter: PlayerState): void {
    detonateMine(mine);
    audio.playExplosion();
    spawnExplosion(this.explosions, mine.x, mine.y, MINE_BLAST_RADIUS);
    spawnExplosionParticles(this.explosionParticles, mine.x, mine.y);
    if (this.telemetry) recordMineDisarmed(this.telemetry);
    const shooterDmg = mineDamageAt({ x: mine.x, y: mine.y }, shooter.player.posX, shooter.player.posY);
    console.log(
      `%c[mine] destroyed by gunfire${shooterDmg > 0 ? ` — caught ${Math.round(shooterDmg)} splash damage` : " — safely disarmed at range"}`,
      "color:#ff5050",
    );
    for (const id of this.sortedPlayerIds()) {
      const p = this.players.get(id)!;
      if (p.status !== "alive") continue;
      const dmg = id === shooter.id ? shooterDmg : mineDamageAt({ x: mine.x, y: mine.y }, p.player.posX, p.player.posY);
      if (dmg > 0) this.damage(id, dmg, "trapMine");
    }
  }

  /**
   * Apply weapon damage to one enemy on `shooter`'s behalf, retiring it
   * (with a log) at 0 HP. If the killing weapon has `lifesteal`, restore
   * that much stability to `shooter`. `burning` (Friday Hotfix hits only)
   * layers a handful of cosmetic embers on top of the usual blood spray —
   * purely visual, no damage-over-time follows. `weaponIndex`/`forcedMelee`
   * are telemetry-only (see `telemetry.ts`) — every caller passes a literal
   * weapon index (`advanceRockets` always passes `GHIDRA_WEAPON_INDEX`);
   * `undefined` only in tests that call this directly without needing
   * weapon-attribution telemetry.
   *
   * Assist tracking: every hit against a still-live enemy (not just the
   * killing blow) records `shooter` into `enemyAssists`. On a kill,
   * `killScore` (points) splits evenly across every distinct assisting
   * player — but `kills`/the multi-kill-streak fields attribute ONLY to
   * `shooter` (the final blow), never split: most coop shooters separate
   * assist points from individual kill/streak credit, and this does the
   * same. At N=1 `assists.size` is always 1, so `share === killPoints(enemy)`
   * exactly — byte-identical to the pre-N-player single-player behavior.
   */
  private damageEnemy(
    enemy: Enemy,
    amount: number,
    lifesteal: number | undefined,
    burning: boolean | undefined,
    weaponIndex: number | undefined,
    forcedMelee: boolean | undefined,
    shooter: PlayerState,
  ): void {
    // Hit feedback: thud sound, tint the sprite red, spray "digital blood".
    audio.playHit();
    enemy.hitFlash = HIT_FLASH_FRAMES;
    if (burning) spawnBurnParticles(this.burnParticles, enemy.x, enemy.y);
    // Damage aggro: being shot instantly wakes the enemy, even from beyond its
    // aggro radius, so you can't safely snipe a roaming enemy from afar.
    enemy.aggroed = true;
    if (this.telemetry) recordEnemyAggro(this.telemetry, this.enemyTtkIndex, enemy, this.levelTime);
    const baseBloodCount = 3 + Math.floor(Math.random() * 3);
    spawnBlood(this.blood, enemy.x, enemy.y, Math.round(baseBloodCount * this.goreMultipliers.count));

    const enemyIndex = this.enemies.indexOf(enemy);
    (this.enemyAssists.get(enemyIndex) ?? this.enemyAssists.set(enemyIndex, new Set()).get(enemyIndex)!).add(shooter.id);

    enemy.hp -= amount;
    if (enemy.hp > 0) {
      console.log(`[hit] ${enemy.entity.name}() — HP ${enemy.hp}/${enemy.maxHp}`);
      return;
    }
    enemy.hp = 0;
    enemy.alive = false;
    shooter.kills += 1;
    const assists = this.enemyAssists.get(enemyIndex)!;
    const share = killPoints(enemy) / assists.size;
    for (const id of assists) this.players.get(id)!.killScore += share;
    this.enemyAssists.delete(enemyIndex);
    this.registerKillForStreak(shooter);
    if (this.target === enemy) this.target = null;
    if (this.telemetry) {
      recordEnemyDeath(this.telemetry, this.enemyTtkIndex, enemy, this.levelTime);
      if (weaponIndex !== undefined) {
        recordKill(this.telemetry, weaponIndex);
        if (forcedMelee) recordKillForcedByMelee(this.telemetry);
      }
    }
    if (lifesteal) {
      if (this.telemetry) {
        const actualHeal = Math.min(MAX_HEALTH, shooter.health + lifesteal) - shooter.health;
        recordHeal(this.telemetry, "lifesteal", actualHeal);
      }
      shooter.health = Math.min(MAX_HEALTH, shooter.health + lifesteal);
    }

    if (enemy.elite) dropEliteLoot(enemy, shooter.lootCtx);
    else {
      // Health is handled as its own always-on check, decoupled from
      // REGULAR_KILL_NO_DROP_CHANCE entirely — unlike ammo (still survivable
      // via the universal melee fallback), running low on health directly
      // causes death. Confirmed via live balance verification: cutting
      // health the same way as ammo (amount *and* a chance to drop nothing)
      // collapsed Gamer/Hard's qualifying rate from a report-baseline ~48%
      // to 4% in one batch; even reverting just the amount only partially
      // recovered it (to ~20%), since the *frequency* cut from the miss
      // chance was still compounding with Hard's tougher combat. `rollLoot`
      // below is told to exclude "health" from its own weighted roll (via
      // `healthHandledSeparately`) so a kill can't double-drop it.
      if (shooter.health < MAX_HEALTH) {
        this.pushLootDrop({ x: enemy.x, y: enemy.y, kind: "health" }, enemy);
      }
      // Not every regular kill drops ammo/swap anymore — see
      // REGULAR_KILL_NO_DROP_CHANCE's doc comment. A separate rng() draw
      // ahead of rollLoot's own, same as the existing rollBonusWeaponDrop
      // pattern below (an independent roll, not folded into rollLoot itself)
      // so rollLoot's kind-weighting logic and tests stay untouched.
      const lootRollHit = this.rng() >= REGULAR_KILL_NO_DROP_CHANCE;
      if (this.telemetry) recordRegularKillLootRoll(this.telemetry, !lootRollHit);
      if (lootRollHit) {
        this.pushLootDrop({
          x: enemy.x,
          y: enemy.y,
          kind: rollLoot(
            this.map.bonusLevel,
            this.difficultyLevel,
            this.rng,
            shooter.ownedWeapons.has(GHIDRA_WEAPON_INDEX),
            shooter.ownedWeapons.has(GDB_WEAPON_INDEX),
            shooter.health >= MAX_HEALTH,
            shooter.ownedWeapons.has(FRIDAY_HOTFIX_WEAPON_INDEX),
            true, // healthHandledSeparately — see above
          ),
        }, enemy);
      } else if (rollMissChanceToolchain(shooter.lootCtx)) {
        // A kill that drops nothing isn't quite a dead end — a small
        // independent chance turns the miss into a shot at the Toolchain
        // instead, a weapon whose other two acquisition paths (secret rooms,
        // an Elite's own bonus roll) are otherwise easy to never see at all.
        // See `rollMissChanceToolchain`'s doc comment.
        this.pushLootDrop({ x: enemy.x, y: enemy.y, kind: "weapon", weaponIndex: TOOLCHAIN_WEAPON_INDEX }, enemy);
      }
      const missing = UNLOCKABLE_WEAPONS.filter((i) => !shooter.ownedWeapons.has(i));
      const bonusWeaponIndex = rollBonusWeaponDrop(missing, this.rng);
      if (bonusWeaponIndex !== undefined) {
        this.pushLootDrop({ x: enemy.x, y: enemy.y, kind: "weapon", weaponIndex: bonusWeaponIndex }, enemy);
      }
    }
    audio.playAmmoDrop();

    const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    console.log(
      `%c[KILL] ${enemy.elite ? "ELITE " : ""}${enemy.entity.kind} ${enemy.entity.name}() eliminated — ${remaining} enemies remaining`,
      "color:#37d24a;font-weight:bold",
    );
  }

  /**
   * Rolling-window "Multi Kill"/"Ultra Kill" streak detection for `p` —
   * called once per kill, from `damageEnemy`, right after `p.kills`/
   * `p.killScore` are updated. Counts how many recent kills (including the
   * one that just happened) fall within each window; a tier only fires on
   * the kill that *first* pushes the count to its threshold (comparing the
   * before/after count), so a long streak doesn't re-announce every
   * subsequent kill, and a fresh streak later can retrigger "Multi Kill"
   * once the window naturally empties out. Ultra is checked first since
   * 6-in-6 implies 3-in-3 already fired earlier in the same streak — this
   * kill should only ever cross one threshold, not both.
   */
  private registerKillForStreak(p: PlayerState): void {
    const withinMulti = p.recentKillTimes.filter((t) => this.levelTime - t <= MULTI_KILL_WINDOW_SEC).length;
    const withinUltra = p.recentKillTimes.length; // already pruned to the (larger) ultra window below
    p.recentKillTimes.push(this.levelTime);
    p.recentKillTimes = p.recentKillTimes.filter((t) => this.levelTime - t <= ULTRA_KILL_WINDOW_SEC);

    if (withinUltra < ULTRA_KILL_COUNT && withinUltra + 1 >= ULTRA_KILL_COUNT) {
      p.ultraKillCount += 1;
      this.showKillStreakToast(p, "ULTRA KILL!", true);
      audio.playUltraKill();
    } else if (withinMulti < MULTI_KILL_COUNT && withinMulti + 1 >= MULTI_KILL_COUNT) {
      p.multiKillCount += 1;
      this.showKillStreakToast(p, "MULTI KILL!", false);
      audio.playMultiKill();
    }
  }

  /**
   * Flip to the end state — just the state, nothing else. `checkExit()`/
   * `damage()` (which calls this) run early in `advance()`, well before that
   * frame's rendering; actually stopping the loop and firing the
   * `onGameOver`/`onWin` handler here would let the render calls later in the
   * *same* `advance()` call immediately paint over the end-of-run overlay
   * those handlers draw (`GameHud` draws straight onto this engine's canvas —
   * see main.ts). `advance()` does that itself, once, after the frame is
   * fully rendered.
   */
  private endGame(state: "over" | "won"): void {
    // Not reachable via any current call site: `checkExit()` already gates
    // itself on `this.state === "playing"` before ever calling this, and
    // `killPlayer()` only calls this once — the instant the *last* living
    // player's `status` flips to `"dead"` — which `damage()`'s own
    // `p.status !== "alive"` guard (see there) prevents from ever firing
    // twice for the same or a different player once the team is already
    // over. Kept as defensive belt-and-suspenders documentation of the
    // invariant, same spirit as this file's other `/* v8 ignore next */`
    // guards on provably-unreachable defensive branches.
    /* v8 ignore next */
    if (this.state !== "playing") return;
    this.state = state;
  }

  /** Snapshot the live stats consumed by both the native HUD and the host —
   * local-player-only in shape (no new fields for other players), reading
   * through `this.players.get(this.localPlayerId)!` instead of bare
   * `this.*` — byte-identical for N=1. */
  /** `p`'s own level-score breakdown so far, from purely per-player inputs
   * (kills/health/ammo/distance/streaks) plus this level's team-shared
   * completion/discovery state (map completion, lore/secrets read —
   * genuinely shared, not a per-player approximation) and telemetry (also
   * engine-wide, not split per player — an existing characteristic, not a
   * new gap introduced here). Shared by `buildStats()` (always for
   * `this.localPlayerId`) and `captureCarryoverFor()` (for an arbitrary
   * roster id). */
  private computeLevelScoreBreakdown(p: PlayerState): ScoreBreakdown {
    const weaponShotsFired = this.telemetry
      ? Object.values(this.telemetry.weaponTallies).reduce((sum, t) => sum + t.shotsFired, 0)
      : 0;
    const weaponHits = this.telemetry ? Object.values(this.telemetry.weaponTallies).reduce((sum, t) => sum + t.hits, 0) : 0;
    return computeScore({
      killPoints: p.killScore,
      finalHealth: p.health,
      maxHealth: MAX_HEALTH,
      finalBullets: p.ammo.bullets,
      finalRockets: p.ammo.rockets,
      finalSmg: p.ammo.smg,
      finalGas: p.ammo.gas,
      startingBullets: p.startingAmmoRef.bullets,
      startingRockets: p.startingAmmoRef.rockets,
      startingSmg: p.startingAmmoRef.smg,
      startingGas: p.startingAmmoRef.gas,
      levelTimeSec: this.levelTime,
      distanceTraveledTiles: p.distanceTraveled,
      shortestPathTiles: this.map.shortestPathTiles,
      mapCompletionFrac: this.visitedWalkableCount / this.totalWalkableTiles,
      uniqueLoreTerminalsRead: this.loreRead.size,
      uniqueSecretRoomsOpened: this.secretRoomsOpened.size,
      multiKillCount: p.multiKillCount,
      ultraKillCount: p.ultraKillCount,
      weaponShotsFired,
      weaponHits,
    });
  }

  /** Captures `id`'s current state as a fresh `EngineCarryover` — the same
   * shape `buildStats()` derives for `this.localPlayerId` alone (`main.ts`'s
   * own single-player `advanceToNextLevel` builds an identical object from
   * `EngineStats`), generalized to any roster id. Built for step 8's
   * host-driven level transition (`multiplayer-research.md`): the host
   * captures every connected player's own carryover right before generating
   * the next level, so each peer's health/ammo/weapons/score genuinely
   * persists across the swap to a fresh `RaycasterEngine` instead of
   * resetting. A snapshot as of the moment it's called — never mutates `p`.
   * `priorScoreBreakdown`/`priorPlayerStats` stay `undefined` whenever
   * telemetry isn't being recorded at all, the same gating `buildStats()`
   * itself uses for `runScoreBreakdown`/`runPlayerStats` — `priorScore`
   * itself is never gated, it's core carryover, not a telemetry feature. */
  captureCarryoverFor(id: PlayerId): EngineCarryover {
    const p = this.players.get(id)!;
    const levelScoreBreakdown = this.computeLevelScoreBreakdown(p);
    let priorScoreBreakdown: ScoreBreakdown | undefined;
    let priorPlayerStats: PlayerFacingStats | undefined;
    if (this.telemetry) {
      priorScoreBreakdown = sumScoreBreakdowns(p.priorScoreBreakdown, levelScoreBreakdown);
      const levelPlayerStats = buildPlayerFacingStats(this.telemetry, this.levelTime, p.kills);
      priorPlayerStats = mergePlayerFacingStats(p.priorPlayerStats, levelPlayerStats);
    }
    return {
      health: Math.ceil(p.health),
      swap: Math.ceil(p.swap),
      bullets: p.ammo.bullets,
      rockets: p.ammo.rockets,
      smg: p.ammo.smg,
      gas: p.ammo.gas,
      priorScore: p.priorScore + levelScoreBreakdown.total,
      priorScoreBreakdown,
      priorPlayerStats,
      weaponIndex: p.weaponIndex,
      ownedWeapons: [...p.ownedWeapons],
      campaignLevelIndex: p.campaignLevelIndex,
      godMode: p.godMode,
      noClip: p.player.noClip,
      showFps: p.showFps,
    };
  }

  private buildStats(): EngineStats {
    const local = this.players.get(this.localPlayerId)!;
    const levelScoreBreakdown = this.computeLevelScoreBreakdown(local);

    // The curated player-facing breakdown/stats are `undefined` whenever
    // telemetry isn't being recorded at all (`PLAYER_STATS_ENABLED` off and
    // no `?testHooks=1` — see `this.telemetry`'s doc comment); `main.ts`
    // then shows the plain (stats-less) overlay variant, same as before this
    // feature existed. When telemetry IS on, they're only ever read by
    // `onGameOver`/`onWin` (see `main.ts`) — never by the live HUD or the
    // per-frame `onStats` handler, which only reads `score` (already derived
    // above from `levelScoreBreakdown.total`) — so even then, the real
    // derivation only happens on the level's terminal frame
    // (`this.state !== "playing"`); every other call reuses existing object
    // references as unread placeholders, at zero allocation cost.
    let runScoreBreakdown: ScoreBreakdown | undefined;
    let levelPlayerStats: PlayerFacingStats | undefined;
    let runPlayerStats: PlayerFacingStats | undefined;
    if (this.telemetry) {
      const atLevelEnd = this.state !== "playing";
      runScoreBreakdown = atLevelEnd
        ? sumScoreBreakdowns(local.priorScoreBreakdown, levelScoreBreakdown)
        : local.priorScoreBreakdown;
      levelPlayerStats = atLevelEnd
        ? buildPlayerFacingStats(this.telemetry, this.levelTime, local.kills)
        : local.priorPlayerStats;
      runPlayerStats = atLevelEnd ? mergePlayerFacingStats(local.priorPlayerStats, levelPlayerStats) : local.priorPlayerStats;
    }

    return {
      health: Math.ceil(local.health),
      maxHealth: MAX_HEALTH,
      swap: Math.ceil(local.swap),
      bullets: local.ammo.bullets,
      rockets: local.ammo.rockets,
      smg: local.ammo.smg,
      gas: local.ammo.gas,
      keysHeld: local.keysHeld,
      keysTotal: this.map.keys.length,
      score: local.priorScore + levelScoreBreakdown.total,
      kills: local.kills,
      weaponIndex: local.weaponIndex,
      ownedWeapons: [...local.ownedWeapons],
      godMode: local.godMode,
      noClip: local.player.noClip,
      showFps: local.showFps,
      levelScoreBreakdown: this.telemetry ? levelScoreBreakdown : undefined,
      runScoreBreakdown,
      levelPlayerStats,
      runPlayerStats,
    };
  }
}

/** Distinct marker colors for teammate billboards/minimap dots — cycled by a
 * stable hash of the player's own id, so the same player always gets the
 * same color for the whole session regardless of connection order. */
const PLAYER_COLORS = ["#4ade80", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c"];

function colorForPlayer(id: PlayerId): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

/** The closest lore terminal within `LORE_INTERACT_RADIUS` of (px, py), or
 * `null` if none is close enough — "nearby", not facing-based. */
function findNearbyLoreTerminal(
  terminals: LoreTerminal[],
  px: number,
  py: number,
): LoreTerminal | null {
  let best: LoreTerminal | null = null;
  let bestDist = LORE_INTERACT_RADIUS;
  for (const t of terminals) {
    const dist = Math.hypot(t.x + 0.5 - px, t.y + 0.5 - py);
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

/** A tile counts toward map-completion exploration if it's ever walkable —
 * floor, hazard, a door (locked or not), a teleporter pad, or a spike trap.
 * Walls, unopened secret walls, and lore-terminal walls never are. Secret
 * rooms (tile 6 until opened) are deliberately excluded from the completion
 * denominator computed once at level start — finding them is a bonus, not a
 * requirement for "100% Clear". */
function isWalkableTile(tile: number): boolean {
  return tile !== 1 && tile !== SECRET_WALL_TILE && tile !== LORE_TILE;
}

/** Total walkable tiles on `map`, counted once at construction — the
 * map-completion score bonus's denominator (see `./scoring.ts`). */
function countWalkableTiles(map: GameMap): number {
  let count = 0;
  for (const row of map.grid) {
    for (const tile of row) {
      if (isWalkableTile(tile)) count += 1;
    }
  }
  return Math.max(1, count);
}

