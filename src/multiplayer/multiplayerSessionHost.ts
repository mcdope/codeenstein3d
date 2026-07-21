// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The host's half of a live multiplayer session — the sequencer (see
 * `doc/dev/multiplayer-netcode-spec.md`'s "Message flow per tick"): its own
 * `TickAccumulator`-driven Web Worker paces every tick, an `InputDelayBuffer`
 * finalizes one canonical `TickInputBundle` per due tick from whatever's
 * arrived, broadcasts it to every connected guest, and applies it locally via
 * `engine.advance(FIXED_DT)` — the same call every guest makes from its own
 * bundle-arrival handler, so every peer's simulation advances identically.
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
 * initial level and every later transition — `worker`/`links`/
 * `inputDelayBuffer` all stay alive across a swap, only the level-scoped
 * `engine`/`myInput`/`otherInputs`/`localSampler` get replaced. A win no
 * longer ends the session directly (see `sessionEngine.ts`'s own `onWin` doc
 * comment) — it captures every connected player's own carryover, asks the
 * injected `findNextLevel` for the next level's content, and either
 * broadcasts a chunked `LevelTransitionMessage` sequence and calls
 * `startLevel()` again once every guest has acked (or
 * `TRANSITION_ACK_TIMEOUT_MS` elapses — a guest that never acks falls into
 * the disconnect path via the same connection-state signal, not a special
 * case here), or, once genuinely out of content, ends the session with
 * reason `"campaign-complete"`.
 *
 * Step 10 (N-player): `channels`/a single `connection` became `links: Map<
 * PlayerId, HostGuestLink>` — one entry per connected guest (host + up to 3
 * guests today, see `main.ts`'s `maxPlayers` select). Everywhere the old
 * 2-player code read/wrote one guest's channel or watched one connection, it
 * now loops over `links`; disconnect tracking in particular had to become
 * genuinely per-guest (`graceTimers`/`rosterRemovalsToApply`), not just
 * per-session, so one guest disconnecting can never affect another's.
 */
import {
  REVIVE_HEALTH,
  type EngineCarryover,
  type EngineStats,
  type PlayerId,
  type PlayerStatus,
  type RaycasterEngine,
  type RosterSnapshotEntry,
} from "../engine/engine";
import type { GameMap, LootDrop, Point, Tile } from "../map/types";
import { chunkJson } from "./chunkedTransfer";
import { readConnectionStats, type ConnectionStats } from "./connectionStats";
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
import { HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { TickDueMessage } from "./tickClockWorker";
import type { HostGuestLink } from "./types";

export interface TickWorkerHandle {
  onmessage: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

/** The narrow slice of `RTCPeerConnection` disconnect detection (plus, since
 * step 11 Phase 2b, `getStats()` reads — `getConnectionStats()`) needs —
 * typed against just the members this module actually uses (mirrors
 * `TickWorkerHandle`'s own injection style above), so a small fake keeps this
 * module unit-testable without a real `RTCPeerConnection` (this project's
 * test environment has none). A real `HostGuestLink.peerConnection` already
 * structurally satisfies this — `main.ts` passes the genuine
 * `RTCPeerConnection` from each connected guest's link. */
export interface ConnectionStateSource {
  readonly connectionState: RTCPeerConnectionState;
  addEventListener(type: "connectionstatechange", listener: () => void): void;
  removeEventListener(type: "connectionstatechange", listener: () => void): void;
  getStats(): Promise<RTCStatsReport>;
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
  /** Real round-trip-time read via `RTCPeerConnection.getStats()` — step 11
   * Phase 2b (`connectionStats.ts`). Every method here reflects only *this*
   * peer's own local observation, not a network-wide or authoritative view
   * — there is no single "true" RTT, each side of a link measures it
   * independently. Host: `id` is any connected guest's roster id (looked up
   * in `links`); resolves `null` for an id with no live link. Guest: only
   * ever has one link, toward the host — resolves `null` for any `id` other
   * than `HOST_PLAYER_ID`. Never rejects: an underlying `getStats()` failure
   * resolves `{rttMs: null}` (see `readConnectionStats`), same "report
   * un-knowability instead of throwing for a live peer" shape the rest of
   * this interface already uses. */
  getConnectionStats(id: PlayerId): Promise<ConnectionStats | null>;
  /** Cumulative, session-lifetime tally of `TickInputBundle.heldInputFallback`
   * occurrences this peer has observed — every peer applies the identical
   * bundle each tick (lockstep), so host and guest tallies agree in
   * practice; tracked independently rather than centrally, for symmetry with
   * everything else this interface exposes (each peer reports its own local
   * view, not a merged one). `totalTicks` is the same for every player (one
   * bundle covers the whole roster at once) — divide a player's own tally by
   * it for a missed-tick fraction. */
  getMissedTickStats(): { totalTicks: number; missedTicksByPlayer: Record<PlayerId, number> };
  /** Cumulative, session-lifetime per-player reconciliation-correction
   * tally — a real signal only a guest can observe: the host is
   * authoritative and never applies a snapshot to itself, so its own copy
   * of this is always `{}` (see `runMultiplayerSessionAsHost`'s own
   * implementation below). A "correction" is counted only once its position
   * magnitude exceeds a small noise floor (see
   * `RECONCILIATION_CORRECTION_NOISE_FLOOR_TILES` in
   * `multiplayerSessionGuest.ts`) — otherwise ordinary cross-peer
   * floating-point drift (the same inputs, computed in a different order)
   * would count as a "correction" on nearly every broadcast, making the
   * signal meaningless. */
  getReconciliationCorrections(): Record<PlayerId, { count: number; totalMagnitudeTiles: number }>;
  /** Read-only — see `RaycasterEngine.getMultiplayerTelemetrySnapshot`'s doc
   * comment. `null` before any level has started, if telemetry isn't being
   * recorded this run, or if `id` isn't a connected player with its own
   * telemetry (e.g. it disconnected mid-run) — same "report un-knowability"
   * shape `getBotPlayerState` already uses. */
  getMultiplayerTelemetrySnapshot(id: PlayerId): ReturnType<RaycasterEngine["getMultiplayerTelemetrySnapshot"]>;
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
  links: ReadonlyMap<PlayerId, HostGuestLink>,
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

  // Disconnect handling (§5): genuinely per-guest now (step 10) — one guest
  // going away must never affect another's session. `neutralInputIds` still
  // covers both "currently inside its grace window" and "grace expired, now
  // genuinely removed" for any affected id (shared shape across every
  // guest, same reasoning as the original 2-player design) — once a player
  // enters either state, `InputDelayBuffer` must feed it the neutral idle
  // snapshot forever, not just for the bounded grace window (see
  // `InputDelayBuffer.finalize`'s own doc comment). `graceTimers`/
  // `rosterRemovalsToApply` are the pieces that genuinely needed to become
  // per-guest/plural — simultaneous multi-guest disconnects are a real,
  // reachable case now.
  const neutralInputIds = new Set<PlayerId>();
  const graceTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();
  let rosterRemovalsToApply: PlayerId[] = [];

  // Missed-tick tally (Phase 2b) — seeded once from the session's own fixed
  // roster (unchanged across a level transition, see this file's own doc
  // comment on `currentResult`), not per-`startLevel()` call.
  let totalTicks = 0;
  const missedTicksByPlayer = new Map<PlayerId, number>(result.roster.map((id) => [id, 0]));

  const makeConnectionStateChangeHandler = (guestId: PlayerId, connection: ConnectionStateSource) => (): void => {
    const state = connection.connectionState;
    if (state === "disconnected" || state === "failed") {
      if (graceTimers.has(guestId) || neutralInputIds.has(guestId)) return; // already tracked
      neutralInputIds.add(guestId);
      graceTimers.set(
        guestId,
        setTimeout(() => {
          graceTimers.delete(guestId);
          rosterRemovalsToApply.push(guestId);
        }, DISCONNECT_GRACE_MS),
      );
    } else if (state === "connected" && graceTimers.has(guestId)) {
      // Recovered before grace expired — once expired (timer already
      // deleted), reconnection is out of scope (no v1 host migration/rejoin
      // per the spec) and this branch no longer applies.
      clearTimeout(graceTimers.get(guestId));
      graceTimers.delete(guestId);
      neutralInputIds.delete(guestId);
    }
  };
  const connectionStateListeners = new Map<PlayerId, () => void>();
  for (const [guestId, link] of links) {
    const listener = makeConnectionStateChangeHandler(guestId, link.peerConnection);
    link.peerConnection.addEventListener("connectionstatechange", listener);
    connectionStateListeners.set(guestId, listener);
  }

  // Level-transition ack tracking (§7): at most one `waitForAcks()` call is
  // ever in flight at a time (a transition can't start again until the
  // previous one has fully resolved — see `transitionInProgress` below), so
  // a single reassignable callback is enough; no per-call bookkeeping map
  // needed. One subscription per guest's own `reconciliation` channel now
  // (step 10) — otherwise idle since session setup's own listener there
  // already unsubscribed (the host never receives anything else on it, it
  // only ever *sends* `ReconciliationSnapshotMessage`s/transition messages).
  let onAckReceived: ((id: PlayerId) => void) | null = null;
  const unsubscribeTransitionAcks: (() => void)[] = [];
  for (const [guestId, link] of links) {
    unsubscribeTransitionAcks.push(
      // Bound to the link a message actually arrived on, not the message's
      // own self-declared `playerId` — a guest's wire payload must never be
      // trusted to identify itself; the loop's own map key is the only
      // trustworthy identity (see this file's doc comment / the matching
      // fix on the tick-input listener below).
      onJsonMessage<LevelTransitionAckMessage>(link.channels.reconciliation, () => {
        onAckReceived?.(guestId);
      }),
    );
  }
  function waitForAcks(ids: readonly PlayerId[], timeoutMs: number): Promise<void> {
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
    unsubscribeInputs.forEach((fn) => fn());
    unsubscribeTransitionAcks.forEach((fn) => fn());
    for (const [guestId, listener] of connectionStateListeners) {
      links.get(guestId)?.peerConnection.removeEventListener("connectionstatechange", listener);
    }
    for (const timer of graceTimers.values()) clearTimeout(timer);
    // Detached directly here, not left to `startLevel()`'s own `hasStarted`
    // guard (which only ever fires on a *later* `startLevel()` call) —
    // the "campaign-complete" ending never calls `startLevel()` again, so
    // without this the sampler's window/document/canvas listeners would
    // otherwise leak forever past session end.
    localSampler?.detach();
  };

  // Assigned synchronously by `startLevel(currentResult)` a few lines below,
  // before `worker.onmessage`/the returned handle can ever read them —
  // never actually read while `undefined` in practice, `hasStarted` below is
  // what makes that provably true rather than just assumed.
  let engine: SessionEngineHandle["engine"] | undefined;
  let myInput: SessionEngineHandle["myInput"] | undefined;
  let otherInputs: SessionEngineHandle["otherInputs"] | undefined;
  let localSampler: SessionEngineHandle["localSampler"] | undefined;
  let hasStarted = false;
  let transitionInProgress = false;
  // Purely local, never transmitted as its own message (see
  // `TickInputBundle.levelEpoch`'s own doc comment) — bumped alongside
  // `localSampler.detach()` below, on every `startLevel()` call *after* the
  // first, so it stays in lockstep with the guest's own identical counter
  // (both sides call `startLevel()` exactly once per transition).
  let levelEpoch = 0;

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

    const guestIds = currentResult.roster.filter((id) => id !== HOST_PLAYER_ID);
    const { visited: _visited, ...mapWithoutVisited } = next.map;
    // chunkJson splits by UTF-16 code-unit length, not true byte count —
    // an approximation that only matters for non-ASCII map content, the
    // same pre-existing 6b decision `sessionSetupHost.ts`'s own transfer
    // already makes, not new here.
    const chunks = chunkJson(mapWithoutVisited, MAP_CHUNK_SIZE_BYTES);
    const initMessage: LevelTransitionInitMessage = { type: "level-transition-init", carryovers, gameplaySeed: next.gameplaySeed };
    const chunkMessages: LevelTransitionMapChunkMessage[] = chunks.map((data, index) => ({ type: "level-transition-map-chunk", index, data }));
    const endMessage: LevelTransitionMapEndMessage = { type: "level-transition-map-end", totalChunks: chunks.length };
    const messages = [initMessage, ...chunkMessages, endMessage];

    // Fanned out to every guest CONCURRENTLY, not sequentially (step 10):
    // `sendJsonSequence` awaits backpressure per message, so a sequential
    // loop here would multiply wall-clock time by guest count. Each guest's
    // failure is handled independently — it falls into its own "never acked
    // in time" disconnect path below, exactly like a merely-slow guest,
    // rather than aborting every other guest's transfer.
    await Promise.all(
      guestIds.map(async (id) => {
        const channel = links.get(id)?.channels.reconciliation;
        if (!channel || channel.readyState !== "open") return;
        try {
          await sendJsonSequence(channel, messages);
        } catch (err) {
          // No special handling needed: a guest that never receives a
          // complete transition also never acks it, and falls into the
          // disconnect path below via the ordinary "never acked in time"
          // signal — the same outcome a guest that was simply gone already
          // produces, so a failed send here doesn't need its own separate
          // recovery path.
          console.log(`[multiplayer] level-transition send to ${id} failed, it will time out via the normal ack path: ${err}`);
        }
      }),
    );

    // A guest that never acks in time falls into the disconnect path via the
    // same connection-state signal once it's genuinely gone — not handled
    // specially here; this just stops waiting and proceeds regardless.
    // Guests whose disconnect grace has already fully expired (in
    // `neutralInputIds` with no corresponding active `graceTimers` entry)
    // are excluded up front — they can never ack again, so waiting on them
    // would only ever burn the full timeout on every subsequent transition.
    const ackWaitIds = guestIds.filter((id) => !neutralInputIds.has(id) || graceTimers.has(id));
    await waitForAcks(ackWaitIds, TRANSITION_ACK_TIMEOUT_MS);
    if (ended) return;

    currentResult = { ...currentResult, map: next.map, gameplaySeed: next.gameplaySeed };
    startLevel(currentResult, carryovers);
    transitionInProgress = false;
  };

  const startLevel = (levelResult: SessionSetupResult, carryovers?: Record<PlayerId, EngineCarryover>): void => {
    if (hasStarted) {
      localSampler?.detach();
      levelEpoch++;
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
      onWin: () => void onWinFromEngine(),
    });
    engine = built.engine;
    myInput = built.myInput;
    otherInputs = built.otherInputs;
    localSampler = built.localSampler;
  };
  startLevel(currentResult);

  // Every incoming message on a guest's own `input` channel is necessarily a
  // `TickInput` from that guest — a guest never broadcasts a
  // `TickInputBundle` (only the host does), and `input` carries nothing else
  // (session setup rides `reconciliation` instead). One subscription per
  // connected guest (step 10), not one shared subscription.
  const unsubscribeInputs: (() => void)[] = [];
  for (const [guestId, link] of links) {
    unsubscribeInputs.push(
      // Bound to the link a message actually arrived on, not the message's
      // own self-declared `playerId` — a guest could otherwise spoof another
      // player's id (e.g. claim `playerId: "guest-1"` while connected as
      // `"guest-2"`), corrupting that other player's own input. The loop's
      // own map key is the only trustworthy identity.
      onJsonMessage<TickInput>(link.channels.input, (message) => {
        inputDelayBuffer.record(message.tick, guestId, message.input);
      }),
    );
  }

  worker.onmessage = (event) => {
    // Guards against TickAccumulator.advance() having posted several due
    // ticks in one worker turn (after a stall) — if game-over already fired
    // and tore this session down mid-batch, every further already-queued
    // "tick" message must be a no-op, not re-run teardown or advance a
    // stopped engine.
    if (ended || !engine || !myInput || !otherInputs || !localSampler) return;

    const { tick } = event.data as TickDueMessage;

    // Sample + delay-buffer this host's own input for a future tick —
    // delayed the exact same way every guest's input is, so the host gets no
    // built-in latency advantage (multiplayer-netcode-spec.md §2). Recorded
    // locally only, never sent over a guest's `input` channel: each guest's
    // own listener there only ever expects a `TickInputBundle` (see this
    // module's own incoming-message comment above) — broadcasting a bare
    // `TickInput` alongside it would corrupt every guest-side
    // `bundle.inputs[...]` read the moment it arrived (`bundle.inputs` is
    // undefined on a `TickInput`). It reaches every guest properly shaped,
    // inside the broadcast bundle below, once this same tick is finalized.
    const futureTick = tick + INPUT_DELAY_TICKS;
    const { snapshot: sampled, localEscapePressed } = localSampler.sampleAndReset();
    inputDelayBuffer.record(futureTick, HOST_PLAYER_ID, sampled);
    // Local-only, no shared-simulation channel to carry it — see
    // `dismissLoreOverlay()`'s own doc comment.
    if (localEscapePressed) engine.dismissLoreOverlay();

    // Finalize and broadcast the tick that's actually due now. `currentResult.roster`
    // (not the outer `result` param) so a level transition's roster — unchanged
    // today, but read fresh either way — is never silently stale.
    const finalized = inputDelayBuffer.finalize(
      tick,
      currentResult.roster,
      FIXED_DT,
      neutralInputIds.size > 0 ? neutralInputIds : undefined,
    );
    // `levelEpoch` stamped on here, not inside `InputDelayBuffer.finalize()`
    // itself — it's a purely local, per-session-driver counter (see
    // `TickInputBundle.levelEpoch`'s own doc comment), not something the
    // buffer needs to know about.
    const bundle: TickInputBundle = { ...finalized, levelEpoch };
    totalTicks++;
    // `missedTicksByPlayer` is seeded from the full, fixed roster above, and
    // `heldInputFallback` only ever contains roster ids (`InputDelayBuffer.
    // finalize()`'s own `rosterIds` param) — `.get(id)` is always defined.
    for (const id of bundle.heldInputFallback) {
      missedTicksByPlayer.set(id, missedTicksByPlayer.get(id)! + 1);
    }

    // Every grace timer that expired since the last tick is applied on this
    // tick, synchronously with the broadcast — every peer (host included)
    // applies the same `rosterRemove` from this exact bundle, the same
    // synchronized-lockstep-event shape `applyRosterRemoval` itself expects.
    // Plural now (step 10): more than one guest's grace can expire on the
    // same tick.
    if (rosterRemovalsToApply.length > 0) {
      const ids = rosterRemovalsToApply;
      rosterRemovalsToApply = [];
      engine.applyRosterRemoval(ids);
      bundle.rosterRemove = ids;
    }

    // `RTCDataChannel.send()` throws synchronously once `readyState` isn't
    // `"open"` — a guest whose transport is already gone (channel closed
    // before this peer's own `connectionstatechange` even fires; disconnect
    // detection above is best-effort and inherently lags the real transport)
    // must never crash this handler on that throw: an uncaught exception
    // here would abort *this whole tick* before `engine.advance()` ever
    // runs, permanently stalling the host's own simulation the instant any
    // one guest's channel closes — exactly the "never stall waiting on a
    // peer that's gone" guarantee this step exists to provide, now for every
    // connected guest independently. Skipping the send is harmless either
    // way: nothing is listening on a closed channel.
    for (const link of links.values()) {
      if (link.channels.input.readyState === "open") sendJson(link.channels.input, bundle);
    }

    myInput.loadFrame(bundle.inputs[HOST_PLAYER_ID]);
    for (const [id, input] of otherInputs) input.loadFrame(bundle.inputs[id]);
    engine.advance(FIXED_DT);
    lastAppliedTick = tick;

    // Periodic authoritative state reconciliation — the host is the only
    // source of truth, so it never applies its own broadcast back onto
    // itself (`multiplayer-netcode-spec.md` §3). One send per connected
    // guest (step 10), each independently guarded the same way as the tick
    // broadcast above.
    if (tick % RECONCILE_INTERVAL_TICKS === 0) {
      const snapshot: ReconciliationSnapshotMessage = { type: "reconciliation-snapshot", ...engine.captureReconciliationSnapshot(tick) };
      lastReconciliationRngState = snapshot.rngState;
      for (const link of links.values()) {
        if (link.channels.reconciliation.readyState === "open") sendJson(link.channels.reconciliation, snapshot);
      }
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
    getConnectionStats: (id) => {
      const link = links.get(id);
      return link ? readConnectionStats(link.peerConnection) : Promise.resolve(null);
    },
    getMissedTickStats: () => ({
      totalTicks,
      missedTicksByPlayer: Object.fromEntries(missedTicksByPlayer) as Record<PlayerId, number>,
    }),
    // Always empty — see this method's own doc comment on
    // `MultiplayerSessionHandle` for why only a guest can ever observe this.
    getReconciliationCorrections: () => ({}),
    /* v8 ignore next */
    getMultiplayerTelemetrySnapshot: (id) => engine?.getMultiplayerTelemetrySnapshot(id) ?? null,
  };
}
