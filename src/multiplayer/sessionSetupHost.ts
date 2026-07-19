// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The host's half of the session-setup handshake (see
 * `sessionSetupTypes.ts`'s doc comment for the wire shapes and channel
 * choice). Sequence: send our own build-version immediately, wait for the
 * guest's; on a match, send roster/tick-constants/seed/difficulty/
 * player-count in one `session-init` message, then the `GameMap` itself
 * (`visited` stripped) as a chunked sequence. Resolves as soon as everything
 * has been *sent* — the reliable/ordered channel is trusted for delivery, no
 * ack is required to complete setup (that's only a real requirement for
 * later level transitions, per the netcode spec).
 *
 * Rejecting a mismatched build-version is as far as this module's
 * responsibility goes — closing the connection or showing UI in response is
 * a later step's job (nothing in the spec's "Session setup" section assigns
 * it here).
 */
import type { DifficultyLevel } from "../difficulty";
import type { GameMap } from "../map/types";
import { randomSeed } from "../prng";
import { chunkJson } from "./chunkedTransfer";
import { onJsonMessage, sendJson } from "./dataChannelMessaging";
import { FIXED_DT, INPUT_DELAY_TICKS, MAP_CHUNK_SIZE_BYTES, TICK_RATE_HZ } from "./netcodeConstants";
import {
  GUEST_PLAYER_ID,
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
  playerCount: number;
}

export function runHostSessionSetup(channels: MultiplayerChannels, options: HostSessionSetupOptions): Promise<SessionSetupResult> {
  return new Promise((resolve, reject) => {
    const channel = channels.reconciliation;

    const unsubscribe = onJsonMessage<SessionSetupMessage>(channel, (message) => {
      if (message.type !== "build-version") return; // only message a guest ever sends us during setup
      unsubscribe();

      if (!checkBuildVersionMatch({ ref: __BUILD_REF__, time: __BUILD_TIME__ }, message)) {
        reject(new SessionSetupError("build-version-mismatch", "guest is on a different build"));
        return;
      }

      const roster = [HOST_PLAYER_ID, GUEST_PLAYER_ID].sort();
      const gameplaySeed = randomSeed();

      sendJson(channel, {
        type: "session-init",
        roster,
        assignedId: GUEST_PLAYER_ID,
        tickRateHz: TICK_RATE_HZ,
        fixedDt: FIXED_DT,
        inputDelayTicks: INPUT_DELAY_TICKS,
        gameplaySeed,
        difficulty: options.difficulty,
        playerCount: options.playerCount,
      });

      const { visited: _visited, ...mapWithoutVisited } = options.map;
      // chunkJson splits by UTF-16 code-unit length, not true byte count —
      // an approximation that only matters for non-ASCII map content (e.g.
      // non-ASCII identifiers); a pre-existing 6a decision, not new here.
      const chunks = chunkJson(mapWithoutVisited, MAP_CHUNK_SIZE_BYTES);
      chunks.forEach((data, index) => sendJson(channel, { type: "map-chunk", index, data }));
      sendJson(channel, { type: "map-end", totalChunks: chunks.length });

      resolve({
        roster,
        assignedId: HOST_PLAYER_ID,
        tickRateHz: TICK_RATE_HZ,
        fixedDt: FIXED_DT,
        inputDelayTicks: INPUT_DELAY_TICKS,
        gameplaySeed,
        difficulty: options.difficulty,
        playerCount: options.playerCount,
        map: options.map,
      });
    });

    const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    sendJson(channel, ownVersion);
  });
}
