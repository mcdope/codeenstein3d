# Codeenstein 3D — Developer Docs

This is the developer-facing documentation set: architecture, game-design rationale, and a themed reference of notable design decisions. It's written for contributors and future-self, not players — for the pitch and quick start, see the top-level [`README.md`](../../README.md); for the player manual, see [`doc/user`](../user/README.md).

These docs are a **curated, evergreen reference** — they describe current rules and rationale, not a chronological history. The [`notes`](../../notes) file at the repo root is the raw, ongoing backlog of *open* work; the chronological record of completed work lives in [`history.md`](history.md).

Which file a thing belongs in comes down to the question it answers:

| question | file |
|---|---|
| "why is the code like this?" — a choice that still governs the code, including a choice *not* to do something | [`decisions.md`](decisions.md) |
| "what happened, and what did it cost?" — completed work, and approaches measured and reverted | [`history.md`](history.md) |
| "what still needs doing?" | [`notes`](../../notes) |

The middle one matters more than it looks: a reverted approach leaves no trace in the code — the code is precisely where it *isn't* — so without a written record the next person re-attempts it.

## Contents

- [Architecture](architecture.md) — the `fs → parser → map → engine` pipeline and the hard rules that keep it that way
- [Game Design](game-design.md) — why source code maps to a dungeon the way it does, and the intent behind enemies, weapons, and scoring
- [Design Decisions](decisions.md) — a themed reference of notable tradeoffs and reversals, citing `notes` task numbers for full detail
- [Development History](history.md) — the chronological record of completed work, and the approaches that were measured and reverted; moved out of `notes` so that file stays a working backlog
- [Testing](testing.md) — the Vitest unit-test suite: setup, shared mocks, mocking philosophy, and reusable techniques
- [Multiplayer Server Deployment](multiplayer-deployment.md) — step-by-step runbook for standing up the signaling server, the client build, and the optional coturn TURN relay, natively or via the [`docker/`](../../docker/README.md) stack
- [Balancing Telemetry Bot](balancing-telemetry.md) — the automated bot-driven balance-review/regression tool: entry points, profiles, env vars, and the headed-vs-headless timing gotcha
- [Performance Tooling](performance.md) — the `?perfDebug=1` frame diagnostics, the `perf:bench`/`perf:report` benchmark harness, and the measurement gotchas from the 2026-07 audit
