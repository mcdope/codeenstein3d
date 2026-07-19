// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wire shapes for the session-setup handshake (see
 * `doc/dev/multiplayer-netcode-spec.md`'s "Session setup" section): what the
 * host sends a guest, over the already-open data channels from the connect
 * flow, before any tick traffic begins — build-version check, roster
 * assignment, tick constants, seed, difficulty, player count, and the
 * `GameMap` itself (chunked, `visited` stripped).
 *
 * All of this rides the `reconciliation` channel, by elimination:
 * `netcodeTypes.ts`'s own doc comment already reserves the `input` channel
 * exclusively for per-tick `TickInput`/`TickInputBundle` traffic, leaving
 * `reconciliation` as the only channel left for this one-time handshake (and,
 * later, periodic reconciliation snapshots — same channel, discriminated by
 * message type, per that step's own design).
 */
import type { DifficultyLevel } from "../difficulty";
import type { PlayerId } from "../engine/engine";
import type { GameMap } from "../map/types";
import type { BuildVersion } from "./buildVersionCheck";

/** Fixed roster ids for the 2-player MVP: the connect flow (step 2) only
 * ever supports exactly one host + one guest — one `RTCPeerConnection`, one
 * offer/answer code, no multi-guest-slot concept anywhere. Randomly
 * generating ids would be solving a collision problem that can't occur at
 * this slot count; revisit only if the connect flow itself grows multi-guest
 * support. Reuses the same literal vocabulary `MultiplayerRole` already
 * establishes (`types.ts`), not new terms. */
export const HOST_PLAYER_ID: PlayerId = "host";
export const GUEST_PLAYER_ID: PlayerId = "guest";

export interface BuildVersionMessage extends BuildVersion {
  type: "build-version";
}

export interface SessionInitMessage {
  type: "session-init";
  roster: PlayerId[];
  assignedId: PlayerId;
  tickRateHz: number;
  fixedDt: number;
  inputDelayTicks: number;
  gameplaySeed: number;
  difficulty: DifficultyLevel;
  playerCount: number;
}

export interface MapChunkMessage {
  type: "map-chunk";
  index: number;
  data: string;
}

export interface MapEndMessage {
  type: "map-end";
  totalChunks: number;
}

export type SessionSetupMessage = BuildVersionMessage | SessionInitMessage | MapChunkMessage | MapEndMessage;

/** What a completed session-setup handshake resolves both peers to — the
 * same shape on the host and the guest, so downstream (engine construction)
 * code doesn't need to branch on role to read it. */
export interface SessionSetupResult {
  roster: PlayerId[];
  assignedId: PlayerId;
  tickRateHz: number;
  fixedDt: number;
  inputDelayTicks: number;
  gameplaySeed: number;
  difficulty: DifficultyLevel;
  playerCount: number;
  /** `visited` is reconstructed locally (all-false, matching `width`/
   * `height`) rather than sent over the wire — it's all-false at generation
   * time by definition, same reasoning `mapGenerator.ts` itself starts every
   * generation with. */
  map: GameMap;
}

export type SessionSetupErrorCode = "build-version-mismatch" | "protocol-error";

/** Mirrors `signalingClient.ts`'s `SignalingError` pattern: a typed `code`
 * lets calling code (a later step's connection teardown/UI messaging — not
 * this step's job) pattern-match on what went wrong instead of parsing an
 * error message string. */
export class SessionSetupError extends Error {
  constructor(
    public readonly code: SessionSetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionSetupError";
  }
}
