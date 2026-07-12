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
- [x] Phase 4: src/parser/ wasm-runtime (5 files) — all of src/parser/ now
      100% (351 tests total repo-wide, all green). Notes for future reference:
  - cParser.ts, phpParser.ts: real-source tests (entities, complexity,
    nesting, gotos, comments, all 5 secretTrigger kinds where applicable).
    A handful of provably-hard-to-reach-via-valid-syntax branches (the
    "<anonymous>" name fallback for a function/entity, a top-level
    declaration with no identifiable name, the "parser returned no syntax
    tree" defensive throw) were covered via `vi.spyOn(Parser.prototype,
    "parse")` returning a fully synthetic fake tree/rootNode rather than
    fighting to construct valid-but-edge-case-triggering real source — this
    pattern (mock the whole tree, not just the source text) is worth reusing
    whenever a branch depends on an AST shape no valid syntax produces.
  - Sort-comparator tie-break gotcha: to actually exercise `a.startLine -
    b.startLine || a.endLine - b.endLine`'s right-hand side, two entities'
    startLine must be genuinely EQUAL (not just close/adjacent) — verify by
    checking the actual source layout, not just "two entities near each
    other," since a near-miss silently leaves the branch uncovered.
  - genericParser.ts + languages.ts: languages.test.ts parses one real tiny
    snippet through routine ALL 13 bundled generic-adapter languages
    end-to-end (javascript/typescript/tsx/python/java/cpp/go/rust/ruby/
    csharp/bash/scala/objc) — this alone got genericParser.ts to 100%
    stmts/funcs/lines from a single test file, branch gaps closed
    separately in genericParser.test.ts (filter true/false/undefined,
    method-vs-class code-smell-bonus branch, anonymous-node and
    tree-root-self-match defensive skips via synthetic trees, parser
    caching, "no syntax tree" throw). Found and fixed a test-writing mistake
    along the way: a filtered-out entity can still resurface separately as
    a heuristic "global" via genericGlobals — assert on `kind`, not mere
    name presence/absence, when testing a filter rejection.
  - Synthetic-tree mocks must be careful that `descendantsOfType`'s fake
    implementation only returns the intended fake node for the SPECIFIC
    type-name query it's meant to satisfy (e.g. check `types.includes(...)`)
    — a blanket `() => [fakeNode]` also answers unrelated internal calls
    (extractGotos's goto/label lookups, comment scanning) with the same
    shape-incomplete fake node and throws deep inside a helper with a
    confusing stack trace.
- [ ] Phase 5: src/map/ + src/map/generation/ (18 files) — IN PROGRESS
  - [x] src/map/types.ts (tile constants)
  - [x] src/map/generation/seed.ts
  - [x] src/map/generation/util.ts
  - [x] src/map/generation/geometry.ts
  - [x] src/map/generation/labyrinth.ts
  - [x] src/map/generation/corridors.ts
  - [x] src/map/generation/pathing.ts
  - [x] src/map/generation/breakup.ts (the hardest file in this phase, 402
        lines, 5 rounds of branch-gap iteration — see notes below)
  - [x] src/map/generation/doorsKeys.ts
  - [x] src/map/generation/pickups.ts
  - [x] src/map/generation/props.ts
  - [x] src/map/generation/enemies.ts
  - [x] src/map/generation/secretRooms.ts
  - [x] src/map/generation/teleporters.ts
  - [x] src/map/generation/trapsHazards.ts
  - [x] src/map/generation/lore.ts
  - [x] src/map/generation/spawnExit.ts
  - [ ] src/map/mapGenerator.ts (orchestrator, do last)
  - [ ] src/map/debugView.ts (needs test/mocks/canvas.ts — first real use)
  Notes: findPropSpot's PROP_CLEARANCE/PROP_SPACING rejection branches needed
  scripted (non-random) rng sequences to hit deterministically — a
  probabilistic seeded-rng test that merely *might* trigger a rejection
  branch is fragile and shouldn't be trusted for coverage; write a rng
  closure returning a controlled value sequence instead whenever a branch
  depends on a specific narrow numeric outcome. labyrinth.ts's connectivity
  guarantee was tested as a black-box invariant (a local flood-fill helper
  in the test file, not exported from source) rather than reaching into its
  private divide/floorComponents/bridgeComponents functions — matches how a
  real caller only ever sees the guarantee, not the internals.

  breakup.ts (402 lines, the hardest file in map/generation) took real
  effort to get to 100% branch — worth recording the techniques since
  they'll generalize to remaining files:
  - A corridor pinned to row y=1 (the minimum interior row) makes room
    injection geometrically impossible (`rect.y = run.fixed - offset` is
    always < 1 since offset >= 1) — the cleanest way to force the
    forced-jog fallback path deterministically without scripting rng.
  - A run of length exactly 10 makes `segments = ceil(10/10) = 1`, so
    `breakUpRunAtPoints`'s loop (`for s=1; s<segments`) never executes at
    all — the run skips the primary pass entirely and goes straight to the
    safety-net `breakUpRunWide` on the first rescan. Useful for isolating
    which pass (primary vs. wide-search) actually handled a given case.
  - A blocking Room placed *one row further back* than the corridor (not
    immediately adjacent) preserves `isChokePoint`'s precondition while
    still catching a jog's detour via `roomsOverlap`'s margin — placing it
    directly adjacent instead breaks the chokepoint check itself and the
    jog gets rejected for the wrong reason before ever reaching the
    overlap check you're trying to test.
  - Found 6 more provably-unreachable defensive branches (marked with v8
    ignore + rationale, not forced): two `loBound > hiBound` guards in
    `breakUpAtTarget`/`breakUpRunWide` (impossible given every `run` is
    already known > `MAX_CORRIDOR_STRAIGHT_LENGTH` by construction), and
    four `rect.w/h < 3` / `candidates.length === 0` guards in
    `breakUpRoomSightline` (impossible given `randomBreakupDim` always
    rolls >= `BREAKUP_ROOM_MIN_DIM` (3)).
  - When v8's compact coverage table truncates the uncovered-line list with
    a leading "...", don't trust it as complete — pull the untruncated list
    via `--coverage.reporter=json` and read `coverage-final.json`'s
    `branchMap`/`b` counts directly (a one-off Node script), or you'll
    think a branch is fixed when a different, still-uncovered one just
    scrolled out of view.

  doorsKeys.ts, pickups.ts, props.ts (11/18 done): a rng function that
  returns the exact same CONSTANT value on every call (e.g. `() => 0.5`) is
  a trap for anything that calls `findPropSpot` — since x/y candidate
  coordinates are recomputed identically every retry attempt, a constant
  draw can land exactly on the room's own center every single time (always
  rejected by the PROP_CLEARANCE check), silently exhausting all attempts
  and returning null instead of the success you intended to test. Fix: use
  a "scripted first call(s), then delegate to a real varying mulberry32"
  rng wrapper whenever you need to pin one specific roll (e.g. a
  chance-threshold check) while still letting downstream candidate-search
  calls vary naturally.

  lore.ts (16/18 done): for a function with a 3-way (or more) probabilistic
  branch fed by a LONG, hard-to-hand-derive rng call chain (shuffle, then
  candidate filtering, then a final roll — placeTodoEncounter's trap/mine/
  Bug enemy split), don't hand-count rng() calls to script a sequence —
  write a small throwaway Node probe script instead: bundle the real
  source with esbuild (mirroring scripts/lib/loadEngineModules.mjs's
  pattern), loop over mulberry32 seeds 1..N calling the real exported
  function directly, and print which seed produces each outcome you need.
  Bake the discovered seed into the real test with a comment noting it was
  found empirically. Must run `node` from the repo root (not the
  scratchpad) so `esbuild` resolves from node_modules, and delete the probe
  script when done — it's throwaway, not part of the suite. Also: a
  private helper only reachable through ONE gated code path (here,
  interiorNeighborOf is only ever called from inside placeTodoEncounter,
  which only runs for TODO-flagged comments) won't get exercised by a
  "same geometry, non-flagged comment" test even if the outer terminal
  placement succeeds identically — match the gating condition, not just
  the geometry, when hunting for a specific branch.
- [ ] Phase 6: src/engine/ pure-logic (13 files)
- [ ] Phase 7: src/engine/ browser-API (12 files)
- [ ] Phase 8: src/fs/ (3 files)
- [ ] Phase 9: src/ui/ (5 files)
- [ ] Phase 10: src/engine/engine.ts
- [ ] Phase 11: src/main.ts
- [ ] Phase 12: wrap-up (thresholds, CI, docs, notes, delete this file)

## Current coverage snapshot

src/difficulty.ts, src/prng.ts, all of src/wad/ (9 files), ALL of
src/parser/, and 17 of 18 Phase-5 files (everything except mapGenerator.ts
and debugView.ts) are 100% stmts/branch/funcs/lines. 568 tests total, all
green. Rest of src/map/ (2 files), src/engine/, src/fs/, src/ui/,
src/main.ts still 0% (not yet reached). defaultHighscore.ts and
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

Continue Phase 5: read src/map/mapGenerator.ts next (the orchestrator —
calls every module tested so far in a fixed order; write tests covering
its own wiring/branches plus a golden/determinism test: same seed + same
ParsedFile input must reproduce byte-identical output, call generate()
twice and deep-equal). Then src/map/debugView.ts last (first real use of
test/mocks/canvas.ts from Phase 0 — read that mock file first). Only 2
files left in Phase 5, then Phase 6 (src/engine/ pure-logic, 13 files)
starts.
