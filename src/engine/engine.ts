// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * RaycasterEngine: owns the render loop, player, input, and game state for one
 * level.
 *
 * All motion is scaled by delta time so movement speed is identical whether the
 * display runs at 60, 120, or 30 fps. The engine tracks health ("System
 * Stability") and ammo ("Heap / RAM"), applies contact damage from enemies,
 * and ends the run on death (Kernel Panic) or reaching the exit (Build
 * Successful). It reports state to the host via `EngineHandlers` and leaves the
 * DOM HUD/overlays to the caller.
 */
import { Player, isHazard } from "./player";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";
import {
  findTargetAtColumn,
  findTargetUnderCrosshair,
  renderAmmoDrops,
  renderExitMarker,
  renderKeys,
  renderSprites,
} from "./sprites";
import { drawCrosshair, drawHud } from "./hud";
import { WEAPONS, pelletOffsets } from "./weapons";
import { DOOR_TILE, type AmmoDrop, type Enemy, type GameMap } from "../map/types";

/** Movement speed in tiles per second. */
const MOVE_SPEED = 3.2;
/** Keyboard rotation speed in radians per second. */
const ROT_SPEED = 2.6;
/** Mouse rotation sensitivity in radians per pixel of movement. */
const MOUSE_SENSITIVITY = 0.0025;
/** Clamp per-frame dt so a background tab / long stall can't teleport the player. */
const MAX_DT = 0.05;
/** Starting / maximum System Stability (health), as a percentage. */
const MAX_HEALTH = 100;
/** Distance (tiles) within which an enemy is "touching" the player. */
const CONTACT_RADIUS = 0.5;
/** Health lost per second while in contact with an enemy. */
const CONTACT_DPS = 30;
/** Health lost per second while standing in an acid (hazard) tile. */
const HAZARD_DPS = 18;
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
  enemiesRemaining: number;
  totalEnemies: number;
  /** Name of the enemy under the crosshair, or null. */
  target: string | null;
  /** Name of the currently equipped weapon. */
  weapon: string;
  /** Dependency keys currently held (unused, in inventory). */
  keysHeld: number;
  /** Total keys placed on this level. */
  keysTotal: number;
}

/** Host callbacks. All optional. */
export interface EngineHandlers {
  onStats?: (stats: EngineStats) => void;
  onGameOver?: () => void;
  onWin?: () => void;
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

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: GameMap,
    private readonly handlers: EngineHandlers = {},
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.input = new InputController(canvas);
    this.enemies = map.enemies;
    this.zBuffer = new Float64Array(canvas.width);
    this.ammo = startingAmmo(map.enemies);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach();
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
    // Weapon switching (1/2/…) can happen even while lining up a shot.
    const requested = this.input.consumeWeaponRequest();
    if (requested !== null && requested < WEAPONS.length) this.weaponIndex = requested;

    // Simulate (may end the game via damage or reaching the exit).
    this.handleMovement(dt);
    this.collectKeys();
    this.collectAmmoDrops();
    this.openDoorAhead();
    this.applyContactDamage(dt);
    this.applyHazardDamage(dt);
    this.checkExit();

    // Render — one final frozen frame is still drawn after the game ends.
    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, this.player, this.zBuffer);
    renderSprites(this.ctx, this.player, this.enemies, this.zBuffer);
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

    drawCrosshair(this.ctx, this.target !== null, WEAPONS[this.weaponIndex].spreadPx);
    renderMinimap(this.ctx, this.map, this.player);

    // Native HUD sits on top of the whole scene.
    const stats = this.buildStats();
    drawHud(this.ctx, stats);
    this.handlers.onStats?.(stats);
  }

  private handleMovement(dt: number): void {
    const step = MOVE_SPEED * dt;
    if (this.input.isDown("KeyW")) this.player.moveForward(step, this.map);
    if (this.input.isDown("KeyS")) this.player.moveForward(-step, this.map);

    const rot = ROT_SPEED * dt;
    if (this.input.isDown("KeyA")) this.player.rotate(-rot);
    if (this.input.isDown("KeyD")) this.player.rotate(rot);

    const mouseDX = this.input.consumeMouseDX();
    if (mouseDX !== 0) this.player.rotate(mouseDX * MOUSE_SENSITIVITY);
  }

  /** Drain stability while any live enemy overlaps the player. */
  private applyContactDamage(dt: number): void {
    if (this.state !== "playing") return;
    const r2 = CONTACT_RADIUS * CONTACT_RADIUS;
    let touching = false;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.x - this.player.posX;
      const dy = enemy.y - this.player.posY;
      if (dx * dx + dy * dy < r2) {
        touching = true;
        break;
      }
    }
    if (!touching) return;

    this.damage(CONTACT_DPS * dt);
  }

  /** Drain stability while the player stands in an acid (hazard) tile. */
  private applyHazardDamage(dt: number): void {
    if (this.state !== "playing") return;
    const cx = Math.floor(this.player.posX);
    const cy = Math.floor(this.player.posY);
    if (isHazard(this.map, cx, cy)) this.damage(HAZARD_DPS * dt);
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

  /** Apply `amount` of stability loss; ends the run on reaching 0. */
  private damage(amount: number): void {
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
   * sprays several pellets that each independently hit whatever enemy is under
   * their (offset) screen column.
   */
  private fire(): void {
    const weapon = WEAPONS[this.weaponIndex];
    if (this.ammo < weapon.ammoPerShot) {
      console.log(`[${weapon.name}] out of heap — need ${weapon.ammoPerShot} ammo`);
      return;
    }
    this.ammo -= weapon.ammoPerShot;

    const { width, height } = this.ctx.canvas;
    const center = width / 2;
    let pelletsHit = 0;

    for (const offset of pelletOffsets(weapon)) {
      const enemy = findTargetAtColumn(
        this.player,
        this.enemies,
        this.zBuffer,
        width,
        height,
        center + offset,
      );
      if (enemy?.alive) {
        this.damageEnemy(enemy, weapon.damagePerPellet);
        pelletsHit += 1;
      }
    }

    if (pelletsHit === 0) console.log(`[${weapon.name}] missed`);
  }

  /** Apply weapon damage to one enemy, retiring it (with a log) at 0 HP. */
  private damageEnemy(enemy: Enemy, amount: number): void {
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
    else this.handlers.onWin?.();
  }

  private reportStats(): void {
    this.handlers.onStats?.(this.buildStats());
  }

  /** Snapshot the live stats consumed by both the native HUD and the host. */
  private buildStats(): EngineStats {
    const enemiesRemaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    return {
      health: Math.ceil(this.health),
      maxHealth: MAX_HEALTH,
      ammo: this.ammo,
      enemiesRemaining,
      totalEnemies: this.enemies.length,
      target: this.target?.entity.name ?? null,
      weapon: WEAPONS[this.weaponIndex].name,
      keysHeld: this.keysHeld,
      keysTotal: this.map.keys.length,
    };
  }
}

/**
 * Give the player enough heap to clear the level with the pistol, plus a
 * margin: one shot per pistol-damage of total enemy HP, ×1.4, floored at 20.
 * (The shotgun trades heap efficiency for burst damage.)
 */
function startingAmmo(enemies: Enemy[]): number {
  const pistolDamage = WEAPONS[0].damagePerPellet;
  const shotsToClear = enemies.reduce(
    (n, e) => n + Math.ceil(e.maxHp / pistolDamage),
    0,
  );
  return Math.max(20, Math.round(shotsToClear * 1.4) + 8);
}
