# Architecture

Codeenstein 3D is built as four strictly-layered stages, each of which only knows about the plain-data contract the previous stage hands it:

```
fs  →  parser  →  map  →  engine
```

For the actual file listing, see the root [`README.md`](../../README.md)'s "Project Structure" section. This document covers the contracts and rules between layers, and why they exist — for *why a given rule was chosen over an alternative*, see [Design Decisions](decisions.md).

## `fs` — source acquisition

`src/fs/workspace.ts` (local, via the File System Access API), `src/fs/github.ts` (a public GitHub repo's tree + lazily-fetched raw file content), and `src/fs/demoCampaign.ts` (the bundled `demo-campaign/` showcase campaign, inlined into the app's own bundle at build time via `import.meta.glob` — no picker, no network) all produce the same `TreeNode` shape. Nothing downstream — file tree UI, entrypoint detection, level launching, replay — ever special-cases which one supplied a given file; a `TreeNode`'s `handle` is a union wide enough to cover a real `FileSystemFileHandle` and a minimal `RemoteFileHandle` (which the demo loader also uses, wrapping an already-in-memory string instead of a network fetch).

## `parser` — source → normalized AST data

`src/parser/types.ts` defines `ParsedFile` and states the rule directly in its own doc comment: *"This module defines the ONLY shape the rest of the engine is allowed to know about... Nothing outside `src/parser/` should import `web-tree-sitter`."* A `ParsedFile` is plain, serializable JSON: `language`, `linesOfCode`, `entities` (functions/methods/classes/globals, each with a `complexityScore` and `nestingDepth`), `gotos` (resolved `goto`/label pairs), `comments` (large comment blocks), and `secretTriggers` (dead code, empty catch blocks, deprecation markers, commented-out code, and magic-number/blob literals — source for secret rooms).

Dispatch is by file extension (`src/parser/registry.ts`), against a single shared Tree-sitter WASM bootstrap (`src/parser/runtime.ts`, `Parser.init()` memoized so it only runs once regardless of how many adapters need it). PHP and C get bespoke, hand-written adapters — their grammars have quirks (PHP's global-variable-at-program-scope detection, C's buried function declarator) a generic traversal can't capture precisely. The other 12 bundled languages share one data-driven `GenericParserAdapter` (`src/parser/generic/`), driven by a shared node-type vocabulary rather than 12 separate hand-written adapters — see [Dependency Minimalism](decisions.md#dependency-minimalism).

`src/parser/security.ts` sits ahead of every adapter: an extension whitelist (only extensions a registered adapter claims ever reach a parser), a 4 MiB size cap, and a binary-content sniff (non-printable byte ratio over a sample window). Its own doc comment is explicit about scope: *"Nothing in this file — or anywhere else in `src/parser/` — ever evaluates, compiles, or executes the text it inspects. Source text is only ever handed to `Parser.parse()` ... or plain string/regex scans."* A parse failure logs a warning and skips the file rather than crashing the map generator or game loop.

## `map` — AST data → level data

`src/map/mapGenerator.ts`'s `MapGenerator.generate(parsed: ParsedFile, ...)` turns a `ParsedFile` into a `GameMap` (`src/map/types.ts`): a tile grid plus `Enemy[]`, `Room[]`, hazards, doors, keys, teleporters, traps, and pickups. Like `ParsedFile`, a `GameMap` is plain, serializable data — nothing in it references the engine, the player, or the DOM. Generation is deterministic: a seed is derived from a hash of the parsed AST itself (`seedFrom()`), fed through the shared `mulberry32` PRNG (`src/prng.ts`), so the same source file always yields the same map.

One post-carve pass doesn't derive from the AST at all: `breakUpLongCorridors` scans the fully-carved grid for straight corridor runs past a length threshold and interrupts each one with a small injected room (or a forced jog if the room won't fit), tracked separately as `GameMap.breakupRooms: Rect[]` rather than folded into `Room[]` — it has no backing `CodeEntity`, so every AST-driven system stays untouched by construction rather than needing a guard clause. Its own "Edge Case" enemies (`Enemy.edgeCase`) are the one enemy type not derived from a parsed entity either — see [Corridor Breakup: Best-Effort, Not Guaranteed](decisions.md#corridor-breakup-best-effort-not-guaranteed).

### "Enemy stays data"

`Enemy` (and similarly `Mine`, other trap types) is a bare interface — position, HP, cooldown timers, a `home` room rectangle, `aggroed`/`discovered` flags, a back-reference to the `CodeEntity` it represents — with **zero methods**. The doc comment on `Enemy.attackCooldown` states this directly: *"Behaviour lives in `src/engine/enemyAi.ts` — this stays plain data."* All actual behavior (roam/chase/melee/ranged state machine, line-of-sight, steering) lives in free functions in `src/engine/enemyAi.ts` that take the `Enemy[]` array, the `Player`, and the `GameMap`, and mutate the plain data in place. `enemyAi.ts`'s own header explains why: *"This lives in the engine layer rather than as a method on the `Enemy` data ... so the map never depends on the player."* The same split applies to traps (`src/engine/traps.ts` mutates plain `Mine`/`SpikeTrap` data on `GameMap`).

Practical effect: the map layer can be generated, seeded, and reasoned about — including in the replay system — with no dependency on player state, input, or rendering at all.

### Why `difficulty.ts` and `prng.ts` live at `src/` root

Both `src/difficulty.ts` and `src/prng.ts` are needed by more than one layer, and the map layer must never import the engine layer (the reverse is fine and expected). Rather than duplicate either module or force an awkward import direction, both live at `src/` root, outside `map/` and `engine/` entirely — layer-neutral by construction. In practice, difficulty scaling is applied by `engine.ts` (enemy HP is rescaled in-place on the map's `Enemy` objects right after construction) rather than threaded through `MapGenerator.generate()`, but the module itself stays usable from either layer.

## `engine` — level data → running game

`src/engine/` (21 modules) consumes a `GameMap` + a `Player` and runs the render/simulation loop, reporting `EngineStats` back to `main.ts` via `EngineHandlers` callbacks. Key modules: `engine.ts` (game loop), `raycaster.ts` (renderer), `player.ts`, `enemyAi.ts`, `sprites.ts`, `weapons.ts`, `loot.ts`, `projectiles.ts`/`rockets.ts`, `traps.ts`, `scoring.ts`, `highscores.ts`, `replay.ts`, `audio.ts`/`bgm.ts`, `hud.ts`, `viewmodel.ts`, `automap.ts`, `effects.ts`, `input.ts`, `storageCompression.ts`.

### Rendering

Pure Canvas 2D — no WebGL, no 3D library. `raycaster.ts` casts one DDA (Digital Differential Analyzer) ray per screen column at a 640×400 internal resolution (CSS-scaled up for a chunky retro look), drawing one shaded vertical wall strip per column. Shading is distance fog plus a fixed y-side dimming for fake directional lighting — there are no image textures; walls/floor/ceiling are flat or procedurally-shaded colors (bonus/`.h` levels get a distinct palette). Each column's wall top/bottom edge is kept as a float rather than floored to a whole pixel, and the one boundary row at each edge is alpha-blended against whatever's already painted underneath in proportion to its sub-pixel coverage — antialiasing the top/bottom silhouette against ceiling/floor without touching the `zBuffer` (still one exact distance per column, so billboard occlusion is unaffected). Vertical seams between adjacent columns (e.g. at corners) are not antialiased — that would need supersampling across columns, which is a bigger cost/architecture change (`notes` Task 71).

Enemies and items are 2D billboards (`sprites.ts`), projected with the same camera transform as walls. Every world billboard — enemies, projectiles, keys, ammo drops, the exit marker, teleporters, mines — is collected into one list and drawn in a single furthest-to-nearest depth-sorted pass against a per-column `zBuffer` recorded during the wall pass, so occlusion (by walls or by other billboards) is always correct regardless of draw-call order. This replaced an earlier fixed-order-by-category approach that could draw a nearer item behind a farther one — see [Feature Scope Reversals](decisions.md#feature-scope-reversals).

### Determinism and replay

Anything that affects simulation outcome — enemy AI roam/fire-cooldown timing, loot rolls, weapon cone-of-fire spread, elite-loot coinflips — draws from the shared seeded `mulberry32` PRNG (`src/prng.ts`), never `Math.random()`. Purely cosmetic randomness (blood-particle scatter, SFX pitch, BGM shuffle order, console hint selection) stays on `Math.random()` deliberately, since it never feeds back into simulation state. This split is a hard constraint, not a style preference: the replay system (`replay.ts`) records a gameplay seed plus a per-frame input digest per level, and can only reconstruct a byte-identical run if every simulation-relevant random draw goes through the one deterministic stream. See [Determinism & Replay](decisions.md#determinism--replay) for how this evolved.

## Build

Vanilla TypeScript + Vite 6, strict `tsc`, no game framework. `vite.config.ts` aliases `fs/promises`/`module` to `src/empty-node-shim.ts`, an empty stub — purely to satisfy Rollup's static resolution of `web-tree-sitter`'s bundle, which references a Node-only code path that's dead in a real browser but still needs to resolve at build time. There is still no general unit/e2e test framework in this repo (broad `tests` coverage remains an open backlog item in `notes`); most verification so far has relied on `tsc` typechecking, ad hoc headless-Chromium harnesses, and manual playtesting. The one exception is `demo-campaign/` (see `notes` Task 76): `scripts/verify-demo-campaign.mjs` is a committed, rerunnable Node script (bundles the real parser + `MapGenerator` via esbuild, no browser needed) that gates on a full map-feature/enemy-type coverage checklist, and `scripts/verify-campaign-playthrough.mjs` is a committed Playwright script that drives the real app end-to-end (via an OPFS-stubbed workspace picker and a virtual clock) to verify the save/highscore/replay mechanism.
