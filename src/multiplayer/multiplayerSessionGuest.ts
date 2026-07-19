// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The guest's half of a live multiplayer session — purely event-driven, no
 * worker, no `InputDelayBuffer` of its own (only the host ever finalizes a
 * bundle; the guest just applies whatever it's sent). Every incoming message
 * on `channels.input` is necessarily a `TickInputBundle` from the host (the
 * host never receives its own broadcast back, and nothing else rides this
 * channel). On each bundle: sample this peer's own input, tag it for a
 * future tick, send it back to the host (self-pacing off bundle arrival —
 * naturally throttle-resistant per the netcode spec, no separate timer
 * needed guest-side), then apply the bundle via `engine.advance(FIXED_DT)` —
 * the identical call the host makes from its own tick-due handler.
 */
import type { EngineStats } from "../engine/engine";
import { onJsonMessage, sendJson } from "./dataChannelMessaging";
import type { MultiplayerSessionHandle } from "./multiplayerSessionHost";
import { FIXED_DT, INPUT_DELAY_TICKS } from "./netcodeConstants";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import { buildSessionEngine } from "./sessionEngine";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

export function runMultiplayerSessionAsGuest(
  channels: MultiplayerChannels,
  canvas: HTMLCanvasElement,
  result: SessionSetupResult,
  /** Fired once the shared simulation reaches game-over/win, after this
   * module's own teardown (listener unsubscribe) has already run —
   * `main.ts`'s hook for updating its own UI back out of the session. */
  onSessionEnded?: (stats: EngineStats) => void,
): MultiplayerSessionHandle {
  let lastAppliedTick: number | null = null;
  let ended = false;

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    unsubscribeInput();
  };

  const { engine, myInput, otherInput, localSampler } = buildSessionEngine({
    result,
    role: "guest",
    canvas,
    onSessionEnded: (stats) => {
      teardown();
      onSessionEnded?.(stats);
    },
  });

  // No re-entrancy guard needed here, unlike the host's own worker.onmessage
  // handler: `teardown()` unsubscribes this exact listener synchronously, on
  // this same main thread, before any further bundle could be dispatched to
  // it — there's no cross-thread gap (like the host's Worker, which can have
  // already-posted "tick" messages sitting in the main thread's task queue
  // by the time `terminate()` runs) for a stray already-queued message to
  // slip through after teardown.
  const unsubscribeInput = onJsonMessage<TickInputBundle>(channels.input, (bundle) => {
    const futureTick = bundle.tick + INPUT_DELAY_TICKS;
    const sampled = localSampler.sampleAndReset();
    const outgoing: TickInput = { tick: futureTick, playerId: GUEST_PLAYER_ID, input: sampled };
    sendJson(channels.input, outgoing);

    myInput.loadFrame(bundle.inputs[GUEST_PLAYER_ID]);
    otherInput.loadFrame(bundle.inputs[HOST_PLAYER_ID]);
    engine.advance(FIXED_DT);
    lastAppliedTick = bundle.tick;
  });

  return {
    stop: teardown,
    getLastAppliedTick: () => lastAppliedTick,
    getPlayerPosition: (id) => engine.getPlayerPosition(id),
  };
}
