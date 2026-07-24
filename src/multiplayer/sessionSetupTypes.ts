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

/** The host's fixed roster id — always `"host"`, the one id never assigned
 * dynamically (the host is the sole authority handing out every other id, so
 * there's nothing for it to be assigned by). */
export const HOST_PLAYER_ID: PlayerId = "host";

/** A guest's roster id, assigned by the host in join order (step 10: N-player,
 * up to `maxPlayers - 1` guests, chosen by the host before creating a
 * session — see `multiplayer-server-spec.md` §2's "sequential, not
 * concurrent, per-code joins," which is what makes serial assignment safe:
 * the host is the sole authority handing these out, one guest connects at a
 * time, so there's no collision risk to guard against with random ids. */
export function guestPlayerId(n: number): PlayerId {
  return `guest-${n}`;
}

export interface BuildVersionMessage extends BuildVersion {
  type: "build-version";
}

/** `tickRateHz`/`fixedDt`/`inputDelayTicks` are the host's own compiled
 * `netcodeConstants.ts` values — a guest independently checks these against
 * its own local values on arrival (`checkNetcodeConstantsMatch`, called from
 * `runGuestSessionSetup`), hard-failing on a mismatch instead of silently
 * using its own local constants regardless of what the host declared (which
 * is what every downstream reader of `SessionSetupResult.fixedDt`/
 * `inputDelayTicks` used to do — see `multiplayerSessionGuest.ts`'s own
 * direct `netcodeConstants.ts` imports, never these fields). Only the guest
 * can meaningfully perform this check: the host is the sole source of these
 * values for the whole session (there's no reverse message carrying a
 * guest's own compiled constants back to the host to compare against). */
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

export type SessionSetupErrorCode = "build-version-mismatch" | "protocol-error" | "netcode-constants-mismatch" | "handshake-timeout";

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
