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
import { Player, isHazard } from "./player";
import { updateEnemies } from "./enemyAi";
import { collectProjectileBillboards, updateProjectiles, type Projectile } from "./projectiles";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";
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
import { drawCrosshair, drawHud, drawLoreOverlay, drawPauseOverlay } from "./hud";
import { drawWeapon } from "./viewmodel";
import { drawAutomap } from "./automap";
import {
  DAMAGE_FLASH_FRAMES,
  DEFAULT_GORE_LEVEL,
  GORE_MULTIPLIERS,
  HIT_FLASH_FRAMES,
  drawBulletTraces,
  drawDamageFlash,
  makeBulletTrace,
  renderBlood,
  renderExplosions,
  spawnBlood,
  spawnExplosion,
  tickBulletTraces,
  updateBlood,
  updateExplosions,
  type BloodParticle,
  type BulletTrace,
  type Explosion,
  type GoreLevel,
  type GoreMultipliers,
} from "./effects";
import { audio } from "./audio";
import { MELEE_WEAPON, STARTING_WEAPONS, WEAPONS, pelletOffsets, type Weapon } from "./weapons";
import {
  ARMOR_DROP_AMOUNT,
  BULLETS_DROP_AMOUNT,
  ELITE_HEALTH_DROP_AMOUNT,
  HEALTH_DROP_AMOUNT,
  MAX_ARMOR,
  ROCKETS_DROP_AMOUNT,
  rollLoot,
} from "./loot";
import { collectRocketBillboards, rocketDamageAt, spawnRocket, updateRockets, ROCKET_BLAST_RADIUS, type Rocket } from "./rockets";
import { detonateMine, spikeDamage, updateMines } from "./traps";
import {
  DOOR_TILE,
  SECRET_WALL_TILE,
  TELEPORTER_TILE,
  type Enemy,
  type GameMap,
  type LootDrop,
  type LoreTerminal,
  type Mine,
} from "../map/types";

/** Weapon indices whose only acquisition path is an Elite kill's guaranteed
 * drop (see `dropEliteLoot`) — indices into `WEAPONS`, matching its array
 * order (MP is index 3, Rocket Launcher is index 4). */
const UNLOCKABLE_WEAPONS = [3, 4];

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
/** Starting / maximum System Stability (health), as a percentage. */
const MAX_HEALTH = 100;
/** Health lost per second while standing in an acid (hazard) tile. */
const HAZARD_DPS = 18;
/** Cone-of-Fire: screen-px of random aim deviation added per tile of range
 * a ranged weapon's pellet is aimed across (see `fire()`). */
const RANGE_DEVIATION_PX_PER_TILE = 4;
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

/** Live stats pushed to the host each frame. */
export interface EngineStats {
  /** System Stability, 0–100. */
  health: number;
  maxHealth: number;
  /** Armor points, absorbed 1:1 before health on any hit (see `damage()`). */
  armor: number;
  /** Bullets remaining (pistol/shotgun/MP). */
  bullets: number;
  /** Rockets remaining (Rocket Launcher). */
  rockets: number;
  /** Dependency keys currently held (unused, in inventory). */
  keysHeld: number;
  /** Total keys placed on this level. */
  keysTotal: number;
  /** Run score. Always 0 for now — scoring logic is a future task. */
  score: number;
  /** Enemies defeated this level ("bugs squashed" for the commit summary). */
  kills: number;
  /** Index into `WEAPONS` of the currently-equipped weapon. */
  weaponIndex: number;
  /** Indices into `WEAPONS` the player currently owns/can switch to. */
  ownedWeapons: number[];
}

/** Host callbacks. All optional. */
export interface EngineHandlers {
  onStats?: (stats: EngineStats) => void;
  onGameOver?: () => void;
  /** Fired when the player reaches the exit; receives the final stats so the
   * host can carry health/ammo into the next level. */
  onWin?: (stats: EngineStats) => void;
}

/** Health/ammo/weapon carried over from a previous level, for multi-level
 * runs or resuming a saved campaign. */
export interface EngineCarryover {
  health: number;
  armor: number;
  bullets: number;
  rockets: number;
  /** Index into `WEAPONS`; defaults to the pistol (0) when omitted. */
  weaponIndex?: number;
  /** Defaults to `STARTING_WEAPONS` when omitted. */
  ownedWeapons?: number[];
}

type GameState = "playing" | "over" | "won";

export class RaycasterEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly player: Player;
  private readonly input: InputController;
  private readonly enemies: Enemy[];
  /** Per-column wall depth from the latest wall render; used for occlusion. */
  private readonly zBuffer: Float64Array;

  private running = false;
  private rafId = 0;
  private lastTime = 0;
  /** Enemy under the crosshair this frame, if any. */
  private target: Enemy | null = null;

  private state: GameState = "playing";
  private health = MAX_HEALTH;
  /** Armor points; absorbed 1:1 before health on any hit (see `damage()`). */
  private armor = 0;
  private bulletsAmmo: number;
  private rocketsAmmo: number;
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
  /** Loot dropped by defeated enemies, awaiting collection. */
  private readonly drops: LootDrop[] = [];
  /** Frames left on the red "took damage" screen flash (0 = none). */
  private flashFrames = 0;
  /** Live weapon bullet tracers, fading over a few frames. */
  private readonly traces: BulletTrace[] = [];
  /** Live "digital blood" particles falling to the floor. */
  private readonly blood: BloodParticle[] = [];
  /** Gore-level count/size/floor-stain-duration multipliers, read once at
   * construction (see the constructor's `gore` parameter). */
  private readonly goreMultipliers: GoreMultipliers;
  /** In-flight enemy projectiles (ranged bolts). */
  private readonly projectiles: Projectile[] = [];
  /** In-flight player-fired rockets. */
  private readonly rockets: Rocket[] = [];
  /** Live rocket-blast VFX circles. */
  private readonly explosions: Explosion[] = [];
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
  /** Whether the full-screen automap overlay is up (pauses the sim). */
  private isMapActive = false;
  /** Whether the game is paused (window blur or Escape) — freezes the sim and
   * shows a "PAUSED" overlay, distinct from the Tab automap. */
  private isPaused = false;
  /** Text of the lore terminal currently being read (null = no overlay up).
   * Freezes the sim the same way `isPaused`/`isMapActive` do — see `advance()`. */
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

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: GameMap,
    private readonly handlers: EngineHandlers = {},
    carryover?: EngineCarryover,
    gore: GoreLevel = DEFAULT_GORE_LEVEL,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.input = new InputController(canvas);
    this.enemies = map.enemies;
    this.zBuffer = new Float64Array(canvas.width);
    this.bulletsAmmo = carryover?.bullets ?? startingBullets(map.enemies);
    this.rocketsAmmo = carryover?.rockets ?? startingRockets();
    this.ownedWeapons = new Set(carryover?.ownedWeapons ?? STARTING_WEAPONS);
    this.goreMultipliers = GORE_MULTIPLIERS[gore];
    if (carryover) {
      this.health = carryover.health;
      this.armor = carryover.armor;
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

    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > MAX_DT) dt = MAX_DT;

    this.advance(dt);

    if (this.running) this.rafId = requestAnimationFrame(this.frame);
  };

  /**
   * Advance the simulation and render exactly one frame over `dt` seconds.
   * Normally called by the internal rAF loop; exposed so the game can also be
   * driven at a fixed step (e.g. headless/deterministic runs).
   */
  advance(dt: number): void {
    // Window blur always forces a pause (never a toggle — you can't "un-blur"
    // by pressing something while the window doesn't have focus); Escape
    // toggles it explicitly, and a click resumes it. Always drain the click
    // flag regardless of pause state, so a stale click can't instantly
    // resume some later, unrelated pause. Checked first so a pause always
    // wins over the automap and normal play.
    const clicked = this.input.consumeClick();
    if (this.input.consumeBlur()) this.isPaused = true;
    if (this.input.consumeEscape()) this.isPaused = !this.isPaused;
    if (this.isPaused && clicked) this.isPaused = false;
    if (this.isPaused) {
      this.renderPausedOverlay();
      return;
    }

    // Tab toggles the automap, which pauses all game action while it's up.
    if (this.input.consumeMapToggle()) this.isMapActive = !this.isMapActive;
    if (this.isMapActive) {
      this.renderPaused();
      return;
    }

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
      this.renderLoreOverlay();
      return;
    }
    if (interacted && this.state === "playing") {
      const terminal = findNearbyLoreTerminal(this.map.loreTerminals, this.player.posX, this.player.posY);
      if (terminal) {
        audio.playSecret();
        this.loreText = terminal.text;
        this.loreScroll = 0;
        this.renderLoreOverlay();
        return;
      }
      this.tryOpenSecretWall();
    }

    // Weapon switching (1/2/… or mousewheel) can happen even while lining up
    // a shot — but only among ranged weapons the player actually owns (see
    // `ownedWeapons`); an unearned slot just does nothing, rather than
    // switching to a weapon with no way to have gotten it yet. Melee is
    // structurally excluded (see `canWieldViaNumberKey`) — it's bound to
    // Left-Ctrl as its own quick-attack action instead (below).
    const requested = this.input.consumeWeaponRequest();
    if (requested !== null && this.canWieldViaNumberKey(requested)) {
      this.weaponIndex = requested;
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
    updateExplosions(this.explosions, dt);
    renderExplosions(this.ctx, this.player, this.explosions, this.zBuffer);

    // Full-screen red flash when the player is taking damage.
    drawDamageFlash(this.ctx, this.flashFrames / DAMAGE_FLASH_FRAMES);

    // First-person weapon, swaying with the bob and kicking on recoil.
    // A quick-melee swing briefly overlays the knife's viewmodel on top of
    // whatever ranged weapon is actually equipped — weaponIndex, ammo, and
    // the HUD are untouched throughout (see `meleeRecoil`'s doc comment).
    const meleeOverlayActive = this.meleeRecoil > 0.02;
    drawWeapon(this.ctx, {
      bobX: view.bobX,
      bobY: view.bobY,
      recoil: meleeOverlayActive ? this.meleeRecoil : this.recoil,
      flash: meleeOverlayActive ? false : this.muzzleFrames > 0,
      kind: meleeOverlayActive ? MELEE_WEAPON.viewKind : WEAPONS[this.weaponIndex].viewKind,
    });

    drawCrosshair(this.ctx, this.target !== null, WEAPONS[this.weaponIndex].spreadPx);
    renderMinimap(this.ctx, this.map, this.player, this.levelTime);

    // Native HUD sits on top of the whole scene.
    const stats = this.buildStats();
    drawHud(this.ctx, stats);
    this.handlers.onStats?.(stats);

    // Age the frame-based effect timers now that this frame is drawn.
    this.tickEffects();

    // Fire the end-of-run handler last, once this frame is fully painted —
    // see `endGame()`'s doc comment for why this can't happen any earlier.
    if (this.state !== "playing") {
      this.stop();
      if (this.state === "over") this.handlers.onGameOver?.();
      else this.handlers.onWin?.(stats);
    }
  }

  /**
   * Render one frozen frame with the automap overlay on top. Called instead of
   * the normal update+render while the map is open, so the world stands still.
   */
  private renderPaused(): void {
    renderScene(this.ctx, this.map, this.player, this.zBuffer, 0, this.levelTime);
    this.renderWorldBillboards();
    drawAutomap(this.ctx, this.map, this.player, this.levelTime);
    this.handlers.onStats?.(this.buildStats());
  }

  /**
   * Render one frozen frame with the "PAUSED" scrim on top — triggered by
   * window blur or Escape, distinct from the Tab automap pause above.
   */
  private renderPausedOverlay(): void {
    renderScene(this.ctx, this.map, this.player, this.zBuffer, 0, this.levelTime);
    this.renderWorldBillboards();
    drawPauseOverlay(this.ctx);
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
    this.handlers.onStats?.(this.buildStats());
  }

  /**
   * Open the fake wall directly ahead of the player, if there is one — turns
   * a `SECRET_WALL_TILE` into plain floor permanently, revealing whatever
   * secret room was carved behind it (see `placeSecretRooms`).
   */
  private tryOpenSecretWall(): void {
    const px = this.player.posX + this.player.dirX * SECRET_WALL_REACH;
    const py = this.player.posY + this.player.dirY * SECRET_WALL_REACH;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (this.map.grid[cy]?.[cx] !== SECRET_WALL_TILE) return;

    this.map.grid[cy][cx] = 0;
    audio.playSecret();
    console.log(
      "%c[secret] a section of wall slides open — a hidden room lies beyond",
      "color:#e06aff;font-weight:bold",
    );
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

  /** Fog of war: reveal the player's tile and its immediate neighbors. */
  private markVisited(): void {
    const cx = Math.floor(this.player.posX);
    const cy = Math.floor(this.player.posY);
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= this.map.height) continue;
      const row = this.map.visited[y];
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x >= 0 && x < this.map.width) row[x] = true;
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
    tickBulletTraces(this.traces);
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

    // Camera rotation is exclusively Q/E + mouse — A/D strafe instead, so
    // turning stays a keyboard key away from WASD rather than an arrow-key reach.
    const rot = ROT_SPEED * dt;
    if (this.input.isDown("KeyQ")) this.player.rotate(-rot);
    if (this.input.isDown("KeyE")) this.player.rotate(rot);

    const mouseDX = this.input.consumeMouseDX();
    if (mouseDX !== 0) this.player.rotate(mouseDX * MOUSE_SENSITIVITY);

    // Footsteps: accumulate ground actually covered (blocked moves count for
    // nothing) and tick a quiet step once per stride.
    const moved = Math.hypot(this.player.posX - startX, this.player.posY - startY);
    this.moving = moved > 1e-4 && this.state === "playing";
    if (this.moving) {
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
    const dmg = updateEnemies(this.enemies, this.player, this.map, dt, this.projectiles);
    if (this.projectiles.length > beforeShots) audio.playEnemyShoot();
    if (dmg > 0) this.damage(dmg);
  }

  /** Advance enemy bolts; apply any that struck the player this frame. */
  private updateProjectiles(dt: number): void {
    if (this.state !== "playing") return;
    const dmg = updateProjectiles(this.projectiles, this.player, this.map, dt);
    if (dmg > 0) this.damage(dmg);
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
      audio.playExplosion();
      spawnExplosion(this.explosions, blast.x, blast.y, ROCKET_BLAST_RADIUS);

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

    const mineDamage = updateMines(this.map.mines, this.player, dt);
    if (mineDamage > 0) {
      audio.playExplosion();
      this.damage(mineDamage);
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
      switch (pickup.kind) {
        case "bullets":
          this.bulletsAmmo += pickup.amount;
          break;
        case "rockets":
          this.rocketsAmmo += pickup.amount;
          break;
        case "health":
          this.health = Math.min(MAX_HEALTH, this.health + pickup.amount);
          break;
        case "armor":
          this.armor = Math.min(MAX_ARMOR, this.armor + pickup.amount);
          break;
      }
      console.log(`%c[pickup] +${pickup.amount} ${pickup.kind} found`, "color:#3fd0e0");
    }
  }

  /** Apply one dynamic loot drop's effect and log it. */
  private applyLoot(drop: LootDrop): void {
    audio.playPickup();
    switch (drop.kind) {
      case "bullets":
        this.bulletsAmmo += drop.amount ?? BULLETS_DROP_AMOUNT;
        console.log(`%c[loot] +${drop.amount ?? BULLETS_DROP_AMOUNT} bullets`, "color:#3fd0e0");
        break;
      case "rockets":
        this.rocketsAmmo += drop.amount ?? ROCKETS_DROP_AMOUNT;
        console.log(`%c[loot] +${drop.amount ?? ROCKETS_DROP_AMOUNT} rockets`, "color:#ff9d3f");
        break;
      case "health": {
        const amount = drop.amount ?? HEALTH_DROP_AMOUNT;
        this.health = Math.min(MAX_HEALTH, this.health + amount);
        console.log(`%c[loot] +${amount} stability`, "color:#4cff6a");
        break;
      }
      case "armor": {
        const amount = drop.amount ?? ARMOR_DROP_AMOUNT;
        this.armor = Math.min(MAX_ARMOR, this.armor + amount);
        console.log(`%c[loot] +${amount} armor`, "color:#4a7fff");
        break;
      }
      case "weapon":
        if (drop.weaponIndex !== undefined) {
          this.ownedWeapons.add(drop.weaponIndex);
          this.weaponIndex = drop.weaponIndex;
          console.log(`%c[loot] unlocked ${WEAPONS[drop.weaponIndex].name}!`, "color:#e06aff;font-weight:bold");
        }
        break;
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
   * Apply `amount` of stability loss; ends the run on reaching 0. Armor
   * absorbs damage 1:1 before health does, so it's spent down first.
   */
  private damage(amount: number): void {
    if (amount <= 0) return;
    // Kick the red screen flash back to full strength on any damage taken.
    this.flashFrames = DAMAGE_FLASH_FRAMES;
    audio.playDamage();
    let remaining = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, remaining);
      this.armor -= absorbed;
      remaining -= absorbed;
    }
    this.health -= remaining;
    if (this.health <= 0) {
      this.health = 0;
      this.endGame("over");
    }
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
      const have = weapon.ammoType === "bullets" ? this.bulletsAmmo : this.rocketsAmmo;
      if (have < weapon.ammoPerShot) {
        console.log(`[${weapon.name}] out of ${weapon.ammoType} — need ${weapon.ammoPerShot}`);
        return;
      }
      if (weapon.ammoType === "bullets") this.bulletsAmmo -= weapon.ammoPerShot;
      else this.rocketsAmmo -= weapon.ammoPerShot;
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

    for (const offset of pelletOffsets(weapon)) {
      // Cone of Fire: ranged weapons get a small random aim deviation that
      // grows with how far away whatever's down this column actually is (the
      // z-buffer depth there, wall or otherwise), instead of a hard max-range
      // cutoff — a shot lined up on a distant target can still go wide, while
      // point-blank shots stay accurate. Melee has no business missing this
      // way (it can't even reach past its own tiny range), so it's exempt.
      const baseColumn = center + offset;
      let column = baseColumn;
      if (weapon.meleeRange === undefined) {
        const baseCol = Math.min(width - 1, Math.max(0, Math.round(baseColumn)));
        const range = this.zBuffer[baseCol];
        const deviation = (Math.random() * 2 - 1) * range * RANGE_DEVIATION_PX_PER_TILE;
        column = Math.min(width - 1, Math.max(0, baseColumn + deviation));
      }

      // Tracer from the muzzle (bottom center) to this pellet's aim column at
      // crosshair height, in the weapon's own tracer color — drawn whether or
      // not it connects.
      this.traces.push(makeBulletTrace(width, height, column, height / 2, weapon.tracerColor));

      const enemy = findTargetAtColumn(this.player, this.enemies, this.zBuffer, width, height, column);
      if (enemy?.alive) {
        // Melee only actually connects within its stabbing range, even if the
        // column lines up with something farther away down the same sightline.
        if (weapon.meleeRange !== undefined) {
          const dist = Math.hypot(enemy.x - this.player.posX, enemy.y - this.player.posY);
          if (dist > weapon.meleeRange) continue;
        }
        this.damageEnemy(enemy, weapon.damagePerPellet, weapon.lifesteal);
        pelletsHit += 1;
        continue;
      }

      if (weapon.meleeRange === undefined) {
        const mine = findMineAtColumn(this.player, this.map.mines, this.zBuffer, width, height, column);
        if (mine) {
          this.destroyMine(mine);
          pelletsHit += 1;
        }
      }
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
    console.log(`%c[mine] destroyed by gunfire${dmg > 0 ? ` — caught ${Math.round(dmg)} splash damage` : " — safely disarmed at range"}`, "color:#ff5050");
    if (dmg > 0) this.damage(dmg);
  }

  /**
   * Apply weapon damage to one enemy, retiring it (with a log) at 0 HP. If the
   * killing weapon has `lifesteal`, restore that much stability to the player.
   */
  private damageEnemy(enemy: Enemy, amount: number, lifesteal?: number): void {
    // Hit feedback: thud sound, tint the sprite red, spray "digital blood".
    audio.playHit();
    enemy.hitFlash = HIT_FLASH_FRAMES;
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
    if (this.target === enemy) this.target = null;
    if (lifesteal) this.health = Math.min(MAX_HEALTH, this.health + lifesteal);

    if (enemy.elite) this.dropEliteLoot(enemy);
    else this.drops.push({ x: enemy.x, y: enemy.y, kind: rollLoot(this.map.bonusLevel) });
    audio.playAmmoDrop();

    const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    console.log(
      `%c[KILL] ${enemy.elite ? "ELITE " : ""}${enemy.entity.kind} ${enemy.entity.name}() eliminated — ${remaining} enemies remaining`,
      "color:#37d24a;font-weight:bold",
    );
  }

  /**
   * An Elite's death always leaves something worth the fight: a still-unowned
   * heavier weapon (MP or Rocket Launcher — see `UNLOCKABLE_WEAPONS`) if the
   * player doesn't have one yet, picked up automatically like any other
   * loot drop, or a large stability pack once both are already owned.
   */
  private dropEliteLoot(enemy: Enemy): void {
    const missing = UNLOCKABLE_WEAPONS.filter((i) => !this.ownedWeapons.has(i));
    if (missing.length > 0 && Math.random() < 0.5) {
      const weaponIndex = missing[Math.floor(Math.random() * missing.length)];
      this.drops.push({ x: enemy.x, y: enemy.y, kind: "weapon", weaponIndex });
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
    return {
      health: Math.ceil(this.health),
      maxHealth: MAX_HEALTH,
      armor: Math.ceil(this.armor),
      bullets: this.bulletsAmmo,
      rockets: this.rocketsAmmo,
      keysHeld: this.keysHeld,
      keysTotal: this.map.keys.length,
      score: 0,
      kills: this.kills,
      weaponIndex: this.weaponIndex,
      ownedWeapons: [...this.ownedWeapons],
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
 * `startingBullets`, since the Rocket Launcher itself has to be earned from
 * an Elite kill first; most levels' rockets go unused until it's unlocked, at
 * which point they (and any since scavenged) carry over via `EngineCarryover`.
 */
const STARTING_ROCKETS = 4;

function startingRockets(): number {
  return STARTING_ROCKETS;
}
