// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The guest's half of a live multiplayer session — purely event-driven, no
 * worker, no `InputDelayBuffer` of its own (only the host ever finalizes a
 * bundle; a guest just applies whatever it's sent). Every incoming message
 * on `channels.input` is necessarily a `TickInputBundle` from the host (the
 * host never receives its own broadcast back, and nothing else rides this
 * channel). On each bundle: sample this peer's own input, tag it for a
 * future tick, send it back to the host (self-pacing off bundle arrival —
 * naturally throttle-resistant per the netcode spec, no separate timer
 * needed guest-side), then apply the bundle via `engine.advance(FIXED_DT)` —
 * the identical call the host makes from its own tick-due handler.
 *
 * A guest only ever holds one link — toward the host (star topology, see
 * `multiplayerSessionHost.ts`'s own doc comment on why the host is the one
 * side that needed a `links` map for step 10's N-player support). Every
 * *other* roster member (the host, plus 0-2 other guests once step 10
 * ships), this peer only ever hears about indirectly, via the host's own
 * broadcast bundle — `otherInputs` below is a local `Map` feeding the shared
 * simulation, not a second network connection.
 *
 * Level transitions (`multiplayer-research.md` step 8): this peer's own
 * simulation reaches a win at the exact same tick the host's does (lockstep)
 * — but only the host is authoritative for what happens next, so a local win
 * does nothing here beyond what `sessionEngine.ts`'s own `onWin` doc comment
 * already covers (the sim keeps running, never auto-ends). The real
 * transition is entirely wire-driven: a `LevelTransitionMessage` sequence
 * arrives on `channels.reconciliation` (the same channel
 * `ReconciliationSnapshotMessage`s already use, now discriminated by
 * `type`), reassembled via `ChunkReassembler` the same way the initial
 * session-setup handshake reassembles its own `GameMap` transfer; once
 * complete, this peer acks and calls the same rebindable `startLevel()` the
 * host itself uses.
 */
import { onJsonMessage, sendJson } from "./dataChannelMessaging";
import { ChunkReassembler } from "./chunkedTransfer";
import type { EngineCarryover, EngineStats, PlayerId, RosterSnapshotEntry } from "../engine/engine";
import type { ConnectionStateSource, MultiplayerSessionHandle } from "./multiplayerSessionHost";
import { DISCONNECT_GRACE_MS, FIXED_DT, INPUT_DELAY_TICKS } from "./netcodeConstants";
import type { LevelTransitionAckMessage, LevelTransitionMessage } from "./levelTransitionTypes";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine, type SessionEndReason, type SessionEngineHandle } from "./sessionEngine";
import type { SessionSetupResult } from "./sessionSetupTypes";
import type { GameMap } from "../map/types";
import type { MultiplayerChannels } from "./types";

export function runMultiplayerSessionAsGuest(
  channels: MultiplayerChannels,
  canvas: HTMLCanvasElement,
  result: SessionSetupResult,
  /** Fired once the shared simulation reaches game-over, or (guest-side
   * only) the host's own connection expires its grace period, after this
   * module's own teardown (listener unsubscribe) has already run —
   * `main.ts`'s hook for updating its own UI back out of the session.
   * `comparison` is `engine.rosterSnapshot()` at the moment of ending — see
   * `SessionEngineOptions.onSessionEnded`'s own doc comment. For the
   * host-disconnect path this is this peer's own local state, same
   * provisional caveat as `stats` there. */
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason, comparison: ReadonlyMap<PlayerId, RosterSnapshotEntry>) => void,
  /** The guest's own `RTCPeerConnection` toward the host — same injection
   * spirit as `runMultiplayerSessionAsHost`'s own per-guest links (see
   * `ConnectionStateSource`'s doc comment). Monitored here for the reverse
   * direction: the host going away, not a guest. */
  connection?: ConnectionStateSource,
): MultiplayerSessionHandle {
  let lastAppliedTick: number | null = null;
  let lastReconciliationRngState: number | null = null;
  let ended = false;
  let currentResult = result;
  // This peer's own roster id — fixed for the whole session (never
  // reassigned by a level transition, only `map`/`gameplaySeed` change).
  const myPlayerId = result.assignedId;

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
    if (!connection || ended || !engine) return;
    const state = connection.connectionState;
    if (state === "disconnected" || state === "failed") {
      if (graceTimer !== null) return; // already tracked
      graceTimer = setTimeout(() => {
        graceTimer = null;
        const stats = engine!.render();
        const comparison = engine!.rosterSnapshot();
        teardown();
        onSessionEnded?.(stats, "host-disconnected", comparison);
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

  // Assigned synchronously by `startLevel(currentResult)` a few lines below,
  // before anything else can read them — see the identical `hasStarted`
  // pattern in `multiplayerSessionHost.ts`'s own `startLevel()`.
  let engine: SessionEngineHandle["engine"] | undefined;
  let myInput: SessionEngineHandle["myInput"] | undefined;
  let otherInputs: SessionEngineHandle["otherInputs"] | undefined;
  let localSampler: SessionEngineHandle["localSampler"] | undefined;
  let hasStarted = false;

  // In-flight level-transition reassembly (§7) — `null` outside of one,
  // mirroring `sessionSetupGuest.ts`'s own `reassembler`/`pending` split for
  // its identical chunked-transfer shape. At most one transition is ever in
  // flight at a time (the host only starts a new one after the previous
  // fully resolves), so this needs no per-transition bookkeeping.
  let transitionReassembler: ChunkReassembler | null = null;
  let transitionCarryovers: Record<PlayerId, EngineCarryover> | null = null;
  let transitionGameplaySeed: number | null = null;

  const startLevel = (levelResult: SessionSetupResult, carryovers?: Record<PlayerId, EngineCarryover>): void => {
    if (hasStarted) localSampler?.detach();
    hasStarted = true;
    const built = buildSessionEngine({
      result: levelResult,
      canvas,
      carryovers,
      onSessionEnded: (stats, reason, comparison) => {
        teardown();
        onSessionEnded?.(stats, reason, comparison);
      },
      // A local win here does nothing beyond keeping the fallback
      // "campaign-complete" auto-end from firing — only the host decides
      // whether a transition happens; this peer just waits for the wire
      // message sequence handled below.
      onWin: () => {},
    });
    engine = built.engine;
    myInput = built.myInput;
    otherInputs = built.otherInputs;
    localSampler = built.localSampler;
  };
  startLevel(currentResult);

  // No re-entrancy guard needed here, unlike the host's own worker.onmessage
  // handler: `teardown()` unsubscribes this exact listener synchronously, on
  // this same main thread, before any further bundle could be dispatched to
  // it — there's no cross-thread gap (like the host's Worker, which can have
  // already-posted "tick" messages sitting in the main thread's task queue
  // by the time `terminate()` runs) for a stray already-queued message to
  // slip through after teardown.
  const unsubscribeInput = onJsonMessage<TickInputBundle>(channels.input, (bundle) => {
    // Unreachable: `engine`/`myInput`/`otherInputs`/`localSampler` are always
    // assigned synchronously by `startLevel(currentResult)` above, before
    // this listener could ever be invoked — the same "TypeScript's
    // conservative optional typing vs. what production code actually
    // guarantees" shape `doc/dev/testing.md`'s own coverage-caveats section
    // documents elsewhere in this codebase.
    /* v8 ignore next */
    if (!engine || !myInput || !otherInputs || !localSampler) return;
    const futureTick = bundle.tick + INPUT_DELAY_TICKS;
    const { snapshot: sampled, localEscapePressed } = localSampler.sampleAndReset();
    const outgoing: TickInput = { tick: futureTick, playerId: myPlayerId, input: sampled };
    // Same guard, same reasoning as the host's own mirror-image send in
    // `multiplayerSessionHost.ts` — an uncaught `RTCDataChannel.send()`
    // throw here (the transport gone before this peer's own
    // `connectionstatechange` even fires) would abort the rest of this
    // handler before `engine.advance()` ever runs, permanently stalling
    // this peer's own simulation. Skipping the send is harmless either way:
    // nothing is listening on a closed channel.
    if (channels.input.readyState === "open") sendJson(channels.input, outgoing);
    // Local-only, no shared-simulation channel to carry it — see
    // `dismissLoreOverlay()`'s own doc comment.
    if (localEscapePressed) engine.dismissLoreOverlay();

    myInput.loadFrame(bundle.inputs[myPlayerId]);
    for (const [id, input] of otherInputs) input.loadFrame(bundle.inputs[id]);
    // Applied before advance() — the same synchronized-lockstep-event
    // ordering the host itself uses (see its own worker.onmessage handler),
    // so every peer reaches the exact same tick's elimination check/loot-drop
    // state identically.
    if (bundle.rosterRemove) engine.applyRosterRemoval(bundle.rosterRemove);
    engine.advance(FIXED_DT);
    lastAppliedTick = bundle.tick;
  });

  // Independent of the input listener above — session setup's own listener
  // on this same channel has already unsubscribed by the time this module is
  // ever constructed (see `startMultiplayerSessionAsGuest` in `main.ts`), so
  // there's no risk of the two colliding. No re-entrancy guard needed, same
  // reasoning as `unsubscribeInput` above. Now discriminates by `type` —
  // this channel carries both `ReconciliationSnapshotMessage`s and, since
  // step 8, a `LevelTransitionMessage` sequence.
  const unsubscribeReconciliation = onJsonMessage<ReconciliationSnapshotMessage | LevelTransitionMessage>(
    channels.reconciliation,
    (message) => {
      // Same reasoning as `unsubscribeInput`'s own doc comment above.
      /* v8 ignore next */
      if (!engine) return;
      switch (message.type) {
        case "reconciliation-snapshot": {
          engine.applyReconciliationSnapshot(message);
          lastReconciliationRngState = message.rngState;
          return;
        }
        case "level-transition-init": {
          transitionReassembler = new ChunkReassembler();
          transitionCarryovers = message.carryovers;
          transitionGameplaySeed = message.gameplaySeed;
          return;
        }
        case "level-transition-map-chunk": {
          transitionReassembler?.push(message.data, message.index);
          return;
        }
        case "level-transition-map-end": {
          if (!transitionReassembler || transitionCarryovers === null || transitionGameplaySeed === null) return;
          if (!transitionReassembler.isComplete(message.totalChunks)) return;
          const mapWithoutVisited = transitionReassembler.finish<Omit<GameMap, "visited">>();
          // Reconstructed locally rather than transferred — see
          // `sessionSetupGuest.ts`'s identical reasoning for its own initial
          // map transfer.
          const visited: boolean[][] = Array.from({ length: mapWithoutVisited.height }, () =>
            new Array<boolean>(mapWithoutVisited.width).fill(false),
          );
          const carryovers = transitionCarryovers;
          const gameplaySeed = transitionGameplaySeed;
          transitionReassembler = null;
          transitionCarryovers = null;
          transitionGameplaySeed = null;

          const ack: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: myPlayerId };
          if (channels.reconciliation.readyState === "open") sendJson(channels.reconciliation, ack);

          currentResult = { ...currentResult, map: { ...mapWithoutVisited, visited }, gameplaySeed };
          startLevel(currentResult, carryovers);
          return;
        }
      }
    },
  );

  return {
    stop: teardown,
    getLastAppliedTick: () => lastAppliedTick,
    getPlayerPosition: (id) => engine?.getPlayerPosition(id) ?? null,
    getPlayerFacing: (id) => engine?.getPlayerFacing(id) ?? null,
    getRngState: () => engine!.getRngState(),
    hasActiveRenderOffset: (id) => engine!.hasActiveRenderOffset(id),
    getLastReconciliationRngState: () => lastReconciliationRngState,
    // `engine` is always defined by the time any of these handle methods
    // can be called — same reasoning as `unsubscribeInput`'s own doc comment
    // above; the `?? null`/`?? []` fallbacks are defensive-only.
    /* v8 ignore next */
    getPlayerStatus: (id) => engine?.getPlayerStatus(id) ?? null,
    /* v8 ignore next */
    getLootDrops: () => engine?.getLootDrops() ?? [],
    /* v8 ignore next */
    getMapExit: () => engine?.getMapExit() ?? null,
    /* v8 ignore next */
    getMapGrid: () => engine?.getMapGrid() ?? null,
    // See `multiplayerSessionHost.ts`'s identical getter for why this one
    // needs no ignore comment, unlike the getters above it.
    getExitCountdownRemaining: () => engine?.getExitCountdownRemaining() ?? null,
    /* v8 ignore next */
    getMap: () => engine?.getMap() ?? null,
    /* v8 ignore next */
    getEnemiesSnapshot: () => engine?.getEnemiesSnapshot() ?? [],
    /* v8 ignore next */
    getMinesSnapshot: () => engine?.getMinesSnapshot() ?? [],
    /* v8 ignore next */
    getDropsSnapshot: () => engine?.getDropsSnapshot() ?? [],
    /* v8 ignore next */
    getKeysSnapshot: () => engine?.getKeysSnapshot() ?? [],
    // See `multiplayerSessionHost.ts`'s identical getter for why this one
    // needs no ignore comment.
    getBotPlayerState: (id) => engine?.getBotPlayerState(id) ?? null,
    debugInjectDesync: (injection) => engine!.debugInjectDesync(injection),
  };
}
