// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { MapGenerator } from "../map/mapGenerator";
import type { CodeEntity, ParsedFile } from "../parser/types";
import { FIXED_DT, INPUT_DELAY_TICKS, TICK_RATE_HZ } from "./netcodeConstants";
import { runGuestSessionSetup } from "./sessionSetupGuest";
import { runHostSessionSetup } from "./sessionSetupHost";
import { SessionSetupError, type SessionSetupMessage } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

function linkedChannels(): { host: MultiplayerChannels; guest: MultiplayerChannels } {
  const hostReconciliation = new FakeRTCDataChannel("reconciliation");
  const guestReconciliation = new FakeRTCDataChannel("reconciliation");
  hostReconciliation.link(guestReconciliation);

  const hostInput = new FakeRTCDataChannel("input");
  const guestInput = new FakeRTCDataChannel("input");
  hostInput.link(guestInput);

  // A real session-setup handshake only ever starts once both peers'
  // channels are already `readyState: "open"` — `sendJsonWithBackpressure`
  // now enforces that for real, so these fakes must model it too.
  for (const channel of [hostReconciliation, guestReconciliation, hostInput, guestInput]) channel.simulateOpen();

  return {
    host: { input: hostInput as unknown as RTCDataChannel, reconciliation: hostReconciliation as unknown as RTCDataChannel },
    guest: { input: guestInput as unknown as RTCDataChannel, reconciliation: guestReconciliation as unknown as RTCDataChannel },
  };
}

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    language: "javascript",
    linesOfCode: 20,
    entities: [entity(), entity({ name: "b", startLine: 6, endLine: 10 })],
    gotos: [],
    comments: [],
    secretTriggers: [],
    ...overrides,
  };
}

describe("runGuestSessionSetup — build-version mismatch", () => {
  it("independently rejects on its own mismatch check, without needing a real host", async () => {
    const channels = linkedChannels();
    const guestPromise = runGuestSessionSetup(channels.guest);

    // A rogue peer sending a mismatched build-version instead of the real
    // runHostSessionSetup — isolates the guest's own mismatch handling; the
    // guest must not simply trust whatever a real host would have decided.
    const rogueVersion: SessionSetupMessage = { type: "build-version", ref: "other-build-ref", time: "other-build-time" };
    channels.host.reconciliation.send(JSON.stringify(rogueVersion));

    await expect(guestPromise).rejects.toMatchObject({ code: "build-version-mismatch" });
    await expect(guestPromise).rejects.toBeInstanceOf(SessionSetupError);
  });
});

describe("runGuestSessionSetup — netcode-constants mismatch (finding 8)", () => {
  it("rejects when the host's own compiled netcode constants (declared in session-init) don't match ours, even though the build-version itself matches", async () => {
    const channels = linkedChannels();
    const guestPromise = runGuestSessionSetup(channels.guest);

    // Manually drive a rogue host sequence: a real, matching build-version
    // (so that check alone wouldn't catch anything), then a session-init
    // declaring mismatched netcode constants — isolates the guest's own
    // netcode-constants mismatch handling specifically.
    const send = (message: SessionSetupMessage): void => channels.host.reconciliation.send(JSON.stringify(message));
    send({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ });
    send({
      type: "session-init",
      roster: ["guest", "host"],
      assignedId: "guest",
      tickRateHz: 60, // real is TICK_RATE_HZ(30)
      fixedDt: 1 / 60,
      inputDelayTicks: 3,
      gameplaySeed: 1,
      difficulty: "normal",
      playerCount: 2,
    });

    await expect(guestPromise).rejects.toMatchObject({ code: "netcode-constants-mismatch" });
    await expect(guestPromise).rejects.toBeInstanceOf(SessionSetupError);
  });

  it("succeeds normally when the host's netcode constants match ours (positive case)", async () => {
    const channels = linkedChannels();
    const options = { map: new MapGenerator().generate(parsedFile()), difficulty: "normal" as const, roster: ["guest", "host"], gameplaySeed: 1 };

    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSessionSetup(channels.host, "guest", options)]);

    expect(guestResult.tickRateHz).toBe(TICK_RATE_HZ);
    expect(guestResult.fixedDt).toBe(FIXED_DT);
    expect(guestResult.inputDelayTicks).toBe(INPUT_DELAY_TICKS);
  });
});

describe("runGuestSessionSetup — overall handshake timeout (finding 9)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Matches the module's own private HANDSHAKE_TIMEOUT_MS — not exported
  // (a purely internal implementation constant), so mirrored here directly.
  const HANDSHAKE_TIMEOUT_MS = 10_000;

  it("rejects with a handshake-timeout SessionSetupError if the host stalls mid-transfer without ever completing", async () => {
    vi.useFakeTimers();
    const channels = linkedChannels();
    const guestPromise = runGuestSessionSetup(channels.guest);

    // Host starts the handshake normally (real build-version, real
    // session-init) but then stalls forever mid-transfer — never sends any
    // map-chunk/map-end, and never closes the channel either (so no
    // error/close event would ever fire to unblock this some other way).
    const send = (message: SessionSetupMessage): void => channels.host.reconciliation.send(JSON.stringify(message));
    send({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ });
    send({
      type: "session-init",
      roster: ["guest", "host"],
      assignedId: "guest",
      tickRateHz: TICK_RATE_HZ,
      fixedDt: FIXED_DT,
      inputDelayTicks: INPUT_DELAY_TICKS,
      gameplaySeed: 1,
      difficulty: "normal",
      playerCount: 2,
    });

    // Attached before advancing the timer — `guestPromise` only actually
    // rejects once the fake-timer advance below fires it, so the assertion
    // must already be listening at that moment (attaching it afterward would
    // otherwise leave the rejection briefly "unhandled" from Node's own
    // perspective, even though it's caught a tick later).
    const assertion = expect(guestPromise).rejects.toMatchObject({ code: "handshake-timeout" });
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await assertion;
    await expect(guestPromise).rejects.toBeInstanceOf(SessionSetupError);
  });

  it("does not fire if the handshake completes normally well before the timeout", async () => {
    vi.useFakeTimers();
    const channels = linkedChannels();
    const options = { map: new MapGenerator().generate(parsedFile()), difficulty: "normal" as const, roster: ["guest", "host"], gameplaySeed: 1 };

    const [guestResult] = await Promise.all([runGuestSessionSetup(channels.guest), runHostSessionSetup(channels.host, "guest", options)]);
    // Even letting the timeout's own window fully elapse afterward must not
    // retroactively reject an already-resolved handshake.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

    expect(guestResult.roster).toEqual(["guest", "host"]);
  });
});

describe("runGuestSessionSetup — protocol errors", () => {
  it("rejects with a protocol error if map-end arrives before every chunk was received", async () => {
    const channels = linkedChannels();
    const guestPromise = runGuestSessionSetup(channels.guest);

    // Manually drive a rogue host sequence: real build-version (so the
    // version check passes), a session-init, exactly one chunk, then a
    // map-end claiming two chunks total — the reassembler is still missing
    // chunk 1 when map-end arrives.
    const send = (message: SessionSetupMessage): void => channels.host.reconciliation.send(JSON.stringify(message));
    send({ type: "build-version", ref: __BUILD_REF__, time: __BUILD_TIME__ });
    send({
      type: "session-init",
      roster: ["guest", "host"],
      assignedId: "guest",
      tickRateHz: 30,
      fixedDt: 1 / 30,
      inputDelayTicks: 3,
      gameplaySeed: 1,
      difficulty: "normal",
      playerCount: 2,
    });
    send({ type: "map-chunk", index: 0, data: "{}" });
    send({ type: "map-end", totalChunks: 2 });

    await expect(guestPromise).rejects.toMatchObject({ code: "protocol-error" });
    await expect(guestPromise).rejects.toBeInstanceOf(SessionSetupError);
  });
});

describe("runGuestSessionSetup — visited reconstruction", () => {
  it("reconstructs a visited grid matching a real generated map's own dimensions, all false", async () => {
    const channels = linkedChannels();
    const gen = new MapGenerator();
    const map = gen.generate(parsedFile());

    // Guest first: it only listens until the host's own build-version
    // arrives (never sends eagerly), so its listener must be attached
    // before the host's synchronous outbound send below — see
    // sessionSetupGuest.ts's doc comment for the real race this order
    // guards against.
    const [guestResult] = await Promise.all([
      runGuestSessionSetup(channels.guest),
      runHostSessionSetup(channels.host, "guest", { map, difficulty: "normal", roster: ["guest", "host"], gameplaySeed: 1 }),
    ]);

    expect(guestResult.map.visited).toHaveLength(map.height);
    for (const row of guestResult.map.visited) {
      expect(row).toHaveLength(map.width);
      expect(row.every((v) => v === false)).toBe(true);
    }
    expect(guestResult.map.visited).toEqual(map.visited); // map.visited is itself freshly all-false at generation time
  });
});
