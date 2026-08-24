# Capturing Balance Data for Another Campaign

Everything the balance review knows, it knows about `demo-campaign/` — seventeen
hand-authored files that ramp deliberately from a single `main.c` to a
multi-elite finale. That is one sample of one campaign, and it is the *friendliest
possible* one: it was written to be a good game.

Real levels are generated from whatever repository the player points the game at.
A repo has no ramp, no authored finale, and no guarantee that its third file is
easier than its tenth. So the question this document answers is: **how do I run
the same balance measurements against some other body of code** — a GitHub
project, a directory under `~/sources`, this repo itself — and what do I have to
be careful about when I do?

Two tools answer that question, and they do not have the same reach.

| | offline solver (`balancing:budget`) | bot capture (`run-balancing-telemetry.mjs`) |
|---|---|---|
| what it measures | whether a level is *clearable*: HP on the floor vs. damage obtainable | what actually happens when something plays it |
| campaign source | **any directory**, via `--dir` | **`demo-campaign/` only**, hardcoded |
| level enumeration | recursive, using the real workspace helpers, numbered from the real entrypoint | flat, top-level files only |
| cost for 17 levels | seconds | ~20 hours for a 6-cell, 360-attempt sweep |
| needs a browser | no | yes, one per 20 attempts |

The asymmetry is the point. **The solver is the tool for arbitrary repos** and it
needs no setup at all. The bot capture is pinned to the bundled campaign and
requires staging work to point elsewhere. Reach for the solver first; reach for
the bot only when you need a number the solver structurally cannot produce
(hit rates, death locations, loot actually collected, time spent).

---

## Part 1 — The offline solver, on any directory

This already works. No staging, no dev server, no browser:

```sh
npm run balancing:budget -- --dir ~/sources/some-project
npm run balancing:budget -- --dir ~/sources/some-project --all-difficulties
npm run balancing:budget -- --dir ~/sources/some-project --json out.json
```

It parses every file with the real parser, generates every level with the real
`MapGenerator`, and solves each against the real combat constants
(`scripts/lib/levelSolver.mjs`). For a fresh clone of a GitHub project:

```sh
git clone --depth 1 https://github.com/owner/repo /tmp/repo
npm run balancing:budget -- --dir /tmp/repo
```

Two things to know about how to read the result.

**The exit code only means one thing.** Non-zero means some level contains an
enemy that cannot be killed with every round obtainable on that level — a hard,
one-directional result. A zero exit proves nothing in the other direction;
`levelSolver.mjs` documents why, and it is why the script gates on failure only.

**`--kill-rate` is the assumption that moves the numbers most.** It is the
fraction of spawned enemies a player actually kills, which sets both the HP they
spend ammo on *and* the drops they bank. The default (0.71) is measured from bot
telemetry on the demo campaign; `--kill-rate 1` models a completionist. A
carry-forward figure quoted without saying which kill rate produced it is not a
figure. This exact confusion once manufactured a Hard-difficulty "collapse" that
play flatly contradicted.

A worked example, small enough to check by eye — this repo's own `src/fs`, which
holds seven source files with their `*.test.ts` files beside them:

```
$ npm run balancing:budget -- --dir src/fs
# Balance budget -- src/fs
# 6 levels, perfect-accuracy lower bound on cost
# level 1 = demoCampaign.ts — 1 file(s) ahead of it in tree order are never played
# ammo drops x maxHp/88, heal x maxHp/100 (engine defaults)
# kill rate 0.71 — the share of each roster assumed fought

level  file                    enemies   HP tot   ammo dmg (carry/pre/drop)   ratio (nofarm/comb)
    1  demoCampaign.ts               6      260      3244 /      0 /    320    12.48 /  13.71
    2  github.ts                    16      826      3287 /    484 /   1016     4.56 /   5.80
    3  gitlab.ts                    16     1018      3906 /    242 /   1253     4.07 /   5.31
    4  remoteHost.ts                38     1922      4955 /    726 /   3276     2.96 /   4.66
    5  remoteHosts.ts                9      470      6642 /    480 /    801    15.15 /  16.86
    6  workspace.ts                 29     1289      7357 /    484 /   2197     6.08 /   7.79
```

Two things to read off it. **Six levels, not fourteen**: `isIgnoredFileName` dropped the
test files exactly as the game would, and the header line says one further file was
dropped for sitting *ahead of the entrypoint* — `codeberg.ts` sorts before
`demoCampaign.ts`, and the game never plays it. And note how little the file *count*
tells you: `remoteHost.ts` puts 38 enemies and 1,922 HP on the floor where
`remoteHosts.ts`, whose name differs by one character, puts 9 and 470. Level difficulty
tracks code complexity, which in an arbitrary repo is unrelated to filename order.

`collectSourceFiles` (`scripts/report-level-budget.mjs`) walks the directory
using the real `src/fs/workspace.ts` helpers — `isIgnoredDirectoryName`,
`isIgnoredFileName`, `compareNodes` — recursing the way `flattenParsableFiles`
does in `main.ts`: directories before files at each level, then case-insensitive
alphabetical, depth-first.

**Walk order is not level numbering, and the difference is not cosmetic.**
`entrypointIndex()` models `findEntrypoint`'s cascade — the same one the game runs — and
everything sorting *ahead* of the pick is dropped from the numbering entirely rather than
counted as levels 1..n. The header line names how many were dropped, as in the example
above. Before this was modelled (`58cad4b`, 2026-08-21) the tool numbered from tree index
0, which across the corpus counted **1,420 of 7,088 levels (20%) that a player can never
reach** and moved the headline answers with them. It was found the hard way: a playtest
report could not be matched to the levels this tool had named — which is exactly the
failure this page exists to prevent.

So the level order it reports is the order the game would really play, including for a
deeply nested repo. That is deliberate and load-bearing: it decides which source file is
level 1, and therefore what every per-level number is *about*.

---

## Part 2 — The bot capture, on another campaign

### Why this one needs staging

Three separate places pin the harness to the bundled campaign:

- `CAMPAIGN_DIR` / `CAMPAIGN_NAME` are constants, not options
  (`scripts/run-balancing-telemetry.mjs:50-51`).
- The browser side inlines the campaign at **build time** —
  `import.meta.glob("../../demo-campaign/*", { query: "?raw", eager: true })` in
  `src/fs/demoCampaign.ts`. Nothing is fetched at runtime.
- The bot launches by clicking `#launch-demo-campaign`
  (`run-balancing-telemetry.mjs:370`). The other two workspace sources are not
  drivable headlessly: the local-folder path needs `showDirectoryPicker`, a
  native dialog Playwright cannot answer, and the GitHub path needs network on
  every run.

So the only practical route today is to **stage your campaign into
`demo-campaign/`** — which works with zero code change, because both the Node
planner and the browser bundle read that one directory.

### The failure mode you must design against

`playRun` indexes the plan positionally:

```js
const { map, routePlain } = levelPlans[i];   // run-balancing-telemetry.mjs:462
```

There is **no check that `levelPlans[i]` is the file the browser actually
loaded.** If the two enumerations disagree, the bot navigates level 5's map using
level 3's route plan, forever, and nothing errors. You get a full run of
plausible-looking telemetry describing a game nobody played.

That makes the enumeration rules the whole ballgame, and there are three of them,
which are *not* the same rule:

| consumer | recursion | ignore rules | ordering |
|---|---|---|---|
| the game (`flattenParsableFiles`, `main.ts`) | recursive | `IGNORED_DIRECTORIES`, `isIgnoredFileName` | directories first, then case-insensitive alphabetical |
| the solver (`collectSourceFiles`) | recursive | same, via the real helpers | same |
| **the bot planner (`planLevels`, `:234`)** | **flat — `readdirSync` + `isFile()`** | **none** | case-insensitive alphabetical |

For `demo-campaign/` — flat, no ignorable names — all three collapse to the same
list, which is why this has never bitten. For anything else they diverge
immediately: the planner would happily make a level out of a file the game skips,
and would silently ignore every nested directory the game descends into.

**Therefore: stage flat.** A flat directory of parsable files with no ignorable
names is the one shape where all three rules agree, and it is what the harness has
always actually assumed.

### The other failure mode: your campaign starts most of the way down the list

**`campaignLevelOrder` returns `files.slice(entrypointIndex)`.** Files *before* the
detected entrypoint are deliberately absent, because `advanceToNextLevel` only ever
walks forward and the game never reaches them. That is correct for the bundled campaign,
whose entrypoint is `main.c` and therefore first.

It is a trap for anything else. A real project's files are rarely ordered so that the
entrypoint comes first, and `findEntrypoint` falls back to *scoring* when nothing
contains a `main`. The score depends on the whole candidate set, so **the number of
levels you get is not monotonic in the number of files you stage**. Measured on curl's
`lib/`, which has no `main()` anywhere:

| files staged | levels actually played | level 1 |
|---:|---:|---|
| 17 | 13 | `05_bufref.c` |
| 24 | **2** | `23_curl_endian.c` |

Nothing errors, and the run is not wrong — it is a perfectly valid capture of a
two-level campaign. It is simply not the campaign you thought you staged, and at 60
attempts a combo you find out hours later.

**So pin level 1: stage a file that actually contains an entrypoint as `01_`.** For curl
that is `src/tool_main.c` rather than anything under `lib/`, and it takes 17 files back
to 17 levels.

**And check it before spending anything**, by asking the game rather than inferring —
this is the same hook the planner itself uses, so it is the authority:

```sh
node -e 'import("./scripts/run-balancing-telemetry.mjs").then(async (m) => {
  const order = await m.readCampaignLevelOrder();
  console.log(order.length + " levels, starting at " + order[0]);
  process.exit(0);
});'
```

Note this also retires the older worry in the previous section. `planLevels` no longer
derives its own order — it calls `readCampaignLevelOrder`, which asks the browser — so
the planner and the game **cannot** disagree about which file is which level. The three
enumerations still differ, but only the game's answer is ever used.

### Staging

Work on a scratch branch or a `git worktree` — you are about to overwrite a
directory the repo's tests assert on, and you must never commit that state.

Two exceptions to "never commit", both learned the hard way. **A capture that uses SSH
lanes must commit the staging and push it**, because lanes clone from origin and check
out HEAD's exact sha — they refuse outright with "HEAD is not on any remote" otherwise.
Use a `capture/` branch marked DO NOT MERGE. And **`ssh-hosts.env` is gitignored**, so a
fresh worktree does not have one: without it the capture reports `Lanes: local` and runs
single-machine at roughly a fifth of the speed, with no warning. Copy it in.

**Plan on three SSH lanes plus `local`, and probe rather than trusting that number.**
`ssh-hosts.env` lists four hosts but one is commented out, and `readHostList()` filters
`#` lines — so the runner resolves three. This count has been written down wrongly in
both directions: an audit claiming four uncommented hosts went stale within hours of
being written, and a follow-up calling the missing lane "worth investigating" was itself
wrong, because that host is off on purpose. Read the file before sizing a run. For
reference, a 400-attempt capture across those three plus local completed ~2.5h of work in
~2.5h wall clock with every lane 66-100% busy and no orphaned dev servers left behind.

A worktree also needs its own `npm ci`. Symlinking the main tree's `node_modules` looks
like a shortcut and shares Vite's cache between two checkouts of different content.

```sh
git worktree add ../shooter-capture -b capture/some-project
cd ../shooter-capture
```

Then flatten your target into `demo-campaign/`. The numeric prefix is how you
control level order, since ordering is plain alphabetical:

```sh
git clone --depth 1 https://github.com/owner/repo /tmp/repo
rm -f demo-campaign/*
i=1
# Adjust the find expression to the languages and layout you care about.
find /tmp/repo -type f \( -name '*.py' -o -name '*.go' -o -name '*.ts' \) \
  -not -path '*/.git/*' -not -path '*/node_modules/*' \
  | sort | head -17 | while read -r f; do
      cp "$f" "$(printf 'demo-campaign/%02d_%s' "$i" "$(basename "$f")")"
      i=$((i+1))
    done
```

Check the staging before spending twenty hours on it — the solver is the cheap
oracle here, because it reports the level list it derived:

```sh
npm run balancing:budget -- --dir demo-campaign --all-difficulties
```

If that list is not the campaign you meant, nothing downstream will be either.

#### Which files become levels

A file is a level if its extension has a registered parser
(`src/parser/registry.ts`), or if it has no extension but a `#!` line naming an
interpreter that maps onto one:

| adapter | extensions |
|---|---|
| PHP (bespoke) | `php` `php3` `php4` `php5` `phtml` |
| C (bespoke) | `c` `h` |
| JavaScript | `js` `mjs` `cjs` `jsx` |
| TypeScript | `ts` `mts` `cts` — and `tsx` separately |
| Python | `py` `pyw` |
| Java | `java` |
| C++ | `cpp` `cc` `cxx` `hpp` `hh` `hxx` |
| Go / Rust / Ruby / C# | `go` / `rs` / `rb` / `cs` |
| Bash | `sh` `bash` |
| Scala | `scala` `sc` |
| Objective-C | `m` `mm` |

Anything else is skipped by the planner with a `PARSE FAIL — skipping` line. Read
that output: a campaign that silently lost a third of its files still runs.

Two shape rules worth knowing while you choose:

- **`.h` files become bonus levels** (`planLevels`: `extensionOf(filename) === "h"`).
  A campaign made mostly of headers is mostly bonus levels, which is a different
  game, not a harder one.
- **"Qualifying" means reaching level 4** (`QUALIFY_LEVEL_INDEX = 3`). A campaign
  shorter than four levels can never produce a qualifying run, and the qualifying
  count will read `0/N` no matter how well the bot plays. Use the fixed-denominator
  setup below, which does not depend on qualification, and read the event log
  rather than the qualifying count.

#### What staging breaks

Ten test files assert against the bundled campaign's real content — among them
`src/map/mapGenerator.test.ts` ("never logs an unreachable-room warning for any
bundled demo-campaign file"), `src/fs/demoCampaign.test.ts`,
`src/engine/balanceHash.test.ts`, `scripts/lib/routePlanner.test.mjs`. With a
staged campaign in place, **expect those to fail, and do not "fix" them.** The
worktree exists so that this state never reaches a branch anyone merges. Delete
the worktree when the capture is done.

---

## Part 3 — Running the capture

Start a dev server that is *yours*, not the one you develop against, and give it
its own port. `npx vite` rather than `npm run dev` deliberately: the `predev` hook
`process.exit(1)`s on any WAD fetch failure, which is not something an unattended
overnight run should depend on.

```sh
npx vite --port 5199 --strictPort > vite5199.log 2>&1 &
```

Then drive `run-balancing-telemetry.mjs` **directly, once per cell** — not
`balancing:campaign`. The orchestrator runs each combo until N runs *qualify*,
which is the wrong knob for measuring rates: it stops early on easy combos and
never terminates on impossible ones. Death rates need a fixed denominator.

| variable | value | why |
|---|---|---|
| `CODEENSTEIN_DEV_URL` | `http://localhost:5199` | your own server stays untouched |
| `CODEENSTEIN_TELEMETRY_PROFILE` | `Casual` \| `Gamer` \| `Pro` | one cell per profile |
| `CODEENSTEIN_TELEMETRY_DIFFICULTY` | `easy` \| `normal` \| `hard` | one cell per difficulty |
| `CODEENSTEIN_TELEMETRY_ATTEMPT_CAP` | e.g. `20` | **the denominator** |
| `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` | `999` | never exit early |
| `CODEENSTEIN_TELEMETRY_CONCURRENCY` | `10` | see the throughput note |
| `CODEENSTEIN_TELEMETRY_EVENT_LOG` | a directory | the per-event NDJSON — the real output |
| `CODEENSTEIN_TELEMETRY_OUTPUT_FILE` | a path | aggregate counters for this invocation |
| `CODEENSTEIN_TELEMETRY_ANOMALY_SCAN` | `1` | surfaces bot stalls, which a new campaign will have |
| `CODEENSTEIN_TELEMETRY_LEVEL_LIMIT` | unset | unset means the whole campaign |

### Three properties the driver needs

These are not theoretical. The 2026-08-04 capture lost a third of its first cell
to the first two, and its result file to the third.

**1. Chunk the attempts — one browser cannot survive a whole cell.** `main()`
launches a single Chromium (`:263`) and reuses it for every attempt. At attempt
~38, 2h20m in, it died; every remaining attempt failed instantly on
`browser.newContext()` — and the run still reported `attempts used: 60`. Cap each
invocation at ~20 attempts so every chunk gets a fresh browser.

> **`attemptsUsed` is a count of attempts started, not of samples obtained.**
> Count distinct `rid`s in the NDJSON instead. `rid` is
> `${pid}-${random}-${counter}` (`:163`), so chunks never collide and you can
> append many invocations into one cell's log and still count correctly.

**2. A non-zero exit code is not automatically a failure.** The script writes its
JSON, prints `Telemetry saved`, `main()` resolves — and Node then hangs on a
dangling Playwright handle, because nothing calls `process.exit(0)`. Your watchdog
will eventually kill it. If the log contains `Telemetry saved`, the work finished
and the JSON is complete; treating that `rc=124` as failure is how a good result
file got deleted.

**3. Resume from the data, not from a marker file.** Recompute "how many attempts
does this cell have?" by counting `rid`s in its NDJSON on every pass. That resumes
correctly after any kind of kill, costs only the chunk in flight, and cannot be
fooled by a result file that exists but is short.

A driver with all three properties, plus a dry-test harness that stubs out the
telemetry run so its resume logic can be exercised in seconds instead of hours,
was written for the 2026-08-04 sweep. It is a one-off rather than committed
tooling, but the shape is worth reproducing.

### Throughput, and why concurrency does not save you

**0.275 attempts/minute at concurrency 10, on a CPU-saturated 16-core machine.**
Measured, not estimated. Raising concurrency does not help — the work is
CPU-bound, not latency-bound.

Do not size a run off the repo's watchdog calibration (5m13s for 8 attempts).
That is a *time-to-qualify* figure: those attempts race to clear level 4 and
mostly die early rather than playing the whole campaign. Reading it as a
full-campaign rate underestimated a real sweep by 3×.

| sweep | attempts | wall clock |
|---|---|---|
| one cell, 60 attempts | 60 | ~3.6 h |
| 6 cells (3 profiles × normal/hard) | 360 | ~22 h |
| 9 cells (adding easy) | 540 | ~33 h |

Disk: 0.59 MB of NDJSON per attempt (~0.3 GB for 360). Not a constraint.

A longer or slower campaign scales this roughly linearly in level count, and
`normal` is *slower per attempt* than `hard` because the bot survives deeper and
plays more levels before dying.

### Where output belongs

A directory matching `balancing_runs_*/`, which `.gitignore` already covers. Not
the session scratchpad under `/tmp` — that is session-scoped and would take a
whole night's data with it. (The `balancing_events/` path some docs mention is
**not** gitignored; the `balancing_runs_*` prefix is the safe one.)

---

## Part 4 — Verification, before any number is quoted

In this order, because each step invalidates the next if it fails.

**1. `npm run verify:event-log -- <dir>`.** Structural, conservation, and
cross-site checks over the whole capture. Non-zero exit means the data is not
trustworthy and nothing gets published.

**2. External roster cross-check.** `npm run balancing:budget -- --dir demo-campaign
--all-difficulties --json solved.json`, then diff its per-level archetype/HP
multiset against the capture's `levelStart` rosters. Node and the browser build
the map through entirely separate runtimes, so agreement here is real validation
rather than self-consistency. **On a newly staged campaign this is the check that
proves your staging worked** — it is the only one that would catch the planner and
the browser having enumerated different files.

**3. Denominator sanity.** Distinct `rid`s per cell, not `attemptsUsed`. A cell
that came up short must have its real denominator stated rather than being pooled
as if it were full.

**4. Counter cross-check on one chunk.** Shots/hits/kills per weapon and damage by
source, aggregate JSON vs. events. Scope it to a single chunk — each `.json` covers
only its own invocation, and the matching events are those whose `rid` carries that
chunk's session prefix.

---

## Part 5 — Reading the result

Rates need intervals. Use **Wilson score** intervals rather than the normal
approximation: several of these rates sit at 0% or 100%, where the normal
approximation collapses to ±0 and reads as certainty. At n=8 a death rate carries
±32pp — three baseline captures of the same level once came in at 64%, 67% and
88% purely from noise. n=60 gets you to about ±12pp, which is why a real sweep is
sized the way it is.

Report the denominator next to every rate, always.

For a campaign that is not the demo campaign, two comparisons are worth more than
any absolute number:

- **Solver vs. bot.** They are independent models — one analytic, one empirical.
  Where they agree, you have validation. Where they disagree, one of them is
  wrong, and that is the finding.
- **This campaign vs. the demo campaign.** The demo campaign is authored to ramp.
  An arbitrary repo is ordered alphabetically by accident of filename, so its
  difficulty curve is essentially random. Expect the shape to be worse, and treat
  "worse than demo-campaign" as the expected result rather than a bug.

---

## Traps, collected

Each of these cost real time at least once.

- **A campaign whose level order you did not check.** Verify with the solver's
  level list before the capture, not after.
- **Quoting `attemptsUsed` as a sample size.** It counts attempts started. It read
  60 on a cell that produced 38.
- **Deleting output on a non-zero exit code.** Check for `Telemetry saved` first.
- **Running the whole cell in one browser.** It dies around attempt 40 and the
  remainder fail silently and instantly.
- **Committing a staged `demo-campaign/`.** Use a worktree; ten test files assert
  on its real contents.
- **Editing files under `src/` or `demo-campaign/` mid-capture.** Vite's HMR
  reloads the page and kills every attempt in flight.
- **Trusting a rate without its denominator.** Especially at the 0%/100%
  boundaries, where it looks most convincing.

## See also

- [`balancing-telemetry.md`](balancing-telemetry.md) — the bot, its profiles, the
  full env-var surface, the event schema, and the balance model
- [`testing.md`](testing.md) — the verify scripts and what the suite cannot catch
