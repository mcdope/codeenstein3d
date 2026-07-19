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
import type { ConnectionStateSource, MultiplayerSessionHandle } from "./multiplayerSessionHost";
import { DISCONNECT_GRACE_MS, FIXED_DT, INPUT_DELAY_TICKS } from "./netcodeConstants";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine, type SessionEndReason } from "./sessionEngine";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

export function runMultiplayerSessionAsGuest(
  channels: MultiplayerChannels,
  canvas: HTMLCanvasElement,
  result: SessionSetupResult,
  /** Fired once the shared simulation reaches game-over/win, after this
   * module's own teardown (listener unsubscribe) has already run —
   * `main.ts`'s hook for updating its own UI back out of the session. */
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason) => void,
  /** The guest's own `RTCPeerConnection` toward the host — same injection
   * spirit as `runMultiplayerSessionAsHost`'s own `connection` param (see
   * `ConnectionStateSource`'s doc comment). Monitored here for the reverse
   * direction: the host going away, not the guest. */
  connection?: ConnectionStateSource,
): MultiplayerSessionHandle {
  let lastAppliedTick: number | null = null;
  let lastReconciliationRngState: number | null = null;
  let ended = false;

  // Host-disconnect handling (§5, guest side): unlike the host, there's no
  // roster-removal/loot-conversion machinery to run here — a bundle simply
  // stops arriving (nothing to fabricate), so this is purely a grace timer
  // that, on expiry, ends the session locally with a provisional view (this
  // peer's own last-rendered `EngineStats`, not a host-authoritative one —
  // there's no final snapshot coming from a host that's gone).
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const onConnectionStateChange = (): void => {
    // Genuinely unreachable: this listener is only ever registered when
    // `connection` is defined (see the `addEventListener` call right below
    // this closure), and `teardown()` always removes it synchronously, in
    // the same breath it sets `ended` — there's no async gap for a stray
    // event to slip through afterward (same reasoning `unsubscribeInput`'s
    // own doc comment gives for why *it* needs no re-entrancy guard).
    /* v8 ignore next */
    if (!connection || ended) return;
    const state = connection.connectionState;
    if (state === "disconnected" || state === "failed") {
      if (graceTimer !== null) return; // already tracked
      graceTimer = setTimeout(() => {
        graceTimer = null;
        const stats = engine.render();
        teardown();
        onSessionEnded?.(stats, "host-disconnected");
      }, DISCONNECT_GRACE_MS);
    } else if (state === "connected" && graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
  connection?.addEventListener("connectionstatechange", onConnectionStateChange);

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    unsubscribeInput();
    unsubscribeReconciliation();
    connection?.removeEventListener("connectionstatechange", onConnectionStateChange);
    if (graceTimer !== null) clearTimeout(graceTimer);
  };

  const { engine, myInput, otherInput, localSampler } = buildSessionEngine({
    result,
    role: "guest",
    canvas,
    onSessionEnded: (stats, reason) => {
      teardown();
      onSessionEnded?.(stats, reason);
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
    const { snapshot: sampled, localEscapePressed } = localSampler.sampleAndReset();
    const outgoing: TickInput = { tick: futureTick, playerId: GUEST_PLAYER_ID, input: sampled };
    sendJson(channels.input, outgoing);
    // Local-only, no shared-simulation channel to carry it — see
    // `dismissLoreOverlay()`'s own doc comment.
    if (localEscapePressed) engine.dismissLoreOverlay();

    myInput.loadFrame(bundle.inputs[GUEST_PLAYER_ID]);
    otherInput.loadFrame(bundle.inputs[HOST_PLAYER_ID]);
    // Applied before advance() — the same synchronized-lockstep-event
    // ordering the host itself uses (see its own worker.onmessage handler),
    // so both peers reach the exact same tick's elimination check/loot-drop
    // state identically.
    if (bundle.rosterRemove) engine.applyRosterRemoval(bundle.rosterRemove);
    engine.advance(FIXED_DT);
    lastAppliedTick = bundle.tick;
  });

  // Independent of the input listener above — session setup's own listener
  // on this same channel has already unsubscribed by the time this module is
  // ever constructed (see `startMultiplayerSessionAsGuest` in `main.ts`), so
  // there's no risk of the two colliding. No re-entrancy guard needed, same
  // reasoning as `unsubscribeInput` above.
  const unsubscribeReconciliation = onJsonMessage<ReconciliationSnapshotMessage>(channels.reconciliation, (snapshot) => {
    engine.applyReconciliationSnapshot(snapshot);
    lastReconciliationRngState = snapshot.rngState;
  });

  return {
    stop: teardown,
    getLastAppliedTick: () => lastAppliedTick,
    getPlayerPosition: (id) => engine.getPlayerPosition(id),
    getRngState: () => engine.getRngState(),
    hasActiveRenderOffset: (id) => engine.hasActiveRenderOffset(id),
    getLastReconciliationRngState: () => lastReconciliationRngState,
    getPlayerStatus: (id) => engine.getPlayerStatus(id),
    getLootDrops: () => engine.getLootDrops(),
    debugInjectDesync: (injection) => engine.debugInjectDesync(injection),
  };
}
