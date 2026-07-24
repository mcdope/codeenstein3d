// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The shape of a periodic host-authoritative state snapshot (see
 * `doc/dev/multiplayer-netcode-spec.md` §3, "State reconciliation payload").
 * Lives in `src/engine/`, not `src/multiplayer/`, for the same layering
 * reason `PlayerId`/`EngineStats` do (`engine.ts`'s own doc comments): the
 * engine layer never imports from the multiplayer layer, only the reverse —
 * `RaycasterEngine.captureReconciliationSnapshot()`/`applyReconciliationSnapshot()`
 * (`engine.ts`) need this shape natively. `src/multiplayer/reconciliationTypes.ts`
 * imports it and adds the wire-message discriminator on top, the same
 * pattern `netcodeTypes.ts` already uses for `PlayerId`/`InputSnapshot`.
 *
 * Exists because pure lockstep input sync alone isn't safe: cross-browser-
 * engine transcendental math (`Math.sin`/`cos`/`atan2`) isn't bit-identical
 * (confirmed by `scripts/poc-cross-browser-determinism.mjs`), and a late/
 * missing input packet's held-last-input fallback (`InputDelayBuffer`) is a
 * second, independent drift source.
 */
import type { PlayerId } from "./engine";
import type { LootKind, Tile } from "../map/types";

/** One player's full authoritative state at the snapshot's tick — every
 * field a guest's local simulation could have drifted on. `alive` is a flag,
 * never signaled by omission: a dead-but-spectating player still needs a
 * position/camera-follow-target, and `players` always contains every roster
 * member regardless of status. `ownedWeapons` is sorted ascending — the
 * canonical order for a byte-identical-shaped snapshot, not insertion order
 * (a `Set`'s iteration order is insertion order, which a guest's own local
 * grant sequence could differ on even after full state agreement). */
export interface PlayerSnapshot {
  posX: number;
  posY: number;
  dirX: number;
  dirY: number;
  planeX: number;
  planeY: number;
  health: number;
  swap: number;
  ammo: { bullets: number; rockets: number; smg: number; gas: number };
  weaponIndex: number;
  keysHeld: number;
  ownedWeapons: number[];
  alive: boolean;
  /** Drift-*permanent* accumulators — a kill credited differently during a
   * desync window stays different forever unless corrected here. Every other
   * score field is either recomputed live from already-reconciled state or a
   * bounded/cosmetic local counter that doesn't need correcting (see the
   * spec's own "deliberately excluded" list). */
  killScore: number;
  kills: number;
}

/** Index-aligned with `GameMap.enemies` — fixed at map-generation time, so
 * array index is already a stable shared identity, no id scheme needed.
 * Short-lived per-enemy timers (`attackCooldown`/`hitFlash`/roam target/
 * `fireCooldown`) are deliberately excluded: self-correcting within about one
 * cooldown period, no fairness impact worth the bandwidth. */
export interface EnemySnapshot {
  index: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  aggroed: boolean;
}

/** Index-aligned with `GameMap.mines`, same stable-index reasoning as
 * `EnemySnapshot`. `closeTimer` (sub-second fuse-arming state) is
 * deliberately excluded — the fairness-relevant "did it detonate" moment is
 * already captured by `alive` the instant it actually happens host-side. */
export interface MineSnapshot {
  index: number;
  alive: boolean;
  visible: boolean;
}

/** Runtime-spawned, *not* index-stable (`RaycasterEngine.drops` grows
 * dynamically during play) — needs its own id, assigned at push time (see
 * `RaycasterEngine.pushLootDrop`'s doc comment for the exact scheme). */
export interface LootDropSnapshot {
  id: string;
  x: number;
  y: number;
  kind: LootKind;
  amount?: number;
  weaponIndex?: number;
  /** See `LootDrop.source`'s doc comment (`map/types.ts`) — set only for a
   * disconnect-converted-inventory drop. */
  source?: "disconnect";
}

/** One tile's value changed since the receiver's last applied snapshot
 * (a secret-wall flood-fill or a door opening) — paired with `gridVersion`,
 * which reuses the engine's existing cache-invalidation counter rather than
 * inventing a second one. */
export interface TileMutation {
  x: number;
  y: number;
  value: Tile;
}

/**
 * The full per-interval payload. `rngState` is the shared `mulberry32`
 * stream's raw 32-bit internal counter, post-`advance()` for `tick` — always
 * overwritten unconditionally on receipt, with no magnitude threshold
 * (unlike position): a PRNG stream position is either byte-identical
 * already (the write is a no-op) or it's completely wrong from that point
 * forward, never "off by a little." See `RaycasterEngine.applyReconciliationSnapshot`'s
 * doc comment for why this field is mandatory, not optional — fixing every
 * *visible* field without it fixes the symptom for exactly one tick and
 * guarantees a fresh divergence on the very next PRNG-consuming decision.
 *
 * `levelTime` itself needs no reconciliation (pure repeated addition of the
 * same constant, bit-identical by IEEE-754 across engines), so it isn't
 * here — nor is anything purely derived from it (e.g. `SpikeTrap`'s active
 * state). In-flight `Projectile`/`Rocket` state is excluded too: high-
 * frequency and extremely short-lived, resolving within a fraction of a
 * second either way — the outcome that matters (damage dealt) is already
 * captured by `players`/`enemies`.
 */
export interface ReconciliationSnapshot {
  tick: number;
  rngState: number;
  players: Record<PlayerId, PlayerSnapshot>;
  enemies: EnemySnapshot[];
  mines: MineSnapshot[];
  lootDrops: LootDropSnapshot[];
  /** Indices into `GameMap.ammoPickups` now collected. */
  pickupsCollected: number[];
  /** Indices into `GameMap.keys` now collected. */
  keysCollected: number[];
  gridVersion: number;
  gridDelta: TileMutation[];
}
