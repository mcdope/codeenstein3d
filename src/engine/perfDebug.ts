// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Opt-in, per-frame performance diagnostics for tracking down a framedrop
 * report we can't reproduce locally (see `notes` — the magento2/"nightmare"
 * shooting-framedrop item). Gated entirely behind `?perfDebug=1` (see
 * `RaycasterEngine`'s constructor, same pattern as `?testHooks=1`) — a
 * `FramePerfLogger` is only ever constructed when that flag is present, and
 * every call site in `engine.ts` is `this.perf?.mark(...)`, so normal play
 * never even calls into this file.
 *
 * Logs via plain `console.log`, deliberately — the whole point is that the
 * affected player can just screen-record their normal play session and the
 * data rides along in the visible console sidebar
 * (`src/ui/consoleSidebar.ts`) without them ever having to separately open
 * (and remember to keep open) DevTools. That mirror only renders a
 * `console.log` call whose first argument is a plain string — it silently
 * drops any trailing non-string argument (object dumps wreck the
 * retro-terminal effect, see `appendLine`'s doc comment) — so every field
 * here is folded into the message text itself rather than passed as
 * structured data, and each logged frame is kept to two short lines instead
 * of one long one so neither gets cut by the sidebar's 300-char truncation.
 *
 * Bias here is deliberately toward over-logging: this is instrumentation for
 * a single hard-to-reproduce report, not a shipping feature, and a second
 * round-trip to ask an affected user to capture more data is expensive. Rate
 * limiting exists only to stop the profiler's own logging (each line is a
 * real DOM append in the sidebar) from perturbing the very frame times it's
 * measuring, not to hide anything from the recording.
 */

/** Below this instantaneous fps, a frame is "slow" enough to log its full
 * phase breakdown immediately (rate-limited by `SLOW_LOG_MIN_INTERVAL_MS`
 * below) — chosen well under the reporter's usual 120fps so normal frame-time
 * jitter never trips it, but comfortably above the ~30fps they reported. */
const SLOW_FPS_THRESHOLD = 45;
/** Minimum real time between slow-frame log lines — a sustained bad patch
 * would otherwise log every single frame (30+/sec), which is its own source
 * of main-thread/DOM work that could distort the very measurement being
 * taken (and would drown the sidebar's normal gameplay lines). */
const SLOW_LOG_MIN_INTERVAL_MS = 250;
/** How often a baseline snapshot is logged regardless of frame time, so a
 * capture that never dips below `SLOW_FPS_THRESHOLD` still yields a timeline
 * of phase costs and entity counts to compare against. */
const PERIODIC_LOG_INTERVAL_MS = 2000;

/** One frame's phase-timing breakdown, in milliseconds. */
type PhaseTimings = Record<string, number>;

/** Extra context gathered only when a log line is actually about to be
 * printed (never on every frame) — building this eagerly every frame would
 * itself be per-frame O(enemies)-ish work (filtering `enemies` for the alive
 * count) that the profiler has no business adding. */
export interface PerfContext {
  enemiesAlive: number;
  enemiesTotal: number;
  eliteEnemies: number;
  edgeCaseEnemies: number;
  mines: number;
  enemyBolts: number;
  rockets: number;
  traces: number;
  flameStreams: number;
  blood: number;
  explosions: number;
  explosionParticles: number;
  burnParticles: number;
  ammo: Record<string, number>;
  weaponName: string;
  audioShotCount: number;
  audioCtxState: string;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function heapSnapshot(): PerformanceMemory | null {
  const withMemory = performance as Performance & { memory?: PerformanceMemory };
  return withMemory.memory ?? null;
}

function fmt(ms: number): string {
  return ms.toFixed(2);
}

/** `{a:1, b:2}` -> `"a=1 b=2"` — same compact key=value shape used
 * throughout this file's log lines. */
function kv(record: Record<string, number | string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/** Aggregate view of every frame since construction/`reset()` — see
 * `FramePerfLogger`'s `window.__codeensteinPerfStats` hook below. */
export interface PerfStatsSnapshot {
  /** Total frames observed (may exceed the ring's length once it wraps). */
  frames: number;
  /** Newest-window per-frame busy time (sum of marked phases), oldest first. */
  busyMs: number[];
  /** Newest-window per-frame raw frame-to-frame delta, oldest first. */
  rawDtMs: number[];
  /** Per-phase running totals across ALL observed frames (not just the ring
   * window) — `sum/count` gives a true mean unaffected by ring overflow. */
  phases: Record<string, { sum: number; count: number; max: number }>;
}

/** Per-frame ring size for the stats hook: ~9 minutes at 120fps. */
const STATS_RING_CAPACITY = 65536;

export class FramePerfLogger {
  private phases: PhaseTimings = {};
  private phaseOrder: string[] = [];
  private frameStart = 0;
  private lastMark = 0;
  private rawDtMs = 0;
  private lastSlowLogAt = -Infinity;
  private lastPeriodicLogAt = -Infinity;

  /** Every-frame accumulators behind the `window.__codeensteinPerfStats`
   * benchmark hook. The console lines above are rate-limited (slow frames +
   * a 2s periodic snapshot), which is fine for a human-readable capture but
   * gives a benchmark only a handful of busy-time samples per run — far too
   * coarse to A/B a sub-millisecond cost against ~12% sampling noise
   * (measured by `perf:bench --calibrate`). These rings cost two
   * preallocated Float64Arrays and a few adds per frame, and exist only
   * under `?perfDebug=1` like everything else here. */
  private readonly statsBusy: Float64Array;
  private readonly statsRawDt: Float64Array;
  private statsFrames = 0;
  private statsPhases: Record<string, { sum: number; count: number; max: number }> = {};
  /** Real-time clock, independent of `dt` (which is clamped/scaled) — every
   * rate limit above is against wall-clock time so a stretch of genuinely
   * slow frames doesn't get logged faster just because each frame's `dt` is
   * itself large. */
  private wallClock = 0;

  private mouseMoveEvents = 0;
  private readonly onMouseMove = (): void => {
    this.mouseMoveEvents += 1;
  };

  constructor(statsRingCapacity: number = STATS_RING_CAPACITY) {
    this.statsBusy = new Float64Array(statsRingCapacity);
    this.statsRawDt = new Float64Array(statsRingCapacity);
    document.addEventListener("mousemove", this.onMouseMove);
    // Machine-readable side channel for the benchmark harness
    // (scripts/run-perf-benchmark.mjs) — same lifetime as this logger, i.e.
    // only ever present under `?perfDebug=1`.
    (window as Window & { __codeensteinPerfStats?: unknown }).__codeensteinPerfStats = {
      snapshot: (): PerfStatsSnapshot => this.statsSnapshot(),
      reset: (): void => this.statsReset(),
    };
    this.logEnvironmentOnce();
  }

  /** Stop listening — call if a `RaycasterEngine` with perf debug enabled is
   * ever torn down mid-session (today nothing does this; levels reload the
   * page's single engine instance rather than disposing it, but this keeps
   * the class self-contained instead of assuming that). */
  dispose(): void {
    document.removeEventListener("mousemove", this.onMouseMove);
    delete (window as Window & { __codeensteinPerfStats?: unknown }).__codeensteinPerfStats;
  }

  /** Drop everything accumulated so far — the bench calls this after its
   * warmup window so captures hold steady-state frames only. */
  private statsReset(): void {
    this.statsFrames = 0;
    this.statsPhases = {};
  }

  private statsSnapshot(): PerfStatsSnapshot {
    const capacity = this.statsBusy.length;
    const n = Math.min(this.statsFrames, capacity);
    const start = this.statsFrames - n;
    const busyMs = new Array<number>(n);
    const rawDtMs = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      busyMs[i] = this.statsBusy[(start + i) % capacity];
      rawDtMs[i] = this.statsRawDt[(start + i) % capacity];
    }
    const phases: PerfStatsSnapshot["phases"] = {};
    for (const [name, agg] of Object.entries(this.statsPhases)) phases[name] = { ...agg };
    return { frames: this.statsFrames, busyMs, rawDtMs, phases };
  }

  /** One-time environment dump at construction (i.e. the moment `?perfDebug=1`
   * spins up a level) — everything here is static for the session, so it's
   * logged once rather than repeated on every slow/periodic frame. The
   * user-agent string goes last since it's the longest and least actionable
   * field (we already know browser/OS from the bug report itself) — if
   * anything gets clipped by the sidebar's line-length cap, it should be that.
   */
  private logEnvironmentOnce(): void {
    const nav = navigator as Navigator & { deviceMemory?: number };
    console.log(
      `[perf] env: ${kv({
        cores: navigator.hardwareConcurrency,
        memGB: nav.deviceMemory ?? "?",
        dpr: window.devicePixelRatio,
        screen: `${screen.width}x${screen.height}`,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      })} ua="${navigator.userAgent}"`,
    );
  }

  /** Log map/enemy scale right after generation — separate from the
   * constructor's environment dump since `RaycasterEngine` doesn't have the
   * map's enemy/mine counts available until after it's loaded. */
  logLevelScale(mapWidth: number, mapHeight: number, enemyCount: number, eliteCount: number, edgeCaseCount: number, mineCount: number, canvasWidth: number, canvasHeight: number): void {
    console.log(
      `[perf] level: ${kv({
        map: `${mapWidth}x${mapHeight}`,
        canvas: `${canvasWidth}x${canvasHeight}`,
        enemies: enemyCount,
        elite: eliteCount,
        edgeCase: edgeCaseCount,
        mines: mineCount,
      })}`,
    );
  }

  /** Start timing a new frame — `rawDtMs` is the *unclamped* frame-to-frame
   * wall-clock delta (see `RaycasterEngine.frame`'s own `rawDt`), since a
   * clamped `dt` would hide exactly the stalls this exists to catch. */
  beginFrame(rawDtMs: number): void {
    this.phases = {};
    this.phaseOrder = [];
    this.rawDtMs = rawDtMs;
    this.wallClock += rawDtMs;
    this.frameStart = performance.now();
    this.lastMark = this.frameStart;
  }

  /** Record elapsed time since the previous `mark()` (or `beginFrame()`)
   * under `phase`. Call once per named phase per frame, in order — phases
   * are summed in case a name is ever reused, but every call site today uses
   * a distinct name per frame. */
  mark(phase: string): void {
    const now = performance.now();
    if (!(phase in this.phases)) this.phaseOrder.push(phase);
    this.phases[phase] = (this.phases[phase] ?? 0) + (now - this.lastMark);
    this.lastMark = now;
  }

  /**
   * Decide whether this frame is worth a log line (slow, or the periodic
   * baseline interval elapsed) and, only if so, build `context` and print.
   * `context` is a thunk so the entity-count/array-length work it does never
   * runs on a frame that isn't actually being logged. Two lines: the first
   * is the actual diagnostic payload (timing/phases/unaccounted/mouse rate);
   * the second is supporting state (entity counts/ammo/weapon/audio/heap) —
   * split so neither trips the sidebar's per-line truncation.
   */
  endFrame(context: () => PerfContext): void {
    const totalPhaseMs = this.phaseOrder.reduce((sum, name) => sum + this.phases[name], 0);
    const instantFps = this.rawDtMs > 0 ? 1000 / this.rawDtMs : Infinity;

    // Every-frame stats accumulation for the benchmark hook — must run
    // before the rate-limit early return below, which is the whole point.
    const ringIndex = this.statsFrames % this.statsBusy.length;
    this.statsBusy[ringIndex] = totalPhaseMs;
    this.statsRawDt[ringIndex] = this.rawDtMs;
    this.statsFrames += 1;
    for (const name of this.phaseOrder) {
      const agg = (this.statsPhases[name] ??= { sum: 0, count: 0, max: 0 });
      const ms = this.phases[name];
      agg.sum += ms;
      agg.count += 1;
      if (ms > agg.max) agg.max = ms;
    }

    const isSlow = instantFps < SLOW_FPS_THRESHOLD;
    const slowLogDue = isSlow && this.wallClock - this.lastSlowLogAt >= SLOW_LOG_MIN_INTERVAL_MS;
    const periodicLogDue = this.wallClock - this.lastPeriodicLogAt >= PERIODIC_LOG_INTERVAL_MS;
    if (!slowLogDue && !periodicLogDue) return;

    if (slowLogDue) this.lastSlowLogAt = this.wallClock;
    if (periodicLogDue) this.lastPeriodicLogAt = this.wallClock;

    const ctx = context();
    const heap = heapSnapshot();
    const mouseMoveEvents = this.mouseMoveEvents;
    this.mouseMoveEvents = 0;

    const phaseStr = this.phaseOrder.map((name) => `${name}=${fmt(this.phases[name])}`).join(" ");
    // Time this frame spent somewhere *not* between a beginFrame/mark pair —
    // main-thread GC, style/layout/paint, another tab, or the browser simply
    // not scheduling our rAF callback promptly all show up here rather than
    // in any named phase above.
    const unaccountedMs = fmt(Math.max(0, this.rawDtMs - totalPhaseMs));
    const tag = slowLogDue ? "SLOW" : "tick";

    console.log(
      `[perf] ${tag} ${fmt(this.rawDtMs)}ms (~${Math.round(instantFps)}fps) unacct=${unaccountedMs}ms mouse=${mouseMoveEvents}/f | ${phaseStr}`,
    );

    const heapStr = heap
      ? `heapMB=${Math.round(heap.usedJSHeapSize / 1048576)}/${Math.round(heap.totalJSHeapSize / 1048576)}/${Math.round(heap.jsHeapSizeLimit / 1048576)}`
      : "heapMB=n/a";
    console.log(
      `[perf] state: enemies=${ctx.enemiesAlive}/${ctx.enemiesTotal}(elite=${ctx.eliteEnemies},edge=${ctx.edgeCaseEnemies}) mines=${ctx.mines} bolts=${ctx.enemyBolts} rockets=${ctx.rockets} traces=${ctx.traces} flames=${ctx.flameStreams} blood=${ctx.blood} expl=${ctx.explosions}/${ctx.explosionParticles}/${ctx.burnParticles} | ammo:${kv(ctx.ammo)} weapon=${ctx.weaponName} | audio shots=${ctx.audioShotCount} ctx=${ctx.audioCtxState} | ${heapStr}`,
    );
  }
}
