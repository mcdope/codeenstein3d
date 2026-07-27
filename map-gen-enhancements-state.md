# map-gen enhancements — progress state

Disposable working file for the 4 new AST-driven level-generation features
(Switchboards, Exception Zones, Vendor Depots, Acid Overflow). **Delete this file
once the work lands.** Plan: `~/.claude/plans/task-implement-4-lazy-dream.md`.

## Milestones

- [x] **M0** parser contract + detectors + tables (all three adapters)
- [x] **M1** `GameMap` fields, `AmmoPickup` smg/gas, `generate()` params
- [x] **M2** Vendor Depots
- [x] **M3a** `BRANCH_DOOR_TILE`
- [x] **M3b** Switchboards
- [x] **M4** Exception Handling Zones
- [x] **M5** Acid Overflow — map half
- [x] **M6** Acid Overflow — engine half
- [ ] **M7** demo-campaign content + `verify:campaign` checklist
- [ ] **M8** docs + `npm run generate:default-highscore`

## Node types — empirically confirmed

Dumped from the real grammars (throwaway `__dump.test.ts` files, since deleted);
raw output kept at `<scratchpad>/php-ast.txt` and `<scratchpad>/generic-ast.txt`.

### switch / case branches

| Language | branch node | default detection |
|---|---|---|
| C, C++, ObjC | `case_statement` | text `/^default\b/` (no `value` field) |
| PHP | `case_statement` | `default_statement` (own node type) |
| PHP `match` | `match_conditional_expression` | `match_default_expression` |
| JS, TS | `switch_case` | `switch_default` |
| Java (legacy) | `switch_block_statement_group` | text `/^default\b/` (`switch_label "default"`) |
| Java 14+ | `switch_rule` | text `/^default\b/` |
| C# stmt | `switch_section` | text `/^default\b/` |
| C# expr | `switch_expression_arm` | pattern text `_` (`discard`) |
| Go | `expression_case`, `type_case`, `communication_case` | `default_case` |
| Rust | `match_arm` | pattern text `_` |
| Python | `case_clause` | `case_pattern` text `_` |
| Scala | `case_clause` | `wildcard` text `_` |
| Ruby | `when` | sibling `else` node under `case` |
| Bash | `case_item` | pattern text `*` (`extglob_pattern`) |

**Gotcha:** Scala's `catch_clause` contains a `case_block` of `case_clause`s — a
`try`/`catch` would otherwise inflate `caseCount`. Handled by excluding any branch
with a `catch_clause` ancestor.

**Gotcha:** Bash's `case_statement` is the *container*, but C/C++/ObjC/PHP's
`case_statement` is a *branch*. Resolved by not scanning containers at all — the
detector only counts branch nodes and returns `undefined` when there are none —
*plus* skipping any match that holds another matched branch as a **direct named
child**, which is what tells bash's container apart from a real branch. Only
direct children count: a whole switch nested inside a branch body sits deeper
(under the inner switch's own body node) and must not disqualify its parent.

**Gotcha:** Rust's `match_arm` uses the `value` field for the arm's *body*, so
`childForFieldName("value")` on `_ => 0` returns `0`, not `_`. `isDefaultBranch`
therefore checks `pattern` **before** `value`.

### try / catch / finally

`try_statement` (JS, TS, Python, Java, C#, C++, ObjC) · `try_expression` (Scala) ·
`try_with_resources_statement` (Java) · `begin` (Ruby) · `seh_try_statement` (C, MSVC
`__try` only — plain C produces zero zones, mirroring how `cParser.ts` already skips
`findEmptyCatchBlocks`). Go, Bash and Rust have no exception construct at all.

Catch: `catch_clause`, `except_clause` (Python), `rescue` (Ruby), `seh_except_clause`.
Finally: `finally_clause`, `ensure` (Ruby), `seh_finally_clause`.

### imports

`import_statement`/`import_from_statement` (Python, JS, TS) · `import_declaration`
(Java, Scala, Go) · `import_spec` (Go, nested) · `using_directive` (C#) ·
`using_declaration` (C++) · `use_declaration`/`extern_crate_declaration` (Rust) ·
`preproc_include` (C, C++, ObjC — ObjC's `#import` parses as this too) ·
`namespace_use_declaration` + `include_expression`/`include_once_expression`/
`require_expression`/`require_once_expression` (PHP). Call-shaped: Ruby `require`/
`require_relative`/`load` and Bash `source`/`.` are plain `call`/`command` nodes.

Go nests: `import_declaration > import_spec` for a single import,
`import_declaration > import_spec_list > import_spec` when grouped. Handled by
counting only **leaf-most** matches (a match containing another match is skipped), so
ten grouped imports read as ten rather than as one.

"Top-level" is **not** a depth cap — a first attempt used depth ≤ 3 and wrongly counted
a C `#include` sitting inside a function body (also depth 3). It's defined instead as
"no ancestor is a function/class body block", reusing the same `BLOCK_NODE_TYPES` set
`findDeadCodeAfterReturn` already takes.

### allocations

Node types: `new_expression` (C++, JS, TS) · `object_creation_expression` /
`array_creation_expression` (Java, C#) · `instance_expression` (Scala) ·
`stackalloc_expression` (C#). Call-shaped, matched on **callee name**:
`malloc`/`calloc`/`realloc`/`make`/`new`/`alloc`/`strdup`/… — reaches C `malloc(64)`,
Go `make(...)`/`new(...)`, Rust `Box::new`/`Vec::with_capacity`, Ruby `Array.new`, and
ObjC's `[[NSObject alloc] init]` (inner `message_expression`, last identifier child
`alloc`). Rust `vec![...]` is a `macro_invocation`. Large static arrays:
`array_declarator` with a literal size ≥ 1024.

Python has no explicit allocation construct, so Python entities never get an Acid
Overflow room — same shape as `goto`/teleporters being C/C++/PHP/Go only.

## Retuned constants

_(none — every threshold shipped at its first value)_

## Balancing-scan findings (M7)

**Don't add new constructs to `main.c`.** The first attempt at demo-campaign
coverage added `#include`s and a `malloc`-dense function to `main.c`. That changed
its entity list, which changed `seedFrom`, which reseeded level 1's entire layout —
and `npm run balancing:scan` went from a healthy baseline to **0/3 qualifying on all
three profiles, every attempt `stuck` on level 1**. Reverting only the `main.c` edit
(keeping all feature code) restored normal progression, proving the feature code was
never the cause. All the new constructs now live in `stage12_render_engine.cpp`
instead, which is enough for every checklist item.

**Matched A/B, 14-attempt cap, `normal`:** branch **8/9** qualifying runs
(Casual 2/3, Gamer 3/3, Pro 3/3) vs baseline **7/9** (Casual 3/3, Gamer 2/3,
Pro 2/3). Statistically indistinguishable — no balance regression. (The
5-attempt default is far too noisy to read anything from; both sides swung
between 0/3 and 2/3 on the same profile across runs.)

**`stuck@L1` is pre-existing.** Once main.c was restored, both branch and baseline
show `stuck@L1` as the dominant failure at this scan's 5-attempt cap (baseline: 3/4/5
attempts across Casual/Gamer/Pro). It is not a regression from this work.

**The bot's pathfinding needed teaching about `BRANCH_DOOR_TILE`.** Neither
`pathfind.mjs`'s `BLOCKED_TILES` nor `routePlanner.mjs`'s `HARD_BLOCK_TILES` knew
about tile 8, so the planner routed straight *through* doors the engine treats as
solid — a model that happened to work only because the bot holds a movement key and
`openDoorAhead` fired by accident. Both sets now include it, and `planRoute` emits a
keyless `openDoor` leg for a branch door, tried *before* the key/locked-door detour
since it's free. (`pathfind.mjs`'s own doc comment says its blocked set mirrors
`isWall()`; that had silently stopped being true.)
