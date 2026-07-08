# Game Design

This is the developer-facing "why" behind Codeenstein 3D's design — for the player-facing "how", see [`doc/user/mechanics.md`](../user/mechanics.md); for exact current numbers (HP multipliers, aggro radii, drop rates), see that doc or the source directly, since they change as balancing continues.

## Everything maps to something

The core design principle is that every construct the parser can extract from a source file should become *something* in the level, rather than being silently dropped — a codebase should feel fully translated, not partially. Concretely:

- **Functions/methods → enemies.** HP scales with cyclomatic complexity, so a genuinely tangled function is a harder fight than a simple one — the game's difficulty curve is, by design, a reflection of the codebase's own complexity rather than a hand-tuned level progression.
- **Global variables → hazard rooms**, not enemies. Globals aren't "doing" anything the way a function is; they represent ambient, code-smell-adjacent state, which reads better as an environmental hazard (an acid pool) than as something you fight and defeat.
- **Private/protected methods → key-locked rooms.** Encapsulation becomes a literal locked door — access modifiers already express "you're not supposed to reach this directly," which maps naturally onto needing a key.
- **`goto`/label pairs → teleporters**, in the spirit of Unreal Tournament jump pads: a `goto` is already a non-linear jump in control flow, so a bidirectional teleporter pair is a fairly direct translation rather than a stretch.
- **Dead code (unreachable statements after a `return`) → secret rooms.** Code that can never execute is, narratively, a hidden space the codebase itself doesn't know is there — fitting for a secret behind a fake wall with better loot.
- **Large comments → lore terminals.** A big comment is the author speaking directly to a future reader; surfacing it as an interactable in-world text panel keeps that voice intact instead of discarding it. TODO/FIXME comments are deliberately exempted from the normal length gate (even a one-line `// TODO: fix this` gets a terminal) because that's the most common real-world form of technical debt, and excluding short ones would miss most of what this feature exists to surface — each one also spawns a small "technical debt" encounter (trap, mine, or a weak "Bug" enemy) on the approach, rather than a permanent hazard, since the terminal has to be reachable to read — kept at least a minimum distance from the player's spawn point, same as every other hazard placement, so a TODO comment that happens to sit in the spawn room can't ambush the player before they can react (see [Hazard Placement Spawn Safety](decisions.md#hazard-placement-spawn-safety)). License/copyright headers are excluded on purpose — they're boilerplate, not authored lore, and would otherwise turn nearly every file into a terminal.
- **`.h` files → bonus levels.** A header is usually a smaller, self-contained, single-purpose file compared to its implementation — a natural fit for a shorter "restock" level with boosted pickup rates, discovered "by accident" during playtesting rather than planned from the start.

## Enemy and difficulty philosophy

A function's cyclomatic complexity converts to HP at a fixed rate; beyond a certain size, complexity is expressed as *more* enemies (a "pack") rather than one increasingly bloated HP pool, so a big function reads as "this does a lot" rather than "this is a damage sponge." Past an extreme complexity threshold, that logic flips: instead of yet another incrementally bigger pack, the function spawns a single Elite — a real boss fight (higher HP multiplier, more damage, a guaranteed weapon or health drop) marking a genuinely different tier of code, not just "a really big pile of the same thing." See [Enemy Scaling](decisions.md#enemy-scaling-packs-vs-elites) for how this threshold was chosen.

Easy/Normal/Hard scale two axes in the same direction on purpose: Hard makes enemies both tougher *and* deal more damage, while simultaneously making ammo/health/armor scarcer — the two effects compound rather than offset, so difficulty isn't just "bullet sponges," it's a genuinely tighter resource margin too. Easy mirrors this in reverse.

## Weapon and economy intent

Ammo is split into two pools (bullets vs. rockets) specifically so each weapon has a distinct resource identity rather than one shared pool making every gun interchangeable. The rocket launcher and its ammo are both gated behind an unlock (an Elite kill, or a forced grant at fixed campaign milestones as a safety net) — giving it out from the start would make an Elite's guaranteed drop meaningless, and rolling rocket ammo before the launcher is owned would just be a dead, wasted drop.

Loot rolls exclude outcomes that would be pointless in context: health never drops while the player is already at full health (redistributed to ammo/armor instead), and rocket ammo never drops before the launcher is unlocked. The design intent is that every drop should matter — a drop the player can't use at all is worse than no drop, since it reads as the game wasting their luck.

The SIGKILL Knife (melee, unlimited ammo, small lifesteal) exists as a deliberate safety net: with every kill already guaranteeing *some* ammo drop, the knife's job isn't to solve scarcity by itself, it's to make sure a player who's fully dry can still fight their way back into the loop rather than getting stuck.

## Scoring intent

Scoring is built to reward the behaviors the game actually wants to encourage, not just "kill things": points scale with the complexity of what was defeated (tripled for an Elite), plus bonuses for finishing with health/ammo to spare, for speed, and for route efficiency (actual path walked vs. the shortest possible spawn→exit path) — and a separate bonus for reading lore terminals and for exploring most of the map, so pure speedrunning isn't the only path to a high score. Score is a running **campaign total**, not a per-level number that resets — a multi-level run is meant to read as one continuous performance, not a sequence of disconnected level scores. (This was originally broken — see [Persistence & Storage Limits](decisions.md#persistence--storage-limits) — and fixed once identified.)

## Known design gaps

A few open items in [`notes`](../../notes)' `## Open` section are design-facing rather than pure engineering backlog, and are called out here so this doc doesn't read as though the design is finished:

- **Balancing** is explicitly still open — numbers throughout (HP curves, drop rates, aggro distances) are expected to keep moving.
- **Room decorations** were implemented once, disabled twice after playtest feedback (felt like visual clutter rather than atmosphere), and are sitting behind a flag pending a design rethink — not deleted, because the underlying idea (rooms feeling less empty) is still worth pursuing.
- **WAD-sourced textures** are a discovered/considered idea, not committed to.

See `notes` directly for current status on any of these — this doc intentionally doesn't track checkbox state.
