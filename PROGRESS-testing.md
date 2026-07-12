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
- [x] Phase 5: src/map/ + src/map/generation/ (18 files) — ALL 18 DONE, 100%
      stmts/branch/funcs/lines across the entire src/map/ tree, 238 tests.
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
  - [x] src/map/mapGenerator.ts (orchestrator) — **found and fixed a real bug**
        while writing this test, see notes below
  - [x] src/map/debugView.ts (last file — first real use of
        test/mocks/canvas.ts from Phase 0, worked correctly on the first try)
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

  mapGenerator.ts (orchestrator, 17/18 done): **found and fixed a real
  pre-existing bug while writing coverage, not just a coverage gap** —
  `placeFillerRoom`'s corner-fallback path didn't validate a corner
  candidate was actually within grid bounds. `roomDimensions` always
  returns >= 4 tiles regardless of the configured map `size`; on a
  pathologically tiny `minSize` (< ~9, never used by any real caller —
  default is 64) the "bottom-right" corners compute negative coordinates,
  and `carveRoom` then crashes writing to `grid[-1][...]`. Asked the user
  how to handle it (fix now / document gap / v8-ignore) rather than
  deciding unilaterally, since it's a correctness fix outside pure
  test-writing scope — they said fix it. Fix: filter corner candidates to
  ones that actually fit (`x>=0 && y>=0 && x+w<=size && y+h<=size`) before
  checking overlap, and clamp the final last-resort fallback's width/height
  to whatever room the grid actually has (`Math.min(w, Math.max(1, size -
  2))`) instead of trusting the raw dimensions. Verified both by the new
  unit test AND by rerunning `npm run verify:campaign` (the project's own
  real-world 17-language integration check) — passed clean, confirming the
  fix doesn't change behavior for any realistic map size. General lesson:
  a coverage-hunting test that finds a genuine crash isn't a test bug to
  paper over — stop and ask before either fixing engine code or hiding the
  gap, since "should I fix a newly-found bug" is a decision only the user
  should make, not something to resolve unilaterally mid-test-writing.
- [x] Phase 6: src/engine/ pure-logic (13 files) — COMPLETE
  - [x] src/engine/weapons.ts
  - [x] src/engine/player.ts
  - [x] src/engine/ammo.ts
  - [x] src/engine/enemyAi.ts (the most intricate file in this phase — full
        AI state machine, 25 tests, needed careful same-tile/wall-standing
        edge cases to close the last 2 branches)
  - [x] src/engine/pathField.ts
  - [x] src/engine/lootApply.ts
  - [x] src/engine/loot.ts
  - [x] src/engine/replay.ts
  - [x] src/engine/scoring.ts
  - [x] src/engine/spatialGrid.ts
  - [x] src/engine/traps.ts
  - [x] src/engine/storageCompression.ts
  - [x] src/engine/highscores.ts
  - [ ] src/engine/spatialGrid.ts
  - [ ] src/engine/traps.ts
  - [ ] src/engine/storageCompression.ts
  - [ ] src/engine/highscores.ts (last — dynamically imports the excluded
        defaultHighscore.ts, needs jsdom for localStorage)

  enemyAi.ts notes (most intricate file this phase, full AI state machine):
  a real `Player`/`PathField` instance (both already-tested Phase 6
  classes) plus a hand-built minimal `GameMap`/`Enemy` gave far higher
  fidelity than mocking would have, and cost nothing extra since both were
  already unit-tested in isolation. Two closing-the-last-branches tricks
  worth remembering: (1) "enemy and player share a floor tile but are still
  outside melee range" is reachable (ATTACK_RADIUS is a real distance, not
  "same tile") by placing both near opposite corners of one tile — e.g.
  (5.05,5.05) and (5.95,5.95), same `Math.floor` tile, distance ~1.27 >
  ATTACK_RADIUS(0.5); (2) forcing "the player's own tile is a wall" only
  needs `player.noClip = true` plus positioning inside a wall tile — the
  line-of-sight ray-march samples strictly between the two endpoints
  (`i < steps`, never `t=1`), so it doesn't itself get blocked by the
  destination tile being solid, meaning aggro/fire can still resolve
  normally even while the player literally stands inside a wall.

  replay.ts notes: straightforward once read in full — hit 100% on the
  first attempt, no branch-gap iteration needed. `LevelRecorder` isn't
  exported (private to `CampaignReplayRecorder`) but every one of its
  branches (MAX_REPLAY_FRAMES_PER_LEVEL overflow + warn-once, zero-frame
  levels dropped) is reachable indirectly through the public recorder API.
  `MAX_REPLAY_LEVELS`(100)/`MAX_REPLAY_FRAMES_PER_LEVEL`(21600) caps are
  cheap to exceed in a real loop (just array pushes) — no need to fake the
  constants. `console.warn` spied/suppressed via
  `vi.spyOn(console, "warn").mockImplementation(() => {})`, matching the
  established pattern from earlier phases.

  scoring.ts notes: also 100% on the first attempt. Only real trap was
  `mapCompletionBonus`'s strict `>` threshold — the boundary value itself
  (0.95) must NOT award the bonus, only something strictly above it.
  Otherwise mechanical: one test pair (starting-pool > 0 vs === 0) per
  ammo fraction ternary, clamp01 exercised at both ends (negative and
  >1 inputs) via the map-completion fraction, and the speed-bonus decay
  checked at under/at/between/at-double/past-double the target time.

  spatialGrid.ts notes: also 100% on the first attempt. The one
  non-obvious case worth remembering: `queryIndices()`'s ascending sort
  is not a no-op — the bucket walk order is row-major over the query
  circle's AABB (`cy` outer, `cx` inner), so a *higher* array index
  bucketed into an earlier-visited tile and a *lower* index in a
  later-visited tile arrive in descending raw order; the test
  constructs exactly that (enemies[0] on the higher-y tile, enemies[1]
  on the lower-y tile) to prove the `.sort()` call is load-bearing, not
  dead code. Also: `anyWithin()` re-checks `e.alive` per the class's
  own documented contract (buckets are alive-only at rebuild time, but
  an enemy can die between rebuild and query) — tested by flipping
  `e.alive = false` on an already-bucketed enemy instance and confirming
  `anyWithin` no longer finds it.

  traps.ts notes: also 100% on the first attempt. Used a real `Player`
  instance (already-tested Phase 6 class) with `posX`/`posY` overwritten
  directly after construction, same "reuse an already-tested real
  fixture instead of mocking" pattern as `enemyAi.ts`. Key branch traps:
  `detonateMine`'s falloff floor needed a distance placed just inside
  the blast radius (`MINE_BLAST_RADIUS - 0.01`) to force `1 -
  distance/radius` below `MINE_DAMAGE_FALLOFF_FLOOR`; `updateMines`'s
  sight-radius stickiness needed two separate tests (unseen mine staying
  unseen vs. an already-seen mine staying seen) since it's one boolean
  OR-into, not a toggle; and "never assumed capped at 1" detonation per
  frame got its own explicit two-mines-at-once test.

  storageCompression.ts notes: also 100% first attempt, no mocking of
  CompressionStream/DecompressionStream needed for the happy paths —
  Node 18.19.1 has both natively, confirmed by Phase 0 research. Only
  the "unavailable" and "throws" branches needed `vi.stubGlobal` (with
  `vi.unstubAllGlobals()` in `afterEach` so the stub doesn't leak into
  later tests that need the real API). The "compression doesn't
  actually shrink it" fallback branch was the only non-obvious case —
  needed a genuinely tiny value (`1`) since gzip's fixed per-stream
  overhead makes anything below roughly a few dozen bytes bigger
  compressed than plain, not smaller.

  highscores.ts notes: the one real gotcha this phase — jsdom's built-in
  `crypto` global has no `SubtleCrypto` implementation (`crypto.subtle`
  is `undefined`), so `hashRun()`'s `crypto.subtle.digest(...)` call
  threw under `@vitest-environment jsdom` even though the exact same
  code works fine in a real browser and in plain Node. Fixed by
  `vi.stubGlobal("crypto", webcrypto)` (from `node:crypto`) in a
  `beforeAll` — Node's real webcrypto has a full `subtle.digest`
  implementation, so this isn't a mock of the behavior, just swapping in
  a working native implementation jsdom happens to omit. Worth
  remembering for any other jsdom test file that touches
  `crypto.subtle` (none currently do, but Phase 7+ might). Also: the
  quota-exceeded retry ladder in `recordHighscore` needed a **multi-entry**
  board to hit 100% branch coverage — `withoutThisReplay`'s `board.map((e)
  => e === entry ? ... : e)` has a real "some other entry, leave it alone"
  branch that a single-entry board can never exercise; seeded a second
  recorded entry with its own replay first, then asserted it survived the
  retry untouched while only the failing run's replay was stripped.
  `loadHighscoresForDisplay`'s empty-board fallback test needs a longer
  timeout (30s) since it actually dynamically imports the real
  115k-line `defaultHighscore.ts` — slow to parse/transform under
  vite-node but not something to work around, it's exactly the code path
  a first-time player hits.

  **Phase 6 complete (13/13 files), all 100% stmts/branch/funcs/lines.**
- [x] Phase 7: src/engine/ browser-API (12 files) — COMPLETE
  - [x] src/engine/audio.ts
  - [x] src/engine/bgm.ts
  - [x] src/engine/input.ts
  - [x] src/engine/automap.ts
  - [x] src/engine/effects.ts
  - [x] src/engine/hud.ts
  - [x] src/engine/projectiles.ts
  - [x] src/engine/rockets.ts
  - [x] src/engine/raycaster.ts
  - [x] src/engine/sprites.ts
  - [x] src/engine/textures.ts
  - [x] src/engine/viewmodel.ts

  audio.ts notes: 100% took two rounds. First round hit a real gap in
  the shared `test/mocks/audio.ts` helper, not the source under test —
  `mockAudioNode()`'s `connect` was a bare `vi.fn()` returning
  `undefined`, so `AudioManager.resume()`'s
  `master.connect(comp).connect(ctx.destination)` chaining call crashed
  (`Cannot read properties of undefined (reading 'connect')`). No test
  before this one had exercised `resume()`'s full graph-building path
  (Phase 5's `debugView.ts` only used the canvas mock, not audio) — real
  `AudioNode.connect()` returns its destination argument specifically to
  support chaining, so fixed by making the mock's `connect` do the same
  (`vi.fn((destination) => destination)`). This is a shared-mock fix,
  not an app-code fix — same "trust but verify the test double against
  the real API contract" lesson as other mock gaps found this project,
  just the first time it showed up in `test/mocks/`. Also needed
  `@types/node` as a new devDependency (added, pinned to `^18` to match
  the installed Node 18.19.1) — unrelated to audio.ts itself, but
  surfaced because `highscores.test.ts`'s `import { webcrypto } from
  "node:crypto"` (added last phase to work around jsdom's missing
  `crypto.subtle`) had never actually been typechecked after that edit;
  typecheck was run again fresh for this file and caught the gap.
  Otherwise mechanical: singleton `AudioManager` instance required
  `vi.resetModules()` + a fresh dynamic `await import("./audio")` per
  test (in `beforeEach`) since `unavailable`/`ctx` are sticky private
  state that would otherwise leak between tests; `Ctor` selection
  (`AudioContext ?? webkitAudioContext ?? null`), the automation gate's
  stickiness, the pending-volume-before-context-exists queue, the
  distortion-curve cache, and the per-duration noise-buffer cache each
  got a dedicated test.

  bgm.ts notes: one real cross-test-authoring bug and one genuine
  unreachable-branch case. (1) The shuffled-wraparound test initially
  forgot to stub `AudioContext` — the first `wireAndPlay()` call's
  `audio.resume()` then hit the "no Ctor available" path, which sets
  `AudioManager`'s **sticky** `unavailable` flag permanently, silencing
  every later track's `wireAndPlay()` (including its `el.play()` call)
  for the rest of that test — a reminder that `isSilenced()`'s
  stickiness (already documented from audio.ts's own tests last file)
  bites any *caller* of `audio.resume()` too, not just direct callers of
  `isSilenced()`. Fixed by stubbing `AudioContext` in that test. (2)
  `playCurrent()`'s own `if (this.handles.length === 0) return;` is
  provably unreachable — both of its callers (`loadFolder`, `advance`)
  already guard against an empty playlist before ever calling it —
  marked with `/* v8 ignore next */` (rationale in a `//` comment right
  above, matching the existing pattern in `parser/registry.ts`; the
  ignore directive itself must be a bare single-line `/* v8 ignore
  next */` immediately before the target line — a multi-line block
  comment combining the rationale and the directive together did NOT
  get recognized by v8-to-istanbul). Otherwise: `new Audio()`
  (`HTMLAudioElement`) needed `vi.spyOn(HTMLMediaElement.prototype,
  "play"/"pause")` since jsdom's real implementations are unimplemented
  stubs; `URL.createObjectURL`/`revokeObjectURL` needed direct
  overwriting (jsdom doesn't implement them for arbitrary non-Blob fake
  file objects); the private `el` field was reached via `(bgm as
  unknown as { el: HTMLAudioElement }).el` to dispatch a real `"ended"`
  Event and drive `advance()`; async event-driven assertions used
  `vi.waitFor(...)` rather than a fixed `setTimeout` flush, since the
  number of microtask hops between dispatch and the resulting
  `play()`/`createMediaElementSource()` call isn't worth hand-counting.

  input.ts notes: the biggest/densest file so far (666 lines — keyboard,
  mouse, gamepad, pointer lock, fullscreen, cheat codes) but hit 100% on
  the very first coverage run, 61 tests, once two jsdom/IEEE-754
  environment quirks (not app bugs) were worked around: (1)
  `gamepadForward()` is `-this.gamepadMoveY`, and negating the default
  `+0` axis reading produces `-0` — `-0` fails Vitest's `toBe(0)`
  (`Object.is` semantics) even though it's numerically equal, so those
  specific zero-assertions use `.toBeCloseTo(0)` instead. (2) jsdom's
  `MouseEvent` constructor silently drops `movementX` from its init
  dict (it stays `0` regardless of what's passed), so `e.movementX`
  read back as `undefined` inside `onMouseMove`, turning
  `this.mouseDX += e.movementX` into `NaN` — worked around with a small
  `mousemove(dx)` test helper that constructs a bare `MouseEvent` then
  `Object.defineProperty`s `movementX` onto it directly. Pointer Lock
  (`document.pointerLockElement`, `canvas.requestPointerLock`,
  `document.exitPointerLock`) and the Fullscreen API
  (`document.fullscreenElement`, `requestFullscreen`/`exitFullscreen`)
  aren't implemented by jsdom at all, so both were hand-stubbed directly
  on `document`/the test canvas in `beforeEach` — `pointerLockElement`/
  `fullscreenElement` via `Object.defineProperty` (plain assignment
  fails, they're getter-only on the real interfaces) and the four
  methods as plain `vi.fn()` overwrites. `navigator.getGamepads` doesn't
  exist in jsdom either, so it's assigned directly onto the real
  `navigator` object per test (never `vi.stubGlobal("navigator", ...)`
  — replacing the whole object risks breaking jsdom internals that read
  other `navigator` properties). One dispatch-target subtlety: Escape is
  the only key bound to `window` rather than the canvas (see the
  source's own `onWindowEscape` doc comment for why), so its test helper
  dispatches on `window`, unlike every other key which dispatches on the
  canvas.

  automap.ts notes: needed `createMockCanvasContext` directly (not
  `stubCanvasGetContext`) since `drawAutomap(ctx, map, player, levelTime)`
  takes the 2D context as a plain parameter rather than calling
  `canvas.getContext("2d")` itself — `MockCanvasContext` only implements
  a subset of the real `CanvasRenderingContext2D` interface by design, so
  every call site needs an explicit `ctx as unknown as
  CanvasRenderingContext2D` cast (wrapped in a local `asCtx()` helper to
  avoid repeating it ~25 times). A real `GameMap`-shaped fixture (mirroring
  `pathField.test.ts`/`traps.test.ts`'s `fakeMap`) plus a minimal fake
  `Player` object literal (just `posX`/`posY`/`dirX`/`dirY` — no need to
  construct a real `Player` instance here, unlike `traps.test.ts`, since
  none of `Player`'s own methods are called). Two real gotchas: (1)
  `drawAutomap` always paints one translucent panel `fillRect` before any
  tile/mine/exit rendering — every "was `fillRect` called N times"
  assertion needs an `extraFillRectCalls()` helper subtracting that
  baseline call, not a raw call count; (2) an exit tile that's also a
  *visited floor tile* gets drawn twice — once by the general tile loop
  (as ordinary floor), once by the dedicated exit-marker code layered on
  top — so "renders the exit" asserts 2 fillRect calls, not 1. The
  camera-pan clamp branches (`map.width <= viewTilesW` centered vs. the
  clamped-pan formula) were verified by placing the player at the map's
  extreme corners and checking that tile (0,0) (or the last tile) lands
  at the exact expected pixel offset — precise enough to pin the formula
  without hand-deriving float camera positions for every test.

  effects.ts notes: 100% on the first real run (after a Bash-outage
  interruption mid-write — see the "resume from interruption" story
  above; a manual read-through while Bash was down caught one bug in
  the test itself before ever running it). Used a real `Player`
  instance via `new Player(fakeMap())` facing +X by default and placed
  particles 3 tiles ahead along X — `projectPoint`'s camera-inverse math
  (from `sprites.ts`, imported by `effects.ts`) then gives a clean,
  predictable `depth=3`/`screenX=width/2` without hand-deriving the
  transform. Every render* function (`renderExplosions`,
  `renderBurnParticles`, `renderExplosionParticles`, `renderBlood`)
  shares the same two skip-branches (too-close depth, z-buffer
  occlusion) — note `renderBlood`'s depth threshold is `0.2`, the other
  three use `0.1`; doesn't matter for a "particle at the player's exact
  position" test (depth=0 either way) but would matter for a
  boundary-precision test. `updateBurnParticles`/`updateBlood` both
  needed a **second** call in the same test to hit "already-settled,
  don't re-reset life" branches — the first call's landing transition
  and a later call's steady-state decay are genuinely different code
  paths through the same `if` block.

  hud.ts notes: 100% took two rounds — first pass landed at 93.33%
  branch, missing the `<=0` (red/empty) side of the rockets/smg/gas
  ammo-color ternaries (only `bullets<=0` had been tested; the other
  three ammo types were only exercised with a positive value). Fixed
  with one more test per ammo type. One test-authoring lesson: `fillRect`
  calls carry no per-call fillStyle in the mock (`fillStyle` is a plain
  mutable field, not snapshotted per invocation), so "was the stability
  bar drawn in red vs green" can't be checked via the mock's default
  call-args recording — needed a small `fillRectStylesLog()` helper that
  overrides `fillRect`'s mock implementation to push the *currently
  active* `fillStyle` onto a log array at each call, then asserts
  `log.toContain(...)`. `drawLoreOverlay`'s word-wrap was tested via
  `ctx.measureText`'s existing mock formula (`text.length * 6`) to
  hand-pick word lengths that either always stay under `maxWidth` (no
  wrap) or force a mid-paragraph split — and separately, explicit `\n`
  hard-breaks (a different code path: `text.split("\n")`, not the
  greedy-fill word loop) needed their own dedicated test. Body-line
  `fillText` calls were isolated from the fixed header/footer calls via
  `calls.slice(1, -1)` (call order is fixed: header, then N visible body
  lines top-to-bottom, then footer) rather than trying to match on
  `fillText`'s numeric x/y position args.

  projectiles.ts notes: small, clean file — 100% on the first attempt,
  13 tests. `collectProjectileBillboards` just wraps `sprites.ts`'s
  `collectOrbBillboards` with a fixed magenta palette, which itself
  returns an array of `{ depth, draw() }` jobs rather than drawing
  immediately — depth-culling (too close to the player) happens eagerly
  when building the job list, but z-buffer occlusion is checked lazily
  *inside* `draw()`, so an occluded bolt still produces a job (length 1)
  that simply draws nothing when invoked — two genuinely different
  places in the pipeline, needing two different tests rather than one
  "is it drawn" check. `updateProjectiles`' player-hit-vs-wall-hit
  priority (`continue` after a hit skips the wall check) was tested by
  literally putting a wall tile under the player's own feet and firing a
  bolt at point-blank range — confirms the hit still counts as a player
  hit, not silently absorbed by the wall check first.

  rockets.ts notes: near-identical shape to projectiles.ts (same author,
  same doc comment cross-references it explicitly) — 100% on the first
  attempt, 14 tests, reusing the exact same test structure/helpers.
  Only real difference worth noting: `updateRockets`' detonation
  condition is `hitEnemy || hitWall` where `hitEnemy` comes from an
  injected `nearLivingEnemy(x, y, radius)` callback (the caller's
  spatial-grid query, not a real dependency this test needs to fake
  beyond a plain function) — needed a dedicated test asserting the
  callback is actually called with the rocket's *post-move* position and
  the exact `ROCKET_ENEMY_TRIGGER_RADIUS` constant, plus one test with
  both OR operands true at once (near an enemy AND in a wall
  simultaneously) to confirm it only detonates once, not twice.

  raycaster.ts notes: the biggest/most intricate file in the whole
  project so far (DDA wall raycasting + per-pixel floor-casting +
  minimap, ~590 lines) — took several rounds but landed at 100%, 27
  tests. Real gotchas, roughly in the order they bit:
  1. **Module-graph side effect on import, not something a test can
     defer.** `raycaster.ts` imports a real *value* (`LORE_BASE`, not
     just types) from `textures.ts`, whose module scope constructs a
     `TextureManager` singleton that calls `document.createElement`
     and `canvas.getContext("2d")` immediately at import time. Since ES
     module imports are hoisted ahead of *all* other top-level code —
     including a `beforeAll` — a plain `import { renderScene } from
     "./raycaster"` at the top of the test file fails before any test
     setup can run, even under `@vitest-environment jsdom` (jsdom's
     canvas doesn't implement `getContext` at all without the `canvas`
     npm package). Fixed by NOT statically importing `raycaster.ts` —
     instead `stubCanvasGetContext()` runs first in a `beforeAll`, then
     `renderScene`/`renderMinimap`/`FOG_FAR` are bound from a dynamic
     `await import("./raycaster")` afterward. Worth remembering for
     `sprites.ts`/`viewmodel.ts`/`engine.ts` next — any of them
     importing a *value* (not just a type) from `textures.ts` will hit
     the exact same problem.
  2. **A "doesn't throw" test can silently cover 0% of what it looks
     like it's testing.** The floor-cast sweep's exact tile-by-tile
     path depends on player position/facing/viewport geometry in a way
     that's impractical to hand-predict — an initial test that placed
     a hazard/teleporter/spike tile at a few fixed grid cells and just
     asserted `not.toThrow()` left the actual per-tile-kind floor
     texture ternary at under 100% branch coverage, because the sweep
     never actually happened to land on any of those cells. Fixed by
     filling the *entire* map interior with one target tile kind per
     test (guaranteeing the sweep lands on it somewhere), then reading
     the real output pixels back out of the `putImageData` call's
     `ImageData.data` and asserting the target texture's (uniquely
     colored, since the test fixture textures are flat-filled) RGB
     triplet is actually present — real behavioral verification, not
     just absence-of-crash.
  3. Two more branch gaps closed by v8's report after that: a same-row
     wall top/bottom edge-antialiasing skip (needs a wall far enough
     away — a 300-tile corridor — that its whole on-screen height
     collapses into a single pixel row) and the minimap's edge-case
     enemy color branch (the fixture only had one `edgeCase: false`
     enemy; added a second `edgeCase: true` one).
  4. `renderMinimap`/`renderScene`'s lore-terminal/spike/exit pulse
     animations call the real `performance.now()` directly — no mock
     needed, matching Phase 0's original research.

  sprites.ts notes: as predicted in the prior next-step note, this one
  only imports *types* from other engine modules, so a plain static
  import + `test/mocks/canvas.ts` worked with no jsdom/dynamic-import
  workaround needed — confirms that gotcha is specific to files with a
  real *value* import from `textures.ts`. 100% on the first attempt, 58
  tests, despite being the largest file by symbol count so far (~20
  exported functions, mostly `collect*Billboards` sharing one shape:
  filter alive/visible → project → filter by a depth threshold → map to
  a `{ depth, draw() }` job with a lazy occlusion check inside `draw()`)
  — the repetition made most of it mechanical once the pattern was
  established. Two things worth remembering: (1) a naive
  `expect(x || true).toBe(true)` tautology crept into a first draft (an
  attempt to check the hit-flash red tint) and had to be rewritten using
  the `fillRectStylesLog()`-style "capture fillStyle at each fillRect
  call" technique from hud.ts's notes — fillStyle is overwritten later
  by the HP-bar/label overlay, so the final state alone doesn't prove
  the body was ever drawn in the flash color. (2) `findTargetInProjections`/
  `findMineInProjections`'s vertical AABB check (`cy < proj.top || cy >
  proj.bottom`) is provably unreachable *through the real
  `projectEnemy`/`projectPoint` pipeline* — every projected box is
  constructed symmetrically around `height/2`, and `cy` is always
  exactly `height/2` — but since both functions take plain projection
  data as a parameter (not something only `projectPoint` can produce),
  a hand-built synthetic `proj` object with deliberately mismatched
  `top`/`bottom` values exercises the branch honestly without needing a
  `v8 ignore` comment or touching source at all — testing the function
  against its full input contract rather than only realistic callers.

  textures.ts notes: confirmed (not just predicted) it needed the same
  jsdom + stub-canvas-before-dynamic-import pattern as raycaster.ts —
  its own module-level `export const textures = new TextureManager()`
  singleton builds every procedural default texture via
  `document.createElement("canvas")` at import time. 100% on the first
  attempt, 8 tests. Rather than constructing a real in-memory WAD file
  (the `scripts/fixtures/buildTestWad.mjs` route Phase 2 used),
  `../wad/loadWad`'s `loadWadTextures` was mocked directly via
  `vi.mock` — `loadWad.ts` is already fully unit-tested in its own
  right (Phase 2), so re-exercising its internals here would just be
  redundant; textures.ts's own unit only needs to be tested against
  `loadWadTextures`'s *contract* (a `WadLoadResult` shape), not its
  real WAD-parsing behavior. `TextureManager.loadFromWad`'s 10
  independent `result.xTexture ? bitmapFromWadPixels(...) :
  this.defaults.x` ternaries were covered economically with just two
  calls — one `WadLoadResult` with all 10 texture slots present (covers
  every ternary's true branch at once), one with all 10 absent (covers
  every false branch at once) — rather than 20 separate single-slot
  tests. The two `if (!ctx) throw ...` defensive checks (in `makeCanvas()`
  and `bitmapFromWadPixels`, both hit when `canvas.getContext("2d")`
  returns null) were tested directly by calling
  `HTMLCanvasElement.prototype.getContext.mockImplementationOnce(() =>
  null)` right before the one call meant to trip it — `mockImplementationOnce`
  only consumes a single future invocation, so every other test in the
  file keeps using the real (stubbed) working context uninterrupted.

  viewmodel.ts notes: 100% on the first attempt, 17 tests — the
  simplest Phase-7 file by far (pure Canvas 2D drawing, one exported
  function `drawWeapon` dispatching on `WeaponViewKind` to 7 per-weapon
  draw routines, no module-scope singleton, no value import from
  textures.ts, so a plain static import worked with no jsdom/dynamic-
  import workaround at all). The one thing worth remembering: knife and
  chainsaw never reference `v.flash` at all (a stab/revving swing has no
  muzzle flash), so their "flash is ignored" behavior was verified
  directly by comparing `beginPath` call counts between `flash: true`
  and `flash: false` and asserting they're *equal* — the mirror image of
  the 5 ranged weapons' tests, which assert the count is *greater* with
  flash on (each additional muzzle-flash/flame-burst draw call adds its
  own `beginPath()`).

  **Phase 7 complete (12/12 files), all 100% stmts/branch/funcs/lines.**
- [ ] Phase 8: src/fs/ (3 files) — IN PROGRESS
  - [x] src/fs/workspace.ts
  - [x] src/fs/demoCampaign.ts
  - [ ] src/fs/github.ts (next — last Phase-8 file)

  workspace.ts notes: 100% on the first attempt, 16 tests. The
  `test/mocks/fsAccess.ts` fake (`FakeFileSystemDirectoryHandle`/
  `FakeFileSystemFileHandle`, built way back in Phase 0 but never
  actually exercised until now) matched `readDirectoryTree`'s real
  calls (`entry.kind`, async-iterable `values()`, `getFile()`) exactly
  — no changes needed to the shared mock, first time all session a
  Phase-0 mock has needed zero adjustment on first real use.
  `window.showDirectoryPicker` doesn't exist on jsdom's `Window` by
  default, so `isFileSystemAccessSupported()`'s false case needed no
  setup at all, and the true/stubbed cases + `pickDirectory`'s tests
  assign it directly as a plain property (cast through `unknown`) rather
  than `vi.stubGlobal` (stubGlobal replaces the *global* binding, not a
  property *on* the existing `window` object, and this API is read as
  `window.showDirectoryPicker`, not a bare global identifier) — cleaned
  up via `delete` in `afterEach` so it doesn't leak into other tests in
  the file.

  demoCampaign.ts notes: 100% took two rounds. `import.meta.glob`
  resolved against the real `demo-campaign/` directory exactly as
  predicted, no mock needed — tests just call `loadDemoCampaignTree()`
  directly and assert against the real 17 bundled files (`main.c` +
  `stage02`..`stage17`). First round landed at 83.33% branch: the
  `modulePath.split("/").pop() ?? modulePath` fallback is unreachable
  with real glob'd paths (they always contain "/", and
  `Array.prototype.split` never returns an empty array) — same
  "provably unreachable `?? ` fallback" pattern already documented in
  `src/parser/registry.ts`. Marked with `/* v8 ignore next */` plus a
  rationale comment, mirroring that file's existing style.
- [ ] Phase 9: src/ui/ (5 files)
- [ ] Phase 10: src/engine/engine.ts
- [ ] Phase 11: src/main.ts
- [ ] Phase 12: wrap-up (thresholds, CI, docs, notes, delete this file)

## Current coverage snapshot

src/difficulty.ts, src/prng.ts, all of src/wad/ (9 files), ALL of
src/parser/, ALL of src/map/ (Phase 5 complete), ALL 13 of Phase 6,
ALL 12 of Phase 7 (Phase 7 complete), and 2 of 3 Phase-8 files
(workspace.ts, demoCampaign.ts) are 100% stmts/branch/funcs/lines. 1144
tests total, all green. Rest of src/fs/ (github.ts), src/ui/,
src/engine/engine.ts, src/main.ts still 0% (not yet reached).
defaultHighscore.ts and empty-node-shim.ts correctly absent from the
report.

## Known open issues / deferred decisions

- main.ts (Phase 11) may need a testability-seam checkpoint with the user if
  exported-function + DOM-interaction tests genuinely can't reach full
  coverage on its ~40 unexported top-level closures. Not yet reached.
- Node installed is v18.19.1, which caps the Vitest/jsdom major versions
  usable (pinned to vitest@3.2.7/jsdom@26.1.0 — see Phase 0 notes above).
  If Node is ever upgraded to 20+, these can be bumped to latest majors, but
  that's not blocking anything right now.

## Next concrete step

Finish Phase 8: read src/fs/github.ts next (already read once this
session in full — 199 lines), write github.test.ts. Needs
`vi.stubGlobal("fetch", vi.fn())`, driven with `mockResolvedValueOnce`
chains matching call order per test:
1. `parseGithubRepoInput(input)` — pure regex parsing, no fetch needed:
   test full URLs (with/without `https://`, with/without `www.`,
   with/without trailing slash), bare `owner/repo` shorthand, a
   trailing `.git` suffix stripped, and an unparseable input returning
   `null`. Also confirm urlMatch takes precedence when both regexes
   could theoretically match (`m = urlMatch ?? shortMatch`).
2. `fetchGithubTree(ref, onTreeBytes?, signal?)` — two sequential
   fetches: `resolveDefaultBranch` (repo info, extracts
   `default_branch`) then the recursive tree fetch. Each needs its own
   `!res.ok` failure test (distinct error messages: "not found or
   inaccessible" vs "Failed to fetch repository tree"). Test
   `treeJson.truncated` both true (console.warn — `vi.spyOn(console,
   "warn").mockImplementation(() => {})`) and false/undefined (no
   warn). Test `signal` is actually threaded through to both `fetch`
   calls' options (assert on the mock's call args).
3. `readJsonWithProgress` — the interesting one. Non-streaming fallback
   (`!onBytes || !res.body`) is simple: a fake `Response`-shaped object
   with just `.json()`. The streaming path needs a fake `.body` with a
   `.getReader()` returning an object whose `.read()` is scripted via
   `mockResolvedValueOnce` for a `{done:false,value:<Uint8Array
   chunk>}` sequence ending in `{done:true,value:undefined}` — assert
   `onBytes` was called with the correct cumulative byte counts, and
   that the merged/decoded JSON matches (build the encoded bytes with
   `new TextEncoder().encode(JSON.stringify(...))`, sliced into 2+
   chunks to prove the merge logic, not just a single-chunk pass-through).
4. `buildTree`/`sortRecursively` (both private, exercised only via
   `fetchGithubTree`'s return value) — test: `entry.type !== "blob"`
   entries (real GitHub trees include `"tree"` type entries for
   directories) are skipped/synthesized rather than causing duplicate
   nodes; a path segment matching `IGNORED_DIRECTORIES` drops that
   whole file; nested directories get created once and reused for
   later files in the same directory (`ensureDir`'s `dir ??=` cache
   hit vs miss); final tree is sorted directories-first-then-alpha at
   every level (reuse `compareNodes`'s already-proven semantics from
   workspace.test.ts).
5. `GithubFileHandle.getFile()` (private class, exercised via a tree
   node's `handle` after `fetchGithubTree`) — first call fetches from
   the correct `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`
   URL and caches; a second call reuses the cache without fetching
   again (assert `fetch` call count stays at whatever it was); a
   non-ok response throws with status/statusText in the message.
Verify 100%, commit (own commit — Phase 8 will then be complete, 3/3).
Then Phase 9 (src/ui/, 5 files), Phase 10 (engine.ts), Phase 11
(main.ts), Phase 12 (wrap-up). 2/3 Phase-8 files done.
