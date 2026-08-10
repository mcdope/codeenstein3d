// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The host's half of the session-setup handshake (see
 * `sessionSetupTypes.ts`'s doc comment for the wire shapes and channel
 * choice).
 *
 * **Two phases, because `session-init` carries every player's name.** Phase A
 * (`runHostSessionSetupPhaseA`, once per guest, concurrent) sends our own
 * build-version and waits for that guest's build-version *and* its chosen
 * name. Only once every guest's phase A has resolved does the caller know the
 * complete `displayNames` map; it merges them (plus the host's own) and runs
 * phase B (`runHostSessionSetupPhaseB`, once per guest, concurrent again),
 * which sends roster/tick-constants/seed/difficulty/player-count/names in one
 * `session-init` message (which also carries our own compiled netcode
 * constants — see `SessionInitMessage`'s own doc comment for why only the
 * guest side checks those, not here), then the `GameMap` itself (`visited`
 * stripped) as a chunked sequence.
 *
 * The split is forced by the fan-out, not chosen for tidiness: every guest's
 * `session-init` must carry *all* the names, and the per-guest handshakes run
 * concurrently, so a single-pass exchange cannot know guest B's name while
 * building guest A's message. It reintroduces no protocol race — both phases
 * still begin with a host send, and the guest still only ever replies (see
 * `sessionSetupGuest.ts`'s doc comment for the eager-send bug that rule
 * exists to prevent).
 *
 * Phase B resolves as soon as everything has been *sent* — the reliable/
 * ordered channel is trusted for delivery, no ack is required to complete
 * setup (that's only a real requirement for later level transitions, per the
 * netcode spec).
 *
 * Step 10 (N-player): every guest joins during a pre-game lobby phase (see
 * `main.ts`'s connect flow), so the full roster is already final by the time
 * any of this runs — each phase is called once per connected guest, all
 * fanned out concurrently (`Promise.all` in `main.ts`), each guest getting
 * the identical `roster`/`gameplaySeed`/`displayNames` but its own
 * `assignedId`.
 * There's deliberately no "amend an already-setup guest's roster" message —
 * since setup never starts until every guest that's going to join already
 * has, it's never needed.
 *
 * Rejecting a mismatched build-version is as far as this module's
 * responsibility goes — closing the connection or showing UI in response is
 * a later step's job (nothing in the spec's "Session setup" section assigns
 * it here).
 *
 * Bounded by `HANDSHAKE_TIMEOUT_MS`, the host-side counterpart to
 * `sessionSetupGuest.ts`'s own timeout — without it, a guest whose tab
 * freezes or closes right after connecting (never sending its own
 * build-version) wedges this call, and every other guest's own setup
 * alongside it in `main.ts`'s `Promise.all`, forever. Armed immediately at
 * call time, unlike the guest's — this side has no "wait for the user to
 * click Start Session" pre-phase to avoid timing out early: by the time
 * `runHostSessionSetup` is called (once per already-connected guest, all at
 * once), the host user has already clicked Start Session, and this
 * function's own first send happens unconditionally right away.
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

/** How long (real wall-clock milliseconds) the host waits for a connected
 * guest's own build-version *and* chosen name before giving up on that
 * guest's setup —
 * matches `sessionSetupGuest.ts`'s own `HANDSHAKE_TIMEOUT_MS` value (same
 * order-of-magnitude "never wait forever" reasoning as
 * `TRANSITION_ACK_TIMEOUT_MS`/`BUFFER_DRAIN_TIMEOUT_MS`), but armed
 * differently — see this module's doc comment for why call-time is safe
 * here even though it wasn't for the guest's own timer. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

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
  /** Every roster member's chosen name (`""` for unset), keyed by roster id:
   * the host's own, merged with what each guest returned from phase A. Only
   * knowable after *every* phase A has resolved, which is why these options
   * are built between the two phases rather than before both. */
  displayNames: Record<PlayerId, string>;
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
    displayNames: { ...options.displayNames },
    map: options.map,
  };
}

/**
 * Phase A with exactly one guest, over that guest's own `channels`: sends our
 * build-version, waits for that guest's build-version *and* its chosen name,
 * and resolves with the name (raw, exactly as chosen — `""` when unset; the
 * fallback and the sanitizing both happen once, later, where a name enters
 * the game). Call once per connected guest, concurrently — see this module's
 * doc comment for why the fan-out is what forces the phase split.
 *
 * Both messages are required to settle it, in either order: the guest sends
 * them back-to-back over an ordered channel, so name-then-version is not a
 * shape that occurs today, but ordering the *arrival* logic on that would be
 * a needless dependency on a detail of the other side's send order.
 */
export function runHostSessionSetupPhaseA(channels: MultiplayerChannels): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = channels.reconciliation;
    let versionChecked = false;
    let chosenName: string | null = null;

    // Armed immediately (see this module's own doc comment for why that's
    // safe on this side) and cleared on every settle path below.
    const handshakeTimeoutTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      unsubscribe();
      reject(
        new SessionSetupError(
          "handshake-timeout",
          `guest never sent its own build-version and name within ${HANDSHAKE_TIMEOUT_MS}ms`,
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);

    const unsubscribe = onJsonMessage<SessionSetupMessage>(channel, (message) => {
      if (message.type === "build-version") {
        if (!checkBuildVersionMatch({ ref: __BUILD_REF__, time: __BUILD_TIME__ }, message)) {
          unsubscribe();
          clearTimeout(handshakeTimeoutTimer);
          reject(new SessionSetupError("build-version-mismatch", "guest is on a different build"));
          return;
        }
        versionChecked = true;
      } else if (message.type === "player-name") {
        // Anything that isn't a string is treated as "no name chosen" rather
        // than failing the handshake: a cosmetic field is never a reason to
        // refuse a peer, and the fallback covers it exactly as an empty one.
        chosenName = typeof message.name === "string" ? message.name : "";
      } else {
        return; // no other message shape a guest sends us during phase A
      }

      if (!versionChecked || chosenName === null) return; // still waiting for the other half
      unsubscribe();
      clearTimeout(handshakeTimeoutTimer);
      resolve(chosenName);
    });

    const ownVersion: BuildVersionMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    sendJsonWithBackpressure(channel, ownVersion).catch((err) => {
      unsubscribe();
      clearTimeout(handshakeTimeoutTimer);
      reject(err);
    });
  });
}

/**
 * Phase B with exactly one guest: `session-init` (now carrying the complete
 * `displayNames` merged from every phase A) followed by the chunked map.
 * Call once per connected guest, concurrently, after *every* phase A has
 * resolved — each is an independent chunked transfer with its own
 * backpressure wait, so sequential fan-out would multiply wall-clock time
 * with guest count.
 *
 * No listener and no timeout of its own: this phase only sends. The guest has
 * already proven it is alive and on the right build by getting through phase
 * A, and setup completes on send (see this module's doc comment).
 */
export function runHostSessionSetupPhaseB(
  channels: MultiplayerChannels,
  assignedId: PlayerId,
  options: HostSessionSetupOptions,
): Promise<void> {
  const channel = channels.reconciliation;

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
    displayNames: { ...options.displayNames },
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
  // cause of a real CI failure, not a theoretical concern).
  return sendJsonSequence(channel, [sessionInitMessage, ...chunkMessages, mapEndMessage]);
}
