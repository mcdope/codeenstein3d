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
 * elsewhere), followed by the `session-init` payload (which also carries the
 * host's own compiled netcode constants — see `SessionInitMessage`'s own doc
 * comment for why this side, not `sessionSetupHost.ts`, is where that gets
 * checked) and the chunked `GameMap` transfer, reassembled via
 * `ChunkReassembler` and rebuilt with a freshly-constructed `visited` grid
 * (never sent over the wire).
 */
import type { GameMap } from "../map/types";
import { ChunkReassembler } from "./chunkedTransfer";
import { checkBuildVersionMatch } from "./buildVersionCheck";
import { onJsonMessage, sendJsonWithBackpressure } from "./dataChannelMessaging";
import { FIXED_DT, INPUT_DELAY_TICKS, TICK_RATE_HZ } from "./netcodeConstants";
import { checkNetcodeConstantsMatch } from "./netcodeConstantsCheck";
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
          // `.catch(reject)`, not a bare `sendJson` — see
          // `sessionSetupHost.ts`'s identical reasoning for why a real
          // `RTCDataChannel.send()` failure here must settle this module's
          // own `Promise` instead of escaping as an uncaught exception.
          const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
          sendJsonWithBackpressure(channel, ownVersion).catch(reject);
          return;
        }
        case "session-init": {
          // The host's own compiled netcode constants, declared right here
          // — independently checked against our own local values before
          // trusting anything else in this message (never just assume the
          // host agrees with us, same "applies uniformly" principle the
          // build-version check above already follows). This is the only
          // side of the handshake that can meaningfully perform this check:
          // the host is the sole source of these values for the whole
          // session, there's no reverse message carrying a guest's own
          // compiled constants back to it to compare against (see
          // `SessionInitMessage`'s own doc comment).
          if (
            !checkNetcodeConstantsMatch(
              { tickRateHz: TICK_RATE_HZ, fixedDt: FIXED_DT, inputDelayTicks: INPUT_DELAY_TICKS },
              { tickRateHz: message.tickRateHz, fixedDt: message.fixedDt, inputDelayTicks: message.inputDelayTicks },
            )
          ) {
            unsubscribe();
            reject(new SessionSetupError("netcode-constants-mismatch", "host's compiled netcode constants don't match ours"));
            return;
          }
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
