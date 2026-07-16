# Balancing Telemetry Bot

A dev-only tool for automated balance review: three scripted bot profiles (Casual/Gamer/Pro) play the bundled `demo-campaign/` across all three difficulties, and their aggregated combat/economy/navigation stats get written to `balancing_telemetry.json` (gitignored) for a human — or an LLM balance-review pass — to spot HP-curve/drop-rate/pacing problems without replaying the whole campaign nine times by hand. **Not CI-wired.** Requires a locally running dev server (`npm run dev`, default `http://localhost:5173`).

The bot itself (`scripts/run-balancing-telemetry.mjs`) drives a headless Chromium session the same way `scripts/generate-default-highscore.mjs` does — a virtual clock, `window.__codeensteinTestHooks` polling, real `KeyboardEvent`s dispatched at the canvas, BFS route planning done entirely in Node before any browser launches. See that file's own doc comment for the low-level harness rationale.

## The three entry points

| Command | What it does |
|---|---|
| `npm run balancing:telemetry` | Full 9-combo run (Casual/Gamer/Pro × easy/normal/hard), 3 qualifying runs each, writes `balancing_telemetry.json`. Slow (up to 9 × unbounded attempts × up to 17 levels) — this is the "generate real data" entry point. |
| `npm run balancing:watch` | Opens one real, visible Chromium window per profile (Casual → Gamer → Pro by default), plays one full campaign attempt at watchable real-time speed, prints a summary, waits for Enter before the next profile. `scripts/watch-bot-sessions.mjs`; reuses the same profile definitions and per-attempt driving logic (`playRun`), not a separate bot. `npm run balancing:watch -- Gamer Pro` to pick a subset/order; `CODEENSTEIN_WATCH_DIFFICULTY=hard` to change difficulty. |
| `npm run balancing:scan` | The permanent automated bot-**behavior** regression check (distinct from balance-*data* review) — see [Anomaly scanning](#anomaly-scanning-npm-run-balancingscan) below. Run this before declaring any navigation/combat change to the bot script fixed. |
| `npm run balancing:campaign` | Large-scale, resumable data-collection orchestrator — see [Large-scale campaigns](#large-scale-campaigns-npm-run-balancingcampaign) below. Not the same as `balancing:telemetry`'s fixed 3-qualifying-run sweep; this repeatedly spawns it to build up a much bigger sample, keeping every batch as its own file. |

A run only "counts" for `balancing:telemetry`'s aggregate once it clears level 4 (proves it survived the unarmed early game) — a run that dies on level 1-3 is discarded entirely; a qualifying run keeps *all* its levels' data, 1–3 included. Both the qualifying level (`QUALIFY_LEVEL_INDEX`) and the qualifying-run target (`REQUIRED_QUALIFYING_RUNS`, default 3, overridable via `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET`) live in `run-balancing-telemetry.mjs`.

## Profiles and difficulty

`PROFILES` (`Casual`/`Gamer`/`Pro`) in `run-balancing-telemetry.mjs` differ by `fireAngleEps` (aim tolerance — Pro tightest at 0.03 rad, Casual loosest at 0.08), `weaponPriority`, `healthDetourThreshold`, and `rotSpeedMultiplier` (a bot-only turn-speed override, `engine.ts`'s `rotSpeedMultiplier`, approximating a realistic *mouse* turn speed per skill tier — real `requestPointerLock()`-based mouse-look was investigated and rejected: it rejects outright under Playwright automation, headed or headless). Difficulty (`easy`/`normal`/`hard`) is wired through `localStorage["codeenstein-difficulty"]`, same as a real player's setting.

## Env var reference

All scoping/debug flags are read once at module load, so they must be set in the same process invocation (not exported separately beforehand if using a subshell that re-execs).

| Var | Effect |
|---|---|
| `CODEENSTEIN_TELEMETRY_PROFILE` | Restrict to one profile (`Casual`/`Gamer`/`Pro`). |
| `CODEENSTEIN_TELEMETRY_DIFFICULTY` | Restrict to one difficulty. |
| `CODEENSTEIN_TELEMETRY_LEVEL_LIMIT` | Cap how many campaign levels get planned/played. |
| `CODEENSTEIN_TELEMETRY_ATTEMPT_CAP` | Cap attempts per combo (default unbounded — retries until 3 qualify). Use for any scoped/smoke run; never rely on the unbounded default finishing quickly. |
| `CODEENSTEIN_TELEMETRY_CONCURRENCY` | Attempts run concurrently within one combo (separate browser contexts sharing one Chromium process; default 12). **Matters for verification, not just speed** — see [Matched-scale verification](#matched-scale-verification). |
| `CODEENSTEIN_TELEMETRY_VERBOSE` | Per-attempt death detail (`fatal=`/`kills=`/`dmgBySource=`/engaged-enemy TTKs/weapon tallies). |
| `CODEENSTEIN_TELEMETRY_DEBUG_NAV` | Permanent tick-by-tick nav/combat trace (`[nav] pos=... dir=... threat=... -> moveKeys=...`). Not a temporary debug flag — kept on purpose for whatever "why is the bot doing that" question comes up next. |
| `CODEENSTEIN_TELEMETRY_ANOMALY_SCAN` | Enables the stall/health-drain-frozen detector — see below. |
| `CODEENSTEIN_TELEMETRY_NAV_DIAG` | Extra per-decision trace bookkeeping (superset used alongside anomaly scan trace recording). |
| `CODEENSTEIN_TELEMETRY_HEADED` | Real, visible browser + real wall-clock timing instead of the virtual clock. See [Headed vs. headless](#headed-vs-headless-read-this-before-touching-turnburstms-math). |
| `CODEENSTEIN_CONSOLE_FORWARD` | Forwards the browser's own `console` output to Node (`[console] ...` lines) — the engine already logs key pickups/door unlocks; often more reliable ground truth than bot-side telemetry when a freeze's cause is ambiguous. |
| `CODEENSTEIN_WPDEBUG` | Per-waypoint drive-loop trace (`[wpdebug] leg-walk wp=... -> result=...`). |
| `CODEENSTEIN_DRIFTDEBUG` | Traces `driveTowardWithReplan`'s off-route drift/re-plan decisions. |
| `CODEENSTEIN_DEV_URL` | Override the dev server URL (default `http://localhost:5173`). |
| `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` | Override `REQUIRED_QUALIFYING_RUNS` (default 3) — how many qualifying runs a combo needs before its retry loop stops. Used by `balancing:campaign` to set a small per-invocation batch size. |
| `CODEENSTEIN_TELEMETRY_OUTPUT_FILE` | Override the output path (default `balancing_telemetry.json` at repo root). Used by `balancing:campaign` so concurrent invocations each write to their own file instead of racing to overwrite the same one. |

## Anomaly scanning (`npm run balancing:scan`)

`CODEENSTEIN_TELEMETRY_ANOMALY_SCAN=1` makes `tick()` record a per-decision trace (position, health, threat/mine distance, branch, `waitingOnSpike`) and scan it after every level for two patterns:

- **`stall`** — position anchored within 0.05 tiles for 20+ ticks (excluding legitimate spike-cycle waits).
- **`healthDrainFrozen`** — position anchored for 2+ ticks while health is also dropping.

Findings print as `[anomaly] <profile>/<difficulty> level N: <type> (...)`. The `balancing:scan` npm script runs all three profiles, normal difficulty, 8 levels, 5 attempts each. Run this (or a scoped subset via the env vars above) before reporting any bot navigation/combat fix as verified — a "few manual traces looked fine" is not sufficient given this bot's history of freezes that only reproduce after hundreds of ticks or under specific map geometry.

**This scanner is headless-only.** It cannot see bugs that only manifest under real per-frame timing — see the next section.

## Headed vs. headless: read this before touching `turnBurstMs` math

`turnBurstMs` (and its movement counterpart `moveBurstMs`) compute the exact millisecond hold-duration needed to turn/move by a given amount, on the assumption that holding a key for *N* ms produces exactly *N* ms worth of rotation/movement. **That assumption is only exactly true in headless mode.**

- **Headless** (`CODEENSTEIN_TELEMETRY_HEADED` unset): `window.__pumpVirtualTime` advances the engine's virtual clock by precisely the requested duration in one pumped `requestAnimationFrame` callback. Arbitrarily fine convergence (down to a fraction of a radian) is genuinely achievable.
- **Headed** (`CODEENSTEIN_TELEMETRY_HEADED=1`, used by `npm run balancing:watch`): the engine only actually rotates/moves once per real *rendered* frame (~16.7ms at 60fps). A `page.waitForTimeout` wait shorter than roughly one real frame does not reliably produce a proportionally small rotation — real frame/timer granularity dominates. Any convergence epsilon tighter than roughly `ENGINE_ROT_SPEED * rotSpeedMultiplier / realFps` is **structurally unreachable** in headed mode.

Concretely: a fine-alignment epsilon like `MINE_REALIGN_EPS` (0.01 rad) converges in 1–2 ticks headless, but in headed mode produced `dir` bouncing between two fixed values forever — position frozen, chasing a target the real frame rate could never resolve. `balancing:scan` (headless) showed nothing wrong at all; the bug was only visible while actually watching.

**If you're chasing a bug reported from watching (`balancing:watch`) that a headless `balancing:scan` doesn't flag:**

1. Don't assume it's a log artifact or unreproducible — reproduce it directly. Run `scripts/run-balancing-telemetry.mjs` with `CODEENSTEIN_TELEMETRY_HEADED=1` (this bypasses `watch-bot-sessions.mjs`'s interactive per-profile Enter-press wrapper entirely, so it's scriptable/backgroundable like any other run), plus `CODEENSTEIN_TELEMETRY_DEBUG_NAV=1` and tight `_PROFILE`/`_LEVEL_LIMIT`/`_ATTEMPT_CAP=1`/`_CONCURRENCY=1` scoping. Requires a real display (`DISPLAY` set, e.g. Xvfb).
2. To find a genuine freeze (not just ordinary tick-to-tick movement) in the resulting trace, scan for runs of N+ consecutive `[nav]` lines with byte-identical `pos=(x,y)`:

   ```sh
   awk '
   /^\[nav\]/ {
     match($0, /pos=\(([0-9.-]+),([0-9.-]+)\)/, p);
     key = p[1] "," p[2];
     if (key == prevKey) { run++; } else {
       if (run >= 15) print "run of " run " ticks frozen at " prevKey " ending line " NR-1;
       run = 1; prevKey = key;
     }
   }
   ' trace.log
   ```

3. If a fix candidate widens a convergence epsilon ("accept close enough" instead of chasing precision), check what the branch actually *does* once "satisfied" — if it has no fallback action (e.g. mine-targeting deliberately never adds movement, to avoid walking into blast range), the fix can convert "stuck but still trying" into "immediately idle until an unrelated timeout," which is often strictly worse and can have knock-on effects (an abandoned mine stays live and un-avoided by navigation). Prefer a stall-counter/behavioral trigger — matching this codebase's existing `stallStrafeKey`/`criticalStallTicks` idiom — over a static threshold widening.

## Large-scale campaigns (`npm run balancing:campaign`)

`scripts/run-balancing-campaign.mjs` builds up a much bigger sample than `balancing:telemetry`'s fixed 3-qualifying-run sweep — e.g. 50 qualifying full-campaign runs per combo (450 total) for real balance analysis, rather than the small samples used for regression-testing the bot itself. Differences from `balancing:telemetry`:

- **Resumable, not one-shot.** Before touching a combo, it sums `qualifyingRunCount` (a field `buildComboOutput` already returns) across every file already saved for that combo under `balancing_runs/` — killing and restarting the campaign picks up exactly where it left off, with no separate progress-tracking state to drift out of sync with what's actually on disk.
- **Every batch is its own file**, kept forever (not overwritten) — each spawned `run-balancing-telemetry.mjs` invocation is scoped to one combo, collects a small batch (`CODEENSTEIN_CAMPAIGN_BATCH_SIZE`, default 5) via `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET`, and writes directly to its own path via `CODEENSTEIN_TELEMETRY_OUTPUT_FILE` (`balancing_runs/<profile>-<difficulty>-<NNN>.json`) — no shared-file race between concurrently-running combos.
- **Runs combos as separate OS processes** (`child_process.spawn`, `CODEENSTEIN_CAMPAIGN_LANES` at a time, default 2), each wrapped in a wall-clock watchdog (`CODEENSTEIN_CAMPAIGN_WATCHDOG_MS`, SIGTERM then SIGKILL after a grace period). This is deliberate, not incidental: `run-balancing-telemetry.mjs` has no internal safety net for a genuinely wedged `page.evaluate()`/virtual-clock pump — every internal "stuck" resolution (tick-count give-up counters, `page.waitForFunction` timeouts) is bounded and resolves into a normal, non-throwing result, but a true hang would leave a `Promise.all` inside `runCombo` waiting forever with nothing to catch it. Only an external, OS-level kill can actually stop that.
- **Calibrate the watchdog before a real run on new hardware** — the default (90 minutes) was derived 2026-07-15 on a Ryzen 5800X from one real production-representative invocation (full 17-level campaign, `CONCURRENCY=8`, `QUALIFYING_TARGET=5`): 5m13s for 8 attempts to reach 5 qualifying (level-4+) runs, extrapolated to a ~50-minute worst case at `ATTEMPT_CAP=80` with headroom on top. Re-run a similar single-combo calibration invocation (no `LEVEL_LIMIT`) if running on meaningfully different hardware before trusting `CODEENSTEIN_CAMPAIGN_WATCHDOG_MS`'s default.
- **Known risk**: a SIGKILL (only reached if SIGTERM doesn't land within the grace period) can leave orphaned Chromium subprocesses behind, since it doesn't give Playwright's own shutdown handlers a chance to run. Kills should be rare (the watchdog is a safety net, not the normal exit path) but worth an occasional `ps aux | grep chromium` spot-check on a long unattended run.
- Tune `CODEENSTEIN_CAMPAIGN_LANES`/`_CONCURRENCY` to the machine — each lane's invocation gets its own `CODEENSTEIN_TELEMETRY_CONCURRENCY`-way internal browser-context concurrency (default 8, lower than `balancing:telemetry`'s own default of 12, since `LANES` of these run at once), so total concurrent browser contexts is roughly `LANES × CONCURRENCY_PER_LANE`.

## Matched-scale verification

Any change to navigation/combat/movement logic in `run-balancing-telemetry.mjs` needs more than "the scan came back clean" before it's trustworthy:

- **A/B against `git show HEAD:scripts/run-balancing-telemetry.mjs`** at the *same* `CODEENSTEIN_TELEMETRY_CONCURRENCY`/`_ATTEMPT_CAP`/`_LEVEL_LIMIT` that will ultimately be trusted. A small or low-concurrency sample has previously masked a real ~4x survival-rate regression (Casual/normal level-2 death rate looked fine at `CONCURRENCY=1`, but was 72% — vs. the true baseline's 0% — at `CONCURRENCY=6`/`ATTEMPT_CAP=20`).
- **`diagonalStrafeKey`** (the bot's diagonal-movement helper, plain-navigation branch only) is the sharpest cautionary example: an earlier change to its usage caused exactly that 72%-vs-0% regression, only caught via the matched-scale A/B above — not by `balancing:scan`. It's scoped to plain-nav only for this reason; don't re-add it to `hazard`/`criticalHealth`/`mineRetreat`/ranged-aim branches, and treat even refinements *within* its current safe usage as needing the same verification bar, not just a scan.

## Output shape

`balancing_telemetry.json` (repo root, gitignored) holds a meta block (profile definitions), then per-level and campaign-wide aggregates across 7 categories (map density/demographics, combat pacing, AI effectiveness/danger, damage/healing breakdown, weapon efficiency, economy/loot starvation, navigation/map flow), plus deterministic outlier `flags` and per-profile `crossDifficultyFlags`. Judgment-call metrics carry a `{mean, max, min, samples}` spread rather than a bare mean, so a consumer (human or LLM) can see the actual distribution, not just a single number that might hide a bimodal split.

Also, at the combo level (alongside `weaponFirstOwnedAtLevel`): `weaponFirstOwnedAtLevel` is a *min* across qualifying runs — it answers "how soon could this profile realistically get it", not "how often did any run get it at all". `weaponAcquisitionRate` (`{ [weaponIndex]: { count, rate } }`) answers the second question directly, for every unlockable weapon (gdb/ghidra/Friday Hotfix/Toolchain) uniformly — added 2026-07-15 specifically to verify Toolchain's new miss-chance acquisition path (see below) actually moves the needle, since the min-level metric alone can't distinguish "3% of runs get it, always around level 9" from "60% of runs get it, always around level 9".

### `economyLootStarvation` — real amounts, not occurrence counts (fixed 2026-07-15)

`lootRolled` used to record a flat `1` (an occurrence, not a quantity) for every drop whose `LootDrop.amount` was unset at roll time — which is most non-Elite drops, since the real amount is only resolved later, at collection (`applyLootDrop`). This made `lootRolled` unit-incompatible with `consumed` (a real-amount total): a report built on comparing the two (an `ammo_starvation_*` outlier flag) had to be removed rather than fixed as a result — see `balancing-progress.md` milestone 24. `RaycasterEngine.pushLootDrop` now records the real, difficulty-scaled amount a drop is worth (`defaultLootAmountFor` mirrors `applyLootDrop`'s own fallback exactly) for every kind except `"weapon"`, which stays an occurrence count on purpose — a weapon drop's real value (grant vs. an ammo top-up if already owned) depends on ownership state at *collection* time, which can change between roll and collection, so `1` is the only thing that can honestly be recorded for it regardless of when. `lootRolled` and `consumed.total` should now sit within roughly the same order of magnitude per resource, not off by 10-20x.

`economyLootStarvation` also gained `pctRegularKillLootMisses` (a `{mean, samples}` spread, per-level-visit): the fraction of regular (non-Elite) kills whose ammo/swap roll came up empty — see `REGULAR_KILL_NO_DROP_CHANCE` in `src/engine/loot.ts`. Not a "desperation" signal on its own (health is a separate, always-on grant now, independent of this roll — see `game-design.md`'s "Weapon and economy intent" for why) — a mechanic-verification stat, letting real telemetry confirm the ~20% design rate empirically instead of trusting the constant alone.

### `aiEffectivenessDanger.enemyAccuracy` now reflects a real difficulty axis (2026-07-15)

Before 2026-07-15, enemy ranged bolts had zero aim deviation at all — `enemyAccuracy` (hits/shots fired) was purely a function of the player dodging (movement, walls), never anything the difficulty setting touched. `DIFFICULTY_MULTIPLIERS.enemyAimSpreadDeg` (10°/4°/0° easy/normal/hard, `src/difficulty.ts`) now rotates a bolt's aim vector by a random angle up to that cap before firing (`spawnProjectile` in `projectiles.ts`) — `enemyAccuracy` should now show a real, monotonic difficulty curve instead of the flat ~70-77% band across all three tiers that the original balance report flagged as "difficulty makes enemies tougher, not smarter". Verified directly: a Gamer-profile spot-check went 74.9%→45.6% (easy), 73.8%→58.0% (normal), 77.3%→78.0% (hard, unchanged — 0° spread is the same as the old always-perfect aim).
