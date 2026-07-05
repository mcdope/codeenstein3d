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
import { renderProjectiles, updateProjectiles, type Projectile } from "./projectiles";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";
import {
  findMineAtColumn,
  findTargetAtColumn,
  findTargetUnderCrosshair,
  renderAmmoDrops,
  renderDecorations,
  renderExitMarker,
  renderKeys,
  renderMines,
  renderSprites,
  renderTeleporters,
} from "./sprites";
import { drawCrosshair, drawHud } from "./hud";
import { drawWeapon } from "./viewmodel";
import { drawAutomap } from "./automap";
import {
  DAMAGE_FLASH_FRAMES,
  HIT_FLASH_FRAMES,
  drawBulletTraces,
  drawDamageFlash,
  makeBulletTrace,
  renderBlood,
  spawnBlood,
  tickBulletTraces,
  updateBlood,
  type BloodParticle,
  type BulletTrace,
} from "./effects";
import { audio } from "./audio";
import { WEAPONS, pelletOffsets } from "./weapons";
import { detonateMine, spikeDamage, updateMines } from "./traps";
import { DOOR_TILE, TELEPORTER_TILE, type AmmoDrop, type Enemy, type GameMap, type Mine } from "../map/types";

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
/** Heap (ammo) restored by picking up one enemy loot drop. */
const AMMO_DROP_AMOUNT = 6;
/** How close (tiles) the player must get to pick up a dropped ammo pack. */
const AMMO_PICKUP_RADIUS = 0.5;

/** Live stats pushed to the host each frame. */
export interface EngineStats {
  /** System Stability, 0–100. */
  health: number;
  maxHealth: number;
  /** Heap / RAM (ammo) remaining. */
  ammo: number;
  /** Dependency keys currently held (unused, in inventory). */
  keysHeld: number;
  /** Total keys placed on this level. */
  keysTotal: number;
  /** Run score. Always 0 for now — scoring logic is a future task. */
  score: number;
}

/** Host callbacks. All optional. */
export interface EngineHandlers {
  onStats?: (stats: EngineStats) => void;
  onGameOver?: () => void;
  /** Fired when the player reaches the exit; receives the final stats so the
   * host can carry health/ammo into the next level. */
  onWin?: (stats: EngineStats) => void;
}

/** Health/ammo carried over from a previous level, for multi-level runs. */
export interface EngineCarryover {
  health: number;
  ammo: number;
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
  private ammo: number;
  /** Index into WEAPONS of the equipped weapon (0 = pistol). */
  private weaponIndex = 0;
  /** Dependency keys collected but not yet spent on a door. */
  private keysHeld = 0;
  /** Ammo pickups dropped by defeated enemies, awaiting collection. */
  private readonly drops: AmmoDrop[] = [];
  /** Frames left on the red "took damage" screen flash (0 = none). */
  private flashFrames = 0;
  /** Live weapon bullet tracers, fading over a few frames. */
  private readonly traces: BulletTrace[] = [];
  /** Live "digital blood" particles falling to the floor. */
  private readonly blood: BloodParticle[] = [];
  /** In-flight enemy projectiles (ranged bolts). */
  private readonly projectiles: Projectile[] = [];
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
  /** Frames left on the muzzle flash. */
  private muzzleFrames = 0;
  /** Whether the full-screen automap overlay is up (pauses the sim). */
  private isMapActive = false;
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
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.input = new InputController(canvas);
    this.enemies = map.enemies;
    this.zBuffer = new Float64Array(canvas.width);
    this.ammo = carryover?.ammo ?? startingAmmo(map.enemies);
    if (carryover) this.health = carryover.health;
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
    this.reportStats();
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
    // Tab toggles the automap, which pauses all game action while it's up.
    if (this.input.consumeMapToggle()) this.isMapActive = !this.isMapActive;
    if (this.isMapActive) {
      this.renderPaused();
      return;
    }

    // Weapon switching (1/2/…) can happen even while lining up a shot.
    const requested = this.input.consumeWeaponRequest();
    if (requested !== null && requested < WEAPONS.length) this.weaponIndex = requested;

    // Simulate (may end the game via damage or reaching the exit).
    this.levelTime += dt;
    this.handleMovement(dt);
    this.markVisited();
    this.updateRoomDiscovery();
    this.collectKeys();
    this.collectAmmoDrops();
    this.openDoorAhead();
    this.checkTeleporters();
    this.updateEnemyAi(dt);
    this.updateProjectiles(dt);
    this.applyHazardDamage(dt);
    this.applyTrapDamage(dt);
    this.updateLowHealthAlarm(dt);
    this.checkExit();

    // Head-bob / recoil offsets for this frame (camera + weapon).
    const view = this.updateViewmodel(dt);

    // Render — one final frozen frame is still drawn after the game ends.
    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, this.player, this.zBuffer, view.horizonShift, this.levelTime);
    renderDecorations(this.ctx, this.player, this.map.decorations, this.zBuffer);
    renderTeleporters(this.ctx, this.player, this.map.teleporters, this.zBuffer);
    renderMines(this.ctx, this.player, this.map.mines, this.zBuffer);
    renderSprites(this.ctx, this.player, this.enemies, this.zBuffer);
    renderProjectiles(this.ctx, this.player, this.projectiles, this.zBuffer);
    renderKeys(this.ctx, this.player, this.map.keys, this.zBuffer);
    renderAmmoDrops(this.ctx, this.player, this.drops, this.zBuffer);
    renderExitMarker(this.ctx, this.player, this.map.exit, this.zBuffer);

    this.target = findTargetUnderCrosshair(
      this.player,
      this.enemies,
      this.zBuffer,
      width,
      height,
    );

    if (this.state === "playing" && this.input.consumeFire()) this.fire();

    // In-world impact effects (above sprites): falling "digital blood" and the
    // muzzle→impact tracer lines from any shot fired this frame.
    updateBlood(this.blood, dt);
    renderBlood(this.ctx, this.player, this.blood, this.zBuffer);
    drawBulletTraces(this.ctx, this.traces);

    // Full-screen red flash when the player is taking damage.
    drawDamageFlash(this.ctx, this.flashFrames / DAMAGE_FLASH_FRAMES);

    // First-person weapon, swaying with the bob and kicking on recoil.
    drawWeapon(this.ctx, {
      bobX: view.bobX,
      bobY: view.bobY,
      recoil: this.recoil,
      flash: this.muzzleFrames > 0,
    });

    drawCrosshair(this.ctx, this.target !== null, WEAPONS[this.weaponIndex].spreadPx);
    renderMinimap(this.ctx, this.map, this.player, this.levelTime);

    // Native HUD sits on top of the whole scene.
    const stats = this.buildStats();
    drawHud(this.ctx, stats);
    this.handlers.onStats?.(stats);

    // Age the frame-based effect timers now that this frame is drawn.
    this.tickEffects();
  }

  /**
   * Render one frozen frame with the automap overlay on top. Called instead of
   * the normal update+render while the map is open, so the world stands still.
   */
  private renderPaused(): void {
    renderScene(this.ctx, this.map, this.player, this.zBuffer, 0, this.levelTime);
    renderDecorations(this.ctx, this.player, this.map.decorations, this.zBuffer);
    renderTeleporters(this.ctx, this.player, this.map.teleporters, this.zBuffer);
    renderMines(this.ctx, this.player, this.map.mines, this.zBuffer);
    renderSprites(this.ctx, this.player, this.enemies, this.zBuffer);
    renderProjectiles(this.ctx, this.player, this.projectiles, this.zBuffer);
    renderKeys(this.ctx, this.player, this.map.keys, this.zBuffer);
    renderAmmoDrops(this.ctx, this.player, this.drops, this.zBuffer);
    renderExitMarker(this.ctx, this.player, this.map.exit, this.zBuffer);
    drawAutomap(this.ctx, this.map, this.player, this.levelTime);
    this.handlers.onStats?.(this.buildStats());
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

  /** Pick up any ammo drop the player has walked onto, refilling the heap. */
  private collectAmmoDrops(): void {
    if (this.state !== "playing" || this.drops.length === 0) return;
    const r2 = AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      const dx = drop.x - this.player.posX;
      const dy = drop.y - this.player.posY;
      if (dx * dx + dy * dy < r2) {
        this.drops.splice(i, 1);
        this.ammo += AMMO_DROP_AMOUNT;
        audio.playPickup();
        console.log(
          `%c[heap] +${AMMO_DROP_AMOUNT} ammo salvaged — ${this.ammo} in heap`,
          "color:#3fd0e0",
        );
      }
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

  /** Apply `amount` of stability loss; ends the run on reaching 0. */
  private damage(amount: number): void {
    if (amount <= 0) return;
    // Kick the red screen flash back to full strength on any damage taken.
    this.flashFrames = DAMAGE_FLASH_FRAMES;
    audio.playDamage();
    this.health -= amount;
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
   * Fire the equipped weapon: spend its heap cost, then resolve one hitscan per
   * pellet across its cone. The pistol is a single centered ray; the shotgun
   * sprays several pellets that each independently hit whatever's under their
   * (offset) screen column — an enemy first, or failing that a spotted
   * proximity mine, which a shot destroys outright (see `destroyMine`).
   */
  private fire(): void {
    const weapon = WEAPONS[this.weaponIndex];
    if (this.ammo < weapon.ammoPerShot) {
      console.log(`[${weapon.name}] out of heap — need ${weapon.ammoPerShot} ammo`);
      return;
    }
    this.ammo -= weapon.ammoPerShot;
    audio.playShoot();
    // Kick the viewmodel: full recoil, easing back over the next frames.
    this.recoil = 1;
    this.muzzleFrames = MUZZLE_FLASH_FRAMES;

    const { width, height } = this.ctx.canvas;
    const center = width / 2;
    let pelletsHit = 0;

    for (const offset of pelletOffsets(weapon)) {
      // Tracer from the muzzle (bottom center) to this pellet's aim column at
      // crosshair height — drawn whether or not it connects.
      const column = center + offset;
      this.traces.push(makeBulletTrace(width, height, column, height / 2));

      const enemy = findTargetAtColumn(this.player, this.enemies, this.zBuffer, width, height, column);
      if (enemy?.alive) {
        this.damageEnemy(enemy, weapon.damagePerPellet);
        pelletsHit += 1;
        continue;
      }

      const mine = findMineAtColumn(this.player, this.map.mines, this.zBuffer, width, height, column);
      if (mine) {
        this.destroyMine(mine);
        pelletsHit += 1;
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

  /** Apply weapon damage to one enemy, retiring it (with a log) at 0 HP. */
  private damageEnemy(enemy: Enemy, amount: number): void {
    // Hit feedback: thud sound, tint the sprite red, spray "digital blood".
    audio.playHit();
    enemy.hitFlash = HIT_FLASH_FRAMES;
    // Damage aggro: being shot instantly wakes the enemy, even from beyond its
    // aggro radius, so you can't safely snipe a roaming enemy from afar.
    enemy.aggroed = true;
    spawnBlood(this.blood, enemy.x, enemy.y, 3 + Math.floor(Math.random() * 3));
    enemy.hp -= amount;
    if (enemy.hp > 0) {
      console.log(`[hit] ${enemy.entity.name}() — HP ${enemy.hp}/${enemy.maxHp}`);
      return;
    }
    enemy.hp = 0;
    enemy.alive = false;
    if (this.target === enemy) this.target = null;
    // Drop a heap (ammo) pickup where the process died.
    this.drops.push({ x: enemy.x, y: enemy.y });
    audio.playAmmoDrop();
    const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    console.log(
      `%c[KILL] ${enemy.entity.kind} ${enemy.entity.name}() eliminated — ${remaining} enemies remaining`,
      "color:#37d24a;font-weight:bold",
    );
  }

  private endGame(state: "over" | "won"): void {
    if (this.state !== "playing") return;
    this.state = state;
    this.reportStats();
    this.stop();
    if (state === "over") this.handlers.onGameOver?.();
    else this.handlers.onWin?.(this.buildStats());
  }

  private reportStats(): void {
    this.handlers.onStats?.(this.buildStats());
  }

  /** Snapshot the live stats consumed by both the native HUD and the host. */
  private buildStats(): EngineStats {
    return {
      health: Math.ceil(this.health),
      maxHealth: MAX_HEALTH,
      ammo: this.ammo,
      keysHeld: this.keysHeld,
      keysTotal: this.map.keys.length,
      score: 0,
    };
  }
}

/**
 * Give the player enough heap to clear the level with the pistol, plus a
 * generous margin, so the fight itself never grinds to a halt for lack of
 * ammo — but scattered ammo pickups are still meant to matter across a real
 * playthrough (missed shots, backtracking, mixing in the heavier shotgun),
 * not just be a nice-to-have. Scales with both total enemy HP (`shotsToClear`,
 * the theoretical perfect-accuracy cost) and raw enemy count (`missBuffer`,
 * covering the missed shots/repositioning a pack of separate encounters
 * costs that a flat HP-total multiplier alone wouldn't capture). The shotgun
 * trades heap efficiency for burst damage, so this undercounts its cost.
 */
function startingAmmo(enemies: Enemy[]): number {
  const pistolDamage = WEAPONS[0].damagePerPellet;
  const shotsToClear = enemies.reduce(
    (n, e) => n + Math.ceil(e.maxHp / pistolDamage),
    0,
  );
  const missBuffer = enemies.length * 2.5;
  return Math.max(28, Math.round(shotsToClear * 1.7 + missBuffer) + 10);
}
