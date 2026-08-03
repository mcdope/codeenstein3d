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
- [WAD Texture Packs](wad-texture-packs.md) — which lump names the game looks for in a DOOM WAD, per styleset and per gameplay-signal slot; what a WAD must contain to work as a texture pack; the fallback chain, the format limits that silently drop a slot, and how to check a pack with `report:wad-stylesets`
- [Testing](testing.md) — the Vitest unit-test suite: setup, shared mocks, mocking philosophy, reusable techniques, how to run the verify scripts locally, and what the suite structurally cannot catch
- [Adding a Weapon](adding-a-weapon.md) — the touchpoint checklist for a new weapon; most of them are hardcoded enumerations, and the ones that fail silently (the playtest bot's mirrored weapon table especially) are called out per step
- [Adding a Language](adding-a-language.md) — the same for a new parser: the mandatory grammar-ABI vetting gate, and the shared vocabulary tables where a missing language loses a whole map feature without erroring
- [Multiplayer Server Deployment](multiplayer-deployment.md) — step-by-step runbook for standing up the signaling server, the client build, and the optional coturn TURN relay, natively or via the [`docker/`](../../docker/README.md) stack
- [Balancing Telemetry Bot](balancing-telemetry.md) — the automated bot-driven balance-review/regression tool: entry points, profiles, env vars, and the headed-vs-headless timing gotcha
- [Multiplayer Research](multiplayer-research.md) — the 2026-07-18 feasibility pass that decided multiplayer's shape before any of it was built: the privacy analysis, the no-backend filter and where it broke, short-code-vs-QR, and the measured cross-browser determinism result. Historical rationale, not current behaviour — the four specs below supersede it wherever they disagree
- [Multiplayer Specs](multiplayer-netcode-spec.md) — the four documents behind the multiplayer implementation, all marked **implemented** and CI-verified. They are specifications rather than guides, and are the place to look when changing netcode behaviour rather than using it:
  - [Signaling + lobby server](multiplayer-server-spec.md) — the one piece of backend that turned out to be unavoidable: a minimal WebRTC signaling mailbox plus the lobby feature
  - [Netcode](multiplayer-netcode-spec.md) — the lockstep layer sitting above the single-player `RaycasterEngine`
  - [Game-state adaptation](multiplayer-game-state-spec.md) — the `simulate()`/`render()`/`advance()` split, the N-player model, player-count elite scaling, and coop revive
  - [Balancing & telemetry automation](multiplayer-balancing-telemetry-spec.md) — the multiplayer arm of the telemetry bot (see [balancing-telemetry.md](balancing-telemetry.md) for the day-to-day reference)
- [Performance Tooling](performance.md) — the `?perfDebug=1` frame diagnostics, the `perf:bench`/`perf:report` benchmark harness, and the measurement gotchas from the 2026-07 audit

## Dated snapshots

Point-in-time audit reports, kept for their evidence rather than as current reference — the evergreen docs above supersede them wherever they disagree.

- [Performance review, 2026-08-02](perf-review-2026-08-02.md) — the frame-time audit that found the real draw-call cost class, including two earlier wrong mechanisms it retracts
- [Code review, 2026-08-03](review-2026-08-03.md)
