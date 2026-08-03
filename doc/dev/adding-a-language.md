# Adding a Language

Adding a language is mostly *data* — one `GenericParserAdapter` entry in
`src/parser/generic/languages.ts` — but the shared node-type vocabulary behind it is a set of
hand-maintained tables, and a language missing from one of them silently loses a whole map
feature. Nothing fails; the levels just come out flatter than they should, and there is no
signal anywhere that says why.

Same shape as [Adding a Weapon](adding-a-weapon.md), same reason for existing: this document
is the procedure, not the rationale. For *why* the parser layer looks like this — one
data-driven adapter instead of fourteen hand-written ones — see
[Dependency Minimalism](decisions.md#dependency-minimalism) and
[Architecture](architecture.md#parser--source--normalized-ast-data).

---

## 0. Vet the grammar first — this is a gate, not a formality

Before anything else, confirm the grammar's prebuilt wasm actually loads against this
project's pinned `web-tree-sitter`. `languages.ts`' own header records why: a bulk
`tree-sitter-wasms` package, `tree-sitter-kotlin` and `tree-sitter-lua` were all rejected —
they ship either an incompatible ABI or no prebuilt wasm at all. A grammar that looks
perfect on npm can be unusable here.

What you need from the package:

- a **prebuilt `.wasm`** in the published tarball (this project does not compile grammars),
- an **ABI compatible** with the pinned `web-tree-sitter` in `package.json`,
- an **MIT-or-similar licence** — the grammars ship inside the bundle, so they land in
  README's "Shipped to players" table.

If the grammar fails any of these, stop here. There is no workaround that doesn't mean
vendoring a build toolchain.

## 1. The dependency

`package.json` — add the `tree-sitter-<lang>` devDependency. It's a *dev* dependency despite
shipping, because what ships is the wasm asset Vite bundles, not the npm package's JS.

## 2. The adapter entry

`src/parser/generic/languages.ts` — one `import … from "tree-sitter-<lang>/tree-sitter-<lang>.wasm?url"`
(check the real filename; `tree-sitter-c-sharp` publishes `tree-sitter-c_sharp.wasm`, and
`tree-sitter-typescript` publishes two), then one row:

```ts
new GenericParserAdapter({ id: "mylang", extensions: ["ml", "mli"], wasmUrl: myWasmUrl, ...refine.mylang }),
```

- `id` is what lands in `ParsedFile.language` and what `verify:campaign` counts.
- `extensions` are lower-case and without the dot. They must not collide with an existing
  adapter — `registry.ts` builds one flat extension→adapter map, so a duplicate silently
  wins or loses depending on array order.
- The `?url` suffix is load-bearing in two places beyond the browser build: `vitest.config.ts`'s
  `wasmUrlAsPathPlugin` and `scripts/lib/loadEngineModules.mjs`'s esbuild equivalent both
  rewrite it to a real filesystem path for Node. You get that for free by matching the
  existing import shape — don't invent a different one.

**No edit needed** in `src/parser/registry.ts`: it spreads `GENERIC_ADAPTERS` and derives its
extension map from each adapter's own `extensions`.

## 3. Refinements (optional, usually wanted)

`src/parser/generic/refinements.ts` — per-language overrides on top of the shared traversal:
real method-vs-function distinction, visibility modifiers, and whatever else the grammar
words differently. Ten languages have one; `bash` deliberately doesn't. Start without one,
look at what the generic pass produces, and add only what's actually wrong.

## 4. The shared vocabulary tables — where a language goes quietly missing

`src/parser/generic/vocabulary.ts` holds one table per AST-driven map feature, merged across
every grammar. **A language absent from a table loses that feature with no error.** Walk all
of them:

| Table | Feature it drives | Absent means |
|---|---|---|
| `TRY_NODE_TYPES` / `CATCH_NODE_TYPES` / `FINALLY_NODE_TYPES` | Exception Handling Zones | No gauntlets. Legitimate for a language with no exception construct (Go, Rust, Bash) — say so in the table comment rather than leaving it ambiguous. |
| `IMPORT_NODE_TYPES` / `CALL_SHAPED_IMPORT_NODE_TYPES` | Vendor Depots | No spawn-room supply alcoves. |
| `ALLOCATION_NODE_TYPES` / `CALL_NODE_TYPES` / `ARRAY_DECLARATOR_NODE_TYPES` | Acid Overflow rooms | No flooding rooms. Note `ALLOCATOR_NAME_PATTERN` matches on *callee name*, so a language can qualify through `CALL_NODE_TYPES` alone without an allocation keyword. |
| `GOTO_NODE_TYPE` | Teleporter pads | No teleporters. Only the C-family and Go have `goto` at all. |
| `PARAMETER_LIST_NODE_TYPES` | The ">5 params" code smell | Every function reads as having zero parameters — a silently *easier* level, which is the worst kind of miss. |
| `CASE_BRANCH_NODE_TYPES` | Switchboards | No junction hubs. |

The grammar's own `src/node-types.json` (inside the installed package) is the authority for
what a node is actually called. Read it rather than guessing from another language's spelling
— `try_expression` (Scala) and `begin` (Ruby) are both "try".

## 5. A demo-campaign level

`demo-campaign/` has one file per supported language, hand-tuned to hit a specific spread of
features. Add one for the new language, in the existing `stageNN_name.ext` naming. Two
reasons this isn't optional:

- `scripts/verify-demo-campaign.mjs` (`npm run verify:campaign`, a blocking CI job) sweeps
  the campaign and tracks `languagesSeen` alongside its map-feature checklist — a language
  with no level in there is never exercised by CI at all.
- It's the only place anyone can see what the new adapter actually produces.

Write it the way [Designing Your Own Levels](../user/level-design.md) describes, and check
the result with `npm run report:level-maps` rather than by reading the file.

**Then regenerate the default highscore board.** Adding a campaign file changes what
`demo-campaign/` is, which invalidates the baked-in replays — see
[Adding a Weapon §8](adding-a-weapon.md#8-regenerate-the-default-highscore) for the same
procedure and the same warning about doing it last.

## 6. Tests

- `src/parser/generic/languages.test.ts` — the per-language sweep. It asserts the shared
  feature tables actually fire per grammar (e.g. `exceptionZones` present, `hasFinally`
  correct), which is exactly the class of miss §4 warns about. Add the new language to it.
- `src/parser/registry.test.ts` — extension dispatch, including that nothing collides.
- Mind the coverage gate (99.9% lines/statements, [Testing](testing.md)). A refinement branch
  no fixture exercises will fail it.

## 7. Docs

- `README.md` — the "Multi-language support" feature line, the "N Language Grammars" line in
  Architecture & Tech Stack, the parser-details breakdown ("12 Generic languages"), and the
  Credits table's grammar list. All four enumerate the set independently.
- [`architecture.md`](architecture.md#parser--source--normalized-ast-data) — the "other 12
  bundled languages" count.
- [`doc/user/troubleshooting.md`](../user/troubleshooting.md) — the supported-extension table
  is what a player checks when a file doesn't become a level.
- [`doc/user/level-design.md`](../user/level-design.md) — the per-language caveats
  (which languages have `goto`, which have no exception construct, which can't allocate).
- `CHANGELOG.md` — under `## Unreleased`, player-facing voice.
- `notes` — close the open item.

---

## Why not a bespoke adapter?

Only PHP and C have one, and both earned it: PHP needs global-variable-at-program-scope
detection the generic traversal can't express, and C's function declarator is buried deeper
than the shared walk goes. Reach for a bespoke adapter only after the generic one plus a
refinement has actually failed on something specific — "this language feels different" isn't
a reason, and two hand-written adapters is already the number this project wants to maintain.
