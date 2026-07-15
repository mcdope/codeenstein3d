# Game Mechanics

[← Back to index](README.md)

## How code becomes a level

Codeenstein 3D parses your source into an AST and turns its structure into a playable map:

| Code element | Becomes |
|---|---|
| Folder | A level |
| File | A room (or set of rooms) |
| Function | An enemy — HP scales with its cyclomatic complexity |
| Function with more than 5 params or more than 3 nesting levels | A tougher enemy (a "code smell" bonus on top of complexity) |
| Function at extreme complexity (≥40) | A single **Elite** enemy instead of a pack — 4× HP, 2× damage, gold-tinted, 60% chance of an extra weapon drop |
| Global variable | An acid pool (hazard terrain) |
| Private/protected method | A locked room, gated behind a key placed somewhere already reachable |
| `goto`/label pair | A linked teleporter pad pair |
| Large comment | A glowing lore terminal — press `R` to read it |
| Comment flagged `TODO`/`FIXME` | Also a lore terminal, plus a small "technical debt" encounter nearby: a spike trap, a proximity mine, or a weak enemy (equally likely) |
| Dead/unreachable code, an empty (swallowed-exception) catch block, a `@deprecated`/`[Obsolete]` marker, a commented-out code block, or a magic-number/blob literal (long Base64-ish string, `0xDEADBEEF`-style hex constant) | A secret room hidden behind a fake wall (very slightly tinted if you look closely), holding one guaranteed pickup — mega-health, a fat rockets stash, a big armor top-up, or (if you haven't unlocked it yet) gdb/ghidra/Friday Hotfix outright, or, from campaign level 4 on, the Toolchain chainsaw |
| Header file (`.h`) | A distinct bonus level — cool teal theme, better loot odds, meant as a restock stop |

The level-start briefing shows how many secret rooms a level actually has ("Secrets") alongside its room/enemy counts — worth keeping an eye on the walls.

A long, straight corridor gets broken up rather than left as one uninterrupted sightline: either a small extra room gets carved into the middle of it, or (if there's no room for one) the corridor jogs around a short blocked stretch instead. Any injected room comes with its own Edge Case enemies — see [Enemies](#enemies) below.

## Weapons

| Weapon | Slot | Type | Notes |
|---|---|---|---|
| echo pistol | 1 | Hitscan | Starting weapon |
| Regex Shotgun | 2 | 7-pellet cone | Starting weapon |
| SIGKILL Knife | `Space` only | Melee | Starting weapon, infinite ammo, heals 1 HP per kill, not on the number row |
| gdb | 3 | Full-auto hitscan | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 4 |
| ghidra | 4 | Rocket / splash damage | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 8 |
| Friday Hotfix | 5 | Full-auto 6-pellet cone, 3.5-tile max range | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 12 |
| Toolchain | `Space` only | Full-auto melee | Infinite ammo, 2× the knife's damage, a bigger lifesteal heal, fires as long as you hold the key — permanently replaces the knife on Space once picked up. Found in a secret room, dropped by an Elite kill, or a small chance on any regular kill whose loot roll comes up empty — all gated to campaign level 4 on; **no forced unlock** — a loot-unlucky run can still finish without ever finding it |

Ranged weapons draw from four separate ammo pools: **Bullets** (pistol/shotgun), **SMG Ammo** (gdb only), **Rockets** (ghidra only), and **Gas** (Friday Hotfix only). SMG/rocket/gas ammo won't drop or spawn on the map at all until you actually own the matching weapon. Hitscan pellets deviate more the further away the target is, so point-blank shots are reliable and very long-range ones can miss. Friday Hotfix additionally enforces a hard 3.5-tile max range on top of that — a genuine flamethrower's reach, not just a wide cone that happens to scatter — and fires a fanning flame stream instead of the thin tracer line every other gun draws.

## Loot & Difficulty

Any regular kill tops up your health if you're not already at full stability — unconditional, not a roll, since running low on health is the one thing that can actually end a run. Separately, the same kill rolls for bullets, SMG ammo, rockets, gas, or swap — but that roll doesn't always land: roughly 1 in 5 regular kills drop no ammo/swap at all. A few more rules apply on top:
- No SMG ammo is rolled until you own gdb; no rockets are rolled until you own ghidra; no gas is rolled until you own Friday Hotfix.
- Elite kills always drop either a large health pack or (if you're already full) a bigger bullets/swap drop, plus a separate 60% chance to *additionally* drop a still-locked weapon (two items on the ground once one's missing, not a choice between them). From campaign level 4 on, this can include the Toolchain chainsaw.
- Any regular kill has a very small (1%) chance to also drop a still-locked weapon, stacked on top of its normal roll — a rare bonus, not a reliable unlock path.
- If a regular kill's ammo/swap roll comes up empty, there's a small extra chance (5%) it grants the Toolchain chainsaw instead of nothing — on top of, not instead of, finding one in a secret room or from an Elite.

### Difficulty

| Difficulty | Enemy HP | Enemy damage | Enemy aim | Pickup amounts |
|---|---|---|---|---|
| Easy | ×0.7 | ×0.85 | Sloppy — random deviation up to ±10° per shot | ×1.3 |
| Normal | ×1 | ×1 | Slightly off — up to ±4° | ×1 |
| Hard | ×1.5 | ×1.5 | Dead-on — no deviation at all | ×0.7 |

Note Easy's damage (×0.85) doesn't mirror its HP reduction (×0.7) the way Hard's pair does — a deliberate, slightly less forgiving choice made after Easy's original mirrored curve, combined with cautious play, turned out to make it possible to sail through the whole campaign nearly unscathed.

Difficulty affects enemy-dealt melee/ranged damage and ranged aim precision — traps and rocket self-splash are unaffected. "Dead-on" aim still means a real bolt with real travel time, not a hitscan or a homing shot — you can still dodge it, an enemy just won't miss by aiming badly.

## Enemies

Enemies roam randomly within their home room until they notice you — which requires being within roughly 7.5 tiles **and** having line-of-sight, or taking a hit from you at any range (getting shot always counts as being spotted). Once aggro'd, they chase you around corners, and attack with melee at close range or ranged plasma bolts if they have line-of-sight at a distance.

**Edge Cases** are a separate, small breed found only inside a corridor's breakup room (never in a normal room): a jarring cyan tint and a noticeably smaller silhouette make them easy to tell apart from a real enemy at a glance. They have very little HP, dart around erratically rather than roaming smoothly, move faster than any other enemy in the game (though not faster than your own sprint), and hit for much less than a normal enemy's melee — a nuisance to swat on your way through, not a real threat.

## Traps

- **Spike traps** cycle between safe and damaging on a timer — watch the tile, not just the trap.
- **Proximity mines** are revealed from a fair distance away but only actually arm (start their detonation timer) once you get close; backing off in time resets the timer. A spotted mine can be shot from outside its blast radius to disarm it safely.
- No trap, mine, or "technical debt" encounter (spawned by a nearby TODO/FIXME comment) ever lands close enough to your starting point to hit you before you've had a chance to move.

## Scoring

Points come from: kill value (scaled by the enemy's complexity, tripled for Elites), bonuses for finishing with health and ammo left, a speed bonus for clearing quickly, a route-efficiency bonus for taking something close to the shortest possible path, a flat bonus per unique lore terminal read, a flat bonus (double the lore terminal's) per unique secret room opened, and a bonus for exploring 95%+ of a level's walkable area. Your score is a running campaign total — it carries forward across every level you clear and never resets at a level transition.
