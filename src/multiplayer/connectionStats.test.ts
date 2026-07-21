// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { readConnectionStats, type StatsSource } from "./connectionStats";

function fakeSource(entries: [string, unknown][]): StatsSource {
  return { getStats: () => Promise.resolve(new Map(entries) as unknown as RTCStatsReport) };
}

describe("readConnectionStats", () => {
  it("reads currentRoundTripTime (seconds) off the succeeded/nominated candidate-pair entry, converted to milliseconds", async () => {
    const source = fakeSource([["cp1", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.065 }]]);
    await expect(readConnectionStats(source)).resolves.toEqual({ rttMs: 65 });
  });

  it("ignores a candidate-pair that isn't both succeeded and nominated — an abandoned ICE-negotiation attempt, not the active path", async () => {
    const source = fakeSource([
      ["cp1", { type: "candidate-pair", state: "succeeded", nominated: false, currentRoundTripTime: 0.01 }],
      ["cp2", { type: "candidate-pair", state: "waiting", nominated: true, currentRoundTripTime: 0.02 }],
      ["cp3", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.09 }],
    ]);
    await expect(readConnectionStats(source)).resolves.toEqual({ rttMs: 90 });
  });

  it("resolves {rttMs: null} once no succeeded/nominated candidate-pair is reported yet", async () => {
    const source = fakeSource([["cp1", { type: "candidate-pair", state: "waiting", nominated: false }]]);
    await expect(readConnectionStats(source)).resolves.toEqual({ rttMs: null });
  });

  it("resolves {rttMs: null} for an empty report (e.g. read immediately after connect)", async () => {
    await expect(readConnectionStats(fakeSource([]))).resolves.toEqual({ rttMs: null });
  });

  it("resolves {rttMs: null} when the active pair never populated currentRoundTripTime", async () => {
    const source = fakeSource([["cp1", { type: "candidate-pair", state: "succeeded", nominated: true }]]);
    await expect(readConnectionStats(source)).resolves.toEqual({ rttMs: null });
  });

  it("resolves {rttMs: null}, not a rejected promise, when getStats() itself throws (e.g. a closing connection)", async () => {
    const source: StatsSource = {
      getStats: () => Promise.reject(new Error("connection is closing")),
    };
    await expect(readConnectionStats(source)).resolves.toEqual({ rttMs: null });
  });
});
