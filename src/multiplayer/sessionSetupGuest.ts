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
 *
 * Once the host's build-version actually arrives, the rest of the handshake
 * is bounded by `HANDSHAKE_TIMEOUT_MS` — re-armed on every incoming message,
 * so it only ever fires on a genuine mid-transfer stall (the host stops
 * sending without ever closing the channel, so no error/close event fires
 * either), matching the "never wait forever" rule every other multi-step
 * wait in this subsystem already follows (`TRANSITION_ACK_TIMEOUT_MS`,
 * `BUFFER_DRAIN_TIMEOUT_MS`). Deliberately *not* armed before the first
 * message arrives: the wait for the host to even start (it only does once
 * its user clicks "Start Session") is a lobby-wait, not a protocol step, and
 * has no reasonable fixed bound — confirmed as a real bug in an earlier
 * version of this fix, which armed the timer at call time instead. That
 * broke the 3-player scenario: an early-joining guest waiting for a
 * later-joining guest's own (multi-attempt, several-second) join race to
 * finish before the host clicks "Start Session" could have its handshake
 * time out before the host ever sent a single byte.
 */
import type { GameMap } from "../map/types";
import { ChunkReassembler, isValidMapDimensions } from "./chunkedTransfer";
import { checkBuildVersionMatch } from "./buildVersionCheck";
import { onJsonMessage, sendJsonWithBackpressure } from "./dataChannelMessaging";
import { FIXED_DT, INPUT_DELAY_TICKS, MAX_TRANSFERRED_MAP_DIMENSION, TICK_RATE_HZ } from "./netcodeConstants";
import { checkNetcodeConstantsMatch } from "./netcodeConstantsCheck";
import { SessionSetupError, type BuildVersionMessage, type SessionSetupMessage, type SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

type PendingResult = Omit<SessionSetupResult, "map">;

/** How long (real wall-clock milliseconds) the guest waits, after the *last*
 * handshake message it received, for the next one before giving up — an
 * inactivity window, not a deadline from call time (see this module's doc
 * comment for why: the lobby-wait before the host's first message has no
 * reasonable fixed bound). A reasoned starting point, not a validated value,
 * matching the order of magnitude `netcodeConstants.ts`'s own
 * `TRANSITION_ACK_TIMEOUT_MS`/`BUFFER_DRAIN_TIMEOUT_MS` already use for the
 * same "never wait forever on something that might not happen" discipline
 * elsewhere in this subsystem. Not itself in `netcodeConstants.ts`: this
 * handshake is a guest-only concern (the host has its own, symmetric-in-spirit
 * "never wait forever" guarantee already covered by `main.ts`'s own
 * connection-level handling — nothing else in that shared constants file
 * needs this value). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function runGuestSessionSetup(channels: MultiplayerChannels): Promise<SessionSetupResult> {
  return new Promise((resolve, reject) => {
    const channel = channels.reconciliation;
    let pending: PendingResult | null = null;
    let reassembler: ChunkReassembler | null = null;
    let handshakeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // Not armed until the first message arrives (see this module's doc
    // comment) — re-armed on every subsequent message, so it only ever
    // bounds a genuine stall once the handshake has actually started, never
    // the lobby wait beforehand.
    const armHandshakeTimeout = (): void => {
      if (handshakeTimeoutTimer !== null) clearTimeout(handshakeTimeoutTimer);
      handshakeTimeoutTimer = setTimeout(() => {
        unsubscribe();
        reject(new SessionSetupError("handshake-timeout", `session-setup handshake stalled for ${HANDSHAKE_TIMEOUT_MS}ms after its last message`));
      }, HANDSHAKE_TIMEOUT_MS);
    };
    // Cleared on every settle path below (resolve or any reject) — a timer
    // that fires after the handshake has already settled one way or another
    // must never re-reject an already-resolved/rejected `Promise` (a no-op
    // in practice, `Promise`s only ever settle once, but the unsubscribe
    // below still matters: without it, a late "message" event after the
    // handshake completed would call a handler referencing already-stale
    // closured state for no reason).
    const clearHandshakeTimeout = (): void => {
      if (handshakeTimeoutTimer !== null) clearTimeout(handshakeTimeoutTimer);
    };

    const unsubscribe = onJsonMessage<SessionSetupMessage>(channel, (message) => {
      armHandshakeTimeout();
      switch (message.type) {
        case "build-version": {
          if (!checkBuildVersionMatch({ ref: __BUILD_REF__, time: __BUILD_TIME__ }, message)) {
            unsubscribe();
            clearHandshakeTimeout();
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
          sendJsonWithBackpressure(channel, ownVersion).catch((err) => {
            clearHandshakeTimeout();
            reject(err);
          });
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
            clearHandshakeTimeout();
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
            clearHandshakeTimeout();
            reject(new SessionSetupError("protocol-error", "map-end arrived before every chunk was received"));
            return;
          }
          const mapWithoutVisited = reassembler.finish<Omit<GameMap, "visited">>();
          // Declared dimensions are never trusted before allocating from
          // them — the byte/chunk caps above bound wire size, not this —
          // see `isValidMapDimensions`'s own doc comment.
          if (!isValidMapDimensions(mapWithoutVisited.width, mapWithoutVisited.height, MAX_TRANSFERRED_MAP_DIMENSION)) {
            unsubscribe();
            clearHandshakeTimeout();
            reject(new SessionSetupError("protocol-error", "map-end arrived with invalid or oversized map dimensions"));
            return;
          }
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
          clearHandshakeTimeout();
          resolve({ ...pending, map: { ...mapWithoutVisited, visited } });
          return;
        }
      }
    });
  });
}
