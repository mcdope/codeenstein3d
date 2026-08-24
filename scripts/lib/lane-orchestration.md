# Lane orchestration — the contract

Distributes many invocations of one script across several machines you own,
resumably, learning each machine's speed as it goes.

It exists because a balancing capture is hundreds of headless-browser runs, and
the machines available are a laptop, a couple of servers and a NAS that differ
by roughly 5x in throughput. Nothing off the shelf covers that shape: CI
sharding assumes homogeneous, disposable runners, and assumes the work is a test
suite rather than a resumable accumulation of samples.

This file is the contract, kept next to the code rather than in `doc/dev/` so it
travels with a future `git mv`. **`laneOrchestrator.mjs` imports only node
builtins** — the coupling to this project lives entirely in what callers pass
in, and in `sshRunner.mjs`'s single `REPO_ROOT` import.

## The pieces

| module | what it is | project-specific? |
|---|---|---|
| `laneOrchestrator.mjs` | the scheduler: claiming, chunk sizing, stealing, lane health, utilisation accounting | no |
| `sshRunner.mjs` | bootstrap + run on a remote host (clone/fetch, force-checkout a sha, `npm ci`, playwright install) | one import (`REPO_ROOT`), and `REMOTE_DIR`'s name |
| `bankedRuns.mjs` | counts distinct `rid`s already on disk, incrementally | yes — knows the NDJSON event-log shape |
| `devServer.mjs` | starts a dev server if one isn't already up, and hands back its URL | one import (`REPO_ROOT`) |
| `envNumber.mjs` | parses every numeric env knob, failing loudly instead of yielding `NaN` | no |

Consumers today: `run-balancing-capture.mjs`, `run-balancing-campaign.mjs`,
`run-balancing-campaign-multiplayer.mjs`.

## What a consumer supplies

Required:

- `combos` — the work items. Opaque to the orchestrator; it only ever passes
  them back to your callbacks.
- `comboKey(combo)` — a stable string id, used for filenames and log prefixes.
- `scanExisting(combo) -> {qualifying, fileCount}` — **how much is already
  banked on disk.** This is what makes the whole thing resumable, and it is
  called constantly (every combo, every time a lane frees up), so it must be
  cheap. See `bankedRuns.mjs` for the caching this needs at scale.
- `targetQualifying` — a number, or `(combo) => number`.
- `outputPathFor(combo, seq)`, `logPathFor(combo, seq)` — where an invocation
  writes. `eventLogPathFor` is optional.
- `envFor(combo, seq, outputPath, eventLogPath, ctx)` — the environment for one
  invocation. `ctx` carries `inFlightBefore`, `chunkAttempts`,
  `reservedAttempts` so you can size the work this invocation should do.
- `scriptPath` — the script each invocation runs.
- `runners` — `LocalRunner` and/or `SshRunner` instances. `LocalRunner` also takes an
  `env` object, merged over each invocation's environment, which is what lets several
  local lanes on one machine differ from each other — see **Running more than one local
  lane** below, because getting it wrong is silent.

Optional, and this is where the tuning lives: `watchdogMs`, `sigtermGraceMs`,
`maxInvocations`, `maxConcurrentPerCombo`, `laneFailureLimit`, `chunkFor`,
`measureYield`, `initialLaneRates`, `onLaneRate`, `initialComboCost`,
`onComboCost`, `log`, `formatElapsed`.

## What it promises

- **Every invocation gets a unique sequence number**, allocated synchronously,
  so two lanes working the same combo never collide on an output path.
- **Nothing is lost to a crash.** Progress is whatever `scanExisting` reports
  from disk; re-running asks only for the shortfall. A crashed, killed or
  empty-output invocation is a retry, not a data loss.
- **It terminates.** `maxInvocations` counts *consecutive invocations that
  banked nothing* — not every spawn — so a combo delivering three at a time is
  never cut off. A separate absolute multiple bounds a runaway.
- **A slow lane cannot monopolise the end of a cell.** See
  `concurrencyByRemaining`; getting this wrong is what produced 20-40 minute
  single-lane tails.
- **It reports what it did**: per-lane busy/idle, measured attempts-per-minute,
  relative per-combo cost, and time spent with one lane working while another
  was *refused* work.

## Running more than one local lane

A capture shards local work across several Node processes rather than one event loop
(`26b1e72`, 2026-08-19), because a single process was the bottleneck long before the
machine was. `run-balancing-capture.mjs` builds N `LocalRunner`s labelled `local-0`…
`local-N`. Three things about that are easy to get wrong and only fail in ways that look
like something else:

- **The count is derived from the machine, not fixed.** `LOCAL_LANES` defaults to
  `min(4, floor(os.cpus().length / 4))`, overridable with
  `CODEENSTEIN_CAPTURE_LOCAL_LANES`. There is therefore no correct remembered answer to
  "how many lanes are there" — probe it. It has been misremembered in both directions.
- **Each lane gets a *share* of the machine's concurrency, not all of it.**
  `CODEENSTEIN_TELEMETRY_CONCURRENCY` is set per runner to
  `CONCURRENCY_PER_LANE / LOCAL_LANES`, so total context count across the local lanes
  stays what it was. Splitting the queue is the point; asking more of the machine is not.
- **Every local lane must share one dev server.** A telemetry child that starts its own
  `stop()`s it on exit, which with parallel lanes pulls the server out from under the
  lanes still running. `ensureDevServer()` starts one, and its URL goes in the
  per-runner `env` — **never globally**, because `SshRunner` forwards every
  `CODEENSTEIN_*` key and a `localhost` URL set globally points every remote lane back at
  this machine.

## Invariants worth not breaking

- `claim()` is entirely synchronous. `inFlight`, `reserved`, `nextSequence` and
  `spawned` need no locking precisely because no `await` splits them.
- No `await` between `claim()` returning nothing and registering for the next
  completion, or a completion can slip past an unregistered waiter and the run
  parks forever.
- `reserved` must be tracked, not derived from `inFlight x CHUNK`: chunks differ
  per lane, and deriving it overshoots the target by the difference.
- Every lane exits only when nothing is claimable *and* nothing is in flight.

## What is genuinely reusable, and what is not

Reusable as-is: the scheduler, per-lane rate learning, cost-ranked assignment,
the watchdog and retry, lane health, utilisation accounting, and the ssh
bootstrap.

**Not** reusable, and the reason this is not an npm package yet: the constants
encode measurements of *this* workload. One headless browser dies at roughly 38
attempts, so a chunk is capped below that. The watchdog default came from timing
a real campaign on a specific CPU. `relCost` exists because a run that clears 15
levels costs 20x one that dies on level 2. A general package would have to
expose all of it as configuration, and that surface would be larger than the
code.

## If you do extract it

1. Drop `sshRunner.mjs`'s `REPO_ROOT` import (take the repo root as a
   parameter), and make `REMOTE_DIR` configurable.
2. Leave `bankedRuns.mjs` behind — `scanExisting` is the seam, and counting
   `rid`s in NDJSON is this project's business.
3. Move the tests: `laneOrchestrator.test.mjs` and `bankedRuns.test.mjs` already
   drive the public surface with fake runners and need no project fixtures.
4. Expect the API to move first. Two known changes are still open in `notes` —
   cross-repo pipelining, and replacing gameplay-derived lane speed with a
   benchmark — and both change this contract.

The trigger to publish is a **second repository** wanting it. Three consumers in
one repo is reuse; it is not yet evidence about anyone else's needs.
