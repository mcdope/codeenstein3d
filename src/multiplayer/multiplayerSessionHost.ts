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
 *
 * Level transitions (`multiplayer-research.md` step 8): the engine
 * construction closure is rebindable (`startLevel()`), called both for the
 * initial level and every later transition — `worker`/`channels`/
 * `inputDelayBuffer` all stay alive across a swap, only the level-scoped
 * `engine`/`myInput`/`otherInput`/`localSampler` get replaced. A win no
 * longer ends the session directly (see `sessionEngine.ts`'s own `onWin`
 * doc comment) — it captures every connected player's own carryover, asks
 * the injected `findNextLevel` for the next level's content, and either
 * broadcasts a chunked `LevelTransitionMessage` sequence and calls
 * `startLevel()` again once every guest has acked (or
 * `TRANSITION_ACK_TIMEOUT_MS` elapses — a guest that never acks falls into
 * the disconnect path via the same connection-state signal, not a special
 * case here), or, once genuinely out of content, ends the session with
 * reason `"campaign-complete"`.
 */
import {
  REVIVE_HEALTH,
  type EngineCarryover,
  type EngineStats,
  type PlayerId,
  type PlayerStatus,
  type RosterSnapshotEntry,
} from "../engine/engine";
import type { GameMap, LootDrop, Point, Tile } from "../map/types";
import { chunkJson } from "./chunkedTransfer";
import { sendJson, sendJsonSequence, onJsonMessage } from "./dataChannelMessaging";
import { InputDelayBuffer } from "./inputDelayBuffer";
import {
  DISCONNECT_GRACE_MS,
  FIXED_DT,
  INPUT_DELAY_TICKS,
  MAP_CHUNK_SIZE_BYTES,
  RECONCILE_INTERVAL_TICKS,
  TRANSITION_ACK_TIMEOUT_MS,
} from "./netcodeConstants";
import type {
  LevelTransitionAckMessage,
  LevelTransitionInitMessage,
  LevelTransitionMapChunkMessage,
  LevelTransitionMapEndMessage,
} from "./levelTransitionTypes";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { buildSessionEngine, type SessionEndReason, type SessionEngineHandle } from "./sessionEngine";
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
  /** Read-only — see `RaycasterEngine.getPlayerFacing`'s doc comment. */
  getPlayerFacing(id: PlayerId): { dirX: number; dirY: number } | null;
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
  /** Read-only — see `RaycasterEngine.getMapExit`'s doc comment. `null`
   * before any level has started. */
  getMapExit(): Point | null;
  /** Read-only — see `RaycasterEngine.getMapGrid`'s doc comment. `null`
   * before any level has started. */
  getMapGrid(): readonly (readonly Tile[])[] | null;
  /** Read-only — see `RaycasterEngine.getExitCountdownRemaining`'s doc
   * comment. `null` before any level has started, same as the map getters
   * above (as well as whenever no countdown is currently running). */
  getExitCountdownRemaining(): number | null;
  /** Read-only — see `RaycasterEngine.getMap`'s doc comment. `null` before
   * any level has started. */
  getMap(): GameMap | null;
  /** Read-only — see `RaycasterEngine.getEnemiesSnapshot`'s doc comment.
   * `[]` before any level has started (same "nothing to report yet" shape
   * as `getLootDrops`, not `null`). */
  getEnemiesSnapshot(): { x: number; y: number; alive: boolean; aggroed: boolean; elite: boolean; edgeCase: boolean; hp: number; maxHp: number }[];
  /** Read-only — see `RaycasterEngine.getMinesSnapshot`'s doc comment. `[]`
   * before any level has started. */
  getMinesSnapshot(): { x: number; y: number; alive: boolean; visible: boolean }[];
  /** Read-only — see `RaycasterEngine.getDropsSnapshot`'s doc comment. `[]`
   * before any level has started. */
  getDropsSnapshot(): { x: number; y: number; kind: LootDrop["kind"] }[];
  /** Read-only — see `RaycasterEngine.getKeysSnapshot`'s doc comment. `[]`
   * before any level has started. */
  getKeysSnapshot(): { x: number; y: number }[];
  /** Read-only — see `RaycasterEngine.getBotPlayerState`'s doc comment.
   * `null` before any level has started, or if `id` isn't a connected
   * player. */
  getBotPlayerState(id: PlayerId): {
    x: number;
    y: number;
    dirX: number;
    dirY: number;
    health: number;
    healthFraction: number;
    swap: number;
    state: "playing" | "over";
    ammo: { bullets: number; rockets: number; smg: number; gas: number };
    weaponIndex: number;
    meleeWouldHit: boolean;
    wouldMineHit: boolean;
    ownedWeapons: number[];
    levelTime: number;
    distanceTraveled: number;
  } | null;
  /** Test-only, mutating — see `RaycasterEngine.debugInjectDesync`'s doc
   * comment. */
  debugInjectDesync(injection: { kind: "position"; deltaTiles: number } | { kind: "extraRngDraw" }): void;
}

/** What `findNextLevel` needs to decide the next level's content — every
 * connected player's own carryover, keyed by roster id, dead players
 * already revived at `REVIVE_HEALTH` (see `runMultiplayerSessionAsHost`'s
 * own doc comment on the level-transition flow). */
export interface HostTransitionContext {
  carryovers: Record<PlayerId, EngineCarryover>;
}

/** Resolves to the next level's content once this peer's own simulation
 * reaches a win, or `null` once the workspace is genuinely out of parsable
 * files (routes to a `"campaign-complete"` end instead of a phantom
 * transition). `main.ts` owns the real implementation (file-tree traversal,
 * parsing, `MapGenerator.generate()` — mirroring its own single-player
 * `advanceToNextLevel`); this module has no dependency on any of that, only
 * the injected callback — omitted by every existing unit test (a win simply
 * always reaches the `"campaign-complete"` fallback without it). */
export type FindNextLevel = (context: HostTransitionContext) => Promise<{ map: GameMap; gameplaySeed: number } | null>;

export function runMultiplayerSessionAsHost(
  channels: MultiplayerChannels,
  canvas: HTMLCanvasElement,
  result: SessionSetupResult,
  worker: TickWorkerHandle,
  /** Fired once the shared simulation reaches game-over, or a win with
   * nowhere left to transition to, after this module's own teardown
   * (worker/listeners) has already run — `main.ts`'s hook for updating its
   * own UI back out of the session. `comparison` is `engine.rosterSnapshot()`
   * at the moment of ending — see `SessionEngineOptions.onSessionEnded`'s own
   * doc comment. */
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason, comparison: ReadonlyMap<PlayerId, RosterSnapshotEntry>) => void,
  /** The host's own `RTCPeerConnection` toward the guest — omitted by every
   * existing unit test (disconnect detection simply never triggers without
   * it), real production callers (`main.ts`) always pass one. */
  connection?: ConnectionStateSource,
  findNextLevel?: FindNextLevel,
): MultiplayerSessionHandle {
  const inputDelayBuffer = new InputDelayBuffer();
  let lastAppliedTick: number | null = null;
  let lastReconciliationRngState: number | null = null;
  let ended = false;
  // Only `map`/`gameplaySeed` ever change across a transition — everything
  // else (roster/tick constants/difficulty/player count) is fixed for the
  // whole session, agreed once at setup.
  let currentResult = result;

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

  // Level-transition ack tracking (§7): at most one `waitForAcks()` call is
  // ever in flight at a time (a transition can't start again until the
  // previous one has fully resolved — see `transitionInProgress` below), so
  // a single reassignable callback is enough; no per-call bookkeeping map
  // needed. Rides `channels.reconciliation`, otherwise idle since session
  // setup's own listener unsubscribed — the host never receives anything
  // else there (it only ever *sends* `ReconciliationSnapshotMessage`s).
  let onAckReceived: ((id: PlayerId) => void) | null = null;
  const unsubscribeTransitionAck = onJsonMessage<LevelTransitionAckMessage>(channels.reconciliation, (message) => {
    onAckReceived?.(message.playerId);
  });
  function waitForAcks(ids: readonly PlayerId[], timeoutMs: number): Promise<void> {
    // Unreachable today: the roster is fixed at exactly 2 players (host +
    // one guest — see `sessionSetupTypes.ts`'s own `HOST_PLAYER_ID`/
    // `GUEST_PLAYER_ID` doc comment), so `guestIds` below always has exactly
    // one entry. Kept as a guard against a future N-player roster, not
    // reachable via any current call site.
    /* v8 ignore next */
    if (ids.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const remaining = new Set(ids);
      const timer = setTimeout(() => {
        onAckReceived = null;
        resolve();
      }, timeoutMs);
      onAckReceived = (id) => {
        remaining.delete(id);
        if (remaining.size === 0) {
          clearTimeout(timer);
          onAckReceived = null;
          resolve();
        }
      };
    });
  }

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    worker.terminate();
    unsubscribeInput();
    unsubscribeTransitionAck();
    connection?.removeEventListener("connectionstatechange", onConnectionStateChange);
    if (graceTimer !== null) clearTimeout(graceTimer);
  };

  // Assigned synchronously by `startLevel(currentResult)` a few lines below,
  // before `worker.onmessage`/the returned handle can ever read them —
  // never actually read while `undefined` in practice, `hasStarted` below is
  // what makes that provably true rather than just assumed.
  let engine: SessionEngineHandle["engine"] | undefined;
  let myInput: SessionEngineHandle["myInput"] | undefined;
  let otherInput: SessionEngineHandle["otherInput"] | undefined;
  let localSampler: SessionEngineHandle["localSampler"] | undefined;
  let hasStarted = false;
  let transitionInProgress = false;

  /** Fired once this peer's own simulation reaches a win (see
   * `sessionEngine.ts`'s own `onWin` doc comment for why that's not
   * automatically an end-of-session event anymore). `transitionInProgress`
   * guards re-entrancy: an already-won engine's `onWin` refires on every
   * subsequent `advance()` call (same as `onGameOver` would — no edge-gating
   * on either, by design, see `engine.ts`'s own tests), and this whole flow
   * is `async` — several more ticks arrive before it ever resolves. */
  const onWinFromEngine = async (): Promise<void> => {
    if (ended || transitionInProgress || !engine) return;
    transitionInProgress = true;

    const carryovers: Record<PlayerId, EngineCarryover> = {};
    for (const id of currentResult.roster) {
      const captured = engine.captureCarryoverFor(id);
      // A teammate who died earlier this level revives at REVIVE_HEALTH for
      // the next one — the same revive pattern `addPlayer`'s own carryover
      // handling already established in step 4, just applied at a level
      // boundary instead of a mid-level reconnect.
      carryovers[id] = engine.getPlayerStatus(id) === "dead" ? { ...captured, health: REVIVE_HEALTH } : captured;
    }

    const next = await findNextLevel?.({ carryovers });
    if (ended) return; // torn down while the lookup was in flight

    if (!next) {
      const stats = engine.render();
      const comparison = engine.rosterSnapshot();
      teardown();
      onSessionEnded?.(stats, "campaign-complete", comparison);
      return;
    }

    if (channels.reconciliation.readyState === "open") {
      const { visited: _visited, ...mapWithoutVisited } = next.map;
      const initMessage: LevelTransitionInitMessage = {
        type: "level-transition-init",
        carryovers,
        gameplaySeed: next.gameplaySeed,
      };
      // chunkJson splits by UTF-16 code-unit length, not true byte count —
      // an approximation that only matters for non-ASCII map content, the
      // same pre-existing 6b decision `sessionSetupHost.ts`'s own transfer
      // already makes, not new here.
      const chunks = chunkJson(mapWithoutVisited, MAP_CHUNK_SIZE_BYTES);
      const chunkMessages: LevelTransitionMapChunkMessage[] = chunks.map((data, index) => ({ type: "level-transition-map-chunk", index, data }));
      const endMessage: LevelTransitionMapEndMessage = { type: "level-transition-map-end", totalChunks: chunks.length };
      try {
        // Backpressure-aware — see `sendJsonSequence`'s own doc comment for
        // why a real `RTCDataChannel.send()` burst needs this (confirmed
        // directly as the cause of a real CI failure, not theoretical).
        await sendJsonSequence(channels.reconciliation, [initMessage, ...chunkMessages, endMessage]);
      } catch (err) {
        // No special handling needed: a guest that never receives a
        // complete transition also never acks it, and falls into the
        // disconnect path below via the ordinary "never acked in time"
        // signal — the same outcome a guest that was simply gone already
        // produces, so a failed send here doesn't need its own separate
        // recovery path.
        console.log(`[multiplayer] level-transition send failed, guest(s) will time out via the normal ack path: ${err}`);
      }
    }

    // A guest that never acks in time falls into the disconnect path via the
    // same connection-state signal once it's genuinely gone — not handled
    // specially here; this just stops waiting and proceeds regardless.
    const guestIds = currentResult.roster.filter((id) => id !== HOST_PLAYER_ID);
    await waitForAcks(guestIds, TRANSITION_ACK_TIMEOUT_MS);
    if (ended) return;

    currentResult = { ...currentResult, map: next.map, gameplaySeed: next.gameplaySeed };
    startLevel(currentResult, carryovers);
    transitionInProgress = false;
  };

  const startLevel = (levelResult: SessionSetupResult, carryovers?: Record<PlayerId, EngineCarryover>): void => {
    if (hasStarted) localSampler?.detach();
    hasStarted = true;
    const built = buildSessionEngine({
      result: levelResult,
      role: "host",
      canvas,
      carryovers,
      onSessionEnded: (stats, reason, comparison) => {
        teardown();
        onSessionEnded?.(stats, reason, comparison);
      },
      onWin: () => void onWinFromEngine(),
    });
    engine = built.engine;
    myInput = built.myInput;
    otherInput = built.otherInput;
    localSampler = built.localSampler;
  };
  startLevel(currentResult);

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
    if (ended || !engine || !myInput || !otherInput || !localSampler) return;

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

    // Finalize and broadcast the tick that's actually due now. `currentResult.roster`
    // (not the outer `result` param) so a level transition's roster — unchanged
    // today, but read fresh either way — is never silently stale.
    const bundle: TickInputBundle = inputDelayBuffer.finalize(
      tick,
      currentResult.roster,
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
    getPlayerPosition: (id) => engine?.getPlayerPosition(id) ?? null,
    getPlayerFacing: (id) => engine?.getPlayerFacing(id) ?? null,
    getRngState: () => engine!.getRngState(),
    hasActiveRenderOffset: (id) => engine!.hasActiveRenderOffset(id),
    getLastReconciliationRngState: () => lastReconciliationRngState,
    getPlayerStatus: (id) => engine?.getPlayerStatus(id) ?? null,
    // `engine` is always defined by the time any of these handle methods
    // can be called (assigned synchronously by `startLevel(currentResult)`
    // before this function ever returns) — the `?? []` fallback is the same
    // "TypeScript's conservative optional typing vs. what production code
    // actually guarantees" shape `doc/dev/testing.md`'s own coverage-caveats
    // section documents elsewhere in this codebase.
    /* v8 ignore next */
    getLootDrops: () => engine?.getLootDrops() ?? [],
    /* v8 ignore next */
    getMapExit: () => engine?.getMapExit() ?? null,
    /* v8 ignore next */
    getMapGrid: () => engine?.getMapGrid() ?? null,
    // Unlike the getters above, `engine`'s own `getExitCountdownRemaining()`
    // legitimately returns `null` on its own (no countdown running yet) even
    // once `engine` is defined — so both outcomes of this fallback are
    // genuinely reachable through a real call, no ignore needed.
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
    // Same reasoning as `getPlayerPosition`/`getPlayerFacing` above — the
    // inner call itself already returns `null` for an unrecognized id, so
    // both fallback outcomes are reachable through a real call, no ignore
    // needed.
    getBotPlayerState: (id) => engine?.getBotPlayerState(id) ?? null,
    debugInjectDesync: (injection) => engine!.debugInjectDesync(injection),
  };
}
