// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The guest's half of the session-setup handshake (see
 * `sessionSetupTypes.ts`'s doc comment for the wire shapes and channel
 * choice). Purely receive-driven, mirrored against `sessionSetupHost.ts`'s
 * send sequence: send our own build-version immediately, then react to
 * whatever arrives — an independent build-version check (never just trust
 * the host's own judgment, matching the netcode spec's "applies uniformly"
 * principle elsewhere), the `session-init` payload, and the chunked
 * `GameMap` transfer, reassembled via `ChunkReassembler` and rebuilt with a
 * freshly-constructed `visited` grid (never sent over the wire).
 */
import type { GameMap } from "../map/types";
import { ChunkReassembler } from "./chunkedTransfer";
import { checkBuildVersionMatch } from "./buildVersionCheck";
import { onJsonMessage, sendJson } from "./dataChannelMessaging";
import { SessionSetupError, type BuildVersionMessage, type SessionSetupMessage, type SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

type PendingResult = Omit<SessionSetupResult, "map">;

export function runGuestSessionSetup(channels: MultiplayerChannels): Promise<SessionSetupResult> {
  return new Promise((resolve, reject) => {
    const channel = channels.reconciliation;
    let pending: PendingResult | null = null;
    let reassembler: ChunkReassembler | null = null;

    const unsubscribe = onJsonMessage<SessionSetupMessage>(channel, (message) => {
      switch (message.type) {
        case "build-version": {
          if (!checkBuildVersionMatch({ ref: __BUILD_REF__, time: __BUILD_TIME__ }, message)) {
            unsubscribe();
            reject(new SessionSetupError("build-version-mismatch", "host is on a different build"));
          }
          return;
        }
        case "session-init": {
          pending = {
            roster: message.roster,
            assignedId: message.assignedId,
            tickRateHz: message.tickRateHz,
            fixedDt: message.fixedDt,
            inputDelayTicks: message.inputDelayTicks,
            gameplaySeed: message.gameplaySeed,
            difficulty: message.difficulty,
            playerCount: message.playerCount,
          };
          reassembler = new ChunkReassembler();
          return;
        }
        case "map-chunk": {
          reassembler?.push(message.data, message.index);
          return;
        }
        case "map-end": {
          if (!pending || !reassembler || !reassembler.isComplete(message.totalChunks)) {
            unsubscribe();
            reject(new SessionSetupError("protocol-error", "map-end arrived before every chunk was received"));
            return;
          }
          const mapWithoutVisited = reassembler.finish<Omit<GameMap, "visited">>();
          // Reconstructed locally rather than transferred — see
          // sessionSetupTypes.ts's SessionSetupResult doc comment. Explicit
          // height/width (not a single "size"), matching GameMap.visited's
          // documented `visited[y][x]` contract, not just today's
          // implementation detail that every generated map happens to be
          // square.
          const visited: boolean[][] = Array.from({ length: mapWithoutVisited.height }, () =>
            new Array<boolean>(mapWithoutVisited.width).fill(false),
          );
          unsubscribe();
          resolve({ ...pending, map: { ...mapWithoutVisited, visited } });
          return;
        }
      }
    });

    const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    sendJson(channel, ownVersion);
  });
}
