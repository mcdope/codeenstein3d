# Game Mechanics

[← Back to index](README.md)

## How code becomes a level

Codeenstein 3D parses your source into an AST and turns its structure into a playable map:

| Code element | Becomes |
|---|---|
| File | A level |
| Folder | Nothing of its own — the tree order (directories first, then alphabetical) is the order levels are played in |
| Function, method, class or global | A room of that level |
| Function | An enemy in its room — HP scales with its cyclomatic complexity |
| Function with more than 5 params or more than 3 nesting levels | A tougher enemy (a "code smell" bonus on top of complexity) |
| Function at extreme complexity (≥40) | An **Elite pack** — 2× the room's usual HP budget, led by a gold-tinted Elite dealing 2× damage with a 60% chance of an extra weapon drop |
| Global variable | An acid pool (hazard terrain) |
| Private/protected method | A locked room, gated behind a key placed somewhere already reachable |
| `goto`/label pair | A linked teleporter pad pair |
| Large comment | A glowing lore terminal — press `R` to read it |
| Comment flagged `TODO`/`FIXME` | Also a lore terminal, plus a small "technical debt" encounter nearby: a spike trap, a proximity mine, or a weak enemy (equally likely) |
| Dead/unreachable code, an empty (swallowed-exception) catch block, a `@deprecated`/`[Obsolete]` marker, a commented-out code block, or a magic-number/blob literal (long Base64-ish string, `0xDEADBEEF`-style hex constant) | A secret room hidden behind a fake wall (very slightly tinted if you look closely), holding one guaranteed pickup — mega-health, a fat rockets stash, a big Swap top-up, or (if you haven't unlocked it yet) gdb/ghidra/Friday Hotfix outright, or, from campaign level 4 on, the Toolchain chainsaw |
| `switch`/`match` with several cases | A **Switchboard**: that function's room becomes a junction hub with one short dead-end spur per `case`, each behind an amber branch door. Every spur holds a small encounter — an Edge Case enemy, a trap or mine, or a little ammo. The `default` branch gets no spur; it's the corridor you were already on |
| `try`/`catch`/`finally` | An **Exception Handling Zone** hanging off that room: a narrow acid gauntlet with spike traps and a mine (`try`), an alcove with guaranteed health *and* Swap at the far end (`catch`), then a safe room with guaranteed loot (`finally`). The acid **corrodes away under you** — step in a tile and it's gone a couple of seconds later, so the walk back out with the loot is clear. The spikes and the mine don't, and you still pay full price going in |
| `import`/`require`/`#include` (about one per four) | A small **Vendor Depot** alcove built into the spawn room's wall, stocked with third-party supplies — bullets, and rockets/SMG/gas ammo for whichever of those weapons you already own |
| A function that allocates heavily (`malloc`/`new`/big fixed arrays) | An **Acid Overflow** room: walk in and the floor starts flooding with acid, tile by tile. A low warning tone and a "Memory leak — acid rising!" banner tell you the moment it starts, so you're not relying on noticing the floor. Kill the enemy that function spawned and the leak stops where it is |
| Header file (`.h`) | A distinct bonus level — cool teal theme, better loot odds, meant as a restock stop |

The level-start briefing shows how many secret rooms a level actually has ("Secrets") alongside its room/enemy counts — worth keeping an eye on the walls. A single level tops out at 5 of them, however many triggers the file contains.

**What doesn't become a level.** Before anything is parsed, the loader drops directories that are tooling rather than authored code — `.git`, `node_modules`, `vendor`, `dist`, `build`, `.cache`, `.idea`, `.vscode`, `__pycache__` — and test directories (`test`, `tests`, `__tests__`) along with colocated test files (`foo_test.go`, `FooTests.cs`, `bar.spec.ts`). Test code is someone else's map of your code, not your code; letting it in roughly doubles a well-tested repo's campaign with levels that read as duplicates of the ones beside them. The same list applies to a local folder and a GitHub repo alike. See [Troubleshooting](troubleshooting.md) for the rest of what gets skipped silently, and why.

There are two kinds of door, and they're easy to tell apart. A **blue** door is key-locked: you need a dependency key, and the generator always places a reachable one first. An **amber** door is a Switchboard branch door — no key, just walk into it and it opens. Both show in their own colour on the minimap and automap too, so you can tell at a glance whether a door is worth walking to.

Walk into a blue door with no key and it tells you so rather than just refusing: a low thunk as the door doesn't budge, a "You need a key!" banner, and then a few seconds of the nearest key you can actually reach pinging on the minimap — a bright marker with a sonar ring sweeping out of it, one soft ping per beat. "Reachable" is meant literally: it's measured by how far you'd have to walk, so a key sitting behind *another* locked door is skipped rather than sending you at the wall you just bounced off. If every remaining key is walled off for now, you still get the thunk and the banner, just nothing to follow.

Corridors aren't left as bare tubes. Rooms are placed next to each other, so the corridors between them are short to begin with, and rooms that end up near each other but far apart in the source pick up an extra connecting corridor — so a level usually has more than one way round rather than a single branching dead-end. The corridors themselves vary in width (most are a single-file squeeze, some open into two- or three-tile halls) and get dressed with one of six things: a room with a baffle wall, a pillared hall, a pinch-point gateway, an open plaza, a pair of wall alcoves, or a chicane. The same one never appears twice running on one corridor, and any of them that encloses space comes with its own Edge Case enemies — see [Enemies](#enemies) below.

## Weapons

| Weapon | Slot | Type | Notes |
|---|---|---|---|
| echo pistol | 1 | Hitscan, ~6.6 shots/sec | Starting weapon |
| Regex Shotgun | 2 | 7-pellet cone, pump-action (one blast per 0.85s) | Starting weapon |
| SIGKILL Knife | `Space` only | Melee | Starting weapon, infinite ammo, heals 1 HP per kill, not on the number row |
| gdb | 3 | Full-auto hitscan | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 4 |
| ghidra | 4 | Rocket / splash damage | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 8 |
| Friday Hotfix | 5 | Full-auto 6-pellet cone, 3.5-tile max range | Unlocked by an Elite kill's high-odds bonus drop, a rare drop from any kill, or forced at campaign level 12 |
| Toolchain | `Space` only | Full-auto melee | Infinite ammo, 2× the knife's damage, a bigger lifesteal heal, fires as long as you hold the key — permanently replaces the knife on Space once picked up. Found in a secret room, dropped by an Elite kill, or a small chance on any regular kill whose loot roll comes up empty — all gated to campaign level 4 on; **no forced unlock** — a loot-unlucky run can still finish without ever finding it |

Ranged weapons draw from four separate ammo pools: **Bullets** (echo pistol/Regex Shotgun), **SMG Ammo** (gdb only), **Rockets** (ghidra only), and **Gas** (Friday Hotfix only). SMG/rocket/gas ammo won't drop or spawn on the map at all until you actually own the matching weapon. Hitscan pellets deviate more the further away the target is, so point-blank shots are reliable and very long-range ones can miss. Friday Hotfix additionally enforces a hard 3.5-tile max range on top of that — a genuine flamethrower's reach, not just a wide cone that happens to scatter — and fires a fanning flame stream instead of the thin tracer line every other gun draws.

Every gun also has its own **cadence**, and clicking faster can't beat it. The Regex Shotgun is the one you'll feel: it's pump-action, so it cycles for 0.85s after each blast — you'll hear it rack — and that pause is exactly what buys its huge burst damage up close. The echo pistol cycles far quicker (~6.6 shots/sec) but still has a floor. The cadence is tracked per *player*, not per weapon, so switching guns mid-cycle won't let you shoot any sooner; quick-melee on `Space` is always available though, which is your out while a pump finishes.

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

**Edge Cases** are a separate, small breed found only inside the widenings and alcoves dressed into a corridor (never in a normal room): a jarring cyan tint and a noticeably smaller silhouette make them easy to tell apart from a real enemy at a glance. They have very little HP, dart around erratically rather than roaming smoothly, move faster than any other enemy in the game (though not faster than your own sprint), and hit for much less than a normal enemy's melee — a nuisance to swat on your way through, not a real threat.

## Traps

- **Spike traps** cycle between safe and damaging on a timer — watch the tile, not just the trap.
- **Proximity mines** are revealed from a fair distance away but only actually arm (start their detonation timer) once you get close; backing off in time resets the timer. A spotted mine can be shot from outside its blast radius to disarm it safely.
- No trap, mine, or "technical debt" encounter (spawned by a nearby TODO/FIXME comment) ever lands close enough to your starting point to hit you before you've had a chance to move.

## Scoring

Points come from: kill value (scaled by the enemy's complexity, tripled for Elites), bonuses for finishing with health and ammo left, an accuracy bonus for shot-to-hit ratio, a speed bonus for clearing quickly, a route-efficiency bonus for taking something close to the shortest possible path, a flat bonus per unique lore terminal read, a flat bonus (double the lore terminal's) per unique secret room opened, and a bonus for exploring 95%+ of a level's walkable area. Chaining kills fast pays off too: 3 kills within 3 seconds triggers a "MULTI KILL!" bonus (banner + stinger sound), and 6 within 6 seconds a bigger "ULTRA KILL!" instead. Your score is a running campaign total — it carries forward across every level you clear and never resets at a level transition.
