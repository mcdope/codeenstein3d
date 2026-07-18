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

Large open rooms also get a scattering of solid pillars (1-3 per room) to break up sightlines — this isn't tied to any specific source construct, it's an always-on structural pass over whatever rooms the generator already placed, so there's nothing to write in your source to trigger it either way.

## Manual authoring cheat sheet

If you'd rather write the file yourself, here's what each construct controls. See [Game Mechanics](mechanics.md#how-code-becomes-a-level) for the full reference table — this is the "which knob do I turn" version.

- **Want a simple grunt?** A short, flat function with low cyclomatic complexity (few branches/loops). HP is complexity × 25.
- **Want a boss fight?** One deeply-branching, long function. At complexity ≥ 40 it spawns as a single gold-tinted Elite (more HP, more damage, guaranteed good loot) instead of a pack.
- **Want a pack of enemies instead of one tough one?** A function with complexity between "simple" and the Elite threshold splits into multiple enemies sharing that complexity's HP pool, rather than one big one.
- **Want a tougher grunt without touching complexity math?** More than 5 parameters, or nesting more than 3 levels deep, adds bonus HP on top — "code smells" read as tougher fights.
- **Want a hazard pool?** A global variable becomes an acid pool.
- **Want a locked room?** Make a method private or protected. The generator always places a reachable key somewhere else in the level first — you can't lock yourself out by writing this.
- **Want a teleporter pair?** A `goto`/label pair — but this only works in **C, C++, PHP, or Go**; other languages' grammars aren't parsed for `goto` at all.
- **Want a lore terminal?** A large comment block, or a `TODO`/`FIXME` comment of any length (even a one-liner skips the usual size gate). Every TODO/FIXME terminal also spawns a small nearby encounter — a trap, a mine, or a weak "Bug" enemy — never close enough to ambush you from spawn. A single file caps out at 6 lore terminals; extra large comments beyond that don't get one.
- **Want a secret room?** Any of: dead/unreachable code after a `return`, an empty (swallowed-exception) `catch` block, a `@deprecated`/`[Obsolete]`-style marker, a commented-out block of code, or a magic-number/blob literal (a long Base64-ish string, or a hex constant like `0xDEADBEEF`).
- **Want a bonus level?** Use a `.h` header file — its own distinct teal-themed level with better loot odds.
- **Want a bigger, more chaotic level** with extra corridor-breakup fights and Edge Case swarm enemies? Write more functions. Maps cap at 160 tiles; a big/dense file is more likely to hit that and get long corridors interrupted with extra encounter rooms.
- **Want a multi-level campaign?** Chain multiple files together in one folder — the file tree order (directories first, then alphabetical) becomes the level order.

## Try it yourself

`demo-campaign/` at the repo root has one file per supported language, each hand-tuned to hit a specific mix of these features — open a couple and compare them against what you see in-game to get a feel for how the numbers translate before writing your own from scratch.
