// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import type { EngineCarryover, PlayerId } from "../engine/engine";
import { COUNTDOWN_TICKS } from "../engine/transitionConstants";
import type { GameMap, Tile } from "../map/types";
import type { LevelTransitionAckMessage, LevelTransitionMessage } from "./levelTransitionTypes";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import { DISCONNECT_GRACE_MS, RECONCILE_INTERVAL_TICKS, TRANSITION_ACK_TIMEOUT_MS } from "./netcodeConstants";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { HOST_PLAYER_ID } from "./sessionSetupTypes";
import type { SessionSetupResult } from "./sessionSetupTypes";
import type { HostGuestLink, MultiplayerChannels } from "./types";

/** A small fake of the `ConnectionStateSource` slice of `RTCPeerConnection`
 * — same spirit as `FakeRTCDataChannel`, this project's test environment has
 * no real `RTCPeerConnection`. */
class FakeConnection {
  connectionState: RTCPeerConnectionState = "connected";
  private readonly listeners = new Set<() => void>();
  /** `null` fakes a `getStats()` report with no succeeded/nominated
   * candidate-pair entry yet (e.g. read right after connect) — the same
   * "not known right now" case `readConnectionStats()` collapses a missing
   * field or an outright `getStats()` failure into. */
  rttSeconds: number | null = 0.042;
  addEventListener(_type: "connectionstatechange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "connectionstatechange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const listener of this.listeners) listener();
  }
  getStats(): Promise<RTCStatsReport> {
    const entries: [string, unknown][] =
      this.rttSeconds === null
        ? []
        : [["candidate-pair-1", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: this.rttSeconds }]];
    return Promise.resolve(new Map(entries) as unknown as RTCStatsReport);
  }
}

let runMultiplayerSessionAsHost: typeof import("./multiplayerSessionHost").runMultiplayerSessionAsHost;
let RaycasterEngine: typeof import("../engine/engine").RaycasterEngine;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ runMultiplayerSessionAsHost } = await import("./multiplayerSessionHost"));
  ({ RaycasterEngine } = await import("../engine/engine"));
});

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  createMockCanvasContext(canvas);
  return canvas;
}

function channelPair(): { host: MultiplayerChannels; guest: MultiplayerChannels } {
  const hostInput = new FakeRTCDataChannel("input");
  const guestInput = new FakeRTCDataChannel("input");
  hostInput.link(guestInput);
  const hostReconciliation = new FakeRTCDataChannel("reconciliation");
  const guestReconciliation = new FakeRTCDataChannel("reconciliation");
  hostReconciliation.link(guestReconciliation);
  // Every real caller only ever drives ticks once `waitForChannelsOpen()`
  // has already resolved (see `webrtcConnection.ts`) — matching that here
  // keeps this fixture's default state realistic, now that the host driver
  // itself checks `readyState === "open"` before broadcasting (see
  // `multiplayerSessionHost.ts`'s own doc comment on that guard). A test
  // that specifically wants a *not-open* channel sets `readyState` back
  // after this call.
  hostInput.simulateOpen();
  guestInput.simulateOpen();
  hostReconciliation.simulateOpen();
  guestReconciliation.simulateOpen();
  return {
    host: { input: hostInput as unknown as RTCDataChannel, reconciliation: hostReconciliation as unknown as RTCDataChannel },
    guest: { input: guestInput as unknown as RTCDataChannel, reconciliation: guestReconciliation as unknown as RTCDataChannel },
  };
}

/** A single connected guest ("guest") — the common 2-player case every test
 * originally exercised. `links` is what `runMultiplayerSessionAsHost` now
 * takes directly (step 10: was a bare `channels` pair); `connection` is the
 * same `FakeConnection` embedded in that one link, exposed separately so
 * disconnect tests can drive `.setState(...)` on it without having to reach
 * back into the `Map`. */
function linkedChannels(): { host: MultiplayerChannels; guest: MultiplayerChannels; connection: FakeConnection; links: Map<PlayerId, HostGuestLink> } {
  const channels = channelPair();
  const connection = new FakeConnection();
  const links = new Map<PlayerId, HostGuestLink>([["guest", { peerConnection: connection as unknown as RTCPeerConnection, channels: channels.host }]]);
  return { host: channels.host, guest: channels.guest, connection, links };
}

/** Two connected guests ("guest-1"/"guest-2") — for step 10's N-player
 * coverage (tick fan-out, per-guest disconnect isolation, multi-guest
 * level-transition acks). */
function twoGuestLinks(): {
  guest1: MultiplayerChannels;
  guest2: MultiplayerChannels;
  connection1: FakeConnection;
  connection2: FakeConnection;
  links: Map<PlayerId, HostGuestLink>;
} {
  const pair1 = channelPair();
  const pair2 = channelPair();
  const connection1 = new FakeConnection();
  const connection2 = new FakeConnection();
  const links = new Map<PlayerId, HostGuestLink>([
    ["guest-1", { peerConnection: connection1 as unknown as RTCPeerConnection, channels: pair1.host }],
    ["guest-2", { peerConnection: connection2 as unknown as RTCPeerConnection, channels: pair2.host }],
  ]);
  return { guest1: pair1.guest, guest2: pair2.guest, connection1, connection2, links };
}

function walledRoom(size: number): Tile[][] {
  const g: Tile[][] = Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) g[y][x] = 1;
    }
  }
  return g;
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 12): GameMap {
  return {
    width: size,
    height: size,
    grid: walledRoom(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 5, y: 5 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
    shortestPathTiles: 4,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
    ...overrides,
  };
}

function fakeResult(overrides: Partial<SessionSetupResult> = {}): SessionSetupResult {
  return {
    roster: ["guest", HOST_PLAYER_ID].sort(),
    assignedId: HOST_PLAYER_ID,
    tickRateHz: 30,
    fixedDt: 1 / 30,
    inputDelayTicks: 3,
    gameplaySeed: 1,
    difficulty: "normal",
    playerCount: 2,
    map: fakeMap(),
    ...overrides,
  };
}

function fakeWorker(): { onmessage: ((event: MessageEvent) => void) | null; terminate: ReturnType<typeof vi.fn> } {
  return { onmessage: null, terminate: vi.fn() };
}

/** Collects every JSON message sent on a channel (a guest's own view of what
 * the host broadcast) for assertions. */
function collectMessages(channel: RTCDataChannel): (TickInput | TickInputBundle)[] {
  const messages: (TickInput | TickInputBundle)[] = [];
  channel.addEventListener("message", (event) => {
    messages.push(JSON.parse((event as MessageEvent).data as string));
  });
  return messages;
}

function collectReconciliationMessages(channel: RTCDataChannel): ReconciliationSnapshotMessage[] {
  const messages: ReconciliationSnapshotMessage[] = [];
  channel.addEventListener("message", (event) => {
    messages.push(JSON.parse((event as MessageEvent).data as string));
  });
  return messages;
}

describe("runMultiplayerSessionAsHost", () => {
  it("broadcasts exactly one finalized TickInputBundle when a tick becomes due, its own delayed input recorded locally only", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const guestSeenMessages = collectMessages(channels.guest.input);

    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

    expect(handle.getLastAppliedTick()).toBe(0);
    // Exactly one message — the finalized TickInputBundle for tick 0. The
    // host's own delayed input for tick 3 is recorded into its own
    // InputDelayBuffer directly (see multiplayerSessionHost.ts's own
    // comment) rather than broadcast as a second, differently-shaped
    // message the guest's listener never expected — a real regression this
    // test now guards, caught by scripts/verify-multiplayer-netcode.mjs.
    expect(guestSeenMessages).toHaveLength(1);
    expect(guestSeenMessages[0]).toMatchObject({ tick: 0, dt: 1 / 30 });
  });

  it("bootstrap transient: falls back to the neutral snapshot for the guest on the very first ticks", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const guestSeenMessages = collectMessages(channels.guest.input);

    runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

    const bundle = guestSeenMessages[0] as TickInputBundle;
    expect(bundle.heldInputFallback).toContain("guest");
  });

  it("records the guest's own TickInput arriving on the input channel into the delay buffer", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const guestSeenMessages = collectMessages(channels.guest.input);

    runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

    // Guest sends its own input for tick 3 ahead of time.
    const guestInput: TickInput = { tick: 3, playerId: "guest", input: { ...emptySnapshot(), fireQueued: true } };
    channels.guest.input.send(JSON.stringify(guestInput));

    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
    worker.onmessage?.({ data: { type: "tick", tick: 1 } } as MessageEvent);
    worker.onmessage?.({ data: { type: "tick", tick: 2 } } as MessageEvent);
    worker.onmessage?.({ data: { type: "tick", tick: 3 } } as MessageEvent);

    const bundleAt3 = guestSeenMessages.find((m): m is TickInputBundle => "inputs" in m && m.tick === 3);
    expect(bundleAt3?.inputs.guest.fireQueued).toBe(true);
    expect(bundleAt3?.heldInputFallback).not.toContain("guest");
  });

  it("stop() is idempotent and terminates the worker exactly once", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    handle.stop();
    handle.stop();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("ignores further tick-due messages after teardown (re-entrancy guard for a batch of queued ticks)", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    handle.stop();
    expect(() => worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent)).not.toThrow();
    expect(handle.getLastAppliedTick()).toBeNull();
  });

  it("getPlayerPosition delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 4, y: 4 } }) }), worker);
    expect(handle.getPlayerPosition("host")).toEqual({ x: 4.5, y: 4.5 });
    expect(handle.getPlayerPosition("nope")).toBeNull();
  });

  it("getPlayerFacing delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    expect(handle.getPlayerFacing("host")).toEqual({ dirX: 1, dirY: 0 });
    expect(handle.getPlayerFacing("nope")).toBeNull();
  });

  it("getExitCountdownRemaining delegates to the underlying engine, null before any countdown starts", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    expect(handle.getExitCountdownRemaining()).toBeNull();
  });

  it("getExitCountdownRemaining reports a real tick count once the host is standing on the exit", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const map = fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } });
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map }), worker);
    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
    expect(handle.getExitCountdownRemaining()).toBe(COUNTDOWN_TICKS);
  });

  it("getMap/getEnemiesSnapshot/getMinesSnapshot/getBotPlayerState delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const map = fakeMap({ spawn: { x: 4, y: 4 } });
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map }), worker);
    expect(handle.getMap()).toBe(map);
    expect(handle.getEnemiesSnapshot()).toEqual([]);
    expect(handle.getMinesSnapshot()).toEqual([]);
    expect(handle.getBotPlayerState("host")).toMatchObject({ x: 4.5, y: 4.5, state: "playing" });
    expect(handle.getBotPlayerState("nope")).toBeNull();
  });

  it("getDropsSnapshot/getKeysSnapshot delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const map = fakeMap({ keys: [{ x: 6, y: 6, collected: false }] });
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map }), worker);
    expect(handle.getDropsSnapshot()).toEqual([]);
    expect(handle.getKeysSnapshot()).toEqual([{ x: 6, y: 6 }]);
  });

  it("getPlayerStatus/getLootDrops delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    expect(handle.getPlayerStatus("host")).toBe("alive");
    expect(handle.getPlayerStatus("nope")).toBeNull();
    expect(handle.getLootDrops()).toEqual([]);
  });

  it("forwards onSessionEnded once game-over fires, after tearing down the worker", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // hazard tile at spawn
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const onSessionEnded = vi.fn();
    runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map }), worker, onSessionEnded);

    // FIXED_DT-paced ticks (1/30s each) — needs many more iterations than a
    // dt=1 advance() loop would to cover the same in-sim elapsed time.
    for (let i = 0; i < 300 && onSessionEnded.mock.calls.length === 0; i++) {
      worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
    }

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("broadcasts a ReconciliationSnapshotMessage over channels.reconciliation only every RECONCILE_INTERVAL_TICKS ticks", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const guestSeenSnapshots = collectReconciliationMessages(channels.guest.reconciliation);

    runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    for (let tick = 0; tick < RECONCILE_INTERVAL_TICKS + 1; tick++) {
      worker.onmessage?.({ data: { type: "tick", tick } } as MessageEvent);
    }

    // Due at tick 0 and tick RECONCILE_INTERVAL_TICKS — nowhere in between.
    expect(guestSeenSnapshots).toHaveLength(2);
    expect(guestSeenSnapshots[0]).toMatchObject({ type: "reconciliation-snapshot", tick: 0 });
    expect(guestSeenSnapshots[1]).toMatchObject({ type: "reconciliation-snapshot", tick: RECONCILE_INTERVAL_TICKS });
    expect(guestSeenSnapshots[0].players).toHaveProperty("host");
    expect(guestSeenSnapshots[0].players).toHaveProperty("guest");
  });

  it("getLastReconciliationRngState reflects the rngState of the most recently broadcast snapshot, null before the first one", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    expect(handle.getLastReconciliationRngState()).toBeNull();

    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
    expect(handle.getLastReconciliationRngState()).toBe(handle.getRngState());
  });

  it("getRngState/debugInjectDesync/hasActiveRenderOffset delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
    const before = handle.getRngState();
    handle.debugInjectDesync({ kind: "extraRngDraw" });
    expect(handle.getRngState()).not.toBe(before);
    expect(handle.hasActiveRenderOffset("host")).toBe(false);
  });

  describe("network/netcode-quality telemetry (step 11 Phase 2b)", () => {
    it("getConnectionStats reads the active candidate pair's currentRoundTripTime off the guest's own link, null for an unknown id", async () => {
      const channels = linkedChannels();
      channels.connection.rttSeconds = 0.08;
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      await expect(handle.getConnectionStats("guest")).resolves.toEqual({ rttMs: 80 });
      await expect(handle.getConnectionStats("nobody")).resolves.toBeNull();
    });

    it("getConnectionStats resolves {rttMs: null} once no succeeded/nominated candidate pair is reported yet", async () => {
      const channels = linkedChannels();
      channels.connection.rttSeconds = null;
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      await expect(handle.getConnectionStats("guest")).resolves.toEqual({ rttMs: null });
    });

    it("getMissedTickStats tallies heldInputFallback occurrences per player across ticks, seeded at 0 for every roster id", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      expect(handle.getMissedTickStats()).toEqual({ totalTicks: 0, missedTicksByPlayer: { guest: 0, host: 0 } });

      // Tick 0: bootstrap transient — no real input has arrived yet for
      // *either* player (the host's own is delayed to a future tick just
      // like a guest's, per multiplayerSessionHost.ts's own doc comment on
      // why — see this file's "bootstrap transient" test above for the
      // guest-only half of the same phenomenon), so both count as missed.
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      expect(handle.getMissedTickStats()).toEqual({ totalTicks: 1, missedTicksByPlayer: { guest: 1, host: 1 } });

      const guestInput: TickInput = { tick: 3, playerId: "guest", input: emptySnapshot() };
      channels.guest.input.send(JSON.stringify(guestInput));
      worker.onmessage?.({ data: { type: "tick", tick: 3 } } as MessageEvent);
      expect(handle.getMissedTickStats()).toEqual({ totalTicks: 2, missedTicksByPlayer: { guest: 1, host: 1 } });
    });

    it("getReconciliationCorrections is always empty — the host is authoritative, it never applies a snapshot to itself", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      expect(handle.getReconciliationCorrections()).toEqual({});
    });
  });

  describe("disconnect handling (step 8, host side)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does nothing unless a guest's connection state actually changes from its default 'connected'", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      expect(handle.getPlayerStatus("guest")).toBe("alive");
    });

    it("applies rosterRemove and marks the guest disconnected once the connection stays down for the full grace period", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.input);
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      channels.connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(handle.getPlayerStatus("guest")).toBe("disconnected");
      const bundle = guestSeenMessages[0] as TickInputBundle;
      expect(bundle.rosterRemove).toEqual(["guest"]);
    });

    it("feeds the neutral idle snapshot for the guest during the grace window, even if real input arrived", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.input);
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      channels.connection.setState("disconnected");
      const guestInput: TickInput = { tick: 0, playerId: "guest", input: { ...emptySnapshot(), fireQueued: true } };
      channels.guest.input.send(JSON.stringify(guestInput));
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      const bundle = guestSeenMessages[0] as TickInputBundle;
      expect(bundle.inputs.guest.fireQueued).toBe(false);
      expect(bundle.heldInputFallback).not.toContain("guest"); // neutral, not "held" — a distinct code path
    });

    it("recovering to 'connected' before grace expires cancels the pending removal", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.input);
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      channels.connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2);
      channels.connection.setState("connected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(handle.getPlayerStatus("guest")).toBe("alive");
      const bundle = guestSeenMessages[0] as TickInputBundle;
      expect(bundle.rosterRemove).toBeUndefined();
      // Back on the ordinary bootstrap-transient held-fallback path, not the
      // forced-neutral grace path — proves recovery actually cleared
      // `neutralInputIds`, not just skipped the roster removal itself.
      expect(bundle.heldInputFallback).toContain("guest");
    });

    it("stop() before grace expires clears the timer, so it never fires after teardown", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      channels.connection.setState("disconnected");
      handle.stop();
      expect(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2)).not.toThrow();
      // No further tick was ever processed (worker is terminated) — this is
      // really just proving the timer callback itself never throws once its
      // captured closures reference an already-torn-down session.
    });

    it("a second 'disconnected' state while already in grace doesn't restart the timer", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      channels.connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
      channels.connection.setState("disconnected"); // e.g. a duplicate/spurious event
      vi.advanceTimersByTime(1);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(handle.getPlayerStatus("guest")).toBe("disconnected");
    });

    // Regression: a real `RTCDataChannel.send()` throws synchronously once
    // `readyState` isn't `"open"` — this mock doesn't enforce that (see its
    // own doc comment), so the bug this guards is verified by observing the
    // *skip* directly (readyState checked, no message sent) rather than by
    // simulating the throw itself. Caught for real by
    // `scripts/verify-multiplayer-disconnect.mjs`'s own real-transport run:
    // without the `readyState === "open"` guard in the production code, the
    // host's own simulation silently stalled forever the instant the
    // guest's real channel closed — every subsequent tick threw before ever
    // reaching `engine.advance()`, so `getSimTick()`/`getPlayerStatus()`
    // both froze mid-session with no error visible anywhere in the app.
    it("skips broadcasting (but keeps advancing the engine) once the input channel is no longer open", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.input);
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      (channels.host.input as unknown as { readyState: RTCDataChannelState }).readyState = "closed";
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(guestSeenMessages).toHaveLength(0);
      expect(handle.getLastAppliedTick()).toBe(0); // engine.advance() still ran
    });

    it("skips the periodic reconciliation broadcast once that channel is no longer open, without throwing", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenSnapshots = collectReconciliationMessages(channels.guest.reconciliation);
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      (channels.host.reconciliation as unknown as { readyState: RTCDataChannelState }).readyState = "closed";
      expect(() => worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent)).not.toThrow();

      expect(guestSeenSnapshots).toHaveLength(0);
      expect(handle.getLastAppliedTick()).toBe(0);
    });
  });

  describe("local Escape → dismissLoreOverlay (step 8)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("a raw local Escape keypress calls dismissLoreOverlay() on the underlying engine", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const dismissSpy = vi.spyOn(RaycasterEngine.prototype, "dismissLoreOverlay");
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(dismissSpy).toHaveBeenCalledTimes(1);
    });

    it("does not call dismissLoreOverlay() when no Escape was pressed", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const dismissSpy = vi.spyOn(RaycasterEngine.prototype, "dismissLoreOverlay");
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult(), worker);

      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(dismissSpy).not.toHaveBeenCalled();
    });
  });

  describe("level transition (step 8)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function winMap(overrides: Partial<GameMap> = {}, size = 12): GameMap {
      return fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 }, ...overrides }, size);
    }

    /** Drives exactly enough ticks for the host's own countdown to reach
     * zero and fire `onWin` — the first tick only *starts* it (see
     * `checkExit()`'s own doc comment), `COUNTDOWN_TICKS` further ticks are
     * needed to exhaust it. */
    function driveToWin(worker: ReturnType<typeof fakeWorker>): void {
      for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) {
        worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
      }
    }

    it("ends the session with reason 'campaign-complete' when no findNextLevel is provided at all", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, onSessionEnded);

      driveToWin(worker);
      // Even with no findNextLevel to await, `onWinFromEngine` is still an
      // async function — its own body doesn't resume until the next
      // microtask, same as the "resolves null" case below.
      await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));

      expect(onSessionEnded.mock.calls[0][1]).toBe("campaign-complete");
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("ends the session with reason 'campaign-complete' when findNextLevel resolves null (workspace exhausted)", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const onSessionEnded = vi.fn();
      const findNextLevel = vi.fn().mockResolvedValue(null);
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, onSessionEnded, findNextLevel);

      driveToWin(worker);
      await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));

      expect(onSessionEnded.mock.calls[0][1]).toBe("campaign-complete");
      expect(findNextLevel).toHaveBeenCalledTimes(1);
      const request = findNextLevel.mock.calls[0][0] as { carryovers: Record<PlayerId, EngineCarryover> };
      expect(Object.keys(request.carryovers).sort()).toEqual(["guest", "host"]);
    });

    it("broadcasts a chunked level-transition sequence and starts the new level once every guest acks", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.reconciliation) as unknown as LevelTransitionMessage[];
      const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 999 });
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, undefined, findNextLevel);

      driveToWin(worker);
      await vi.waitFor(() => {
        expect(guestSeenMessages.some((m) => m.type === "level-transition-map-end")).toBe(true);
      });

      // The channel also carries periodic `reconciliation-snapshot`
      // broadcasts throughout `driveToWin`'s many ticks — filter down to
      // just the transition sequence itself.
      const transitionMessages = guestSeenMessages.filter((m) => m.type.startsWith("level-transition"));
      expect(transitionMessages[0]).toMatchObject({ type: "level-transition-init", gameplaySeed: 999 });
      const chunkMessages = transitionMessages.filter((m) => m.type === "level-transition-map-chunk");
      expect(chunkMessages.length).toBeGreaterThan(0);
      expect(transitionMessages.at(-1)).toMatchObject({ type: "level-transition-map-end" });

      // Still mid-transition — waiting on the guest's own ack — the new
      // level hasn't actually started yet.
      expect(handle.getPlayerPosition("host")).toEqual({ x: 5.5, y: 5.5 });

      const ack: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest" };
      channels.guest.reconciliation.send(JSON.stringify(ack));
      await vi.waitFor(() => {
        expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
      });
    });

    it("logs and falls through to the ack-timeout path, instead of crashing the tick handler, when the transition send itself fails", async () => {
      // A real send() failure (readyState flipping mid-burst, a genuine
      // transport error — the actual root cause of a real CI failure this
      // guards against) must never crash `onWinFromEngine`'s own tick
      // handler; the guest that never received a complete transition also
      // never acks it, so it falls into the exact same "never acked in
      // time -> proceed anyway" path a merely-slow guest already takes.
      vi.useFakeTimers();
      const channels = linkedChannels();
      // Only the transition messages themselves fail — the periodic
      // reconciliation-snapshot broadcast (a real, unrelated send on this
      // same channel, happening throughout `driveToWin`'s many ticks) must
      // keep working normally, so this can't be a blanket "every send()
      // throws" mock.
      const realSend = channels.host.reconciliation.send.bind(channels.host.reconciliation);
      const sendSpy = vi.spyOn(channels.host.reconciliation, "send").mockImplementation((data) => {
        const str = data as unknown as string;
        if ((JSON.parse(str) as { type?: string }).type?.startsWith("level-transition")) {
          throw new Error("simulated RTCDataChannel send failure");
        }
        realSend(str);
      });
      const worker = fakeWorker();
      const nextMap = fakeMap({ spawn: { x: 9, y: 9 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, undefined, findNextLevel);

      driveToWin(worker);
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(TRANSITION_ACK_TIMEOUT_MS);

      // Proceeded to the new level anyway, despite every send having failed.
      expect(handle.getPlayerPosition("host")).toEqual({ x: 9.5, y: 9.5 });
    });

    it("revives a player who was dead at REVIVE_HEALTH in the carryover captured for the next level", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const canvas = makeCanvas();
      const size = 12;
      const g = walledRoom(size);
      g[3][3] = 2; // hazard tile, exactly on the guest's own spawn — at
      // HAZARD_DPS(18)/s, lethal (100 HP) after ~5.6s (~167 ticks)
      // sorted roster is ["guest", "host"] -> guest gets multiplayerSpawns[0]
      // (the hazard); host gets multiplayerSpawns[1], two tiles from the
      // exit — reached by holding "W" (default east facing), starting the
      // countdown only once it arrives, not at tick 0.
      const map = fakeMap(
        { grid: g, hazards: [{ x: 3, y: 3 }], exit: { x: 7, y: 5 }, multiplayerSpawns: [{ x: 3, y: 3 }, { x: 5, y: 5 }] },
        size,
      );
      const findNextLevel = vi.fn().mockResolvedValue({ map: fakeMap(), gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(channels.links, canvas, fakeResult({ map }), worker, undefined, findNextLevel);

      // Let the guest take real hazard damage for a while — well past its
      // own ~167-tick death — before the host even starts moving toward the
      // exit, so there's no race between "guest actually dies" and "host's
      // own 150-tick countdown completes": the countdown can't even start
      // until the host arrives, comfortably after this.
      for (let i = 0; i < 200; i++) worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
      expect(handle.getPlayerStatus("guest")).toBe("dead");

      canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
      for (let i = 200; i < 500 && findNextLevel.mock.calls.length === 0; i++) {
        worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
      }
      canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));

      await vi.waitFor(() => expect(findNextLevel).toHaveBeenCalledTimes(1));
      const request = findNextLevel.mock.calls[0][0] as { carryovers: Record<PlayerId, EngineCarryover> };
      expect(request.carryovers.guest.health).toBe(50); // REVIVE_HEALTH
      expect(request.carryovers.host.health).toBeGreaterThan(0); // never touched — still alive
    });

    it("proceeds without waiting forever once TRANSITION_ACK_TIMEOUT_MS elapses with no ack", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, undefined, findNextLevel);

      driveToWin(worker);
      return vi.waitFor(() => expect(findNextLevel).toHaveBeenCalledTimes(1)).then(async () => {
        await vi.advanceTimersByTimeAsync(TRANSITION_ACK_TIMEOUT_MS);
        expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
      });
    });

    it("an already-won engine's repeated onWin firing doesn't restart an in-progress transition", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      let resolveFindNextLevel: (value: { map: GameMap; gameplaySeed: number } | null) => void = () => {};
      const findNextLevel = vi.fn(() => new Promise<{ map: GameMap; gameplaySeed: number } | null>((resolve) => (resolveFindNextLevel = resolve)));
      runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, undefined, findNextLevel);

      driveToWin(worker);
      // The engine is already "won" — several more ticks (each re-firing
      // onWin, since neither onWin nor onGameOver edge-gate) arrive while
      // findNextLevel's own promise is still pending.
      worker.onmessage?.({ data: { type: "tick", tick: COUNTDOWN_TICKS + 1 } } as MessageEvent);
      worker.onmessage?.({ data: { type: "tick", tick: COUNTDOWN_TICKS + 2 } } as MessageEvent);
      await vi.waitFor(() => expect(findNextLevel).toHaveBeenCalledTimes(1));

      resolveFindNextLevel(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(findNextLevel).toHaveBeenCalledTimes(1); // never re-entered
    });

    it("does nothing if the session is torn down while findNextLevel's own lookup is still in flight", async () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const onSessionEnded = vi.fn();
      let resolveFindNextLevel: (value: { map: GameMap; gameplaySeed: number } | null) => void = () => {};
      const findNextLevel = vi.fn(() => new Promise<{ map: GameMap; gameplaySeed: number } | null>((resolve) => (resolveFindNextLevel = resolve)));
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, onSessionEnded, findNextLevel);

      driveToWin(worker);
      await vi.waitFor(() => expect(findNextLevel).toHaveBeenCalledTimes(1));

      handle.stop();
      resolveFindNextLevel({ map: fakeMap({ spawn: { x: 9, y: 9 } }), gameplaySeed: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Torn down before onSessionEnded's own "campaign-complete"/transition
      // path ever ran — main.ts's own teardown (e.g. leaving the session)
      // wins, not a stray late transition. `engine` itself isn't destroyed
      // by stop() (only the driver's own worker/listeners are), so position
      // still reads through it — the real assertion is that it's still on
      // the *original* map, never swapped to the late-resolved one.
      expect(onSessionEnded).not.toHaveBeenCalled();
      expect(handle.getPlayerPosition("host")).toEqual({ x: 5.5, y: 5.5 });
    });

    it("does nothing once the ack wait's own timeout fires after the session was already torn down", async () => {
      // `stop()` unsubscribes the ack listener itself (so a genuinely late
      // ack can never reach `waitForAcks` at all — nothing to test there),
      // but doesn't reach into `waitForAcks`'s own internal timer to cancel
      // it; that timer still fires on its own schedule regardless, and
      // `onWinFromEngine`'s own `if (ended) return;` right after the await
      // is what keeps that harmless once it does.
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenMessages = collectMessages(channels.guest.reconciliation) as unknown as LevelTransitionMessage[];
      const nextMap = fakeMap({ spawn: { x: 9, y: 9 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(channels.links, makeCanvas(), fakeResult({ map: winMap() }), worker, undefined, findNextLevel);

      driveToWin(worker);
      // Wait for the transition messages to have actually gone out — not
      // just for findNextLevel to have been *called* (that resolves on an
      // earlier microtask, before the broadcast+ack-wait code below it ever
      // runs) — so `stop()` below lands specifically inside the ack wait,
      // not the still-in-flight-lookup case the previous test covers.
      await vi.waitFor(() => {
        expect(guestSeenMessages.some((m) => m.type === "level-transition-map-end")).toBe(true);
      });
      handle.stop();

      await vi.advanceTimersByTimeAsync(TRANSITION_ACK_TIMEOUT_MS);

      // Still the original level — the timeout firing after teardown never
      // resurrected a torn-down transition.
      expect(handle.getPlayerPosition("host")).toEqual({ x: 5.5, y: 5.5 });
    });
  });

  describe("identity binding — link owner, not self-declared playerId (finding 1)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("attributes a TickInput to the link it actually arrived on, even if the message claims another player's id", () => {
      const { guest1, guest2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const guest1Seen = collectMessages(guest1.input);
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3 });
      runMultiplayerSessionAsHost(links, makeCanvas(), result, worker);

      // guest-2's own channel sends a TickInput spoofing playerId "guest-1".
      const spoofed: TickInput = { tick: 3, playerId: "guest-1", input: { ...emptySnapshot(), fireQueued: true } };
      guest2.input.send(JSON.stringify(spoofed));

      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      worker.onmessage?.({ data: { type: "tick", tick: 1 } } as MessageEvent);
      worker.onmessage?.({ data: { type: "tick", tick: 2 } } as MessageEvent);
      worker.onmessage?.({ data: { type: "tick", tick: 3 } } as MessageEvent);

      const bundleAt3 = guest1Seen.find((m): m is TickInputBundle => "inputs" in m && m.tick === 3);
      // Attributed to guest-2 (the true link owner) — guest-1 never actually
      // sent anything for tick 3, so it's still on the held-fallback path.
      expect(bundleAt3?.inputs["guest-2"].fireQueued).toBe(true);
      expect(bundleAt3?.heldInputFallback).toContain("guest-1");
    });

    it("attributes a level-transition-ack to the link it actually arrived on, even if the message claims another player's id", async () => {
      const { guest1, guest2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const guest1Seen = collectMessages(guest1.reconciliation) as unknown as LevelTransitionMessage[];
      const guest2Seen = collectMessages(guest2.reconciliation) as unknown as LevelTransitionMessage[];
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3, map: fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } }) });
      const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker, undefined, findNextLevel);

      for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
      await vi.waitFor(() => {
        expect(guest1Seen.some((m) => m.type === "level-transition-map-end")).toBe(true);
        expect(guest2Seen.some((m) => m.type === "level-transition-map-end")).toBe(true);
      });

      // guest-2's own channel sends an ack spoofing playerId "guest-1" — must
      // be attributed to guest-2 (the true link owner), not guest-1. If it
      // were wrongly attributed to guest-1, the still-pending real guest-1
      // ack below would never resolve `waitForAcks` (guest-1 would look
      // already-acked, guest-2 never actually acked).
      const spoofedAck: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest-1" };
      guest2.reconciliation.send(JSON.stringify(spoofedAck));
      // Still waiting — guest-1's own real ack hasn't arrived yet.
      expect(handle.getPlayerPosition("host")).toEqual({ x: 5.5, y: 5.5 });

      const realAck: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest-1" };
      guest1.reconciliation.send(JSON.stringify(realAck));
      await vi.waitFor(() => {
        expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
      });
    });
  });

  describe("N-player (step 10): multiple guests", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("broadcasts the identical finalized TickInputBundle to every connected guest", () => {
      const { guest1, guest2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const guest1Seen = collectMessages(guest1.input);
      const guest2Seen = collectMessages(guest2.input);
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3 });

      runMultiplayerSessionAsHost(links, makeCanvas(), result, worker);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(guest1Seen).toHaveLength(1);
      expect(guest2Seen).toHaveLength(1);
      expect(guest1Seen[0]).toEqual(guest2Seen[0]); // one canonical bundle, fanned out to both
    });

    it("a guest-2 disconnect doesn't affect guest-1's session — only guest-2 is marked disconnected", () => {
      vi.useFakeTimers();
      const { guest1, connection2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const guest1Seen = collectMessages(guest1.input);
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3 });
      const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker);

      connection2.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(handle.getPlayerStatus("guest-2")).toBe("disconnected");
      expect(handle.getPlayerStatus("guest-1")).toBe("alive");
      expect(handle.getPlayerStatus("host")).toBe("alive");
      const bundle = guest1Seen[0] as TickInputBundle;
      expect(bundle.rosterRemove).toEqual(["guest-2"]); // guest-1 never removed
    });

    it("a later guest-1 disconnect, after guest-2 already left, removes only guest-1", () => {
      vi.useFakeTimers();
      const { connection1, connection2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3 });
      const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker);

      connection2.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      expect(handle.getPlayerStatus("guest-2")).toBe("disconnected");
      expect(handle.getPlayerStatus("guest-1")).toBe("alive");

      connection1.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
      worker.onmessage?.({ data: { type: "tick", tick: 1 } } as MessageEvent);
      expect(handle.getPlayerStatus("guest-1")).toBe("disconnected");
      expect(handle.getPlayerStatus("host")).toBe("alive");
    });

    it("a solo host (0 connected guests) transitions immediately — nothing to wait an ack for", async () => {
      const links = new Map<PlayerId, HostGuestLink>();
      const worker = fakeWorker();
      const result = fakeResult({ roster: ["host"], playerCount: 1, map: fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } }) });
      const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
      const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker, undefined, findNextLevel);

      for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);

      // No guest to broadcast to or wait an ack from — `waitForAcks([], ...)`
      // resolves immediately, so the transition completes without needing a
      // timeout or any message traffic at all.
      await vi.waitFor(() => {
        expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
      });
    });

    it("skips the transition send to a guest whose channel isn't open, without blocking the others or throwing", async () => {
      vi.useFakeTimers();
      const { guest1: _guest1, guest2, links } = twoGuestLinks();
      const worker = fakeWorker();
      const guest2Seen = collectMessages(guest2.reconciliation) as unknown as LevelTransitionMessage[];
      const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3, map: fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } }) });
      const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
      const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });

      // guest-1's own reconciliation channel (the host's side of that link)
      // is already closed by the time the transition fires.
      (links.get("guest-1")!.channels.reconciliation as unknown as { readyState: RTCDataChannelState }).readyState = "closed";
      const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker, undefined, findNextLevel);

      for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
      await vi.waitFor(() => expect(guest2Seen.some((m) => m.type === "level-transition-map-end")).toBe(true));

      // guest-2 got the full transition; guest-1 never received anything
      // (its channel was closed, skipped without throwing) and will simply
      // time out via the ordinary ack-timeout path rather than crashing this
      // whole flow.
      const ack2: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest-2" };
      guest2.reconciliation.send(JSON.stringify(ack2));
      await vi.advanceTimersByTimeAsync(TRANSITION_ACK_TIMEOUT_MS);
      expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
    });

    describe("level transition waits for every connected guest's own ack", () => {
      function winMap3(): GameMap {
        return fakeMap({ spawn: { x: 5, y: 5 }, exit: { x: 5, y: 5 } });
      }

      it("proceeds only once both guests have acked, not just one", async () => {
        const { guest1, guest2, links } = twoGuestLinks();
        const worker = fakeWorker();
        const guest1Seen = collectMessages(guest1.reconciliation) as unknown as LevelTransitionMessage[];
        const guest2Seen = collectMessages(guest2.reconciliation) as unknown as LevelTransitionMessage[];
        const result = fakeResult({ roster: ["guest-1", "guest-2", "host"].sort(), playerCount: 3, map: winMap3() });
        const nextMap = fakeMap({ spawn: { x: 6, y: 6 } });
        const findNextLevel = vi.fn().mockResolvedValue({ map: nextMap, gameplaySeed: 1 });
        const handle = runMultiplayerSessionAsHost(links, makeCanvas(), result, worker, undefined, findNextLevel);

        for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) worker.onmessage?.({ data: { type: "tick", tick: i } } as MessageEvent);
        // Wait for the transition messages to have actually gone out to BOTH
        // guests (not just for findNextLevel to have been *called* — that
        // resolves on an earlier microtask, before the concurrent broadcast
        // + `waitForAcks` registration below it ever run) — otherwise an ack
        // sent too early arrives before `waitForAcks` is listening and is
        // silently dropped, the same "poll for the real synchronization
        // point, don't assume-and-race" lesson this project's own
        // cross-browser verify scripts already learned the hard way.
        await vi.waitFor(() => {
          expect(guest1Seen.some((m) => m.type === "level-transition-map-end")).toBe(true);
          expect(guest2Seen.some((m) => m.type === "level-transition-map-end")).toBe(true);
        });

        const ack1: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest-1" };
        guest1.reconciliation.send(JSON.stringify(ack1));
        // Still waiting on guest-2's own ack — the new level hasn't started.
        expect(handle.getPlayerPosition("host")).toEqual({ x: 5.5, y: 5.5 });

        const ack2: LevelTransitionAckMessage = { type: "level-transition-ack", playerId: "guest-2" };
        guest2.reconciliation.send(JSON.stringify(ack2));
        await vi.waitFor(() => {
          expect(handle.getPlayerPosition("host")).toEqual({ x: 6.5, y: 6.5 });
        });
      });
    });
  });
});

function emptySnapshot() {
  return {
    keys: [],
    mouseDX: 0,
    fireQueued: false,
    fireHeld: false,
    weaponRequest: null,
    mapToggle: false,
    interact: false,
    melee: false,
    meleeHeld: false,
    wheelSteps: 0,
    fpsToggle: false,
    escape: false,
    blur: false,
    pointerUnlock: false,
    click: false,
    gpForward: 0,
    gpStrafe: 0,
    gpTurn: 0,
  };
}
