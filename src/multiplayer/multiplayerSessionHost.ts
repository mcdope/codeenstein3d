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
import type { EngineStats, PlayerId, PlayerStatus } from "../engine/engine";
import type { LootDrop } from "../map/types";
import { sendJson, onJsonMessage } from "./dataChannelMessaging";
import { InputDelayBuffer } from "./inputDelayBuffer";
import { DISCONNECT_GRACE_MS, FIXED_DT, INPUT_DELAY_TICKS, RECONCILE_INTERVAL_TICKS } from "./netcodeConstants";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine, type SessionEndReason } from "./sessionEngine";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { TickDueMessage } from "./tickClockWorker";
import type { MultiplayerChannels } from "./types";

export interface TickWorkerHandle {
  onmessage: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

/** The narrow slice of `RTCPeerConnection` disconnect detection needs — typed
 * against just the two members this module actually uses (mirrors
 * `TickWorkerHandle`'s own injection style above), so a small fake keeps this
 * module unit-testable without a real `RTCPeerConnection` (this project's
 * test environment has none). `main.ts` passes the real
 * `activeMultiplayerConnection.peerConnection` for production use. */
export interface ConnectionStateSource {
  readonly connectionState: RTCPeerConnectionState;
  addEventListener(type: "connectionstatechange", listener: () => void): void;
  removeEventListener(type: "connectionstatechange", listener: () => void): void;
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
  /** Read-only — see `RaycasterEngine.getPlayerStatus`'s doc comment. */
  getPlayerStatus(id: PlayerId): PlayerStatus | null;
  /** Read-only — see `RaycasterEngine.getLootDrops`'s doc comment. */
  getLootDrops(): readonly LootDrop[];
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
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason) => void,
  /** The host's own `RTCPeerConnection` toward the guest — omitted by every
   * existing unit test (disconnect detection simply never triggers without
   * it), real production callers (`main.ts`) always pass one. */
  connection?: ConnectionStateSource,
): MultiplayerSessionHandle {
  const inputDelayBuffer = new InputDelayBuffer();
  let lastAppliedTick: number | null = null;
  let lastReconciliationRngState: number | null = null;
  let ended = false;

  // Disconnect handling (§5): the host only ever monitors its own connection
  // toward the guest — there's exactly one `RTCPeerConnection` in a 2-player
  // session, so there's nothing to distinguish by id here (unlike a future
  // N-player roster). `neutralInputIds` covers both "currently inside its
  // grace window" and "grace expired, now genuinely removed" — once a player
  // enters either state, `InputDelayBuffer` must feed it the neutral idle
  // snapshot forever, not just for the bounded grace window (see
  // `InputDelayBuffer.finalize`'s own doc comment).
  const neutralInputIds = new Set<PlayerId>();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let rosterRemovalToApply: PlayerId | null = null;

  const onConnectionStateChange = (): void => {
    // Genuinely unreachable without `connection`: this listener is only ever
    // registered when `connection` is defined (see the `addEventListener`
    // call right below this closure), so it's the only thing that can invoke
    // it.
    /* v8 ignore next */
    if (!connection) return;
    const state = connection.connectionState;
    if (state === "disconnected" || state === "failed") {
      if (graceTimer !== null || neutralInputIds.has(GUEST_PLAYER_ID)) return; // already tracked
      neutralInputIds.add(GUEST_PLAYER_ID);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        rosterRemovalToApply = GUEST_PLAYER_ID;
      }, DISCONNECT_GRACE_MS);
    } else if (state === "connected" && graceTimer !== null) {
      // Recovered before grace expired — once expired (graceTimer already
      // null), reconnection is out of scope (no v1 host migration/rejoin
      // per the spec) and this branch no longer applies.
      clearTimeout(graceTimer);
      graceTimer = null;
      neutralInputIds.delete(GUEST_PLAYER_ID);
    }
  };
  connection?.addEventListener("connectionstatechange", onConnectionStateChange);

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    worker.terminate();
    unsubscribeInput();
    connection?.removeEventListener("connectionstatechange", onConnectionStateChange);
    if (graceTimer !== null) clearTimeout(graceTimer);
  };

  const { engine, myInput, otherInput, localSampler } = buildSessionEngine({
    result,
    role: "host",
    canvas,
    onSessionEnded: (stats, reason) => {
      teardown();
      onSessionEnded?.(stats, reason);
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
    const { snapshot: sampled, localEscapePressed } = localSampler.sampleAndReset();
    inputDelayBuffer.record(futureTick, HOST_PLAYER_ID, sampled);
    // Local-only, no shared-simulation channel to carry it — see
    // `dismissLoreOverlay()`'s own doc comment.
    if (localEscapePressed) engine.dismissLoreOverlay();

    // Finalize and broadcast the tick that's actually due now.
    const bundle: TickInputBundle = inputDelayBuffer.finalize(
      tick,
      result.roster,
      FIXED_DT,
      neutralInputIds.size > 0 ? neutralInputIds : undefined,
    );

    // A grace timer that expired since the last tick is applied on this
    // tick, synchronously with the broadcast — every peer (host included)
    // applies the same `rosterRemove` from this exact bundle, the same
    // synchronized-lockstep-event shape `applyRosterRemoval` itself expects.
    if (rosterRemovalToApply) {
      const id = rosterRemovalToApply;
      rosterRemovalToApply = null;
      engine.applyRosterRemoval([id]);
      bundle.rosterRemove = [id];
    }

    // `RTCDataChannel.send()` throws synchronously once `readyState` isn't
    // `"open"` — a guest whose transport is already gone (channel closed
    // before this peer's own `connectionstatechange` even fires; disconnect
    // detection above is best-effort and inherently lags the real transport)
    // must never crash this handler on that throw: an uncaught exception
    // here would abort *this whole tick* before `engine.advance()` ever
    // runs, permanently stalling the host's own simulation the instant the
    // guest's channel closes — exactly the "never stall waiting on a peer
    // that's gone" guarantee this step exists to provide. Skipping the send
    // is harmless either way: nothing is listening on a closed channel.
    if (channels.input.readyState === "open") sendJson(channels.input, bundle);

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
      // Same reasoning as `channels.input` above.
      if (channels.reconciliation.readyState === "open") sendJson(channels.reconciliation, snapshot);
    }
  };

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
