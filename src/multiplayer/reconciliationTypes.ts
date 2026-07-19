// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wire wrapper for periodic host-authoritative state reconciliation (see
 * `doc/dev/multiplayer-netcode-spec.md` §3) — the payload shape itself
 * (`ReconciliationSnapshot` and friends) lives in `src/engine/`, imported
 * here, for the same layering reason `netcodeTypes.ts` imports `PlayerId`/
 * `InputSnapshot` rather than redefining them: the engine layer never
 * imports from the multiplayer layer, only the reverse.
 *
 * Rides the same `reconciliation` channel `sessionSetupTypes.ts`'s one-time
 * handshake uses (that listener has already unsubscribed by the time this
 * traffic starts — see `multiplayerSessionGuest.ts`), discriminated from it
 * by `type`. Sent by the host only, once every `RECONCILE_INTERVAL_TICKS`
 * (`netcodeConstants.ts`), tagged with the tick it reflects (post-`advance()`
 * for that tick).
 */
import type { ReconciliationSnapshot } from "../engine/reconciliationSnapshot";

export type {
  EnemySnapshot,
  LootDropSnapshot,
  MineSnapshot,
  PlayerSnapshot,
  ReconciliationSnapshot,
  TileMutation,
} from "../engine/reconciliationSnapshot";

export interface ReconciliationSnapshotMessage extends ReconciliationSnapshot {
  type: "reconciliation-snapshot";
}
