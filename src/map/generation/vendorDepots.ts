// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Vendor Depot" supply alcoves: small store rooms carved straight into the
 * spawn room's wall, one per few top-level imports the file declares.
 *
 * The mapping is the joke and the mechanic at once — the third-party code a
 * file leans on becomes the third-party supplies you start the level leaning
 * on. A file with no imports gets none, and a file with a long import block
 * opens with a genuinely well-stocked armory.
 */
import type { AmmoPickup, Point, Rect, Room, Tile } from "../types";
import { carveRect, connectorTiles, sideCandidateFits, sideCandidates } from "./geometry";
import { clamp, shuffle } from "./util";

/** Feature flag — see `doc/dev/architecture.md`'s Feature Flags table. Checked
 * at the `mapGenerator.ts` call site, so a disabled feature draws zero rng and
 * leaves every other map layout byte-identical. */
export const VENDOR_DEPOTS_ENABLED = true;

/** Top-level imports needed per depot. Four keeps a two-import script from
 * opening with free ammo while a real module header still earns a couple. */
const IMPORTS_PER_DEPOT = 4;
/** Hard cap, however long the import block is — these sit on the spawn room's
 * wall, and past a handful they'd eat its whole perimeter. */
const MAX_VENDOR_DEPOTS = 4;
/** A depot is 1x1 or 2x2, rolled per depot. */
const DEPOT_MIN_SIZE = 1;
const DEPOT_MAX_SIZE = 2;

/** Depot stock amounts. Deliberately around one magazine each — a depot is a
 * head start, not a substitute for playing the level. */
const VENDOR_BULLETS_AMOUNT = 12;
const VENDOR_ROCKETS_AMOUNT = 3;
const VENDOR_SMG_AMOUNT = 30;
const VENDOR_GAS_AMOUNT = 30;

/** One candidate outcome for a depot's stock — see the availability gate in
 * `placeVendorDepots`. */
interface VendorStock {
  kind: AmmoPickup["kind"];
  amount: number;
}

/**
 * Carve up to `MAX_VENDOR_DEPOTS` alcoves into `spawnRoom`'s wall and stock
 * each with third-party supplies.
 *
 * The alcoves sit *directly* against the wall (offset 0), with the wall tile
 * itself carved open as the doorway — that's what makes them read as built
 * into the spawn room rather than as separate rooms down a corridor, and it's
 * why they need no corridor of their own.
 *
 * `hasRocketLauncher`/`hasSmg`/`hasGas` gate which ammo pools are worth
 * stocking: a magazine for a gun the player hasn't unlocked is dead loot. The
 * stock is then picked uniformly among whatever's actually available, the same
 * pattern `placeSecretRooms` uses for its guaranteed pickup, so "always
 * bullets" can't happen once anything else is in the running.
 *
 * Never a hard failure: a spawn room with no free rock beside it simply gets
 * fewer (or zero) depots.
 */
export function placeVendorDepots(
  spawnRoom: Room,
  grid: Tile[][],
  mapSize: number,
  importCount: number,
  rng: () => number,
  hasRocketLauncher: boolean,
  hasSmg: boolean,
  hasGas: boolean,
): { depots: Rect[]; pickups: AmmoPickup[] } {
  const wanted = clamp(Math.floor(importCount / IMPORTS_PER_DEPOT), 0, MAX_VENDOR_DEPOTS);
  // Early-out *before* any rng draw, so a file with too few imports leaves the
  // whole downstream draw sequence exactly as it was.
  if (wanted === 0) return { depots: [], pickups: [] };

  const stockCandidates: VendorStock[] = [{ kind: "bullets", amount: VENDOR_BULLETS_AMOUNT }];
  if (hasRocketLauncher) stockCandidates.push({ kind: "rockets", amount: VENDOR_ROCKETS_AMOUNT });
  if (hasSmg) stockCandidates.push({ kind: "smg", amount: VENDOR_SMG_AMOUNT });
  if (hasGas) stockCandidates.push({ kind: "gas", amount: VENDOR_GAS_AMOUNT });

  const depots: Rect[] = [];
  const pickups: AmmoPickup[] = [];

  for (let i = 0; i < wanted; i++) {
    const size = DEPOT_MIN_SIZE + Math.floor(rng() * (DEPOT_MAX_SIZE - DEPOT_MIN_SIZE + 1));
    const candidates = sideCandidates(spawnRoom, size, size, 0);
    shuffle(candidates, rng);

    const fit = candidates.find((c) => sideCandidateFits(c, grid, mapSize));
    if (!fit) continue;

    const rect = carveRect(grid, fit.x0, fit.y0, fit.x1, fit.y1);
    // Open the doorway last: `sideCandidateFits` required it to still be rock,
    // and carving it is what connects the alcove to the spawn room.
    for (const tile of connectorTiles(fit, 0)) grid[tile.y][tile.x] = 0;
    depots.push(rect);

    // A 2x2 depot is stocked twice, a 1x1 once — the bigger alcove is visibly
    // the better find, rather than differing only in floor area.
    for (let slot = 0; slot < (size >= 2 ? 2 : 1); slot++) {
      const stock = stockCandidates[Math.floor(rng() * stockCandidates.length)];
      const spot = depotSlotTile(rect, slot);
      pickups.push({ x: spot.x + 0.5, y: spot.y + 0.5, kind: stock.kind, amount: stock.amount, collected: false });
    }
  }

  return { depots, pickups };
}

/** Where a depot's `slot`-th pickup sits. Deterministic rather than rolled:
 * the alcove is 1-2 tiles across, so there's no meaningful choice to make and
 * a draw here would only perturb the sequence for nothing. */
function depotSlotTile(rect: Rect, slot: number): Point {
  return slot === 0
    ? { x: rect.x, y: rect.y }
    : { x: rect.x + rect.w - 1, y: rect.y + rect.h - 1 };
}
