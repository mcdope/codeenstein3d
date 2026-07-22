// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The host's half of the session-setup handshake (see
 * `sessionSetupTypes.ts`'s doc comment for the wire shapes and channel
 * choice). Sequence, per connected guest: send our own build-version
 * immediately, wait for that guest's; on a match, send roster/tick-constants/
 * seed/difficulty/player-count in one `session-init` message (which also
 * carries our own compiled netcode constants — see `SessionInitMessage`'s own
 * doc comment for why only the guest side checks those, not here), then the
 * `GameMap` itself (`visited` stripped) as a chunked sequence. Resolves as
 * soon as everything has been *sent* — the reliable/ordered channel is
 * trusted for delivery, no ack is required to complete setup (that's only a
 * real requirement for later level transitions, per the netcode spec).
 *
 * Step 10 (N-player): every guest joins during a pre-game lobby phase (see
 * `main.ts`'s connect flow), so the full roster is already final by the time
 * any of this runs — `runHostSessionSetup` is called once per connected
 * guest, all fanned out concurrently (`Promise.all` in `main.ts`), each guest
 * getting the identical `roster`/`gameplaySeed` but its own `assignedId`.
 * There's deliberately no "amend an already-setup guest's roster" message —
 * since setup never starts until every guest that's going to join already
 * has, it's never needed.
 *
 * Rejecting a mismatched build-version is as far as this module's
 * responsibility goes — closing the connection or showing UI in response is
 * a later step's job (nothing in the spec's "Session setup" section assigns
 * it here).
 */
import type { DifficultyLevel } from "../difficulty";
import type { PlayerId } from "../engine/engine";
import type { GameMap } from "../map/types";
import { chunkJson } from "./chunkedTransfer";
import { onJsonMessage, sendJsonSequence, sendJsonWithBackpressure } from "./dataChannelMessaging";
import { FIXED_DT, INPUT_DELAY_TICKS, MAP_CHUNK_SIZE_BYTES, TICK_RATE_HZ } from "./netcodeConstants";
import {
  HOST_PLAYER_ID,
  SessionSetupError,
  type BuildVersionMessage,
  type SessionSetupMessage,
  type SessionSetupResult,
} from "./sessionSetupTypes";
import { checkBuildVersionMatch } from "./buildVersionCheck";
import type { MultiplayerChannels } from "./types";

export interface HostSessionSetupOptions {
  map: GameMap;
  difficulty: DifficultyLevel;
  /** The full, final roster — host first, then every joined guest in join
   * order. Identical across every guest's own `runHostSessionSetup` call;
   * `playerCount` is always `roster.length`, never passed separately, so the
   * two can never drift apart. */
  roster: readonly PlayerId[];
  /** Generated once by the caller (`main.ts`, at "Start Session" time) and
   * reused across every guest's setup call and the host's own
   * `buildHostSessionSetupResult` — every peer must agree on the same seed,
   * so it can't be regenerated per guest. */
  gameplaySeed: number;
}

/** The host's own `SessionSetupResult` — the same shape every guest's own
 * `runGuestSessionSetup` resolves to, built directly here rather than over
 * the wire (the host never sends itself a `session-init`). Call once, after
 * every guest's `runHostSessionSetup` has been kicked off (order doesn't
 * matter — this reads nothing any of those calls produce). */
export function buildHostSessionSetupResult(options: HostSessionSetupOptions): SessionSetupResult {
  return {
    roster: [...options.roster],
    assignedId: HOST_PLAYER_ID,
    tickRateHz: TICK_RATE_HZ,
    fixedDt: FIXED_DT,
    inputDelayTicks: INPUT_DELAY_TICKS,
    gameplaySeed: options.gameplaySeed,
    difficulty: options.difficulty,
    playerCount: options.roster.length,
    map: options.map,
  };
}

/** Runs the setup handshake with exactly one guest, over that guest's own
 * `channels` — call once per connected guest (`main.ts` fans these out
 * concurrently via `Promise.all`, since each is an independent chunked
 * transfer with its own backpressure wait; see this module's doc comment for
 * why sequential fan-out would multiply wall-clock time with guest count). */
export function runHostSessionSetup(
  channels: MultiplayerChannels,
  assignedId: PlayerId,
  options: HostSessionSetupOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = channels.reconciliation;
    // TEMPORARY diagnostic logging (to be removed once root-caused) — see
    // `main.ts`'s own matching diagnostic comment for why.
    console.log(`[diag] runHostSessionSetup(${assignedId}): starting, channel.readyState=${channel.readyState}`);

    const unsubscribe = onJsonMessage<SessionSetupMessage>(channel, (message) => {
      console.log(`[diag] runHostSessionSetup(${assignedId}): received message type=${message.type}`);
      if (message.type !== "build-version") return; // only message a guest ever sends us during setup
      unsubscribe();

      if (!checkBuildVersionMatch({ ref: __BUILD_REF__, time: __BUILD_TIME__ }, message)) {
        reject(new SessionSetupError("build-version-mismatch", "guest is on a different build"));
        return;
      }

      const sessionInitMessage = {
        type: "session-init" as const,
        roster: [...options.roster],
        assignedId,
        tickRateHz: TICK_RATE_HZ,
        fixedDt: FIXED_DT,
        inputDelayTicks: INPUT_DELAY_TICKS,
        gameplaySeed: options.gameplaySeed,
        difficulty: options.difficulty,
        playerCount: options.roster.length,
      };

      const { visited: _visited, ...mapWithoutVisited } = options.map;
      // chunkJson splits by UTF-16 code-unit length, not true byte count —
      // an approximation that only matters for non-ASCII map content (e.g.
      // non-ASCII identifiers); a pre-existing 6a decision, not new here.
      const chunks = chunkJson(mapWithoutVisited, MAP_CHUNK_SIZE_BYTES);
      const chunkMessages = chunks.map((data, index) => ({ type: "map-chunk" as const, index, data }));
      const mapEndMessage = { type: "map-end" as const, totalChunks: chunks.length };

      // Backpressure-aware and stops (rejects) the instant any one message
      // fails — see `sendJsonSequence`'s own doc comment for why a real
      // `RTCDataChannel.send()` burst needs this (confirmed directly as the
      // cause of a real CI failure, not a theoretical concern). `.catch`,
      // not `try`/`await` here: `onJsonMessage`'s handler type is
      // synchronous (`(message: T) => void`), so an `async` callback's own
      // rejection would never actually reach anything — this settles the
      // outer `Promise` explicitly instead of relying on that.
      console.log(`[diag] runHostSessionSetup(${assignedId}): sending session-init + ${chunkMessages.length} map chunks + map-end`);
      sendJsonSequence(channel, [sessionInitMessage, ...chunkMessages, mapEndMessage])
        .then(() => {
          console.log(`[diag] runHostSessionSetup(${assignedId}): sendJsonSequence resolved, resolving setup`);
          resolve();
        })
        .catch((err) => {
          console.log(`[diag] runHostSessionSetup(${assignedId}): sendJsonSequence REJECTED: ${err instanceof Error ? err.message : String(err)}`);
          reject(err);
        });
    });

    const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    console.log(`[diag] runHostSessionSetup(${assignedId}): sending own build-version`);
    sendJsonWithBackpressure(channel, ownVersion)
      .then(() => console.log(`[diag] runHostSessionSetup(${assignedId}): own build-version sent successfully`))
      .catch((err) => {
        console.log(`[diag] runHostSessionSetup(${assignedId}): sendJsonWithBackpressure(build-version) REJECTED: ${err instanceof Error ? err.message : String(err)}`);
        reject(err);
      });
  });
}
