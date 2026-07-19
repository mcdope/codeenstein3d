// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The guest's half of the session-setup handshake (see
 * `sessionSetupTypes.ts`'s doc comment for the wire shapes and channel
 * choice). Purely receive-driven: this side only ever *starts* by reacting
 * to the host's own build-version, replying with its own once that arrives
 * — never sending eagerly on connect. The host only starts listening (and
 * sending) once its user explicitly clicks "Start Session," which can be an
 * arbitrarily long time after the data channels open; a guest that fires
 * its build-version immediately on connect (this module's original design)
 * races that gap — `RTCDataChannel` doesn't replay a message to a listener
 * attached after it already fired, so an eager guest message sent before
 * the host clicks Start Session is silently lost forever, wedging the host
 * in "Starting session…" indefinitely. Caught by
 * `scripts/verify-multiplayer-netcode.mjs`'s real end-to-end timing, not by
 * any mocked-channel unit test (every existing test drives the messages
 * itself, in whatever order it likes, sidestepping the race entirely). An
 * independent build-version check either way (never just trust the host's
 * own judgment, matching the netcode spec's "applies uniformly" principle
 * elsewhere), followed by the `session-init` payload and the chunked
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
            return;
          }
          // Only reply once the host's own build-version has actually
          // arrived — see this module's doc comment for why sending eagerly
          // on connect (instead) is the real race this guards against.
          const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
          sendJson(channel, ownVersion);
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
  });
}
