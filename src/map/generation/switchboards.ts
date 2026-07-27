// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Switchboard" junction rooms: branching control flow becomes branching
 * geometry. A function containing a `switch`/`match` turns its own already
 * carved room into a hub, with one small dead-end room spurring off it per
 * `case` branch, each behind a keyless `BRANCH_DOOR_TILE`.
 *
 * The `default` branch deliberately gets no room of its own. It's the branch
 * that falls through to whatever comes next, and the hub is already wired into
 * the level by `connectRooms` — so "the default path continues the level"
 * holds by construction, and the spokes are exactly the branches that dead-end.
 *
 * Split in two like `breakUpLongCorridors`/`spawnEdgeCaseEnemies`: the carving
 * half runs with the other geometry passes, the population half has to wait
 * until `spawn`/`exit` exist.
 */
import type { CodeEntity } from "../../parser/types";
import {
  BRANCH_DOOR_TILE,
  SPIKE_TRAP_TILE,
  type AmmoPickup,
  type Enemy,
  type Mine,
  type Point,
  type Rect,
  type Room,
  type SpikeTrap,
  type Tile,
} from "../types";
import { carveRect, connectorTiles, sideCandidateFits, sideCandidates, type Side } from "./geometry";
import { SPIKE_PERIOD_MAX, SPIKE_PERIOD_MIN, TRAP_SPACING } from "./trapsHazards";
import { dist, key, shuffle } from "./util";

/** Feature flag — see `doc/dev/architecture.md`'s Feature Flags table. Checked
 * at the `mapGenerator.ts` call site, so a disabled feature draws zero rng. */
export const SWITCHBOARDS_ENABLED = true;

/**
 * Hard cap on spokes per hub, however many cases the source has. A `switch`
 * over a 30-value enum must read as a junction, not a starburst — and the map
 * has other things to spend its solid rock on.
 */
const MAX_CASE_ROOMS_PER_HUB = 5;
/** Cap per side too, so the spokes spread over the hub's walls instead of
 * crowding one of them. */
const MAX_CASE_ROOMS_PER_SIDE = 2;
/** Interior footprint (both dimensions) of one case dead-end room. */
const CASE_ROOM_SIZE = 2;
/** Connector length between the hub's branch door and the case room. Two tiles
 * is enough to read as "down a short corridor" rather than "a hole in the
 * wall", which is what separates a spoke from a Vendor Depot alcove. */
const CASE_CORRIDOR_LENGTH = 2;

/** An Edge Case enemy guarding a spoke — same weak "bug in the system" tier the
 * corridor-breakup rooms use, since a spoke is a comparable size of detour. */
const CASE_ENEMY_HP = 12;
/** A spoke's consolation pickup: small, since the reward for a dead end is
 * mostly "you now know it's a dead end". */
const CASE_BULLETS_AMOUNT = 8;

export interface SwitchboardEncounters {
  enemies: Enemy[];
  spikeTraps: SpikeTrap[];
  mines: Mine[];
  pickups: AmmoPickup[];
}

/**
 * Carve one dead-end room per `case` branch off every switch-containing
 * function's own room, each reached through a short corridor and a keyless
 * branch door.
 *
 * Only `function`/`method` rooms are considered — the same gate `spawnEnemies`
 * uses, and the reason a `class` entity's aggregated method switches (see
 * `SwitchBranchSummary`) can't produce a spurious hub. Room index 0 is skipped
 * so the spawn room never becomes a junction.
 *
 * Writing `BRANCH_DOOR_TILE` on the hub-side mouth is also what keeps
 * `placeDoors` out of this: `roomMouths` only considers a mouth whose outward
 * tile is plain floor, so a spoke's doorway is skipped automatically and a
 * private method with a five-case switch doesn't turn into six locked doors
 * and six keys.
 *
 * Never a hard failure — a hub with no free rock beside it just gets fewer
 * (or zero) spokes.
 */
export function placeSwitchboards(
  rooms: Room[],
  grid: Tile[][],
  mapSize: number,
  rng: () => number,
): Rect[] {
  const caseRooms: Rect[] = [];

  rooms.forEach((room, index) => {
    if (index === 0) return; // never turn the spawn room into a junction
    const kind = room.entity.kind;
    if (kind !== "function" && kind !== "method") return;
    const branches = room.entity.switchBranches;
    if (!branches || branches.caseCount <= 0) return;

    const wanted = Math.min(MAX_CASE_ROOMS_PER_HUB, branches.caseCount);
    const perSide = new Map<Side, number>();
    const candidates = sideCandidates(room, CASE_ROOM_SIZE, CASE_ROOM_SIZE, CASE_CORRIDOR_LENGTH);
    shuffle(candidates, rng);

    let carved = 0;
    for (const candidate of candidates) {
      if (carved >= wanted) break;
      if ((perSide.get(candidate.side) ?? 0) >= MAX_CASE_ROOMS_PER_SIDE) continue;
      const corridor = connectorTiles(candidate, CASE_CORRIDOR_LENGTH);
      if (!sideCandidateFits(candidate, grid, mapSize, corridor)) continue;

      caseRooms.push(carveRect(grid, candidate.x0, candidate.y0, candidate.x1, candidate.y1));
      // The mouth becomes the branch door; the rest of the connector is plain
      // corridor floor.
      for (const tile of corridor) grid[tile.y][tile.x] = 0;
      grid[candidate.wall.y][candidate.wall.x] = BRANCH_DOOR_TILE;

      perSide.set(candidate.side, (perSide.get(candidate.side) ?? 0) + 1);
      carved += 1;
    }
  });

  return caseRooms;
}

/**
 * Populate each case dead-end with one minor encounter — an Edge Case enemy, a
 * spike trap or mine, or a small pickup, one roll each at equal odds. Modeled
 * on `placeTodoEncounter`, including its hard spawn-safety rule: a trap or mine
 * is never placed within `TRAP_SPACING` of the player's spawn (see
 * `doc/dev/decisions.md#hazard-placement-spawn-safety`).
 *
 * Separate from `placeSwitchboards` because it needs `spawn` and `exit`, which
 * don't exist until after the geometry is final — exactly why
 * `spawnEdgeCaseEnemies` is separate from `breakUpLongCorridors`.
 */
export function placeSwitchboardEncounters(
  caseRooms: readonly Rect[],
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  rng: () => number,
): SwitchboardEncounters {
  const result: SwitchboardEncounters = { enemies: [], spikeTraps: [], mines: [], pickups: [] };

  for (const room of caseRooms) {
    // A case room is 2x2, so `findPropSpot`'s margin-1 interior is empty —
    // enumerate its handful of tiles directly instead.
    const tiles: Point[] = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) tiles.push({ x, y });
    }
    shuffle(tiles, rng);

    const roll = rng();
    const free = tiles.filter((p) => grid[p.y]?.[p.x] === 0);
    if (free.length === 0) continue;

    // Anything damaging keeps its distance from spawn; a pickup or an enemy
    // the player has to walk up to doesn't need to.
    const safeFromSpawn = free.filter((p) => dist(p.x + 0.5, p.y + 0.5, spawn.x + 0.5, spawn.y + 0.5) >= TRAP_SPACING);
    const notExit = free.filter((p) => key(p) !== key(exit));
    const spot = notExit[0] ?? free[0];

    if (roll < 1 / 3 && safeFromSpawn.length > 0) {
      const p = safeFromSpawn[0];
      if (rng() < 0.5) {
        grid[p.y][p.x] = SPIKE_TRAP_TILE;
        result.spikeTraps.push({
          x: p.x,
          y: p.y,
          period: SPIKE_PERIOD_MIN + rng() * (SPIKE_PERIOD_MAX - SPIKE_PERIOD_MIN),
          phase: rng() * SPIKE_PERIOD_MAX,
        });
      } else {
        // Mines stay on plain floor, invisible until triggered — the same
        // convention `placeTraps` and `placeTodoEncounter` both follow.
        result.mines.push({ x: p.x + 0.5, y: p.y + 0.5, alive: true, visible: false, closeTimer: 0 });
      }
      continue;
    }

    if (roll < 2 / 3) {
      result.enemies.push(caseEnemy(spot, room, rng));
      continue;
    }

    result.pickups.push({ x: spot.x + 0.5, y: spot.y + 0.5, kind: "bullets", amount: CASE_BULLETS_AMOUNT, collected: false });
  }

  return result;
}

/** A spoke's guard. `kind: "class"` on the synthetic entity is deliberate, per
 * the `FILLER_ENTITY`/`EdgeCase`/`Bug` precedent: it fails every "real code"
 * eligibility check elsewhere in `generation/`, so a placeholder name can
 * never leak onto a nameplate as if it were a parsed function. */
function caseEnemy(pos: Point, room: Rect, rng: () => number): Enemy {
  const entity: CodeEntity = {
    name: "Case",
    kind: "class",
    startLine: 0,
    endLine: 0,
    complexityScore: 1,
    nestingDepth: 0,
  };
  return {
    x: pos.x + 0.5,
    y: pos.y + 0.5,
    hp: CASE_ENEMY_HP,
    maxHp: CASE_ENEMY_HP,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: room.x, y: room.y, w: room.w, h: room.h },
    aggroed: false,
    discovered: false,
    roamX: pos.x + 0.5,
    roamY: pos.y + 0.5,
    fireCooldown: rng() * 2,
    entity,
    elite: false,
    edgeCase: true,
  };
}
