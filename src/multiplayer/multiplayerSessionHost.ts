// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The host's half of a live multiplayer session — the sequencer (see
 * `doc/dev/multiplayer-netcode-spec.md`'s "Message flow per tick"): its own
 * `TickAccumulator`-driven Web Worker paces every tick, an `InputDelayBuffer`
 * finalizes one canonical `TickInputBundle` per due tick from whatever's
 * arrived, broadcasts it to the guest, and applies it locally via
 * `engine.advance(FIXED_DT)` — the same call the guest makes from its own
 * bundle-arrival handler, so both peers' simulations advance identically.
 *
 * `worker` is caller-injected (typed against just the two members this
 * module actually uses, not the full DOM `Worker` shape) rather than
 * constructed internally — this project's test environment has no real
 * `Worker` global, so injection is what keeps this module unit-testable with
 * a small fake, the same spirit as `test/mocks/webrtc.ts`'s fake data
 * channels. `main.ts` constructs the real one.
 */
import type { EngineStats, PlayerId } from "../engine/engine";
import { sendJson, onJsonMessage } from "./dataChannelMessaging";
import { InputDelayBuffer } from "./inputDelayBuffer";
import { FIXED_DT, INPUT_DELAY_TICKS, RECONCILE_INTERVAL_TICKS } from "./netcodeConstants";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine } from "./sessionEngine";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { TickDueMessage } from "./tickClockWorker";
import type { MultiplayerChannels } from "./types";

export interface TickWorkerHandle {
  onmessage: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

export interface MultiplayerSessionHandle {
  stop(): void;
  getLastAppliedTick(): number | null;
  getPlayerPosition(id: PlayerId): { x: number; y: number } | null;
  /** Read-only PRNG-stream introspection — see `RaycasterEngine.getRngState`'s
   * doc comment. */
  getRngState(): number;
  /** Read-only — see `RaycasterEngine.hasActiveRenderOffset`'s doc comment. */
  hasActiveRenderOffset(id: PlayerId): boolean;
  /** The `rngState` this peer's own most recently sent (host) or applied
   * (guest) `ReconciliationSnapshot` carried, or `null` before the first one.
   * Deliberately a *frozen*, already-happened value rather than each peer's
   * current live `getRngState()` — comparing two peers' *live* PRNG state
   * across real process/page boundaries is inherently racy for a value that
   * changes every tick (real, active roaming-enemy AI draws from the same
   * stream continuously, so a fresh, genuine desync can reappear within a
   * single tick of a correction landing — confirmed in practice on WebKit
   * by `scripts/verify-multiplayer-reconciliation.mjs`). Comparing what was
   * actually transmitted/applied is stable regardless of what's happened to
   * live state since. */
  getLastReconciliationRngState(): number | null;
  /** Test-only, mutating — see `RaycasterEngine.debugInjectDesync`'s doc
   * comment. */
  debugInjectDesync(injection: { kind: "position"; deltaTiles: number } | { kind: "extraRngDraw" }): void;
}

export function runMultiplayerSessionAsHost(
  channels: MultiplayerChannels,
  canvas: HTMLCanvasElement,
  result: SessionSetupResult,
  worker: TickWorkerHandle,
  /** Fired once the shared simulation reaches game-over/win, after this
   * module's own teardown (worker/listener) has already run — `main.ts`'s
   * hook for updating its own UI back out of the session. */
  onSessionEnded?: (stats: EngineStats) => void,
): MultiplayerSessionHandle {
  const inputDelayBuffer = new InputDelayBuffer();
  let lastAppliedTick: number | null = null;
  let lastReconciliationRngState: number | null = null;
  let ended = false;

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    worker.terminate();
    unsubscribeInput();
  };

  const { engine, myInput, otherInput, localSampler } = buildSessionEngine({
    result,
    role: "host",
    canvas,
    onSessionEnded: (stats) => {
      teardown();
      onSessionEnded?.(stats);
    },
  });

  // Every incoming message on `channels.input` is necessarily a `TickInput`
  // from the guest — the guest never broadcasts a `TickInputBundle` (only
  // the host does), and `input` carries nothing else (session setup rides
  // `reconciliation` instead).
  const unsubscribeInput = onJsonMessage<TickInput>(channels.input, (message) => {
    inputDelayBuffer.record(message.tick, message.playerId, message.input);
  });

  worker.onmessage = (event) => {
    // Guards against TickAccumulator.advance() having posted several due
    // ticks in one worker turn (after a stall) — if game-over already fired
    // and tore this session down mid-batch, every further already-queued
    // "tick" message must be a no-op, not re-run teardown or advance a
    // stopped engine.
    if (ended) return;

    const { tick } = event.data as TickDueMessage;

    // Sample + delay-buffer this host's own input for a future tick —
    // delayed the exact same way a guest's input is, so the host gets no
    // built-in latency advantage (multiplayer-netcode-spec.md §2). Recorded
    // locally only, never sent over `channels.input`: the guest's own
    // listener there only ever expects a `TickInputBundle` (see this
    // module's own incoming-message comment above) — broadcasting a bare
    // `TickInput` alongside it corrupted every guest-side `bundle.inputs[...]`
    // read the moment it arrived (`bundle.inputs` is undefined on a
    // `TickInput`). It'll reach the guest properly shaped, inside the
    // broadcast bundle below, once this same tick is finalized. Missed by
    // every mocked-channel unit test (each tests host/guest in isolation
    // against hand-crafted messages, never a real paired host+guest talking
    // to each other) — caught by `scripts/verify-multiplayer-netcode.mjs`'s
    // real end-to-end run instead.
    const futureTick = tick + INPUT_DELAY_TICKS;
    const sampled = localSampler.sampleAndReset();
    inputDelayBuffer.record(futureTick, HOST_PLAYER_ID, sampled);

    // Finalize and broadcast the tick that's actually due now.
    const bundle: TickInputBundle = inputDelayBuffer.finalize(tick, result.roster, FIXED_DT);
    sendJson(channels.input, bundle);

    myInput.loadFrame(bundle.inputs[HOST_PLAYER_ID]);
    otherInput.loadFrame(bundle.inputs[GUEST_PLAYER_ID]);
    engine.advance(FIXED_DT);
    lastAppliedTick = tick;

    // Periodic authoritative state reconciliation — the host is the only
    // source of truth, so it never applies its own broadcast back onto
    // itself (`multiplayer-netcode-spec.md` §3). Rides `channels.reconciliation`,
    // idle since session setup's own listener unsubscribed.
    if (tick % RECONCILE_INTERVAL_TICKS === 0) {
      const snapshot: ReconciliationSnapshotMessage = { type: "reconciliation-snapshot", ...engine.captureReconciliationSnapshot(tick) };
      lastReconciliationRngState = snapshot.rngState;
      sendJson(channels.reconciliation, snapshot);
    }
  };

  return {
    stop: teardown,
    getLastAppliedTick: () => lastAppliedTick,
    getPlayerPosition: (id) => engine.getPlayerPosition(id),
    getRngState: () => engine.getRngState(),
    hasActiveRenderOffset: (id) => engine.hasActiveRenderOffset(id),
    getLastReconciliationRngState: () => lastReconciliationRngState,
    debugInjectDesync: (injection) => engine.debugInjectDesync(injection),
  };
}
