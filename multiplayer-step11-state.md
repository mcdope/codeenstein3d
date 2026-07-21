# Multiplayer step 11 progress

Disposable progress file — delete once step 11 ships. Plan:
`~/.claude/plans/plan-step10-of-the-toasty-book.md`. Spec (source of truth for
design): `doc/dev/multiplayer-balancing-telemetry-spec.md`.

Scope: full spec (user chose "full spec now" over MVP-only). Phased delivery,
each phase independently verified/committed before moving to the next.

## Status

- [x] Phase 0: `scripts/lib/multiplayerSessionBootstrap.mjs` (extracted from
      `verify-multiplayer-multiguest.mjs`, generalized to N=2-4) + dedicated
      local signaling server helper (`scripts/lib/multiplayerTestServers.mjs`).
      Real bug found+fixed while smoke-testing: `npm run dev`'s own child
      `vite` process survives killing the `npm` wrapper alone (confirmed
      directly — it kept serving after `devProc.kill()`) — fixed via
      `detached: true` + negative-pid process-group kill.
      `verify-multiplayer-multiguest.mjs` refactored to use both new
      modules instead of its own copy of this logic — full local run (real
      chromium, 3-peer session, disconnect scenario) still passes clean.
- [x] Phase 1: N simultaneous `MultiplayerBot` instances (uniform profile),
      `qualifyLoop.mjs` combo matrix, free anomaly detectors turned on,
      `scripts/run-balancing-telemetry-multiplayer.mjs` +
      `balancing:telemetry-multiplayer`/`balancing:scan-multiplayer` npm
      scripts, top-level-keyed report shape. `bootstrapMultiplayerSession`
      gained a `difficulty` option (sets `localStorage` in every context
      before load, same mechanism `run-balancing-telemetry.mjs`'s
      `installDifficulty` uses). Real, reproducible finding from smoke
      testing (not a script bug): a uniform-Casual 2p pair hits the same
      `stall`/`healthDrainFrozen` anomaly sequence near-identically across
      separate attempts around a mined corridor on `demo-campaign/main.c`
      (~pos (37.5,49.3), mineDist ~3.0-4.0) — worth a closer look in a
      future balancing pass, not something Phase 1 itself should fix.
      `multiplayer_balancing_telemetry.json` added to `.gitignore` (report
      output, mirrors single-player's own `balancing_telemetry.json`).
- [ ] Phase 2a: `TelemetryState` → `PlayerState.telemetry`, ~10 call-site
      retags, per-frame update loop fix, bolt-hit attribution via
      `updateProjectiles()`'s return value, `getMultiplayerTelemetrySnapshot(id)`
- [ ] Phase 2b: `getConnectionStats(id)` (RTCPeerConnection.getStats RTT),
      `heldInputFallback` tally, reconciliation-correction counter,
      `netcodeHealth` report section
- [ ] Phase 3: curated mixed-skill combos, tick-skew-growth-over-time
      detector, disconnect-isolation scored scenario
- [ ] Phase 4: `doc/dev/balancing-telemetry.md` consolidation, apply 3 spec
      corrections to the spec doc, `notes` step11 entry → implemented
- [ ] Final verification: typecheck, 100% coverage, local
      `balancing:scan-multiplayer` run, single-player regression check
- [ ] Commit/push, PR, watch CI

## Spec corrections to apply in Phase 4 (already known, listed in the plan)

1. `lootCtx.recordApplied` closure: `engine.ts:990` → `:1092` (content
   unchanged, just line drift).
2. `onEnemyBoltHit` is NOT part of `EnemyAiEvents` — it's
   `updateProjectiles()`'s own `onHit` param (`projectiles.ts:89-97`), which
   already returns per-player damage — use that instead of threading a new id
   through the callback.
3. §7's "30/min PUT /session" citation to `multiplayer-server-spec.md` §4 is
   wrong — that number is implementation-only, not in the design doc. Also
   add the 4th limiter (`LOBBY_RATE_LIMIT_MAX_REQUESTS = 60`/min) §7 omits.

## Decisions locked in (see plan for full rationale)

- Full spec scope, not MVP-only (user's explicit choice).
- Phased delivery: Phase 0/1 sequential (hard dependency), Phase 2a/2b
  fork-able in parallel once Phase 1 lands, Phase 3 only depends on Phase 0/1
  (can run parallel to Phase 2).
- Report JSON shape is top-level-keyed from Phase 1 onward so later phases
  only ever add a key, never edit shared aggregation logic.
- No virtual clock possible for multiplayer — real-time-only cost model,
  concurrency defaults must be modest (documented, not copied from
  single-player's cheap virtual-time concurrency).
- `peakAggroedCount`/`combatTimeSec`/TTK windows/`minesTriggered`/`lootRolled`
  stay team-level telemetry buckets (deliberate, not deferred-as-oversight).
  Kill credit stays finishing-blow-only.
