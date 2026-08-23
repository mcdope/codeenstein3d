# Performance Tooling

The instrumentation and benchmark harness built during the 2026-07 performance audit. Two layers: an in-game diagnostic mode any player can switch on (`?perfDebug=1`), and a repeatable Playwright benchmark harness on top of it (`npm run perf:bench` / `perf:report`). The audit's measured conclusions live in [`perf-findings.json`](../../perf-findings.json) and the generated `perf-report.html`; this page documents the tools, not the results.

## `?perfDebug=1` — in-game frame diagnostics

Adding `?perfDebug=1` to the URL constructs a `FramePerfLogger` (`src/engine/perfDebug.ts`) alongside the engine. Without the flag, none of this code runs — every engine call site is `this.perf?.…`.

**What it logs** (via plain `console.log`, deliberately, so the lines render in the in-game console sidebar and ride along in a player's screen recording — no DevTools needed):

- `[perf] env: …` once at startup — cores, memory, DPR, screen/viewport, user agent
- `[perf] level: …` after each map generation — map size, canvas size, enemy/mine counts
- `[perf] tick|SLOW <raw>ms (~<fps>fps) unacct=<ms> mouse=<n>/f | <phase>=<ms> …` — one frame's full phase breakdown, nine phases: input-poll, input-actions, sim, viewmodel, firing, raycast-walls, billboards+targeting, particle-effects, hud. `SLOW` fires for frames under 45fps (rate-limited to one per 250ms); `tick` is a periodic baseline every 2s. (The rate-limit clock accumulates the passed raw deltas, so under a direct `advance()` driver — replay viewer, headless — those intervals are simulation time, not wall time; the stats ring below is unaffected.) **`unacct` is the key diagnostic**: raw frame delta minus the sum of measured phases — GC, compositor, or the browser not scheduling the rAF promptly. A slow frame with small phases and large `unacct` is stalling *outside* game code.
- `[perf] state: …` paired with each of the above — entity counts, ammo, weapon, audio state, heap

**Machine-readable side channel:** the logger also exposes `window.__codeensteinPerfStats` (`snapshot()`/`reset()`) — per-frame busy-time and raw-delta rings plus per-phase running totals, accumulated for **every** frame, not just the rate-limited logged ones. This exists because the 2s console cadence gives a benchmark only 2–3 busy samples per 30s run — far too coarse to A/B a sub-millisecond cost. Same `?perfDebug=1`-only lifetime.

Phase begin lives in `advance()` itself (not the rAF `frame()` wrapper), so direct drivers — the replay viewer, headless harnesses — get correct per-frame phases too. That was audit finding F21: it used to live in `frame()` only, and replay watching logged monotonically accumulating garbage.

## `npm run perf:bench` — repeatable benchmark harness

`scripts/run-perf-benchmark.mjs` + `scripts/lib/perfSampler.mjs` (injected rAF interval sampler, zero game-source changes) + `scripts/lib/perfConsoleParse.mjs` (parser for the `[perf]` grammar). Reference for the full CLI is the script's own header comment; the load-bearing design points:

- **Two metrics, and neither substitutes for the other.** Report both.
  - **Busy time** — the A/B metric for cost *inside* the frame callback. rAF pins intervals to vsync, so a cost delta smaller than the frame budget is invisible in intervals. Busy time (sum of measured phases per frame, from the stats hook) is refresh-rate-independent.
  - **Presented frames** — dropped-frame count and percentage, for cost *outside* the frame callback. **Busy measures the time to _record_ canvas draw calls; rasterising that display list happens afterwards, in the GPU process, and busy cannot see it at all.** A change that leaves busy flat at 6.1ms and drops a third of the frames is not hypothetical — see [`perf-review-2026-08-02.md`](perf-review-2026-08-02.md), where exactly that ran for months and was misfiled as environmental by an audit that only looked at busy. The harness derives the display's frame period from the run's own median rather than assuming 60Hz, and counts an interval at or beyond 1.5 periods as dropped.
- **Calibrate before comparing**: `--calibrate` runs the idle cell 10 times and reports the coefficient of variation (scoped to the invocation's own cells — a `--resume` into a dir holding unrelated idle runs can no longer widen it); a delta below ~2× that spread is "no measurable difference" (≈0.1–0.2ms on the reference machine). Never claim an A/B result without stating this floor.
- **Flag A/B** (`--flag aa|scaling|fog|floorfast|floorhalf|floorhalfauto`): interleaves baseline/flagged runs A,B,A,B (defeats thermal drift), temporarily flipping the compile-time const in-source with a guarded git-restore. `fog`, `floorfast` and `floorhalfauto` are inverted (their defaults are on; the flagged variant measures turning each *off*).
- **DVFS can flip a busy A/B's sign.** Busy-ms is CPU-clock-dependent under `schedutil`, and the clock follows load: the u32 floor-cast read **+1.3ms** (a regression) in a properly interleaved A/B at 640×400 while genuinely being **−0.5ms** faster — the lighter arm dropped a boost bin. Interleaving does not protect against this; it is within-run, not thermal. Any busy A/B whose arms run below ~90% duty must be clock-equalized (the `c2-2bg` cell: two busy-loop burners in both arms) or run on a saturated cell (`res-double`). Pacing metrics are immune but cannot arbitrate while both arms hold refresh rate.
- **Scenarios** (`--scenario`): `s1-idle` (calibration workload), `s2-replay` (deterministic combat — the bundled default-highscore replay), `s3-stress` (IDKFA/IDDQD rocket+flame particle stress at the **Extreme** gore tier) / `s3-splatter` (the same macro at **Absurd**, the top tier — 45x spawns, an 1800-particle cap and stains that never expire; `s3-stress` stays pinned to Extreme so its budget history keeps comparing, and this cell tracks the current ceiling), `s4-magento*` (Task-241 shape: the magento2 GitHub repo's `…/Pdo/Mysql.php`, a 160×160 map with 280 enemies, network HAR-replayed offline — re-record with `CODEENSTEIN_PERF_HAR_RECORD=1`; sub-cells: idle/fire/dryfire/mouseflood/move/fire-quiet), `s5-bot-demo` (the balancing bot plays; needs `?testHooks=1` — see caveat below). The 2026-08 frame-budget audit added: `c1-raycast`/`c2-sprites`/`c3-stress` (worst-case balancing-corpus levels — stb `stb_vorbis.c` and laravel `Query/Builder.php`, 522 enemies — loaded as single-file local workspaces via an OPFS `showDirectoryPicker` stub, `scripts/lib/opfsWorkspace.mjs`, pinned `?seed=`; no testHooks, real clock), the `l0-empty`…`l8-full` cumulative ablation ladder and `only-*` full-minus-one cells (driven by the engine's `?ablate=` kill switches), `res-half`/`res-double` (internal resolution via `?renderRes=WxH`), `view-1080/4k/6k` (window-size raster probes), `load-*bg` (CPU burners), `gpu-bg` (4K-repaint neighbor window), and `c2-2bg` (the clock-equalized A/B cell). Level-density selection for the corpus cells: `scripts/dump-level-density.mjs`; per-frame draw-call census: `scripts/count-draw-calls.mjs`.
- **Substrate**: `--channel chrome` measures on the installed system Chrome (the actual target) instead of Playwright's bundled Chromium; the browser version lands in `manifest.json`. Measured 2026-08-16: no divergence beyond noise between the two. `--no-sampler`/`--no-perfdebug` disable one instrument to measure its own overhead through the other (both measured ≤ the calibration noise floor). The injected sampler also carries `PerformanceObserver` capture (`longtask` + `long-animation-frame`, feature-detected per run) and a per-frame `usedJSHeapSize` ring for GC-drop detection.
- **Output**: one JSON per run under gitignored `perf_runs/<timestamp>/`, `manifest.json` for per-cell crash resume, `sceneStates` fingerprint per run (a cell whose driver silently degrades to an idle scene is visible in the data — that failure happened during the audit).
- **Throttle guard**: any run whose median frame interval exceeds 100ms self-marks `throttled: true` and warns — an occluded/locked-screen window gets rAF-throttled to ~1Hz and would otherwise silently poison the medians (that also happened). `perf:report` excludes throttled runs from every aggregate and prints the excluded count per cell.
- The harness runs its own vite on **:5199** (or `CODEENSTEIN_PERF_URL`); it never touches the regular dev server on 5173.

## The regression guard

`src/engine/renderCost.test.ts` runs in the normal Vitest suite and asserts that **no per-frame renderer issues `fill()`, `stroke()` or `strokeRect()` on the scene canvas**. Those three are the calls measured to actually rasterise; path *building* (`beginPath`/`moveTo`/`lineTo`/`arc`/`rect`) is free until something fills it, and the automap's viewport `clip()` legitimately builds a rect path.

It exists because this bug class is invisible in code review: `ctx.strokeRect(…)` is free or costs a quarter of the frame budget depending on a `lineJoin` set by whatever drew before it, and `drawWeapon` sets exactly that. The test forces the pre-rendered fast path (it stubs an offscreen context that actually paints, so `pathSprites`' capability probe passes) — without that it would exercise the direct-draw fallback, which is *supposed* to use paths, and pass vacuously. That vacuity check is itself the first assertion in the file.

Verified to fail: injecting a raw `ctx.strokeRect` into `drawHud` turns it red with the call count, the call site and the suggested replacement.

`npm run perf:report -- perf_runs/<dir> [--findings perf-findings.json]` (`scripts/build-perf-report.mjs`) renders one or more run directories — findings only when passed explicitly via `--findings`; a bare invocation with no directory prints usage and exits — into the self-contained `perf-report.html` — interval CDFs, busy box-plots with per-run dots, phase stacks, A/B dumbbells annotated with the calibration floor, heap timelines, and the ranked findings with their outcomes.

## The 2026-08 penalty did not reproduce on a 2026-08-23 machine

Recorded because it undercuts the evidence for rules this codebase follows
everywhere, and because the next person to measure should know before they
start rather than after.

The model in [`perf-review-2026-08-02.md`](perf-review-2026-08-02.md) is that any
draw Skia cannot emit as an axis-aligned quad forces a coverage pass costing
~10ms/frame, fixed and all-or-nothing. Its headline datum: **one `ctx.fill()`
per frame took 59.3 fps to 43.7**. That finding is why `outlineRect` exists,
why `pathSprites` bakes a 128-step rotation atlas instead of calling
`ctx.rotate`, and what `renderCost.test.ts` guards.

Trying to answer the rotated-`drawImage` question that review left open
(`:222`), a probe was built in its own shape — a steady baseline held at the
vsync edge, then exactly one extra call per frame — and run **headed** on
Chrome 151 with a real GPU (NVIDIA RTX 4060 Ti via ANGLE, confirmed not
SwiftShader), interleaved across four rounds:

| arm | fps | median | frames >20ms |
|---|---|---|---|
| baseline | 58.8 | 16.70ms | 2.1% |
| + one axis-aligned `drawImage` | 59.6 | 16.70ms | 0.7% |
| + one **rotated** `drawImage` | 59.5 | 16.70ms | 0.8% |
| + one `ctx.fill()` — **the control** | 59.4 | 16.70ms | 1.1% |

**The control is the result.** `fill` was included precisely because the review
measured it cratering, and it did not move. So this says nothing about rotated
quads being cheap; it says the instrument could not see the effect it was built
to detect, which is a broken experiment rather than a null.

What it does not distinguish: a probe too unlike the real render path, versus a
penalty that has genuinely gone away in a newer Chrome or on different hardware.
Both are live. **Do not read this as permission to start calling `ctx.fill()`**
— but equally, do not treat the 43.7 figure as reproducible without re-taking
it. Anyone re-measuring should run the `fill` control first and only trust the
run if it fires.

## Gotchas (each cost the audit real time)

- **Never pass `?testHooks=1` to a cell that should measure normal play** — it switches real telemetry recording on (`engine.ts`, `PLAYER_STATS_ENABLED ‖ testHooks`). Level readiness is detected from the `[perf] level:` console line instead. The bot cell (`s5`) can't avoid it; its numbers are labeled accordingly.
- **Synthetic input targets**: gameplay keys must be dispatched on the **canvas element** (the engine's listeners live there; synthetic `KeyboardEvent`s don't bubble), overlay-dismiss Space on **window**; input within ~1s of the briefing dismissal lands before `engine.start()` attaches listeners and silently disappears; `cheatQueued` holds one cheat per engine frame. Verify effects via state (`sceneStates`, test hooks), never assume delivery.
- **Stationary players die**: roaming melee enemies kill an idle player at ~t+10s — idle cells run under IDDQD, or the capture measures the Kernel Panic screen.
- **Headless is not a free choice — it is correct for busy time and blind for draw-call shape.** Headless Chromium rasterises the canvas in software, on a path where the GPU-process coverage-pass penalty does not exist: every scenario reads a flat 60fps with zero dropped frames there *no matter what the renderer does*. The harness prints a warning when you use it, and tags the presented-frame number `[HEADLESS — cannot see raster cost]` so it can never be quoted without the caveat. Anything touching paths, strokes, joins or clips **must** be measured headed.

  Demonstration, same build and same scenario, taken 30 seconds apart:

  | | presented | busy (median) |
  |---|---|---|
  | headed | 59.4fps, 7/713 dropped (1.0%) | 6.60ms |
  | headless | 60.0fps, 0/600 dropped (0.0%) | 6.60ms |

  Identical busy; the headless run cannot distinguish a healthy build from a broken one.

- **Headed mode measures the desktop too**: some slow frames in headed runs are genuinely missed vsyncs with the time in `unacct` (compositor/ambient load) rather than anything the game did. That is real, and it is *also* what a GPU-rasterisation cost looks like from inside the frame callback — the 2026-07 audit read the first as an explanation for the second and closed a real bug as environmental. Distinguishing them takes a headed A/B against a changed build, not a single capture: if suppressing a class of draw call moves the dropped-frame count, it was never ambient load.
