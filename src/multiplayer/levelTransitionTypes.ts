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
import type { EngineCarryover, PlayerId } from "../engine/engine";
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

export type LevelTransitionMessage =
  | LevelTransitionInitMessage
  | LevelTransitionMapChunkMessage
  | LevelTransitionMapEndMessage
  | LevelTransitionAckMessage;

/** What a completed level-transition handshake resolves the receiving guest
 * to — the same shape `SessionSetupResult` uses for its own map field,
 * `visited` reconstructed locally rather than sent over the wire (see that
 * interface's own doc comment for why). */
export interface LevelTransitionResult {
  carryovers: Record<PlayerId, EngineCarryover>;
  gameplaySeed: number;
  map: GameMap;
}
