# Balancing Telemetry Bot

A dev-only tool for automated balance review: three scripted bot profiles (Casual/Gamer/Pro) play the bundled `demo-campaign/` across all three difficulties, and their aggregated combat/economy/navigation stats get written to `balancing_telemetry.json` (gitignored) for a human — or an LLM balance-review pass — to spot HP-curve/drop-rate/pacing problems without replaying the whole campaign nine times by hand. **Not CI-wired.** Requires a locally running dev server (`npm run dev`, default `http://localhost:5173`).

The bot itself (`scripts/run-balancing-telemetry.mjs`) drives a headless Chromium session the same way `scripts/generate-default-highscore.mjs` does — a virtual clock, `window.__codeensteinTestHooks` polling, real `KeyboardEvent`s dispatched at the canvas, BFS route planning done entirely in Node before any browser launches. See that file's own doc comment for the low-level harness rationale.

## The three entry points

| Command | What it does |
|---|---|
| `npm run balancing:telemetry` | Full 9-combo run (Casual/Gamer/Pro × easy/normal/hard), 3 qualifying runs each, writes `balancing_telemetry.json`. Slow (up to 9 × unbounded attempts × up to 17 levels) — this is the "generate real data" entry point. |
| `npm run balancing:watch` | Opens one real, visible Chromium window per profile (Casual → Gamer → Pro by default), plays one full campaign attempt at watchable real-time speed, prints a summary, waits for Enter before the next profile. `scripts/watch-bot-sessions.mjs`; reuses the same profile definitions and per-attempt driving logic (`playRun`), not a separate bot. `npm run balancing:watch -- Gamer Pro` to pick a subset/order; `CODEENSTEIN_WATCH_DIFFICULTY=hard` to change difficulty. |
| `npm run balancing:scan` | The permanent automated bot-**behavior** regression check (distinct from balance-*data* review) — see [Anomaly scanning](#anomaly-scanning-npm-run-balancingscan) below. Run this before declaring any navigation/combat change to the bot script fixed. |

A run only "counts" for `balancing:telemetry`'s aggregate once it clears level 3 (proves it survived the unarmed early game) — a run that dies on level 1 or 2 is discarded entirely; a qualifying run keeps *all* its levels' data, 1–2 included.

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

## Matched-scale verification

Any change to navigation/combat/movement logic in `run-balancing-telemetry.mjs` needs more than "the scan came back clean" before it's trustworthy:

- **A/B against `git show HEAD:scripts/run-balancing-telemetry.mjs`** at the *same* `CODEENSTEIN_TELEMETRY_CONCURRENCY`/`_ATTEMPT_CAP`/`_LEVEL_LIMIT` that will ultimately be trusted. A small or low-concurrency sample has previously masked a real ~4x survival-rate regression (Casual/normal level-2 death rate looked fine at `CONCURRENCY=1`, but was 72% — vs. the true baseline's 0% — at `CONCURRENCY=6`/`ATTEMPT_CAP=20`).
- **`diagonalStrafeKey`** (the bot's diagonal-movement helper, plain-navigation branch only) is the sharpest cautionary example: an earlier change to its usage caused exactly that 72%-vs-0% regression, only caught via the matched-scale A/B above — not by `balancing:scan`. It's scoped to plain-nav only for this reason; don't re-add it to `hazard`/`criticalHealth`/`mineRetreat`/ranged-aim branches, and treat even refinements *within* its current safe usage as needing the same verification bar, not just a scan.

## Output shape

`balancing_telemetry.json` (repo root, gitignored) holds a meta block (profile definitions), then per-level and campaign-wide aggregates across 7 categories (map density/demographics, combat pacing, AI effectiveness/danger, damage/healing breakdown, weapon efficiency, economy/loot starvation, navigation/map flow), plus deterministic outlier `flags` and per-profile `crossDifficultyFlags`. Judgment-call metrics carry a `{mean, max, min, samples}` spread rather than a bare mean, so a consumer (human or LLM) can see the actual distribution, not just a single number that might hide a bimodal split.
