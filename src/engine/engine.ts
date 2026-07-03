/**
 * RaycasterEngine: owns the render loop, player, and input for one level.
 *
 * All motion is scaled by delta time so movement speed is identical whether the
 * display runs at 60, 120, or 30 fps. Call `start()` to begin and `stop()` to
 * tear everything down (used when switching to a different file/level).
 */
import type { GameMap } from "../map/types";
import { Player } from "./player";
import { InputController } from "./input";
import { renderMinimap, renderScene } from "./raycaster";

/** Movement speed in tiles per second. */
const MOVE_SPEED = 3.2;
/** Keyboard rotation speed in radians per second. */
const ROT_SPEED = 2.6;
/** Mouse rotation sensitivity in radians per pixel of movement. */
const MOUSE_SENSITIVITY = 0.0025;
/** Clamp per-frame dt so a background tab / long stall can't teleport the player. */
const MAX_DT = 0.05;

export class RaycasterEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly player: Player;
  private readonly input: InputController;

  private running = false;
  private rafId = 0;
  private lastTime = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: GameMap,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.player = new Player(map);
    this.input = new InputController(canvas);
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
    renderScene(this.ctx, this.map, this.player);
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
}
