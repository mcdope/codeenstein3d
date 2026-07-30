// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the campaign lane orchestrator's cost bound.
 *
 * `driveCombo`'s retry loop is `for (;;)` — it keeps asking for another
 * invocation until the combo reaches its qualifying target. Two ways that
 * never terminates, both observed for real:
 * - a combo the bot cannot clear (the 2026-07-24 multiplayer campaign's Hard
 *   cells, rescued by hand-lowering the target mid-run), and
 * - an invocation that *crashes*, which writes no output file — so a cap
 *   counting files on disk never advances and the same failing invocation is
 *   retried forever (a Gamer/hard/4p probe on 2026-07-30 re-ran invocation #1
 *   indefinitely after its browser died).
 *
 * The second case is why the cap counts spawns rather than files, and is the
 * regression this file exists to pin.
 */
import { describe, expect, it } from "vitest";
import { runLaneOrchestrator } from "./laneOrchestrator.mjs";

/** A `Runner` stand-in: records every invocation and reports whatever the
 * caller wants, without spawning anything. */
function fakeRunner(onInvocation) {
  const calls = [];
  return {
    label: "fake",
    calls,
    runInvocation(args) {
      calls.push(args);
      return Promise.resolve(onInvocation(calls.length));
    },
  };
}

const baseParams = (over = {}) => ({
  combos: [{ id: "a" }],
  comboKey: (c) => c.id,
  outputPathFor: (c, seq) => `/dev/null/${c.id}-${seq}`,
  logPathFor: (c, seq) => `/dev/null/${c.id}-${seq}.log`,
  envFor: () => ({}),
  scriptPath: "/dev/null/script.mjs",
  targetQualifying: 10,
  watchdogMs: 1000,
  sigtermGraceMs: 10,
  log: () => {},
  ...over,
});

describe("runLaneOrchestrator cost bound", () => {
  it("stops a combo that never reaches its target, at the invocation cap", async () => {
    // Succeeds every time but banks nothing — the unclearable-combo case.
    const runner = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 3,
      }),
    );
    expect(runner.calls).toHaveLength(3);
  });

  it("stops a crashing invocation that never writes an output file", async () => {
    // The regression: a crash means no file, so `fileCount` stays 0 forever.
    // A file-counting cap would loop here until something external killed it.
    const runner = fakeRunner(() => ({ code: 1, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
      }),
    );
    expect(runner.calls).toHaveLength(2);
  });

  it("stops an invocation the watchdog keeps killing", async () => {
    const runner = fakeRunner(() => ({ code: null, signal: "SIGKILL", killedForTimeout: true, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 4,
      }),
    );
    expect(runner.calls).toHaveLength(4);
  });

  it("still returns as soon as the target is met, without consuming the cap", async () => {
    let qualifying = 0;
    const runner = fakeRunner(() => {
      qualifying = 10;
      return { code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 };
    });
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying, fileCount: qualifying > 0 ? 1 : 0 }),
        runners: [runner],
        maxInvocations: 5,
      }),
    );
    expect(runner.calls).toHaveLength(1);
  });

  it("does nothing at all when the target is already satisfied on disk", async () => {
    const runner = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 10, fileCount: 2 }),
        runners: [runner],
        maxInvocations: 3,
      }),
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("counts the cap per combo, not across the whole queue", async () => {
    const runner = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        combos: [{ id: "a" }, { id: "b" }],
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
      }),
    );
    expect(runner.calls).toHaveLength(4);
  });

  it("accepts a per-combo target function", async () => {
    const runner = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 5, fileCount: 1 }),
        targetQualifying: () => 5,
        runners: [runner],
        maxInvocations: 3,
      }),
    );
    expect(runner.calls).toHaveLength(0);
  });
});
