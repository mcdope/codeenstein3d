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
- [x] Phase 3: src/parser/ wasm-free (6 files) — 286 tests total repo-wide,
      all green. Notes for future reference:
  - types.ts is fully type-only (zero runtime exports) — excluded from
    vitest.config.ts's coverage.exclude (v8 reports a 0/0-statement file as
    a literal 0%, not "N/A", which would have wrongly sunk the Phase 12
    gate). A light types.test.ts still exists (not counted) pinning the
    documented EntityKind/SecretTriggerKind value sets. Note: src/map/types.ts
    is NOT the same case — it has real runtime constants (HAZARD_TILE etc.)
    and needs real tests in Phase 5, not exclusion.
  - security.ts, registry.ts: straightforward, real adapters used for
    registry.test.ts's parseFile() success/throw-path tests (the "wasm-free"
    phase label is about which files import web-tree-sitter directly, not
    about forbidding real wasm execution in their tests — registry.ts's own
    dispatch logic is wasm-free, but exercising parseFile() meaningfully
    still parses real JS via the generic adapter, which already works fine
    thanks to the Phase 0 plugin).
  - astUtils.ts, generic/refinements.ts (10 language refinements: js/ts,
    python, java, csharp, scala, rust, go, cpp, objc, ruby): tested against
    REAL parsed ASTs (C/JS/python/java/csharp/scala/rust/go/cpp/objc/ruby
    grammars, all already-bundled deps) rather than hand-built mock nodes —
    higher fidelity, and the `entity` argument passed to `refine()` is a
    synthetic stub since only ancestry/structure needs to be real.
  - generic/vocabulary.ts: fully grammar-agnostic (parameterized purely by
    node-type-name tables) — used synthetic Node-shaped fixtures instead of
    real grammars here, since they give precise control over BFS-depth and
    unwrap-path branches that would be fragile to hit via any one real
    grammar's exact shape. Real end-to-end exercising of this module through
    an actual grammar happens naturally in Phase 4.
  - Found and fixed 3 provably-unreachable defensive branches in
    registry.ts's shebang parsing (String.prototype.split() never returns
    an empty array, so `?? ""` fallbacks there can't fire) and one in
    refinements.ts's cppVisibility (`refine`'s own isMethod guard already
    ensures node.parent is non-null before cppVisibility is ever called) —
    marked with `/* v8 ignore next */` + a one-line rationale comment
    referencing exactly why, rather than either leaving 100% unreachable or
    weakening the defensive code for a metric. A parallel case in
    rubyVisibility (`!body`) turned out to be genuinely reachable (ruby's
    refine has no equivalent pre-guard) and got real synthetic-node test
    coverage instead — worth checking this reachability distinction
    carefully rather than assuming symmetry between similar-looking guards.
  - Incidental partial coverage of cParser.ts/phpParser.ts/genericParser.ts
    already shows up in the coverage report (Phase 3's registry.test.ts and
    astUtils.test.ts exercise the JS generic adapter and C adapter in
    passing) — expected and fine, Phase 4 will finish these off properly.
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

src/difficulty.ts, src/prng.ts, all of src/wad/ (9 files), and src/parser/'s
6 wasm-free files (types.ts excluded from coverage, astUtils.ts, registry.ts,
runtime.ts, security.ts, generic/refinements.ts, generic/vocabulary.ts): all
100% stmts/branch/funcs/lines. 286 tests total, all green. cParser.ts/
phpParser.ts/genericParser.ts show partial incidental coverage already (from
Phase 3 tests exercising real adapters) — expected, Phase 4 finishes them.
Rest of the repo still 0% (not yet reached). defaultHighscore.ts and
empty-node-shim.ts correctly absent from the report.

## Known open issues / deferred decisions

- main.ts (Phase 11) may need a testability-seam checkpoint with the user if
  exported-function + DOM-interaction tests genuinely can't reach full
  coverage on its ~40 unexported top-level closures. Not yet reached.
- Node installed is v18.19.1, which caps the Vitest/jsdom major versions
  usable (pinned to vitest@3.2.7/jsdom@26.1.0 — see Phase 0 notes above).
  If Node is ever upgraded to 20+, these can be bumped to latest majors, but
  that's not blocking anything right now.

## Next concrete step

Start Phase 4: src/parser/ wasm-runtime files (runtime.ts is already 100%
covered as a side effect of Phase 0/3, so really: c/cParser.ts,
php/phpParser.ts, generic/genericParser.ts, generic/languages.ts). Read
c/cParser.ts first (already read once during Phase 0's throwaway smoke
test — re-read for real this time), then php/phpParser.ts, then
generic/genericParser.ts + generic/languages.ts together (genericParser.ts
is the shared implementation all 12 non-C/PHP bundled languages route
through; languages.ts just wires up the 12 LanguageConfig instances with
their refinements.ts hooks — already indirectly exercised by Phase 3's
refinements.test.ts, but not through the real GenericParserAdapter.parse()
pipeline end-to-end yet). Follow the same "real grammar, real tiny source
snippet" pattern used successfully in Phase 3's astUtils.test.ts/
refinements.test.ts.
