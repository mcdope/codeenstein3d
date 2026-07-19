// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import { DISCONNECT_GRACE_MS, RECONCILE_INTERVAL_TICKS } from "./netcodeConstants";
import type { ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID } from "./sessionSetupTypes";
import type { SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

/** A small fake of the `ConnectionStateSource` slice of `RTCPeerConnection`
 * — same spirit as `FakeRTCDataChannel`, this project's test environment has
 * no real `RTCPeerConnection`. */
class FakeConnection {
  connectionState: RTCPeerConnectionState = "connected";
  private readonly listeners = new Set<() => void>();
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

function linkedChannels(): { host: MultiplayerChannels; guest: MultiplayerChannels } {
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
    roster: [GUEST_PLAYER_ID, HOST_PLAYER_ID].sort(),
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

/** Collects every JSON message sent on a channel (guest's own view of what
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

    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
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

    runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

    const bundle = guestSeenMessages[0] as TickInputBundle;
    expect(bundle.heldInputFallback).toContain("guest");
  });

  it("records the guest's own TickInput arriving on the input channel into the delay buffer", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const guestSeenMessages = collectMessages(channels.guest.input);

    runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);

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
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
    handle.stop();
    handle.stop();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("ignores further tick-due messages after teardown (re-entrancy guard for a batch of queued ticks)", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
    handle.stop();
    expect(() => worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent)).not.toThrow();
    expect(handle.getLastAppliedTick()).toBeNull();
  });

  it("getPlayerPosition delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 4, y: 4 } }) }), worker);
    expect(handle.getPlayerPosition("host")).toEqual({ x: 4.5, y: 4.5 });
    expect(handle.getPlayerPosition("nope")).toBeNull();
  });

  it("getPlayerStatus/getLootDrops delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
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
    runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult({ map }), worker, onSessionEnded);

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

    runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
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
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
    expect(handle.getLastReconciliationRngState()).toBeNull();

    worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
    expect(handle.getLastReconciliationRngState()).toBe(handle.getRngState());
  });

  it("getRngState/debugInjectDesync/hasActiveRenderOffset delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const worker = fakeWorker();
    const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
    const before = handle.getRngState();
    handle.debugInjectDesync({ kind: "extraRngDraw" });
    expect(handle.getRngState()).not.toBe(before);
    expect(handle.hasActiveRenderOffset("host")).toBe(false);
  });

  describe("disconnect handling (step 8, host side)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does nothing without an injected connection — disconnect detection simply never triggers", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);
      expect(handle.getPlayerStatus("guest")).toBe("alive");
    });

    it("applies rosterRemove and marks the guest disconnected once the connection stays down for the full grace period", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const worker = fakeWorker();
      const connection = new FakeConnection();
      const guestSeenMessages = collectMessages(channels.guest.input);
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker, undefined, connection);

      connection.setState("disconnected");
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
      const connection = new FakeConnection();
      const guestSeenMessages = collectMessages(channels.guest.input);
      runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker, undefined, connection);

      connection.setState("disconnected");
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
      const connection = new FakeConnection();
      const guestSeenMessages = collectMessages(channels.guest.input);
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker, undefined, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2);
      connection.setState("connected");
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
      const connection = new FakeConnection();
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker, undefined, connection);

      connection.setState("disconnected");
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
      const connection = new FakeConnection();
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker, undefined, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
      connection.setState("disconnected"); // e.g. a duplicate/spurious event
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
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);

      (channels.host.input as unknown as { readyState: RTCDataChannelState }).readyState = "closed";
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(guestSeenMessages).toHaveLength(0);
      expect(handle.getLastAppliedTick()).toBe(0); // engine.advance() still ran
    });

    it("skips the periodic reconciliation broadcast once that channel is no longer open, without throwing", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const guestSeenSnapshots = collectReconciliationMessages(channels.guest.reconciliation);
      const handle = runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);

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
      runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);

      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(dismissSpy).toHaveBeenCalledTimes(1);
    });

    it("does not call dismissLoreOverlay() when no Escape was pressed", () => {
      const channels = linkedChannels();
      const worker = fakeWorker();
      const dismissSpy = vi.spyOn(RaycasterEngine.prototype, "dismissLoreOverlay");
      runMultiplayerSessionAsHost(channels.host, makeCanvas(), fakeResult(), worker);

      worker.onmessage?.({ data: { type: "tick", tick: 0 } } as MessageEvent);

      expect(dismissSpy).not.toHaveBeenCalled();
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
