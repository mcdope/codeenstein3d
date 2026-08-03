// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Hidden secret rooms carved behind fake walls from code-smell triggers. */
import type { SecretTrigger } from "../../parser/types";
import { SECRET_WALL_TILE, type AmmoPickup, type Point, type Room, type Tile } from "../types";
import { roomForLine, sideCandidateFits, sideCandidates } from "./geometry";
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
 * exists, fully inside the map border. Carves that patch and turns the
 * connecting tile into `SECRET_WALL_TILE` on the first fit found.
 *
 * Uses `sideCandidates`/`sideCandidateFits` — the helpers that were *extracted
 * from this function* for `placeSwitchboards`/`placeExceptionZones`/
 * `placeVendorDepots`, while this one kept its own inline copy. `geometry.ts`
 * called this the reference for what "fits" means, so the rule that four
 * carvers depend on was written down twice, and the copy the doc pointed at
 * was the one nobody shared.
 *
 * The margin `sideCandidateFits` enforces is not incidental here — it is the
 * reason it exists. Opening a secret wall flood-fills every 4-connected
 * `SECRET_WALL_TILE` reachable from the door (see `tryOpenSecretWall`), so two
 * secret rooms whose footprints touched would reveal each other.
 */
function trySecretRoomOffAnchor(
  anchor: Room,
  grid: Tile[][],
  mapSize: number,
  rng: () => number,
): { center: Point } | null {
  const size = SECRET_ROOM_SIZE;
  const candidates = sideCandidates(anchor, size, size, 0);
  shuffle(candidates, rng);

  const fit = candidates.find((c) => sideCandidateFits(c, grid, mapSize));
  if (!fit) return null;

  // The whole room — interior *and* the one connecting tile — is carved as
  // `SECRET_WALL_TILE`, not floor (so this deliberately does *not* use
  // `carveRect`, which carves to plain floor). Rendering already treats every
  // `SECRET_WALL_TILE` cell as an ordinary wall (3D view, corner minimap,
  // automap), so a room made entirely of it is genuinely indistinguishable
  // from solid rock until opened — a room carved as floor here would show
  // up as a room-shaped hole in the surrounding walls (no fog-of-war on the
  // corner minimap) or leak through the automap's `visited` radius (which
  // has no wall-awareness and reaches past the one doorway tile) well
  // before the player ever interacts with it. Opening flood-fills this
  // whole connected patch to floor at once — see `tryOpenSecretWall`.
  for (let y = fit.y0; y <= fit.y1; y++) {
    for (let x = fit.x0; x <= fit.x1; x++) grid[y][x] = SECRET_WALL_TILE;
  }
  grid[fit.wall.y][fit.wall.x] = SECRET_WALL_TILE;
  return { center: { x: Math.floor((fit.x0 + fit.x1) / 2), y: Math.floor((fit.y0 + fit.y1) / 2) } };
}
