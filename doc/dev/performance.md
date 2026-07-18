# Performance Tooling

The instrumentation and benchmark harness built during the 2026-07 performance audit. Two layers: an in-game diagnostic mode any player can switch on (`?perfDebug=1`), and a repeatable Playwright benchmark harness on top of it (`npm run perf:bench` / `perf:report`). The audit's measured conclusions live in [`perf-findings.json`](../../perf-findings.json) and the generated `perf-report.html`; this page documents the tools, not the results.

## `?perfDebug=1` — in-game frame diagnostics

Adding `?perfDebug=1` to the URL constructs a `FramePerfLogger` (`src/engine/perfDebug.ts`) alongside the engine. Without the flag, none of this code runs — every engine call site is `this.perf?.…`.

**What it logs** (via plain `console.log`, deliberately, so the lines render in the in-game console sidebar and ride along in a player's screen recording — no DevTools needed):

- `[perf] env: …` once at startup — cores, memory, DPR, screen/viewport, user agent
- `[perf] level: …` after each map generation — map size, canvas size, enemy/mine counts
- `[perf] tick|SLOW <raw>ms (~<fps>fps) unacct=<ms> mouse=<n>/f | <phase>=<ms> …` — one frame's full phase breakdown (input, sim, raycast-walls, billboards+targeting, firing, particle-effects, hud). `SLOW` fires for frames under 45fps (rate-limited to one per 250ms); `tick` is a periodic baseline every 2s. **`unacct` is the key diagnostic**: raw frame delta minus the sum of measured phases — GC, compositor, or the browser not scheduling the rAF promptly. A slow frame with small phases and large `unacct` is stalling *outside* game code.
- `[perf] state: …` paired with each of the above — entity counts, ammo, weapon, audio state, heap

**Machine-readable side channel:** the logger also exposes `window.__codeensteinPerfStats` (`snapshot()`/`reset()`) — per-frame busy-time and raw-delta rings plus per-phase running totals, accumulated for **every** frame, not just the rate-limited logged ones. This exists because the 2s console cadence gives a benchmark only 2–3 busy samples per 30s run — far too coarse to A/B a sub-millisecond cost. Same `?perfDebug=1`-only lifetime.

Phase begin lives in `advance()` itself (not the rAF `frame()` wrapper), so direct drivers — the replay viewer, headless harnesses — get correct per-frame phases too. That was audit finding F21: it used to live in `frame()` only, and replay watching logged monotonically accumulating garbage.

## `npm run perf:bench` — repeatable benchmark harness

`scripts/run-perf-benchmark.mjs` + `scripts/lib/perfSampler.mjs` (injected rAF interval sampler, zero game-source changes) + `scripts/lib/perfConsoleParse.mjs` (parser for the `[perf]` grammar). Reference for the full CLI is the script's own header comment; the load-bearing design points:

- **Busy time is the A/B metric, not frame intervals.** rAF pins intervals to vsync — a cost delta smaller than the frame budget is invisible in intervals. Busy time (sum of measured phases per frame, from the stats hook) is refresh-rate-independent.
- **Calibrate before comparing**: `--calibrate` runs 10 identical idle cells and reports the coefficient of variation; a delta below ~2× that spread is "no measurable difference" (≈0.1–0.2ms on the reference machine). Never claim an A/B result without stating this floor.
- **Flag A/B** (`--flag aa|scaling|fog`): interleaves baseline/flagged runs A,B,A,B (defeats thermal drift), temporarily flipping the compile-time const in-source with a guarded git-restore. `fog` is inverted (its default is on; the flagged variant measures turning it *off*).
- **Scenarios** (`--scenario`): `s1-idle` (calibration workload), `s2-replay` (deterministic combat — the bundled default-highscore replay), `s3-stress` (IDKFA/IDDQD rocket+flame particle ceiling, extreme gore), `s4-magento*` (Task-241 shape: the magento2 GitHub repo's `…/Pdo/Mysql.php`, a 160×160 map with 280 enemies, network HAR-replayed offline — re-record with `CODEENSTEIN_PERF_HAR_RECORD=1`; sub-cells: idle/fire/dryfire/mouseflood/move/fire-quiet), `s5-bot-demo` (the balancing bot plays; needs `?testHooks=1` — see caveat below).
- **Output**: one JSON per run under gitignored `perf_runs/<timestamp>/`, `manifest.json` for per-cell crash resume, `sceneStates` fingerprint per run (a cell whose driver silently degrades to an idle scene is visible in the data — that failure happened during the audit).
- **Throttle guard**: any run whose median frame interval exceeds 100ms self-marks `throttled: true` and warns — an occluded/locked-screen window gets rAF-throttled to ~1Hz and would otherwise silently poison the medians (that also happened).
- The harness runs its own vite on **:5199** (or `CODEENSTEIN_PERF_URL`); it never touches the regular dev server on 5173.

`npm run perf:report` (`scripts/build-perf-report.mjs`) renders one or more run directories plus `perf-findings.json` into the self-contained `perf-report.html` — interval CDFs, busy box-plots with per-run dots, phase stacks, A/B dumbbells annotated with the calibration floor, heap timelines, and the ranked findings with their outcomes.

## Gotchas (each cost the audit real time)

- **Never pass `?testHooks=1` to a cell that should measure normal play** — it switches real telemetry recording on (`engine.ts`, `PLAYER_STATS_ENABLED ‖ testHooks`). Level readiness is detected from the `[perf] level:` console line instead. The bot cell (`s5`) can't avoid it; its numbers are labeled accordingly.
- **Synthetic input targets**: gameplay keys must be dispatched on the **canvas element** (the engine's listeners live there; synthetic `KeyboardEvent`s don't bubble), overlay-dismiss Space on **window**; input within ~1s of the briefing dismissal lands before `engine.start()` attaches listeners and silently disappears; `cheatQueued` holds one cheat per engine frame. Verify effects via state (`sceneStates`, test hooks), never assume delivery.
- **Stationary players die**: roaming melee enemies kill an idle player at ~t+10s — idle cells run under IDDQD, or the capture measures the Kernel Panic screen.
- **Headed mode measures the desktop too**: slow frames in headed runs were universally missed vsyncs with the time in `unacct` (compositor/ambient load), reproducing at zero rate headless. Headed and headless busy medians match; prefer headless for unattended collection.
