/**
 * RaycasterEngine: owns the render loop, player, and input for one level.
 *
 * All motion is scaled by delta time so movement speed is identical whether the
 * display runs at 60, 120, or 30 fps. Call `start()` to begin and `stop()` to
 * tear everything down (used when switching to a different file/level).
 */
import type { Enemy, GameMap } from "../map/types";
import { Player } from "./player";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";
import { findTargetUnderCrosshair, renderSprites } from "./sprites";
import { drawCrosshair, drawHud } from "./hud";

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

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: GameMap,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.input = new InputController(canvas);
    this.enemies = map.enemies;
    this.zBuffer = new Float64Array(canvas.width);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach();
    this.lastTime = performance.now();
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

    this.update(dt);

    const { width, height } = this.ctx.canvas;
    renderScene(this.ctx, this.map, this.player, this.zBuffer);
    renderSprites(this.ctx, this.player, this.enemies, this.zBuffer);

    // Recompute the aimed target against this frame's fresh z-buffer.
    this.target = findTargetUnderCrosshair(
      this.player,
      this.enemies,
      this.zBuffer,
      width,
      height,
    );

    if (this.input.consumeFire()) this.fire();

    drawCrosshair(this.ctx, this.target !== null);
    drawHud(this.ctx, this.enemies, this.target);
    renderMinimap(this.ctx, this.map, this.player);

    this.rafId = requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    const step = MOVE_SPEED * dt;
    if (this.input.isDown("KeyW")) this.player.moveForward(step, this.map);
    if (this.input.isDown("KeyS")) this.player.moveForward(-step, this.map);

    const rot = ROT_SPEED * dt;
    if (this.input.isDown("KeyA")) this.player.rotate(-rot);
    if (this.input.isDown("KeyD")) this.player.rotate(rot);

    const mouseDX = this.input.consumeMouseDX();
    if (mouseDX !== 0) this.player.rotate(mouseDX * MOUSE_SENSITIVITY);
  }

  /** Hitscan the "echo" pistol: damage the enemy under the crosshair. */
  private fire(): void {
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
      console.log(
        `[hit] ${target.entity.name}() — HP ${target.hp}/${target.maxHp}`,
      );
    }
  }
}
