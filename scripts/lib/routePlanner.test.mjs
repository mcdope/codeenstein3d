// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for `planRoute`'s pickup ordering.
 *
 * The planner collects *every* reachable key before it opens the next gate, so
 * the order it visits them in is pure walking cost — and it used to take them
 * in `map.keys` array order, which is `placeKeys`' push order (gate-opening
 * order) and says nothing about where the player is standing. On
 * `demo-campaign/stage03_legacy_api.php` that walked 94 tiles west to one key,
 * 85 back east to a key 7 tiles from spawn, then 114 west again to the first
 * gate. The file's own doc comment had claimed "nearest reachable uncollected
 * key" since it was written; only the ordering here ever made that true.
 *
 * The door order deliberately stays array-order — see `findReachableDoor`,
 * where tile-order scanning deadlocked `stage13_batch_job.scala` — so the last
 * test pins that difference in place.
 */
import { describe, expect, it } from "vitest";
import { planRoute } from "./routePlanner.mjs";

const FLOOR = 0;
const WALL = 1;
const DOOR = 3;

/**
 * A single east-west corridor of open floor, walled above and below, with
 * `doorsAt` x-positions turned into locked door tiles.
 */
function corridorMap(width, doorsAt = []) {
  const grid = [
    Array.from({ length: width }, () => WALL),
    Array.from({ length: width }, (_, x) => (x === 0 || x === width - 1 ? WALL : FLOOR)),
    Array.from({ length: width }, () => WALL),
  ];
  for (const x of doorsAt) grid[1][x] = DOOR;
  return { width, height: 3, grid, doors: doorsAt.map((x) => ({ x, y: 1 })), keys: [] };
}

/** Tile a walk leg finishes on, as a `"x,y"` string. */
function endOf(leg) {
  const last = leg.waypoints[leg.waypoints.length - 1];
  return `${Math.floor(last.x)},${Math.floor(last.y)}`;
}

const keyAt = (x) => ({ x: x + 0.5, y: 1.5, collected: false });

describe("planRoute key ordering", () => {
  it("collects the nearest reachable key first, not the first one in map.keys order", () => {
    const map = corridorMap(15, [11]);
    map.spawn = { x: 2, y: 1 };
    map.exit = { x: 13, y: 1 };
    // Deliberately array-ordered far-key-first: this is the ordering the old
    // `findIndex` walked straight into.
    map.keys = [keyAt(10), keyAt(3)];

    const route = planRoute(map);
    expect(route.ok).toBe(true);

    const walks = route.legs.filter((l) => l.kind === "walk");
    expect(endOf(walks[0])).toBe("3,1"); // one tile away, not eight
    expect(endOf(walks[1])).toBe("10,1");
  });

  it("still collects every reachable key before opening the gate", () => {
    const map = corridorMap(15, [11]);
    map.spawn = { x: 2, y: 1 };
    map.exit = { x: 13, y: 1 };
    map.keys = [keyAt(10), keyAt(3)];

    const route = planRoute(map);
    const kinds = route.legs.map((l) => l.kind);
    // Reordering pickups must not change *which* pickups happen, or the gate
    // could be reached without the key the generator guaranteed was fetchable.
    expect(kinds.filter((k) => k === "walk").length).toBe(4);
    expect(kinds.filter((k) => k === "openDoor").length).toBe(1);
    expect(kinds.indexOf("openDoor")).toBe(3);
  });

  it("breaks equal-distance ties by map.keys index, so planning stays deterministic", () => {
    const map = corridorMap(15, [11]);
    map.spawn = { x: 6, y: 1 };
    map.exit = { x: 13, y: 1 };
    // Symmetric about the spawn: both are three tiles away.
    map.keys = [keyAt(9), keyAt(3)];

    const first = planRoute(map);
    expect(endOf(first.legs.filter((l) => l.kind === "walk")[0])).toBe("9,1");
    // Same input, same plan — the tiebreak is the only thing standing between
    // this and a route that varies run to run.
    const second = planRoute(map);
    expect(JSON.stringify(second.legs)).toBe(JSON.stringify(first.legs));
  });

  it("leaves gate order alone — doors stay in map.doors order, not nearest-first", () => {
    const map = corridorMap(19, [5, 13]);
    map.spawn = { x: 9, y: 1 };
    map.exit = { x: 17, y: 1 };
    map.keys = [keyAt(8), keyAt(10)];
    // The exit is east, and door x=13 is the nearer one from spawn, but
    // `map.doors` lists x=5 first. Key ordering is a walking-cost choice; door
    // ordering is the generator's solvability guarantee and must not follow it.
    const route = planRoute(map);
    expect(route.ok).toBe(true);
    const opened = route.legs.filter((l) => l.kind === "openDoor").map((l) => l.doorTile.x);
    expect(opened).toEqual([5, 13]);
  });
});
