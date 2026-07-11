# Vitest 100%-Coverage Rollout — Progress State

(disposable — delete once Phase 12 ships; see `notes`' "tests" backlog item, and
[[feedback-scoped-progress-state-file]] memory convention)

Full plan: `/home/mcdope/.claude/plans/pure-crafting-zebra.md`

**Update this file after every file's test suite is finished and passing — not
just at phase boundaries.** Sessions can end abruptly (usage limits). Commit
alongside every update so nothing sits uncommitted for long. Read this file
first thing at the start of every session, before touching code.

## Status by phase

- [x] Phase 0: scaffolding — devDeps, vitest.config.ts, `?url`-as-path plugin
      verified via smoke test, npm scripts, test/mocks/* helpers
  - [x] devDependencies added: vitest@3.2.7, @vitest/coverage-v8@3.2.7, jsdom@26.1.0
        (pinned below vitest's own latest-major floor — installed Node is
        v18.19.1, and vitest@4/jsdom@29 require Node 20+; 3.2.7 is the newest
        3.x release, fixes the GHSA-5xrq-8626-4rwp UI-server CVE, `npm audit`
        clean)
  - [x] npm scripts added (test, test:watch, coverage)
  - [x] vitest.config.ts written (node default env, coverage config, no thresholds yet)
  - [x] `?url`-as-path Vite plugin written — note: had to use a real id +
        `?url-as-path` query suffix, NOT a `\0`-prefixed synthetic id
        (Rollup's usual virtual-module convention) — vite-node's module
        loader tried to parse the `\0`-prefixed id as a URL with a
        `url-as-path:` scheme and threw. Real-path+query mirrors how Vite's
        own `?url`/`?raw` work internally and Just Works.
  - [x] smoke test confirmed: `src/parser/runtime.ts`'s `initTreeSitter()`
        resolves under Vitest (now the permanent `src/parser/runtime.test.ts`,
        counts toward Phase 4), and a full `CParserAdapter.parse()` smoke
        check confirmed grammar wasm loading too (that one was throwaway,
        deleted — real cParser tests belong to Phase 4)
  - [x] test/mocks/canvas.ts, audio.ts, fsAccess.ts, raf.ts — all hand-rolled,
        scoped to the exact API surface confirmed via grep across
        src/engine, src/ui, src/map/debugView.ts, src/fs/workspace.ts.
        raf.ts gotcha: can't reassign `performance.now` directly (read-only
        property in this env) — must use `vi.spyOn(performance, "now")` +
        `.mockRestore()`. All 4 verified via a throwaway smoke test, deleted
        after passing.
  - [x] `coverage` added to .gitignore
  - [x] typecheck clean, `npm test` green, `npm run coverage` runs and
        correctly excludes defaultHighscore.ts/empty-node-shim.ts while
        including everything else (incl. main.ts) — committing now
- [x] Phase 1: src/ root (difficulty.ts, prng.ts) — both 100% covered
- [ ] Phase 2: src/wad/ (9 files)
- [ ] Phase 3: src/parser/ wasm-free (6 files)
- [ ] Phase 4: src/parser/ wasm-runtime (5 files)
- [ ] Phase 5: src/map/ + src/map/generation/ (18 files)
- [ ] Phase 6: src/engine/ pure-logic (13 files)
- [ ] Phase 7: src/engine/ browser-API (12 files)
- [ ] Phase 8: src/fs/ (3 files)
- [ ] Phase 9: src/ui/ (5 files)
- [ ] Phase 10: src/engine/engine.ts
- [ ] Phase 11: src/main.ts
- [ ] Phase 12: wrap-up (thresholds, CI, docs, notes, delete this file)

## Current coverage snapshot

src/difficulty.ts and src/prng.ts: 100%/100%/100%/100%. Rest of the repo
still 0% (not yet reached). defaultHighscore.ts and empty-node-shim.ts
correctly absent from the report.

## Known open issues / deferred decisions

- main.ts (Phase 11) may need a testability-seam checkpoint with the user if
  exported-function + DOM-interaction tests genuinely can't reach full
  coverage on its ~40 unexported top-level closures. Not yet reached.
- Node installed is v18.19.1, which caps the Vitest/jsdom major versions
  usable (pinned to vitest@3.2.7/jsdom@26.1.0 — see Phase 0 notes above).
  If Node is ever upgraded to 20+, these can be bumped to latest majors, but
  that's not blocking anything right now.

## Next concrete step

Start Phase 2: src/wad/ (9 files). Read scripts/verify-wad-parser.mjs and
scripts/fixtures/buildTestWad.mjs first — reuse buildTestWad.mjs's fixtures
directly rather than re-deriving synthetic WAD bytes. Start with the
simplest file (playpal.ts or pnames.ts) and work up to loadWad.ts.
