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

`PROFILES` (`Casual`/`Gamer`/`Pro`) lives in **`scripts/lib/profiles.mjs`** and is re-exported from `run-balancing-telemetry.mjs`, so every existing importer is unchanged. It was moved there so unit tests can import the real profiles without pulling in Playwright — `combatPolicy.test.mjs` previously hand-copied Gamer's values into a local fixture, which silently drifted out of sync and no test could detect.

**Read the ladder as an ordering, not a list of numbers.** `profiles.test.mjs` pins what several consumers silently depend on: the exact key order (`curateMixedProfiles` reads `tierNames[0]` as the weakest tier), strict monotonicity per knob, and a complete ranged fallback chain per tier — the historical Pro-missing-shotgun bug made Pro *slower to qualify than Casual*, which is what a broken ladder looks like from the outside.

| knob | Casual → Pro | what it controls |
|---|---|---|
| `fireAngleEps` | 0.08 → 0.03 rad | aim tolerance before the bot will pull the trigger |
| `fireCooldownMs` | 220 → 120 ms | minimum gap between *semi-auto* shots. Dual-role and worth knowing: it also feeds `secPerShot` in `scoreRangedWeapon`, so a slow trigger also makes the bot *judge* semi-autos as worse. Don't draw per-tier weapon-balance conclusions without accounting for that |
| `rotSpeedMultiplier` | 2 → 5 | bot-only turn-speed override (`engine.ts`), approximating mouse turn speed per tier — real pointer-lock mouse-look rejects outright under Playwright |
| `healthDetourThreshold` | 0.75 → 0.25 | how early the bot breaks off to find health |
| `ammoThrift` | 1.6 → 0.2 | willingness to burn a finite reserve to shorten a fight |
| `selfHarmAversion` | 2.2 → 0.5 | caution with self-splash weapons; only reachable in the ghidra branch |
| `weaponPriority` | — | **membership is a hard filter, order is only a tiebreak.** The scoring loop iterates this list, so an absent weapon is never considered at all — which is why Casual omitting ghidra is a real behavioural tier rather than a preference |
| `engageRadius` | 9.5, identical | deliberately not a tier: "low aggression" must never mean skipping a fight |

A profile may also carry a **`tuning` object**, deep-merged over `DEFAULT_TUNING` in the `Bot` constructor and *under* any explicit `opts.tuning` — so `CODEENSTEIN_TELEMETRY_TUNING` still wins and single-variable A/Bs keep working. That is how a tier can own what would otherwise be a global constant, i.e. express *competence* rather than only *pace*.

Difficulty (`easy`/`normal`/`hard`) is wired through `localStorage["codeenstein-difficulty"]`, same as a real player's setting. Keep the two axes distinct: **difficulty changes the world** (enemy HP, damage, ammo drop rate, enemy aim spread — `src/difficulty.ts`), **a profile changes the player**.

### Grading the ladder — `report-profile-separation.mjs`

```sh
node scripts/report-profile-separation.mjs <dir-or-file> [difficulty]
```

Takes one telemetry JSON containing all three profiles, or a directory of per-profile captures, and **exits non-zero when the tiers aren't cleanly ordered**. `abReport.mjs` compares two *sides* of one change; this compares the three *profiles* within one capture, which is the question that decides whether per-tier balance conclusions mean anything.

It bounds the **smallest adjacent step**, not the ladder's ends, and that distinction is the point: Casual is cleanly separated from both other tiers, so an ends-based ratio looks healthy while **Gamer↔Pro** — the step that actually flipped run-to-run across four n=5 scans — is unreadable. Bars are calibrated against a measured n=40 baseline so the axes that already work cannot be quietly traded away.

Measured 2026-08-01, before any retune: `ttkNormal` and `levelTimeSec` were correctly ordered, but **both damage-avoidance axes were inverted** (`enemyAccuracy` 0.499/0.556/0.531 and ranged damage per second of exposure 0.354/0.430/0.439 — Pro the *most* hittable). The tiers differed in pace, not competence.

### `PROFILES_HASH` — why `defaultHighscore.ts` must be regenerated after a retune

`src/engine/defaultHighscore.ts` is generated by playing the campaign *with these profiles*, so any retune leaves it describing a bot that no longer exists — and nothing used to detect that. A segment's `astHash` covers the parsed source and `balanceHash` covers the enemy roster; neither knows anything about bot tuning, so every replay stays valid while the shipped board silently misrepresents the bot.

The generator now bakes `profilesHash()` into the file as `PROFILES_HASH`, and `profiles.test.mjs` recomputes and compares — so this is a failing `vitest run` rather than an invisible drift. Field order inside a profile is ignored (it changes no behaviour); profile *order* is not (several consumers read it positionally).

**Regenerate the board last.** A retune is only one of several things that invalidates it — anything in `SIMULATION_BALANCE` does too, and that record now includes `ACID_DECAY_SECONDS`. The 2026-08-02 layout rework learned this the expensive way: the board was regenerated mid-branch, a gameplay constant then joined `SIMULATION_BALANCE`, and the whole two-hour run had to be repeated. Land every simulation change first, then generate once.

**The board is a poor instrument for judging a code change, and always has been.** Each entry is a *maximum over qualifying runs*, so its level count swings on luck: Gamer has come out 14/11/14/11/11/17 levels across six regenerations with no cause in the code. Read `balancing:scan`'s anomaly A/B for that question instead — it compares two builds over many attempts, which is what the 3-combo protocol above exists to make honest.

## Shared bot library (`scripts/lib/`)

The bot-behavior logic (navigation, combat, hazard/mine handling, loot detours — ~1450 lines) lives in `scripts/lib/bot.mjs`'s `Bot` class, not duplicated per script. Both `run-balancing-telemetry.mjs` and `generate-default-highscore.mjs` construct one `Bot` per attempt (`new Bot(page, profile, opts)`), call `bot.startLevel(map)` per level, then drive it via `bot.tick()`/`bot.driveLegs()`/`bot.driveToward()`/etc.

- **Config is explicit constructor `opts`, not ambient module state.** `opts.realtime`/`opts.stepMs` (headed-vs-headless timing), `opts.recordStepMs` (only the highscore generator sets this — see its own module doc comment for why replay recording needs a finer step granularity than bot decision-making), `opts.logger` (a `{debugNav, wpDebug, driftDebug, trace}` bag of no-op-by-default callbacks, replacing scattered `process.env.CODEENSTEIN_WPDEBUG`-style checks), and `opts.tuning` (deep-merged over `DEFAULT_TUNING`, the ~40 movement/combat constants both scripts used to duplicate). `run-balancing-telemetry.mjs` still resolves its own module-level `HEADED`/`DEBUG_NAV`/etc. consts from `process.env` once at import (this is what preserves `watch-bot-sessions.mjs`'s "set `process.env.CODEENSTEIN_TELEMETRY_HEADED` before dynamically importing" trick) and forwards them into the `Bot` constructor per attempt.
- **`scripts/lib/qualifyLoop.mjs`'s `runQualifyLoop()`** is the generic "retry attempts in concurrent batches until N qualify (or a cap is hit)" loop both `run-balancing-telemetry.mjs`'s `runCombo` and `generate-default-highscore.mjs`'s per-profile driver are thin wrappers around — the qualifying predicate, attempt function, and concurrency are all caller-supplied.
- **`scripts/lib/virtualClock.mjs`'s `installVirtualClock()`** is the one virtual-clock installer both scripts import, instead of each keeping its own byte-for-byte-identical copy.
- **`scripts/lib/combatPolicy.mjs` holds the decision core.** `decide(world, memory, config)` returns an *intent* — which keys to hold and for how long, whether to fire, which weapon to switch to — and `bot.mjs` is the I/O half that dispatches it. Everything it owns (`DEFAULT_TUNING`, `angleDelta`, `pickThreat`, `pickRangedWeapon`, `findDisarmableMine`/`findDangerousMine`, the burst helpers, the weapon indices) is re-exported from `bot.mjs`, so no consumer had to change an import; new code should import from `combatPolicy.mjs` directly. `detectAnomalies`/`detectHeldKeyNoMovement` stay in `bot.mjs` — they analyse recorded traces rather than making decisions.
  - Two reasons for the split. It makes the decision logic **testable** (`combatPolicy.test.mjs`, 100+ assertions — before this, nothing in `scripts/lib/` had any). And it is shaped so it can later be lifted into `src/engine/combatPolicy.ts` as the basis of a real in-game deathmatch opponent: `src/` cannot import from `scripts/`, so the move has to be a copy, and a copy is only mechanical if the file never acquires a dependency `src/engine/` couldn't satisfy. The module doc comment lists the rules that keep that true (no page, no async, no Node builtins, all tuning injected, no `Math.random`/`Date.now`, total sorts).
  - Injecting tuning also fixed a latent bug: `pickThreat`, `pickRangedWeapon`, `rocketAimUnsafe`, `findDisarmableMine` and `findDangerousMine` used to read `DEFAULT_TUNING` directly, so a `Bot`'s own `opts.tuning` override silently never reached them.
- **The bot has full WASD, and all eight directions are full speed.** `moveForward` translates along `(dirX, dirY)` and `strafe` along `(-dirY, dirX)` (`player.ts`), both scaled by the same `step`; `diagonalScale` (1/√2) is applied per axis when both are held, so two perpendicular components have magnitude *exactly* `step`. Reversing is the same speed as advancing (`forwardSign` is signed) and sprint applies throughout. **So turning is never required in order to move somewhere** — worst-case direction error picking the nearest octant is 22.5°, i.e. 92% of the step lands where wanted, against 0% while standing still to turn. This was not written down anywhere and the bot went a long time without using it: it never emitted `KeyS` at all, and stood still at every route corner (23.5% of all decisions were turn-only). `movementKeysFor`/`movementVectorFor` in `combatPolicy.mjs` encode it. Note that any safety check must then scan along the **movement** vector, not the facing one.
- **Evasion: the bot does not stand still to shoot.** The ranged-fire branch used to hold no keys at all for a whole decision, which made `aiEffectivenessDanger.enemyAccuracy` a measure of how easy it is to hit a stationary target rather than of how dangerous enemies are. It now sidesteps while firing, and when `getProjectiles` reports a bolt actually inbound it steps off that bolt's flight line specifically and *sprints* while doing so. Measured marginal effect of the directed dodge over blind sidestepping: `dmg.enemyRangedPerSec` -25.4/-18.5/-7.9%, `enemyAccuracy` -0.115/-0.095/-0.085, qualifyRate +0/+55/+25pp.
  - Three constraints, each load-bearing. **Lateral only, never alongside `KeyW`** — `engine.ts`'s `diagonalScale` cuts the forward component 29% when both axes are active, which is the mechanism behind the recorded 0%→72% regression. **Sprint only while genuinely dodging**, never for the blind sidestep, or the dance becomes drift. **Acid, spikes and walls all block**, with the other side tried first — a strafe is optional movement, so unlike a committed route leg it is never worth damage.
  - **Only the fire branch strafes, and that is deliberate.** Extending it to the re-aim branch was measured and reverted: it cost Gamer 30pp of qualify rate and doubled its stuck count for no accuracy gain, because that branch exists to converge on a firing angle and lateral movement perturbs the very quantity it is nulling out. Roughly 43% of combat decisions reach the fire branch; that ceiling is the price of not fighting the aim loop.
- **Per-key hold durations and `dispatchSegment`.** An intent's `holds` is a `Map` of key → ms, and `applyAction` turns it into the sequence of dispatch phases that realises it: a key whose hold ends early simply stops appearing in later phases, and the held-key diff releases it for free. Today every branch gives all its keys the same duration, so `segmentsFor` always yields exactly one phase and dispatch is byte-identical to the pre-split single-`turnBurst` call — verified by a differential harness over 21,600 dispatches (3 profiles × 3 step sizes × 400 seeds × 6 consecutive decisions), comparing keys, fire/melee/weapon, duration, mutated memory, trace, and the semi-auto fire clock. Letting keys carry *different* durations is what will fix the bot standing still while it shoots.
  - `minPhaseMs` is a floor, and it is the reason multiplayer can't be hurt by this mechanism: a phase shorter than the lockstep input delay never lands before the next is issued, so `MultiplayerBot` sets it to `MIN_DECISION_MS` and any decision that would split below it collapses back to a single phase — exactly the behaviour it already had.
  - `dispatchSegment` (not `applyAction`) is now the override point for a non-Playwright control surface. `MultiplayerBot` used to reimplement all of `applyAction`; the timing bugs its doc comment catalogues all trace to those two copies drifting apart.
- `scripts/lib/pathfind.mjs` and `scripts/lib/routePlanner.mjs` are unaffected by any of this — they were already clean, reusable, stateless modules `bot.mjs` imports.
- **⚠️ The bot keeps three hand-maintained copies of `isWall()`, and adding a `Tile` value silently breaks all three.** `player.ts`'s `isWall()` is the engine's single source of truth for solidity, but `scripts/lib/` is plain `.mjs` that cannot import it, so the tile sets are duplicated as literals:

  | Module | Constant | Contents |
  |---|---|---|
  | `pathfind.mjs` | `BLOCKED_TILES` | `{1, 3, 6, 7, 8}` |
  | `routePlanner.mjs` | `HARD_BLOCK_TILES` | `{1, 3, 6, 7, BRANCH_DOOR_TILE, TELEPORTER_TILE}` |
  | `combatPolicy.mjs` | `STRAFE_BLOCKED_TILES` | `{1, 3, 6, 7, 8}` |

  Note they are **not identical** — `routePlanner`'s also blocks teleporters, deliberately — so this cannot be collapsed to one constant without thought. The failure mode is what makes it dangerous: a `Set` lookup for an unknown tile value returns `false`, so a newly added solid tile is treated as **ordinary walkable floor** by every bot script. No error, no crash — the bot simply plans routes through it and wedges against a wall it believes is open. Nothing catches this: `scripts/**` is excluded from the coverage denominator, the files are not type-checked, and `balancing:scan` only reports the *symptom* (a stall) with no hint at the cause. This shipped once already, on `BRANCH_DOOR_TILE = 8`.

  **When adding a `Tile` value to `src/map/types.ts`, grep `scripts/lib/` for the neighbouring tile numbers and decide each set explicitly.** The engine-side touchpoints (`isWall`, the renderer, the automap/minimap colouring) are at least type-adjacent; these three are not.
- **`scripts/lib/abReport.mjs`** holds the pure baseline-vs-candidate comparison helpers behind `scripts/report-balancing-ab.mjs` — see [Matched-scale verification](#matched-scale-verification). It has a colocated `abReport.test.mjs`: `scripts/**` is excluded from the `src/` coverage *denominator* but is still executed by `vitest run`, so a test placed here does run in CI, exactly like `scripts/multiplayer-server.test.mjs`. That is the only automated coverage anything in `scripts/lib/` has, and it's worth extending as more of this library becomes pure functions.

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
| `CODEENSTEIN_TELEMETRY_TRACE_DUMP` | Prints the raw per-decision rows of each level's *longest* oscillation run — position, bearing error and distance to the nav target, keys held, burst, threat/mine distance, branch. Implies the trace. **Run with `CONCURRENCY=1`**: concurrent attempts interleave their rows into a misleadingly coherent-looking mess. Added because aggregates over this detector's own findings produced two wrong diagnoses in a row; reading one run end to end settled it in minutes. |
| `CODEENSTEIN_TELEMETRY_HEADED` | Real, visible browser + real wall-clock timing instead of the virtual clock. See [Headed vs. headless](#headed-vs-headless-read-this-before-touching-turnburstms-math). |
| `CODEENSTEIN_CONSOLE_FORWARD` | Forwards the browser's own `console` output to Node (`[console] ...` lines) — the engine already logs key pickups/door unlocks; often more reliable ground truth than bot-side telemetry when a freeze's cause is ambiguous. |
| `CODEENSTEIN_WPDEBUG` | Per-waypoint drive-loop trace (`[wpdebug] leg-walk wp=... -> result=...`). |
| `CODEENSTEIN_DRIFTDEBUG` | Traces `driveTowardWithReplan`'s off-route drift/re-plan decisions. |
| `CODEENSTEIN_DEV_URL` | Override the dev server URL (default `http://localhost:5173`). |
| `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` | Override `REQUIRED_QUALIFYING_RUNS` (default 3) — how many qualifying runs a combo needs before its retry loop stops. Used by `balancing:campaign` to set a small per-invocation batch size. **Set it to `999` for any A/B**, so the loop runs to `ATTEMPT_CAP` instead of exiting the moment enough runs qualify — that early exit, not concurrency, is what controls the failure-sample denominator. See [Matched-scale verification](#matched-scale-verification). |
| `CODEENSTEIN_TELEMETRY_OUTPUT_FILE` | Override the output path (default `balancing_telemetry.json` at repo root). Used by `balancing:campaign` so concurrent invocations each write to their own file instead of racing to overwrite the same one. |

### `generate-default-highscore.mjs`

Not a telemetry tool, but it drives the same `Bot` against the same dev server and is the other job that can run unattended for a long time — so its three knobs belong next to the ones above rather than nowhere.

| Var | Effect |
|---|---|
| `CODEENSTEIN_HIGHSCORE_QUALIFYING_RUNS` | Qualifying runs collected per profile before the highest-scoring one is baked in (default 3). |
| `CODEENSTEIN_HIGHSCORE_ATTEMPT_CAP` | Cap attempts per profile (default unbounded) — the only way to bound an otherwise open-ended run. |
| `CODEENSTEIN_HIGHSCORE_CONCURRENCY` | Attempts run concurrently per profile (default 4). |

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
- **Cost is bounded per combo, not just per invocation** (added 2026-07-30). The retry loop keeps asking for another invocation until the combo reaches its qualifying target, so a combo the bot simply *cannot* clear would respawn invocations forever — the watchdog bounds one invocation, never the loop around it. This bit the 2026-07-24 multiplayer campaign for real: the Hard cells never converged (Gamer/hard/2p banked 1 qualifying run across 6 invocations) and the run had to be rescued by hand-lowering the target mid-flight. `CODEENSTEIN_CAMPAIGN_MAX_INVOCATIONS` (default 6) / `CODEENSTEIN_MP_CAMPAIGN_MAX_INVOCATIONS` (default 3) cap it: at the cap the combo gives up loudly, the lane moves on, and the partial data stays intact and resumable — the combo just reports short of target. Set either to `0` for the old unbounded behaviour. Both orchestrators print the active bound in their startup banner, so a running campaign states its own worst case rather than leaving it to be inferred.
  - Corollary for **clear-rate** questions (as opposed to per-combo aggregates): a qualifying target is the wrong knob, because it stops early on easy combos and never terminates on impossible ones. For a fixed denominator, invoke the underlying telemetry script directly per combo with a high qualifying target and `ATTEMPT_CAP` set to the sample size you want — the same trick single-player uses with `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET=999`.
- **Known risk**: a SIGKILL (only reached if SIGTERM doesn't land within the grace period) can leave orphaned Chromium subprocesses behind, since it doesn't give Playwright's own shutdown handlers a chance to run. Kills should be rare (the watchdog is a safety net, not the normal exit path) but worth an occasional `ps aux | grep chromium` spot-check on a long unattended run.
- Tune `CODEENSTEIN_CAMPAIGN_LANES`/`_CONCURRENCY` to the machine — each lane's invocation gets its own `CODEENSTEIN_TELEMETRY_CONCURRENCY`-way internal browser-context concurrency (default 8, lower than `balancing:telemetry`'s own default of 12, since `LANES` of these run at once), so total concurrent browser contexts is roughly `LANES × CONCURRENCY_PER_LANE`.
- **The queue/resumability/watchdog engine itself lives in `scripts/lib/laneOrchestrator.mjs`**, shared with `run-balancing-campaign-multiplayer.mjs` (see [SSH-host parallelism](#ssh-host-parallelism) below) — `run-balancing-campaign.mjs` itself only supplies the combo list, env vars, and how to read an existing output file's qualifying count; a `Runner` (local `child_process`, or a remote SSH host) is what actually executes an invocation.

## SSH-host parallelism

`balancing:telemetry`'s and `balancing:telemetry-multiplayer`'s own real-time-costly data collection can be spread across N SSH hosts — not by giving those one-shot scripts an SSH concept of their own (neither has a lane/queue to plug one into), but through the two campaign orchestrators (`balancing:campaign`, `balancing:campaign-multiplayer`), which already exist specifically to spawn many instances of the underlying telemetry script in the first place. Both orchestrators can spread their local lanes across N SSH hosts as well, on top of (not instead of) `CODEENSTEIN_CAMPAIGN_LANES`/`_MP_CAMPAIGN_LANES` local lanes — useful when one machine's own core count is the bottleneck, or (for the multiplayer campaign specifically) when running more than one *local* lane isn't possible at all (see below).

- **Host list**: a gitignored `ssh-hosts.env` at repo root, one `user@host` per line — auto-managed, not normally hand-edited (see the setup step right below, which appends to it automatically). Blank/`#`-prefixed lines are ignored; a missing or empty file just means "local lanes only," the common case.
- **Auth is entirely external** — whatever a plain `ssh user@host` would already use (a pre-unlocked key in your local `ssh-agent`, or a `~/.ssh/config` alias). Neither `ssh-hosts.env` nor `scripts/lib/sshRunner.mjs` ever touch credentials.
- **One-time setup per host, then zero sudo forever after.** Adding a new host is one command: `node scripts/setup-ssh-lane-host.mjs user@newhost` — a real interactive SSH session where you may be prompted for your sudo password, installing git/a modern Node if missing, Playwright's Chromium system dependencies, cloning the repo, and running `npm ci`. Once setup succeeds, the host is appended to `ssh-hosts.env` automatically (`appendHostIfMissing`) — no separate manual edit. Run the same script with no arguments to re-run setup on every already-listed host at once (e.g. after a system update wiped one's Node install) — a safe no-op for any host already present. After setup, the *automated* per-run bootstrap (`sshRunner.mjs`'s own `bootstrapHost()`, run by every real campaign invocation) never touches sudo/apt at all — it only checks git/an adequate Node are already there (failing with a pointer back to the setup script if not), then clone-or-fetch, force-checkout the exact local `HEAD` commit, `npm ci`, and `npx playwright install chromium` (browser binary only). A host that's unreachable or fails any automated step is logged as a warning and simply excluded from that run — one bad host must never wedge the whole orchestrator (the same lesson a real stuck combo already taught: see the multiplayer campaign's own `ATTEMPT_CAP` default below).
- **The remote clone always uses `https://`, never this machine's own configured `origin` URL as-is** — confirmed directly as a real failure: this repo's own `origin` is an SSH-style `git@github.com:...` URL (the natural default for an owner who pushes), and shipping that to an arbitrary lane host assumes it has a matching GitHub SSH key too, which a fresh host generally doesn't. `toHttpsCloneUrl()` (`sshRunner.mjs`) normalizes both common SSH forms to `https://` before it ever reaches a remote host — a public repo needs no credentials at all over `https://`.
- **Why this needs a separate one-time script at all, rather than just automating everything**: two of its steps genuinely can't be made both unattended *and* narrowly sudo-scoped. Installing Node needs NodeSource's own `curl | sudo bash` setup script (or the equivalent by hand) — sudoers can only match the executable (`bash`), never what's piped into its stdin, so a NOPASSWD rule for that is unrestricted passwordless root, not a scoped step. And Playwright's own `--with-deps`/`install-deps` has Playwright itself decide and `apt-get install` an arbitrary, OS/version-state-dependent package list at run time (confirmed directly — `npx playwright install-deps --dry-run chromium` reported a different missing-package list on hosts at different patch levels) — there's no fixed command line a sudoers rule could ever pin for that. Splitting setup (real interactive sudo, once) from every automated run (no sudo, ever) sidesteps both instead of trying to scope either.
- **ARM hosts work fine** — nothing in `sshRunner.mjs` is architecture-specific, and Playwright's Chromium build (the only engine this whole family ever launches) has genuine Linux ARM64 support. Real per-attempt wall-clock cost can still vary a lot by hardware, same "calibrate before trusting" discipline as `CODEENSTEIN_CAMPAIGN_WATCHDOG_MS`'s own calibration note above.
- **A remote lane's own result file is pulled back via `scp`** into the exact local path the orchestrator's resumability scan expects, so local and remote lanes are indistinguishable from the queue's point of view.
- **Known gap, not yet solved**: a local watchdog timeout kills the *local* `ssh` client, which best-effort propagates (via a forced pseudo-terminal, `-tt`) to the remote command, but a genuinely dropped connection can still leave an orphaned remote process running — a real fix needs a remote supervisor, out of scope for this first cut.
- **Multiplayer-specific limitation**: `run-balancing-campaign-multiplayer.mjs` defaults `CODEENSTEIN_MP_CAMPAIGN_LANES` to **1**, not 2 — every local invocation starts its own isolated signaling+dev server pair on the same fixed ports (`multiplayerTestServers.mjs`, 8788/5174), so two concurrent *local* lanes would collide today. Real multiplayer parallelism is expected to come from SSH lanes (each its own remote machine, no port conflict) rather than raising the local lane count.

## Matched-scale verification

Any change to navigation/combat/movement logic in `run-balancing-telemetry.mjs` needs more than "the scan came back clean" before it's trustworthy:

- **A/B against a baseline worktree** (`git worktree add /tmp/bot-ab-base <last-good-sha>` — not `git stash`, which can't serve both sides against one dev server) at the *same* `CODEENSTEIN_TELEMETRY_CONCURRENCY`/`_ATTEMPT_CAP`/`_LEVEL_LIMIT` that will ultimately be trusted. A small or low-concurrency sample has previously masked a real ~4x survival-rate regression (Casual/normal level-2 death rate looked fine at `CONCURRENCY=1`, but was 72% — vs. the true baseline's 0% — at `CONCURRENCY=6`/`ATTEMPT_CAP=20`).
- **`diagonalStrafeKey`** (the bot's diagonal-movement helper, plain-navigation branch only) is the sharpest cautionary example: an earlier change to its usage caused exactly that 72%-vs-0% regression, only caught via the matched-scale A/B above — not by `balancing:scan`. It's scoped to plain-nav only for this reason; don't re-add it to `hazard`/`criticalHealth`/`mineRetreat`/ranged-aim branches, and treat even refinements *within* its current safe usage as needing the same verification bar, not just a scan.

### Concurrency was never the mechanism — the qualify loop's early exit is

The "low concurrency masked it" story above is real but was misattributed, which matters because it made the fix look like a knob rather than a rule. `runQualifyLoop` (`scripts/lib/qualifyLoop.mjs`) is `while (qualifyingRuns.length < requiredQualifyingRuns && attempts < attemptCap)`, running `concurrency` attempts per batch — and `failureReasons` only accumulates from attempts actually run. At `CONCURRENCY=1` a bot that qualifies 3-of-3 runs **exactly three attempts and records zero failures**, whatever its true death rate; at `CONCURRENCY=6` the first batch always runs six, so failures get recorded. Concurrency was changing the *sample size*, not the simulation.

So don't rely on concurrency to produce a denominator. Set **`CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET=999`** for any A/B, which makes the loop always run to `ATTEMPT_CAP` — a guaranteed denominator instead of an incidental one. Keep `CONCURRENCY=6`/`ATTEMPT_CAP=20` as well, to honour the bar the regression above established.

### The A/B recipe

Run once per side, then diff:

```sh
for combo in "Casual normal" "Gamer normal" "Pro hard" "Pro normal"; do
  set -- $combo
  CODEENSTEIN_TELEMETRY_PROFILE=$1 CODEENSTEIN_TELEMETRY_DIFFICULTY=$2 \
  CODEENSTEIN_TELEMETRY_LEVEL_LIMIT=8 CODEENSTEIN_TELEMETRY_ATTEMPT_CAP=20 \
  CODEENSTEIN_TELEMETRY_CONCURRENCY=6 CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET=999 \
  CODEENSTEIN_TELEMETRY_ANOMALY_SCAN=1 \
  CODEENSTEIN_TELEMETRY_OUTPUT_FILE=ab/<side>-$1-$2.json \
  node scripts/run-balancing-telemetry.mjs
done

node scripts/report-balancing-ab.mjs ab/base ab/cand   # dirs or single files
```

The four combos are not arbitrary: **Casual/normal** is the combo the 72% regression showed up on, **Gamer/normal** is where most quoted telemetry numbers come from, and **Pro/hard** is where `enemyAimSpreadDeg = 0` (perfect enemy aim) makes any dodging/movement change matter most.

**Pro/normal** is the fourth for a reason worth stating, because it is the kind of gap that stays invisible until it costs a day. A profile and a difficulty are independent axes, and running Pro *only* on hard leaves every Pro-specific behaviour untested at normal's enemy aim and damage. That is exactly what happened on 2026-07-31: a reproducible ~22s freeze at a fixed tile on level 1, hitting roughly 40% of Pro/normal attempts, survived a full day of A/Bs because no side of any A/B ran that cell — it only surfaced in the wider `balancing:scan`, which does sweep every profile. Two of the three combos above are `normal` and the third changes *both* axes at once, so `Pro` and `hard` were confounded: any Pro-only regression was indistinguishable from a hard-only one. Adding this cell makes the profile axis separable at fixed difficulty, and it is the cheapest possible insurance against re-learning that lesson.

The cost is real — a fourth combo is a third more wall clock per side — so if you must drop one for a change that plainly cannot interact with difficulty (a pure navigation or routing change, say), drop `Pro/hard` and keep this one, not the other way round.

`report-balancing-ab.mjs` splits the comparison in two on purpose, and the split is the point:

- **Guard metrics** — `qualifyRate` (from `trueQualifyingCount`, never the floored `qualifyingRunCount`) and a per-level **conditional** death rate, `died[i] / reached[i]`. Raw death counts don't compare across two runs with different reach: a level nobody got to has no deaths. These are attempt-level, so n=20 detects a 0%→72% swing instantly and nothing near 10pp — small guard movements are not readable at this sample size and must not be reported as if they were. Pre-registered rollback thresholds (in `abReport.mjs`, deliberately fixed in code rather than chosen after seeing the numbers): qualifyRate down >15pp, any level's conditional death rate up >20pp, or **any** increase in stuck count. A breach means revert, not tune. The CLI exits non-zero on a breach.
- **Win metrics** — `enemyAccuracy`, `levelTimeSec`, `distanceTraveled`, `routeFollowingOverhead`, TTK, health, damage-by-source. Per-level-visit aggregates over hundreds of samples, so these do have real resolution at the same n. Note `routeEfficiencyScore` is marked `"flat"`, not `"up"`: see *Route efficiency is mostly not a bot metric* below.

Passing guards means "not obviously worse", never "the change worked" — always read the win metrics against whatever the change was actually supposed to do. If a guard lands ambiguously (5–20pp worse), escalate that one combo to `ATTEMPT_CAP=60` before deciding; never ship on the ambiguous reading.

One A/B side is roughly 4x `balancing:scan`'s wall clock, and a full gate is two of them — **confirm before launching one.**

### Flip one constant, not one commit (`CODEENSTEIN_TELEMETRY_TUNING`)

A JSON object deep-merged over `DEFAULT_TUNING` for every bot the run builds:

```sh
CODEENSTEIN_TELEMETRY_TUNING='{"NEAR_PI_HEADING_EPS":0}' node scripts/run-balancing-telemetry.mjs
```

This is how a behaviour A/B should be run whenever the change is gated by a constant. The alternative — a worktree at an older commit — makes the whole diff the thing under test rather than the one value, and worse, **a worktree predating the metric you want to read cannot emit it at all**. That is not hypothetical: the first attempt to grade the atan2 branch-cut fix stalled on exactly that, because the baseline commit had no anomaly tally in its output. With the override, both sides run the same binary and differ only by the value. Invalid JSON is a hard exit rather than a warning, since silently falling back to defaults would produce a baseline-vs-baseline comparison that looks like a real result.

Behaviour changes that are gated on a constant expose one deliberately, so they stay A/B-able against the same binary rather than needing a worktree:

| switch | `false` restores |
|---|---|
| `NAV_FULL_WASD` | standing still to turn whenever the heading error exceeds `MAX_WALK_WHILE_TURNING_RAD` |
| `NAV_BACKPEDAL_RETREAT` | spinning to face away before fleeing at critical health |

Three more were added 2026-08-03 for the `verify (multiplayer-transition)` fix. All three are **off in `DEFAULT_TUNING` and on in `MultiplayerBot`**, so single-player telemetry is unchanged by construction rather than by measurement — and so they can be A/B'd into single-player later without a worktree:

| key | default | on |
|---|---|---|
| `BOT_NAV_STALL_BAIL_TICKS` | `0` (off) | `24` — give up on a drive that has not left `BOT_NAV_STALL_RADIUS_TILES` (0.5) for this many consecutive decisions, so `driveTowardWithReplan` re-plans while it still has budget. Sits just above the detectors' own `STALL_TICKS_THRESHOLD` (20), which keeps the invariant *"the bail only fires on something the anomaly scan would have reported as a stall anyway"*. Suppressed while engaged in combat or waiting out a spike trap, mirroring `detectAnomalies`' `mostlyFiring` and `SPIKE_WAIT_DOMINANCE` exemptions. |
| `BOT_LOOT_ABANDON_ON_STUCK` | `false` | `true` — abandon a loot detour whose waypoint has exhausted its re-plans, instead of driving the rest of a path planned from a tile the bot never reached. |
| `MAX_TICKS_PER_WAYPOINT` | `600` | `40` — 600 was sized against `VIRTUAL_STEP_MS` (50), i.e. 30 *simulated* seconds; at `MultiplayerBot`'s 400ms decisions the same number is 240 **real** seconds for a one-tile waypoint. |

Note the A/B for these has to be run *into* single-player (turning them on) rather than out of it, since the multiplayer campaign has no baseline corpus.

**Multiplayer telemetry semantics changed on 2026-08-03, and stored runs from before it are not comparable.** Two things moved: `MultiplayerBot` now carries the tuning above, and `driveOneBot`'s final approach uses `Bot#driveToExit` instead of a bare `driveToward`. The second one moves outcomes directly — an exit held shut by a living exit-room enemy used to record as `stuck` however perfectly the bot was standing on it, and that was scored against the bot's *navigation* when the route had worked exactly as planned.

`meta.flags` did not exist in `multiplayer_balancing_telemetry.json` until the same date, which meant `compareRunFlags` returned `comparable: false` and every cross-run multiplayer comparison silently lost its one guard against this. It now records `botTuning` (from `MULTIPLAYER_TUNING_DEFAULTS`, exported so the recorded value cannot drift from the value used) and `finalApproach`. A comparison spanning the change will now say so instead of quietly reporting a behaviour delta as a balance delta.

What did **not** change is the outcome vocabulary. `driveToExit` reports `arrived` only when *this* bot stood on the exit tile and saw the exit accepted; a teammate's exit touch still arrives as `teleported` and is still classified `levelAdvanced`. That distinction is what `trueQualifyingCount` rests on, and widening it into `reachedExit` would have inflated exactly the number the campaign is judged by.

### Judging a bot-behaviour change: use `anomaly (ticks/1k dec)`

With `CODEENSTEIN_TELEMETRY_ANOMALY_SCAN=1`, each combo's output carries an `anomalySummary` — per anomaly type, `findings`/`ticks` totals plus `findingsPerRun`, `ticksPerRun` and `ticksPerKiloDecision`. `report-balancing-ab.mjs` diffs the last of those.

Two normalizations, both learned the hard way:

- **Ticks, not findings.** `detectOscillation` counts *events*. A change that makes the bot cover less ground can trip *more* qualifying windows while behaving better — which is how the first oscillation fix got graded as a +9.6% regression and reverted on a number that didn't mean what it looked like.
- **Per decision, not per run.** Even ticks-per-run is not exposure-independent. Measured on a real comparison: oscillation ticks/run fell 11.7% while `levelTimeSec` fell 7.7%, so most of the apparent win was simply less time on the level. `ticksPerKiloDecision` divides that out.

## Output shape

`balancing_telemetry.json` (repo root, gitignored) holds a meta block (profile definitions), then per-level and campaign-wide aggregates across 7 categories (map density/demographics, combat pacing, AI effectiveness/danger, damage/healing breakdown, weapon efficiency, economy/loot starvation, navigation/map flow), plus deterministic outlier `flags` and per-profile `crossDifficultyFlags`. Judgment-call metrics carry a `{mean, max, min, samples}` spread rather than a bare mean, so a consumer (human or LLM) can see the actual distribution, not just a single number that might hide a bimodal split.

Two raw fields were added 2026-07-27 because the derived ratios they already fed couldn't answer an A/B on their own. `combatPacing.levelTimeSec` — previously read only as `combatVsExplorationRatio`'s denominator and never emitted, which left the playtest bot's loudest failure mode (being far slower over a route than a human) with no output field at all; a ratio can't substitute, since a bot that is uniformly 2x slow reports an unchanged ratio. And `navigationMapFlow.distanceTraveled` — the raw counterpart to `routeEfficiencyScore`, which is `0` whenever `shortestPathTiles` is null and so can't distinguish "walked a tight route" from "the optimum was unknown". Together they separate "the bot got faster" (time down, distance flat) from "the bot took a shorter route" (both down).

### Route efficiency is mostly not a bot metric (measured 2026-07-30)

`navigationMapFlow.routeEfficiencyScore` sat at **0.345** on the demo campaign (Gamer/normal) and was being read as "the bot walks 3x further than it needs to". It does walk 2.9x the theoretical minimum, but only a minority of that is the bot's doing. Decomposed against the planned route and a new per-decision activity attribution (`summarizeActivityDistance` in `bot.mjs`, which charges every tile walked to the errand the bot was on at the time), the 2.9x is three near-independent factors multiplying to 2.97x:

| factor | size | whose fault |
|---|---|---|
| planned route vs bare spawn→exit BFS | **1.68x** | level design — and *entirely* the two key/locked-door levels (demo 3 and 7, 3.7x and 3.5x). The other six plan within 5% of optimal. |
| loot detours (24% of all distance walked) | **1.32x** | bot policy, and mostly justified — 63% of those tiles are ammo, 19% mandatory keys, and only 3.3% of them (0.8% of total distance) is provably wasted: a health pack grabbed at `hp=1.00`, where `MAX_HEALTH` caps the gain at nothing. |
| actually following the plan | **1.30x** | the bot outright. 4.2% of distance is covered while engaged with a threat; ~1.2% of simulated time is the known atan2-branch-cut oscillation. Replan retries and the exit-gate fallback contribute **~0%** on these eight levels. |

Two consequences, both now encoded in the code and in `WIN_METRICS`:

- **`routeEfficiencyScore` is a poor A/B win metric for navigation changes** — it moves mostly with level layout and loot policy. It is marked `"flat"` in `abReport.mjs` rather than `"up"`.
- **`navigationMapFlow.routeFollowingOverhead` is the metric to judge navigation on.** Distance ÷ the route the bot planned for *itself* (`staticAnalysis.plannedRouteTiles`), as a multiplier where 1.0 is a perfect walk; measured **1.71** distance-weighted across levels (the campaign rollup's per-run mean reads ~1.64). Level design divides out; loot stays in, deliberately, because detouring is the bot's own decision. `null` when the route failed to plan and for the campaign-wide rollup.

`plannedRouteTiles` sums straight-line waypoint-to-waypoint distance, which is exact here rather than an approximation: `planRoute` emits one waypoint per tile, and a BFS re-measurement of the true walkable path agreed to the tile on all eight demo levels.

Also, at the combo level (alongside `weaponFirstOwnedAtLevel`): `weaponFirstOwnedAtLevel` is a *min* across qualifying runs — it answers "how soon could this profile realistically get it", not "how often did any run get it at all". `weaponAcquisitionRate` (`{ [weaponIndex]: { count, rate } }`) answers the second question directly, for every unlockable weapon (gdb/ghidra/Friday Hotfix/Toolchain) uniformly — added 2026-07-15 specifically to verify Toolchain's new miss-chance acquisition path (see below) actually moves the needle, since the min-level metric alone can't distinguish "3% of runs get it, always around level 9" from "60% of runs get it, always around level 9".

### `economyLootStarvation` — real amounts, not occurrence counts (fixed 2026-07-15)

`lootRolled` used to record a flat `1` (an occurrence, not a quantity) for every drop whose `LootDrop.amount` was unset at roll time — which is most non-Elite drops, since the real amount is only resolved later, at collection (`applyLootDrop`). This made `lootRolled` unit-incompatible with `consumed` (a real-amount total): a report built on comparing the two (an `ammo_starvation_*` outlier flag) had to be removed rather than fixed as a result. `RaycasterEngine.pushLootDrop` now records the real, difficulty-scaled amount a drop is worth (`defaultLootAmountFor` mirrors `applyLootDrop`'s own fallback exactly) for every kind except `"weapon"`, which stays an occurrence count on purpose — a weapon drop's real value (grant vs. an ammo top-up if already owned) depends on ownership state at *collection* time, which can change between roll and collection, so `1` is the only thing that can honestly be recorded for it regardless of when. `lootRolled` and `consumed.total` should now sit within roughly the same order of magnitude per resource, not off by 10-20x.

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
| `npm run balancing:campaign-multiplayer` | Resumable orchestrator (`scripts/run-balancing-campaign-multiplayer.mjs`) — spawns one OS process per combo (via the new `CODEENSTEIN_MP_TELEMETRY_COMBO_PROFILES` pin, see below), each writing its own file under `balancing_runs_multiplayer/`, shares `scripts/lib/laneOrchestrator.mjs` with `balancing:campaign`. See [Large-scale campaigns](#large-scale-campaigns-npm-run-balancingcampaign)/[SSH-host parallelism](#ssh-host-parallelism) above — same design, `CODEENSTEIN_MP_CAMPAIGN_*` env vars instead of `CODEENSTEIN_CAMPAIGN_*`, smaller defaults throughout (`_TARGET` 10, `_BATCH_SIZE` 2, `_ATTEMPT_CAP` 30, `_LANES` 1, `_MAX_INVOCATIONS` 3) given the much higher real-time cost per attempt. |

Both always start their **own isolated signaling + dev server pair** (`scripts/lib/multiplayerTestServers.mjs`, ports 8788/5174 — deliberately never 8787/5173, a developer's own manual session's default ports) rather than share whatever a developer's own dev session happens to be pointed at. The signaling server's rate limits are per-IP, not per-session (`multiplayer-balancing-telemetry-spec.md` §7) — running this tool's own traffic against a shared server risks tripping a budget sized for one human's manual testing. There's no `CODEENSTEIN_DEV_URL`-equivalent override for this reason: the isolated pair is always used.

### Profiles, difficulty, and the combo matrix

Reuses `run-balancing-telemetry.mjs`'s own `PROFILES` (Casual/Gamer/Pro) and `DIFFICULTIES` (easy/normal/hard) unchanged. Beyond that, the combo matrix is genuinely different from single-player's:

- **One bundled demo-campaign level per run, not the full campaign.** Multiplayer level transition is already covered on its own by `verify-multiplayer-transition.mjs` (one transition, host god-moded) — re-driving that whole sequence for every combo would multiply this tool's already-real-time-only cost for no new signal. A run "qualifies" once every bot reaches the exit tile alive (`teamOutcome === "allReachedExit"`). Chaining several *consecutive* real transitions (the gap neither that script nor this one covers) is instead a separate, dedicated functional check — see `npm run verify:multiplayer-campaign` (`scripts/verify-multiplayer-campaign.mjs`), not a balancing-data tool itself.
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

---

## The balance model: offline solver and event log

**Status: implemented.** This part was written as a design first and then built;
the ordering and the reasoning below are kept as-written because they explain
*why* each piece is shaped the way it is, and §6 records which step shipped what.
Where a measurement later corrected the design's own assumption, the correction is
recorded inline rather than the original quietly edited away — §7.1 is the clearest
example.

What runs today:

| Command | What it does |
|---|---|
| `npm run balancing:budget` | Solve a campaign's budget offline — no browser, no bot. `--dir` any repo, `--all-difficulties`, `--json`. Exits non-zero on an enemy that outlasts every round on its level. |
| `npm run balancing:corpus` | Fetch the pinned corpus of real repositories to solve against. |
| `npm run balancing:events` | Turn a raw event log into a markdown report. |
| `CODEENSTEIN_TELEMETRY_EVENT_LOG=<dir>` | Turn on raw event recording for a telemetry run. Off by default. |
| `CODEENSTEIN_TELEMETRY_SEED=<n>` / `?seed=` | Pin the gameplay seed so loot rolls are reproducible. |

The problem this part exists to solve: levels are generated from *arbitrary
repositories*, so no amount of playtesting the bundled `demo-campaign/` produces
confidence about a repo nobody has ever opened. The bot harness above answers "how
does this campaign play"; it cannot answer "is this level clearable at all" for a
level that does not exist yet. That needs a solver which reads a generated level
and the real combat constants and computes the answer without anyone playing.

Two additions, in priority order:

1. **An offline solver** — generate a level, compute its enemy budget, its loot
   budget, per-weapon TTK and the resulting ratios. No browser, no bot, no play.
2. **A raw event log** — per-occurrence records written alongside (never instead
   of) the existing aggregates, so a metric can be invented after the data was
   collected instead of requiring re-instrumentation.

## 1. Baseline

### 1.1 The telemetry that exists today is aggregate, end to end

Every field of `TelemetryState` and `TeamTelemetryState` (`src/engine/telemetry.ts`)
is a scalar accumulator: `state.damageBySource[source] += amount`,
`tallyFor(state, weaponIndex).shotsFired += 1`. Once recorded, an event's
timestamp, position, actor and identity are gone — `damageBySource.enemyMelee = 412`
cannot be decomposed into which enemy, when, or how much per bite.

Raw per-occurrence data exists at exactly two points, and neither reaches disk:

- **`ttkRecords`** (`telemetry.ts:89-90`) is genuinely one record per enemy that
  ever aggroed, carrying `{category, aggroAtLevelTime, deathAtLevelTime}`, and it
  survives into the snapshot verbatim (`engine.ts:1679`). It is then destroyed by
  the *first* aggregation step: `run-balancing-telemetry.mjs:599-605` reduces each
  record to a bare duration in `ttkByCategory[category]`, discarding enemy identity
  and absolute timing. What lands in `balancing_telemetry.json` is an unordered bag
  of durations.
- **The bot's per-decision trace** (`bot.mjs:778`, appended at `:863-866`) is a
  real event log, gated off by default, consumed in-process by the anomaly
  detectors, and thrown away when the next `startLevel()` reallocates it.
  `CODEENSTEIN_TELEMETRY_TRACE_DUMP=1` prints a *fragment* of it as formatted text.

There is no NDJSON, no CSV and no append-only log anywhere in `src/` or the
balancing scripts. `src/engine/replay.ts` is the closest thing that exists — one
`ReplayFrame {dt, input}` per simulated frame plus `gameplaySeed`, and by
construction it reproduces a run exactly — but it records **inputs, not outcomes**,
carries no damage/kill/loot event, lives in `localStorage`, and no balancing tool
reads it. The proposed event log is its outcome-side counterpart.

**Gating.** `this.telemetryEnabled = PLAYER_STATS_ENABLED || isTestHooksActive()`
(`engine.ts:1037`). `PLAYER_STATS_ENABLED` is `false` (`playerStats.ts:29`) and
`isTestHooksActive()` (`engine.ts:215`) requires `?testHooks=1`. So in shipped
play nothing is recorded at all: `teamTelemetry` stays `undefined`, every
`PlayerState.telemetry` stays `undefined`, and every call site is a guarded no-op.

**Existing per-frame cost when telemetry *is* on** — worth writing down so a future
reader does not attribute it to the event log:

| Cost | Site |
|---|---|
| `updateMinHealth` + `updateTelemetryPerFrame`, per living player | `engine.ts:2600-2611` |
| Full `this.enemies` scan for `peakAggroedCount` / `combatTimeSec` | `engine.ts:3325-3332` |
| Two `Object.values(...).reduce(...)` over `weaponTallies` in `buildStats()`, which runs once per rendered frame | `engine.ts:4616-4617`, called from `render()` |

`PLAYER_STATS_ENABLED`'s own doc comment (`playerStats.ts:19-28`) records that
recording on every real playthrough "measurably slowed gameplay down", and that
the ~20 `record*` call sites were the remaining cost after the derived stats were
already gated to level-end. That is the strongest available evidence that this path
must not widen, and it is why §3 adds no per-frame work whatsoever.

### 1.2 Balance constants

**There is no single constants module.** Numbers live across ~14 files in two
layers. `SIMULATION_BALANCE` (`engine.ts:308-322`) is a partial aggregator feeding
`computeBalanceHash`, and it is explicitly incomplete — its own comment
(`engine.ts:300-306`) names `ELITE_DAMAGE_MULTIPLIER`, `EDGE_CASE_SPEED_MULTIPLIER`,
`SPIKE_DPS`, `MINE_DAMAGE_FALLOFF_FLOOR` and `PROJECTILE_SPEED` as *not* covered.

#### Weapons — `src/engine/weapons.ts:150-292`

| # | `name` | Dmg/pellet | Pellets | `spreadPx` | Fire interval | Auto | Ammo/shot | Pool | Kind | Range limit | Lifesteal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | echo pistol | 22 | 1 | 0 | 0.15 s | — | 1 | bullets | hitscan | — | — |
| 1 | Regex Shotgun | 25 | 7 | 70 | 0.85 s | — | 4 | bullets | hitscan | — | — |
| 2 | SIGKILL Knife | 40 | 1 | 0 | (default 0.15 s) | — | 0 | *none* | melee | `meleeRange` 1.5 | 1 |
| 3 | gdb | 12 | 1 | 0 | 0.09 s | yes | 1 | smg | hitscan | — | — |
| 4 | ghidra | 150 | 1 | 0 | 1.1 s | — | 1 | rockets | **projectile** | blast 2.6 | — |
| 5 | Friday Hotfix | 8 | 6 | 45 | 0.1 s | yes | 2.5 | gas | hitscan | `maxRange` 3.5 | — |
| 6 | Toolchain | 80 | 1 | 0 | 0.35 s | yes | 0 | *none* | melee | `meleeRange` 1.5 | 3 |

gdb overrides `maxConeDeviationPx` to 20 (`weapons.ts:230`); everything else uses
the shared `MAX_CONE_DEVIATION_PX = 38` (`engine.ts:338`).

**There are no magazines, no reload, and no weapon switch/draw time anywhere in the
codebase.** Ammo is a flat continuous pool per type, decremented directly at
`fire()` (`engine.ts:4340`); switching is instant (`consumeWeaponRequest` → `equip`,
no timer). **Ammo has no upper cap** — `engine.ts:222-223` states it outright; only
the IDKFA cheat's `CHEAT_MAX_AMMO = 999` bounds anything.

**Hitscan weapons have no damage falloff.** Damage is flat per pellet at any range.
What falls off is *accuracy* — the Cone of Fire, `engine.ts:4268-4270`:

```
rangeFraction = min(1, zBuffer[col] / FOG_FAR)          // FOG_FAR = 14 tiles
deviation     = (rng()*2 - 1) * rangeFraction**3 * (weapon.maxConeDeviationPx ?? 38)
```

Cubic in range, in **screen pixels**, resolved against the per-column z-buffer.
Melee is exempt. This is the single reason hit probability is not cleanly
computable offline — see §4.4.

Ghidra is the one projectile: `ROCKET_SPEED = 18` t/s, `ROCKET_BLAST_RADIUS = 2.6`,
damage `150 * max(0.3, 1 - d/2.6)`, and it damages the firer too (`rockets.ts:20-121`).

Starting ammo (`ammo.ts:86-104`), before carryover:

```
bullets = max(28, round(shotsToClear * 1.7 + enemies.length * 2.5) + 10)
          where shotsToClear = Σ ceil(enemy.maxHp / 22)      // 22 = pistol damage
rockets = 4    smg = 40    gas = 40
```

Note this is computed *after* difficulty HP scaling (`createPlayerState` at
`engine.ts:1044` runs after the rescale at `:1016-1020`), so it scales with
difficulty for free. It also means **level 1 already ships with a guaranteed
bullets-only clear margin**: the `× 1.7` applies to the perfect-accuracy shot count,
the per-enemy `ceil` rounds each enemy's cost up on top of that, and the miss buffer
and `+10` add more — so the real starting ratio lands closer to 2.3–2.4× for a
typical roster, not 1.7×. That is worth knowing before reading any level-1 economy
number as evidence of anything.

From level 2 on, carryover overrides starting ammo entirely
(`engine.ts:1179-1182`), so the economy is a **campaign running balance**, not a
per-level independent quantity. The solver must model it that way or every level
after the first will read as far poorer than it plays.

#### Enemy archetypes

Three archetypes, distinguished by two booleans on `Enemy`, not by a stat table.
**Only HP is computed from the repo; every other combat stat is a shared constant.**

| | Regular | Elite | Edge Case |
|---|---|---|---|
| Trigger | function/method entity | same, `complexity ≥ 40` | corridor dressing |
| HP | `max(25, round(c*25/count))` | `c * 25 * 2` | 10–15 uniform |
| Melee dmg | 10 | 20 | 4 |
| Bolt dmg | 8 | 16 | 3.2 |
| Melee interval | 0.8 s | 0.8 s | 0.8 s |
| Ranged interval | 1.2–2.6 s uniform | same | same |
| Aggro radius | 7.5 | 7.5 | 7.5 |
| Melee radius | 0.5 | 0.5 | 0.5 |
| Ranged range | 8 | 8 | 8 |
| Chase speed | 1.7 | 1.7 | 3.74 |
| Roam speed | 0.8 | 0.8 | 1.76 |

Sources: `enemyAi.ts:26-62` (`AGGRO_RADIUS`, `MOVEMENT_SPEED`, `RANGED_RANGE`,
`FIRE_COOLDOWN_MIN/MAX`, `ROAM_SPEED`, `ATTACK_RADIUS`, `ATTACK_COOLDOWN`,
`ATTACK_DAMAGE`, `ELITE_DAMAGE_MULTIPLIER`, `EDGE_CASE_SPEED_MULTIPLIER`,
`EDGE_CASE_DAMAGE_MULTIPLIER`), `projectiles.ts:15-19` (`PROJECTILE_SPEED` 5,
`PROJECTILE_DAMAGE` 8, `PROJECTILE_RADIUS` 0.15), `enemies.ts:11-68`.

**Every one of those `enemyAi.ts` constants is module-private.** That is the
solver's one real blocker for incoming-DPS and threat-score metrics — see §7.

Aggro needs proximity **and** line of sight (`enemyAi.ts:173-182`) and is sticky;
being shot sets it unconditionally, bypassing LOS (`engine.ts:4454`). There is no
telegraph on either attack. Bolts do not home.

#### Player — `src/engine/engine.ts`

`MAX_HEALTH` 100 (`:203`), `MOVE_SPEED` 3.2 (`:182`), `SPRINT_MULTIPLIER` 2.0
(`:184`), `ROT_SPEED` 2.6 rad/s (`:186`), collision radius 0.2 (`player.ts:23`).
Strafe is the *same* speed as forward (`player.ts:80-84`) and reversing is too.

Armour is `swap`, starts at 0, caps at `MAX_SWAP = 100` (`loot.ts:167`), and
absorbs **1:1 before health** (`engine.ts:3739-3745`). There is no percentage
reduction, no resistance and no invulnerability frames — so effective HP is exactly
`health + swap`.

No in-level respawn exists. Death ends a single-player run; in coop a dead player
revives at the next level transition at `REVIVE_HEALTH = 50` (`engine.ts:394`).

Environmental damage: `HAZARD_DPS` 18 (`engine.ts:275`), `SPIKE_DPS` 20
(`traps.ts:14`), mine `32 * max(0.35, 1 - d/2.4)` (`traps.ts:32-36`), rocket
self-splash at full strength.

#### Difficulty — `src/difficulty.ts:50-54`

| | `hp` | `damage` | `ammoDropRate` | `enemyAimSpreadDeg` |
|---|---|---|---|---|
| easy | 0.7 | 0.85 | 1.3 | 10° |
| normal | 1 | 1 | 1 | 4° |
| hard | 1.5 | 1.5 | 0.7 | 0° |

`damage` covers enemy melee and bolts only — not traps, hazards or rocket
self-damage. `ammoDropRate` scales **both** dropped and pre-placed pickup amounts
(`scaledLootAmount`, `engine.ts:3549-3551`), which matters for the solver: the
pre-placed budget is difficulty-dependent too.

Multiplayer adds an Elite-only rescale, `hp × (1 + 0.5·(players−1))` and
`damage × (1 + 0.25·(players−1))` (`multiplayerScaling.ts:33-47`), unbounded in
player count.

### 1.3 Drop rules — they exist, and they dominate

A regular kill fires **up to four independent rolls** (`engine.ts:4490-4539`):

| Roll | Guaranteed? | Rate | Yields |
|---|---|---|---|
| Health top-up | yes, if `health < MAX_HEALTH` | 100% | 20 (×`ammoDropRate`) |
| Weighted ammo/swap | no | 80% (`REGULAR_KILL_NO_DROP_CHANCE = 0.2`) | one kind from the table below |
| Miss-consolation Toolchain | only on the 20% miss | 5% of misses = **1% of kills** | Toolchain, if level ≥ 4 and unowned |
| Bonus weapon | independent, stacks | 1% (`NORMAL_KILL_WEAPON_DROP_CHANCE`) | a random still-locked index from `[3,4,5]` |

An Elite kill takes a completely separate path (`lootApply.ts:160-177`) — the
`if (enemy.elite) dropEliteLoot(...) else {...}` split is total, so an Elite never
rolls the miss chance:

| Roll | Rate | Yields |
|---|---|---|
| Guaranteed drop | 100% | health 50; or, at full health, a 50/50 between bullets 18 and swap 30 |
| Bonus weapon | 60% (`ELITE_BONUS_WEAPON_DROP_CHANCE`) | a still-locked index, **plus** Toolchain if level ≥ 4 |

Loot-kind weights (`loot.ts:19-51`), re-normalised after filtering:

| Kind | base (easy/hard) | normal | bonus level |
|---|---|---|---|
| bullets | 40 | 46 | 24 |
| smg | 18 | 20 | 20 |
| gas | 18 | 20 | 20 |
| rockets | 10 | 12 | 20 |
| health | 16 | 11 | 20 |
| swap | 16 | 11 | 16 |

Filters (`loot.ts:102-109`): `rockets`/`smg`/`gas` are removed entirely unless the
matching weapon is owned, and `health` is *always* removed because the engine passes
`healthHandledSeparately = true` — health is its own unconditional check now.

Drop amounts (`loot.ts:131-165`): bullets 4, rockets 1, smg 21, gas 21, health 20,
swap 11; elite fallbacks bullets 18, rockets 6, smg 80, gas 80, swap 30, health 50.

Three things the brief asked about, answered explicitly:

- **The kill method does not affect drops.** The drop block reads only
  `enemy.elite`, `shooter.health`, `shooter.ownedWeapons`, `map.bonusLevel`,
  `difficultyLevel` and `this.rng`. `weaponIndex`, `forcedMelee` and `lifesteal` are
  consumed earlier, for telemetry and the lifesteal heal, and never reach it.
  Killing with the knife, a rocket or the flamethrower yields identical
  distributions.
- **Leftover magazine contents do not carry over**, because there are no magazines.
  Enemies carry no inventory at all — a drop's contents come entirely from the
  weighted roll.
- **Edge Cases take the regular path with no special-casing.** A 10 HP Edge Case
  has exactly the same expected drop as a 500 HP regular enemy. That is the single
  most suspicious line in this whole section, and §2.2's self-sustain ratio is
  designed to quantify it.

### 1.4 Pre-placed loot — the budget the generator actually controls

| Source | Contents | Cap / rate |
|---|---|---|
| Scattered ammo (`pickups.ts:11-25`) | bullets 11, or rockets 3 at 30% if ghidra owned | Bernoulli(0.22) per non-spawn room; bonus levels 0.65 and ×1.5 |
| Secret rooms (`secretRooms.ts:15-22`) | health 60, rockets 4, swap 40, one weapon | `MAX_SECRET_ROOMS = 5` |
| Vendor depots (`vendorDepots.ts:27-37`) | bullets 12, rockets 3, smg 30, gas 30 — each gated on ownership | `floor(importCount/4)`, max 4 |
| Exception zones (`exceptionZones.ts:42-71`) | catch: health 45, swap 35; finally: bullets 14, rockets 3 | `MAX_EXCEPTION_ZONES = 3` |

All amounts are scaled by `ammoDropRate` at collection, not at placement.

**Note what pre-placed ammo scales with: room count, i.e. entity count.** Not enemy
HP, not enemy count, not walkable area. See §7 finding 5.

### 1.5 Generator mapping rules

**A file is a level. Folders contribute only ordering** (`main.ts:2893
flattenParsableFiles`). Within a file, one room per `CodeEntity`, in `startLine`
order — but only `function`/`method` entities produce enemies. Classes, interfaces
and traits get a room and no enemy; globals become acid pools.

Complexity is `1 + decisionPoints + smellBonus` (`genericParser.ts:175`), where the
smell bonus adds 2 per parameter beyond 5 and 3 per nesting level beyond 3
(`astUtils.ts:108-117`).

The enemy mapping, verbatim (`enemies.ts:92-101`):

```ts
const complexity = Math.max(1, room.entity.complexityScore);
const elite = complexity >= ELITE_COMPLEXITY_THRESHOLD;          // 40
const count = elite ? 1 : 1 + Math.floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY);  // 10
const hp = elite
  ? complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER          // 25 * 2
  : Math.max(HP_PER_COMPLEXITY, Math.round((complexity * HP_PER_COMPLEXITY) / count));
```

**There is no clamp, cap or normalisation on enemy HP.** The only `clamp()` near
complexity is on *room geometry* (`geometry.ts:21-27`, side capped at 18 tiles),
and the only repo-size normalisation in the whole generator is map dimension
(`ROOM_SPREAD × √roomArea + ROCK_RESERVE`, clamped 48..160,
`mapGenerator.ts:431-458`) — geometry only. See §7 finding 1 for what that means.

Walkable area is computable but awkward: `countWalkableTiles` (`engine.ts:4788`) is
module-private, and `staticLevelAnalysis.mjs:17-31` already keeps a hand-copied
mirror of it and `isWalkableTile`.

### 1.6 Determinism

**Map generation is fully deterministic and content-addressed.** `mulberry32(seedFrom(parsed))`
(`mapGenerator.ts:209`), where `seedFrom` is FNV-1a over
`language:linesOfCode:kind/name/complexityScore,…` (`seed.ts:8-18`). Zero
`Math.random()` exists under `src/map/` or `src/parser/`. One shared stream threaded
through every subsystem in a fixed order, so the *order of generation passes is
part of the contract*.

Two caveats worth recording: the seed signature omits `nestingDepth` and comment
text, so it is not a complete fingerprint of what generation actually reads (two
files can share a seed and still generate different maps — determinism holds, the
seed just is not a complete identifier); and `GenerateOptions` (weapon ownership,
`missingWeaponIndices`, `bonusLevel`, `maxPlayers`) also feed generation, so the
same file at a different campaign position produces different pickups and grid.

**Gameplay randomness is seeded but not pinnable.** Loot rolls, enemy AI timing,
weapon spread and enemy aim all draw from one `createResumablePrng(gameplaySeed)`
stream (`engine.ts:1000-1001`). So drops *are* deterministic given a seed — but the
seed comes from `randomSeed()` (`main.ts:2569`), the one sanctioned `Math.random()`
(`prng.ts:69-71`), and **there is no way to supply one**: no UI field, no CLI flag,
no env var in any balancing runner. See §7 finding 2.

One direct `Math.random()` sits on the combat path — `engine.ts:4456`,
`baseBloodCount` inside `damageEnemy` — sizing a blood-particle burst. It touches no
simulation state, but it is the only one in `engine.ts`, whose own field comment at
`:715` says "Never `Math.random()` directly". Recorded here so a future determinism
audit does not have to rediscover that it is benign.

## 2. Stat catalog

Marker key: **A** = analytic (computable offline from level data + constants),
**E** = empirical (needs play), **A+E** = both, and the two should agree — where
they disagree, that gap is itself the finding.

Nothing is listed for completeness. Every entry states what you would *change* if
it came out bad; anything without such an answer is in §2.6 instead.

### 2.1 Weapon performance

| Metric | Kind | Definition / computation | Needs | Bad when |
|---|---|---|---|---|
| `ttkAnalytic[w][arch]` | A | `shotsToKill × fireIntervalSec`. No reload term — there are no magazines. | constants + roster | > 8 s vs a normal enemy (matches the existing `NORMAL_TTK_HIGH_SEC`) |
| `ttkObserved[arch]` | E | aggro→death window; already collected as `avgTtkByCategory` | `kill` | ≫ analytic (means the weapon is unusable at real range, not merely slow) |
| `shotsToKill[w][arch]` | A | `ceil(hp / (damagePerPellet × pellets))`, pellets=1 for ghidra | constants + roster | any weapon needing > total obtainable ammo for that pool |
| `overkill[w]` | E | mean `−hpAfter` on the killing blow ÷ damage dealt | `damageDealt{hpBefore,hpAfter}` | > 30% — the weapon's granularity is wrong for this roster |
| `dpsSustained[w]` | A | `damagePerPellet × pellets / fireIntervalSec` | constants | — (a comparison axis, not a threshold) |
| **`damagePerAmmo[w]`** | A | `damagePerPellet × pellets / ammoPerShot`; ∞ for melee | constants | a weapon both below the pistol *and* slower than it has no reason to be fed |
| `pelletHitRate[w]` | E | pellets connected ÷ pellets fired | `shot{pellets}`, `hit` | — |
| `triggerHitRate[w]` | E | trigger-pulls landing ≥1 pellet ÷ trigger-pulls | `shot`, `hit` | — |
| `hitRateByDistance[w][bucket]` | E | `hit`/`shot` bucketed by `dist` (0–2, 2–4, 4–7, 7–10, 10–14 tiles) | `shot{dist}`, `hit{dist}` | a weapon whose rate collapses inside its own usable range |
| `switchesPerEngagement` | E | `weaponSwitch` count between first aggro and last kill of a fight | `weaponSwitch`, `kill` | — (bot-policy signal, see §2.6 on why the *cost* half is cut) |
| `share.shots/damage/kills[w]` | E | per-weapon fraction of each total | `shot`, `damageDealt`, `kill` | **< 2% of kills for an owned weapon = dead content**, reported as a first-class line, not a footnote |

`damagePerAmmo` is the number that decides whether a weapon is worth feeding, and
it is worth precomputing here because the current values are not intuitive:

| Weapon | dmg/trigger | ammo/shot | **dmg per ammo unit** | dps |
|---|---|---|---|---|
| echo pistol | 22 | 1 | **22.0** | 147 |
| Regex Shotgun | 175 (7×25) | 4 | **43.8** | 206 |
| gdb | 12 | 1 | **12.0** | 133 |
| ghidra | 150 | 1 | **150.0** | 136 |
| Friday Hotfix | 48 (6×8) | 2.5 | **19.2** | 480 |

Read against §1.3's drop weights this already predicts something the solver should
confirm per level: the shotgun is twice as ammo-efficient as the pistol *out of the
same pool*, so a bullets-starved level should be shot-gunned, while gdb's own pool
is fed by 21-round drops precisely because it is the least efficient per round.
These are the perfect-accuracy figures — §4.4.

### 2.2 Loot economy

Every quantity here is reported **three ways: pre-placed only, dropped only, and
combined.** Pre-placed is a fixed budget the generator controls; dropped is a
feedback loop that scales with how much you fight. Summing them hides which knob is
wrong, and this game has already been burned by exactly that: a 450-run campaign
found dropped loot was **93–100% of everything actually consumed, every resource
type, every combo** (see `loot.ts:119-130`), which is what motivated the ~30% drop
cut and `REGULAR_KILL_NO_DROP_CHANCE`.

| Metric | Kind | Definition / computation | Needs | Bad when |
|---|---|---|---|---|
| **`clearRatio[source]`** | A | (Σ damage obtainable from ammo of that source + starting loadout) ÷ Σ enemy HP, per weapon and overall. Ammo → damage via `damagePerAmmo`. | constants + roster + pickup list + drop model | pre-placed-only < 1.0 means the level is unclearable without farming; combined < 1.2 means no margin for a miss |
| **`selfSustain[arch]`** | A | expected damage-worth of one kill's drop ÷ damage needed to kill it. Expected drop = 0.8 × Σ(weightᵢ/Σweight × amountᵢ × `damagePerAmmo`ᵢ), plus the guaranteed health grant valued separately. | drop tables + weights + constants | **> 1.0 = fighting is free ammo and the economy has no floor**; ≪ 1.0 = every fight is a net loss |
| `incomeVsExpenditure` | E | cumulative ammo gained and spent over level time, both curves, split by source | `lootCollected`, `shot` | income curve flat while expenditure climbs — starvation that a total would hide |
| `starvationEvents` | E | intervals at zero ammo in the preferred pool; count, duration, and the fallback used. Attributed: "no pre-placed nearby" vs "drops came up empty" via the last `lootDropped`/`lootCollected` in the window | `shot`, `lootCollected`, `lootDropped` | any forced-melee stretch > 10 s |
| `overflow[source]` | E | amount collected while already at cap. Only health and swap can overflow — **ammo has no cap** | `lootCollected{granted,wasted}` | pre-placed overflow is a *placement* bug; drop overflow is a *rate* problem |
| `uncollectedPrePlaced` | E | pickups still `collected === false` at level end, valued in damage | `levelStart{prePlaced}`, `levelEnd` | the generator's effective budget is lower than its nominal one — the gap is the number to tune against |
| `unrealisedDrops` | A+E | expected drop value of enemies left alive at level end | `levelEnd{enemiesAlive}` + drop model | with the line above, gives nominal-vs-actual economy |
| `scarcity[pool][source]` | A+E | per-pool obtainable damage ÷ damage the pool is asked to deliver | as `clearRatio` | tells whether a gun is starved by *placement* or by *drop tables* — different fixes |
| `relianceRatio` | E | share of consumed ammo that came from drops | `lootCollected{source}` | > 0.9 means the level is only clearable by engaging optional enemies |

The origin split already half-exists: `recordLootCollected(state, origin, kind, amount)`
(`engine.ts:1285`) distinguishes `dynamic` from `static`. What it does not carry is
**which archetype dropped it**, and without that `selfSustain` cannot be measured
empirically at all — only predicted. That is the one field that must be right from
day one (§3.3).

### 2.3 Survivability economy

| Metric | Kind | Definition / computation | Needs | Bad when |
|---|---|---|---|---|
| `incomingDps[arch]` | A | melee `dmg/0.8` at contact + ranged `dmg/1.9` (mean of the 1.2–2.6 s window) within 8 tiles, × difficulty `damage` | `enemyAi.ts` constants (**currently private**) | — |
| `survivalWindow(N)` | A | `(MAX_HEALTH + swap) ÷ (N × incomingDps)` for N = 1…peak observed | as above | < 3 s at the level's observed `peakSimultaneousAggroed` |
| `healthIncomeVsTaken[source]` | A+E | health granted vs damage taken, split pre-placed / dropped | `lootCollected`, `damageTaken` | dropped health ≥ damage taken means fighting is self-sustaining and the level has no attrition |
| **`damageTakenByArchetype`** | E | damage attributed to the archetype that dealt it | `damageTaken{archetype}` | an Edge Case tier out-damaging regulars means the "harmless nuisance" design intent is not holding |
| `deaths`, `nearDeath`, `timeBelowThreshold` | E | deaths per level; dips below 25% that recovered; time below it | `damageTaken`, `playerDeath` | zero near-deaths across a campaign = no stakes (this is exactly how Easy's damage floor got raised) |

`damageBySource` exists today with six sources (`telemetry.ts:28`) but no archetype
attribution — `enemyMelee` merges an Elite's 20-damage bite with an Edge Case's 4.
The archetype split is new and is what makes threat scoring checkable.

### 2.4 Encounter and pacing

| Metric | Kind | Definition / computation | Needs | Bad when |
|---|---|---|---|---|
| `enemyCount`, `enemyHpTotal`, `enemyDpsTotal` | A | roster sums | roster + constants | — |
| the same three per walkable tile | A | ÷ `countWalkableTiles` | roster + grid | > 1.5× the campaign mean (matches the existing `DENSITY_OUTLIER_MULTIPLIER`) |
| **`threatScore[arch]`** | A | `incomingDps × √hp × rangeFactor × speedFactor`, normalised so a regular enemy = 1.0. `rangeFactor` = ranged reach ÷ 8; `speedFactor` = chase speed ÷ 1.7 | constants | lets archetypes be ranked at all — today Elite-vs-EdgeCase is a judgement call |
| `combatVsExploration`, `levelTimeSec`, `distanceTraveled` | E | already collected | existing | — |
| `backtracking` | E | tiles walked over an already-visited tile ÷ total | `levelEnd` + existing distance | > 0.4 means the layout is asking for re-walks |
| `difficultyCurve` | A+E | per-level `clearRatio` and `enemyDpsTotal` across the campaign, as a series | per-level solver output | a spike > 2× its neighbours |

### 2.5 Generator sanity — the repo-specific part

This is the group that only matters because levels come from source code, and it is
the reason the solver exists.

| Metric | Kind | Definition / computation | Needs | Bad when |
|---|---|---|---|---|
| **`complexityToHpCurve`** | A | every entity's `(complexityScore, resulting HP, archetype)`, plotted | parse + roster | see below |
| **`hpOutliers`** | A | entities whose single-enemy HP exceeds the level's *total obtainable damage* | roster + `clearRatio` | **any hit is a hard failure — that enemy cannot be killed with everything on the level** |
| `clampEffectiveness` | A | how many entities hit a clamp, and which | parse + generator | currently always zero for HP, because no HP clamp exists |
| `perLevelBudget` | A | one line per level: enemy HP total, enemy DPS total, ammo damage (pre/drop/combined), health (pre/drop/combined), ratios | all of the above | the tuning table |
| `corpusDistribution` | A | the same budget report over N repos of varying size and language | corpus | shows the spread rather than one sample |

The curve is the point. `hp = complexity × 25 × 2` for Elites is **linear and
unbounded**, so its outliers are not a tail — they are a ray. Regular packs, by
contrast, self-limit: per-member HP is `25c / (1 + ⌊c/10⌋)`, which asymptotes to
250 as complexity rises. Plotting both on one axis makes the discontinuity at
`c = 40` visible as what it is: at `c = 39` the entity spawns four enemies of 244 HP
(976 total); at `c = 40` it spawns **one enemy of 2000 HP**. One extra point of
complexity doubles the entity's total HP and multiplies its *single-enemy* HP by
8.2× — and a single 2000 HP target cannot be split, kited or partially cleared the
way a four-pack can.

### 2.6 Deliberately excluded

Standard shooter metrics that do not apply to *this* game, listed so nobody adds
them back for completeness:

| Excluded | Why |
|---|---|
| Magazine size, reload time, reload-adjusted TTK | No magazines and no reload exist anywhere in the codebase. |
| Burst DPS vs sustained DPS | Same reason — with no magazine to empty, the two collapse to one number. |
| Weapon draw / switch **cost** | Switching is instant. Switch *frequency* is kept in §2.1 as a bot-policy signal; the cost half would measure a constant zero. |
| Hitscan damage falloff | Does not exist. Damage is flat with range; *accuracy* falls off cubically, and §2.1 measures that instead. |
| Armour as a separate pool with its own curve | `swap` absorbs 1:1 with no reduction, so effective HP is exactly `health + swap` and a second model adds nothing. |
| Headshot / hit-location stats | There are no hit locations — a pellet either connects with a sprite column or does not. |
| Movement/aim heatmaps | The player here is a bot with a route planner; its position distribution describes `routePlanner.mjs`, not the level. |

## 3. Event schema

### 3.1 Why NDJSON

**NDJSON — one JSON object per line, appended.** Against the alternatives:

- **vs. a single JSON document** (what `balancing_telemetry.json` is today, written
  by one `JSON.stringify(output, null, 2)` at process end,
  `run-balancing-telemetry.mjs:263`): a killed campaign loses that file entirely.
  An event log must survive a SIGKILL — and the campaign orchestrator *does*
  SIGKILL invocations, by design (`laneOrchestrator.mjs`'s watchdog). With NDJSON a
  truncated final line is discarded and everything before it is intact; a truncated
  JSON array is unparseable.
- **vs. CSV**: events are heterogeneous — a `shot` and a `levelEnd` share almost no
  fields. A single CSV needs a wide sparse header, and one file per event type
  loses the interleaved ordering that makes timeline metrics possible.
- **Dependency cost: zero.** `JSON.parse` per line, `fs.appendFileSync` to write.
  No parser, no schema library. That matters given `doc/dev/decisions.md`'s
  Dependency Minimalism section.

`perf_runs/*.json` already sets the precedent for keeping raw arrays (`rawDeltas`,
one float per frame) next to the summaries computed from them.

One file per run: `balancing_events/<profile>-<difficulty>-<runId>.ndjson`,
gitignored alongside the existing `balancing_runs*/` entries.

### 3.2 Envelope

Every line carries exactly five envelope fields, kept short because they repeat on
every record:

| Field | Meaning |
|---|---|
| `v` | schema version integer — bump on any breaking field change |
| `e` | event type |
| `sid` | session id (one process invocation) |
| `rid` | run id (one campaign attempt) |
| `lvl` | campaign level index |
| `t` | `levelTime` in seconds, monotonic within a level |

The **level fingerprint** does not repeat per line — it lives once in `levelStart`,
and it reuses identifiers that already exist rather than inventing a new one:
`astHash` (parsed source + campaign name), `balanceHash`
(`computeBalanceHash(map, SIMULATION_BALANCE)`, `balanceHash.ts:114` — the enemy
roster plus the simulation constants in force) and `seed` (the gameplay seed).
Together these answer "same repo, same commit, same constants, same universe?"
without a new mechanism, and `balanceHash` in particular already exists precisely
to catch the case where a constant moved but no source byte did.

### 3.3 Events

Fields marked † exist **only** to make a named metric computable; if that metric is
dropped, the field goes with it.

**`levelStart`** — once per level. Makes the log self-contained, so uncollected-loot
and unrealised-drop analysis needs no re-run of the generator.

```
file, astHash, balanceHash, seed, difficulty, campaignLevelIndex,
walkableTiles†,                       // enemy/HP per unit area (§2.4)
ownedWeapons[], startHealth, startSwap, startAmmo{bullets,rockets,smg,gas},
enemies[]:   {eid, arch, maxHp, x, y}        // roster; unrealised drops (§2.2)
prePlaced[]: {pid, kind, amount, x, y}       // pre-placed budget (§2.2)
```

**`shot`** — one per trigger-pull.
`w` (weapon index), `pellets`†, `ammoAfter`, `forcedMelee`, `dist`† (range to the
crosshair target, or null).
`pellets` and `dist` exist for `pelletHitRate` and `hitRateByDistance` (§2.1); note
that separating this from `hit` is what fixes the >100% accuracy problem in §7.4.

**`hit`** — one per pellet that connects.
`w`, `eid` (or `mine`), `dist`†.

**`damageDealt`** — one per HP change on an enemy.
`w`, `eid`, `arch`, `amt`, `hpBefore`†, `hpAfter`†, `splash`†.
`hpBefore`/`hpAfter` exist solely for `overkill` (§2.1) — on the killing blow,
`hpAfter` is the pre-clamp negative value, which `engine.ts:4462-4467` currently
computes and immediately discards.

**`kill`** — `eid`, `arch`, `maxHp`, `w`, `forcedMelee`, `aggroAt`† (closes the TTK
window without needing the separate `ttkRecords` array).

**`damageTaken`** — `src` (the six existing `DamageSource` values), `arch`† (null
for traps/hazards/self-splash), `amt`, `healthAfter`, `swapAfter`.
`arch` is new and is what makes `damageTakenByArchetype` (§2.3) possible at all.

**`lootDropped`** — at spawn time, so drops that are never collected stay visible.
`did`, `kind`, `amount`, `x`, `y`, `fromEid`†, `fromArch`†, `elite`†.

**`lootCollected`** — `did` or `pid`, `kind`, **`source`** (`preplaced` | `drop`),
`fromArch`† (drops only), `amount`, `granted`†, `wasted`†.

> **`source` and `fromArch` are the two fields that must be right from day one.**
> Without `source` the pre-placed/dropped split of §2.2 is not reconstructible after
> the fact; without `fromArch` the self-sustain ratio — the most useful number in
> the whole catalog — can only ever be predicted, never measured. Both are cheap:
> the origin split already exists in the collect path
> (`recordLootCollected(state, origin, kind, amount)`, `engine.ts:1285`), and
> `pushLootDrop(drop, enemy)` (`engine.ts:3591`) already receives the dropping
> enemy, so the archetype is in scope with no new plumbing.
>
> `granted`/`wasted` split the amount that actually applied from the amount lost to
> a cap — needed for `overflow` (§2.2), and only ever nonzero for health and swap,
> since ammo has no cap.

**`weaponSwitch`** — `from`, `to`, `reason` (`manual` | `granted` | `autoEquip`).

**`weaponGranted`** — `w`, `via` (`secret` | `eliteBonus` | `missChance` |
`normalBonus` | `forcedUnlock`), `duplicate`† (whether it fell back to an ammo
top-up).

**`playerDeath`** — `src`, `arch`†, `t`.

**`levelEnd`** — `outcome` (`cleared` | `died` | `abandoned`), `killCount`, `score`,
`healthEnd`, `swapEnd`, `ammoEnd{}`, `distanceTraveled`,
`enemiesAlive[]: {eid, arch, maxHp}`†, `prePlacedUncollected[]: {pid, kind, amount}`†.
The two † arrays are the "nominal vs actual budget" sweep — together they give the
gap between what the generator placed and what the run actually had access to.

### 3.3a Verifying the log — `npm run verify:event-log`

`scripts/verify-event-log.mjs` runs every consistency check over a log
directory and exits non-zero on failure, so this is repeatable rather than a
spot-check someone remembers to do. It is deliberately a script: "is the
telemetry right?" was asked three times, and two of those turned up a real
defect *after* an ad-hoc check had already passed. Ad-hoc checks answer the
question you thought to ask.

Three tiers, weakest to strongest, and the script says which is which:

1. **Structural** — parseable lines, nothing dropped by the buffer cap,
   envelope complete on every record.
2. **Conservation** — `hpBefore - amt == hpAfter`; spawned enemies equal kills
   plus survivors per level-visit; every collected drop references a real spawn.
   Catches corruption, not a consistently wrong value.
3. **Cross-site agreement** — an enemy's archetype is emitted independently at
   five call sites, and all five must match the roster `levelStart` recorded.
   Catches a mislabel at one site, not one shared by all.

**Verified against injected faults, not just against good data.** Three
mutations — an archetype relabelled on one `lootDropped`, seven HP added to one
`hpAfter`, one `kill` removed — are each caught and named:
`lootDropped.fromArch agrees with the roster: 1 failure(s), e.g. {"eid":9,
"said":"normal","roster":"edgeCase"}`. A checker that has only ever seen
passing input is not known to check anything.

A check that never ran is printed as `0` rather than omitted, since a silently
absent row reads as a pass — `targetArch` only exists in logs captured after
that field was added.

### What external validation exists

Internal consistency cannot tell you the roster itself is right; every site
agreeing on the same wrong answer looks identical to every site being correct.
Two independent sources close that:

- **The roster, against a separate runtime.** `npm run balancing:budget --json`
  generates the same campaign through Node/esbuild rather than the browser.
  Measured on the demo campaign: the archetype-and-HP multiset is **identical on
  all 12 captured levels**, difficulty scaling included, computed by two
  different code paths.
- **`targetArch`, against what was actually hit.** For a single-pellet weapon
  the pellet flies dead-centre, so the crosshair archetype should be the
  archetype hit: measured **99.9% over 1,135 single-pellet shots and 100% over
  749 multi-pellet ones**. The single outlier is a gdb shot recorded against an
  Edge Case that landed on a regular — one frame of staleness, since
  `this.target` is set during the previous frame's render and Edge Cases cross
  the reticle at 3.74 tiles/sec.
- **The counters, against the events.** Shots, hits and kills match exactly for
  all seven weapons and every damage source matches to the unit — two
  independent recording paths in the same run.

### What the log does not record

Cross-checked against the aggregate counters over a 4-attempt Gamer/hard capture,
since the two are recorded by independent code in the same run: **shots, hits and
kills match exactly for all seven weapons, and every damage source matches to the
unit.** Internal conservation also holds — `hpBefore - amt == hpAfter` on all 2,649
damage records, spawned enemies equal kills plus survivors on all 64 level-visits,
all 528 kills pair with a lethal damage record, no drop was collected without a
matching spawn, and nothing was lost to the buffer cap.

**One real data-loss bug was found this way, after the checks above had already
passed.** Three `stuck` return paths in `playRun` returned before
`pullLevelResult`, so that level's buffered events were never drained and were
discarded with the page. The balanced `levelStart`/`levelEnd` counts *hid* it: a
lost level drops both records together, so the totals stay consistent. Proven in
both directions by forcing stuck runs with
`CODEENSTEIN_TELEMETRY_TUNING='{"MAX_TICKS_PER_WAYPOINT":1}'` — with the fix, two
stuck runs yield 2 `levelStart`, 11 shots, 2 kills and their loot; without it, **no
event file is written at all**. Fixed by `drainEventsInto`, which drains without
pulling a snapshot, since a stuck level has no usable snapshot and must not enter
`levelSnapshots`.

The bias mattered more than the volume: a stuck run's last level is exactly the
level that caused the problem, so the events most worth reading were the ones being
dropped. Anything about wedges or hard-level failures collected before this fix is
missing its most interesting level.

Three gaps remain, all deliberate and all worth knowing before reading a number:

- **`weaponSwitch` and `weaponGranted` are never emitted.** They appear in the
  schema above and in §7's blocked-metrics table; nothing currently depends on them.
- **Multiplayer emits no events at all.** `run-balancing-telemetry-multiplayer.mjs`
  never sets `?eventLog=1` and never drains, so the whole event stream is
  single-player only. The engine side would work unchanged — every emission point
  is shared — but each peer would record its own copy, so a reader would need to
  de-duplicate by roster id first.
- **A splash weapon emits no `hit`.** `fire()` returns before the pellet loop for
  `isRocket`, so a rocket's damage arrives later as `damageDealt` from the blast
  and never as a per-pellet hit. Ghidra accordingly showed 17 shots, 15 damage
  records and 0 hits — a *structural* zero that an earlier version of the balance
  review printed as though it measured accuracy. `shot.splash` now flags it and
  `weaponUsage` returns `null` rather than a rate. Emitting hits from the blast
  would not fix it: one round can strike several enemies, which is the same
  >100% class of error that separating `shot` from `hit` fixed for the shotgun.
  Judge splash weapons on damage and kill share.

### 3.4 Buffering, gating and crash behaviour

**Gate: the existing one, unchanged.** Events are pushed behind the already-computed
`this.telemetryEnabled` boolean (`engine.ts:1037`). No new flag, no new branch in
shipped play, and no possibility of this reaching a real player's session.

**Every emission point is event-rate, not frame-rate.** Nothing is added to
`simulate()` (`engine.ts:2323`), `render()` (`:2649`), `renderNormalFrame()`
(`:2831`), `renderScene`, `handleMovement`, `updateEnemyAi`, `collectLoot` or any
other per-frame function. The emission sites are exactly:

| Event | Site |
|---|---|
| `shot` | `fire()` — `engine.ts:4332` |
| `hit`, `damageDealt`, `kill` | `damageEnemy()` — `engine.ts:4434` |
| `damageTaken`, `playerDeath` | `damage()` — `engine.ts:3732`, `killPlayer()` — `:3782` |
| `lootDropped` | `pushLootDrop()` — `engine.ts:3591` |
| `lootCollected` | the loot-drop branch at `:3504` and the static-pickup branch at `:3517` |
| `weaponSwitch`, `weaponGranted` | the weapon-request handler and `grantOrTopUpWeapon` |
| `levelStart`, `levelEnd` | engine construction and `endGame()` — `engine.ts:4589` |

**So the render-loop-adjacent diff for this work should be empty.** That is a
design property, not an aspiration — if a later step needs a per-frame sample,
that is the moment to stop and re-read `playerStats.ts:19-28`.

**Buffer.** A plain array on the engine, preallocated at construction only when
telemetry is enabled. Objects are pushed, not serialised — `JSON.stringify` happens
in Node, off the browser's clock entirely.

**Flush.** A new `__codeensteinTestHooks.drainEvents()` returns the buffer and
resets it, mirroring the existing `getTelemetrySnapshot()` hook (`engine.ts:1162`).
The bot drains at every level boundary and once more at run end; Node
`appendFileSync`s the lines. Draining at a level boundary — not on a timer — keeps
the flush off any hot path and bounds the buffer at one level's events.

**On crash:** everything up to the last drain is on disk. The current level's
undrained tail is lost. That is the deliberate trade — the alternative, flushing
per event across the Playwright boundary, would cost a round-trip per shot. A
partially-written final line is discarded by the reader, which is the whole reason
for NDJSON over a JSON array.

**Volume sanity.** A campaign level runs roughly 60–200 s with a few hundred kills'
worth of activity; at ~10–40 events/second of combat this is single-digit MB per
run uncompressed. Not a concern, but the reader should stream lines rather than
`JSON.parse` a whole file.

## 4. The offline solver

`scripts/lib/levelSolver.mjs` (pure, unit-testable, no I/O) plus
`scripts/report-level-budget.mjs` (CLI, formatting, exit codes) — the same split as
the existing `abReport.mjs` / `report-balancing-ab.mjs` and
`profileSeparation.mjs` / `report-profile-separation.mjs` pairs.

### 4.1 How it hooks into the generator

It does not reimplement anything. `scripts/lib/loadEngineModules.mjs` already
esbuild-bundles the real `src/parser/registry.ts` and `src/map/mapGenerator.ts` for
plain Node — including the `?url` grammar-wasm rewrite — and
`verify-demo-campaign.mjs` and `generate-default-highscore.mjs` Phase 0 already use
it to produce real `GameMap`s headlessly. The solver walks a directory, calls
`parseFile` then `MapGenerator.generate()` per file, and analyses the result.

`scripts/lib/staticLevelAnalysis.mjs`'s `analyzeStaticLevel(map, route)` already
computes enemy counts, per-category tallies, walkable tiles, density and a
pre-placed ammo summary. The solver **extends** that rather than replacing it — the
existing function keeps its current callers and shape.

### 4.2 Single source of truth for constants

This is a hard constraint, and this repo has already been bitten by ignoring it —
see §7.3. The rule: **the solver imports every number from the module that owns it.**

`loadEngineModules()`'s entry stub gains re-exports from `src/engine/loot.ts`
(weights, drop amounts, `REGULAR_KILL_NO_DROP_CHANCE`,
`NORMAL_KILL_WEAPON_DROP_CHANCE`, `ELITE_BONUS_WEAPON_DROP_CHANCE`),
`src/difficulty.ts` (`DIFFICULTY_MULTIPLIERS`) and `src/engine/ammo.ts`
(`startingAmmo`, `AMMO_META`). It already re-exports the real `WEAPONS`. All of
these are pure data modules with no DOM dependency, so bundling them costs nothing
— exactly the argument `loadEngineModules`'s own doc comment already makes for
`UNLOCKABLE_WEAPONS`.

**The one gap: `src/engine/enemyAi.ts`'s combat constants are module-private.**
`ATTACK_DAMAGE`, `ATTACK_COOLDOWN`, `FIRE_COOLDOWN_MIN/MAX`, `AGGRO_RADIUS`,
`RANGED_RANGE`, `MOVEMENT_SPEED`, `ELITE_DAMAGE_MULTIPLIER`,
`EDGE_CASE_DAMAGE_MULTIPLIER`, `EDGE_CASE_SPEED_MULTIPLIER` — none are exported, so
`incomingDps`, `survivalWindow` and `threatScore` (§2.3, §2.4) cannot be computed
without exporting them. Copying them into the solver is not an option; that is
precisely the failure §7.3 documents.

Exporting them is a two-line change, but it has a tail: five of those constants are
the ones `SIMULATION_BALANCE`'s comment (`engine.ts:300-306`) already names as
uncovered, and the honest move once they are exported is to fold them in — which
**moves `balanceHash` and invalidates every shipped replay**, i.e. a multi-hour
`defaultHighscore.ts` regeneration. So the two halves are sequenced apart:
exporting is early and cheap, folding into `SIMULATION_BALANCE` is last, after every
other simulation change has landed. That ordering is the existing rule from *"Land
every simulation change first, then generate once"* above, and the 2026-08-02 layout
rework already paid for learning it.

### 4.3 What it computes

Per level, from the generated `GameMap` plus the constants:

- **Enemy budget** — count and HP total by archetype, DPS total, per walkable tile.
- **Loot budget, three ways** — pre-placed (walk `map.ammoPickups`, convert to
  damage via `damagePerAmmo`), potential drops (expected value over the weight
  tables, gated by which weapons are owned at that campaign position, times
  `ammoDropRate`), and combined; health likewise.
- **Per-weapon TTK and shots-to-kill** against every distinct HP value on the level.
- **`selfSustain` per archetype** and **`clearRatio` per source**.
- **The complexity→HP curve and its outliers**, including the hard-failure check:
  any single enemy whose HP exceeds the level's total obtainable damage.

Across a campaign it carries ammo forward the way the engine does (`startingAmmo`
only applies where there is no carryover), so the ratios are a running balance
rather than eight independent levels.

Difficulty is a parameter — the same level solved at easy/normal/hard gives three
budgets, because `ammoDropRate` and `hp` both move.

### 4.4 The one analytic limit, stated plainly

**Per-shot hit probability is not cleanly computable offline.** The Cone of Fire
deviates by `(rng()*2-1) × rangeFraction³ × maxConeDeviationPx` in *screen pixels*
against the per-column z-buffer (`engine.ts:4268-4270`), so whether a pellet
connects depends on the raycast geometry of the specific tile the enemy is standing
on and the sprite's projected width at that distance.

So the solver reports **perfect-accuracy TTK and perfect-accuracy `clearRatio` as a
lower bound on cost**, labelled as such in the output, and leaves real hit rate to
the empirical half (§2.1). A level whose *perfect-accuracy* `clearRatio` is below
1.0 is definitively unclearable; a level above 1.0 is not thereby proven clearable.
That asymmetry is useful and honest, and it is a better contract than a fabricated
accuracy coefficient that would quietly mean nothing.

(There is a partial in-engine model already — `engine.ts:1794-1796` computes a
worst-case deviation for the bot's effective-range estimate. It is a *bound*, not a
probability, and it is not a substitute.)

### 4.5 The corpus

`scripts/fetch-balancing-corpus.mjs`, shaped like the existing
`fetch-online-wads.mjs`: idempotent (skip any destination that already exists),
gitignored destination, no credentials. One deliberate difference — **it degrades
on failure instead of `process.exit(1)`**. That exact failure mode is already
logged against `fetch-online-wads.mjs` in `notes`, where it takes `npm run dev` and
`npm run build` down with it; there is no reason to reproduce it.

Selection criteria: pinned commits (so a corpus run is reproducible), permissive
licences, and coverage of both axes that matter — size and language, chosen from
what the parser already supports (bash, C, C++, C#, Go, Java, JavaScript, Objective-C,
PHP, Python, Ruby, Rust, Scala, TypeScript).

| Bucket | Target | Why |
|---|---|---|
| tiny | 1–5 files, a few hundred LOC | the degenerate case — does a 2-room level even have a viable budget |
| small | ~20 files, one language | the common "someone points it at their side project" case |
| medium | ~200 files, mixed | the case the demo campaign approximates |
| large | 1000+ files | where the per-level ratios diverge most, and where an unbounded Elite is most likely |
| pathological | a file with one very high-complexity function | the §7.1 case, deliberately included as a fixture rather than hoped for |

The pathological entry should be a **committed fixture** under `scripts/fixtures/`,
not a fetched repo — it is a regression test for the outlier check, and it must not
depend on some upstream project keeping its worst function.

## 5. What the reports look like

Every number below is real. §5.1 and §5.2 are computed from the constant tables in
§1 alone, so they held before anything was built; §5.3 and §5.4 are abridged output
from the shipped tools.

### 5.1 Worked example — self-sustain (real numbers, normal difficulty)

Expected ammo value of one kill's drop, as a fraction of the damage that kill cost.
Weights from `NORMAL_LOOT_WEIGHTS` with `health` filtered out
(`healthHandledSeparately`), times the 80% `REGULAR_KILL_NO_DROP_CHANCE` hit rate,
valued through `damagePerAmmo`.

```
Regular enemy, all weapons owned          cost 250 dmg   →  self-sustain 0.56
Regular enemy, pistol + shotgun only      cost 250 dmg   →  self-sustain 0.23
Edge Case,     all weapons owned          cost  12 dmg   →  self-sustain 11.6   ⚠
Elite (c=40),  player damaged             cost 2000 dmg  →  self-sustain 0.00   ⚠
Elite (c=40),  player at full health      cost 2000 dmg  →  self-sustain 0.10   ⚠
```

**Measured against real generated levels** once the solver shipped, these predictions
held and sharpened. On the demo campaign (normal): Edge Cases 8.1–13.8×, regular
enemies **above 1.0 on 11 of 17 levels** peaking at 2.33, Elites 0.00. Across
ripgrep's first 25 levels the regular figure runs **0.67–6.74** — real repositories
are full of trivial functions, which floor at `HP_PER_COMPLEXITY` (25 HP) while
still paying a full-sized drop, so the more ordinary code a repo contains the more
free ammo it prints. Carried ammo climbs from 10,456 to 53,293 damage over those 25
levels without ever being spent down.

Three things fall straight out, and all three are actionable:

- **Edge Cases are a self-sustain engine at 11.6×.** They take the regular drop
  path with no special-casing (§1.3), so a 12 HP nuisance yields the same expected
  loot as a 250 HP regular enemy. Corridor dressing places 1–3 of them per breakup
  room. Whatever ammo scarcity the rest of the design is aiming for, this bypasses
  it. The fix is a drop-scaling term tied to `maxHp`, or excluding Edge Cases from
  the ammo roll the way `health` already is.
- **Elites are a pure ammo sink.** The guaranteed drop is *health* unless you are
  already at full, so a 2000 HP fight typically returns no ammo at all. That is
  defensible as design — a boss should cost something — but it should be a
  deliberate choice, and right now it is a side effect of `dropEliteLoot`'s
  health-first branch.
- **Early game is 2.4× harsher than late game**, because `rollLoot` filters out
  `rockets`/`smg`/`gas` until the matching weapon is owned and redistributes their
  share across a much smaller table. That is the intended behaviour
  (`loot.ts:73-77`), but nothing currently measures its size.

### 5.2 Worked example — weapon efficiency (real numbers)

```
weapon           dmg/trigger   ammo   dmg/ammo   dps     pool
echo pistol           22        1.0      22.0    147     bullets
Regex Shotgun        175        4.0      43.8    206     bullets   ← 2.0x the pistol, same pool
gdb                   12        1.0      12.0    133     smg
ghidra               150        1.0     150.0    136     rockets
Friday Hotfix         48        2.5      19.2    480     gas
SIGKILL Knife         40         --        inf   267     --
Toolchain             80         --        inf   229     --
```

*Perfect accuracy — see §4.4. Melee dps assumes contact is maintained; the knife
defines no `fireIntervalSec` and is semi-auto, so its figure additionally assumes
mashing at the engine's 0.15 s default floor, while Toolchain genuinely fires
continuously while held.*

### 5.3 Real output — per-level budget, demo campaign at normal

`npm run balancing:budget`, abridged to the budget table:

```
level  file                                 enemies   HP tot   ammo dmg (carry/pre/drop)      ratio (nofarm/comb)
    1  main.c                                   11      550      3894 /   2363 /   1243      11.38 /  13.63
    2  stage02_bootstrap.sh                     13      640      5706 /    481 /   1469       9.67 /  11.96
    7  stage07_service.rb                       13      448      9668 /      0 /   1768      21.58 /  25.53
   12  stage12_render_engine.cpp                18     2659     11597 /   1966 /   2864       5.10 /   6.18
   15  stage15_god_object.java                  13     4803     11542 /   1050 /   1853       2.62 /   3.01
   16  stage16_hardware.h                       11      228      7789 /   1344 /   1787      40.06 /  47.89
   17  stage17_the_monolith.php                 77     8883      8905 /   3994 /  12467       1.45 /   2.86

  X  combined clear ratio below 1.0 -- NOT clearable even counting every drop
  !  combined clear ratio below 1.2 -- no margin for a missed shot
     'nofarm' counts only what you carried in plus what is on the floor.
```

Two things the demo campaign shows immediately. Ratios run **1.45x to 47.9x** —
nothing is close to starved, which is the same conclusion the 450-run campaign
reached from the other direction, and it is why `loot.ts`'s drop amounts were cut
~30%. And level 16 (`.h`, a bonus level) sits at 47.9x while level 17 sits at 2.86x
with 77 enemies, so the curve's shape is set almost entirely by what the source
files happen to contain.

The remaining sections (`## Threat and survival`, `## Self-sustain by archetype`,
`## Enemy HP outliers`) print alongside it, and `--all-difficulties` adds a
comparison table.

### 5.4 Real output — the event report

`npm run balancing:events`, over a 3-attempt, 6-level capture (2136 events). This
is the half that could not exist before the log did:

```
| weapon        | pulls | pellets fired | pellet hits | pellet hit rate | pulls that hit | kill share |
| echo pistol   |   261 |           261 |         156 |           59.8% |          59.8% |      26.4% |
| Regex Shotgun |    39 |           273 |         114 |           41.8% |          87.2% |      14.2% |
| gdb           |   193 |           193 |         101 |           52.3% |          52.3% |      23.6% |
| Friday Hotfix |     7 |            42 |          11 |           26.2% |          42.9% |       2.0% |

Hit rate by engagement distance
| Regex Shotgun | 0-2  |  35 | 27 | 77.1% |
| Regex Shotgun | 2-4  | 154 | 59 | 38.3% |
| Friday Hotfix | 0-2  |  18 | 11 | 61.1% |
| Friday Hotfix | 2-4  |  24 |  0 |  0.0% |

Overkill (damage wasted on the killing blow)
| SIGKILL Knife |  45 kills | mean 24.8 | max 38 |
| Toolchain     |   5 kills | mean 60.2 | max 68 |

reliance on drops                     79.6%
health pickups that granted nothing   19 of 50
drops spawned by archetype            edgeCase 93, normal 70

Self-sustain, measured
| normal   | 61 kills | mean HP 119 | ratio  1.09 |
| edgeCase | 87 kills | mean HP  13 | ratio 10.57 |
```

Four readings worth acting on, none of which the aggregate counters can produce:

- **The measured self-sustain matches the solver's independent prediction.**
  Observed 1.09 and 10.57; predicted from the drop tables alone, 0.76–2.33 and
  8.1–13.8. Two models built on the same constants but from opposite directions —
  one from the weight tables, one from the rolls that actually happened — agreeing
  is what makes the Edge Case finding trustworthy rather than an artifact.
- **Friday Hotfix is dead content.** 2.0% of kills, 0.5% of damage, and a hit rate
  that goes 61.1% → **0.0%** between the 0–2 and 2–4 tile buckets. Its 3.5-tile
  `maxRange` bites well inside the range the bot actually fires at.
- **The shotgun's cone is doing exactly what it was designed to**, 77.1% → 38.3%
  across the same boundary — now measured rather than asserted.
- **Toolchain wastes 60.2 of its 80 damage per kill.** It is a safety net, so
  overkill is expected; the size of it is not, and it is the first evidence that
  the 2x-the-knife damage buys very little against this roster.

## 6. Implementation plan — what shipped

Ordered smallest-useful-first, each step its own commit, each leaving the build
green, the suite passing and the telemetry path off by default.

| Step | What | State |
|---|---|---|
| 0 | `levelSolver.mjs` + `report-level-budget.mjs` + `balancing:budget`. No engine change at all — reuses `loadEngineModules` and extends `analyzeStaticLevel`. | **done** |
| 1 | `combatConstants.ts`: lift the enemy/player/projectile scalars out of `enemyAi.ts`, `projectiles.ts`, `rockets.ts` and `engine.ts` into a dependency-free module the solver can bundle. Unlocks incoming DPS, survival window, threat score. | **done** |
| 2 | `?seed=` / `CODEENSTEIN_TELEMETRY_SEED` — pin the gameplay seed so loot rolls are reproducible. | **done** |
| 3 | Fix `ROCKET_TRAVEL_SPEED` and pin every bot mirror against the engine with `constantMirrors.test.mjs`. | **done**, see §7.3 for the gate |
| 4 | `fetch-balancing-corpus.mjs`, recursive level collection via the real `workspace.ts` helpers, and the committed pathological fixture. | **done** |
| 5 | `events.ts` + `drainEvents()` hook + NDJSON writer; `levelStart`, `damageDealt`, `kill`, `levelEnd`. | **done** |
| 6 | The rest: `shot`, `hit`, `damageTaken`, `playerDeath`, `lootDropped`, `lootCollected`. | **done** |
| 7 | `eventMetrics.mjs` + `report-balancing-events.mjs` — derive the empirical catalog back out of the log. | **done** |
| 8 | Fold the Step-1 constants into `SIMULATION_BALANCE`, closing the gap its own comment documents. | **not done, deliberately** |

**Step 8 is left undone on purpose.** Folding those constants into the hash moves
`balanceHash`, which invalidates **every shipped replay** and demands a multi-hour
`defaultHighscore.ts` regeneration. That is a release-shaped decision, not a
refactor, and the existing rule above — *land every simulation change first, then
generate once* — says it goes last. The constants now live somewhere it can be done
cheaply when someone decides to; nothing else depends on it.

**The render-loop diff for steps 5 and 6 is empty.** Not "small" — empty. No
emission point sits in `simulate()`, `render()`, `renderNormalFrame()`,
`handleMovement`, `updateEnemyAi` or `collectLoot`'s per-frame scan. That was the
design property §3.4 committed to, and it is the one worth checking on any future
change to this path.

## 7. Open questions and blockers

### Findings from the baseline audit

**7.1 — Elite HP has no clamp, and this is the highest-value thing the solver will
find.** `hp = complexity × 25 × 2` with `count = 1` for any `complexity ≥ 40`
(`enemies.ts:93-100`) is linear and unbounded. A complexity-200 function produces a
**10,000 HP** enemy dealing double damage: 15,000 on Hard, 37,500 in 4-player coop.
Its room is capped at 18 tiles a side (`geometry.ts:21-27`), so the arena does not
grow with it. Regular packs self-limit — per-member HP asymptotes to 250 — but
Elites do not. This cliff has already caused one live incident: `enemies.ts:22-37`
records a complexity-44 function producing 4400 HP and killing the bot 12/12 runs,
and the fix lowered `ELITE_HP_MULTIPLIER` 4→2 rather than adding a bound.

**Measured, and it corrected this entry's original claim.** The committed fixture
`scripts/fixtures/pathological-repo/` holds a complexity-**805** function, which
becomes a **40,250 HP** Elite. As *level 1* the solver reports it killable — because
`startingAmmo` derives the player's bullets from the level's own total enemy HP
(`ammo.ts:86-94`), so an unbounded Elite quietly funds its own counter-play. That
compensation exists only at campaign position 1. From level 2 on, carryover replaces
the starting formula (`engine.ts:1179-1182`) and **nothing scales with what the level
contains**: the same function at position 2 is **31.9× all obtainable damage on its
level**, a clear ratio of 0.03. The fixture therefore ships a trivial level that
sorts first, so it pins the case that actually bites.

**Open question: should there be a cap, and against what — total obtainable damage
on the level, or an absolute ceiling?** A cap against obtainable damage is
self-balancing but makes HP depend on pickup placement, which currently it does not.
Note the measurement above narrows the question: the danger is not "a big Elite", it
is "a big Elite anywhere except level 1".

**7.2 — Drops are seeded but not reproducible.** Map generation is fully
deterministic and content-addressed. Gameplay randomness, including every loot roll,
runs through one seeded `mulberry32` stream — so drops *are* reproducible given a
seed. But the seed comes from `randomSeed()` (`main.ts:2569`) and **nothing can pin
it**: no UI field, no CLI flag, no env var in any balancing runner. So today,
"same repo + same seed + same version = same level" holds for the *level* and not
for the *run*. Step 2 fixes it.

**7.3 — A mirrored constant had already drifted, exactly as predicted — and the
gate for fixing it turned out to be unrunnable.**
`scripts/lib/combatPolicy.mjs:300` defines `ROCKET_TRAVEL_SPEED: 5` with a comment
saying it mirrors `projectiles.ts`'s `PROJECTILE_SPEED` — but it is used at
`combatPolicy.mjs:1120` to model the **player's own ghidra rocket** flight time, and
the real player-rocket speed is `ROCKET_SPEED = 18` (`rockets.ts:20`). The constant
is named after the rocket and sourced from the enemy bolt. The bot overestimated
rocket flight time by **3.6×**, so `rocketDetonationDistanceAfterClosing` reported
threats as far closer at detonation than they would be, making the bot more
rocket-shy than the game warrants. Fixed, and every mirrored weapon stat and
engine scalar is now pinned against the real module by
`scripts/lib/constantMirrors.test.mjs` (verified red against the old value). `doc/dev/adding-a-weapon.md:105` already
warns that "nothing links the two, and nothing fails when they drift" — this is that
failure, realised. It is also the concrete argument for §4.2's rule.

**The A/B that should have gated the fix cannot see it, and finding that out is the
more useful result.** The documented recipe (`LEVEL_LIMIT=8`, the constant flipped
via `CODEENSTEIN_TELEMETRY_TUNING`) was set up and then abandoned once the event
log answered a cheaper question first: *does the bot ever fire a rocket at all?*
Measured with `?eventLog=1` on a **Pro** run — the profile whose `weaponPriority`
**leads with ghidra** — reaching level 12 across four attempts:

| | |
|---|---|
| ghidra owned from | level 8 (forced unlock), 4 rockets in the pool |
| shots fired, levels 1–12 | 1961 |
| **ghidra shots** | **0** |
| gdb shots over the same span | 1102 |

So `rocketDetonationDistanceAfterClosing` — the only consumer of
`ROCKET_TRAVEL_SPEED` — never executes in a single-player bot run. The A/B would
have come back "no significant difference", and that would have meant nothing: the
branch under test never ran. One scoped capture settled it instead of two hours of
A/B wall clock.

Two consequences:

- **The fix is correctness-only and cannot be regression-tested by behaviour**, so
  `constantMirrors.test.mjs` is the whole guard — which is why it pins every
  mirrored value rather than only this one.
- **Ghidra is dead content for the bot**, by the same threshold §2.1 defines. Note
  the fix should have made it *less* rocket-shy, and the measurement above was
  taken *with* the fix already in — so something else gates the choice, in
  `scoreRangedWeapon`'s ammo-economy or self-harm terms against a 4-rocket
  reserve. Worth its own investigation; not this one.

**7.3a — Why the bot never fires ghidra: root-caused, and one fix attempt failed.**
Three gates stack, and they are not equally to blame.

| # | Gate | Effect |
|---|---|---|
| 1 | `rocketAimUnsafe` hard-excludes ghidra below `ROCKET_SAFE_DISTANCE` (4 tiles), *before any score is computed* | The bot fights at a **median of 3.64 tiles** — measured over 4,825 aimed shots. Only 46.9% of shots are at ≥4 tiles, 36.3% at ≥5 (`ROCKET_CLUSTER_MIN_DIST`), and **0.7% at ≥8**, where self-harm risk reaches zero. |
| 2 | `SELF_HARM_PENALTY_SEC = 25`, scaled by risk | `scoreRangedWeapon` is denominated in seconds-to-kill and a real kill takes 1–3s. A 25s penalty dominates any comparison the moment risk is nonzero: at 5 tiles ghidra scored **21.0 against the pistol's 1.3**. |
| 3 | The scorer models ghidra as single-target | Its single-target DPS (136) ties gdb's (133), so the model sees a slower, scarcer, self-damaging weapon with no upside. Splash — its entire reason to exist — has no term. |

**The fix attempt, and why it is not in the tree.** Gates 2 and 3 were addressed
(`SELF_HARM_PENALTY_SEC` 25→5; a `ROCKET_MAX_EFFECTIVE_TARGETS` splash divisor;
the blanket "never rocket an Edge Case" guard made cluster-aware), both tied to one
constant so the A/B was a single-binary flip. Unit-level the change worked exactly
as intended — `pickRangedWeapon` began returning ghidra for clustered regulars and
for clustered Elites, and left lone weak targets alone.

**In play it did nothing.** A/B on Gamer/hard, 8 attempts a side, all 17 levels:

| | base | cand |
|---|---:|---:|
| ghidra shots | 2 | **1** |
| ghidra kills | 0 | 0 |
| `selfRocket` damage | 0 | 0 |
| deaths (all levels) | 7 | 8 |

Reverted. The reason is gate 1, which fires first and which neither change touched:
the bot plays at knife range, so ghidra is excluded from over half of all
engagements before scoring ever runs. Fixing the scorer while the hard gate does
the excluding is fixing the wrong layer — which is only obvious once engagement
distance is measured, and that took the event log.

**A second attempt also failed, and the pair of failures is the useful record.**
The follow-up widened three more constants together — `ROCKET_SAFE_DISTANCE` 4→3
(the engine's real `ROCKET_BLAST_RADIUS` is 2.6, past which the firer takes
*literally zero* damage, so 4 sat 1.4 tiles beyond any danger),
`ROCKET_CLUSTER_MIN_DIST` 5→4, plus the scoring fix from the first attempt. Before
launching, a probe confirmed the two sides genuinely differed: base and candidate
picked different weapons in the 4–4.5 tile band.

| | base | cand |
|---|---:|---:|
| ghidra shots | 5 | 11 (of ~4,400 pulls) |
| ghidra kills | 1 | **0** |
| **min rocket firing range** | 4.95 | **5.13** |
| `selfRocket` damage | 0 | 0 |
| deaths / campaigns completed | 8 / 0 | 8 / 0 |

**The min firing range is the whole story: not one rocket was fired in the 4–4.5
band the change existed to open.** Reverted.

**Instrumented, and it refuted the remaining hypothesis too.** `shot` now carries
`targetArch` and `targetHp` alongside `dist`, and
`eventMetrics.mjs`'s `weaponChoiceByTarget` turns "what does the bot reach for,
against what, at what range" into a table. One 4-attempt Gamer/hard capture
settled in minutes what two 55-minute A/Bs could not:

| target | range | shots | weapons chosen |
|---|---|---:|---|
| normal | 4–7 | **826** | gdb 63%, pistol 34%, shotgun 3%, **ghidra 0%** |
| normal | 7–10 | 75 | pistol 55%, gdb 44%, ghidra 1% |
| elite | 4–7 | **5** | shotgun 100% |
| elite | 2–4 | 7 | Friday Hotfix 71%, shotgun 29% |
| elite | **0–2** | **87** | **knife 86%**, Toolchain 9%, Friday Hotfix 5% |

**The Edge Case guard was never the blocker.** At 4–7 tiles against `normal`
targets — the largest bucket in the capture — ghidra is chosen 0% of the time, and
that guard does not apply there at all. Both the fast-path's `!threat.edgeCase` and
the scoring-loop copy of it are irrelevant to why ghidra goes unused.

**The answer is in the Elite rows.** Of 99 shots taken at an Elite, **88% are
inside 2 tiles**, and 86% of those are the SIGKILL Knife. The bot closes to contact
on precisely the targets a rocket is for — so the range at which ghidra is legal is
a range at which it has already stopped shooting Elites. No constant fixes that:
it is what the profile's `engageRadius`, the route planner and the melee fallback
add up to.

That also re-frames §7.1's level-15 deaths. The bot is not dying because it lacks
firepower; it is dying because it walks up to two 3,500 HP enemies that deal double
damage and stabs them. `killsForcedByMelee` reads zero throughout — this is chosen
melee, not desperation.

**The methodological point, which is the durable part.** Two attempts have now been designed
off a synthetic probe of `pickRangedWeapon` and both were null, because the probe
supplies an idealised threat (a 4-strong cluster of non-Edge-Case enemies) that
real play rarely presents. The most likely remaining blocker is the cluster
fast-path's own `!threat.edgeCase` test — untouched by either attempt, and Edge
Cases are 62–78% of the roster on exactly these levels while moving 2.2× faster, so
they are usually the selected threat. But that is a hypothesis, and two hypotheses
have already failed.

The cheap way to settle it is to record the threat's archetype and distance on the
`shot` event (or a dedicated `weaponChoice` event carrying the rejected
alternatives). Then the question "what actually blocks ghidra, at what range,
against what" is a query rather than a guess — which is what the event log is for,
and what turned the engagement-distance question from an argument into a table.

Also worth stating plainly: it is entirely possible ghidra is simply the wrong
weapon for this bot. It fights at a 3.64-tile median; the weapon needs 4–5 tiles to
be safe *and* worth its ammo. Making it useful may be a change to how the bot
positions, not to how it scores weapons — and that is a much larger piece of work
than any constant.

Both reverted patches are preserved and are correct as far as they go.

**7.4 — Cross-weapon hit rate is not comparable today.** `recordShot` counts
trigger-pulls (`engine.ts:4349`); `recordHit` counts **pellets** (`:4371`). For the
7-pellet shotgun `hits/shotsFired` can reach 7.0, and `accuracyPct`
(`playerStats.ts:63`) is unclamped, so a shotgun-heavy run reports over 100%
accuracy. Harmless in shipped play only because `PLAYER_STATS_ENABLED` is `false`,
but `weaponEfficiency` in the balancing report reads the same ratio, so any
cross-weapon accuracy comparison drawn from it so far is wrong. §3.3's separate
`shot`/`hit` events fix it; the existing counters are left alone per the
alongside-not-instead rule, so **the old ratio stays wrong and should be read as
"pellets per trigger-pull", not accuracy.**

**7.5 — Pre-placed ammo does not scale with what it has to kill.** Placement is one
Bernoulli(0.22) trial per non-spawn room (`pickups.ts:46-63`), so it tracks *entity
count*. Enemies come only from `function`/`method` entities, so a file full of
classes and interfaces gets rooms and pickups but no enemies, while a file of dense
functions gets the same pickup rate against far more HP. Meanwhile `startingAmmo`
*does* scale with total enemy HP (`ammo.ts:86-94`) — but carryover overrides it from
level 2 on. **Open question: should pre-placed ammo scale with the level's enemy HP
the way starting ammo does?** The solver's `clearRatio (pre-placed)` column is
exactly the evidence needed to decide.

**7.6 — Terminology, for anyone reading the original brief.** "Enemies per
folder/file" — **a file is a level**; folders contribute only ordering
(`main.ts:2893`). Classes, interfaces and traits produce a room but no enemy;
globals become acid pools; only functions and methods produce enemies.

**7.7 — One `Math.random()` sits on the combat path.** `engine.ts:4456`,
`baseBloodCount` inside `damageEnemy`. Cosmetic particle count only, touching no
simulation state — but it is the only direct one in `engine.ts`, whose own comment
at `:715` says "Never `Math.random()` directly". Recorded so a future determinism
audit does not have to rediscover it is benign.

**7.8 — `countWalkableTiles` is module-private** (`engine.ts:4788`), and
`staticLevelAnalysis.mjs:17-31` already hand-mirrors it and `isWalkableTile`. The
per-unit-area metrics in §2.4 need one of the two. This joins the three
hand-maintained `isWall()` mirrors documented above — same failure mode, same fix.

### Blocked metrics

| Metric | Blocked by | Status |
|---|---|---|
| `incomingDps`, `survivalWindow`, `threatScore` | `enemyAi.ts` constants were module-private | **done** — moved to `combatConstants.ts` |
| `overkill` | `damageEnemy` discarded the pre-clamp negative HP | **done** — `damageDealt.hpAfter` |
| `selfSustain` measured (rather than predicted) | no dropping-archetype field | **done** — `lootDropped.fromArch` |
| `hitRateByDistance` | no distance recorded on a shot or hit | **done** — `hit.dist` |
| Cross-weapon hit rate | pellets and trigger-pulls were one counter | **done** — separate `shot`/`hit` events |
| Reproducible drop economy | gameplay seed could not be pinned | **done** — `?seed=` |
| Anything about repos other than `demo-campaign/` | no corpus | **done** — `balancing:corpus` |
| **`damageTakenByArchetype`** | melee damage arrives from `updateEnemies` already summed per player, and a bolt carries no reference to the enemy that fired it | **open** — needs both return shapes changed on the AI hot path; `damageTaken.arch` is `null` until then, deliberately not guessed |
| **`weaponSwitch` / `weaponGranted`** | the drop path grants through `lootApply.ts`, which has no engine reference | **open** — low value next to the above; switch *frequency* is a bot-policy signal, not a balance one |

### Genuinely open design questions

1. **Should Elite HP be capped, and against what?** (§7.1)
2. **Should Edge Cases drop like a 250 HP enemy?** The 11.6× self-sustain in §5.1
   says no; the counter-argument is that they are placed for pacing, not economy,
   and nerfing their drops makes corridor dressing feel like a chore.
3. **Should pre-placed ammo scale with enemy HP?** (§7.5)
4. **Should the solver's verdict gate anything?** It could exit non-zero on an
   unclearable level, which would make it usable as a check on a generated campaign
   — but "unclearable at perfect accuracy" is a hard failure while "clearable at
   perfect accuracy" proves nothing (§4.4), so only the failing direction is
   trustworthy as a gate.
5. **How much does multiplayer change the budget?** Elite HP scales with player
   count while loot does not obviously scale to match. Out of scope for the first
   solver, but the asymmetry is visible in `multiplayerScaling.ts` and deserves its
   own pass.
