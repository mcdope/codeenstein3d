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
- [x] 1. Benchmark harness + calibration (done 2026-07-18). Calibration (10× idle, headed, 60Hz display): interval median CoV 0.2% (vsync-pinned, useless for A/B — as designed), busy-median CoV 11.7% but from only 2-3 periodic samples/run → decision gate FIRED: added the gated stats accumulator (`window.__codeensteinPerfStats` in perfDebug.ts, per-frame busy ring, +tests). Idle busy ≈5-6ms: raycast-walls ~4-6ms, hud ~0.9ms, rest ≈0.1ms. "SLOW" idle frames = single missed vsyncs (33.3ms, unacct≈27ms) — compositor, not game work. Data: `perf_runs/2026-07-17T23-38-21-892Z/calibration.json`.
- [x] 2. Scenario drivers validated (2026-07-18): S1 idle, S2 replay (F21 workaround: busy recovered by differencing — replay loop never calls perf.beginFrame), S3 IDKFA stress, S4 magento2 via 18MB HAR (gitignored, `scripts/fixtures/perf-har/`; re-record: CODEENSTEIN_PERF_HAR_RECORD=1) opening magento2/lib/…/Pdo/Mysql.php → 160×160 map, 280 enemies; S4 sub-cells fire/dryfire/mouseflood; S5 bot-plays-demo (testHooks caveat). Level transitions mid-capture (s2/s5) reset the stats hook — busy stats cover the newest level only, interval sampler unaffected.
- [x] 3. Baseline collection (2026-07-18, `perf_runs/2026-07-18T00-13-09-796Z`, 8 cells × 5 headed runs). Gotcha caught mid-run: idle player DIES at t≈10.1s to roaming melee (measured) — s1/calibration data was ~5s gameplay + 25s Kernel Panic screen; idle cells now IDDQD'd, invalid s1 runs purged, calibration redone. KEY RESULTS: (a) all slow frames are ~33ms double-vsyncs with unacct≈27ms — stalls live OUTSIDE game code (GC/compositor), game phases stay ~5ms even during them; (b) magento cells have 2-3× the slow-frame rate of demo cells (124-205 vs 65-76 per 5×30s), firing adds ~+80 over magento idle → matches F8 (combat console.log → sidebar DOM thrash) + GC pressure (heap 80MB vs 12MB); (c) mouseflood did NOT raise slow count (105 vs 124 idle) — gaming-mouse theory weakened (synthetic-event caveat: movementX=0, no pointer lock); (d) hud phase scales with map area: 0.59ms (72×72) → 1.3-1.4ms (160×160) → F1 minimap real but ~Med at this scale; (e) S2 replay busy metrics not comparable (F21 diff-recovery, endFrame cadence differs) — use intervals for S2.
- [ ] 3b. firefox/webkit S1+S2 sanity cells (3 runs) — pending
- [ ] 4. Flag A/B: WALL_EDGE_ANTIALIASING (S1/S2/S4), RESPONSIVE_CANVAS_SCALING (S1/S2 + resize storm) — sed-flip + guarded restore, interleaved runs
- [x] 5. Static audit fan-out (5 subagents: allocations, canvas state, algorithmic scaling, bundle/startup, DOM/side-channel) → findings queue below (done 2026-07-18; ran early, in parallel with M1)
- [ ] 6. Verification experiments (entity/map-size sweeps, GC attribution, 10-min heap soak, Task 241 repro attempt)
- [ ] 7. Report `perf-report.html` via `npm run perf:report` (charts; findings as Symptom/Culprit/Impact/Refactor ranked by impact-per-effort) + quick-wins list

## Open findings queue

(hypothesis → verification status → verdict; nothing enters the report unverified.
Sources: A=allocation audit, B=canvas-state audit, C=algorithmic audit, D=bundle audit, E=DOM audit)

| # | Hypothesis (file:line) | Est. | Src | Status |
|---|---|---|---|---|
| F1 | `raycaster.ts:497` renderMinimap: unconditional O(map-area) wall fillRect loop EVERY frame in default HUD state — tens of thousands of draw calls on magento2-scale maps | High | C | pending M6 (skip-minimap diff on S4) |
| F2 | `pathField.ts:45` full-map `fill(-1)`+BFS reflood on every player tile-crossing (~every 150ms sprinting) and every door/secret `gridVersion` bump | High | C | pending M6 (map-size sweep, reflood ms log) |
| F3 | `engine.ts:2066/2111/2129` fire(): O(E) projectLivingEnemies per shot + O(E) findTarget per pellet — the "worse when shooting" suspect for all hitscan weapons | High | C | pending M6 (hold-trigger vs idle on S4) |
| F4 | `engine.ts:1419` billboards: 10 collector `.filter().map()` chains + per-item `{depth,draw}` closures + fresh sort per frame | High | A/C | pending M6 (entity-count sweep) |
| F5 | `effects.ts:332-599` particles: per-particle projectPoint object + `rgba(...)` template-string fillStyle per particle per frame (Extreme gore = 16× spawns) | High | A | pending M6 (S3 gore none-vs-extreme) |
| F6 | `enemyAi.ts:267-405` slideAxes/neighbors4 fresh objects per chasing enemy per frame (5× STEER_OFFSETS) | High | A | pending M6 (aggro-count sweep) |
| F7 | `engine.ts:2322` buildStats+computeScore: ~30-field object churn unconditionally every frame (even paused) + `[...ownedWeapons]` Set spread | High | A | pending M6 (GC/heap attribution) |
| F8 | `consoleSidebar.ts:139` `scrollTop=scrollHeight` layout thrash per console.log; combat bursts (hit/kill/loot logs, engine.ts:2192, lootApply.ts) = 30-100 logs/frame | High | E | pending M6 (kill-streak with sidebar no-op'd) |
| F9 | `raycaster.ts:267-282` per-column globalAlpha/fillStyle churn: ~2.6-5.8k state writes/frame total, 60-70% from the column loop | High | B | pending M6 (state-write caching prototype) |
| F10 | `engine.ts:1042` `input.captureSnapshot()` arg evaluated before `?.` — 18-field snapshot + filter array allocated EVERY frame with no recorder attached | Med-High | A | pending M6 |
| F11 | `input.ts:428` `Array.from(getGamepads())` full copy every frame, gamepad or not | Med | A | pending M6 |
| F12 | `spatialGrid.ts:32` O(E) rebuild every frame any rocket is airborne (per-frame, not per-flight) | Med | C | pending M6 |
| F13 | `enemyAi.ts:191` LOS raycast ≤80 steps per eligible aggroed enemy per frame; plus `:133` los closure per living enemy per frame | Med | A/C | pending M6 |
| F14 | `hud.ts` font/fillStyle churn (~36-44 writes/frame) + per-frame `measureText` (cheat toast :71, lore wrapText :220-237) | Med | B | pending M6 |
| F15 | `weapons.ts:357` pelletOffsets fresh array per shot; per-shot projection arrays | Med | A | pending M6 |
| F16 | `raycaster.ts:192` DDA cost ~O(longest sightline) per column on huge open maps | Low-Med | C | pending M6 |
| F17 | `traps.ts:49` activeSpikeTileKeys Set rebuilt 2-3× per frame (renderBackground + renderMinimap + automap) | Low | A/C | pending M6 |
| F18 | Misc constant per-frame allocs: `traps.find` closures, updateMines empty array, drawFlameStreams jitter closure | Low | A | pending M6 |
| F19 | Bundle: healthy overall (all 18 wasms lazy, defaultHighscore lazy 223KB gz); main bundle 101KB gz could code-split replay system (~10-15% parse win) | Low-Med | D | verified-static; report as-is |
| F20 | Startup: nothing render-blocking beyond main bundle; grammars fetched per-language on first parse — by design | Info | D | verified-static; report as-is |
| F21 | `main.ts` replay viewer drives `engine.advance()` without `perf.beginFrame()` — ?perfDebug=1 phase logs during replay watching are monotonic garbage (phases never reset). Found by harness (S2 busy=6955ms) | Low (instrumentation-only) | bench | VERIFIED by measurement; refactor: have replay loop call a public perf-begin wrapper |

Notable non-findings (checked clean): floorImage ImageData genuinely cached; pathField buffers reused (cost is the reflood, not allocation); rockets/projectiles allocation-free in flight; textures cached; telemetry OFF in normal play (engine.ts:744 gates on PLAYER_STATS_ENABLED=false ‖ ?testHooks=1 — memory said "unconditional", that was reverted); audio nodes short-lived by design; no O(E²) anywhere.

## Decisions log

- 2026-07-18: Phase timings scraped from existing `?perfDebug=1` console.log output via Playwright — zero source changes. Fallback (only if 2s snapshot granularity too coarse for A/B): additive gated accumulator in perfDebug.ts, ~40 lines + tests.
- 2026-07-18: Busy time (perfDebug phase sums), not frame intervals, is the primary A/B metric — rAF is vsync-pinned.
- 2026-07-18: Bench harness uses its own vite on port 5199 (or `CODEENSTEIN_PERF_URL`); never touches the user's 5173 server.
- 2026-07-18: Bench does NOT pass `?testHooks=1` — that would switch telemetry recording ON (engine.ts:744) and contaminate normal-play measurements. Level readiness is detected from perfDebug's `[perf] level:` console line instead.
