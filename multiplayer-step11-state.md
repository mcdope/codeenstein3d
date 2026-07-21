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
- [x] Phase 2a: `TelemetryState` split — per-player-attributable fields
      (damage/heal/loot/weapon tallies/mine-disarm/fatal-source/regular-
      kill-loot-roll) moved onto each `PlayerState.telemetry`; the handful
      with no single owner (peakAggroedCount/combatTimeSec/TTK windows/
      minesTriggered/lootRolled/enemyBoltsFired/enemyMeleeAttacks) stay on a
      new engine-level `teamTelemetry` (`TeamTelemetryState`, new type in
      `telemetry.ts`) — single-player is N=1 so `getTelemetrySnapshot()`
      still returns the exact same flat shape, just assembled from two
      objects instead of one (all existing single-player tests pass
      unchanged, confirming this). Per-frame health/ammo update now loops
      every player, not just local. `killsForcedByMelee`/`recordKill`/
      `recordHeal("lifesteal")`/`recordRegularKillLootRoll` now attribute to
      `shooter.telemetry` (the actual killer), not whichever player happened
      to share the old single instance — a real, previously-dormant bug
      (`PlayerState.priorPlayerStats` mixing every player's events into one
      bucket) fixed as part of the same change. Enemy-bolt-hit attribution
      dropped the separate `onHit` callback entirely (`projectiles.ts`'s
      `updateProjectiles()` lost that param) — derived instead straight from
      its own per-player damage return `Map`, per the plan's correction #2.
      New `RaycasterEngine.getMultiplayerTelemetrySnapshot(id)` (via a shared
      private `buildTelemetrySnapshotFor(id)` also used by the single-player
      hook) mirrors `getBotPlayerState(id)`'s pattern. Left unwired into
      `main.ts`'s `__codeensteinMultiplayerTestHooks` by design (to avoid a
      two-way edit conflict with Phase 2b, running concurrently in a
      separate worktree) — wired through after both phases merged (see
      Phase 2b's own entry below for the follow-up commit). Typecheck clean;
      `engine.ts`/
      `telemetry.ts`/`projectiles.ts` all 100% covered (one unrelated
      pre-existing gap, `computeMeleeAndMineHitChecks`'s `meleeWouldHit`
      line, only shows up in this sandboxed worktree because `main.test.ts`
      can't load here — tree-sitter wasm path denial, unrelated to this
      diff, confirmed via `git diff` that those lines are untouched).
- [x] Phase 2b: `getConnectionStats(id)` (`connectionStats.ts`, new —
      `RTCPeerConnection.getStats()`'s active-candidate-pair
      `currentRoundTripTime`, zero prior usage anywhere in `src/`),
      `getMissedTickStats()` (cumulative `heldInputFallback` tally, seeded
      from the fixed roster), `getReconciliationCorrections()` (guest-only —
      the host is authoritative and never applies a snapshot to itself, so
      its own copy is always `{}`; a correction only counts once its
      position magnitude clears a small noise floor,
      `RECONCILIATION_CORRECTION_NOISE_FLOOR_TILES = 0.001` tiles, below
      which it's ordinary cross-peer float drift, not a real desync).
      `ConnectionStateSource` widened with a `getStats()` member (both test
      files' `FakeConnection` fakes updated to match). Wired into
      `run-balancing-telemetry-multiplayer.mjs`'s report as a real
      `netcodeHealth` section (RTT sampled per real link — star topology,
      both directions; missed-tick fraction and reconciliation corrections
      read once per attempt, at teardown, since they're cumulative counters
      not point-in-time samples) and into `main.ts`'s
      `__codeensteinMultiplayerTestHooks`. Verified with a real, live 2-peer
      session (not just unit tests): RTT genuinely non-placeholder (0ms on
      loopback), missed-tick tally matched the real bootstrap-transient
      warm-up, host's corrections stayed `{}`, guest's stayed at 0 for a
      truly idle session (proving the noise floor suppresses false
      positives, not just that it compiles). 100% line/branch/statement/
      function coverage on every touched `src/` file except `main.ts` itself
      — `main.test.ts` couldn't be run inside this isolated worktree (a
      pre-existing Vite fs-boundary "Denied ID" error on `node_modules/
      tree-sitter-*.wasm` unrelated to this change — confirmed by the same
      error hitting untouched parser test files too); the 3 new hooks are
      trivial one-line delegations mirroring an already-tested pattern
      shared by every other hook in that same object, and test coverage was
      still added to `main.test.ts` by inspection — confirmed via a real run
      from the main working tree after merging both phases (299 files, 6094
      tests, all green). Post-merge follow-up (done in the merge commit, not
      by either fork): wired Phase 2a's `getMultiplayerTelemetrySnapshot(id)`
      through `MultiplayerSessionHandle` (both host/guest implementations,
      mirroring `getBotPlayerState`'s exact pattern) and into `main.ts`'s
      `__codeensteinMultiplayerTestHooks` — this was the one piece neither
      fork owned, by design, to avoid the file-overlap conflict.
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
