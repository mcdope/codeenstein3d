// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import type { GameMap, Tile } from "../map/types";
import { runGuestSessionSetup } from "./sessionSetupGuest";
import { buildHostSessionSetupResult, runHostSessionSetup, type HostSessionSetupOptions } from "./sessionSetupHost";
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
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
  };
}

describe("runHostSessionSetup / runGuestSessionSetup — successful handshake", () => {
  it("host and guest converge on the same session shape, exercising real multi-chunk map transfer", async () => {
    const channels = linkedChannels();
    const map = bigFakeMap();
    expect(JSON.stringify(map).length).toBeGreaterThan(16 * 1024); // sanity: the fixture is genuinely big
    const options: HostSessionSetupOptions = { map, difficulty: "hard", roster: ["guest", "host"], gameplaySeed: 42 };

    // Guest first: it only ever listens on `runGuestSessionSetup()` (never
    // sends until the host's own build-version arrives), so its listener
    // must be attached before the host's synchronous outbound send below —
    // see sessionSetupGuest.ts's doc comment for the real race this order
    // guards against.
    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSessionSetup(channels.host, "guest", options)]);
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
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1 };

    // See the previous test's comment on why guest must go first.
    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSessionSetup(channels.host, "guest", options)]);
    const hostResult = buildHostSessionSetupResult(options);

    expect(hostResult.assignedId).toBe(HOST_PLAYER_ID);
    expect(guestResult.assignedId).toBe("guest");
  });
});

describe("runHostSessionSetup — ignores unexpected message types", () => {
  it("ignores a stray non-build-version message and still completes once the real build-version arrives", async () => {
    const channels = linkedChannels();
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1 };
    const hostPromise = runHostSessionSetup(channels.host, "guest", options);

    // A rogue guest sending a stray, unexpected message type before its real
    // build-version — isolates the host's own tolerance for it, same manual
    // "rogue guest" pattern as the mismatch test below (rather than the real
    // `runGuestSessionSetup`, which never sends this message type at all).
    const stray: SessionSetupMessage = { type: "map-chunk", index: 0, data: "{}" };
    channels.guest.reconciliation.send(JSON.stringify(stray));
    const realVersion: SessionSetupMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    channels.guest.reconciliation.send(JSON.stringify(realVersion));

    await expect(hostPromise).resolves.toBeUndefined();
  });
});

describe("runHostSessionSetup — build-version mismatch", () => {
  it("rejects when the guest's build-version doesn't match, and sends nothing further", async () => {
    const channels = linkedChannels();
    const sendSpy = vi.spyOn(channels.host.reconciliation, "send");
    const options: HostSessionSetupOptions = { map: bigFakeMap(10), difficulty: "easy", roster: ["guest", "host"], gameplaySeed: 1 };

    const hostPromise = runHostSessionSetup(channels.host, "guest", options);

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

describe("runHostSessionSetup — multiple guests (step 10: N-player)", () => {
  it("sets up each guest independently, with the same roster/seed but its own assignedId", async () => {
    const linkA = linkedChannels(); // host <-> guest-1
    const linkB = linkedChannels(); // host <-> guest-2
    const options: HostSessionSetupOptions = {
      map: bigFakeMap(10),
      difficulty: "normal",
      roster: ["guest-1", "guest-2", "host"],
      gameplaySeed: 777,
    };

    // Both guests' listeners attached before either host setup call sends
    // anything — same ordering discipline as the 2-player test above,
    // applied per guest.
    const [guest1Result, guest2Result] = await Promise.all([
      runGuestSessionSetup(linkA.guest),
      runGuestSessionSetup(linkB.guest),
      runHostSessionSetup(linkA.host, "guest-1", options),
      runHostSessionSetup(linkB.host, "guest-2", options),
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

describe("buildHostSessionSetupResult", () => {
  it("derives playerCount from the roster's own length, never a separately-tracked value", () => {
    const options: HostSessionSetupOptions = { map: bigFakeMap(5), difficulty: "normal", roster: ["guest-1", "guest-2", "guest-3", "host"], gameplaySeed: 1 };
    expect(buildHostSessionSetupResult(options).playerCount).toBe(4);
  });
});
