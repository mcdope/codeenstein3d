// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import type { GameMap, Tile } from "../map/types";
import { runGuestSessionSetup } from "./sessionSetupGuest";
import {
  buildHostSessionSetupResult,
  runHostSessionSetupPhaseA,
  runHostSessionSetupPhaseB,
  type HostSessionSetupOptions,
} from "./sessionSetupHost";
import { HOST_PLAYER_ID, SessionSetupError, type SessionSetupMessage } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

/** Two host/guest `MultiplayerChannels` pairs, both channels linked so a
 * `send()` on either side dispatches a `"message"` event on the other —
 * mirrors a real connected `RTCPeerConnection` pair closely enough for the
 * session-setup handshake, which never touches `input`. */
function linkedChannels(): { host: MultiplayerChannels; guest: MultiplayerChannels } {
  const hostReconciliation = new FakeRTCDataChannel("reconciliation");
  const guestReconciliation = new FakeRTCDataChannel("reconciliation");
  hostReconciliation.link(guestReconciliation);

  const hostInput = new FakeRTCDataChannel("input");
  const guestInput = new FakeRTCDataChannel("input");
  hostInput.link(guestInput);

  // A real session-setup handshake only ever starts once both peers'
  // channels are already `readyState: "open"` (the host's own "Start
  // Session" button stays disabled/unclickable until then) —
  // `sendJsonWithBackpressure` now enforces that for real, so these fakes
  // must model it too, matching every other multiplayer test file's own
  // "open before use" setup.
  for (const channel of [hostReconciliation, guestReconciliation, hostInput, guestInput]) channel.simulateOpen();

  return {
    host: { input: hostInput as unknown as RTCDataChannel, reconciliation: hostReconciliation as unknown as RTCDataChannel },
    guest: { input: guestInput as unknown as RTCDataChannel, reconciliation: guestReconciliation as unknown as RTCDataChannel },
  };
}

/** A `GameMap` fixture whose JSON serialization genuinely exceeds 16 KiB
 * (the map-chunk size), so tests exercise real multi-chunk transfer rather
 * than a single-chunk edge case — a 150x150 grid (matching this project's
 * real max map size) of single-digit tile values comfortably clears it. */
function bigFakeMap(size = 150): GameMap {
  const grid: Tile[][] = Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
  return {
    width: size,
    height: size,
    grid,
    visited: Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
    shortestPathTiles: 4,
    hazards: [],
    doors: [],
    gates: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    styleSet: "stone",
    secretRoomCount: 0,
    switchboardRooms: [],
    exceptionZones: [],
    vendorDepots: [],
    acidOverflows: [],
  };
}

/** Both host phases for one guest, back to back — what `main.ts` does per
 * guest, with the barrier between them collapsed because these tests only
 * ever have one guest's names to merge. Tests that care about the phases
 * separately call them directly instead. */
async function runHostSetup(
  channels: MultiplayerChannels,
  assignedId: string,
  options: Omit<HostSessionSetupOptions, "displayNames">,
): Promise<void> {
  const guestName = await runHostSessionSetupPhaseA(channels);
  await runHostSessionSetupPhaseB(channels, assignedId, { ...options, displayNames: { [assignedId]: guestName } });
}

describe("runHostSessionSetup / runGuestSessionSetup — successful handshake", () => {
  it("host and guest converge on the same session shape, exercising real multi-chunk map transfer", async () => {
    const channels = linkedChannels();
    const map = bigFakeMap();
    expect(JSON.stringify(map).length).toBeGreaterThan(16 * 1024); // sanity: the fixture is genuinely big
    const options: HostSessionSetupOptions = { map, difficulty: "hard", roster: ["guest", "host"], gameplaySeed: 42, displayNames: {} };

    // Guest first: it only ever listens on `runGuestSessionSetup()` (never
    // sends until the host's own build-version arrives), so its listener
    // must be attached before the host's synchronous outbound send below —
    // see sessionSetupGuest.ts's doc comment for the real race this order
    // guards against.
    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSetup(channels.host, "guest", options)]);
    const hostResult = buildHostSessionSetupResult(options);

    expect(guestResult.roster).toEqual(["guest", "host"]);
    expect(guestResult.tickRateHz).toBe(hostResult.tickRateHz);
    expect(guestResult.fixedDt).toBe(hostResult.fixedDt);
    expect(guestResult.inputDelayTicks).toBe(hostResult.inputDelayTicks);
    expect(guestResult.gameplaySeed).toBe(hostResult.gameplaySeed);
    expect(guestResult.gameplaySeed).toBe(42);
    expect(guestResult.difficulty).toBe("hard");
    expect(guestResult.playerCount).toBe(2);
    expect(guestResult.map).toEqual(map);
  });

  it("assigns HOST_PLAYER_ID to the host's own result and the given assignedId to the guest's", async () => {
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    // See the previous test's comment on why guest must go first.
    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSetup(channels.host, "guest", options)]);
    const hostResult = buildHostSessionSetupResult(options);

    expect(hostResult.assignedId).toBe(HOST_PLAYER_ID);
    expect(guestResult.assignedId).toBe("guest");
  });
});

describe("runHostSessionSetup — ignores unexpected message types", () => {
  it("ignores a stray non-build-version message and still completes once the real build-version arrives", async () => {
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };
    const hostPromise = runHostSetup(channels.host, "guest", options);

    // A rogue guest sending a stray, unexpected message type before its real
    // build-version — isolates the host's own tolerance for it, same manual
    // "rogue guest" pattern as the mismatch test below (rather than the real
    // `runGuestSessionSetup`, which never sends this message type at all).
    const stray: SessionSetupMessage = { type: "map-chunk", index: 0, data: "{}" };
    channels.guest.reconciliation.send(JSON.stringify(stray));
    const realVersion: SessionSetupMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    channels.guest.reconciliation.send(JSON.stringify(realVersion));
    const name: SessionSetupMessage = { type: "player-name", name: "" };
    channels.guest.reconciliation.send(JSON.stringify(name));

    await expect(hostPromise).resolves.toBeUndefined();
  });
});

describe("runHostSessionSetup — build-version mismatch", () => {
  it("rejects when the guest's build-version doesn't match, and sends nothing further", async () => {
    const channels = linkedChannels();
    const sendSpy = vi.spyOn(channels.host.reconciliation, "send");
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const hostPromise = runHostSetup(channels.host, "guest", options);

    // A rogue guest sending a mismatched build-version instead of the real
    // runGuestSessionSetup — isolates the host's own mismatch handling.
    const rogueVersion: SessionSetupMessage = { type: "build-version", ref: "other-build-ref", time: "other-build-time" };
    channels.guest.reconciliation.send(JSON.stringify(rogueVersion));

    await expect(hostPromise).rejects.toMatchObject({ code: "build-version-mismatch" });
    await expect(hostPromise).rejects.toBeInstanceOf(SessionSetupError);

    // Only the host's own outbound build-version — no session-init/map-chunk/map-end.
    const sentTypes = sendSpy.mock.calls.map((call) => (JSON.parse(call[0] as unknown as string) as SessionSetupMessage).type);
    expect(sentTypes).toEqual(["build-version"]);
  });
});

describe("runHostSessionSetup — send failures", () => {
  it("rejects if the host's own outbound build-version send fails (channel not open)", async () => {
    const channels = linkedChannels();
    (channels.host.reconciliation as unknown as FakeRTCDataChannel).readyState = "closing";
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const hostPromise = runHostSetup(channels.host, "guest", options);

    await expect(hostPromise).rejects.toThrow(/readyState is "closing"/);
  });

  it("rejects if phase B's sendJsonSequence (session-init + map chunks) fails", async () => {
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const phaseA = runHostSessionSetupPhaseA(channels.host);
    const realVersion: SessionSetupMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    channels.guest.reconciliation.send(JSON.stringify(realVersion));
    channels.guest.reconciliation.send(JSON.stringify({ type: "player-name", name: "" } satisfies SessionSetupMessage));
    await phaseA;

    // Phase A's sends already succeeded (channel was open) — close it now, so
    // phase B's session-init is what fails.
    (channels.host.reconciliation as unknown as FakeRTCDataChannel).readyState = "closing";
    await expect(runHostSessionSetupPhaseB(channels.host, "guest", options)).rejects.toThrow(/readyState is "closing"/);
  });
});

describe("runHostSessionSetup — multiple guests (step 10: N-player)", () => {
  it("sets up each guest independently, with the same roster/seed but its own assignedId", async () => {
    const linkA = linkedChannels(); // host <-> guest-1
    const linkB = linkedChannels(); // host <-> guest-2
    const options: HostSessionSetupOptions = {
      map: bigFakeMap(10),
      difficulty: "normal",
      roster: ["guest-1", "guest-2", "host"],
      gameplaySeed: 777,
      displayNames: {},
    };

    // Both guests' listeners attached before either host setup call sends
    // anything — same ordering discipline as the 2-player test above,
    // applied per guest.
    const [guest1Result, guest2Result] = await Promise.all([
      runGuestSessionSetup(linkA.guest),
      runGuestSessionSetup(linkB.guest),
      runHostSetup(linkA.host, "guest-1", options),
      runHostSetup(linkB.host, "guest-2", options),
    ]);
    const hostResult = buildHostSessionSetupResult(options);

    expect(guest1Result.assignedId).toBe("guest-1");
    expect(guest2Result.assignedId).toBe("guest-2");
    expect(guest1Result.roster).toEqual(["guest-1", "guest-2", "host"]);
    expect(guest2Result.roster).toEqual(["guest-1", "guest-2", "host"]);
    expect(guest1Result.gameplaySeed).toBe(guest2Result.gameplaySeed);
    expect(hostResult.assignedId).toBe(HOST_PLAYER_ID);
    expect(hostResult.roster).toEqual(["guest-1", "guest-2", "host"]);
    expect(hostResult.playerCount).toBe(3);
  });
});

describe("runHostSessionSetup — handshake timeout (re-review finding: host-side counterpart to finding 9)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Matches the module's own private HANDSHAKE_TIMEOUT_MS — not exported (a
  // purely internal implementation constant), so mirrored here directly.
  const HANDSHAKE_TIMEOUT_MS = 10_000;

  it("rejects with a handshake-timeout SessionSetupError if the guest never sends its own build-version", async () => {
    vi.useFakeTimers();
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const hostPromise = runHostSetup(channels.host, "guest", options);

    // Attached before advancing the timer — same reasoning as
    // sessionSetupGuest.test.ts's identical pattern: the assertion must
    // already be listening before the fake-timer advance below fires the
    // rejection, or it's briefly "unhandled" from Node's own perspective.
    const assertion = expect(hostPromise).rejects.toMatchObject({ code: "handshake-timeout" });
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await assertion;
    await expect(hostPromise).rejects.toBeInstanceOf(SessionSetupError);
  });

  it("does not fire if the handshake completes normally well before the timeout", async () => {
    vi.useFakeTimers();
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSetup(channels.host, "guest", options)]);
    // Even letting the timeout's own window fully elapse afterward must not
    // retroactively reject an already-resolved setup.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

    expect(guestResult.roster).toEqual(["guest", "host"]);
  });

  it("does not fire once a build-version mismatch has already settled the promise", async () => {
    vi.useFakeTimers();
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1, displayNames: {} };

    const hostPromise = runHostSetup(channels.host, "guest", options);
    const rogueVersion: SessionSetupMessage = { type: "build-version", ref: "other-build-ref", time: "other-build-time" };
    channels.guest.reconciliation.send(JSON.stringify(rogueVersion));

    await expect(hostPromise).rejects.toMatchObject({ code: "build-version-mismatch" });
    // The already-rejected promise must not reject again (or throw) once the
    // handshake-timeout window it never needed also elapses — a second,
    // still-pending rejection here would surface as an unhandled rejection
    // and fail the test run.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
  });
});

describe("runHostSessionSetupPhaseA — the guest's chosen name", () => {
  it("resolves with the name the guest sent", async () => {
    const channels = linkedChannels();
    const phaseA = runHostSessionSetupPhaseA(channels.host);
    channels.guest.reconciliation.send(
      JSON.stringify({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ } satisfies SessionSetupMessage),
    );
    channels.guest.reconciliation.send(JSON.stringify({ type: "player-name", name: "Tobi" } satisfies SessionSetupMessage));
    await expect(phaseA).resolves.toBe("Tobi");
  });

  it("waits for BOTH halves — a build-version alone does not settle it", async () => {
    vi.useFakeTimers();
    try {
      const channels = linkedChannels();
      const phaseA = runHostSessionSetupPhaseA(channels.host);
      channels.guest.reconciliation.send(
        JSON.stringify({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ } satisfies SessionSetupMessage),
      );

      // Still pending: without the name, `session-init` could not carry a
      // complete roster of names, which is the whole reason for phase A.
      const assertion = expect(phaseA).rejects.toMatchObject({ code: "handshake-timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the two halves in either order", async () => {
    // The guest sends version-then-name over an ordered channel, so this
    // order does not occur today; settling on it anyway keeps this side from
    // depending on a detail of the other's send order.
    const channels = linkedChannels();
    const phaseA = runHostSessionSetupPhaseA(channels.host);
    channels.guest.reconciliation.send(JSON.stringify({ type: "player-name", name: "Backwards" } satisfies SessionSetupMessage));
    channels.guest.reconciliation.send(
      JSON.stringify({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ } satisfies SessionSetupMessage),
    );
    await expect(phaseA).resolves.toBe("Backwards");
  });

  it("treats a non-string name as no name at all rather than failing the handshake", async () => {
    const channels = linkedChannels();
    const phaseA = runHostSessionSetupPhaseA(channels.host);
    channels.guest.reconciliation.send(
      JSON.stringify({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ } satisfies SessionSetupMessage),
    );
    // A rogue/older peer sending the wrong shape: cosmetic, so it must never
    // be a reason to refuse the connection.
    channels.guest.reconciliation.send(JSON.stringify({ type: "player-name", name: 42 }));
    await expect(phaseA).resolves.toBe("");
  });
});

describe("session-setup — names reach the guest", () => {
  it("carries every roster member's name in session-init, and the guest resolves with them", async () => {
    const channels = linkedChannels();
    const map = bigFakeMap(10);
    const [guestResult] = await Promise.all([
      runGuestSessionSetup(channels.guest, "Tobi"),
      (async () => {
        const guestName = await runHostSessionSetupPhaseA(channels.host);
        expect(guestName).toBe("Tobi");
        await runHostSessionSetupPhaseB(channels.host, "guest", {
          map,
          difficulty: "normal",
          roster: ["guest", "host"],
          gameplaySeed: 1,
          displayNames: { host: "The Host", guest: guestName },
        });
      })(),
    ]);

    expect(guestResult.displayNames).toEqual({ host: "The Host", guest: "Tobi" });
  });

  // These two only run phase A, so the guest's own setup never completes (it
  // is still waiting for a `session-init` that never comes). Its promise is
  // deliberately started and *not* awaited — awaiting it would hang the test
  // rather than assert anything.
  it("sends an empty name for a guest that chose none, leaving the fallback to the one place that owns it", async () => {
    const channels = linkedChannels();
    void runGuestSessionSetup(channels.guest).catch(() => undefined);
    await expect(runHostSessionSetupPhaseA(channels.host)).resolves.toBe("");
  });

  it("sanitizes an oversized/control-character name before it ever reaches the wire", async () => {
    const channels = linkedChannels();
    void runGuestSessionSetup(channels.guest, `  Tobi\u0000\u202e${"x".repeat(80)}  `).catch(() => undefined);
    const guestName = await runHostSessionSetupPhaseA(channels.host);
    // Control characters gone, trimmed, and cut to MAX_PLAYER_NAME_LENGTH —
    // the host receives exactly what will be drawn.
    expect(guestName).toBe(`Tobi${"x".repeat(20)}`);
    expect(guestName).toHaveLength(24);
  });
});

describe("buildHostSessionSetupResult", () => {
  it("derives playerCount from the roster's own length, never a separately-tracked value", () => {
    const options: HostSessionSetupOptions = { map: bigFakeMap(5), difficulty: "normal", roster: ["guest-1", "guest-2", "guest-3", "host"], gameplaySeed: 1, displayNames: {} };
    expect(buildHostSessionSetupResult(options).playerCount).toBe(4);
  });
});
