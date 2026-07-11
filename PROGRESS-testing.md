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
- [ ] Phase 2: src/wad/ (9 files) — **IN PROGRESS, INTERRUPTED MID-VERIFICATION**
  All 9 test files were WRITTEN this session but the session hit its usage
  limit before `npm run typecheck` / `npx vitest run src/wad/ --coverage`
  could be confirmed green, and even `git add` stopped going through — so
  these files are UNCOMMITTED and UNVERIFIED on disk right now:
  - src/wad/wadFile.test.ts (readPaddedName/parseWadHeader/parseLumpDirectory/findLump)
  - src/wad/playpal.test.ts (parsePlaypal)
  - src/wad/pnames.test.ts (parsePnames)
  - src/wad/patch.test.ts (parsePatch — local buildPatchBuffer helper, multi-post
    columns, hole columns, nonzero filePos)
  - src/wad/textureLump.test.ts (parseTextureLump — local buildTextureLumpBuffer
    helper)
  - src/wad/compositeTexture.test.ts (compositeTexture — reuses
    scripts/fixtures/buildTestWad.mjs via relative import `../../scripts/
    fixtures/buildTestWad.mjs`, plus hand-built edge cases: missing pnames
    entry, missing lump, out-of-bounds clip, out-of-range palette index,
    zero patches)
  - src/wad/flatLump.test.ts (findFlat both marker pairs + edge cases,
    parseFlat)
  - src/wad/textureAllowlist.test.ts (data-shape smoke checks via it.each)
  - src/wad/loadWad.test.ts (loadWadTextures — full success, no-PLAYPAL,
    bad magic, truncated buffer, includeTextures:false, includeFlats:false,
    each optional slot omitted individually, and two deliberately-corrupted-
    lump tests via a local `corruptLumpFilePos` helper that overwrites a
    lump's directory filepos to run off the buffer end, to prove
    resolveCompositeSlot/resolveFlatSlot's per-candidate try/catch isolates
    one candidate's failure from the rest of the parse)

  **NEXT SESSION MUST START HERE, BEFORE ANYTHING ELSE:**
  1. `npm run typecheck` — confirm no type errors in the 9 new files above.
  2. `npx vitest run src/wad/ --coverage` — confirm all pass and every
     src/wad/*.ts file (except none are excluded — wad has no exclusions)
     hits 100% stmts/branch/funcs/lines. Known risk spots to check first if
     something's off: (a) the relative import path from src/wad/*.test.ts up
     to scripts/fixtures/buildTestWad.mjs — confirm Vitest resolves a plain
     .mjs fixture file correctly; (b) whether the two
     `corruptLumpFilePos`-based tests in loadWad.test.ts actually land inside
     resolveCompositeSlot's/resolveFlatSlot's catch blocks as intended, or
     whether corrupting a lump's filepos to `buffer.byteLength - 1`
     accidentally throws somewhere the code doesn't catch (e.g. during
     directory parsing itself, if the corrupted lump happens to be read
     before the try/catch scope) — reread the failure and adjust the corrupt
     offset/target lump if so.
  3. Fix whatever's broken, rerun until green and 100%.
  4. One known likely coverage gap flagged during writing (not yet
     confirmed against a real coverage report): loadWad.ts's
     `pnamesLump && (texture1Lump || texture2Lump)` guard — only the
     both-true and both-false branches are exercised by the current tests;
     the pnamesLump-true/no-texture-lump-present branch has no dedicated
     fixture. Check the coverage report; only add a test for it if v8
     actually flags that branch as uncovered.
  5. `git add src/wad/*.test.ts` then commit (message: "test: 100% coverage
     for src/wad/ (Phase 2)"), update this file's checkbox to `[x]` and the
     coverage snapshot below, THEN move to Phase 3.
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

Session was interrupted by a usage limit mid-Phase-2, before verification
could run (Bash access became intermittently/then fully unavailable — not a
code problem, a session-limit problem). See the detailed "NEXT SESSION MUST
START HERE" block under Phase 2 above for exact resume steps. Do not trust
that the 9 wad test files are correct — they are untested code on disk.
