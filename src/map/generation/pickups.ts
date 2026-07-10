// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Sparse static ammo-pickup scatter (boosted on bonus/restock levels). */
import type { AmmoPickup, Point, Room, Tile } from "../types";
import { findPropSpot } from "./geometry";

/** Odds any given non-spawn room gets a scattered ammo pickup — deliberately
 * sparse, since the primary ammo source is the starting reserve plus enemy
 * loot drops, not free static pickups. */
const AMMO_PICKUP_ROOM_CHANCE = 0.22;
/** Odds a given scattered pickup is rockets rather than bullets — rockets are
 * the scarcer, higher-value ammo type. */
const AMMO_PICKUP_ROCKET_CHANCE = 0.3;
/** Amount granted per scattered pickup, by kind (kept local rather than
 * imported from the engine layer's `loot.ts` — the map layer never depends on
 * the engine layer, only the reverse). Bumped ~40-50% over the original
 * 8/2 baseline — playtest feedback was that ammo ran too scarce on Normal. */
const AMMO_PICKUP_BULLETS_AMOUNT = 11;
const AMMO_PICKUP_ROCKETS_AMOUNT = 3;
/** A bonus (restock-arena) level scatters pickups far more liberally, and
 * each one grants more — it's meant to feel like a deliberate resupply stop,
 * not a normal combat level that happens to have a few pickups. */
const BONUS_AMMO_ROOM_CHANCE = 0.65;
const BONUS_AMMO_AMOUNT_MULTIPLIER = 1.5;

/**
 * Scatter a sparse handful of statically-placed ammo pickups (bullets or
 * rockets) across the map — one candidate roll per non-spawn room, each
 * independently likely to actually get one. A backup source, not the primary
 * one (see `AMMO_PICKUP_ROOM_CHANCE`'s doc comment) — except on a bonus level,
 * where both the odds and the amounts are boosted (see `BONUS_AMMO_ROOM_CHANCE`).
 */
export function placeAmmoPickups(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
  bonusLevel: boolean,
  hasRocketLauncher: boolean,
): AmmoPickup[] {
  const pickups: AmmoPickup[] = [];
  const roomChance = bonusLevel ? BONUS_AMMO_ROOM_CHANCE : AMMO_PICKUP_ROOM_CHANCE;
  const amountMultiplier = bonusLevel ? BONUS_AMMO_AMOUNT_MULTIPLIER : 1;

  rooms.forEach((room, index) => {
    if (index === 0) return; // never in the spawn room
    if (rng() >= roomChance) return;

    const placedSoFar = pickups.map((p) => ({ x: Math.floor(p.x), y: Math.floor(p.y) }));
    const spot = findPropSpot(room, grid, avoid, placedSoFar, rng);
    if (!spot) return;

    const kind = hasRocketLauncher && rng() < AMMO_PICKUP_ROCKET_CHANCE ? "rockets" : "bullets";
    const base = kind === "rockets" ? AMMO_PICKUP_ROCKETS_AMOUNT : AMMO_PICKUP_BULLETS_AMOUNT;
    pickups.push({
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      kind,
      amount: Math.round(base * amountMultiplier),
      collected: false,
    });
  });
  return pickups;
}
