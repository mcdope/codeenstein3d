# Performance Audit — Progress

Disposable tracking file for the full-scale performance audit (branch `perf`).
Delete once shipped (report reviewed, quick wins decided).
Full design: `/home/mcdope/.claude/plans/you-re-a-senior-performance-calm-dahl.md`

## Data manifest

- Benchmark output: `perf_runs/<timestamp>/` (gitignored), one JSON per run per cell.
- `perf_runs/<timestamp>/manifest.json` tracks per-cell status (pending/running/done/failed)
  — a crashed matrix run resumes per-cell via `npm run perf:bench`, never restarts.

## Milestones

- [x] 0. Scaffolding — this file, `.gitignore` (`perf_runs/`, `perf-report.html`), npm scripts `perf:bench`/`perf:report`
- [ ] 1. Benchmark harness (`scripts/run-perf-benchmark.mjs`, `scripts/lib/perfSampler.mjs`, `scripts/lib/perfConsoleParse.mjs`) + variance calibration (10× idle, CoV → minimum detectable difference)
- [ ] 2. Scenario matrix drivers: S1 idle, S2 replay-campaign, S3 particle stress, S4 magento2 (HAR-replayed) with sub-cells look/fire/dry-fire/mousemove-flood
- [ ] 3. Baseline collection (full matrix, baseline flags, chromium headed; headed-vs-headless calibration; firefox/webkit S1+S2 sanity)
- [ ] 4. Flag A/B: WALL_EDGE_ANTIALIASING (S1/S2/S4), RESPONSIVE_CANVAS_SCALING (S1/S2 + resize storm) — sed-flip + guarded restore, interleaved runs
- [ ] 5. Static audit fan-out (5 subagents: allocations, canvas state, algorithmic scaling, bundle/startup, DOM/side-channel) → findings queue below
- [ ] 6. Verification experiments (entity/map-size sweeps, GC attribution, 10-min heap soak, Task 241 repro attempt)
- [ ] 7. Report `perf-report.html` via `npm run perf:report` (charts; findings as Symptom/Culprit/Impact/Refactor ranked by impact-per-effort) + quick-wins list

## Open findings queue

(hypothesis → verification status → verdict; nothing enters the report unverified)

| # | Hypothesis (file:line) | Source | Status |
|---|---|---|---|
| — | pathField.ts full-map BFS reflood on player tile crossing scales with map area (magento2 suspect) | plan-phase exploration | pending M5-C/M6 |
| — | billboards: per-frame jobs array + ~10-collector spread + depth sort (engine.ts ~1419-1439) | plan-phase exploration | pending M5-A/M6 |
| — | raycaster: ~3 globalAlpha writes × 640 columns/frame | plan-phase exploration | pending M5-B/M6 |

## Decisions log

- 2026-07-18: Phase timings scraped from existing `?perfDebug=1` console.log output via Playwright — zero source changes. Fallback (only if 2s snapshot granularity too coarse for A/B): additive gated accumulator in perfDebug.ts, ~40 lines + tests.
- 2026-07-18: Busy time (perfDebug phase sums), not frame intervals, is the primary A/B metric — rAF is vsync-pinned.
- 2026-07-18: Bench harness uses its own vite on port 5199 (or `CODEENSTEIN_PERF_URL`); never touches the user's 5173 server.
