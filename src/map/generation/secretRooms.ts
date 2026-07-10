// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Hidden secret rooms carved behind fake walls from code-smell triggers. */
import type { SecretTrigger } from "../../parser/types";
import { SECRET_WALL_TILE, type AmmoPickup, type Point, type Room, type Tile } from "../types";
import { roomForLine } from "./geometry";
import { shuffle } from "./util";

/** Interior footprint (both dimensions) of a carved secret room. */
const SECRET_ROOM_SIZE = 3;
/** Secret-room triggers are capped the same way lore terminals are — a huge
 * legacy file can have dozens of qualifying spots, but not every one needs
 * its own hidden room. */
const MAX_SECRET_ROOMS = 5;
/** A secret room's guaranteed pickup — "mega-health", a fat rockets stash, or
 * a chunky armor top-up — noticeably above the normal
 * `AMMO_PICKUP_*`/`HEALTH_DROP_AMOUNT`/`SWAP_DROP_AMOUNT` scale, since finding
 * one is meant to feel like a real reward for exploring. */
const SECRET_LOOT_HEALTH_AMOUNT = 60;
const SECRET_LOOT_ROCKETS_AMOUNT = 4;
const SECRET_LOOT_SWAP_AMOUNT = 40;

/** One candidate outcome for a secret room's guaranteed pickup — see the
 * `candidates` list built in `placeSecretRooms`. */
interface SecretLootCandidate {
  kind: AmmoPickup["kind"];
  amount: number;
  weaponIndex?: number;
}

/**
 * Carve a hidden room for a capped, fairly-sampled, one-per-room subset of
 * `secretTriggers` (dead code, empty catch blocks, deprecation markers,
 * commented-out code, magic-number/blob literals), off a random side of
 * whichever room contains its source line, behind a `SECRET_WALL_TILE` that
 * renders and blocks exactly like a normal wall (see `Tile`'s doc comment) —
 * the only way to find one is to interact with the right stretch of wall.
 * Never a hard failure: a trigger whose anchor room has no free, clear patch
 * of solid rock beside it on any of its four sides simply doesn't get one.
 *
 * `missingWeaponIndices` is an opaque list of `WEAPONS` indices the current
 * player doesn't own yet (computed by `main.ts` from `ownedWeapons`, same
 * pattern as `hasRocketLauncher`) — the map layer never imports engine-layer
 * weapon concepts (see `doc/dev/architecture.md`), it just carries the
 * numbers through to `AmmoPickup.weaponIndex` for the engine to interpret
 * once collected.
 */
export function placeSecretRooms(
  rooms: Room[],
  grid: Tile[][],
  mapSize: number,
  secretTriggers: SecretTrigger[],
  rng: () => number,
  hasRocketLauncher: boolean,
  missingWeaponIndices: readonly number[],
): { secretLoot: AmmoPickup[] } {
  const secretLoot: AmmoPickup[] = [];

  // With five source patterns concatenated in a fixed order, a file with many
  // dead-code regions (added first) could otherwise starve out every other
  // trigger kind from ever getting one of the capped slots below — shuffle a
  // copy first so the cap samples fairly across all kinds. Still fully
  // deterministic, since `rng` is the map's own seeded PRNG.
  const shuffled = [...secretTriggers];
  shuffle(shuffled, rng);

  // A single function/entity can trip several different trigger kinds at
  // once (e.g. dead code AND a magic number in the same method) and they'd
  // all resolve to the same anchor room via `roomForLine` — `usedAnchors`
  // caps it at one secret room per room, so the whole level's worth of
  // triggers is walked (not just the first `MAX_SECRET_ROOMS` in shuffled
  // order) until either the room cap is filled or triggers run out.
  const usedAnchors = new Set<Room>();
  for (const trigger of shuffled) {
    if (secretLoot.length >= MAX_SECRET_ROOMS) break;
    const anchor = roomForLine(rooms, trigger.startLine) ?? rooms[0];
    if (!anchor || usedAnchors.has(anchor)) continue;
    const secret = trySecretRoomOffAnchor(anchor, grid, mapSize, rng);
    if (!secret) continue;
    usedAnchors.add(anchor);

    // Picked uniformly among whatever's actually available this run — a
    // still-unowned weapon only competes once one exists, rockets only once
    // the launcher is owned, so "always health" (the reported complaint)
    // can't happen: swap is always in the running as a real alternative.
    const candidates: SecretLootCandidate[] = [{ kind: "health", amount: SECRET_LOOT_HEALTH_AMOUNT }, { kind: "swap", amount: SECRET_LOOT_SWAP_AMOUNT }];
    if (hasRocketLauncher) candidates.push({ kind: "rockets", amount: SECRET_LOOT_ROCKETS_AMOUNT });
    if (missingWeaponIndices.length > 0) {
      const weaponIndex = missingWeaponIndices[Math.floor(rng() * missingWeaponIndices.length)];
      candidates.push({ kind: "weapon", amount: 0, weaponIndex });
    }
    const choice = candidates[Math.floor(rng() * candidates.length)];

    secretLoot.push({
      x: secret.center.x + 0.5,
      y: secret.center.y + 0.5,
      kind: choice.kind,
      amount: choice.amount,
      weaponIndex: choice.weaponIndex,
      collected: false,
    });
  }
  return { secretLoot };
}

/**
 * Try each of `anchor`'s four sides (in random order) for a still-untouched
 * wall tile behind which a `SECRET_ROOM_SIZE`² patch of unclaimed solid rock
 * exists, fully inside the map border. Carves that patch to floor and turns
 * the connecting tile into `SECRET_WALL_TILE` on the first fit found.
 */
function trySecretRoomOffAnchor(
  anchor: Room,
  grid: Tile[][],
  mapSize: number,
  rng: () => number,
): { center: Point } | null {
  const size = SECRET_ROOM_SIZE;
  const half = Math.floor(size / 2);
  const candidates: { wall: Point; x0: number; y0: number; x1: number; y1: number }[] = [];

  for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
    const nx0 = x - half;
    candidates.push({
      wall: { x, y: anchor.y - 1 },
      x0: nx0,
      y0: anchor.y - 1 - size,
      x1: nx0 + size - 1,
      y1: anchor.y - 2,
    });
    candidates.push({
      wall: { x, y: anchor.y + anchor.h },
      x0: nx0,
      y0: anchor.y + anchor.h + 1,
      x1: nx0 + size - 1,
      y1: anchor.y + anchor.h + size,
    });
  }
  for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
    const ny0 = y - half;
    candidates.push({
      wall: { x: anchor.x - 1, y },
      x0: anchor.x - 1 - size,
      y0: ny0,
      x1: anchor.x - 2,
      y1: ny0 + size - 1,
    });
    candidates.push({
      wall: { x: anchor.x + anchor.w, y },
      x0: anchor.x + anchor.w + 1,
      y0: ny0,
      x1: anchor.x + anchor.w + size,
      y1: ny0 + size - 1,
    });
  }
  shuffle(candidates, rng);

  for (const c of candidates) {
    if (grid[c.wall.y]?.[c.wall.x] !== 1) continue;
    if (c.x0 < 1 || c.y0 < 1 || c.x1 > mapSize - 2 || c.y1 > mapSize - 2) continue;

    // Checked with a 1-tile margin beyond the room's own footprint, not just
    // the footprint itself: opening this room now flood-fills every
    // 4-connected `SECRET_WALL_TILE` cell reachable from the door (see
    // `tryOpenSecretWall`), so if another secret room's carved footprint
    // ended up directly touching this one, opening either would leak into
    // revealing both. A 1-tile buffer of untouched rock on every side rules
    // that out entirely.
    let clear = true;
    for (let y = c.y0 - 1; y <= c.y1 + 1 && clear; y++) {
      for (let x = c.x0 - 1; x <= c.x1 + 1; x++) {
        if (grid[y]?.[x] !== 1) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;

    // The whole room — interior *and* the one connecting tile — is carved as
    // `SECRET_WALL_TILE`, not floor. Rendering already treats every
    // `SECRET_WALL_TILE` cell as an ordinary wall (3D view, corner minimap,
    // automap), so a room made entirely of it is genuinely indistinguishable
    // from solid rock until opened — a room carved as floor here would show
    // up as a room-shaped hole in the surrounding walls (no fog-of-war on the
    // corner minimap) or leak through the automap's `visited` radius (which
    // has no wall-awareness and reaches past the one doorway tile) well
    // before the player ever interacts with it. Opening flood-fills this
    // whole connected patch to floor at once — see `tryOpenSecretWall`.
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) grid[y][x] = SECRET_WALL_TILE;
    }
    grid[c.wall.y][c.wall.x] = SECRET_WALL_TILE;
    return { center: { x: Math.floor((c.x0 + c.x1) / 2), y: Math.floor((c.y0 + c.y1) / 2) } };
  }
  return null;
}
