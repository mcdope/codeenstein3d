// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import {
  BULLET_TRACE_FRAMES,
  DAMAGE_FLASH_FRAMES,
  drawBulletTraces,
  drawDamageFlash,
  drawFlameStreams,
  GORE_MULTIPLIERS,
  HIT_FLASH_FRAMES,
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
} from "./effects";
import { Player } from "./player";

const WIDTH = 200;
const HEIGHT = 100;

function fakeMap(): GameMap {
  const grid: Tile[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]);
  return {
    width: 10,
    height: 10,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn: { x: 5, y: 5 },
    enemies: [],
    exit: { x: 0, y: 0 },
    shortestPathTiles: 0,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
  };
}

/** A real Player facing +X (default), so a particle 3 tiles ahead along X
 * projects to dead center of the screen at a clean, positive depth. */
function facingPlayer(): Player {
  return new Player(fakeMap());
}

function ctx(): MockCanvasContext {
  return createMockCanvasContext({ width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

function clearZBuffer(value: number): Float64Array {
  return new Float64Array(WIDTH).fill(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("drawDamageFlash", () => {
  it("does nothing when intensity is 0 or negative", () => {
    const c = ctx();
    drawDamageFlash(asCtx(c), 0);
    drawDamageFlash(asCtx(c), -1);
    expect(c.fillRect).not.toHaveBeenCalled();
  });

  it("fills the whole canvas with red scaled by intensity", () => {
    const c = ctx();
    drawDamageFlash(asCtx(c), 1);
    expect(c.fillStyle).toBe("rgba(255,0,0,0.400)");
    expect(c.fillRect).toHaveBeenCalledWith(0, 0, WIDTH, HEIGHT);
  });
});

describe("makeBulletTrace / drawBulletTraces", () => {
  it("anchors the trace at bottom-center of the screen, aimed at the impact point", () => {
    const trace = makeBulletTrace(WIDTH, HEIGHT, 50, 20, "#ff0000");
    expect(trace).toEqual({ x1: WIDTH / 2, y1: HEIGHT, x2: 50, y2: 20, frames: BULLET_TRACE_FRAMES, color: "#ff0000" });
  });

  it("draws a full-life trace at full alpha, in its own color", () => {
    const c = ctx();
    const trace = makeBulletTrace(WIDTH, HEIGHT, 50, 20, "#ff0000");
    drawBulletTraces(asCtx(c), [trace]);
    expect(c.strokeStyle).toBe("rgba(255,0,0,0.900)");
    expect(c.moveTo).toHaveBeenCalledWith(trace.x1, trace.y1);
    expect(c.lineTo).toHaveBeenCalledWith(trace.x2, trace.y2);
    expect(c.stroke).toHaveBeenCalledTimes(1);
    expect(c.lineWidth).toBe(1); // reset after drawing
  });

  it("fades a near-expired trace toward transparent", () => {
    const c = ctx();
    const trace: BulletTrace = { x1: 0, y1: 0, x2: 1, y2: 1, frames: 1, color: "#00ff00" };
    drawBulletTraces(asCtx(c), [trace]);
    expect(c.strokeStyle).toBe(`rgba(0,255,0,${(0.9 * (1 / BULLET_TRACE_FRAMES)).toFixed(3)})`);
  });
});

describe("spawnFlameStream / tickFlameStreams / drawFlameStreams", () => {
  it("spawns a stream centered vertically at half height", () => {
    const stream = spawnFlameStream(HEIGHT, 10, 90, "#ffaa00");
    expect(stream.y2).toBe(HEIGHT / 2);
    expect(stream.leftX).toBe(10);
    expect(stream.rightX).toBe(90);
  });

  it("ages streams and drops expired ones", () => {
    const list: FlameStream[] = [
      { leftX: 0, rightX: 10, y2: 5, frames: 1, color: "#fff" },
      { leftX: 0, rightX: 10, y2: 5, frames: 3, color: "#fff" },
    ];
    tickFlameStreams(list);
    expect(list).toHaveLength(1);
    expect(list[0].frames).toBe(2);
  });

  it("draws two layered jets (outer flame + inner core) per stream", () => {
    const c = ctx();
    const stream = spawnFlameStream(HEIGHT, 10, 90, "#ffaa00");
    drawFlameStreams(asCtx(c), WIDTH, HEIGHT, [stream]);
    expect(c.beginPath).toHaveBeenCalledTimes(2);
    expect(c.closePath).toHaveBeenCalledTimes(2);
    expect(c.fill).toHaveBeenCalledTimes(2);
    expect(c.moveTo).toHaveBeenCalledTimes(2);
    // 10 steps forward + 11 steps backward (inclusive of 0) per jet call.
    expect(c.lineTo).toHaveBeenCalledTimes((10 + 11) * 2);
  });
});

describe("spawnExplosion / updateExplosions", () => {
  it("spawns with life equal to maxLife", () => {
    const list: Explosion[] = [];
    spawnExplosion(list, 3, 4, 2.4);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ x: 3, y: 4, radius: 2.4 });
    expect(list[0].life).toBe(list[0].maxLife);
  });

  it("ages explosions and removes ones that finished", () => {
    const list: Explosion[] = [{ x: 0, y: 0, radius: 1, life: 0.1, maxLife: 0.35 }];
    updateExplosions(list, 0.05);
    expect(list).toHaveLength(1);
    expect(list[0].life).toBeCloseTo(0.05);
    updateExplosions(list, 0.05);
    expect(list).toHaveLength(0);
  });
});

describe("renderExplosions", () => {
  it("skips an explosion at the player's own position (depth too shallow)", () => {
    const c = ctx();
    const player = facingPlayer();
    const list: Explosion[] = [{ x: player.posX, y: player.posY, radius: 1, life: 0.2, maxLife: 0.35 }];
    renderExplosions(asCtx(c), player, list, clearZBuffer(Infinity));
    expect(c.arc).not.toHaveBeenCalled();
  });

  it("skips an explosion occluded by a nearer wall", () => {
    const c = ctx();
    const player = facingPlayer();
    const list: Explosion[] = [{ x: player.posX + 3, y: player.posY, radius: 1, life: 0.2, maxLife: 0.35 }];
    renderExplosions(asCtx(c), player, list, clearZBuffer(0.5)); // wall closer than depth=3
    expect(c.arc).not.toHaveBeenCalled();
  });

  it("renders a visible, unoccluded explosion as two nested rings", () => {
    const c = ctx();
    const player = facingPlayer();
    const list: Explosion[] = [{ x: player.posX + 3, y: player.posY, radius: 1, life: 0.2, maxLife: 0.35 }];
    renderExplosions(asCtx(c), player, list, clearZBuffer(Infinity));
    expect(c.arc).toHaveBeenCalledTimes(2);
    expect(c.fill).toHaveBeenCalledTimes(2);
  });
});

describe("spawnExplosionParticles", () => {
  it("spawns the documented particle count, each with life equal to maxLife", () => {
    const list: ExplosionParticle[] = [];
    spawnExplosionParticles(list, 1, 2);
    expect(list).toHaveLength(16);
    for (const p of list) {
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
      expect(p.life).toBe(p.maxLife);
      expect(p.z).toBeGreaterThanOrEqual(0.25);
      expect(p.z).toBeLessThanOrEqual(0.55);
      expect(p.vz).toBeGreaterThanOrEqual(1.4);
    }
  });
});

describe("updateExplosionParticles", () => {
  function particle(overrides: Partial<ExplosionParticle> = {}): ExplosionParticle {
    return { x: 0, y: 0, z: 1, vx: 0, vy: 0, vz: 0, life: 1, maxLife: 1, ...overrides };
  }

  it("integrates gravity and position, keeping a particle with life and height remaining", () => {
    const list = [particle({ z: 1, life: 1 })];
    updateExplosionParticles(list, 0.1);
    expect(list).toHaveLength(1);
    expect(list[0].vz).toBeLessThan(0); // gravity pulled it down
  });

  it("removes a particle whose life expired, even mid-air", () => {
    const list = [particle({ z: 5, life: 0.05 })];
    updateExplosionParticles(list, 0.1);
    expect(list).toHaveLength(0);
  });

  it("removes a particle that fell through the floor before its life expired", () => {
    const list = [particle({ z: 0.01, vz: -10, life: 10 })];
    updateExplosionParticles(list, 0.1);
    expect(list).toHaveLength(0);
  });
});

describe("renderExplosionParticles", () => {
  function particle(overrides: Partial<ExplosionParticle> = {}): ExplosionParticle {
    return { x: 0, y: 0, z: 0.3, vx: 0, vy: 0, vz: 0, life: 1, maxLife: 1, ...overrides };
  }

  it("skips a particle too close to the player, and one occluded by a wall", () => {
    const player = facingPlayer();
    const c1 = ctx();
    renderExplosionParticles(asCtx(c1), player, [particle({ x: player.posX, y: player.posY })], clearZBuffer(Infinity));
    expect(c1.fillRect).not.toHaveBeenCalled();

    const c2 = ctx();
    renderExplosionParticles(asCtx(c2), player, [particle({ x: player.posX + 3, y: player.posY })], clearZBuffer(0.5));
    expect(c2.fillRect).not.toHaveBeenCalled();
  });

  it("renders a hot, fresh particle in white-yellow", () => {
    const c = ctx();
    const player = facingPlayer();
    renderExplosionParticles(asCtx(c), player, [particle({ x: player.posX + 3, y: player.posY, life: 1, maxLife: 1 })], clearZBuffer(Infinity));
    expect(c.fillStyle).toBe("rgba(255,235,190,1.000)");
  });

  it("renders a mid-life particle in orange", () => {
    const c = ctx();
    const player = facingPlayer();
    renderExplosionParticles(asCtx(c), player, [particle({ x: player.posX + 3, y: player.posY, life: 0.4, maxLife: 1 })], clearZBuffer(Infinity));
    expect(c.fillStyle).toBe("rgba(255,110,35,0.400)");
  });

  it("renders a dying particle as a smoky ember", () => {
    const c = ctx();
    const player = facingPlayer();
    renderExplosionParticles(asCtx(c), player, [particle({ x: player.posX + 3, y: player.posY, life: 0.1, maxLife: 1 })], clearZBuffer(Infinity));
    expect(c.fillStyle).toBe("rgba(90,75,65,0.100)");
  });
});

describe("spawnBurnParticles / updateBurnParticles", () => {
  it("spawns the documented ember count with a zero life placeholder", () => {
    const list: BurnParticle[] = [];
    spawnBurnParticles(list, 5, 6);
    expect(list).toHaveLength(4);
    for (const p of list) {
      expect(p.settled).toBe(false);
      expect(p.life).toBe(0);
    }
  });

  it("keeps an airborne ember falling without aging its placeholder life", () => {
    const list: BurnParticle[] = [{ x: 0, y: 0, z: 5, vx: 0, vy: 0, vz: 0, life: 0, settled: false }];
    updateBurnParticles(list, 0.1);
    expect(list).toHaveLength(1);
    expect(list[0].settled).toBe(false);
    expect(list[0].life).toBe(0); // still the placeholder
    expect(list[0].vz).toBeLessThan(0);
  });

  it("settles an ember the instant it reaches the floor, resetting its life", () => {
    const list: BurnParticle[] = [{ x: 0, y: 0, z: 0.05, vx: 1, vy: 1, vz: -10, life: 0, settled: false }];
    updateBurnParticles(list, 0.1);
    expect(list[0].settled).toBe(true);
    expect(list[0].z).toBe(0);
    expect(list[0].vx).toBe(0);
    expect(list[0].life).toBeGreaterThan(0);
  });

  it("counts down a settled ember and removes it once its glow expires", () => {
    const list: BurnParticle[] = [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0.05, settled: true }];
    updateBurnParticles(list, 0.02);
    expect(list).toHaveLength(1);
    updateBurnParticles(list, 0.1);
    expect(list).toHaveLength(0);
  });
});

describe("renderBurnParticles", () => {
  it("skips a too-close or occluded ember", () => {
    const player = facingPlayer();
    const c1 = ctx();
    renderBurnParticles(
      asCtx(c1),
      player,
      [{ x: player.posX, y: player.posY, z: 0.3, vx: 0, vy: 0, vz: 0, life: 1, settled: false }],
      clearZBuffer(Infinity),
    );
    expect(c1.fillRect).not.toHaveBeenCalled();

    const c2 = ctx();
    renderBurnParticles(
      asCtx(c2),
      player,
      [{ x: player.posX + 3, y: player.posY, z: 0.3, vx: 0, vy: 0, vz: 0, life: 1, settled: false }],
      clearZBuffer(0.5),
    );
    expect(c2.fillRect).not.toHaveBeenCalled();
  });

  it("renders an airborne ember as a fixed hot-white spark", () => {
    const c = ctx();
    const player = facingPlayer();
    renderBurnParticles(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, z: 0.3, vx: 0, vy: 0, vz: 0, life: 1, settled: false }],
      clearZBuffer(Infinity),
    );
    expect(c.fillStyle).toBe("rgba(255,225,150,0.95)");
  });

  it("renders a settled ember as a fading orange glow", () => {
    const c = ctx();
    const player = facingPlayer();
    renderBurnParticles(
      asCtx(c),
      player,
      [{ x: player.posX + 3, y: player.posY, z: 0, vx: 0, vy: 0, vz: 0, life: 0.8, settled: true }],
      clearZBuffer(Infinity),
    );
    // t = life / BURN_SETTLED_LIFE = 0.8 / 1.6 = 0.5, not raw life.
    expect(c.fillStyle).toBe(`rgba(255,110,30,${(0.5 * 0.85).toFixed(3)})`);
  });
});

describe("spawnBlood / updateBlood", () => {
  it("spawns the requested count, unsettled", () => {
    const list: BloodParticle[] = [];
    spawnBlood(list, 1, 2, 5);
    expect(list).toHaveLength(5);
    expect(list.every((p) => !p.settled)).toBe(true);
  });

  it("keeps an airborne particle falling and aging its own short spawn life", () => {
    const list: BloodParticle[] = [{ x: 0, y: 0, z: 2, vx: 1, vy: 1, vz: 0, life: 0.5, settled: false }];
    updateBlood(list, 0.1, 1);
    expect(list).toHaveLength(1);
    expect(list[0].settled).toBe(false);
    expect(list[0].life).toBeCloseTo(0.4);
  });

  it("settles a particle on landing, resetting its life to a gore-scaled stain duration", () => {
    const list: BloodParticle[] = [{ x: 0, y: 0, z: 0.02, vx: 2, vy: 2, vz: -5, life: 0.1, settled: false }];
    updateBlood(list, 0.1, GORE_MULTIPLIERS.more.stainDuration);
    expect(list[0].settled).toBe(true);
    expect(list[0].z).toBe(0);
    expect(list[0].vx).toBeCloseTo(0.8); // skidded, not zeroed outright (2 * 0.4)
    expect(list[0].life).toBeCloseTo(1.5 * 3 - 0.1); // BASE_STAIN_LIFE * multiplier, minus this tick's decrement
  });

  it("does not re-reset an already-settled particle's life on later ticks", () => {
    const list: BloodParticle[] = [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, settled: true }];
    updateBlood(list, 0.3, 1);
    expect(list[0].life).toBeCloseTo(0.7);
  });

  it("removes a particle once its life expires", () => {
    const list: BloodParticle[] = [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0.05, settled: true }];
    updateBlood(list, 0.1, 1);
    expect(list).toHaveLength(0);
  });
});

describe("renderBlood", () => {
  it("skips a too-close or occluded particle", () => {
    const player = facingPlayer();
    const c1 = ctx();
    renderBlood(asCtx(c1), player, [{ x: player.posX, y: player.posY, z: 0, vx: 0, vy: 0, vz: 0, life: 1, settled: false }], clearZBuffer(Infinity), 1);
    expect(c1.fillRect).not.toHaveBeenCalled();

    const c2 = ctx();
    renderBlood(asCtx(c2), player, [{ x: player.posX + 3, y: player.posY, z: 0, vx: 0, vy: 0, vz: 0, life: 1, settled: false }], clearZBuffer(0.5), 1);
    expect(c2.fillRect).not.toHaveBeenCalled();
  });

  it("renders a visible particle scaled by sizeMultiplier", () => {
    const c = ctx();
    const player = facingPlayer();
    renderBlood(asCtx(c), player, [{ x: player.posX + 3, y: player.posY, z: 0.2, vx: 0, vy: 0, vz: 0, life: 1, settled: false }], clearZBuffer(Infinity), 3);
    expect(c.fillStyle).toBe("#c81e1e");
    expect(c.fillRect).toHaveBeenCalledTimes(1);
  });
});

describe("tickBulletTraces", () => {
  it("ages traces and drops expired ones", () => {
    const list: BulletTrace[] = [
      { x1: 0, y1: 0, x2: 1, y2: 1, frames: 1, color: "#fff" },
      { x1: 0, y1: 0, x2: 1, y2: 1, frames: 4, color: "#fff" },
    ];
    tickBulletTraces(list);
    expect(list).toHaveLength(1);
    expect(list[0].frames).toBe(3);
  });
});

describe("module constants", () => {
  it("exposes the documented frame counts", () => {
    expect(DAMAGE_FLASH_FRAMES).toBe(12);
    expect(BULLET_TRACE_FRAMES).toBe(4);
    expect(HIT_FLASH_FRAMES).toBe(5);
  });
});
