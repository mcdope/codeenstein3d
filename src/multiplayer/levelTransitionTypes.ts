// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wire shapes for a host-driven level transition (`multiplayer-research.md`
 * step 8, `doc/dev/multiplayer-netcode-spec.md` §7). Rides the
 * `reconciliation` channel, by the same elimination `sessionSetupTypes.ts`'s
 * own doc comment already documents for the initial handshake — `input` is
 * exclusively for per-tick `TickInput`/`TickInputBundle` traffic. Mirrors
 * that same handshake's own three-message chunked-transfer shape
 * (`SessionInitMessage`/`MapChunkMessage`/`MapEndMessage`) almost exactly —
 * a level transition is, functionally, a second smaller handshake mid-session
 * rather than a wholly different kind of message — reusing
 * `chunkedTransfer.ts`'s `chunkJson`/`ChunkReassembler` the same way.
 */
import type { EngineCarryover, PlayerId, RosterSnapshotEntry } from "../engine/engine";
import type { GameMap } from "../map/types";

/** Sent once, before the map chunks — small enough it never needs
 * chunking itself (a handful of players' worth of health/ammo/weapons). */
export interface LevelTransitionInitMessage {
  type: "level-transition-init";
  carryovers: Record<PlayerId, EngineCarryover>;
  gameplaySeed: number;
}

export interface LevelTransitionMapChunkMessage {
  type: "level-transition-map-chunk";
  index: number;
  data: string;
}

export interface LevelTransitionMapEndMessage {
  type: "level-transition-map-end";
  totalChunks: number;
}

/** Sent guest -> host once a guest has fully received and applied the new
 * level — the host waits for one of these per connected guest (or
 * `TRANSITION_ACK_TIMEOUT_MS`) before resuming ticking on the new level. */
export interface LevelTransitionAckMessage {
  type: "level-transition-ack";
  playerId: PlayerId;
}

/** Sent host -> every connected guest instead of a `LevelTransitionInit...`
 * sequence, once `findNextLevel` has nothing further to offer — the host's
 * own local `onSessionEnded("campaign-complete")` previously fired with no
 * wire counterpart at all, leaving every guest's own simulation frozen on
 * the won level forever (its own local `onWin` is a deliberate no-op; a
 * guest only ever progresses via a message on this channel — see
 * `multiplayerSessionGuest.ts`'s own `onWin` doc comment). Best-effort, no
 * ack expected: unlike an actual level transition, nothing further depends
 * on a guest having received this before the host tears down.
 *
 * `comparison` is `RaycasterEngine.rosterSnapshot()`, serialized as a plain
 * object (`ReadonlyMap` isn't JSON-safe) — the shared, host-authoritative
 * end-of-campaign comparison table every peer's own results screen needs.
 * Per-peer `EngineStats` deliberately doesn't travel here: it's local
 * gameplay state (health/ammo/keys) each peer already has from its own
 * engine, not shared session state. */
export interface LevelTransitionCampaignCompleteMessage {
  type: "campaign-complete";
  comparison: Record<PlayerId, RosterSnapshotEntry>;
}

export type LevelTransitionMessage =
  | LevelTransitionInitMessage
  | LevelTransitionMapChunkMessage
  | LevelTransitionMapEndMessage
  | LevelTransitionAckMessage
  | LevelTransitionCampaignCompleteMessage;

/** What a completed level-transition handshake resolves the receiving guest
 * to — the same shape `SessionSetupResult` uses for its own map field,
 * `visited` reconstructed locally rather than sent over the wire (see that
 * interface's own doc comment for why). */
export interface LevelTransitionResult {
  carryovers: Record<PlayerId, EngineCarryover>;
  gameplaySeed: number;
  map: GameMap;
}
