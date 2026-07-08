# Game Mechanics

[← Back to index](README.md)

## How code becomes a level

Codeenstein 3D parses your source into an AST and turns its structure into a playable map:

| Code element | Becomes |
|---|---|
| Folder | A level |
| File | A room (or set of rooms) |
| Function | An enemy — HP scales with its cyclomatic complexity |
| Function with 5+ params or 3+ nesting levels | A tougher enemy (a "code smell" bonus on top of complexity) |
| Function at extreme complexity (≥40) | A single **Elite** enemy instead of a pack — 4× HP, 2× damage, gold-tinted, guarantees a weapon drop |
| Global variable | An acid pool (hazard terrain) |
| Private/protected method | A locked room, gated behind a key placed somewhere already reachable |
| `goto`/label pair | A linked teleporter pad pair |
| Large comment | A glowing lore terminal — press `R` to read it |
| Comment flagged `TODO`/`FIXME` | Also a lore terminal, plus a small "technical debt" encounter nearby: a spike trap, a proximity mine, or a weak enemy (equally likely) |
| Dead/unreachable code | A secret room hidden behind a fake wall (very slightly tinted if you look closely), holding guaranteed loot |
| Header file (`.h`) | A distinct bonus level — cool teal theme, better loot odds, meant as a restock stop |

## Weapons

| Weapon | Slot | Type | Notes |
|---|---|---|---|
| echo pistol | 1 | Hitscan | Starting weapon |
| Regex Shotgun | 2 | 7-pellet cone | Starting weapon |
| SIGKILL Knife | `Left Ctrl` only | Melee | Starting weapon, infinite ammo, heals 1 HP per kill, not on the number row |
| gdb | 4 | Full-auto hitscan | Unlocked by an Elite kill's guaranteed drop, or forced at campaign level 4 |
| ghidra | 5 | Rocket / splash damage | Unlocked by an Elite kill's guaranteed drop, or forced at campaign level 8 |

Ranged weapons draw from two separate ammo pools: **Bullets** (pistol/shotgun/gdb) and **Rockets** (ghidra only). Rocket ammo won't drop or spawn on the map at all until you actually own the launcher. Hitscan pellets deviate more the further away the target is, so point-blank shots are reliable and very long-range ones can miss.

## Loot & Difficulty

Enemy kills roll a random drop: bullets, rockets, health, or swap. A few rules apply on top of the base odds:
- No health drop is ever rolled while you're already at full health (loot goes to ammo/swap instead).
- No rockets are rolled until you own the launcher.
- Elite kills guarantee either a large health pack or (if you're already full) a bigger bullets/swap drop, on top of their guaranteed weapon.

### Difficulty

| Difficulty | Enemy HP | Enemy damage | Pickup amounts |
|---|---|---|---|
| Easy | ×0.7 | ×0.7 | ×1.3 |
| Normal | ×1 | ×1 | ×1 |
| Hard | ×1.5 | ×1.5 | ×0.7 |

Difficulty only affects enemy-dealt melee/ranged damage — traps and rocket self-splash are unaffected.

## Enemies

Enemies roam randomly within their home room until they notice you — which requires being within roughly 7.5 tiles **and** having line-of-sight, or taking a hit from you at any range (getting shot always counts as being spotted). Once aggro'd, they chase you around corners, and attack with melee at close range or ranged plasma bolts if they have line-of-sight at a distance.

## Traps

- **Spike traps** cycle between safe and damaging on a timer — watch the tile, not just the trap.
- **Proximity mines** are revealed from a fair distance away but only actually arm (start their detonation timer) once you get close; backing off in time resets the timer. A spotted mine can be shot from outside its blast radius to disarm it safely.
- No trap, mine, or "technical debt" encounter (spawned by a nearby TODO/FIXME comment) ever lands close enough to your starting point to hit you before you've had a chance to move.

## Scoring

Points come from: kill value (scaled by the enemy's complexity, tripled for Elites), bonuses for finishing with health and ammo left, a speed bonus for clearing quickly, a route-efficiency bonus for taking something close to the shortest possible path, a flat bonus per unique lore terminal read, and a bonus for exploring 95%+ of a level's walkable area. Your score is a running campaign total — it carries forward across every level you clear and never resets at a level transition.
