# Designing Your Own Levels

[← Back to index](README.md)

Every level in Codeenstein 3D is generated from the actual structure of a source file — there's no hand-placed level data anywhere. That has a genuinely fun side effect: you're not limited to pointing the game at code you already have lying around. You can **write a file specifically to produce the level you want**, the same way [`demo-campaign/`](../../demo-campaign) (the built-in "Demos" tab) and the test fixtures under `scripts/fixtures/` were built.

This page covers both halves of that: doing it by hand, and doing it by describing what you want to a coding agent instead.

## Have a coding agent write it for you

This is the easiest way in, and it's not a stretch — it's literally how `demo-campaign/`'s 17 files were authored. Describe the level you want in plain gameplay terms and ask any coding assistant (Claude Code, Copilot, etc.) to write a source file that produces it, using the [code → gameplay table](mechanics.md#how-code-becomes-a-level) as your shared vocabulary. For example:

> "Write a short C file with one simple enemy, one tough boss-tier function, a global variable for a hazard pool, a private helper function behind a locked door, and a `goto` pair for a teleporter."

Point the agent at a couple of files in `demo-campaign/` (any language) as a style reference — they're real, working examples already tuned to hit specific features, and reading a couple makes the request much more concrete than description alone.

### Prompting tip: Secret-Heavy Dungeon

Want a level dense with hidden rooms? Steer the agent toward **dead/unreachable code after a `return`** and **oversized comment blocks** (more than about half a dozen consecutive comment lines — plain prose is fine, it doesn't need to look like real commented-out code) as its secret-room triggers, rather than `@deprecated`/`[Obsolete]` markers or magic-number/hex-blob literals. All four are equally valid triggers to the generator, but the first two read as things a real, aging codebase would actually accumulate; a file sprinkled with a dozen `@deprecated` tags or hex blobs to farm secret rooms reads as obviously artificial "code vandalism" the moment anyone actually opens it. An oversized comment block is efficient too — long enough and it doubles as a lore terminal in the same spot, not just a secret room.

One thing to tell the agent up front: **it can't know exactly what its file will produce just by reading it.** Map layout, secret-room contents, and even which of three outcomes a TODO comment triggers are all drawn from a seeded RNG — deterministic per file, but not something anyone can compute by eye. The only way to know what a file actually generates is to load it and look. That's exactly how `demo-campaign/` was tuned during development: every file was run through the real map generator repeatedly and adjusted based on what actually came out, not what seemed like it should.

One more thing worth knowing before you start tuning a file: **layout is seeded from the file's own entity list**, so adding or removing a single function reshuffles that level's entire map — every room, corridor and secret moves. That's not a bug, it's the whole premise (see the warning above about not being able to predict a level by reading it), but it does mean a small edit to a file you were happy with can hand you a level you're not. Re-check anything you'd tuned by hand, and pay closest attention to your campaign's *first* file, since level 1 is the one every run has to get through.

Large open rooms also get a scattering of solid pillars (1-3 per room) to break up sightlines — this isn't tied to any specific source construct, it's an always-on structural pass over whatever rooms the generator already placed, so there's nothing to write in your source to trigger it either way.

The same goes for what happens *between* rooms. Rooms are placed beside one another rather than scattered, so the corridors joining them are short by construction; rooms that end up near each other but far apart in your file pick up an extra connecting corridor, giving the level loops instead of only dead ends; and the corridors themselves vary in width and get dressed with widenings, colonnades, gateways, plazas, alcoves and chicanes. All of that is structural too — you can influence how *much* of it there is by writing more functions, but not which shapes you get where.

There's a tip hiding in the [`report:level-maps` script](../dev/testing.md) if you're tuning a campaign seriously: it renders every level's floor plan to a PNG, which is a far faster way to see what a file produced than walking it.

**A note if you generate levels from a project you don't control:** `npm run report:level-maps` only ever renders the bundled demo campaign. To eyeball your own workspace, load it in the game and use the post-win "Export Map as PNG" button.

## Manual authoring cheat sheet

If you'd rather write the file yourself, here's what each construct controls. See [Game Mechanics](mechanics.md#how-code-becomes-a-level) for the full reference table — this is the "which knob do I turn" version.

- **Want a simple grunt?** A short, flat function with low cyclomatic complexity (few branches/loops). HP is complexity × 25.
- **Want a boss fight?** One deeply-branching, long function. At complexity ≥ 40 the room doubles its HP budget and spawns an Elite pack — a gold-tinted Elite (more damage, guaranteed good loot) leading several tougher-than-usual enemies.
- **Want a pack of enemies instead of one tough one?** You always get a pack: a function's HP budget is split across several enemies rather than piled onto one, so no single enemy is ever a damage sponge you can't chew through. More complexity means more of them, not a bigger one.
- **Want a tougher grunt without touching complexity math?** More than 5 parameters, or nesting more than 3 levels deep, adds bonus HP on top — "code smells" read as tougher fights.
- **Want a hazard pool?** A global variable becomes an acid pool.
- **Want a locked room?** Make a method private or protected. The generator always places a reachable key somewhere else in the level first — you can't lock yourself out by writing this. A key is coloured, permanent, and opens every door of its room, so one key is all a room ever costs. A level locks at most six doorways, picking the rooms most worth locking (large, loot-rich, few ways in), so in a file full of private methods only some of them become locked rooms — otherwise a big source file turned into nothing but a key hunt.
- **Want a teleporter pair?** A `goto`/label pair — but this only works in **C, C++, Objective-C, PHP, or Go**; other languages' grammars aren't parsed for `goto` at all. A pair whose two pads would land in the *same* room only gets built once per level: an error-handling `goto out;` is the common case, and warping you a few tiles across the room you were already standing in is noise rather than a shortcut. Pairs that connect two different rooms are unaffected.
- **Want a lore terminal?** A large comment block, or a `TODO`/`FIXME` comment of any length (even a one-liner skips the usual size gate). Every TODO/FIXME terminal also spawns a small nearby encounter — a trap, a mine, or a weak "Bug" enemy — never close enough to ambush you from spawn. A single file caps out at 6 lore terminals; extra large comments beyond that don't get one.
- **Want a secret room?** Any of: dead/unreachable code after a `return`, an empty (swallowed-exception) `catch` block, a `@deprecated`/`[Obsolete]`-style marker, a commented-out block of code, or a magic-number/blob literal (a long Base64-ish string, or a hex constant like `0xDEADBEEF`).
- **Want a bonus level?** Use a `.h` header file — its own distinct teal-themed level with better loot odds. That teal look is reserved for bonus levels: if you're seeing it, you're in a restock arena.
- **Why does each level look different?** Every level picks one of several *stylesets* — a whole look, walls, floor, doors and ceiling together — and keeps it for the entire level. Which one it gets is derived from the source file's own content, so a given file always looks the same, every time you play it. Nothing that matters to your survival changes with it: acid is always green, teleporter pads always purple, an armed spike trap always red, and lore terminals always the same glowing cyan, on every level and in every styleset.
- **Want a bigger level** with more corridor encounters and Edge Case swarm enemies? Write more functions. Map size follows the space the rooms actually need (capped at 160 tiles), and corridor furniture is budgeted per room, so more functions means more rooms, more corridors between them, and more of the widenings, colonnades, gateways, plazas and alcoves that get dressed into them — each with its own small encounter.
- **Want a hub-and-spoke junction?** A `switch`/`match` with a few `case` branches inside one function. Each case becomes a short dead-end spur off that function's room, behind a keyless amber door. The `default` branch is the way onward, so it gets no spur — and the whole thing caps at 5 spurs, so a giant enum switch won't carpet the map.
- **Want a risk-then-reward gauntlet?** A `try`/`catch`/`finally`. You get an acid corridor with traps, an alcove of health and Swap at the end of it, and a safe loot room past that. Worth knowing: **Go, Rust, Bash and plain C have no exception construct at all**, so this one does nothing in those languages — same caveat as `goto` teleporters, just the other way round.
- **Want extra supplies right at spawn?** More top-level imports/`#include`s — roughly one alcove per four, capped at four. They stock ammo for weapons you already own, so early levels lean toward bullets.
- **Want a room that floods with acid?** A function that allocates heavily — several `malloc`/`calloc`/`new` calls, or a big fixed-size array, packed into a reasonably short function. Walk in and the floor starts going — you get a warning tone and an on-screen banner the moment it triggers — and killing that function's enemy stops it. Bash has no allocation construct the parser looks at, so it never produces one. Python has no `new`, but it's still matched on *callee name* — a function literally called `make`, `vec`, or anything `alloc`-ish counts — so it's unlikely by accident rather than impossible.
- **Want a multi-level campaign?** Chain multiple files together in one folder — the file tree order (directories first, then alphabetical) becomes the level order.

## Try it yourself

`demo-campaign/` at the repo root has one file per supported language, each hand-tuned to hit a specific mix of these features — open a couple and compare them against what you see in-game to get a feel for how the numbers translate before writing your own from scratch.
