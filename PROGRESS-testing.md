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
- [x] Phase 2: src/wad/ (9 files) — verified 100% stmts/branch/funcs/lines,
      91 tests total green, `npm run verify:wad-parser` (the pre-existing
      Node script) still passes too. Notes for future reference:
  - Two real bugs caught by actually running the tests (not just writing
    them): pnames.test.ts had a wrong byte offset (wrote a name at +12 when
    the code reads it at +8 for a nonzero filePos case); compositeTexture.test.ts
    had an unused `palette` destructure under `noUnusedLocals`. Both fixed.
  - TS couldn't resolve types for the `.mjs` fixture import
    (`scripts/fixtures/buildTestWad.mjs`) — fixed with a hand-written
    `scripts/fixtures/buildTestWad.d.mts` ambient declaration file. Gotcha:
    it must be `.d.mts`, not `.d.ts` — TS only auto-pairs a `.mjs` file with
    a same-basename `.d.mts` companion.
  - Reaching true 100% branch coverage (not just stmts/lines) took a few
    deliberate edge-case tests: a destY-out-of-bounds-while-destX-in-bounds
    case in compositeTexture.test.ts; a TEXTURE2-lump case in loadWad.test.ts
    (which required adding a `texture2Name` option to the shared
    `buildTestWad.mjs` fixture — a real capability gap, since actual Doom2
    IWADs ship both TEXTURE1 and TEXTURE2, not test-only scope creep); a
    non-Error-thrown case via `vi.spyOn` on the `./wadFile` module namespace
    object (confirms Vitest's vite-node lets you spy a named import's
    binding this way); and a PNAMES-present-but-no-TEXTURE-lump case via a
    new `renameLump` test helper (buildTestWad's options can't express that
    combination directly, so the fixture's TEXTURE1 lump is renamed
    in-place after the fact).
  - Reuse pattern that worked well: `scripts/fixtures/buildTestWad.mjs`
    imported directly into compositeTexture.test.ts/loadWad.test.ts via a
    relative path, unmodified except the one additive `texture2Name` option
    above — confirms Vitest resolves plain `.mjs` fixtures fine.
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

src/difficulty.ts, src/prng.ts, and all of src/wad/ (9 files): 100% stmts/
branch/funcs/lines. 91 tests total, all green. Rest of the repo still 0%
(not yet reached). defaultHighscore.ts and empty-node-shim.ts correctly
absent from the report.

## Known open issues / deferred decisions

- main.ts (Phase 11) may need a testability-seam checkpoint with the user if
  exported-function + DOM-interaction tests genuinely can't reach full
  coverage on its ~40 unexported top-level closures. Not yet reached.
- Node installed is v18.19.1, which caps the Vitest/jsdom major versions
  usable (pinned to vitest@3.2.7/jsdom@26.1.0 — see Phase 0 notes above).
  If Node is ever upgraded to 20+, these can be bumped to latest majors, but
  that's not blocking anything right now.

## Next concrete step

Start Phase 3: src/parser/ wasm-free files (types.ts, registry.ts,
security.ts, astUtils.ts, generic/refinements.ts, generic/vocabulary.ts —
all either zero-import or type-only `web-tree-sitter` imports, so no wasm
runtime needed). Read src/parser/types.ts first (defines the ParsedFile
contract everything else in this phase produces/consumes), then registry.ts
and security.ts (both fully dependency-free), then astUtils.ts/refinements.ts/
vocabulary.ts (need small hand-built mock tree-sitter Node object literals
since they only import the Node type, erased at compile time).
