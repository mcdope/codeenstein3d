# Balancing Telemetry Bot

A dev-only tool for automated balance review: three scripted bot profiles (Casual/Gamer/Pro) play the bundled `demo-campaign/` across all three difficulties, and their aggregated combat/economy/navigation stats get written to `balancing_telemetry.json` (gitignored) for a human — or an LLM balance-review pass — to spot HP-curve/drop-rate/pacing problems without replaying the whole campaign nine times by hand. **Not CI-wired.** Requires a locally running dev server (`npm run dev`, default `http://localhost:5173`).

The bot itself is a shared `Bot` class (`scripts/lib/bot.mjs`) that both this script and `scripts/generate-default-highscore.mjs` drive — a virtual clock, `window.__codeensteinTestHooks` polling, real `KeyboardEvent`s dispatched at the canvas, BFS route planning done entirely in Node before any browser launches. See `bot.mjs`'s own doc comment for the low-level harness rationale, and [Shared bot library (`scripts/lib/`)](#shared-bot-library-scriptslib) below for how the pieces fit together.

## The three entry points

| Command | What it does |
|---|---|
| `npm run balancing:telemetry` | Full 9-combo run (Casual/Gamer/Pro × easy/normal/hard), 3 qualifying runs each, writes `balancing_telemetry.json`. Slow (up to 9 × unbounded attempts × up to 17 levels) — this is the "generate real data" entry point. |
| `npm run balancing:watch` | Opens one real, visible Chromium window per profile (Casual → Gamer → Pro by default), plays one full campaign attempt at watchable real-time speed, prints a summary, waits for Enter before the next profile. `scripts/watch-bot-sessions.mjs`; reuses the same profile definitions and per-attempt driving logic (`playRun`), not a separate bot. `npm run balancing:watch -- Gamer Pro` to pick a subset/order; `CODEENSTEIN_WATCH_DIFFICULTY=hard` to change difficulty. |
| `npm run balancing:scan` | The permanent automated bot-**behavior** regression check (distinct from balance-*data* review) — see [Anomaly scanning](#anomaly-scanning-npm-run-balancingscan) below. Run this before declaring any navigation/combat change to the bot script fixed. |
| `npm run balancing:campaign` | Large-scale, resumable data-collection orchestrator — see [Large-scale campaigns](#large-scale-campaigns-npm-run-balancingcampaign) below. Not the same as `balancing:telemetry`'s fixed 3-qualifying-run sweep; this repeatedly spawns it to build up a much bigger sample, keeping every batch as its own file. |

A run only "counts" for `balancing:telemetry`'s aggregate once it clears level 4 (proves it survived the unarmed early game) — a run that dies on level 1-3 is discarded entirely; a qualifying run keeps *all* its levels' data, 1–3 included. Both the qualifying level (`QUALIFY_LEVEL_INDEX`) and the qualifying-run target (`REQUIRED_QUALIFYING_RUNS`, default 3, overridable via `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET`) live in `run-balancing-telemetry.mjs`.

## Profiles and difficulty

`PROFILES` (`Casual`/`Gamer`/`Pro`) in `run-balancing-telemetry.mjs` differ by `fireAngleEps` (aim tolerance — Pro tightest at 0.03 rad, Casual loosest at 0.08), `fireCooldownMs` (minimum time between semi-auto ranged shots — Pro fastest at 120ms/~8.3 per sec, Casual slowest at 220ms/~4.5 per sec; see its own doc comment above `PROFILES` for why this exists — semi-auto weapons have no engine-side fire-rate cap, so an untuned bot fires as fast as its decision loop allows, far beyond any human trigger-pull rate), `weaponPriority`, `healthDetourThreshold`, and `rotSpeedMultiplier` (a bot-only turn-speed override, `engine.ts`'s `rotSpeedMultiplier`, approximating a realistic *mouse* turn speed per skill tier — real `requestPointerLock()`-based mouse-look was investigated and rejected: it rejects outright under Playwright automation, headed or headless). Difficulty (`easy`/`normal`/`hard`) is wired through `localStorage["codeenstein-difficulty"]`, same as a real player's setting.

## Shared bot library (`scripts/lib/`)

The bot-behavior logic (navigation, combat, hazard/mine handling, loot detours — ~1450 lines) lives in `scripts/lib/bot.mjs`'s `Bot` class, not duplicated per script. Both `run-balancing-telemetry.mjs` and `generate-default-highscore.mjs` construct one `Bot` per attempt (`new Bot(page, profile, opts)`), call `bot.startLevel(map)` per level, then drive it via `bot.tick()`/`bot.driveLegs()`/`bot.driveToward()`/etc.

- **Config is explicit constructor `opts`, not ambient module state.** `opts.realtime`/`opts.stepMs` (headed-vs-headless timing), `opts.recordStepMs` (only the highscore generator sets this — see its own module doc comment for why replay recording needs a finer step granularity than bot decision-making), `opts.logger` (a `{debugNav, wpDebug, driftDebug, trace}` bag of no-op-by-default callbacks, replacing scattered `process.env.CODEENSTEIN_WPDEBUG`-style checks), and `opts.tuning` (deep-merged over `DEFAULT_TUNING`, the ~40 movement/combat constants both scripts used to duplicate). `run-balancing-telemetry.mjs` still resolves its own module-level `HEADED`/`DEBUG_NAV`/etc. consts from `process.env` once at import (this is what preserves `watch-bot-sessions.mjs`'s "set `process.env.CODEENSTEIN_TELEMETRY_HEADED` before dynamically importing" trick) and forwards them into the `Bot` constructor per attempt.
- **`scripts/lib/qualifyLoop.mjs`'s `runQualifyLoop()`** is the generic "retry attempts in concurrent batches until N qualify (or a cap is hit)" loop both `run-balancing-telemetry.mjs`'s `runCombo` and `generate-default-highscore.mjs`'s per-profile driver are thin wrappers around — the qualifying predicate, attempt function, and concurrency are all caller-supplied.
- **`scripts/lib/virtualClock.mjs`'s `installVirtualClock()`** is the one virtual-clock installer both scripts import, instead of each keeping its own byte-for-byte-identical copy.
- **Free (non-`Bot`-state) helper functions** — `angleDelta`, `diagonalStrafeKey`, `isHazardAt`/`activeSpikeAt`, `pickThreat`, `hasLineOfSight`/`isWallTile`, `findDisarmableMine`/`findDangerousMine`, `pickRangedWeapon`, `detectAnomalies`/`detectHeldKeyNoMovement` — also live in `bot.mjs`, exported alongside the class, since they don't need any per-run state.
- `scripts/lib/pathfind.mjs` and `scripts/lib/routePlanner.mjs` are unaffected by any of this — they were already clean, reusable, stateless modules `bot.mjs` imports.

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
- **The queue/resumability/watchdog engine itself lives in `scripts/lib/laneOrchestrator.mjs`**, shared with `run-balancing-campaign-multiplayer.mjs` (see [SSH-host parallelism](#ssh-host-parallelism) below) — `run-balancing-campaign.mjs` itself only supplies the combo list, env vars, and how to read an existing output file's qualifying count; a `Runner` (local `child_process`, or a remote SSH host) is what actually executes an invocation.

## SSH-host parallelism

`balancing:telemetry`'s and `balancing:telemetry-multiplayer`'s own real-time-costly data collection can be spread across N SSH hosts — not by giving those one-shot scripts an SSH concept of their own (neither has a lane/queue to plug one into), but through the two campaign orchestrators (`balancing:campaign`, `balancing:campaign-multiplayer`), which already exist specifically to spawn many instances of the underlying telemetry script in the first place. Both orchestrators can spread their local lanes across N SSH hosts as well, on top of (not instead of) `CODEENSTEIN_CAMPAIGN_LANES`/`_MP_CAMPAIGN_LANES` local lanes — useful when one machine's own core count is the bottleneck, or (for the multiplayer campaign specifically) when running more than one *local* lane isn't possible at all (see below).

- **Host list**: a gitignored `ssh-hosts.env` at repo root, one `user@host` per line — copy `ssh-hosts.env.dist` to get started. Blank/`#`-prefixed lines are ignored; a missing or empty file just means "local lanes only," the common case.
- **Auth is entirely external** — whatever a plain `ssh user@host` would already use (a pre-unlocked key in your local `ssh-agent`, or a `~/.ssh/config` alias). Neither `ssh-hosts.env` nor `scripts/lib/sshRunner.mjs` ever touch credentials.
- **No manual pre-provisioning needed beyond SSH access + passwordless `sudo`.** Each configured host is bootstrapped once, upfront, before any combo work starts (not lazily per-invocation — the local commit under test can't change mid-campaign): installs `git` and a modern-enough Node/npm via `apt`/NodeSource if either is missing or too old (**Debian/Ubuntu-only by design** — a different distro fails this step and just gets excluded), clone-or-fetch into a fixed `/tmp/codeenstein3d-ssh-lane` on the remote host, force-checkout the exact local `HEAD` commit, `npm ci`, `npx playwright install --with-deps chromium`. A host that's unreachable or fails any bootstrap step is logged as a warning and simply excluded from that run — one bad host must never wedge the whole orchestrator (the same lesson a real stuck combo already taught: see the multiplayer campaign's own `ATTEMPT_CAP` default below).
- **ARM hosts work fine** — nothing in `sshRunner.mjs` is architecture-specific, and Playwright's Chromium build (the only engine this whole family ever launches) has genuine Linux ARM64 support. Real per-attempt wall-clock cost can still vary a lot by hardware, same "calibrate before trusting" discipline as `CODEENSTEIN_CAMPAIGN_WATCHDOG_MS`'s own calibration note above.
- **A remote lane's own result file is pulled back via `scp`** into the exact local path the orchestrator's resumability scan expects, so local and remote lanes are indistinguishable from the queue's point of view.
- **Known gap, not yet solved**: a local watchdog timeout kills the *local* `ssh` client, which best-effort propagates (via a forced pseudo-terminal, `-tt`) to the remote command, but a genuinely dropped connection can still leave an orphaned remote process running — a real fix needs a remote supervisor, out of scope for this first cut.
- **Multiplayer-specific limitation**: `run-balancing-campaign-multiplayer.mjs` defaults `CODEENSTEIN_MP_CAMPAIGN_LANES` to **1**, not 2 — every local invocation starts its own isolated signaling+dev server pair on the same fixed ports (`multiplayerTestServers.mjs`, 8788/5174), so two concurrent *local* lanes would collide today. Real multiplayer parallelism is expected to come from SSH lanes (each its own remote machine, no port conflict) rather than raising the local lane count.

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

## Multiplayer balancing telemetry (step 11)

A separate tool, `scripts/run-balancing-telemetry-multiplayer.mjs`, mirrors this whole toolchain for real multiplayer sessions (2-4 simultaneous players) — step 11 of the multiplayer implementation plan. Full design rationale lives in [`doc/dev/multiplayer-balancing-telemetry-spec.md`](multiplayer-balancing-telemetry-spec.md); this section is the user-facing "how to run it" reference. **Not CI-wired, not fast** — run manually, same as `balancing:telemetry`.

The two are more different than they look at first glance, for one structural reason: **multiplayer has no virtual clock.** `scripts/lib/virtualClock.mjs` cannot fast-forward a real Web-Worker-timer-paced multiplayer simulation (`scripts/lib/multiplayerBot.mjs`'s own doc comment states this outright) — every attempt costs genuine wall-clock time. A single combat-heavy level clear for a 2-bot pair has been directly measured at ~4 real minutes. Every default in this tool (sequential attempts, small qualifying targets, one bundled level per run instead of a full campaign) is sized around that cost, not copied from single-player's cheap virtual-time concurrency.

### Entry points

| Command | What it does |
|---|---|
| `npm run balancing:telemetry-multiplayer` | Full combo sweep across every profile/difficulty/player-count (plus curated mixed-skill combos, see below), 2 qualifying runs per combo by default, writes `multiplayer_balancing_telemetry.json`. Real-time cost means this can run for a long while — scope it with the env vars below before trusting the unbounded default to finish quickly. One monolithic process: no incremental persistence, so a kill loses everything collected so far — see `balancing:campaign-multiplayer` below if that matters. |
| `npm run balancing:scan-multiplayer` | Fast/cheap preset: `Casual`/`normal`/2p only, attempt cap 3, qualifying target 1, `disconnectIsolation` scenario disabled. The multiplayer pre-merge regression gate — mirrors single-player's `balancing:scan` role. |
| `npm run balancing:campaign-multiplayer` | Resumable orchestrator (`scripts/run-balancing-campaign-multiplayer.mjs`) — spawns one OS process per combo (via the new `CODEENSTEIN_MP_TELEMETRY_COMBO_PROFILES` pin, see below), each writing its own file under `balancing_runs_multiplayer/`, shares `scripts/lib/laneOrchestrator.mjs` with `balancing:campaign`. See [Large-scale campaigns](#large-scale-campaigns-npm-run-balancingcampaign)/[SSH-host parallelism](#ssh-host-parallelism) above — same design, `CODEENSTEIN_MP_CAMPAIGN_*` env vars instead of `CODEENSTEIN_CAMPAIGN_*`, smaller defaults throughout (`_TARGET` 10, `_BATCH_SIZE` 2, `_ATTEMPT_CAP` 30, `_LANES` 1) given the much higher real-time cost per attempt. |

Both always start their **own isolated signaling + dev server pair** (`scripts/lib/multiplayerTestServers.mjs`, ports 8788/5174 — deliberately never 8787/5173, a developer's own manual session's default ports) rather than share whatever a developer's own dev session happens to be pointed at. The signaling server's rate limits are per-IP, not per-session (`multiplayer-balancing-telemetry-spec.md` §7) — running this tool's own traffic against a shared server risks tripping a budget sized for one human's manual testing. There's no `CODEENSTEIN_DEV_URL`-equivalent override for this reason: the isolated pair is always used.

### Profiles, difficulty, and the combo matrix

Reuses `run-balancing-telemetry.mjs`'s own `PROFILES` (Casual/Gamer/Pro) and `DIFFICULTIES` (easy/normal/hard) unchanged. Beyond that, the combo matrix is genuinely different from single-player's:

- **One bundled demo-campaign level per run, not the full campaign.** Multiplayer level transition is already covered on its own by `verify-multiplayer-transition.mjs` — re-driving that whole sequence for every combo would multiply this tool's already-real-time-only cost for no new signal. A run "qualifies" once every bot reaches the exit tile alive (`teamOutcome === "allReachedExit"`).
- **Player count (2-4) is a real combo dimension**, not fixed — `CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS` (comma-separated, default `2,3,4`).
- **Uniform combos** (one skill tier for the whole team) run alongside **curated mixed-skill combos** (`curateMixedProfiles()`) when no `PROFILE` filter narrows things to one tier: 2p gets only *adjacent*-tier pairs (Casual+Gamer, Gamer+Pro — not the skip-a-tier Casual+Pro, less representative of a real pairing while costing the same real time as either neighbor); 3p/4p get one weakest+strongest+filler combo each (filler = the middle tier, repeated for 4p). Deliberately not a blind cartesian product across up to 4 slots — that multiplies cost for combos with little new signal over their neighbors. A `PROFILE` filter disables mixed combos entirely (a filter means "just this one tier").

### Env var reference

All `CODEENSTEIN_MP_TELEMETRY_*` — read once at module load, same "same process invocation" caveat as the single-player table above.

| Var | Effect |
|---|---|
| `CODEENSTEIN_MP_TELEMETRY_PROFILE` | Restrict to one profile tier — also disables curated mixed-skill combos (see above). |
| `CODEENSTEIN_MP_TELEMETRY_DIFFICULTY` | Restrict to one difficulty. |
| `CODEENSTEIN_MP_TELEMETRY_COMBO_PROFILES` | Pins one *exact* per-slot combo (comma-separated tier names, e.g. `Casual,Gamer` for a specific 2p mixed pair) — bypasses the uniform+curated-mixed matrix entirely, running just that one combo. Player count is derived from this list's own length (`_PLAYER_COUNTS` is ignored); requires `_DIFFICULTY` to also be set. Used by `balancing:campaign-multiplayer` to scope one spawned invocation to one combo — a bare `_PROFILE` filter can express a uniform combo but not a specific mixed one. |
| `CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS` | Comma-separated list of player counts to test, each 2-4 (default `2,3,4`). |
| `CODEENSTEIN_MP_TELEMETRY_QUALIFYING_TARGET` | Qualifying runs needed per combo before its retry loop stops (default **2** — deliberately much smaller than single-player's default 3, given the real-time cost per attempt). |
| `CODEENSTEIN_MP_TELEMETRY_ATTEMPT_CAP` | Cap attempts per combo (default unbounded). Use for any scoped/smoke run. |
| `CODEENSTEIN_MP_TELEMETRY_CONCURRENCY` | Attempts run concurrently within one combo (default **1**, sequential) — several concurrent real multiplayer sessions against one dedicated signaling+dev server pair is a real resource-contention risk this tool hasn't been measured against; raise deliberately. |
| `CODEENSTEIN_MP_TELEMETRY_VERBOSE` | Per-attempt detail logging. |
| `CODEENSTEIN_MP_TELEMETRY_ANOMALY_SCAN` | Enables the shared `Bot` stall/`healthDrainFrozen`/rotation detectors (see [Anomaly scanning](#anomaly-scanning-npm-run-balancingscan) above — these work for `MultiplayerBot` unchanged, they just need the trace collector turned on). |
| `CODEENSTEIN_MP_TELEMETRY_NAV_DIAG` | Extra per-decision trace bookkeeping (implies `ANOMALY_SCAN`). |
| `CODEENSTEIN_MP_TELEMETRY_HEADED` | Real, visible browsers instead of headless. |
| `CODEENSTEIN_MP_TELEMETRY_DISCONNECT_SCENARIO` | Set to `0` to skip the `disconnectIsolation` scenario (default on — it's what `balancing:scan-multiplayer`'s own preset disables, since the real detection wait would dominate that fast preset's own runtime budget). |
| `CODEENSTEIN_MP_TELEMETRY_OUTPUT_FILE` | Override the output path (default `multiplayer_balancing_telemetry.json` at repo root, gitignored). |

### Output shape

`multiplayer_balancing_telemetry.json` (repo root, gitignored) is top-level-keyed by combo (`meta` + `combos`), each combo holding:

- **`perPlayerTelemetry`** — the real per-player 7-category breakdown (map density, combat pacing, AI danger, damage/healing, weapon efficiency, economy, navigation), keyed by roster id (`host`, `guest-1`, ...). Reuses `run-balancing-telemetry.mjs`'s own `aggregateLevelRuntime()` unchanged: `RaycasterEngine.getMultiplayerTelemetrySnapshot(id)`'s shape matches single-player's own `getTelemetrySnapshot()` field-for-field (both built from the same `buildTelemetrySnapshotFor`). One category single-player has that multiplayer doesn't: `navigationMapFlow.routeEfficiencyScore` is omitted — each bot spawns at a different tile, so there's no single team-wide shortest-path figure to compare against, and shipping the aggregator's own "not computed" placeholder zeros would read as a real (and misleadingly bad) result.
- **`gameplayHealth`** — coarser team-level signals: outcome tally (`allReachedExit`/`teamWiped`/`partial`/`crashed`), a team-wide enemies-killed estimate (a before/after alive-count delta — not per-player-attributable the way `perPlayerTelemetry`'s own kill counts are, since assist vs. finishing-blow can't be told apart from a bare count), and each player's minimum observed health fraction.
- **`perf`** — fps per player, mean tick-skew per peer pair, and `tickSkewGrowthByPair`: a first-third-vs-last-third mean comparison per qualifying run, flagging a real desync-*widening* trend (not just a raw mean/max, which can't tell "briefly spiked then settled" apart from "steadily growing" — a "growing" call requires both a ≥5ms absolute delta and a ≥1.5x ratio, so ordinary real-clock sampling noise can't false-positive).
- **`netcodeHealth`** — real RTT per link (`RTCPeerConnection.getStats()`'s active-candidate-pair `currentRoundTripTime` — star topology, host↔each guest, sampled both directions since each side's own view is a genuinely different measurement point), missed-tick fraction per player (`TickInputBundle.heldInputFallback` tally), and reconciliation-correction count/magnitude per player (guest-only — the host is authoritative and never applies a snapshot to itself, so its own entries are always `{count: 0, avgMagnitudeTiles: 0}`, not missing data; a correction only counts once its position magnitude clears a small noise floor, so ordinary cross-peer float drift doesn't register as a false "correction").

Separately, at the report's top level (not part of the combo matrix — the scenario doesn't vary by bot skill or difficulty, so it runs once per invocation, not once per combo): **`disconnectIsolation`** — a real, scored version of `verify-multiplayer-disconnect.mjs`'s guest-disconnect scenario. A real `RTCPeerConnection` teardown (closing the guest's `BrowserContext`), then measuring how long the host takes to detect it and whether the host keeps ticking/surviving through the disconnect — `{guestFinalStatus, detectedWithinMs, hostKeptTicking, hostSurvived}`.

### Two real findings from this tool's own smoke testing — both root-caused and fixed

**A mine-corridor stall — root-caused and fixed (applies to single-player too).** A uniform-Casual 2-player pair reproducibly hit a `stall`/`healthDrainFrozen` anomaly sequence around a mined corridor on `demo-campaign/main.c` (three real mines clustered within a few tiles of each other, ~pos `(37.5, 49.3)`). Root cause, confirmed via a live position/health/mine-state trace: `findDangerousMine`'s own "retreat now" trigger only fires once a mine is *already* within its blast radius — but a mine's fuse (`MINE_FUSE_SECONDS`, 0.9s) ticks in real time regardless of how often the bot re-evaluates, and `MultiplayerBot`'s own real decision window (`DEFAULT_STEP_MS`, 400ms) is long enough that a mine already armed by the *other* mine in the cluster (or by this same bot's own earlier approach) could finish its fuse and detonate entirely within one held decision — the bot correctly saw itself as "safe" (beyond blast radius, aiming at a *different*, farther mine as a disarm target) right up until the explosion it had no chance to react to. Fixed in shared `bot.mjs`: `findDangerousMine` now takes a `reactionBufferTiles` parameter — a real, decision-window-scaled reaction margin (`ENGINE_MOVE_SPEED × ENGINE_SPRINT_MULTIPLIER × stepMs`) rather than a fixed tile count, mirroring the existing `MELEE_CLOSE_MIN_DISTANCE` fix's own pattern. At single-player's much shorter decision windows (`WATCH_STEP_MS` 130ms, `VIRTUAL_STEP_MS` 50ms) this rounds to well under a tile — a harmless, mostly-no-op widening; multiplayer's much longer window gets a buffer that actually matters (~2.5 tiles). Verified live: the same `stall`+`healthDrainFrozen` compound pattern near the mine cluster is gone, and `Casual/normal/2p` — previously stuck there — qualified 2/2 on the very next full run. Some mine damage in that corridor is still possible (mines are hazards by design) — what's fixed is the bot getting physically stuck there taking damage it had no chance to react to, not mines being risky at all.

**A far more severe stall — root-caused and fixed.** The same runs also hit one much longer stall — ~596 ticks (vs. ~40-45 for the mine-corridor one above, and suspiciously close to `MAX_TICKS_PER_WAYPOINT`'s own value of 600), at a *different* position (~pos `(15.8, 16.8)`), with no mine or threat nearby. Root cause, confirmed via live repro: `checkExit()` (`engine.ts`) starts the level-transition countdown the moment *any single* alive player touches the exit — a real, intended co-op mechanic ("exit touch is a shared simulation event"), not a bug — and once it elapses, the *whole* roster is carried to the next level's spawn, including a teammate who's still mid-route. That teammate's own `Bot` instance had no way to notice: it kept walking its pre-planned waypoint list against a live position that had moved to an entirely different level, using its own now-stale map for every navigation decision (which is exactly why `(15.8, 16.8)` read as solid wall against `main.c`'s own grid — it was never on `main.c` at all). Fixed in `bot.mjs`'s shared `driveLegs`/`driveTowardWithReplan`/`maybeDetourForLoot`: a mid-route `"teleported"` result (already detected, previously silently ignored) now stops the walk immediately instead of continuing. `driveOneBot` maps this into a new `"levelAdvanced"` outcome — exactly as real a team success as personally reaching the exit tile, and now counted as such in `teamOutcome`. Verified for real: the exact combo that had never once qualified across every earlier test run in this investigation (`Casual/normal/2p`) qualified on its very first attempt after the fix.
