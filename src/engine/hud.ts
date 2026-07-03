/**
 * Heads-up display: crosshair and combat status text drawn over the 3D view.
 */
import type { Enemy } from "../map/types";

/** Center crosshair; turns red when an enemy is targeted. */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  hasTarget: boolean,
): void {
  const cx = Math.floor(ctx.canvas.width / 2);
  const cy = Math.floor(ctx.canvas.height / 2);
  ctx.fillStyle = hasTarget ? "rgba(255,60,60,0.95)" : "rgba(255,255,255,0.6)";
  ctx.fillRect(cx - 6, cy, 13, 1);
  ctx.fillRect(cx, cy - 6, 1, 13);
}

/** Bottom-left status: enemies remaining and the currently aimed target. */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  enemies: Enemy[],
  target: Enemy | null,
): void {
  const remaining = enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
  const x = 10;
  const y = ctx.canvas.height - 14;

  ctx.font = "12px monospace";
  ctx.textAlign = "start";

  const line1 = `Enemies: ${remaining}/${enemies.length}`;
  const line2 = target
    ? `Target: ${target.entity.name}() — HP ${Math.max(0, target.hp)}/${target.maxHp}`
    : "Target: —";

  shadowText(ctx, line1, x, y - 16);
  shadowText(ctx, line2, x, y, target ? "#ff6a5a" : "#c8c8d0");
}

function shadowText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color = "#c8c8d0",
): void {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
