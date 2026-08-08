// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the campaign lane orchestrator's cost bound.
 *
 * The scheduler keeps asking for another invocation until a combo reaches its
 * qualifying target. Two ways that never terminates, both observed for real:
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

/**
 * Chunk stealing.
 *
 * Lanes used to own a whole combo, so with combos <= lanes a finished lane had
 * nothing left to take and stopped working while the run continued — 115 idle
 * minutes of a 132-minute ripgrep capture, roughly half of all lane-time
 * across the run. These pin the scheduler that replaced it.
 */
describe("runLaneOrchestrator chunk stealing", () => {
  /** A runner that blocks until the test releases it, so several lanes can be
   * observed genuinely in flight at once rather than racing to completion. */
  function gatedRunner(label) {
    const calls = [];
    const release = [];
    // Once released, stay released: the cap counts invocations that made no
    // progress, which is only known at completion, so a lane may claim one
    // more than the cap while others are still in flight. A latch that only
    // fires once would leave that extra invocation hanging forever.
    let opened = null;
    return {
      label,
      calls,
      releaseAll(result = { code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }) {
        opened = result;
        const pending = release.splice(0);
        for (const r of pending) r(result);
      },
      runInvocation(args) {
        calls.push(args);
        if (opened) return Promise.resolve(opened);
        return new Promise((resolve) => release.push(resolve));
      },
    };
  }

  it("keeps a second lane working after the only other combo is finished", async () => {
    // The exact idle-lane shape: two lanes, two combos, one of which is
    // already satisfied. Under combo ownership the second lane took the
    // finished combo, found nothing to do and exited for the rest of the run.
    const banked = { a: 0, b: 10 };
    const runners = [fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 })), fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }))];
    await runLaneOrchestrator(
      baseParams({
        combos: [{ id: "a" }, { id: "b" }],
        scanExisting: (c) => ({ qualifying: banked[c.id], fileCount: 0 }),
        runners,
        maxInvocations: 4,
        maxConcurrentPerCombo: 2,
      }),
    );
    // Combo `b` needs nothing; every invocation went to `a`, and BOTH lanes
    // contributed rather than one sitting idle.
    //
    // The bound is `maxInvocations + lanes - 1`, not equality: the cap counts
    // invocations that made no progress, which is only known once one
    // finishes, so concurrent claims can overshoot by up to one per extra
    // lane. Counting at claim time was exact but cut off combos that were
    // still delivering — see `state.barren`.
    const all = [...runners[0].calls, ...runners[1].calls];
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeLessThanOrEqual(5);
    expect(runners[0].calls.length).toBeGreaterThan(0);
    expect(runners[1].calls.length).toBeGreaterThan(0);
  });

  it("never gives two concurrent invocations the same sequence number", async () => {
    // They would overwrite each other's output file, log and event-log
    // directory — silently losing a whole chunk of a capture.
    const runner = gatedRunner("l1");
    const runner2 = gatedRunner("l2");
    const done = runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner, runner2],
        maxInvocations: 2,
        maxConcurrentPerCombo: 2,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const paths = [...runner.calls, ...runner2.calls].map((c) => c.outputPath);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    runner.releaseAll();
    runner2.releaseAll();
    await done;
  });

  it("tells each invocation how many of its combo were already in flight", async () => {
    // A caller sizing a chunk from "target minus what is on disk" must
    // subtract the work concurrent lanes were already asked for, or every
    // extra lane re-runs the same shortfall.
    const runner = gatedRunner("l1");
    const runner2 = gatedRunner("l2");
    const seen = [];
    const done = runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (_c, _seq, _out, _ev, ctx) => {
          seen.push(ctx.inFlightBefore);
          return {};
        },
        runners: [runner, runner2],
        maxInvocations: 2,
        maxConcurrentPerCombo: 2,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([0, 1]);
    runner.releaseAll();
    runner2.releaseAll();
    await done;
  });

  it("honours a concurrency limit that shrinks as work is banked", async () => {
    // ceil(remaining / chunk): 5 remaining at chunk 2 admits 3 lanes, but once
    // 4 are banked only one more invocation is worth starting.
    let qualifying = 0;
    const runner = fakeRunner(() => {
      qualifying += 2;
      return { code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 };
    });
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying, fileCount: 0 }),
        targetQualifying: 5,
        runners: [runner],
        maxInvocations: 10,
        maxConcurrentPerCombo: (_c, ctx) => Math.ceil(Math.max(0, ctx.target - ctx.qualifying) / 2),
      }),
    );
    expect(runner.calls).toHaveLength(3); // 0->2, 2->4, 4->6 >= 5
  });

  it("parks a lane with nothing to claim instead of exiting the run", async () => {
    // The deadlock/early-exit hazard: lane 2 finds the only combo already at
    // its concurrency limit. It must wait for lane 1 to land and then take the
    // next invocation — not decide the run is over and leave.
    const gated = gatedRunner("slow");
    const fast = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    let qualifying = 0;
    const done = runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying, fileCount: 0 }),
        targetQualifying: 2,
        runners: [gated, fast],
        maxInvocations: 5,
        maxConcurrentPerCombo: 1, // only one at a time, so one lane must park
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    // Exactly one lane got work; the other is parked, not returned.
    expect(gated.calls.length + fast.calls.length).toBe(1);
    qualifying = 2; // the in-flight one will satisfy the target
    gated.releaseAll();
    await done; // must terminate, not hang
  });

  it("drops a lane that fails everything, and refunds the budget it ate", async () => {
    // Measured 2026-08-07: an SSH host whose inotify watch limit was exhausted
    // could never start vite, so every invocation died after ~63s — and
    // `bootstrapHost` had called it "ready". It burned 7 of one combo's 8
    // invocations and that combo gave up at 15 of 60 runs, which reads as a
    // balance finding rather than as a dead machine.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-health-"));
    let good = 0;
    const working = {
      label: "good",
      calls: [],
      runInvocation({ outputPath }) {
        this.calls.push(1);
        good += 1;
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1 });
      },
    };
    const broken = fakeRunner(() => ({ code: 1, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: good }),
        targetQualifying: 99,
        runners: [working, broken],
        maxInvocations: 4,
        maxConcurrentPerCombo: 2,
        laneFailureLimit: 2,
      }),
    );
    // The broken lane is dropped on its 2nd consecutive no-output failure…
    expect(broken.calls).toHaveLength(2);
    // …and its spend was refunded, so the working lane got the budget instead
    // of the combo giving up at the cap with a dead machine to blame.
    expect(good).toBeGreaterThan(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT drop a lane when nothing anywhere has succeeded", async () => {
    // The discriminator. With no lane producing anything, the fault may be the
    // build or the content rather than the machine — so every failure still
    // counts and the invocation cap ends the run exactly as before. This is
    // what keeps the 2026-07-30 crashing-invocation protection intact.
    const broken = fakeRunner(() => ({ code: 1, signal: null, killedForTimeout: false, elapsedMs: 1 }));
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [broken],
        maxInvocations: 5,
        laneFailureLimit: 2,
      }),
    );
    expect(broken.calls).toHaveLength(5); // the cap, not the lane-health rule
  });

  it("sizes each lane's chunk from its own measured rate", async () => {
    // A fixed chunk makes the run end when the SLOWEST lane finishes its last
    // full-size chunk, with every other lane idle. Measured spread across the
    // configured hosts is about 2x.
    const asked = [];
    const mk = (label) => ({
      label,
      calls: [],
      runInvocation({ env }) {
        this.calls.push(1);
        asked.push({ label, cap: env.CAP });
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1000 });
      },
    });
    const fast = mk("fast");
    const slow = mk("slow");
    let qualifying = 0;
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying, fileCount: 0 }),
        envFor: (_c, _s, _o, _e, ctx) => ({ CAP: String(ctx.chunkAttempts) }),
        targetQualifying: 40,
        runners: [fast, slow],
        maxInvocations: 2,
        maxConcurrentPerCombo: 2,
        initialLaneRates: { fast: 10, slow: 2 },
        chunkFor: (_c, { ratePerMin }) => ratePerMin * 2,
      }),
    );
    // 2 minutes of work each: the fast lane is asked for 20, the slow one 4.
    expect(asked.find((a) => a.label === "fast").cap).toBe("20");
    expect(asked.find((a) => a.label === "slow").cap).toBe("4");
  });

  it("reserves the attempts actually claimed, not a constant chunk", async () => {
    // The trap this replaces: the caller reserved `inFlightBefore * CHUNK`,
    // which is only right while every lane gets an identical chunk. With
    // per-lane sizing that over- or under-counts and the combo overshoots its
    // target.
    const seen = [];
    const gate = [];
    let opened = null; // same latch reasoning as `gatedRunner`
    const mk = (label) => ({
      label,
      calls: [],
      runInvocation({ env }) {
        this.calls.push(1);
        seen.push({ label, cap: Number(env.CAP), reserved: Number(env.RESERVED) });
        if (opened) return Promise.resolve(opened);
        return new Promise((r) => gate.push(r));
      },
    });
    const a = mk("fast");
    const b = mk("slow");
    const done = runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (_c, _s, _o, _e, ctx) => ({ CAP: String(ctx.chunkAttempts), RESERVED: String(ctx.reservedAttempts) }),
        targetQualifying: 100,
        runners: [a, b],
        maxInvocations: 2,
        maxConcurrentPerCombo: 2,
        initialLaneRates: { fast: 10, slow: 2 },
        chunkFor: (_c, { ratePerMin }) => ratePerMin * 2,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    // First claim sees nothing reserved; the second sees exactly what the
    // first actually asked for — 20, not a constant.
    expect(seen[0].reserved).toBe(0);
    expect(seen[1].reserved).toBe(seen[0].cap);
    opened = { code: 0, signal: null, killedForTimeout: false, elapsedMs: 1000 };
    gate.forEach((r) => r(opened));
    await done;
  });

  it("reports each measured rate as it happens, not only at the end", async () => {
    // A run that is interrupted must not lose what it learned — otherwise the
    // next one pays the calibration round again. Several runs were killed
    // mid-investigation on 2026-08-07 and would each have discarded it.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-rate-"));
    const seen = [];
    const runner = {
      label: "fake",
      calls: [],
      runInvocation({ outputPath }) {
        this.calls.push(1);
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 60000 });
      },
    };
    await runLaneOrchestrator(
      baseParams({
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
        chunkFor: () => 10,
        onLaneRate: (label, perMin) => seen.push({ label, perMin }),
      }),
    );
    // 10 attempts in 60s = 10/min, reported after each invocation rather than
    // once at the end.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ label: "fake", perMin: 10 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not let a persistence failure kill the capture", async () => {
    // The rates file is a convenience; a capture is hours of machine time.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-rate-fail-"));
    const runner = {
      label: "fake",
      calls: [],
      runInvocation({ outputPath }) {
        this.calls.push(1);
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1000 });
      },
    };
    const summary = await runLaneOrchestrator(
      baseParams({
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
        chunkFor: () => 10,
        onLaneRate: () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(runner.calls).toHaveLength(2);
    expect(summary.lanes[0].attemptsPerMin).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the expensive combo to the fast lane and the cheap one to the slow lane", async () => {
    // Work units are not interchangeable: a Casual/hard run dying on level 2 is
    // cheap, a Pro/normal run completing 15 levels is not. A slow host must not
    // be the one grinding the costliest combo.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-cost-"));
    const took = [];
    const mk = (label, ms) => ({
      label,
      runInvocation({ outputPath, env }) {
        took.push({ label, combo: env.COMBO });
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: ms });
      },
    });
    await runLaneOrchestrator(
      baseParams({
        combos: [{ id: "cheap" }, { id: "pricey" }],
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (c) => ({ COMBO: c.id }),
        targetQualifying: 200,
        runners: [mk("fast", 1000), mk("slow", 4000)],
        maxInvocations: 1,
        maxConcurrentPerCombo: 1,
        initialLaneRates: { fast: 20, slow: 5 },
        chunkFor: (_c, { ratePerMin }) => ratePerMin,
        // `pricey` costs 4x per attempt. Seeded, because otherwise both start
        // equal and the very first pair of claims has nothing to rank on.
        initialComboCost: { pricey: 4, cheap: 1 },
      }),
    );
    expect(took.find((t) => t.label === "fast").combo).toBe("pricey");
    expect(took.find((t) => t.label === "slow").combo).toBe("cheap");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("learns which combo is expensive from what it observes", async () => {
    // The ranking is decoration unless cost is measured. Same lane, same chunk
    // size, one combo taking 4x the wall time: its relative cost must rise
    // above the cheap one's.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-learn-"));
    const picks = [];
    const runner = {
      label: "only",
      runInvocation({ outputPath, env }) {
        picks.push(env.COMBO);
        fs.writeFileSync(outputPath, "{}");
        // `pricey` genuinely takes longer for the same number of attempts.
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: env.COMBO === "pricey" ? 40000 : 10000 });
      },
    };
    const summary = await runLaneOrchestrator(
      baseParams({
        combos: [{ id: "cheap" }, { id: "pricey" }],
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (c) => ({ COMBO: c.id }),
        targetQualifying: 500,
        runners: [runner],
        maxInvocations: 3,
        chunkFor: () => 10,
        initialLaneRates: { only: 30 },
      }),
    );
    expect(summary.comboCost.pricey).toBeGreaterThan(summary.comboCost.cheap);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports each combo cost as it is learned, so an interrupted run keeps it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-costcb-"));
    const seen = [];
    const runner = {
      label: "only",
      runInvocation({ outputPath, env }) {
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: env.COMBO === "pricey" ? 40000 : 10000 });
      },
    };
    await runLaneOrchestrator(
      baseParams({
        combos: [{ id: "cheap" }, { id: "pricey" }],
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (c) => ({ COMBO: c.id }),
        targetQualifying: 500,
        runners: [runner],
        maxInvocations: 3,
        chunkFor: () => 10,
        initialLaneRates: { only: 30 },
        onComboCost: (combo, relCost) => seen.push({ combo, relCost }),
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    const pricey = seen.filter((x) => x.combo === "pricey").at(-1);
    const cheap = seen.filter((x) => x.combo === "cheap").at(-1);
    expect(pricey.relCost).toBeGreaterThan(cheap.relCost);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a slow lane still takes the work when no other lane is running", async () => {
    // The deadlock the tail guard must never cause: standing down is only safe
    // while someone else is working. With nothing in flight, refusing means
    // nobody ever claims and the run hangs. A slow lane beats an idle one.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-tail-"));
    const slow = {
      label: "slow",
      calls: [],
      runInvocation({ outputPath }) {
        this.calls.push(1);
        fs.writeFileSync(outputPath, "{}");
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 60000 });
      },
    };
    await runLaneOrchestrator(
      baseParams({
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        targetQualifying: 3,
        runners: [slow],
        maxInvocations: 2,
        chunkFor: () => 5,
        // Ranked slowest of a pool that includes absent, faster lanes.
        initialLaneRates: { slow: 1, ghostA: 50, ghostB: 50 },
      }),
    );
    expect(slow.calls.length).toBeGreaterThan(0); // must not hang or starve
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not credit speed to an invocation that banked nothing", async () => {
    // A run that fails fast still writes its output file, so it used to count
    // as a success at the rate it was ASKED for. Measured 2026-08-08: a
    // 45-second invocation banking zero pushed one lane to 2.02 attempts/min
    // against a true ~0.2, which then earned it oversized chunks and starved
    // the other lanes.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-yield-"));
    const rates = [];
    let call = 0;
    const runner = {
      label: "flaky",
      calls: [],
      runInvocation({ outputPath }) {
        this.calls.push(1);
        fs.writeFileSync(outputPath, "{}"); // writes output either way
        call += 1;
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: call === 1 ? 750 : 60000 });
      },
    };
    await runLaneOrchestrator(
      baseParams({
        outputPathFor: (c, seq) => path.join(dir, `${c.id}-${seq}.json`),
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
        chunkFor: () => 10,
        // First invocation banks nothing despite "succeeding"; second banks 10.
        measureYield: () => (call === 1 ? 0 : 10),
        onLaneRate: (_l, perMin) => rates.push(perMin),
      }),
    );
    // The 0.75s empty invocation would have read as 800/min. Only the honest
    // one is counted: 10 attempts in 60s.
    expect(rates).toEqual([10]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never takes more than an even share of what is left", async () => {
    // The tail is where idle accrues: with long chunks whoever grabs the last
    // one runs alone while every other lane sits finished.
    const asked = [];
    const mk = (label) => ({
      label,
      runInvocation({ env }) {
        asked.push(Number(env.CAP));
        return Promise.resolve({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1000 });
      },
    });
    await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        envFor: (_c, _s, _o, _e, ctx) => ({ CAP: String(ctx.chunkAttempts) }),
        targetQualifying: 12,
        runners: [mk("a"), mk("b"), mk("c")],
        maxInvocations: 1,
        maxConcurrentPerCombo: 3,
        chunkFor: (_c, { remaining, laneCount }) => Math.min(100, Math.ceil(remaining / laneCount)),
      }),
    );
    // 12 left over 3 lanes: nobody takes more than 4, so all three share it.
    expect(Math.max(...asked)).toBeLessThanOrEqual(4);
  });

  it("reports per-lane utilisation so idle time is never invisible again", async () => {
    const runner = fakeRunner(() => ({ code: 0, signal: null, killedForTimeout: false, elapsedMs: 1000 }));
    const summary = await runLaneOrchestrator(
      baseParams({
        scanExisting: () => ({ qualifying: 0, fileCount: 0 }),
        runners: [runner],
        maxInvocations: 2,
      }),
    );
    expect(summary.lanes).toHaveLength(1);
    expect(summary.lanes[0]).toMatchObject({ label: "fake", invocations: 2, busyMs: 2000 });
    expect(summary.idleFraction).toBeGreaterThanOrEqual(0);
    expect(summary.idleFraction).toBeLessThanOrEqual(1);
  });
});
