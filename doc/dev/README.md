# Codeenstein 3D — Developer Docs

This is the developer-facing documentation set: architecture, game-design rationale, and a themed reference of notable design decisions. It's written for contributors and future-self, not players — for the pitch and quick start, see the top-level [`README.md`](../../README.md); for the player manual, see [`doc/user`](../user/README.md).

These docs are a **curated, evergreen reference** — they describe current rules and rationale, not a chronological history. The [`notes`](../../notes) file at the repo root is the raw, ongoing playtest/dev log (numbered tasks, updated continuously); it is never superseded by these docs, and these docs cite it rather than repeat it.

## Contents

- [Architecture](architecture.md) — the `fs → parser → map → engine` pipeline and the hard rules that keep it that way
- [Game Design](game-design.md) — why source code maps to a dungeon the way it does, and the intent behind enemies, weapons, and scoring
- [Design Decisions](decisions.md) — a themed reference of notable tradeoffs and reversals, citing `notes` task numbers for full detail
- [Testing](testing.md) — the Vitest unit-test suite: setup, shared mocks, mocking philosophy, and reusable techniques
