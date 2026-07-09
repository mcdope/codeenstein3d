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
import { mulberry32, randomSeed } from "../prng";
import { Player, isHazard } from "./player";
import { updateEnemies } from "./enemyAi";
import { collectProjectileBillboards, updateProjectiles, type Projectile } from "./projectiles";
import { InputController, type InputSource } from "./input";
import type { CampaignReplayRecorder } from "./replay";
import { FOG_FAR, renderMinimap, renderScene } from "./raycaster";
import {
  collectDecorationBillboards,
  collectEnemyBillboards,
  collectExitBillboard,
  collectKeyBillboards,
  collectLootBillboards,
  collectMineBillboards,
  collectTeleporterBillboards,
  findMineAtColumn,
  findTargetAtColumn,
  findTargetUnderCrosshair,
  type BillboardJob,
} from "./sprites";
import {
  COMPASS_ENABLED,
  drawCheatToast,
  drawCompass,
  drawCrosshair,
  drawFpsOverlay,
  drawHud,
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
import { computeScore, killPoints } from "./scoring";
import {
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  MELEE_WEAPON,
  NUMBER_KEY_WEAPONS,
  STARTING_WEAPONS,
  UNLOCKABLE_WEAPONS,
  WEAPONS,
  pelletOffsets,
  type AmmoType,
  type Weapon,
} from "./weapons";
import {
  SWAP_DROP_AMOUNT,
  BULLETS_DROP_AMOUNT,
  ELITE_BULLETS_DROP_AMOUNT,
  ELITE_GAS_DROP_AMOUNT,
  ELITE_HEALTH_DROP_AMOUNT,
  ELITE_ROCKETS_DROP_AMOUNT,
  ELITE_SMG_DROP_AMOUNT,
  ELITE_SWAP_DROP_AMOUNT,
  GAS_DROP_AMOUNT,
  HEALTH_DROP_AMOUNT,
  MAX_SWAP,
  ROCKETS_DROP_AMOUNT,
  SMG_DROP_AMOUNT,
  rollLoot,
} from "./loot";
import { collectRocketBillboards, rocketDamageAt, spawnRocket, updateRockets, ROCKET_BLAST_RADIUS, type Rocket } from "./rockets";
import { detonateMine, spikeDamage, updateMines, MINE_BLAST_RADIUS } from "./traps";
import {
  DOOR_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  TELEPORTER_TILE,
  type Enemy,
  type GameMap,
  type LootDrop,
  type LoreTerminal,
  type Mine,
  type Point,
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
  /** Index into `WEAPONS`; defaults to the pistol (0) when omitted. */
  weaponIndex?: number;
  /** Defaults to `STARTING_WEAPONS` when omitted. */
  ownedWeapons?: number[];
  /** Doom-style cheat flags carried across a level transition — a fresh
   * `RaycasterEngine`/`Player` is constructed for every level (see
   * `main.ts`'s `launchLevel`), so an active toggle would otherwise silently
   * reset at the next file. Omitted on a genuinely fresh run. IDKFA needs no
   * equivalent field — its effect already persists via `bullets`/`rockets`/
   * `smg`/`gas`/`ownedWeapons` above. */
  godMode?: boolean;
  noClip?: boolean;
}

type GameState = "playing" | "over" | "won";

export class RaycasterEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly player: Player;
  /** Typed against the narrow `InputSource` shape (not the concrete
   * `InputController`) so a `ReplayPlaybackInput` (see `./replay.ts`) can
   * drive the engine identically during replay playback. */
  private readonly input: InputSource;
  /** Seeded PRNG for every simulation-relevant random draw this engine itself
   * makes (weapon spread, elite-loot coinflip) — plus what it hands down to
   * `updateEnemies`/`rollLoot`. Never `Math.random()` directly; see
   * `src/prng.ts`'s doc comment for why. */
  private readonly rng: () => number;
  /** Records this level's input for the replay system, if a run is actively
   * being tracked (see `main.ts`'s `launchLevel`) — `undefined` during replay
   * playback itself, which never re-records what it's replaying. */
  private readonly replayRecorder?: CampaignReplayRecorder;
  private readonly enemies: Enemy[];
  /** Per-column wall depth from the latest wall render; used for occlusion. */
  private readonly zBuffer: Float64Array;

  private running = false;
  private rafId = 0;
  private lastTime = 0;
  /** Enemy under the crosshair this frame, if any. */
  private target: Enemy | null = null;

  /** Whether the FPS/frame-time overlay is showing (Right-Ctrl toggles it).
   * Default off, not persisted — a debug display, not a setting. */
  private showFps = false;
  /** Seconds/frame-count accumulated since the last `displayFps` update. */
  private fpsAccumTime = 0;
  private fpsAccumFrames = 0;
  /** Rolling-averaged FPS, recomputed every `FPS_UPDATE_INTERVAL` seconds. */
  private displayFps = 0;
  /** Last frame's raw (unaveraged) time in milliseconds — jitter/stutter is
   * useful signal the averaged FPS alone would hide. */
  private displayFrameMs = 0;

  private state: GameState = "playing";
  private health = MAX_HEALTH;
  /** Swap points; absorbed 1:1 before health on any hit (see `damage()`). */
  private swap = 0;
  /** IDDQD cheat — while true, `damage()` is a no-op. */
  private godMode = false;
  /** Text of the "cheat activated" toast currently showing, if any. */
  private cheatToastText: string | null = null;
  /** Frames remaining for the toast above — ticked down in `tickEffects()`
   * alongside `flashFrames`/`muzzleFrames`, same frame-counted convention. */
  private cheatToastFrames = 0;
  private bulletsAmmo: number;
  private rocketsAmmo: number;
  private smgAmmo: number;
  private gasAmmo: number;
  /** What this level would have started the player out with, regardless of
   * `carryover` — the ammo-bonus baseline `computeScore` scores remaining
   * ammo against (see `./scoring.ts`), so a low-ammo carryover from a
   * previous level doesn't unfairly tank this one's ammo bonus. */
  private readonly startingBulletsRef: number;
  private readonly startingRocketsRef: number;
  private readonly startingSmgRef: number;
  private readonly startingGasRef: number;
  /** Index into WEAPONS of the equipped weapon (0 = pistol). */
  private weaponIndex = 0;
  /** Indices into `WEAPONS` the player can currently switch to — everything
   * beyond `STARTING_WEAPONS` has to be earned (an Elite kill's guaranteed
   * weapon drop; see `dropEliteLoot`). */
  private readonly ownedWeapons: Set<number>;
  /** Seconds remaining before the next shot is allowed — ticks down every
   * frame regardless of weapon; automatic weapons (the MP) re-fire on their
   * own while held once it reaches 0, everything else just gates a stray
   * double-press faster than the weapon's own `fireIntervalSec` allows. */
  private weaponCooldown = 0;
  /** Dependency keys collected but not yet spent on a door. */
  private keysHeld = 0;
  /** Enemies defeated this level. */
  private kills = 0;
  /** Sum of `killPoints()` for every enemy defeated so far this level. */
  private killScore = 0;
  /** Score banked from levels already cleared this campaign — see
   * `EngineCarryover.priorScore`. Added on top of this level's own live score
   * in `buildStats()` so the running total never resets at a transition. */
  private readonly priorScore: number;
  /** Tiles of ground actually covered so far this level (blocked moves count
   * for nothing) — never reset mid-level, unlike `stepDistance`; feeds the
   * scoring system's path-efficiency bonus (see `./scoring.ts`). */
  private distanceTraveled = 0;
  /** Count of unique walkable tiles (see `isWalkableTile`) revealed by
   * `markVisited` so far — the numerator of the "100% Clear" completion
   * fraction (see `./scoring.ts`). Updated incrementally there rather than
   * rescanned every frame, since `map.visited` only ever grows. */
  private visitedWalkableCount = 0;
  /** Total walkable tiles on this level, counted once at construction — the
   * completion fraction's denominator. */
  private readonly totalWalkableTiles: number;
  /** Tile keys ("x,y") of lore terminals read at least once this level —
   * feeds the scoring system's flat per-terminal bonus. */
  private readonly loreRead = new Set<string>();
  /** Tile keys ("x,y") of the door tile of every secret room opened at least
   * once this level — feeds the scoring system's flat per-room bonus. Keyed
   * by the door tile (not any interior tile), since that's the one cell
   * `tryOpenSecretWall` always has in hand and it's unique per room. */
  private readonly secretRoomsOpened = new Set<string>();
  /** Loot dropped by defeated enemies, awaiting collection. */
  private readonly drops: LootDrop[] = [];
  /** Frames left on the red "took damage" screen flash (0 = none). */
  private flashFrames = 0;
  /** Live weapon bullet tracers, fading over a few frames. */
  private readonly traces: BulletTrace[] = [];
  /** Live flamethrower flame streams (Friday Hotfix's tracer replacement),
   * fading over a few frames — see `FlameStream`. */
  private readonly flameStreams: FlameStream[] = [];
  /** Live "digital blood" particles falling to the floor. */
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
  /** In-flight enemy projectiles (ranged bolts). */
  private readonly projectiles: Projectile[] = [];
  /** In-flight player-fired rockets. */
  private readonly rockets: Rocket[] = [];
  /** Live rocket-blast VFX circles. */
  private readonly explosions: Explosion[] = [];
  /** Live rocket-blast debris/spark particles (see `spawnExplosionParticles`). */
  private readonly explosionParticles: ExplosionParticle[] = [];
  /** Live flamethrower-hit burn embers, settling and lingering on the floor
   * (see `spawnBurnParticles`). */
  private readonly burnParticles: BurnParticle[] = [];
  /** Countdown (seconds) to the next low-health alarm beep; 0 = beep now. */
  private alarmCountdown = 0;
  /** Ground covered (tiles) since the last footstep sound. */
  private stepDistance = 0;
  /** Whether the player translated (WASD) this frame — drives head-bob. */
  private moving = false;
  /** Head-bob phase accumulator; only advances while moving. */
  private bobTime = 0;
  /** Eased bob amplitude (0 at rest → 1 at full stride) for smooth start/stop. */
  private bobAmount = 0;
  /** Weapon recoil, 1 just after firing, easing back to 0. */
  private recoil = 0;
  /** Quick-melee "thrust" progress, 1 just after a Left-Ctrl swing, easing
   * back to 0 — entirely independent of `recoil` so a melee swing never
   * makes whatever ranged weapon is equipped visually kick as if IT fired. */
  private meleeRecoil = 0;
  /** Frames left on the muzzle flash. */
  private muzzleFrames = 0;
  /** Whether the automap overlay is up. Non-blocking — the sim keeps running
   * (movement, combat, hazards) while it's shown, Diablo-style; only a few
   * purely-visual layers (viewmodel, corner minimap/compass) are suppressed
   * while it's open — the crosshair stays visible since the player can still
   * aim and fire. See `advance()`. */
  private isMapActive = false;
  /** Whether the game is paused (window blur or Escape) — freezes the sim and
   * shows a "PAUSED" overlay, distinct from the Tab automap. */
  private isPaused = false;
  /** Text of the lore terminal currently being read (null = no overlay up).
   * Freezes the sim the same way `isPaused` does (`isMapActive` no longer
   * freezes — see its doc comment) — see `advance()`. */
  private loreText: string | null = null;
  /** Wrapped-line scroll offset into `loreText`, advanced by holding W/S
   * while the overlay is up (see `drawLoreOverlay`'s doc comment) and reset
   * whenever a new terminal is opened. */
  private loreScroll = 0;
  /** Tile key ("x,y") of a teleporter pad the player just arrived on, so they
   * can step off before it can trigger again — otherwise the destination pad
   * (itself a teleporter tile) would bounce them straight back. */
  private suppressTeleportAt: string | null = null;
  /** Seconds elapsed in this level's simulation; drives timed spike traps. */
  private levelTime = 0;
  /** Last value reported via `onFreezeChange`, so that handler only fires on
   * an actual edge instead of every frame the sim happens to be paused. */
  private wasFrozen = false;

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
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.godMode = carryover?.godMode ?? false;
    this.player.noClip = carryover?.noClip ?? false;
    this.input = inputSource ?? new InputController(canvas);
    this.rng = mulberry32(gameplaySeed);
    this.replayRecorder = replayRecorder;
    this.enemies = map.enemies;
    this.zBuffer = new Float64Array(canvas.width);
    this.bulletsAmmo = carryover?.bullets ?? startingBullets(map.enemies);
    this.rocketsAmmo = carryover?.rockets ?? startingRockets();
    this.smgAmmo = carryover?.smg ?? startingSmg();
    this.gasAmmo = carryover?.gas ?? startingGas();
    this.startingBulletsRef = startingBullets(map.enemies);
    this.startingRocketsRef = startingRockets();
    this.startingSmgRef = startingSmg();
    this.startingGasRef = startingGas();
    this.ownedWeapons = new Set(carryover?.ownedWeapons ?? STARTING_WEAPONS);
    this.priorScore = carryover?.priorScore ?? 0;
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
    if (carryover) {
      this.health = carryover.health;
      this.swap = carryover.swap;
    }
    if (carryover?.weaponIndex !== undefined) this.weaponIndex = carryover.weaponIndex;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach();
    // Warm up the audio context now, while we're still inside the user gesture
    // (the click that launched this level) so playback isn't blocked later.
    audio.resume();
    this.markVisited(); // reveal the spawn tile before the first step
    this.lastTime = performance.now();
    this.handlers.onStats?.(this.buildStats());
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.input.detach();
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
   * Advance the simulation and render exactly one frame over `dt` seconds.
   * Normally called by the internal rAF loop; exposed so the game can also be
   * driven at a fixed step (e.g. headless/deterministic runs).
   */
  advance(dt: number): void {
    // Gamepad axis/button state has no change events to listen for (unlike
    // keyboard/mouse), so it must be actively polled once per frame — and
    // before any of the below reads any of the one-shot queues it can feed
    // (fire/weapon-cycle/melee), or a gamepad press made this frame would sit
    // unconsumed until the *next* frame's reads instead.
    this.input.pollGamepad();

    // Record this frame's full input state for the replay system, before
    // anything below consumes any of its one-shot flags — a non-destructive
    // peek (see `InputSnapshot`'s doc comment), so this has zero effect on
    // live play whether or not a recorder is actually attached.
    this.replayRecorder?.record(dt, this.input.captureSnapshot());

    // The FPS overlay toggles independent of pause/map/lore state, so it's
    // consumed unconditionally right here rather than gated behind any of
    // the early-return branches below.
    if (this.input.consumeFpsToggle()) this.showFps = !this.showFps;

    // Doom cheat codes are a debug/fun feature independent of pause/automap
    // state too, same reasoning as the FPS toggle above.
    const cheat = this.input.consumeCheat();
    if (cheat) this.applyCheat(cheat);

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
    const clicked = this.input.consumeClick();
    const blurred = this.input.consumeBlur();
    const pointerUnlocked = this.input.consumePointerUnlock();
    const escaped = this.input.consumeEscape();
    if (escaped) {
      this.isPaused = !this.isPaused;
    } else if (blurred || pointerUnlocked) {
      this.isPaused = true;
    }
    if (this.isPaused && clicked) this.isPaused = false;
    if (this.isPaused) {
      this.notifyFrozen(true);
      this.renderPausedOverlay();
      return;
    }

    // Tab toggles the automap. Non-blocking — sim keeps running (movement,
    // combat, hazards) while it's shown; only a few purely-visual layers are
    // suppressed while it's open (see the render section below).
    if (this.input.consumeMapToggle()) this.isMapActive = !this.isMapActive;

    // Lore terminal overlay: opened/closed by "R", independent of Tab/Esc.
    // Checked before weapon switching / simulation so both freeze the sim the
    // same way the automap does. A second interact (or a click) dismisses it;
    // otherwise holding W/S scrolls the text (movement is never simulated
    // this frame, so repurposing those keys here doesn't fight `handleMovement`).
    const interacted = this.input.consumeInteract();
    if (this.loreText !== null) {
      if (interacted || clicked) {
        this.loreText = null;
      } else {
        if (this.input.isDown("KeyS")) this.loreScroll += LORE_SCROLL_SPEED * dt;
        if (this.input.isDown("KeyW")) this.loreScroll = Math.max(0, this.loreScroll - LORE_SCROLL_SPEED * dt);
      }
      this.notifyFrozen(true);
      this.renderLoreOverlay();
      return;
    }
    this.notifyFrozen(false);
    if (interacted && this.state === "playing") {
      // Secret walls are checked first: that check is facing/reach-based (only
      // the exact tile directly ahead, within `SECRET_WALL_REACH`), a far more
      // deliberate action than the lore terminal's generous omnidirectional
      // proximity radius — without this ordering, any lore terminal within
      // `LORE_INTERACT_RADIUS` (which is more than double the secret-wall
      // reach) would always win, even while squarely facing a fake wall.
      if (!this.tryOpenSecretWall()) {
        const terminal = findNearbyLoreTerminal(this.map.loreTerminals, this.player.posX, this.player.posY);
        if (terminal) {
          audio.playSecret();
          const key = `${terminal.x},${terminal.y}`;
          if (!this.loreRead.has(key)) {
            this.loreRead.add(key);
            console.log("%c[lore] terminal logged — exploration bonus earned", "color:#78c8d2");
          }
          this.loreText = terminal.text;
          this.loreScroll = 0;
          this.renderLoreOverlay();
          return;
        }
      }
    }

    // Weapon switching (1/2/… or mousewheel) can happen even while lining up
    // a shot — but only among ranged weapons the player actually owns (see
    // `ownedWeapons`); an unearned slot just does nothing, rather than
    // switching to a weapon with no way to have gotten it yet. Melee is
    // structurally excluded (see `canWieldViaNumberKey`) — it's bound to
    // Left-Ctrl as its own quick-attack action instead (below). `requested`
    // is a 0-based number-key *slot* (digit 1 -> 0), not a raw `WEAPONS`
    // index — routed through `NUMBER_KEY_WEAPONS` so the melee exclusion
    // above doesn't leave a dead key in the middle of the number row (see
    // its doc comment).
    const requested = this.input.consumeWeaponRequest();
    if (requested !== null) {
      const targetIndex = NUMBER_KEY_WEAPONS[requested];
      if (targetIndex !== undefined && this.canWieldViaNumberKey(targetIndex)) {
        this.weaponIndex = targetIndex;
      }
    }

    const wheelSteps = this.input.consumeWheelSteps();
    if (wheelSteps !== 0) {
      const direction = wheelSteps > 0 ? 1 : -1; // scroll down = next weapon
      for (let i = 0; i < Math.abs(wheelSteps); i++) this.cycleWeapon(direction);
    }

    // Quick-melee: an instant knife swing, independent of whatever ranged
    // weapon is equipped/owned/cooling down — see `fire()`'s doc comment and
    // the `meleeRecoil`-driven viewmodel overlay in the render section below.
    if (this.state === "playing" && this.input.consumeMelee()) {
      this.fire(MELEE_WEAPON);
      this.meleeRecoil = 1;
    }

    // Simulate (may end the game via damage or reaching the exit).
    this.levelTime += dt;
    this.handleMovement(dt);
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
    this.updateLowHealthAlarm(dt);
    this.checkExit();

    // Head-bob / recoil offsets for this frame (camera + weapon).
    const view = this.updateViewmodel(dt);

    // Render — one final frozen frame is still drawn after the game ends.
    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, this.player, this.zBuffer, view.horizonShift, this.levelTime);
    this.renderWorldBillboards();

    this.target = findTargetUnderCrosshair(
      this.player,
      this.enemies,
      this.zBuffer,
      width,
      height,
    );

    if (this.state === "playing") this.updateFiring(dt);

    // In-world impact effects (above sprites): falling "digital blood", the
    // muzzle→impact tracer lines from any shot fired this frame, and any live
    // rocket-blast VFX circles.
    updateBlood(this.blood, dt, this.goreMultipliers.stainDuration);
    renderBlood(this.ctx, this.player, this.blood, this.zBuffer, this.goreMultipliers.size);
    drawBulletTraces(this.ctx, this.traces);
    drawFlameStreams(this.ctx, width, height, this.flameStreams);
    updateExplosions(this.explosions, dt);
    renderExplosions(this.ctx, this.player, this.explosions, this.zBuffer);
    updateExplosionParticles(this.explosionParticles, dt);
    renderExplosionParticles(this.ctx, this.player, this.explosionParticles, this.zBuffer);
    updateBurnParticles(this.burnParticles, dt);
    renderBurnParticles(this.ctx, this.player, this.burnParticles, this.zBuffer);

    // Full-screen red flash when the player is taking damage.
    drawDamageFlash(this.ctx, this.flashFrames / DAMAGE_FLASH_FRAMES);

    // First-person weapon and corner minimap/compass: visual clutter the
    // automap would immediately cover, so they're skipped while it's open
    // rather than drawn and instantly painted over. A quick-melee swing
    // briefly overlays the knife's viewmodel on top of whatever ranged
    // weapon is actually equipped — weaponIndex, ammo, and the HUD are
    // untouched throughout (see `meleeRecoil`'s doc comment).
    if (!this.isMapActive) {
      const meleeOverlayActive = this.meleeRecoil > 0.02;
      drawWeapon(this.ctx, {
        bobX: view.bobX,
        bobY: view.bobY,
        recoil: meleeOverlayActive ? this.meleeRecoil : this.recoil,
        flash: meleeOverlayActive ? false : this.muzzleFrames > 0,
        kind: meleeOverlayActive ? MELEE_WEAPON.viewKind : WEAPONS[this.weaponIndex].viewKind,
      });

      const minimapPanel = renderMinimap(this.ctx, this.map, this.player, this.levelTime);
      if (COMPASS_ENABLED) {
        drawCompass(
          this.ctx,
          minimapPanel.compassBadge,
          this.player.posX,
          this.player.posY,
          Math.atan2(this.player.dirY, this.player.dirX),
          this.map.exit.x + 0.5,
          this.map.exit.y + 0.5,
        );
      }
    }

    // Diablo-style automap overlay: drawn on top of the still-live 3D scene
    // (sim never stops for it, unlike `isPaused`/`loreText`) — see automap.ts.
    if (this.isMapActive) {
      drawAutomap(this.ctx, this.map, this.player, this.levelTime);
    }

    // Crosshair stays visible (and on top of the automap, not dimmed by its
    // translucent panel) even with the map open — the player can still aim
    // and fire while it's up, so the aim point should still be shown.
    drawCrosshair(this.ctx, this.target !== null, WEAPONS[this.weaponIndex].spreadPx);

    // Native HUD sits on top of the whole scene, automap included, so
    // health/ammo/keys always stay visible and live.
    const stats = this.buildStats();
    drawHud(this.ctx, stats);
    if (this.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    // Transient feedback only — not drawn in the paused/automap/lore render
    // branches below, unlike the FPS overlay, since a 2-second confirmation
    // toast isn't meant to persist across those states the way a standing
    // debug readout is.
    if (this.cheatToastText && this.cheatToastFrames > 0) {
      drawCheatToast(this.ctx, this.cheatToastText, this.cheatToastFrames / CHEAT_TOAST_FRAMES);
    }
    this.handlers.onStats?.(stats);

    // Age the frame-based effect timers now that this frame is drawn.
    this.tickEffects();

    // Fire the end-of-run handler last, once this frame is fully painted —
    // see `endGame()`'s doc comment for why this can't happen any earlier.
    if (this.state !== "playing") {
      this.stop();
      if (this.state === "over") this.handlers.onGameOver?.(stats);
      else this.handlers.onWin?.(stats);
    }
  }

  /**
   * Render one frozen frame with the "PAUSED" scrim on top — triggered by
   * window blur or Escape. Distinct from the Tab automap, which no longer
   * freezes the sim — see `advance()`.
   */
  private renderPausedOverlay(): void {
    renderScene(this.ctx, this.map, this.player, this.zBuffer, 0, this.levelTime);
    this.renderWorldBillboards();
    drawPauseOverlay(this.ctx);
    if (this.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    this.handlers.onStats?.(this.buildStats());
  }

  /**
   * Render one frozen frame with a lore terminal's comment text on top —
   * triggered by "R" near a `LORE_TILE` (see `advance()`), dismissed by
   * another interact or a click.
   */
  private renderLoreOverlay(): void {
    renderScene(this.ctx, this.map, this.player, this.zBuffer, 0, this.levelTime);
    this.renderWorldBillboards();
    const { maxScrollLines } = drawLoreOverlay(this.ctx, this.loreText ?? "", this.loreScroll);
    this.loreScroll = Math.max(0, Math.min(this.loreScroll, maxScrollLines));
    if (this.showFps) drawFpsOverlay(this.ctx, this.displayFps, this.displayFrameMs);
    this.handlers.onStats?.(this.buildStats());
  }

  /**
   * Open the fake wall directly ahead of the player, if there is one — the
   * whole secret room behind it (not just the one tile faced) is carved as
   * `SECRET_WALL_TILE` (see `placeSecretRooms`/`trySecretRoomOffAnchor`), so
   * every 4-connected `SECRET_WALL_TILE` cell reachable from the tile opened
   * is flood-filled to plain floor at once, revealing the room in full. Also
   * logs the door tile into `secretRoomsOpened`, feeding the scoring
   * system's flat per-room discovery bonus (same pattern as `loreRead`).
   * Returns whether a wall was actually opened, so the interact handler can
   * fall back to checking for a nearby lore terminal when it wasn't.
   */
  private tryOpenSecretWall(): boolean {
    const px = this.player.posX + this.player.dirX * SECRET_WALL_REACH;
    const py = this.player.posY + this.player.dirY * SECRET_WALL_REACH;
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
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }
    audio.playSecret();
    console.log(
      "%c[secret] a section of wall slides open — a hidden room lies beyond — exploration bonus earned",
      "color:#e06aff;font-weight:bold",
    );
    return true;
  }

  /**
   * Draw every world billboard category (enemies, projectiles, rockets, keys,
   * loot drops, static ammo pickups, the exit marker, teleporters,
   * decorations, mines) in one combined pass, sorted furthest-to-nearest so
   * nearer items always paint over farther ones — regardless of which
   * category they belong to. Drawing category-by-category in a fixed order
   * used to let a later category (e.g. the exit marker, always drawn last)
   * paint over a nearer item from an earlier one (e.g. a loot drop), making it
   * vanish even though it was actually closer to the player.
   */
  private renderWorldBillboards(): void {
    const jobs: BillboardJob[] = [
      ...collectDecorationBillboards(this.ctx, this.player, this.map.decorations, this.zBuffer),
      ...collectTeleporterBillboards(this.ctx, this.player, this.map.teleporters, this.zBuffer),
      ...collectMineBillboards(this.ctx, this.player, this.map.mines, this.zBuffer),
      ...collectEnemyBillboards(this.ctx, this.player, this.enemies, this.zBuffer),
      ...collectProjectileBillboards(this.ctx, this.player, this.projectiles, this.zBuffer),
      ...collectRocketBillboards(this.ctx, this.player, this.rockets, this.zBuffer),
      ...collectKeyBillboards(this.ctx, this.player, this.map.keys, this.zBuffer),
      ...collectLootBillboards(this.ctx, this.player, this.drops, this.zBuffer),
      ...collectLootBillboards(
        this.ctx,
        this.player,
        this.map.ammoPickups.filter((p) => !p.collected),
        this.zBuffer,
      ),
      ...collectExitBillboard(this.ctx, this.player, this.map.exit, this.zBuffer),
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
    const cx = Math.floor(this.player.posX);
    const cy = Math.floor(this.player.posY);
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
   * Reveal each not-yet-discovered enemy once the player's collision box
   * (an AABB centered on their position) intersects that enemy's room — its
   * `home` rectangle. Sticky: a discovered enemy stays visible on the minimap
   * even after the player leaves the room.
   */
  private updateRoomDiscovery(): void {
    const r = this.player.radius;
    const px = this.player.posX;
    const py = this.player.posY;
    for (const enemy of this.enemies) {
      if (enemy.discovered) continue;
      const home = enemy.home;
      const intersects =
        px + r > home.x && px - r < home.x + home.w && py + r > home.y && py - r < home.y + home.h;
      if (intersects) enemy.discovered = true;
    }
  }

  /** Advance the frame-based visual-effect timers by one frame. */
  private tickEffects(): void {
    if (this.flashFrames > 0) this.flashFrames -= 1;
    if (this.muzzleFrames > 0) this.muzzleFrames -= 1;
    if (this.cheatToastFrames > 0) this.cheatToastFrames -= 1;
    tickBulletTraces(this.traces);
    tickFlameStreams(this.flameStreams);
    for (const enemy of this.enemies) {
      if (enemy.hitFlash > 0) enemy.hitFlash -= 1;
    }
  }

  private handleMovement(dt: number): void {
    const sprinting = this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight");
    const step = MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1) * dt;
    const startX = this.player.posX;
    const startY = this.player.posY;
    if (this.input.isDown("KeyW")) this.player.moveForward(step, this.map);
    if (this.input.isDown("KeyS")) this.player.moveForward(-step, this.map);
    if (this.input.isDown("KeyD")) this.player.strafe(step, this.map);
    if (this.input.isDown("KeyA")) this.player.strafe(-step, this.map);

    // Gamepad left stick: analog move/strafe, additive with keyboard (both
    // read as 0 when idle/absent, so this is a no-op without a pad plugged in).
    const gpForward = this.input.gamepadForward();
    const gpStrafe = this.input.gamepadStrafe();
    if (gpForward !== 0) this.player.moveForward(step * gpForward, this.map);
    if (gpStrafe !== 0) this.player.strafe(step * gpStrafe, this.map);

    // Camera rotation is exclusively Q/E + mouse (+ the gamepad's right
    // stick) — A/D strafe instead, so turning stays a keyboard key away from
    // WASD rather than an arrow-key reach.
    const rot = ROT_SPEED * dt;
    if (this.input.isDown("KeyQ")) this.player.rotate(-rot);
    if (this.input.isDown("KeyE")) this.player.rotate(rot);

    const gpTurn = this.input.gamepadTurn();
    if (gpTurn !== 0) this.player.rotate(rot * gpTurn);

    const mouseDX = this.input.consumeMouseDX();
    if (mouseDX !== 0) this.player.rotate(mouseDX * MOUSE_SENSITIVITY);

    // Footsteps: accumulate ground actually covered (blocked moves count for
    // nothing) and tick a quiet step once per stride.
    const moved = Math.hypot(this.player.posX - startX, this.player.posY - startY);
    this.moving = moved > 1e-4 && this.state === "playing";
    if (this.moving) {
      this.distanceTraveled += moved;
      this.stepDistance += moved;
      if (this.stepDistance >= STRIDE_LENGTH) {
        audio.playStep();
        this.stepDistance -= STRIDE_LENGTH;
      }
    }
  }

  /**
   * Advance the head-bob and recoil animation. The bob phase only runs while
   * moving; its amplitude eases in/out so starting and stopping is smooth. The
   * recoil lerps back to rest every frame. Returns the derived offsets for this
   * frame (camera horizon shift plus weapon bob), consumed by the renderer.
   */
  private updateViewmodel(dt: number): { horizonShift: number; bobX: number; bobY: number } {
    if (this.moving) this.bobTime += dt;
    const target = this.moving ? 1 : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, dt * BOB_EASE);
    this.recoil += (0 - this.recoil) * Math.min(1, dt * RECOIL_RECOVERY);
    this.meleeRecoil += (0 - this.meleeRecoil) * Math.min(1, dt * RECOIL_RECOVERY);

    const phase = this.bobTime * BOB_FREQUENCY;
    // Horizontal sway is one cycle per stride; vertical bounces twice (a dip on
    // each footfall) — the classic head-bob relationship.
    const bobH = Math.sin(phase) * this.bobAmount;
    const bobV = Math.sin(phase * 2) * this.bobAmount;
    return {
      horizonShift: bobV * CAMERA_BOB_PX,
      bobX: bobH * WEAPON_BOB_X_PX,
      bobY: bobV * WEAPON_BOB_Y_PX,
    };
  }

  /**
   * Run the enemy chase/attack AI for this frame and apply any melee damage it
   * dealt to the player. Enemies home in when the player is within their aggro
   * radius and bite on a per-enemy cooldown once adjacent.
   */
  private updateEnemyAi(dt: number): void {
    if (this.state !== "playing") return;
    const beforeShots = this.projectiles.length;
    const dmg = updateEnemies(this.enemies, this.player, this.map, dt, this.projectiles, this.rng);
    if (this.projectiles.length > beforeShots) audio.playEnemyShoot();
    // Difficulty scales enemy-*dealt* damage only — melee bites and ranged
    // bolts, not trap/hazard/self-inflicted (rocket splash) damage.
    if (dmg > 0) this.damage(dmg * this.difficultyMultipliers.damage);
  }

  /** Advance enemy bolts; apply any that struck the player this frame. */
  private updateProjectiles(dt: number): void {
    if (this.state !== "playing") return;
    const dmg = updateProjectiles(this.projectiles, this.player, this.map, dt);
    if (dmg > 0) this.damage(dmg * this.difficultyMultipliers.damage);
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
    const blasts = updateRockets(this.rockets, this.enemies, this.map, dt);
    for (const blast of blasts) {
      audio.playRocketExplosion();
      spawnExplosion(this.explosions, blast.x, blast.y, ROCKET_BLAST_RADIUS);
      spawnExplosionParticles(this.explosionParticles, blast.x, blast.y);

      const playerDmg = rocketDamageAt(blast, this.player.posX, this.player.posY);
      if (playerDmg > 0) this.damage(playerDmg);

      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const dmg = rocketDamageAt(blast, enemy.x, enemy.y);
        if (dmg > 0) this.damageEnemy(enemy, dmg);
      }
    }
  }

  /** Drain stability while the player stands in an acid (hazard) tile. */
  private applyHazardDamage(dt: number): void {
    if (this.state !== "playing") return;
    const cx = Math.floor(this.player.posX);
    const cy = Math.floor(this.player.posY);
    if (isHazard(this.map, cx, cy)) this.damage(HAZARD_DPS * dt);
  }

  /**
   * Drain stability while standing on an active spike trap, and detonate any
   * proximity mine whose fuse the player didn't back away from in time.
   */
  private applyTrapDamage(dt: number): void {
    if (this.state !== "playing") return;
    const spike = spikeDamage(this.map.spikeTraps, this.player, this.levelTime, dt);
    if (spike > 0) this.damage(spike);

    for (const detonation of updateMines(this.map.mines, this.player, dt)) {
      audio.playExplosion();
      spawnExplosion(this.explosions, detonation.x, detonation.y, MINE_BLAST_RADIUS);
      spawnExplosionParticles(this.explosionParticles, detonation.x, detonation.y);
      if (detonation.damage > 0) this.damage(detonation.damage);
    }
  }

  /** Pick up any key the player has walked onto. */
  private collectKeys(): void {
    if (this.state !== "playing") return;
    for (const item of this.map.keys) {
      if (item.collected) continue;
      const dx = item.x - this.player.posX;
      const dy = item.y - this.player.posY;
      if (dx * dx + dy * dy < KEY_PICKUP_RADIUS * KEY_PICKUP_RADIUS) {
        item.collected = true;
        this.keysHeld += 1;
        console.log(
          `%c[key] dependency key acquired — ${this.keysHeld} in inventory`,
          "color:#f2d64b",
        );
      }
    }
  }

  /**
   * Pick up any dynamic loot drop or statically-placed map ammo pickup the
   * player has walked onto, applying whatever it grants.
   */
  private collectLoot(): void {
    if (this.state !== "playing") return;
    const r2 = AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      const dx = drop.x - this.player.posX;
      const dy = drop.y - this.player.posY;
      if (dx * dx + dy * dy >= r2) continue;
      this.drops.splice(i, 1);
      this.applyLoot(drop);
    }

    for (const pickup of this.map.ammoPickups) {
      if (pickup.collected) continue;
      const dx = pickup.x - this.player.posX;
      const dy = pickup.y - this.player.posY;
      if (dx * dx + dy * dy >= r2) continue;
      pickup.collected = true;
      audio.playPickup();
      if (pickup.kind === "weapon") {
        // Own message/amount logic (unlock vs. already-owned top-up) — the
        // generic "+N kind found" log below doesn't apply to it.
        if (pickup.weaponIndex !== undefined) this.grantOrTopUpWeapon(pickup.weaponIndex);
        continue;
      }
      const amount = this.scaledLootAmount(pickup.amount);
      switch (pickup.kind) {
        case "bullets":
          this.bulletsAmmo += amount;
          break;
        case "rockets":
          this.rocketsAmmo += amount;
          break;
        case "health":
          this.health = Math.min(MAX_HEALTH, this.health + amount);
          break;
        case "swap":
          this.swap = Math.min(MAX_SWAP, this.swap + amount);
          break;
      }
      console.log(`%c[pickup] +${amount} ${pickup.kind} found`, "color:#3fd0e0");
    }
  }

  /** Scale a base loot/pickup amount by the difficulty's `ammoDropRate`
   * (Easy is more generous, Hard scarcer) — always at least 1, so rounding
   * down on Hard can never zero out a pickup entirely. */
  private scaledLootAmount(baseAmount: number): number {
    return Math.max(1, Math.round(baseAmount * this.difficultyMultipliers.ammoDropRate));
  }

  /** Apply one dynamic loot drop's effect and log it. */
  private applyLoot(drop: LootDrop): void {
    audio.playPickup();
    switch (drop.kind) {
      case "bullets": {
        const amount = this.scaledLootAmount(drop.amount ?? BULLETS_DROP_AMOUNT);
        this.bulletsAmmo += amount;
        console.log(`%c[loot] +${amount} bullets`, "color:#3fd0e0");
        break;
      }
      case "rockets": {
        const amount = this.scaledLootAmount(drop.amount ?? ROCKETS_DROP_AMOUNT);
        this.rocketsAmmo += amount;
        console.log(`%c[loot] +${amount} rockets`, "color:#ff9d3f");
        break;
      }
      case "smg": {
        const amount = this.scaledLootAmount(drop.amount ?? SMG_DROP_AMOUNT);
        this.smgAmmo += amount;
        console.log(`%c[loot] +${amount} smg ammo`, "color:#3fa9ff");
        break;
      }
      case "gas": {
        const amount = this.scaledLootAmount(drop.amount ?? GAS_DROP_AMOUNT);
        this.gasAmmo += amount;
        console.log(`%c[loot] +${amount} gas`, "color:#ff5a1a");
        break;
      }
      case "health": {
        const amount = this.scaledLootAmount(drop.amount ?? HEALTH_DROP_AMOUNT);
        this.health = Math.min(MAX_HEALTH, this.health + amount);
        console.log(`%c[loot] +${amount} stability`, "color:#4cff6a");
        break;
      }
      case "swap": {
        const amount = this.scaledLootAmount(drop.amount ?? SWAP_DROP_AMOUNT);
        this.swap = Math.min(MAX_SWAP, this.swap + amount);
        console.log(`%c[loot] +${amount} swap`, "color:#4a7fff");
        break;
      }
      case "weapon":
        if (drop.weaponIndex !== undefined) this.grantOrTopUpWeapon(drop.weaponIndex);
        break;
    }
  }

  /**
   * Grant a still-unowned weapon, switching to it immediately — or, if it's
   * already owned by the time this is collected (e.g. a duplicate roll from
   * another Elite kill or secret room), an elite-sized top-up of whatever
   * ammo pool it uses instead, so the pickup/drop is never just wasted.
   * Shared by `applyLoot`'s `"weapon"` `LootDrop` case and `collectLoot`'s
   * `"weapon"` static `AmmoPickup` case.
   */
  private grantOrTopUpWeapon(weaponIndex: number): void {
    const weapon = WEAPONS[weaponIndex];
    if (this.ownedWeapons.has(weaponIndex)) {
      if (weapon.ammoType === "rockets") {
        const amount = this.scaledLootAmount(ELITE_ROCKETS_DROP_AMOUNT);
        this.rocketsAmmo += amount;
        console.log(`%c[loot] +${amount} rockets (${weapon.name} already owned)`, "color:#ff9d3f");
      } else if (weapon.ammoType === "smg") {
        const amount = this.scaledLootAmount(ELITE_SMG_DROP_AMOUNT);
        this.smgAmmo += amount;
        console.log(`%c[loot] +${amount} smg ammo (${weapon.name} already owned)`, "color:#3fa9ff");
      } else if (weapon.ammoType === "gas") {
        const amount = this.scaledLootAmount(ELITE_GAS_DROP_AMOUNT);
        this.gasAmmo += amount;
        console.log(`%c[loot] +${amount} gas (${weapon.name} already owned)`, "color:#ff5a1a");
      } else if (weapon.ammoType === "bullets") {
        const amount = this.scaledLootAmount(ELITE_BULLETS_DROP_AMOUNT);
        this.bulletsAmmo += amount;
        console.log(`%c[loot] +${amount} bullets (${weapon.name} already owned)`, "color:#3fd0e0");
      }
    } else {
      this.ownedWeapons.add(weaponIndex);
      this.weaponIndex = weaponIndex;
      console.log(`%c[loot] unlocked ${weapon.name}!`, "color:#e06aff;font-weight:bold");
    }
  }

  /**
   * If the player is walking into a locked door and holds a key, spend the key
   * and open the door (its tile becomes plain floor).
   */
  private openDoorAhead(): void {
    if (this.state !== "playing" || this.keysHeld <= 0) return;

    // Which way is the player pushing? Forward (W) or backward (S) along dir.
    let sign = 0;
    if (this.input.isDown("KeyW")) sign += 1;
    if (this.input.isDown("KeyS")) sign -= 1;
    if (sign === 0) return;

    const reach = this.player.radius + 0.15;
    const px = this.player.posX + this.player.dirX * sign * reach;
    const py = this.player.posY + this.player.dirY * sign * reach;
    const cx = Math.floor(px);
    const cy = Math.floor(py);

    if (this.map.grid[cy]?.[cx] === DOOR_TILE) {
      this.map.grid[cy][cx] = 0;
      this.keysHeld -= 1;
      console.log(
        `%c[door] unlocked with a dependency key — ${this.keysHeld} left`,
        "color:#568ebe;font-weight:bold",
      );
    }
  }

  /**
   * Warp the player when they step onto a goto/label teleporter pad. Tracked
   * by tile rather than a cooldown timer: arriving on a pad suppresses only
   * that exact tile until the player leaves it, so the destination pad
   * (itself a teleporter tile) can't immediately bounce them back, however
   * long they linger there.
   */
  private checkTeleporters(): void {
    if (this.state !== "playing") return;
    const cx = Math.floor(this.player.posX);
    const cy = Math.floor(this.player.posY);
    if (this.map.grid[cy]?.[cx] !== TELEPORTER_TILE) {
      this.suppressTeleportAt = null;
      return;
    }

    const tileKey = `${cx},${cy}`;
    if (tileKey === this.suppressTeleportAt) return;

    const pad = this.map.teleporters.find((t) => Math.floor(t.x) === cx && Math.floor(t.y) === cy);
    if (!pad) return;

    this.player.posX = pad.targetX;
    this.player.posY = pad.targetY;
    this.suppressTeleportAt = `${Math.floor(pad.targetX)},${Math.floor(pad.targetY)}`;
    audio.playTeleport();
    console.log(`%c[goto] warped via label "${pad.label}"`, "color:#c86dff;font-weight:bold");
  }

  /**
   * Sound a pulsing warning beep once per second while stability is critically
   * low (below 25%). Resets when health recovers or the run ends, so re-entering
   * the low band beeps immediately.
   */
  private updateLowHealthAlarm(dt: number): void {
    const critical =
      this.state === "playing" && this.health > 0 && this.health < MAX_HEALTH * LOW_HEALTH_FRACTION;
    if (!critical) {
      this.alarmCountdown = 0;
      return;
    }
    if (this.alarmCountdown <= 0) {
      audio.playAlarm();
      this.alarmCountdown = LOW_HEALTH_BEEP_INTERVAL;
    }
    this.alarmCountdown -= dt;
  }

  /**
   * Apply `amount` of stability loss; ends the run on reaching 0. Swap
   * absorbs damage 1:1 before health does, so it's spent down first.
   */
  private damage(amount: number): void {
    if (this.godMode || amount <= 0) return;
    // Kick the red screen flash back to full strength on any damage taken.
    this.flashFrames = DAMAGE_FLASH_FRAMES;
    audio.playDamage();
    let remaining = amount;
    if (this.swap > 0) {
      const absorbed = Math.min(this.swap, remaining);
      this.swap -= absorbed;
      remaining -= absorbed;
    }
    this.health -= remaining;
    if (this.health <= 0) {
      this.health = 0;
      this.endGame("over");
    }
  }

  /**
   * Apply a classic Doom cheat code once its full sequence has been typed
   * (see `InputController.onKeyDown`). IDDQD/IDCLIP toggle (re-typing turns
   * them back off, exactly like real Doom); IDKFA is a one-time grant, not a
   * toggle (also matching real Doom — re-typing it is a harmless no-op).
   */
  private applyCheat(code: string): void {
    switch (code) {
      case "IDDQD":
        this.godMode = !this.godMode;
        this.showCheatToast(`IDDQD — God mode ${this.godMode ? "ON" : "OFF"}`);
        break;
      case "IDCLIP":
        this.player.noClip = !this.player.noClip;
        this.showCheatToast(`IDCLIP — No-clip ${this.player.noClip ? "ON" : "OFF"}`);
        break;
      case "IDKFA":
        for (let i = 0; i < WEAPONS.length; i++) this.ownedWeapons.add(i);
        this.bulletsAmmo = CHEAT_MAX_AMMO;
        this.rocketsAmmo = CHEAT_MAX_AMMO;
        this.smgAmmo = CHEAT_MAX_AMMO;
        this.gasAmmo = CHEAT_MAX_AMMO;
        this.swap = MAX_SWAP;
        this.showCheatToast("IDKFA — Full arsenal");
        break;
      default:
        return;
    }
    this.handlers.onCheatActivated?.(code);
  }

  private showCheatToast(text: string): void {
    this.cheatToastText = text;
    this.cheatToastFrames = CHEAT_TOAST_FRAMES;
  }

  /** Win when the player stands on the exit tile (the return statement). */
  private checkExit(): void {
    if (this.state !== "playing") return;
    if (
      Math.floor(this.player.posX) === this.map.exit.x &&
      Math.floor(this.player.posY) === this.map.exit.y
    ) {
      this.endGame("won");
    }
  }

  /**
   * Whether `index` is a ranged weapon the player currently owns and can
   * switch to via a number key or the mousewheel — melee weapons (anything
   * with `meleeRange` set) are structurally excluded, since the knife is
   * bound exclusively to Left-Ctrl's quick-melee action instead of a slot.
   */
  private canWieldViaNumberKey(index: number): boolean {
    return index >= 0 && index < WEAPONS.length && WEAPONS[index].meleeRange === undefined && this.ownedWeapons.has(index);
  }

  /**
   * Switch to the next/previous number-key-reachable weapon from the
   * currently equipped one, wrapping around, skipping melee and unowned
   * slots (see `canWieldViaNumberKey`). Does nothing if no other reachable
   * weapon is owned.
   */
  private cycleWeapon(direction: 1 | -1): void {
    const n = WEAPONS.length;
    let i = this.weaponIndex;
    for (let steps = 0; steps < n; steps++) {
      i = (i + direction + n) % n;
      if (this.canWieldViaNumberKey(i)) {
        this.weaponIndex = i;
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
   * (Left-Ctrl) is a separate, always-available action handled in `advance()`
   * — it never goes through this cooldown/auto-fire gating at all.
   */
  /** Current reserve of `type`'s ammo pool. */
  private ammoPool(type: AmmoType): number {
    if (type === "bullets") return this.bulletsAmmo;
    if (type === "rockets") return this.rocketsAmmo;
    if (type === "smg") return this.smgAmmo;
    return this.gasAmmo;
  }

  private updateFiring(dt: number): void {
    if (this.weaponCooldown > 0) this.weaponCooldown = Math.max(0, this.weaponCooldown - dt);
    const weapon = WEAPONS[this.weaponIndex];
    const pressed = this.input.consumeFire();

    if (weapon.auto) {
      if (this.input.isFireHeld() && this.weaponCooldown <= 0) {
        this.fire();
        this.weaponCooldown = weapon.fireIntervalSec ?? 0.1;
      }
    } else if (pressed && this.weaponCooldown <= 0) {
      this.fire();
      if (weapon.fireIntervalSec) this.weaponCooldown = weapon.fireIntervalSec;
    }
  }

  /**
   * Fire `weapon` — the equipped weapon by default, or an arbitrary one (the
   * quick-melee action passes `MELEE_WEAPON` directly, bypassing `weaponIndex`
   * entirely — see the Left-Ctrl handling in `advance()`). Spends its ammo
   * cost from the right pool (a no-op for the knife, which has none), then
   * either resolves one hitscan per pellet across its cone (the pistol is a
   * single centered ray; the shotgun sprays several pellets that each
   * independently hit whatever's under their offset screen column) or, for
   * the rocket launcher, launches a real projectile instead (see `rockets.ts`).
   * A hitscan pellet hits an enemy first, or failing that a spotted proximity
   * mine, which a shot destroys outright (see `destroyMine`).
   */
  private fire(weapon: Weapon = WEAPONS[this.weaponIndex]): void {
    if (weapon.ammoType) {
      const have = this.ammoPool(weapon.ammoType);
      if (have < weapon.ammoPerShot) {
        console.log(`[${weapon.name}] out of ${weapon.ammoType} — need ${weapon.ammoPerShot}`);
        return;
      }
      if (weapon.ammoType === "bullets") this.bulletsAmmo -= weapon.ammoPerShot;
      else if (weapon.ammoType === "rockets") this.rocketsAmmo -= weapon.ammoPerShot;
      else if (weapon.ammoType === "smg") this.smgAmmo -= weapon.ammoPerShot;
      else this.gasAmmo -= weapon.ammoPerShot;
    }

    audio.playShoot();
    // Kick the viewmodel: full recoil, easing back over the next frames. No
    // muzzle flash for the knife — a stab doesn't have one. A melee call
    // (weapon.meleeRange !== undefined) never touches `recoil` — the caller
    // already drives its own `meleeRecoil` overlay instead, so a quick-melee
    // swing can't stomp whatever ranged weapon's recoil animation was
    // actually mid-flight.
    if (weapon.meleeRange === undefined) this.recoil = 1;
    if (weapon.ammoType) this.muzzleFrames = MUZZLE_FLASH_FRAMES;

    if (weapon.isRocket) {
      spawnRocket(this.rockets, this.player.posX, this.player.posY, this.player.dirX, this.player.dirY, weapon.damagePerPellet);
      console.log(`[${weapon.name}] launched`);
      return;
    }

    const { width, height } = this.ctx.canvas;
    const center = width / 2;
    let pelletsHit = 0;
    // Friday Hotfix draws one fanning flame stream for the whole shot instead
    // of a per-pellet tracer line (see `FlameStream`'s doc comment) — tracked
    // across the loop below as the widest spread any pellet actually landed
    // on, post-Cone-of-Fire deviation.
    const isFlame = weapon.ammoType === "gas";
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
        const baseCol = Math.min(width - 1, Math.max(0, Math.round(baseColumn)));
        const range = this.zBuffer[baseCol];
        const rangeFraction = Math.min(1, range / FOG_FAR);
        const maxDeviation = weapon.maxConeDeviationPx ?? MAX_CONE_DEVIATION_PX;
        const deviation = (this.rng() * 2 - 1) * rangeFraction * rangeFraction * rangeFraction * maxDeviation;
        column = Math.min(width - 1, Math.max(0, baseColumn + deviation));
      }

      // Tracer from the muzzle (bottom center) to this pellet's aim column at
      // crosshair height, in the weapon's own tracer color — drawn whether or
      // not it connects. Friday Hotfix skips this in favor of one flame
      // stream for the whole shot, pushed after the loop below.
      if (isFlame) {
        flameLeft = Math.min(flameLeft, column);
        flameRight = Math.max(flameRight, column);
      } else {
        this.traces.push(makeBulletTrace(width, height, column, height / 2, weapon.tracerColor));
      }

      const enemy = findTargetAtColumn(this.player, this.enemies, this.zBuffer, width, height, column);
      if (enemy?.alive) {
        // Melee only actually connects within its stabbing range, even if the
        // column lines up with something farther away down the same
        // sightline; Friday Hotfix's `maxRange` is the same idea for a
        // flamethrower's genuinely short reach.
        const rangeLimit = weapon.meleeRange ?? weapon.maxRange;
        if (rangeLimit !== undefined) {
          const dist = Math.hypot(enemy.x - this.player.posX, enemy.y - this.player.posY);
          if (dist > rangeLimit) continue;
        }
        this.damageEnemy(enemy, weapon.damagePerPellet, weapon.lifesteal, isFlame);
        pelletsHit += 1;
        continue;
      }

      if (weapon.meleeRange === undefined) {
        const mine = findMineAtColumn(this.player, this.map.mines, this.zBuffer, width, height, column);
        if (mine) {
          if (weapon.maxRange !== undefined) {
            const dist = Math.hypot(mine.x - this.player.posX, mine.y - this.player.posY);
            if (dist > weapon.maxRange) continue;
          }
          this.destroyMine(mine);
          pelletsHit += 1;
        }
      }
    }

    if (isFlame && flameRight >= flameLeft) {
      this.flameStreams.push(spawnFlameStream(height, flameLeft, flameRight, weapon.tracerColor));
    }

    if (pelletsHit === 0) console.log(`[${weapon.name}] missed`);
  }

  /**
   * Destroy a spotted proximity mine hit by gunfire instead of letting it
   * detonate underfoot — the same distance-scaled blast as a proximity
   * detonation applies, so shooting one from beyond its blast radius is a
   * genuinely safe disarm, while shooting one at point-blank still hurts.
   */
  private destroyMine(mine: Mine): void {
    const dmg = detonateMine(mine, this.player);
    audio.playExplosion();
    spawnExplosion(this.explosions, mine.x, mine.y, MINE_BLAST_RADIUS);
    spawnExplosionParticles(this.explosionParticles, mine.x, mine.y);
    console.log(`%c[mine] destroyed by gunfire${dmg > 0 ? ` — caught ${Math.round(dmg)} splash damage` : " — safely disarmed at range"}`, "color:#ff5050");
    if (dmg > 0) this.damage(dmg);
  }

  /**
   * Apply weapon damage to one enemy, retiring it (with a log) at 0 HP. If the
   * killing weapon has `lifesteal`, restore that much stability to the player.
   * `burning` (Friday Hotfix hits only) layers a handful of cosmetic embers on
   * top of the usual blood spray — purely visual, no damage-over-time follows.
   */
  private damageEnemy(enemy: Enemy, amount: number, lifesteal?: number, burning?: boolean): void {
    // Hit feedback: thud sound, tint the sprite red, spray "digital blood".
    audio.playHit();
    enemy.hitFlash = HIT_FLASH_FRAMES;
    if (burning) spawnBurnParticles(this.burnParticles, enemy.x, enemy.y);
    // Damage aggro: being shot instantly wakes the enemy, even from beyond its
    // aggro radius, so you can't safely snipe a roaming enemy from afar.
    enemy.aggroed = true;
    const baseBloodCount = 3 + Math.floor(Math.random() * 3);
    spawnBlood(this.blood, enemy.x, enemy.y, Math.round(baseBloodCount * this.goreMultipliers.count));
    enemy.hp -= amount;
    if (enemy.hp > 0) {
      console.log(`[hit] ${enemy.entity.name}() — HP ${enemy.hp}/${enemy.maxHp}`);
      return;
    }
    enemy.hp = 0;
    enemy.alive = false;
    this.kills += 1;
    this.killScore += killPoints(enemy);
    if (this.target === enemy) this.target = null;
    if (lifesteal) this.health = Math.min(MAX_HEALTH, this.health + lifesteal);

    if (enemy.elite) this.dropEliteLoot(enemy);
    else
      this.drops.push({
        x: enemy.x,
        y: enemy.y,
        kind: rollLoot(
          this.map.bonusLevel,
          this.difficultyLevel,
          this.rng,
          this.ownedWeapons.has(GHIDRA_WEAPON_INDEX),
          this.ownedWeapons.has(GDB_WEAPON_INDEX),
          this.health >= MAX_HEALTH,
          this.ownedWeapons.has(FRIDAY_HOTFIX_WEAPON_INDEX),
        ),
      });
    audio.playAmmoDrop();

    const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    console.log(
      `%c[KILL] ${enemy.elite ? "ELITE " : ""}${enemy.entity.kind} ${enemy.entity.name}() eliminated — ${remaining} enemies remaining`,
      "color:#37d24a;font-weight:bold",
    );
  }

  /**
   * An Elite's death always leaves something worth the fight: a still-unowned
   * heavier weapon (gdb or ghidra — see `UNLOCKABLE_WEAPONS`) if the
   * player doesn't have one yet, picked up automatically like any other
   * loot drop, or a large stability pack once both are already owned. A
   * health pack would be wasted at full health, so that case rolls an
   * elite-sized ammo/swap drop instead.
   */
  private dropEliteLoot(enemy: Enemy): void {
    const missing = UNLOCKABLE_WEAPONS.filter((i) => !this.ownedWeapons.has(i));
    if (missing.length > 0 && this.rng() < 0.5) {
      const weaponIndex = missing[Math.floor(this.rng() * missing.length)];
      this.drops.push({ x: enemy.x, y: enemy.y, kind: "weapon", weaponIndex });
    } else if (this.health >= MAX_HEALTH) {
      const kind = this.rng() < 0.5 ? "bullets" : "swap";
      const amount = kind === "bullets" ? ELITE_BULLETS_DROP_AMOUNT : ELITE_SWAP_DROP_AMOUNT;
      this.drops.push({ x: enemy.x, y: enemy.y, kind, amount });
    } else {
      this.drops.push({ x: enemy.x, y: enemy.y, kind: "health", amount: ELITE_HEALTH_DROP_AMOUNT });
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
    if (this.state !== "playing") return;
    this.state = state;
  }

  /** Snapshot the live stats consumed by both the native HUD and the host. */
  private buildStats(): EngineStats {
    const score =
      this.priorScore +
      computeScore({
        killPoints: this.killScore,
        finalHealth: this.health,
        maxHealth: MAX_HEALTH,
        finalBullets: this.bulletsAmmo,
        finalRockets: this.rocketsAmmo,
        finalSmg: this.smgAmmo,
        finalGas: this.gasAmmo,
        startingBullets: this.startingBulletsRef,
        startingRockets: this.startingRocketsRef,
        startingSmg: this.startingSmgRef,
        startingGas: this.startingGasRef,
        levelTimeSec: this.levelTime,
        distanceTraveledTiles: this.distanceTraveled,
        shortestPathTiles: this.map.shortestPathTiles,
        mapCompletionFrac: this.visitedWalkableCount / this.totalWalkableTiles,
        uniqueLoreTerminalsRead: this.loreRead.size,
        uniqueSecretRoomsOpened: this.secretRoomsOpened.size,
      }).total;

    return {
      health: Math.ceil(this.health),
      maxHealth: MAX_HEALTH,
      swap: Math.ceil(this.swap),
      bullets: this.bulletsAmmo,
      rockets: this.rocketsAmmo,
      smg: this.smgAmmo,
      gas: this.gasAmmo,
      keysHeld: this.keysHeld,
      keysTotal: this.map.keys.length,
      score,
      kills: this.kills,
      weaponIndex: this.weaponIndex,
      ownedWeapons: [...this.ownedWeapons],
      godMode: this.godMode,
      noClip: this.player.noClip,
    };
  }
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

/**
 * Give the player enough bullets to clear the level with the pistol, plus a
 * generous margin, so the fight itself never grinds to a halt for lack of
 * ammo — but scattered ammo pickups are still meant to matter across a real
 * playthrough (missed shots, backtracking, mixing in the heavier shotgun),
 * not just be a nice-to-have. Scales with both total enemy HP (`shotsToClear`,
 * the theoretical perfect-accuracy cost) and raw enemy count (`missBuffer`,
 * covering the missed shots/repositioning a pack of separate encounters
 * costs that a flat HP-total multiplier alone wouldn't capture). The shotgun
 * (and MP) trade bullet efficiency for burst/rate-of-fire, so this
 * undercounts their cost.
 */
function startingBullets(enemies: Enemy[]): number {
  const pistolDamage = WEAPONS[0].damagePerPellet;
  const shotsToClear = enemies.reduce(
    (n, e) => n + Math.ceil(e.maxHp / pistolDamage),
    0,
  );
  const missBuffer = enemies.length * 2.5;
  return Math.max(28, Math.round(shotsToClear * 1.7 + missBuffer) + 10);
}

/**
 * A modest flat reserve of rockets — not scaled to the level like
 * `startingBullets`, since ghidra itself has to be earned from
 * an Elite kill first; most levels' rockets go unused until it's unlocked, at
 * which point they (and any since scavenged) carry over via `EngineCarryover`.
 */
const STARTING_ROCKETS = 4;

function startingRockets(): number {
  return STARTING_ROCKETS;
}

/**
 * A modest flat reserve of smg ammo — same "not scaled to the level" shape as
 * `startingRockets`, since gdb itself has to be earned first (an Elite kill,
 * or the level-4 forced-unlock safety net). A bit more than one regular
 * `SMG_DROP_AMOUNT` pickup, so the weapon feels usable right away once it's
 * actually unlocked rather than emptying in a couple of bursts.
 */
const STARTING_SMG_AMMO = 40;

function startingSmg(): number {
  return STARTING_SMG_AMMO;
}

/** A modest flat reserve of gas ammo — same "not scaled to the level" shape
 * as `startingRockets`/`startingSmg`, since Friday Hotfix itself has to be
 * earned first (an Elite kill, or the level-12 forced-unlock safety net). */
const STARTING_GAS_AMMO = 40;

function startingGas(): number {
  return STARTING_GAS_AMMO;
}
