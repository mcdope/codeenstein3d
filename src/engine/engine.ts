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
import type { Enemy, GameMap } from "../map/types";
import { Player } from "./player";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";
import { findTargetUnderCrosshair, renderExitMarker, renderSprites } from "./sprites";
import { drawCrosshair } from "./hud";

/** Movement speed in tiles per second. */
const MOVE_SPEED = 3.2;
/** Keyboard rotation speed in radians per second. */
const ROT_SPEED = 2.6;
/** Mouse rotation sensitivity in radians per pixel of movement. */
const MOUSE_SENSITIVITY = 0.0025;
/** Clamp per-frame dt so a background tab / long stall can't teleport the player. */
const MAX_DT = 0.05;
/** Damage dealt per hitscan shot from the "echo" pistol. */
const WEAPON_DAMAGE = 25;
/** Starting / maximum System Stability (health), as a percentage. */
const MAX_HEALTH = 100;
/** Distance (tiles) within which an enemy is "touching" the player. */
const CONTACT_RADIUS = 0.5;
/** Health lost per second while in contact with an enemy. */
const CONTACT_DPS = 30;

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
    // Simulate (may end the game via contact damage or reaching the exit).
    this.handleMovement(dt);
    this.applyContactDamage(dt);
    this.checkExit();

    // Render — one final frozen frame is still drawn after the game ends.
    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, this.player, this.zBuffer);
    renderSprites(this.ctx, this.player, this.enemies, this.zBuffer);
    renderExitMarker(this.ctx, this.player, this.map.exit, this.zBuffer);

    this.target = findTargetUnderCrosshair(
      this.player,
      this.enemies,
      this.zBuffer,
      width,
      height,
    );

    if (this.state === "playing" && this.input.consumeFire()) this.fire();

    drawCrosshair(this.ctx, this.target !== null);
    renderMinimap(this.ctx, this.map, this.player);

    this.reportStats();
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

    this.health -= CONTACT_DPS * dt;
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

  /** Hitscan the "echo" pistol: spend a round of heap, damage what's aimed. */
  private fire(): void {
    if (this.ammo <= 0) {
      console.log("[echo] out of heap — no ammo");
      return;
    }
    this.ammo -= 1;

    const target = this.target;
    if (!target) return;

    target.hp -= WEAPON_DAMAGE;
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      this.target = null;
      const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
      console.log(
        `%c[KILL] ${target.entity.kind} ${target.entity.name}() eliminated — ${remaining} enemies remaining`,
        "color:#37d24a;font-weight:bold",
      );
    } else {
      console.log(`[hit] ${target.entity.name}() — HP ${target.hp}/${target.maxHp}`);
    }
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
    const enemiesRemaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    this.handlers.onStats?.({
      health: Math.ceil(this.health),
      maxHealth: MAX_HEALTH,
      ammo: this.ammo,
      enemiesRemaining,
      totalEnemies: this.enemies.length,
      target: this.target?.entity.name ?? null,
    });
  }
}

/**
 * Give the player enough heap to clear the level by combat, plus a margin:
 * one shot per WEAPON_DAMAGE of total enemy HP, ×1.4, floored at 20.
 */
function startingAmmo(enemies: Enemy[]): number {
  const shotsToClear = enemies.reduce(
    (n, e) => n + Math.ceil(e.maxHp / WEAPON_DAMAGE),
    0,
  );
  return Math.max(20, Math.round(shotsToClear * 1.4) + 8);
}
