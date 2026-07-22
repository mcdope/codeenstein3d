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
import { readConnectionStats } from "./connectionStats";
import type { ConnectionStateSource, MultiplayerSessionHandle } from "./multiplayerSessionHost";
import { DISCONNECT_GRACE_MS, FIXED_DT, INPUT_DELAY_TICKS } from "./netcodeConstants";
import type { LevelTransitionAckMessage, LevelTransitionMessage } from "./levelTransitionTypes";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine, type SessionEndReason, type SessionEngineHandle } from "./sessionEngine";
import { HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { GameMap } from "../map/types";
import type { MultiplayerChannels } from "./types";

/** Below this position-magnitude (in tiles), a reconciliation snapshot's
 * per-player delta isn't counted as a real "correction" by
 * `getReconciliationCorrections()` — ordinary cross-peer floating-point
 * drift (the same inputs, `Math.sin`/`cos`/`atan2` evaluated in a different
 * order across two engines) produces a nonzero delta on nearly every
 * broadcast even when nothing is actually wrong; counting all of those would
 * make the signal useless for spotting genuine desync. Deliberately much
 * smaller than `SNAP_THRESHOLD_TILES` (`reconciliationConstants.ts`, engine
 * layer) — that constant decides *how* a real correction is applied
 * (smoothed vs. instant snap), a different question from *whether* one
 * happened at all, which is all this tally needs to answer. A reasoned
 * starting point, not a validated value — real tuning needs actual
 * multi-peer network conditions, same caveat as every constant in
 * `netcodeConstants.ts`. */
const RECONCILIATION_CORRECTION_NOISE_FLOOR_TILES = 0.001;

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

  // Phase 2b tallies — both seeded once from the session's own fixed roster
  // (unchanged across a level transition), same reasoning
  // `multiplayerSessionHost.ts`'s own `missedTicksByPlayer` seeding gives.
  let totalTicks = 0;
  const missedTicksByPlayer = new Map<PlayerId, number>(result.roster.map((id) => [id, 0]));
  const reconciliationCorrections = new Map<PlayerId, { count: number; totalMagnitudeTiles: number }>(
    result.roster.map((id) => [id, { count: 0, totalMagnitudeTiles: 0 }]),
  );

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
    // Detached directly here, not left to `startLevel()`'s own `hasStarted`
    // guard (which only ever fires on a *later* `startLevel()` call) — the
    // "host-disconnected" ending never calls `startLevel()` again, so
    // without this the sampler's window/document/canvas listeners would
    // otherwise leak forever past session end.
    localSampler?.detach();
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

  // Purely local, never transmitted as its own message (see
  // `TickInputBundle.levelEpoch`'s own doc comment) — bumped alongside
  // `localSampler.detach()` below, on every `startLevel()` call *after* the
  // first, so it stays in lockstep with the host's own identical counter
  // (both sides call `startLevel()` exactly once per transition).
  let levelEpoch = 0;

  const startLevel = (levelResult: SessionSetupResult, carryovers?: Record<PlayerId, EngineCarryover>): void => {
    if (hasStarted) {
      localSampler?.detach();
      levelEpoch++;
      // A tick number from the level just left behind is meaningless once
      // the epoch changes — reset alongside it so a stale-epoch snapshot
      // can never coincidentally also pass a tick-based comparison against
      // this new level's own early ticks (belt-and-suspenders on top of the
      // `levelEpoch` guard itself, below).
      lastAppliedTick = null;
    }
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
    // `input`/`reconciliation` are two independent WebRTC data channels with
    // no cross-channel ordering guarantee — this peer can finish a
    // level-transition handshake (over `reconciliation`) and swap to a
    // brand-new engine, then still receive one or more already-in-flight
    // OLD-level `TickInputBundle`s on `input` afterward. Discarded outright
    // rather than sampled/replied-to/`advance()`-d against the wrong engine
    // (see `TickInputBundle.levelEpoch`'s own doc comment).
    if (bundle.levelEpoch !== levelEpoch) {
      console.log(`[multiplayer] discarding stale tick-input bundle for level epoch ${bundle.levelEpoch}, currently on epoch ${levelEpoch}`);
      return;
    }
    totalTicks++;
    // `missedTicksByPlayer` is seeded from the full, fixed roster above, and
    // `heldInputFallback` only ever contains roster ids (`InputDelayBuffer.
    // finalize()`'s own `rosterIds` param) — `.get(id)` is always defined.
    for (const id of bundle.heldInputFallback) {
      missedTicksByPlayer.set(id, missedTicksByPlayer.get(id)! + 1);
    }
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
          // A snapshot stamped for a level this peer has already transitioned
          // away from must never be applied — the host's tick worker keeps
          // ticking (and broadcasting snapshots for) the *old* level
          // throughout a transition's ack-wait window, and the tick counter
          // itself never resets across levels, so an old-level snapshot can
          // easily carry a tick number this peer's new-level `lastAppliedTick`
          // would otherwise consider "current" or even "future". See
          // `ReconciliationSnapshotMessage.levelEpoch`'s own doc comment.
          if (message.levelEpoch !== levelEpoch) {
            console.log(`[multiplayer] discarding stale reconciliation snapshot for level epoch ${message.levelEpoch}, currently on epoch ${levelEpoch}`);
            return;
          }
          // `input`/`reconciliation` are two independent WebRTC data
          // channels with no cross-channel ordering guarantee — a
          // reconciliation snapshot delayed behind a burst of tick-input
          // bundles can arrive stamped for a tick this peer has already
          // advanced past. Applying it anyway would rewind both gameplay
          // state AND the shared PRNG stream (`applyReconciliationSnapshot`'s
          // own `rngState`) backward, causing a NEW desync one reconcile
          // interval later. The mirror-image case — a snapshot stamped for a
          // tick still ahead of `lastAppliedTick` — is just as unsafe to
          // apply: it would snap this peer to host state at that tick, after
          // which the still-in-flight `TickInputBundle`s for the ticks in
          // between arrive and get applied on top, double-simulating (and
          // double-advancing the shared PRNG) past the host. Both directions
          // are discarded outright rather than applied and never counted as
          // a correction (it was never actually applied) — safe either way,
          // since the next `RECONCILE_INTERVAL_TICKS` snapshot corrects any
          // real drift a discarded snapshot would have caught.
          if (lastAppliedTick !== null && message.tick !== lastAppliedTick) {
            console.log(`[multiplayer] discarding out-of-order reconciliation snapshot for tick ${message.tick}, already applied through tick ${lastAppliedTick}`);
            return;
          }
          // Read *before* applying — `applyReconciliationSnapshot()` snaps
          // simulation state (and the render offset it derives from the
          // same before/after gap) in one pass, so this is the only chance
          // to see what this peer's own simulation believed beforehand.
          for (const [id, ps] of Object.entries(message.players)) {
            const before = engine.getPlayerPosition(id);
            // An id the snapshot mentions that this peer never added —
            // shouldn't happen, roster is agreed at session setup, same
            // "skip rather than throw" shape `applyReconciliationSnapshot`'s
            // own identical check documents (`engine.ts`).
            /* v8 ignore next */
            if (!before) continue;
            const magnitude = Math.hypot(ps.posX - before.x, ps.posY - before.y);
            if (magnitude <= RECONCILIATION_CORRECTION_NOISE_FLOOR_TILES) continue;
            // Seeded from the full, fixed roster above — `message.players`
            // (which `id` is drawn from) is only ever the same roster, per
            // the `!before` skip just above — `.get(id)` is always defined.
            const entry = reconciliationCorrections.get(id)!;
            entry.count += 1;
            entry.totalMagnitudeTiles += magnitude;
          }
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
        case "campaign-complete": {
          // The host's own `stats`/`comparison` reflect its perspective —
          // this peer's `stats` (health/ammo/keys) is genuinely local
          // gameplay state, so it's read from this engine's own `render()`,
          // not carried over the wire (see
          // `LevelTransitionCampaignCompleteMessage`'s own doc comment).
          // `comparison` IS shared, host-authoritative state, so it does
          // travel — reconstructed here as the same `ReadonlyMap` shape
          // `onSessionEnded` expects everywhere else.
          const stats = engine.render();
          const comparison = new Map(Object.entries(message.comparison));
          teardown();
          onSessionEnded?.(stats, "campaign-complete", comparison);
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
    debugSetGodMode: (playerId, enabled) => engine!.debugSetGodMode(playerId, enabled),
    // Only ever has one link, toward the host — see this method's own doc
    // comment on `MultiplayerSessionHandle`.
    getConnectionStats: (id) => (connection && id === HOST_PLAYER_ID ? readConnectionStats(connection) : Promise.resolve(null)),
    getMissedTickStats: () => ({
      totalTicks,
      missedTicksByPlayer: Object.fromEntries(missedTicksByPlayer) as Record<PlayerId, number>,
    }),
    getReconciliationCorrections: () => Object.fromEntries(reconciliationCorrections) as Record<PlayerId, { count: number; totalMagnitudeTiles: number }>,
    /* v8 ignore next */
    getMultiplayerTelemetrySnapshot: (id) => engine?.getMultiplayerTelemetrySnapshot(id) ?? null,
  };
}
