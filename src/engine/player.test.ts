// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { Player, collidesWithWall, isWall, isHazard } from "./player";
import { DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, type GameMap, type Tile } from "../map/types";

function createMockMap(gridData: number[][], spawnX = 1, spawnY = 1): GameMap {
  const width = gridData[0].length;
  const height = gridData.length;
  return {
    width,
    height,
    grid: gridData as Tile[][],
    spawn: { x: spawnX, y: spawnY },
  } as unknown as GameMap;
}

describe("Player", () => {
  let map: GameMap;

  beforeEach(() => {
    // 5x5 map. Spawn at (2, 2).
    map = createMockMap([
      [1, 1, 1, 1, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 1, 1, 1, 1]
    ], 2, 2);
  });

  it("initializes correctly with default config", () => {
    const player = new Player(map);
    expect(player.posX).toBe(2.5);
    expect(player.posY).toBe(2.5);
    expect(player.dirX).toBe(1);
    expect(player.dirY).toBe(0);
    expect(player.planeX).toBe(0);
    expect(player.planeY).toBe(0.66);
    expect(player.radius).toBe(0.2);
    expect(player.noClip).toBe(false);
  });

  it("accepts custom config overrides", () => {
    const player = new Player(map, { radius: 0.4 });
    expect(player.radius).toBe(0.4);
  });

  it("rotates facing and camera plane", () => {
    const player = new Player(map);
    // rotate 90 degrees right (PI / 2)
    player.rotate(Math.PI / 2);
    expect(player.dirX).toBeCloseTo(0);
    expect(player.dirY).toBeCloseTo(1);
    expect(player.planeX).toBeCloseTo(-0.66);
    expect(player.planeY).toBeCloseTo(0);
  });

  it("moves forward without collision", () => {
    const player = new Player(map);
    player.moveForward(0.5, map); // dx=0.5, dy=0
    expect(player.posX).toBe(3);
    expect(player.posY).toBe(2.5);
  });

  it("strafes sideways without collision", () => {
    const player = new Player(map);
    
    // Right strafe (positive dist)
    player.strafe(0.5, map);
    expect(player.posX).toBe(2.5);
    expect(player.posY).toBe(3.0);

    // Left strafe (negative dist)
    player.strafe(-1, map);
    expect(player.posX).toBe(2.5);
    expect(player.posY).toBe(2.0);
  });

  it("slides along walls when blocked on X but not Y", () => {
    const player = new Player(map);
    player.dirX = 2; // Force large dx towards right wall
    player.dirY = 0.5; // Force small dy down
    player.moveForward(1, map);
    expect(player.posX).toBe(2.5); // x movement blocked
    expect(player.posY).toBe(3.0); // y movement allowed
  });

  it("slides along walls when blocked on Y but not X", () => {
    const player = new Player(map);
    player.dirX = 0.5; // Force small dx right
    player.dirY = 2; // Force large dy towards bottom wall
    player.moveForward(1, map);
    expect(player.posX).toBe(3.0); // x movement allowed
    expect(player.posY).toBe(2.5); // y movement blocked
  });

  it("is fully blocked when colliding on both axes", () => {
    const player = new Player(map);
    player.dirX = 2; // move towards right wall
    player.dirY = 2; // move towards bottom wall
    player.moveForward(1, map);
    expect(player.posX).toBe(2.5);
    expect(player.posY).toBe(2.5);
  });

  it("ignores all collisions when noClip is true", () => {
    const player = new Player(map);
    player.noClip = true;
    player.moveForward(2, map); // through the right wall
    expect(player.posX).toBe(4.5);
    expect(player.posY).toBe(2.5);
  });
});

describe("Map collision functions", () => {
  const map = createMockMap([
    [1, DOOR_TILE, SECRET_WALL_TILE, LORE_TILE],
    [0, HAZARD_TILE, 0, 0]
  ]);

  describe("isWall", () => {
    it("identifies out of bounds as solid", () => {
      expect(isWall(map, -1, 0)).toBe(true);
      expect(isWall(map, 0, -1)).toBe(true);
      expect(isWall(map, 4, 0)).toBe(true);
      expect(isWall(map, 0, 2)).toBe(true);
    });

    it("identifies specific solid tiles", () => {
      expect(isWall(map, 0, 0)).toBe(true); // 1
      expect(isWall(map, 1, 0)).toBe(true); // DOOR_TILE
      expect(isWall(map, 2, 0)).toBe(true); // SECRET_WALL_TILE
      expect(isWall(map, 3, 0)).toBe(true); // LORE_TILE
    });

    it("identifies non-solid tiles", () => {
      expect(isWall(map, 0, 1)).toBe(false); // 0
      expect(isWall(map, 1, 1)).toBe(false); // HAZARD_TILE
    });
  });

  describe("isHazard", () => {
    it("identifies out of bounds as not hazard", () => {
      expect(isHazard(map, -1, 0)).toBe(false);
      expect(isHazard(map, 0, -1)).toBe(false);
      expect(isHazard(map, 4, 0)).toBe(false);
      expect(isHazard(map, 0, 2)).toBe(false);
    });

    it("identifies hazard tiles", () => {
      expect(isHazard(map, 1, 1)).toBe(true); // HAZARD_TILE
    });

    it("identifies non-hazard tiles", () => {
      expect(isHazard(map, 0, 1)).toBe(false); // 0
      expect(isHazard(map, 0, 0)).toBe(false); // 1
    });
  });

  describe("collidesWithWall", () => {
    const collisionMap = createMockMap([
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 1]
    ]);

    it("returns false when fully in open space", () => {
      expect(collidesWithWall(collisionMap, 1.5, 1.5, 0.2)).toBe(false);
    });

    it("returns true when overlapping wall edge horizontally", () => {
      // 1.1 - 0.2 = 0.9 -> cell (0, 1) which is a wall
      expect(collidesWithWall(collisionMap, 1.1, 1.5, 0.2)).toBe(true);
      // 1.9 + 0.2 = 2.1 -> cell (2, 1) which is a wall
      expect(collidesWithWall(collisionMap, 1.9, 1.5, 0.2)).toBe(true);
    });

    it("returns true when overlapping wall edge vertically", () => {
      // 1.1 - 0.2 = 0.9 -> cell (1, 0) which is a wall
      expect(collidesWithWall(collisionMap, 1.5, 1.1, 0.2)).toBe(true);
      // 1.9 + 0.2 = 2.1 -> cell (1, 2) which is a wall
      expect(collidesWithWall(collisionMap, 1.5, 1.9, 0.2)).toBe(true);
    });

    it("returns true when overlapping wall corner", () => {
      expect(collidesWithWall(collisionMap, 1.1, 1.1, 0.2)).toBe(true);
    });
  });
});
