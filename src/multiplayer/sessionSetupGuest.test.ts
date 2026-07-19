// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { MapGenerator } from "../map/mapGenerator";
import type { CodeEntity, ParsedFile } from "../parser/types";
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
      runHostSessionSetup(channels.host, { map, difficulty: "normal", playerCount: 2 }),
    ]);

    expect(guestResult.map.visited).toHaveLength(map.height);
    for (const row of guestResult.map.visited) {
      expect(row).toHaveLength(map.width);
      expect(row.every((v) => v === false)).toBe(true);
    }
    expect(guestResult.map.visited).toEqual(map.visited); // map.visited is itself freshly all-false at generation time
  });
});
