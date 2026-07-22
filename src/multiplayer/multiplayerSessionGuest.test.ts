// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import type { EngineCarryover, PlayerId } from "../engine/engine";
import type { InputSnapshot } from "../engine/input";
import { COUNTDOWN_TICKS } from "../engine/transitionConstants";
import { chunkJson } from "./chunkedTransfer";
import type {
  LevelTransitionInitMessage,
  LevelTransitionMapChunkMessage,
  LevelTransitionMapEndMessage,
} from "./levelTransitionTypes";
import { LocalInputSampler } from "./localInputSampler";
import { DISCONNECT_GRACE_MS } from "./netcodeConstants";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { PlayerSnapshot, ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { HOST_PLAYER_ID } from "./sessionSetupTypes";
import type { SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

/** Same fake as `multiplayerSessionHost.test.ts`'s own — see its doc
 * comment. Not shared via an import: each test file keeps its dependencies
 * self-contained, the established pattern every other helper in these two
 * files already follows (`fakeMap`/`fakeResult`/`linkedChannels` are all
 * duplicated too, not extracted to a shared test-utils module). */
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

let runMultiplayerSessionAsGuest: typeof import("./multiplayerSessionGuest").runMultiplayerSessionAsGuest;
let RaycasterEngine: typeof import("../engine/engine").RaycasterEngine;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ runMultiplayerSessionAsGuest } = await import("./multiplayerSessionGuest"));
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
  // keeps this fixture's default state realistic, same reasoning
  // `multiplayerSessionHost.test.ts`'s own identical fixture gives (needed
  // there once the host driver started checking `readyState === "open"`
  // before broadcasting; needed here now that the guest's own
  // level-transition ack does the same).
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
    roster: ["guest", HOST_PLAYER_ID].sort(),
    assignedId: "guest",
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

function emptySnapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
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
    ...overrides,
  };
}

function collectMessages(channel: RTCDataChannel): (TickInput | TickInputBundle)[] {
  const messages: (TickInput | TickInputBundle)[] = [];
  channel.addEventListener("message", (event) => {
    messages.push(JSON.parse((event as MessageEvent).data as string));
  });
  return messages;
}

function fakePlayerSnapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    posX: 5.5,
    posY: 5.5,
    dirX: 1,
    dirY: 0,
    planeX: 0,
    planeY: 1,
    health: 100,
    swap: 0,
    ammo: { bullets: 0, rockets: 0, smg: 0, gas: 0 },
    weaponIndex: 0,
    keysHeld: 0,
    ownedWeapons: [0, 1, 2],
    alive: true,
    killScore: 0,
    kills: 0,
    ...overrides,
  };
}

function fakeReconciliationSnapshot(overrides: Partial<ReconciliationSnapshotMessage> = {}): ReconciliationSnapshotMessage {
  return {
    type: "reconciliation-snapshot",
    levelEpoch: 0,
    tick: 0,
    rngState: 0,
    players: { host: fakePlayerSnapshot(), guest: fakePlayerSnapshot() },
    enemies: [],
    mines: [],
    lootDrops: [],
    pickupsCollected: [],
    keysCollected: [],
    gridVersion: 0,
    gridDelta: [],
    ...overrides,
  };
}

describe("runMultiplayerSessionAsGuest", () => {
  it("applies a received bundle to the engine and samples+sends its own delayed input in response", () => {
    const channels = linkedChannels();
    const hostSeenMessages = collectMessages(channels.host.input);
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

    const bundle: TickInputBundle = {
      tick: 5,
      dt: 1 / 30,
      levelEpoch: 0,
      inputs: { host: emptySnapshot(), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    channels.host.input.send(JSON.stringify(bundle));

    expect(handle.getLastAppliedTick()).toBe(5);
    expect(hostSeenMessages).toHaveLength(1);
    expect(hostSeenMessages[0]).toMatchObject({ tick: 8, playerId: "guest" }); // 5 + INPUT_DELAY_TICKS(3)
  });

  it("applies every roster player's input from the bundle, not just its own", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      levelEpoch: 0,
      inputs: { host: emptySnapshot({ fireQueued: true }), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    channels.host.input.send(JSON.stringify(bundle));
    expect(() => handle.getPlayerPosition("host")).not.toThrow();
  });

  it("applies every roster player's input from a 3-player bundle (step 10: N-player), not just one other", () => {
    const channels = linkedChannels();
    const result = fakeResult({ roster: ["guest", "guest-2", "host"], assignedId: "guest" });
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), result);

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      levelEpoch: 0,
      inputs: { host: emptySnapshot(), guest: emptySnapshot(), "guest-2": emptySnapshot({ fireQueued: true }) },
      heldInputFallback: [],
    };
    channels.host.input.send(JSON.stringify(bundle));

    expect(() => handle.getPlayerPosition("host")).not.toThrow();
    expect(() => handle.getPlayerPosition("guest-2")).not.toThrow();
  });

  it("stop() is idempotent", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("ignores further bundles after teardown", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    handle.stop();

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      levelEpoch: 0,
      inputs: { host: emptySnapshot(), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    expect(() => channels.host.input.send(JSON.stringify(bundle))).not.toThrow();
    expect(handle.getLastAppliedTick()).toBeNull();
  });

  it("getPlayerPosition delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 6, y: 7 } }) }));
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 6.5, y: 7.5 });
    expect(handle.getPlayerPosition("nope")).toBeNull();
  });

  it("getPlayerFacing delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    expect(handle.getPlayerFacing("guest")).toEqual({ dirX: 1, dirY: 0 });
    expect(handle.getPlayerFacing("nope")).toBeNull();
  });

  it("getExitCountdownRemaining delegates to the underlying engine, real once a bundle lands the guest on the exit", () => {
    const size = 12;
    const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }));
    expect(handle.getExitCountdownRemaining()).toBeNull();
    const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
    channels.host.input.send(JSON.stringify(bundle));
    expect(handle.getExitCountdownRemaining()).toBe(COUNTDOWN_TICKS);
  });

  it("getMap/getEnemiesSnapshot/getMinesSnapshot/getBotPlayerState delegate to the underlying engine", () => {
    const map = fakeMap({ spawn: { x: 6, y: 7 } });
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }));
    expect(handle.getMap()).toBe(map);
    expect(handle.getEnemiesSnapshot()).toEqual([]);
    expect(handle.getMinesSnapshot()).toEqual([]);
    expect(handle.getBotPlayerState("guest")).toMatchObject({ x: 6.5, y: 7.5, state: "playing" });
    expect(handle.getBotPlayerState("nope")).toBeNull();
  });

  it("getDropsSnapshot/getKeysSnapshot delegate to the underlying engine", () => {
    const map = fakeMap({ keys: [{ x: 6, y: 6, collected: false }] });
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }));
    expect(handle.getDropsSnapshot()).toEqual([]);
    expect(handle.getKeysSnapshot()).toEqual([{ x: 6, y: 6 }]);
  });

  it("forwards onSessionEnded once game-over fires, after tearing down its own listener", () => {
    const channels = linkedChannels();
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // hazard tile at spawn
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const onSessionEnded = vi.fn();
    runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }), onSessionEnded);

    const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
    // FIXED_DT-paced ticks (1/30s each) — needs many more iterations than a
    // dt=1 advance() loop would to cover the same in-sim elapsed time.
    for (let i = 0; i < 300 && onSessionEnded.mock.calls.length === 0; i++) {
      channels.host.input.send(JSON.stringify({ ...bundle, tick: i }));
    }

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it("applies an incoming ReconciliationSnapshotMessage from the host, correcting its own simulated state", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 });

    const snapshot = fakeReconciliationSnapshot({
      players: {
        host: fakePlayerSnapshot({ posX: 8.5, posY: 8.5 }),
        guest: fakePlayerSnapshot({ posX: 2.5, posY: 3.5 }),
      },
    });
    channels.host.reconciliation.send(JSON.stringify(snapshot));

    expect(handle.getPlayerPosition("guest")).toEqual({ x: 2.5, y: 3.5 });
    expect(handle.getPlayerPosition("host")).toEqual({ x: 8.5, y: 8.5 });
  });

  it("discards a reconciliation snapshot stamped with a stale tick, instead of rewinding past its own already-applied tick (finding 6)", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));

    // Drive the guest past tick 5 via normal input-bundle application —
    // `input`/`reconciliation` are independent channels with no
    // cross-channel ordering, so a snapshot for an earlier tick can still
    // arrive after this.
    for (let tick = 0; tick <= 5; tick++) {
      const bundle: TickInputBundle = { tick, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
      channels.host.input.send(JSON.stringify(bundle));
    }
    expect(handle.getLastAppliedTick()).toBe(5);
    const beforePosition = handle.getPlayerPosition("guest");
    const beforeRngState = handle.getLastReconciliationRngState();

    // A stale snapshot, stamped for tick 2 — before the guest's own
    // already-applied tick 5. Applying it would rewind both gameplay state
    // and the shared PRNG stream backward.
    const staleSnapshot = fakeReconciliationSnapshot({
      tick: 2,
      rngState: 999999,
      players: { host: fakePlayerSnapshot({ posX: 1.5, posY: 1.5 }), guest: fakePlayerSnapshot({ posX: 1.5, posY: 1.5 }) },
    });
    channels.host.reconciliation.send(JSON.stringify(staleSnapshot));

    expect(handle.getPlayerPosition("guest")).toEqual(beforePosition); // unaffected — discarded, not applied
    expect(handle.getLastReconciliationRngState()).toBe(beforeRngState); // unchanged
  });

  it("still applies a reconciliation snapshot stamped for the exact current tick normally — the discard guard doesn't over-trigger", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));

    for (let tick = 0; tick <= 5; tick++) {
      const bundle: TickInputBundle = { tick, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
      channels.host.input.send(JSON.stringify(bundle));
    }
    expect(handle.getLastAppliedTick()).toBe(5);

    // Stamped for the exact tick just applied and the current level epoch —
    // must still apply normally.
    const currentSnapshot = fakeReconciliationSnapshot({
      tick: 5,
      levelEpoch: 0,
      rngState: 424242,
      players: { host: fakePlayerSnapshot({ posX: 7.5, posY: 7.5 }), guest: fakePlayerSnapshot({ posX: 3.5, posY: 4.5 }) },
    });
    channels.host.reconciliation.send(JSON.stringify(currentSnapshot));

    expect(handle.getPlayerPosition("guest")).toEqual({ x: 3.5, y: 4.5 });
    expect(handle.getLastReconciliationRngState()).toBe(424242);
  });

  it("discards a reconciliation snapshot stamped with a future tick, instead of double-simulating once in-flight bundles catch up (CRITICAL/HIGH re-review finding)", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));

    for (let tick = 0; tick <= 5; tick++) {
      const bundle: TickInputBundle = { tick, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
      channels.host.input.send(JSON.stringify(bundle));
    }
    expect(handle.getLastAppliedTick()).toBe(5);
    const beforePosition = handle.getPlayerPosition("guest");
    const beforeRngState = handle.getLastReconciliationRngState();

    // Stamped for tick 8 — ahead of what this guest has actually simulated
    // so far (its own input-channel bundles for ticks 6-8 haven't arrived
    // yet). Snapping to this now would be immediately overwritten by those
    // bundles applying on top once they do, double-advancing state and the
    // shared PRNG past the host.
    const futureSnapshot = fakeReconciliationSnapshot({
      tick: 8,
      levelEpoch: 0,
      rngState: 999999,
      players: { host: fakePlayerSnapshot({ posX: 1.5, posY: 1.5 }), guest: fakePlayerSnapshot({ posX: 1.5, posY: 1.5 }) },
    });
    channels.host.reconciliation.send(JSON.stringify(futureSnapshot));

    expect(handle.getPlayerPosition("guest")).toEqual(beforePosition); // unaffected — discarded, not applied
    expect(handle.getLastReconciliationRngState()).toBe(beforeRngState); // unchanged
  });


  it("stops applying reconciliation snapshots after teardown", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));
    handle.stop();

    const snapshot = fakeReconciliationSnapshot({ players: { host: fakePlayerSnapshot(), guest: fakePlayerSnapshot({ posX: 9.5, posY: 9.5 }) } });
    expect(() => channels.host.reconciliation.send(JSON.stringify(snapshot))).not.toThrow();
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 }); // unchanged — never applied
  });

  it("getRngState/debugInjectDesync/hasActiveRenderOffset delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    const before = handle.getPlayerPosition("guest");
    handle.debugInjectDesync({ kind: "position", deltaTiles: 0.2 });
    expect(handle.getPlayerPosition("guest")).toEqual({ x: before!.x + 0.2, y: before!.y });
    expect(typeof handle.getRngState()).toBe("number");
    expect(handle.hasActiveRenderOffset("guest")).toBe(false);
  });

  it("debugSetGodMode delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    expect(() => handle.debugSetGodMode("guest", true)).not.toThrow();
  });

  it("getLastReconciliationRngState reflects the rngState of the most recently applied snapshot, null before the first one", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    expect(handle.getLastReconciliationRngState()).toBeNull();

    const snapshot = fakeReconciliationSnapshot({ rngState: 424242 });
    channels.host.reconciliation.send(JSON.stringify(snapshot));

    expect(handle.getLastReconciliationRngState()).toBe(424242);
  });

  describe("network/netcode-quality telemetry (step 11 Phase 2b)", () => {
    it("getConnectionStats(HOST_PLAYER_ID) reads the active candidate pair's currentRoundTripTime off the injected connection, null otherwise", async () => {
      const channels = linkedChannels();
      const connection = new FakeConnection();
      connection.rttSeconds = 0.03;
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), undefined, connection);

      await expect(handle.getConnectionStats(HOST_PLAYER_ID)).resolves.toEqual({ rttMs: 30 });
      // A guest only ever has one link, toward the host — any other id resolves null.
      await expect(handle.getConnectionStats("guest")).resolves.toBeNull();

      // No connection injected at all (this module's own `connection` param is optional).
      const handleNoConnection = runMultiplayerSessionAsGuest(linkedChannels().guest, makeCanvas(), fakeResult());
      await expect(handleNoConnection.getConnectionStats(HOST_PLAYER_ID)).resolves.toBeNull();
    });

    it("getMissedTickStats tallies heldInputFallback occurrences per player across bundles, seeded at 0 for every roster id", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      expect(handle.getMissedTickStats()).toEqual({ totalTicks: 0, missedTicksByPlayer: { guest: 0, host: 0 } });

      const bundle: TickInputBundle = {
        tick: 5,
        dt: 1 / 30,
      levelEpoch: 0,
        inputs: { host: emptySnapshot(), guest: emptySnapshot() },
        heldInputFallback: ["host"],
      };
      channels.host.input.send(JSON.stringify(bundle));
      expect(handle.getMissedTickStats()).toEqual({ totalTicks: 1, missedTicksByPlayer: { guest: 0, host: 1 } });
    });

    it("getReconciliationCorrections counts only above-noise-floor position deltas, per player, seeded at 0 for every roster id", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));
      expect(handle.getReconciliationCorrections()).toEqual({
        guest: { count: 0, totalMagnitudeTiles: 0 },
        host: { count: 0, totalMagnitudeTiles: 0 },
      });

      // Same position both players already have — below the noise floor, not a real correction.
      channels.host.reconciliation.send(
        JSON.stringify(
          fakeReconciliationSnapshot({
            players: { host: fakePlayerSnapshot({ posX: 5.5, posY: 5.5 }), guest: fakePlayerSnapshot({ posX: 5.5, posY: 5.5 }) },
          }),
        ),
      );
      expect(handle.getReconciliationCorrections()).toEqual({
        guest: { count: 0, totalMagnitudeTiles: 0 },
        host: { count: 0, totalMagnitudeTiles: 0 },
      });

      // A real correction, for guest only — host's own position is unchanged from the previous snapshot.
      channels.host.reconciliation.send(
        JSON.stringify(
          fakeReconciliationSnapshot({
            players: { host: fakePlayerSnapshot({ posX: 5.5, posY: 5.5 }), guest: fakePlayerSnapshot({ posX: 2.5, posY: 3.5 }) },
          }),
        ),
      );
      const corrections = handle.getReconciliationCorrections();
      expect(corrections.host).toEqual({ count: 0, totalMagnitudeTiles: 0 });
      expect(corrections.guest.count).toBe(1);
      expect(corrections.guest.totalMagnitudeTiles).toBeCloseTo(Math.hypot(2.5 - 5.5, 3.5 - 5.5));
    });
  });

  it("applies a bundle's rosterRemove before advancing that tick, same synchronized ordering the host itself uses", () => {
    const channels = linkedChannels();
    // Distinct multiplayerSpawns, far apart — the default map spawns both
    // players on the same tile, which would have the guest immediately
    // auto-collect the disconnect-converted loot in the same tick it's
    // dropped, leaving nothing in getLootDrops() to observe below.
    const map = fakeMap({ multiplayerSpawns: [{ x: 2, y: 2 }, { x: 9, y: 9 }] });
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }));
    expect(handle.getPlayerStatus("host")).toBe("alive");

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      levelEpoch: 0,
      inputs: { host: emptySnapshot(), guest: emptySnapshot() },
      heldInputFallback: [],
      rosterRemove: ["host"],
    };
    channels.host.input.send(JSON.stringify(bundle));

    expect(handle.getPlayerStatus("host")).toBe("disconnected");
    expect(handle.getLootDrops().some((d) => d.id?.startsWith("disconnect:host:"))).toBe(true);
  });

  it("a bundle with no rosterRemove field leaves every roster player's status untouched", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

    const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
    channels.host.input.send(JSON.stringify(bundle));

    expect(handle.getPlayerStatus("host")).toBe("alive");
    expect(handle.getPlayerStatus("guest")).toBe("alive");
  });

  describe("host-disconnect handling (step 8, guest side)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does nothing without an injected connection", () => {
      const channels = linkedChannels();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded);
      expect(onSessionEnded).not.toHaveBeenCalled();
    });

    it("ends the session with reason 'host-disconnected' once the connection stays down for the full grace period", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

      expect(onSessionEnded).toHaveBeenCalledTimes(1);
      expect(onSessionEnded.mock.calls[0][1]).toBe("host-disconnected");
    });

    it("detaches the local input sampler on the 'host-disconnected' ending, which never calls startLevel() again (finding 3)", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      const detachSpy = vi.spyOn(LocalInputSampler.prototype, "detach");
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

      expect(onSessionEnded).toHaveBeenCalledTimes(1);
      expect(detachSpy).toHaveBeenCalled();
      detachSpy.mockRestore();
    });

    it("does not fire before the grace period has fully elapsed", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);

      expect(onSessionEnded).not.toHaveBeenCalled();
    });

    it("a second 'disconnected' state while already in grace doesn't restart the timer", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
      connection.setState("disconnected"); // e.g. a duplicate/spurious event
      vi.advanceTimersByTime(1);

      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it("recovering to 'connected' before grace expires cancels the pending end", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2);
      connection.setState("connected");
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS);

      expect(onSessionEnded).not.toHaveBeenCalled();
    });

    it("stop() before grace expires prevents it from firing after teardown", () => {
      vi.useFakeTimers();
      const channels = linkedChannels();
      const connection = new FakeConnection();
      const onSessionEnded = vi.fn();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult(), onSessionEnded, connection);

      connection.setState("disconnected");
      handle.stop();
      vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);

      expect(onSessionEnded).not.toHaveBeenCalled();
    });
  });

  describe("local Escape → dismissLoreOverlay (step 8)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("a raw local Escape keypress calls dismissLoreOverlay() on the underlying engine once the next bundle arrives", () => {
      const channels = linkedChannels();
      const dismissSpy = vi.spyOn(RaycasterEngine.prototype, "dismissLoreOverlay");
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
      const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
      channels.host.input.send(JSON.stringify(bundle));

      expect(dismissSpy).toHaveBeenCalledTimes(1);
    });

    it("does not call dismissLoreOverlay() when no Escape was pressed", () => {
      const channels = linkedChannels();
      const dismissSpy = vi.spyOn(RaycasterEngine.prototype, "dismissLoreOverlay");
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

      const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
      channels.host.input.send(JSON.stringify(bundle));

      expect(dismissSpy).not.toHaveBeenCalled();
    });
  });

  describe("level transition (step 8)", () => {
    /** Sends the same init -> chunk(s) -> end sequence the real host driver
     * broadcasts, mirroring `sessionSetupHost.ts`'s own chunking of its
     * initial map transfer. */
    function sendLevelTransition(
      channels: { host: MultiplayerChannels; guest: MultiplayerChannels },
      map: GameMap,
      carryovers: Record<PlayerId, EngineCarryover>,
      gameplaySeed: number,
    ): void {
      const { visited: _visited, ...mapWithoutVisited } = map;
      const initMessage: LevelTransitionInitMessage = { type: "level-transition-init", carryovers, gameplaySeed };
      channels.host.reconciliation.send(JSON.stringify(initMessage));
      const chunks = chunkJson(mapWithoutVisited, 16 * 1024);
      chunks.forEach((data, index) => {
        const chunkMessage: LevelTransitionMapChunkMessage = { type: "level-transition-map-chunk", index, data };
        channels.host.reconciliation.send(JSON.stringify(chunkMessage));
      });
      const endMessage: LevelTransitionMapEndMessage = { type: "level-transition-map-end", totalChunks: chunks.length };
      channels.host.reconciliation.send(JSON.stringify(endMessage));
    }

    it("reassembles the map, applies carryovers, sends an ack, and swaps in a new engine", () => {
      const channels = linkedChannels();
      const hostSeenMessages = collectMessages(channels.host.reconciliation as unknown as RTCDataChannel) as unknown as { type: string }[];
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 }); // default fakeMap() spawn

      const nextMap = fakeMap({ spawn: { x: 7, y: 7 } });
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 66, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, nextMap, carryovers, 999);

      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 });
      expect(handle.getPlayerStatus("guest")).toBe("alive");
      expect(hostSeenMessages).toContainEqual({ type: "level-transition-ack", playerId: "guest" });
    });

    it("discards a stale-epoch tick-input bundle arriving after a level transition, instead of advancing the freshly-swapped engine (finding 7)", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 }); // default fakeMap() spawn

      const nextMap = fakeMap({ spawn: { x: 7, y: 7 } });
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, nextMap, carryovers, 1); // bumps the guest's own levelEpoch from 0 to 1
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 }); // swapped to the new level

      // A pre-transition (epoch 0) TickInputBundle, still in flight on the
      // independent `input` channel with no cross-channel ordering guarantee
      // toward `reconciliation` (which the transition itself rode) — must be
      // discarded, never applied against the freshly-swapped engine.
      const staleBundle: TickInputBundle = {
        tick: 999,
        dt: 1 / 30,
        levelEpoch: 0,
        inputs: { host: emptySnapshot(), guest: emptySnapshot() },
        heldInputFallback: [],
      };
      channels.host.input.send(JSON.stringify(staleBundle));

      expect(handle.getLastAppliedTick()).toBeNull(); // discarded — never applied
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 }); // unchanged
    });

    it("discards a reconciliation snapshot stamped with a stale level epoch after a transition, even though lastAppliedTick was just reset to null (CRITICAL re-review finding)", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

      const nextMap = fakeMap({ spawn: { x: 7, y: 7 } });
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, nextMap, carryovers, 1); // bumps the guest's own levelEpoch from 0 to 1
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 }); // swapped to the new level
      expect(handle.getLastAppliedTick()).toBeNull(); // reset alongside the epoch bump

      // A snapshot still stamped with the OLD level's epoch (0), as if
      // broadcast by the host's tick worker before it caught up to the
      // transition. `lastAppliedTick` being null means a tick-only guard
      // would let this straight through — the epoch mismatch alone must
      // discard it, or it would permanently overwrite the new level's grid/
      // player state with the old level's.
      const staleEpochSnapshot = fakeReconciliationSnapshot({
        tick: 999,
        levelEpoch: 0,
        rngState: 555555,
        players: { host: fakePlayerSnapshot({ posX: 9.5, posY: 9.5 }), guest: fakePlayerSnapshot({ posX: 9.5, posY: 9.5 }) },
      });
      channels.host.reconciliation.send(JSON.stringify(staleEpochSnapshot));

      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 }); // unaffected — discarded, not applied
      expect(handle.getLastReconciliationRngState()).toBeNull(); // never applied
    });

    it("still applies a current-epoch tick-input bundle normally after a level transition", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

      const nextMap = fakeMap({ spawn: { x: 7, y: 7 } });
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, nextMap, carryovers, 1); // bumps the guest's own levelEpoch from 0 to 1

      const currentBundle: TickInputBundle = {
        tick: 0,
        dt: 1 / 30,
        levelEpoch: 1,
        inputs: { host: emptySnapshot(), guest: emptySnapshot() },
        heldInputFallback: [],
      };
      channels.host.input.send(JSON.stringify(currentBundle));

      expect(handle.getLastAppliedTick()).toBe(0); // applied normally — not stale
    });

    it("carries each player's own health from the carryover into the new level", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 42, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 66, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, fakeMap(), carryovers, 1);

      // No public per-player-health hook on MultiplayerSessionHandle — the
      // engine reaching game over from a hazard at exactly this health is
      // the only externally-observable proxy available here (the real
      // per-field carryover mapping itself is already covered directly by
      // `engine.test.ts`'s own `captureCarryoverFor`/`addPlayer` carryover
      // tests) — status staying "alive" at all is still a meaningful signal
      // that construction didn't reject/ignore the carryover outright.
      expect(handle.getPlayerStatus("guest")).toBe("alive");
      expect(handle.getPlayerStatus("host")).toBe("alive");
    });

    it("ignores a stray map-chunk/map-end with no preceding init — nothing to reassemble", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      const before = handle.getPlayerPosition("guest");

      const chunkMessage: LevelTransitionMapChunkMessage = { type: "level-transition-map-chunk", index: 0, data: "{}" };
      channels.host.reconciliation.send(JSON.stringify(chunkMessage));
      const endMessage: LevelTransitionMapEndMessage = { type: "level-transition-map-end", totalChunks: 1 };
      expect(() => channels.host.reconciliation.send(JSON.stringify(endMessage))).not.toThrow();

      expect(handle.getPlayerPosition("guest")).toEqual(before);
    });

    it("ignores an incomplete chunk sequence — never starts the new level", () => {
      const channels = linkedChannels();
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
      const before = handle.getPlayerPosition("guest");

      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      const initMessage: LevelTransitionInitMessage = { type: "level-transition-init", carryovers, gameplaySeed: 1 };
      channels.host.reconciliation.send(JSON.stringify(initMessage));
      // Claims 2 chunks arrived but only 1 was ever actually sent.
      const endMessage: LevelTransitionMapEndMessage = { type: "level-transition-map-end", totalChunks: 2 };
      channels.host.reconciliation.send(JSON.stringify(endMessage));

      expect(handle.getPlayerPosition("guest")).toEqual(before);
    });

    it("does not send an ack when the reconciliation channel is no longer open, but still starts the new level", () => {
      const channels = linkedChannels();
      const hostSeenMessages = collectMessages(channels.host.reconciliation as unknown as RTCDataChannel) as unknown as { type: string }[];
      const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

      (channels.guest.reconciliation as unknown as { readyState: RTCDataChannelState }).readyState = "closed";
      const nextMap = fakeMap({ spawn: { x: 7, y: 7 } });
      const carryovers: Record<PlayerId, EngineCarryover> = {
        host: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
        guest: { health: 100, swap: 0, bullets: 0, rockets: 0, smg: 0, gas: 0 },
      };
      sendLevelTransition(channels, nextMap, carryovers, 1);

      expect(hostSeenMessages.some((m) => m.type === "level-transition-ack")).toBe(false);
      expect(handle.getPlayerPosition("guest")).toEqual({ x: 7.5, y: 7.5 });
    });

    it("reaching a local win does not end the session by itself — only the host's own transition/campaign-complete decides that", () => {
      const size = 12;
      const map = fakeMap({ spawn: { x: size - 2, y: size - 2 }, exit: { x: size - 2, y: size - 2 } }, size);
      const channels = linkedChannels();
      const onSessionEnded = vi.fn();
      runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }), onSessionEnded);

      for (let i = 0; i < COUNTDOWN_TICKS + 1; i++) {
        const bundle: TickInputBundle = { tick: i, dt: 1 / 30, levelEpoch: 0, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
        channels.host.input.send(JSON.stringify(bundle));
      }

      expect(onSessionEnded).not.toHaveBeenCalled();
    });
  });
});
