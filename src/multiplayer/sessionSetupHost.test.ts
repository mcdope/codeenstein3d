// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import type { GameMap, Tile } from "../map/types";
import { runGuestSessionSetup } from "./sessionSetupGuest";
import { runHostSessionSetup } from "./sessionSetupHost";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, SessionSetupError, type SessionSetupMessage } from "./sessionSetupTypes";
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
  it("host and guest converge on the same SessionSetupResult, exercising real multi-chunk map transfer", async () => {
    const channels = linkedChannels();
    const map = bigFakeMap();
    expect(JSON.stringify(map).length).toBeGreaterThan(16 * 1024); // sanity: the fixture is genuinely big

    // Guest first: it only ever listens on `runGuestSessionSetup()` (never
    // sends until the host's own build-version arrives), so its listener
    // must be attached before the host's synchronous outbound send below —
    // see sessionSetupGuest.ts's doc comment for the real race this order
    // guards against.
    const [guestResult, hostResult] = await Promise.all([
      runGuestSessionSetup(channels.guest),
      runHostSessionSetup(channels.host, { map, difficulty: "hard", playerCount: 2 }),
    ]);

    expect(guestResult.roster).toEqual(["guest", "host"]);
    expect(guestResult.tickRateHz).toBe(hostResult.tickRateHz);
    expect(guestResult.fixedDt).toBe(hostResult.fixedDt);
    expect(guestResult.inputDelayTicks).toBe(hostResult.inputDelayTicks);
    expect(guestResult.gameplaySeed).toBe(hostResult.gameplaySeed);
    expect(guestResult.difficulty).toBe("hard");
    expect(guestResult.playerCount).toBe(2);
    expect(guestResult.map).toEqual(map);
  });

  it("assigns HOST_PLAYER_ID to the host's own result and GUEST_PLAYER_ID to the guest's", async () => {
    const channels = linkedChannels();
    const map = bigFakeMap(10);

    // See the previous test's comment on why guest must go first.
    const [guestResult, hostResult] = await Promise.all([
      runGuestSessionSetup(channels.guest),
      runHostSessionSetup(channels.host, { map, difficulty: "normal", playerCount: 2 }),
    ]);

    expect(hostResult.assignedId).toBe(HOST_PLAYER_ID);
    expect(guestResult.assignedId).toBe(GUEST_PLAYER_ID);
  });
});

describe("runHostSessionSetup — ignores unexpected message types", () => {
  it("ignores a stray non-build-version message and still completes once the real build-version arrives", async () => {
    const channels = linkedChannels();
    const hostPromise = runHostSessionSetup(channels.host, { map: bigFakeMap(10), difficulty: "normal", playerCount: 2 });

    // A rogue guest sending a stray, unexpected message type before its real
    // build-version — isolates the host's own tolerance for it, same manual
    // "rogue guest" pattern as the mismatch test below (rather than the real
    // `runGuestSessionSetup`, which never sends this message type at all).
    const stray: SessionSetupMessage = { type: "map-chunk", index: 0, data: "{}" };
    channels.guest.reconciliation.send(JSON.stringify(stray));
    const realVersion: SessionSetupMessage = { type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ };
    channels.guest.reconciliation.send(JSON.stringify(realVersion));

    await expect(hostPromise).resolves.toBeDefined();
  });
});

describe("runHostSessionSetup — build-version mismatch", () => {
  it("rejects when the guest's build-version doesn't match, and sends nothing further", async () => {
    const channels = linkedChannels();
    const sendSpy = vi.spyOn(channels.host.reconciliation, "send");

    const hostPromise = runHostSessionSetup(channels.host, { map: bigFakeMap(10), difficulty: "easy", playerCount: 2 });

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
