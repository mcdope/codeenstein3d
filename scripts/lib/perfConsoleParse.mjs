// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Parser for the `?perfDebug=1` console grammar emitted by
 * `src/engine/perfDebug.ts` (`FramePerfLogger`). The logger prints via plain
 * `console.log`, which Playwright surfaces through `page.on("console")` — so
 * the bench harness gets per-phase frame timings with zero game-source
 * changes. Four line shapes (see perfDebug.ts for why they look like this):
 *
 *   [perf] env: cores=8 memGB=16 dpr=1 screen=1920x1080 viewport=... ua="..."
 *   [perf] level: map=48x64 canvas=640x400 enemies=12 elite=1 edgeCase=2 mines=3
 *   [perf] tick 8.33ms (~120fps) unacct=1.20ms mouse=0/f | input-poll=0.02 sim=1.10 ...
 *   [perf] SLOW 41.70ms (~24fps) unacct=30.10ms mouse=14/f | ...
 *   [perf] state: enemies=9/12(elite=1,edge=2) ... | heapMB=48/64/4096
 *
 * `tick`/`SLOW` lines carry the payload we analyze (rawDt, unaccounted, phase
 * breakdown); `state` lines are kept parsed-loose (kv bag) for context.
 */

const FRAME_RE = /^\[perf\] (tick|SLOW) ([\d.]+)ms \(~(-?\d+|Infinity)fps\) unacct=([\d.]+)ms mouse=(\d+)\/f \| (.*)$/;
const KV_RE = /([A-Za-z0-9_+-]+)=([^\s]+)/g;

/** Parse one console line. Returns `null` for anything that isn't a `[perf]`
 * line, otherwise `{kind: "frame"|"state"|"env"|"level", ...fields}`. */
export function parsePerfLine(text) {
  if (!text.startsWith("[perf] ")) return null;

  const frame = FRAME_RE.exec(text);
  if (frame) {
    const phases = {};
    let busyMs = 0;
    for (const [, key, value] of frame[6].matchAll(KV_RE)) {
      const ms = Number(value);
      if (!Number.isFinite(ms)) continue;
      phases[key] = ms;
      busyMs += ms;
    }
    return {
      kind: "frame",
      slow: frame[1] === "SLOW",
      rawDtMs: Number(frame[2]),
      fps: Number(frame[3]),
      unaccountedMs: Number(frame[4]),
      mouseMovesPerFrame: Number(frame[5]),
      phases,
      busyMs,
    };
  }

  for (const kind of ["state", "env", "level"]) {
    const prefix = `[perf] ${kind}: `;
    if (!text.startsWith(prefix)) continue;
    const kv = {};
    for (const [, key, value] of text.slice(prefix.length).matchAll(KV_RE)) kv[key] = value;
    return { kind, kv, raw: text };
  }
  return null;
}

/** Attachable collector: wire `page.on("console", collector.onConsole)` and
 * read back `collector.entries` (each entry gets a wall-clock `at` for
 * ordering against the sampler's timeline). `reset()` drops entries gathered
 * during setup/warmup so a capture holds steady-state lines only. */
export function createPerfLogCollector() {
  const entries = [];
  return {
    entries,
    onConsole(msg) {
      const parsed = parsePerfLine(msg.text());
      if (parsed) entries.push({ at: Date.now(), ...parsed });
    },
    reset() {
      entries.length = 0;
    },
  };
}

/** Summarize the frame-kind entries of a capture: per-phase mean/median/max
 * plus busy/unaccounted stats, split by periodic ticks vs slow-frame logs
 * (slow logs are event-driven, mixing them into "typical cost" averages
 * would skew high). */
export function summarizeFrameEntries(entries) {
  const frames = entries.filter((e) => e.kind === "frame");
  const ticks = frames.filter((e) => !e.slow);
  const slows = frames.filter((e) => e.slow);

  const phaseNames = [...new Set(frames.flatMap((e) => Object.keys(e.phases)))];
  const phaseStats = {};
  for (const name of phaseNames) {
    const values = ticks.map((e) => e.phases[name]).filter((v) => v !== undefined);
    if (values.length) phaseStats[name] = numberStats(values);
  }
  return {
    tickCount: ticks.length,
    slowCount: slows.length,
    busyMs: numberStats(ticks.map((e) => e.busyMs)),
    unaccountedMs: numberStats(ticks.map((e) => e.unaccountedMs)),
    rawDtMs: numberStats(ticks.map((e) => e.rawDtMs)),
    phaseStats,
    slowFrames: slows, // few by construction (rate-limited) — keep verbatim
  };
}

/** min/mean/median/p95/max for a number list (empty-safe). */
export function numberStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** Nearest-rank percentile over an already-sorted ascending array. */
export function percentileSorted(sorted, pct) {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
