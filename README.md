# 🔫 Codeenstein 3D (Working Title)

**Turn your legacy code into a playable retro 3D shooter.**

## 👁️ Project Vision
What if you could physically walk through your software architecture? *Codeenstein 3D* is a browser-based retro raycaster that translates local source code into playable dungeons.
Every folder is a level. Every file is a room. Every function is an enemy. The higher the cyclomatic complexity, the harder the boss.

Whether it's a massive Symfony enterprise project or low-level C code like the `pam_usb` module – this engine lets you "refactor" with a shotgun.

## 🚦 Current Status
Playable end-to-end: pick a local folder and it auto-starts at the workspace's
detected entrypoint (or the first parsable file if none is found), briefing
you on the level's AST stats before dropping you into the dungeon generated
from its structure. Fight through to the `return` statement — strafing/sprint
movement, native HUD, procedural retro audio, a swaying weapon viewmodel, an
active enemy AI that roams, chases, melees and shoots back, jogged corridors
with pillar-broken rooms, `goto`-driven teleporter pads, timed spike traps and
proximity mines at corridor choke points, and a togglable automap. Reaching
`return` shows a commit summary of the level just cleared, then — instead of
ending the run — carries your health, ammo, and weapon into the next parsable
file in the tree, so a whole codebase plays as one continuous multi-level
campaign. Progress autosaves to `localStorage`, so a "Continue Run" button can
pick up a large repository right where you left off in a later session.
Every level is scored live — kill value, remaining health/ammo, completion
speed, route efficiency, a flat bonus per unique lore terminal read, and a
large "100% Clear" bonus for exploring over 95% of the level's walkable
tiles, minus a malus for finishing hurt. A run records
a top-10 leaderboard entry (score, campaign name, how many levels were
cleared, and a SHA-256 hash of the run-ending level's AST + campaign name,
for comparing runs) once it actually ends — on death, or on finishing the
whole campaign — never on an ordinary mid-campaign level clear — viewable in
a sidebar Highscores dialog. A sidebar Master/SFX/Music volume mixer balances
the procedural sound effects against an optional custom BGM folder (local
`.mp3`/`.ogg`/`.wav` files, played back as a shuffled, looping playlist).
The windowed canvas now scales to fit any viewport without clipping, and a
gamepad can drive the whole game (movement, aiming, firing, weapon cycling,
quick-melee) alongside keyboard and mouse. A small exit-pointing compass
needle sits in its own dedicated cutout in the minimap's frame. The end-of-run
overlays ("Kernel Panic"/"Build Successful"/commit summary/level-start
briefing) now ignore keyboard, mouse, and gamepad dismiss input for a short
lock window after they appear, so mashing the fire button in the fight that
triggered one can't instantly close it before it's even read. The console
sidebar's random hints also never repeat the same line twice in a row. Every
simulation-relevant random draw (enemy AI timing/roam targets, loot rolls,
weapon spread) now runs through a seeded PRNG instead of `Math.random()`,
which powers a new deterministic replay system: every level of a run is
recorded, one segment per level, and from the Highscores dialog a "Watch
Replay" button re-picks the workspace, verifies each level's file still
hashes to what was recorded, and plays the whole run back level-by-level
frame-for-frame against freshly regenerated maps — a full multi-level
campaign, not just the level it ended on.

| Stage | Status |
| --- | --- |
| 1. Local file access (File System Access API) | ✅ Done |
| 2. AST parsing (web-tree-sitter, PHP grammar) | ✅ Done |
| 3. Procedural map generation (rooms + corridors) | ✅ Done |
| 4. Raycaster engine (DDA, first-person controls) | ✅ Done |
| 5. Enemies from entities + hitscan combat | ✅ Done |
| 6. Developer HUD + win/lose game state | ✅ Done |
| 7. C-language support (`tree-sitter-c`) | ✅ Done |
| 8. Hazards (globals → acid) + weapon arsenal | ✅ Done |
| 9. Nested-scope labyrinths (deep code → maze) | ✅ Done |
| 10. Locked doors (private/protected) + keys | ✅ Done |
| 11. Native canvas HUD + enemy ammo loot drops | ✅ Done |
| 12. Active enemy AI (chase + melee) | ✅ Done |
| 13. Visual feedback (damage flash, tracers, blood) | ✅ Done |
| 14. Procedural retro audio (Web Audio synthesis) | ✅ Done |
| 15. Weapon viewmodel, head-bob, recoil | ✅ Done |
| 16. Distance fog depth shading | ✅ Done |
| 17. Automap overlay with fog of war | ✅ Done |
| 18. Enemy AI overhaul (roaming, packs, damage aggro) | ✅ Done |
| 19. Ranged enemy combat (projectiles) | ✅ Done |
| 20. Strafing, sprint, Q/E turning, trimmed HUD | ✅ Done |
| 21. Environment geometry (corridor jogs, pillars) | ✅ Done |
| 22. Goto teleporters + multi-level progression | ✅ Done |
| 23. Universal language parsing + parser security hardening | ✅ Done |
| 24. Minimap overhaul, logical entrypoints, trap mechanics | ✅ Done |
| 25. Engine fixes: z-sorting, focus, safe spawns, pause/fullscreen | ✅ Done |
| 26. Campaign flow: start/commit screens, save & continue | ✅ Done |
| 27. Line-of-sight aggro, SIGKILL Knife, Cone of Fire | ✅ Done |
| 28. Full arsenal (MP, Rocket Launcher), loot economy, Elite bosses | ✅ Done |
| 29. Secret rooms, lore terminals, bonus levels, console sidebar | ✅ Done |
| 30. Controls overhaul (quick-melee, mousewheel), gore levels, FPS overlay | ✅ Done |
| 31. Weapon tuning/renaming, forced unlocks, code smells, difficulty | ✅ Done |
| 32. Scoring, persisted highscores (AST/campaign hash), custom BGM + volume mixer | ✅ Done |
| 33. Exploration/lore score bonuses, ammo tuning, gamepad support, canvas scaling | ✅ Done |
| 34. Exit compass fix + redesign, end-game dialog dismiss lock, non-repeating hints | ✅ Done |
| 35. Compass notch cutout, Cone of Fire tuning, seeded PRNG + deterministic replay system | ✅ Done |
| 36. Replay system expanded to a whole multi-level campaign run | ✅ Done |
| Room decorations (racks/plants/desks/blocks) | ⏸️ Implemented, disabled (playtest feedback) |

## 🏗️ Architecture & Pipeline
This project is strictly "Local-First". Proprietary code never leaves your machine.

1. **Local Access (File System Access API):** Direct read access to your local workspace via `showDirectoryPicker()`. *Strictly no virtual devices or mocked file systems.* — `src/fs/`
2. **AST Parser (web-tree-sitter via WASM):** Language-agnostic parsing behind a `CodeParserAdapter` interface. Source files are normalized into plain JSON (`linesOfCode` + `entities[]` with start/end lines, `visibility`, and a cyclomatic `complexityScore`, plus `gotos[]`: every `goto label;` resolved against its `label:` target by line, `comments[]`: large/multi-line comments worth surfacing as in-game lore, and `deadCodeRegions[]`: statements found unreachable after an unconditional `return` in the same block). Every function/method's `complexityScore` also folds in two heuristic **code smells** — more than 5 parameters, or more than 3 levels of nesting — as a scaled bonus (worse than the threshold = more bonus, not a flat penalty), on top of the normal decision-point count; a smelly function ends up tougher (or spawns as an Elite at extreme complexity) the same way genuinely complex control flow already did. The rest of the engine never touches Tree-sitter directly. **14 languages** are supported: PHP and C keep bespoke, hand-written adapters (their grammars have quirks — PHP's global-at-program-scope detection, C's buried function declarator — a generic pass can't capture precisely); JavaScript, TypeScript/TSX, Python, Java, C++, Go, Rust, Ruby, C#, Bash, Scala, and Objective-C all go through one data-driven `GenericParserAdapter`, keyed off a cross-language node-type vocabulary (`src/parser/generic/vocabulary.ts`) verified against each grammar's real `node-types.json` — adding another language is one grammar wasm import + one `LanguageConfig` entry, no new parsing code. On top of the shared defaults, each of those 12 languages gets its own precision refinements (`src/parser/generic/refinements.ts`) so nothing is left as a lowest-common-denominator guess: real method-vs-function distinctions (Python/Scala/C++ class-body ancestry, Rust `impl`/`trait` blocks), real visibility (Java/C#/Scala access modifiers, Rust `pub`, Python's underscore convention, Go's export-by-capitalization convention, C++'s `public:`/`private:`/`protected:` section tracking with correct `class`-vs-`struct` defaults, Ruby's stateful `private`/`protected` toggle), full Objective-C selector assembly (`add:with:`, not just the first name fragment), and JS/TS/TSX capturing `const foo = () => {}`/class-field arrow functions as real entities rather than silently dropping the majority of real-world function definitions. Every grammar wasm is ABI-checked against the pinned `web-tree-sitter` runtime before use (a bulk `tree-sitter-wasms` package and the `tree-sitter-kotlin`/`tree-sitter-lua` npm packages were tried and rejected — wrong ABI or no prebuilt wasm at all). **Security:** only extensions a registered adapter claims ever reach a parser (`isParsable`); on top of that, a size cap and binary-content sniff (`src/parser/security.ts`) reject oversized or binary-looking files before parsing, and any parse failure is caught, logged as a warning, and skipped rather than crashing the map generator or game loop. Source text is only ever fed to `Parser.parse()` — nothing in `src/parser/` evaluates, compiles, or executes loaded code. — `src/parser/`
3. **Procedural Map Generator:** Deterministically translates the normalized JSON into a 2D tile matrix (`0` = floor, `1` = wall, `2` = acid hazard, `3` = locked door, `4` = goto teleporter pad, `5` = timed spike trap, `6` = fake wall hiding a secret room, `7` = lore terminal). Each entity becomes an enclosed room, with the player spawning in whichever corner of the first room sits farthest from every enemy-bearing room's center (best-effort — aggro now requires a clear line of sight in addition to proximity, so it can no longer reach through a wall, but a small/dense level may still have no fully safe corner) — but a **deeply nested function turns into a labyrinth** (recursive-division maze of `1`-walls, passages kept ≥1 tile wide) rather than an open box. Rooms are linked by corridors that **jog with 1-2 turns instead of one straight line** once they get long, so hallways don't offer a full sightline end-to-end; large open rooms also get a scattering of **1-tile pillars** to break up empty floor. It places an enemy for every function/method (HP scaled from its complexity, split into a pack above a complexity threshold — or, at *extreme* complexity, a single 4x-HP **Elite boss** instead of the biggest pack), floods every global-variable room with an **acid pool**, locks **private/protected-method** rooms behind **doors** and scatters a matching **dependency key** in reachable public floor (so every level stays solvable), turns every resolved `goto` → label jump into a **linked teleporter pad pair** dropped in the rooms containing the goto and its label, scatters **timed spike traps** and invisible **proximity mines** at 1-tile-wide corridor choke points (never in open room floor), sprinkles a sparse handful of static **bullets/rockets pickups** across non-spawn rooms as a backup ammo source (boosted in odds and amount on a **bonus level** — see below), carves a hidden room behind a **fake wall** for every unreachable ("dead") code region found (near-indistinguishable from a normal wall until opened — just a very slight hue nudge for a close look — with a guaranteed high-value pickup inside), turns every large source comment into a glowing **lore terminal** wall tile near the room it came from, and puts a green **exit tile** — the `return` statement — in the room furthest from spawn, always kept clear of enemies/pillars/pads. A file whose extension marks it as a header (`.h`) generates as a **bonus level** (`GameMap.bonusLevel`) — a restock arena the raycaster themes distinctly and the loot systems favor. (Cosmetic room decorations — server racks, plants, desks, code-blocks — are implemented but currently disabled behind a feature flag pending a design rethink.) — `src/map/`
4. **Raycaster Engine & Gameplay:** A classic 2.5D raycaster written entirely on the HTML5 `<canvas>` 2D context. No WebGL, no Three.js – pure retro mathematics (DDA algorithm), distance-fog shading (full bright near, black beyond ~14 tiles), floor-cast acid/teleporter/spike-trap tiles, delta-timed first-person movement, and AABB wall collision. Every world billboard (enemies, projectiles, rockets, keys, loot drops, the exit marker, teleporters, decorations, mines) is collected into one list and drawn in a single pass sorted furthest-to-nearest, so a nearer item always paints over a farther one regardless of which category it belongs to. Layered on top: a **five-weapon arsenal**, each with its own bottom-of-screen silhouette and tracer color — the **echo pistol** (hitscan), **Regex Shotgun** (cone of pellets), fully-automatic **gdb** (high fire rate, low damage — renamed from "MP" in Task 31), a **ghidra** launcher firing a real, slow projectile that explodes for distance-scaled AoE splash damage (catching the player too, if they're standing too close; renamed from "Rocket Launcher"), and the infinite-ammo **SIGKILL Knife** bound exclusively to **Left-Ctrl** as an instant "quick-melee" swing — a pure viewmodel overlay, independent of whatever ranged weapon is equipped (the equipped weapon, its ammo, and the HUD never change); number keys and the **mousewheel** cycle only the four ranged weapons. gdb/ghidra aren't available from the start — an Elite kill's guaranteed drop unlocks either early, and a campaign-progression safety net force-unlocks gdb at level 4 and ghidra at level 8 regardless (never removes anything, so an already-looted weapon is unaffected). Ranged pellets carry a small random aim deviation that grows *cubically* with range (not linearly or quadratically) instead of a hard cutoff (a "Cone of Fire") — medium-range shots stay reliable, and only the last stretch before the true maximum visual range (where the world fades to black anyway) spreads noticeably. Active enemy AI roams its room, chases on line-of-sight aggro or on taking damage regardless of sightline, melees up close, or lobs ranged bolts with line-of-sight at range — Elites do this too, just harder (bigger, gold-tinted, 2x damage). Regular kills roll a weighted random drop (bullets, rockets, a health pack, or an **armor** shard — a new stat absorbed 1:1 before health on any hit, capped at 100); Elite kills instead guarantee a still-unowned heavier weapon or a large heal. Impact feedback covers screen damage flash, per-weapon bullet tracers, rocket-blast VFX circles, enemy bleed-flash, and falling "digital blood" particles whose count, rendered size, and landed floor-stain lifetime all scale with a **Gore level** setting (None/Normal/More = 0x/1x/3x, a sidebar dropdown persisted to `localStorage` and read once per level launch — Extreme/10x exists in the code but is hidden behind a disabled flag for now, playtest feedback called it over-the-top), plus procedural Web-Audio sound effects, a native-canvas HUD with a redesigned always-on minimap (semi-transparent dark panel, a bright directional player triangle, a pulsing high-contrast exit marker, and enemies hidden until the player's collision box AABB-intersects their room), a togglable automap with fog of war, key-unlocked doors, goto-warp teleporter pads, timed spike traps and proximity mines, a toggleable Fullscreen API hook (the canvas stays crisply pixelated at any scale, fullscreen included), a **Right-Ctrl-toggled FPS/frame-time overlay** (top-right, visible across every render state), and a distinct pause overlay (window blur forces it, Escape toggles it, a click resumes) separate from the automap pause, plus win/lose state. Pressing **R** near a glowing lore terminal pauses the sim and shows the source comment it was generated from on a native-canvas overlay (holding **W/S** scrolls it if it's too long for one screen, with a scrollbar shown only when it actually overflows); pressing **R** while facing a fake wall opens the secret room hidden behind it permanently. A bonus (`.h`) level renders with a distinct cool steel/teal wall and floor palette instead of the normal warm brick, both in the 3D scene and the minimap. Every level is bracketed by two blocking overlays (`src/ui/gameHud.ts`): a **level-start briefing** (campaign/level name, room/enemy counts — the engine isn't even started until it's acknowledged) and, on reaching the exit, a **commit summary** (lines refactored, bugs squashed) before the next file loads. When the exit is reached, instead of always ending the run the host (`main.ts`) checks the workspace tree for the next parsable file and — if there is one — silently loads it as the next level with health/armor/ammo/weapon(s) carried over; the "Build Successful" screen only appears after the last file. Progress autosaves to `localStorage` on level transitions and periodically during play; a "Continue Run" button re-picks the workspace (file handles can't survive a page reload) and resumes at the saved file, falling back to a fresh entrypoint launch if it's no longer found. Clearing a level scores it (`src/engine/scoring.ts`): points per kill scaled by the killed entity's complexity (tripled for an Elite), plus bonuses for remaining health/ammo, completion speed, and how close the actual route was to the BFS-shortest spawn→exit path (`GameMap.shortestPathTiles`), minus a malus for finishing below full health — recomputed live every frame for the HUD's Score readout, final the instant the exit is reached. That score is recorded (`src/engine/highscores.ts`) once the run actually ends — on death, or on finishing the whole campaign, never on an ordinary mid-campaign level clear — into a persisted top-10 board, alongside how many levels were cleared and a SHA-256 hash of the run-ending level's parsed AST JSON plus the campaign name (`crypto.subtle.digest`) — two runs over the exact same source under the same campaign name hash identically, letting a player spot at a glance whether a leaderboard entry is really the same code — viewable in a sidebar-triggered Highscores dialog. Audio is now two independent buses under one master gain (`src/engine/audio.ts`): every procedural sound effect through an SFX bus, and an optional custom BGM folder (`src/engine/bgm.ts` — local `.mp3`/`.ogg`/`.wav` files picked via the File System Access API, played back through an `<audio>` element as a shuffled, looping playlist) through its own BGM bus, with a sidebar Master/SFX/Music slider trio (persisted to `localStorage`) balancing all three. — `src/engine/`

### Gameplay loop
Every **function/method is an enemy** whose **HP equals its cyclomatic complexity** (×25) — so a gnarly function takes more shots to clear, and functions above a complexity threshold spawn a whole *pack* instead of one boss, or — at *extreme* complexity — a single boss-tier **Elite** (1.5x size, gold tint, 4x HP, 2x damage) instead of the biggest pack. Two **code smells** pad that complexity further: more than 5 parameters, or more than 3 levels of nesting, each add a scaled bonus — a smelly function is a tougher fight, on top of whatever its actual control flow already earned it. A sidebar **Difficulty** setting (Easy/Normal/Hard) then multiplies everyone's HP (0.7x/1x/1.5x) and the damage they deal to you, while inversely scaling how much ammo/health/armor you find — harder is scarcer, not just tougher. Enemies aren't static: they **roam** their room until they notice you — within an aggro radius *and* with a clear line of sight, or instantly regardless of sightline the moment you shoot them from further away — then **chase** you around corners and walls, **melee** you up close on a cooldown, or **lob ranged plasma bolts** when they have a clear line of sight at range — though they stay off your always-on minimap entirely until you've physically walked into their room. Every **global variable becomes an acid pool** (a hazard room) that drains you if you wade through it. **`private`/`protected` methods are locked rooms**: their doors (steel-blue) block you until you pick up a scattered **dependency key** and walk into them, which consumes the key. Corridors hide their own hazards too: **timed spike traps** cycle between safe and damaging on a per-trap clock (metal grey → pulsing red), and **proximity mines** stay completely invisible until you get close — then reveal well before they're actually dangerous, giving you room to back off (resetting the fuse), route around, or shoot the now-spotted mine to disarm it (safe from a distance, but a point-blank shot still catches you in the blast). You have **System Stability** (health), an **Armor** buffer that absorbs damage 1:1 before stability does, and two separate ammo pools — **Bullets** and **Rockets** — sized to the level and topped up by loot drops or sparse map pickups. The arsenal: the **echo pistol** (precise single hitscan), the **Regex Shotgun** (a cone of pellets — devastating up close, useless at range), the fully-automatic **gdb** (high fire rate, low damage per round), and **ghidra** (a real, slow projectile that explodes for distance-scaled splash damage — including on you, if you're standing too close) — switch between these four with number keys or the **mousewheel**. The infinite-ammo **SIGKILL Knife** isn't one of them: it's bound exclusively to **Left-Ctrl** as an instant quick-melee swing (point-blank only, but every kill heals a sliver of stability) that overlays on top of whatever's equipped without ever switching away from it. gdb and ghidra aren't available from the start: an Elite kill's guaranteed drop unlocks one early, carried over between levels — and if you haven't looted either by then, gdb force-unlocks at campaign level 4 and ghidra at level 8 as a progression safety net. Every weapon has its own tracer color and its own bottom-of-screen silhouette. Ranged shots also carry a small random deviation that grows cubically with distance to whatever's downrange, so medium-range shots stay reliable and only a far-off shot near the edge of visibility can go wide. Defeating a regular enemy rolls a random drop — bullets, rockets, a health pack, or an armor shard; an Elite's death instead guarantees a still-unowned weapon or a large heal. Every hit lands with feedback: a screen-shaking damage flash, per-weapon bullet tracers, rocket-blast VFX, enemies flashing red and spraying "digital blood", and procedurally synthesized retro sound effects (no audio files — pure Web Audio oscillators). Touching an enemy, a bolt, acid, an active spike, or a mine blast drains stability (armor first); below 25% a pulsing alarm kicks in. Hitting 0 is a **Kernel Panic** (game over). Any `goto` in the source becomes a pair of linked, pulsing violet **teleporter pads** — step on one and you're warped straight to the other, UT-style. Large source comments become glowing **lore terminals**: press **R** nearby to pause and read the original comment, scrolling with **W/S** if it runs long. Unreachable ("dead") code hides a **secret room** behind a fake wall that blocks like a normal one and looks almost identical — a very slight cool hue nudge is the only tell, for a player who looks closely — press **R** while facing the right stretch of wall to open it and claim the mega-health or fat rockets stash inside. A `.h` (or equivalent header) file loads as a **bonus level**: a visibly different cool steel/teal theme, more static pickups, and kills that favor scarcer, higher-value drops — a deliberate restock stop. Reach the green `return` tile and, if there's another parsable file left in the tree, you're dropped straight into it as the next level with your stability, armor, ammo, and unlocked weapons intact; only run out of files and you get a **Build Successful** screen back to the file tree. Lost? Hit **Tab** for a togglable automap that reveals only the rooms and corridors you've already explored (fake walls carry the same subtle tint there too, not full camouflage). Not fullscreen? A console sidebar next to the canvas mirrors the game's `console.log` output (real messages only — object dumps like a whole parsed AST or generated map are never rendered there, so it stays readable, and the messages themselves are written to never spoil something you're meant to find in-world, like an exit or secret room's coordinates) and occasionally drops a random hint (never the same one twice in a row). A sidebar **Gore** dropdown scales how much "digital blood" a kill sprays (None/Normal/More — Extreme is temporarily disabled), a sidebar **Difficulty** dropdown (Easy/Normal/Hard) scales enemy HP (0.7x/1x/1.5x), enemy-dealt damage, and ammo/health/armor pickup amounts (inversely — harder is scarcer, not just tougher), and **Right-Ctrl** toggles a small FPS/frame-time readout if you want to keep an eye on performance.

### Data flow
```
Local folder ──▶ CodeParserAdapter ──▶ ParsedFile JSON ──▶ MapGenerator ──▶ GameMap (grid+enemies+doors+keys+teleporters+traps+exit) ──▶ RaycasterEngine
 (src/fs)          (src/parser)                              (src/map)                                                     (src/engine)
```
Each stage only depends on the plain data structure produced by the previous one, so languages, map styles, and renderers can evolve independently.

## 🎮 Controls
Picking a workspace auto-starts the level for its detected entrypoint (a
recognized filename like `main.c`/`index.php`/`main.py`/`main.go`/`main.rs`,
or — for the C family, where no filename convention is reliable — the first
file found to actually define a `main()` function), falling back to the first
parsable file in tree order if nothing matches. Click any other supported
source file in the sidebar to jump into its level instead — PHP, C/C++,
JavaScript/TypeScript, Python, Java, Go, Rust, Ruby, C#, Bash, Scala, or
Objective-C. A **"Continue Run"** button appears next to "Select Workspace"
whenever a saved campaign exists, letting you re-pick the same workspace and
resume exactly where you left off (health, armor, ammo, unlocked weapons, and
file included).
Every level opens on a briefing overlay (room/enemy counts) you have to
acknowledge before it starts, and reaching the exit shows a commit summary
before the next one loads. Every one of these overlays (plus the end-of-run
"Kernel Panic"/"Build Successful" screens) ignores keyboard/mouse/gamepad
dismiss input for about a second and a half after it appears, so mashing the
fire button in the fight that triggered it can't instantly close it before
you've even read it.

* **W / S** – move forward / backward
* **A / D** – strafe left / right
* **Q / E** – turn left / right
* **Shift** – sprint (2× move speed)
* **Mouse** – click the canvas to capture the pointer and look around (the canvas grabs keyboard focus automatically on load, no extra click needed first)
* **Click / Space** – fire the active weapon
* **1 / 2** – switch weapon (echo pistol / Regex Shotgun)
* **4 / 5** – switch to gdb / ghidra, once unlocked (an Elite kill's guaranteed drop, or a forced unlock at campaign level 4/8 — locked slots just do nothing)
* **Mousewheel** – cycle through the ranged weapons you currently own (wraps at both ends)
* **Left-Ctrl** – quick-melee: an instant SIGKILL Knife swing, independent of whatever ranged weapon is equipped (never runs dry, no cooldown beyond your own press rate)
* **R** – interact: read a nearby glowing lore terminal (hold W/S to scroll if it's too long for one screen), or open a fake wall you're facing to reveal the secret room behind it (not bound to E — E is already turn-right in this game's Q/E-turn scheme)
* **Tab** – toggle the full-screen automap (pauses the action; only explored areas are revealed)
* **F** – toggle fullscreen
* **Esc** – pause (freezes the action under a "PAUSED" overlay, distinct from the automap; a click or a second `Esc` resumes); also releases pointer lock / exits fullscreen per normal browser behavior. Losing window focus (alt-tab, etc.) pauses the same way automatically.
* **Right-Ctrl** – toggle a small FPS/frame-time readout, top-right (off by default)
* **Gamepad** – left stick moves/strafes, right stick turns, RT/R2 fires, the bumpers (LB/RB) cycle through your owned ranged weapons, and R3 (right stick click) or B triggers quick-melee — works alongside keyboard/mouse at the same time, no mode switch needed. Also dismisses the level-start/commit-summary/end-of-run overlays (any button, after the dismiss lock above expires)
* **Compass** – a small needle in its own dedicated cutout in the minimap's bottom-right corner (separated from the grid itself, not overlapping it), always pointing from your current position toward the exit tile *relative to your own facing* — dead ahead reads as "up," directly behind reads as "down"
* **Gore** – a sidebar dropdown (None/Normal/More — Extreme is temporarily disabled, playtest feedback called it over-the-top) scaling blood-particle count, size, and how long a landed particle lingers; persisted across sessions, takes effect on the next level load
* **Difficulty** – a sidebar dropdown (Easy/Normal/Hard) scaling enemy HP (0.7x/1x/1.5x), enemy-dealt damage, and ammo/health/armor pickup amounts (inversely — Hard is scarcer, not just tougher); persisted across sessions, takes effect on the next level load. Normal also rolls enemy loot kind against a slightly ammo-favoring weight table (playtest feedback was that ammo ran too scarce there specifically), and static map ammo pickups grant ~40-50% more per pickup than before across all difficulties
* **Score** – points per kill (scaled by the killed entity's complexity, tripled for an Elite), plus bonuses for remaining health/ammo, completion speed, route efficiency (how close your path was to the shortest spawn→exit route), a flat bonus per unique lore terminal read, and a large "100% Clear" bonus for exploring over 95% of the level's walkable tiles before reaching the exit, minus a malus for finishing below full health; live in the HUD, final the moment you reach the exit
* **Highscores** – a sidebar button opens a dialog listing the top-10 scored runs (score, campaign name, levels cleared, and a truncated SHA-256 hash of the run-ending level's AST + campaign name, so you can tell whether a leaderboard entry is really the same code); an entry is only recorded once a run actually ends — on death, or on finishing the whole campaign — not on every intermediate level clear
* **Watch Replay** – entries recorded since this feature shipped get a "Watch Replay" button: re-pick the same workspace, and — after verifying each level's re-parsed file still hashes to what was recorded — the exact run plays back level-by-level, frame-by-frame, against freshly regenerated maps, carrying health/ammo/weapons forward between levels exactly as recorded (Esc stops early)
* **Master / SFX / Music** – three sidebar volume sliders balancing the procedural sound effects against any custom BGM, persisted across sessions
* **Select BGM Folder** – pick a local folder of `.mp3`/`.ogg`/`.wav` files to play as a shuffled, looping background-music playlist behind the game's own sound effects
* **Keys & doors** – walk over a gold key to collect it; walk into a blue locked door while holding a key to open it (consumes the key)
* **Loot drops** – defeated enemies drop bullets, rockets, a health pack, or an armor shard; an Elite instead guarantees a still-unowned weapon or a big heal — walk over any of it to collect
* **Ammo pickups** – a sparse handful of static bullets/rockets pickups scattered across the map as a backup source (more frequent and generous on a bonus level); walk over one to collect
* **Teleporter pads** – glowing violet pads generated from `goto`/label jumps; step on one to warp straight to its paired pad
* **Lore terminals** – glowing wall tiles generated from large source comments; press **R** nearby to pause and read the original comment (hold **W/S** to scroll if it doesn't fit on one screen)
* **Secret rooms** – hidden behind a fake wall (indistinguishable from a real one) generated from unreachable "dead" code; press **R** while facing one to open it and claim the high-value loot inside
* **Bonus levels** – a `.h` (or equivalent header) file loads with a distinct cool steel/teal theme and boosted loot, as a restock stop rather than a fight
* **Spike traps** – floor tiles at corridor choke points that alternate safe (grey) and damaging (pulsing red) on a timer; cross while safe
* **Proximity mines** – invisible until you get close, revealing well before they're dangerous; back off to reset the fuse, or shoot a spotted mine to disarm it (safe at range, still hurts point-blank)
* **Objective** – clear (or dodge) the enemies, avoid the green acid pools, enemy bolts, spike traps, and mines, unlock any doors in your way, and step on the green `return` tile — reaching it advances straight into the next file in the workspace (health/armor/ammo/weapons carried over) until you run out of files
* A native-canvas bottom **HUD** keeps it minimal: System Stability, Armor, ammo for whichever ranged weapon is equipped (Bullets/Rockets), keys held, and score (no weapon name or targeted-entity name — and it never reflects a quick-melee swing, which is a pure overlay); a top-left minimap over a semi-transparent dark panel shows walls, acid, doors, keys, teleporter pads, spike traps, discovered mines, the pulsing exit, and your exact position/facing as a bright triangle — enemies only appear once you've physically entered their room.

## 💻 Tech Stack
* **Frontend:** Vanilla TypeScript + Vite (no UI framework; minimal dependencies)
* **Parser:** `web-tree-sitter` (WASM) with 14 grammars: `tree-sitter-php`, `-c`, `-javascript`, `-typescript`, `-python`, `-java`, `-cpp`, `-go`, `-rust`, `-ruby`, `-c-sharp`, `-bash`, `-scala`, `-objc`
* **Rendering:** HTML5 Canvas 2D API (walls, sprites, HUD, and the automap are all native canvas draws — no DOM overlay for gameplay)
* **Audio:** Web Audio API — every sound effect is synthesized from oscillators/noise at runtime, no bundled audio files; an optional custom BGM folder plays local `.mp3`/`.ogg`/`.wav` files instead, mixed in via a separate gain bus
* **Platform:** Nothing in the stack is OS-specific — any OS running a supported Chromium-based browser works identically (see Browser Requirements below). Developed on Linux, but that's just the author's own machine, not a constraint.

## 🌐 Browser Requirements
The [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
(`showDirectoryPicker()`) is required and is currently only available in Chromium-based
browsers (**Chrome, Edge, Brave**) served over `localhost` or HTTPS. The app detects
unsupported browsers and disables the picker with a message.

## 📂 Project Structure
```
src/
├── main.ts            # App entry: wires the sidebar, parser, map, engine, and HUD together
├── difficulty.ts       # Difficulty setting (Easy/Normal/Hard) + HP/damage/ammo-rate multiplier table — layer-neutral, shared by main.ts and engine.ts
├── prng.ts             # Seeded mulberry32 PRNG — layer-neutral, shared by the map generator and the engine's own gameplay randomness
├── fs/                # File System Access API: workspace picker + directory walk
├── ui/                # File-tree sidebar, external console sidebar, highscore table, + all DOM overlays (gameHud.ts: level-start briefing, commit summary, end-of-run; the live HUD is native canvas)
├── parser/            # Language-agnostic AST layer (CodeParserAdapter, registry, astUtils, security)
│   ├── php/           # PHP adapter backed by tree-sitter-php (bespoke)
│   ├── c/             # C adapter backed by tree-sitter-c (bespoke)
│   └── generic/       # One data-driven adapter for the other 12 languages + shared vocabulary + per-language refinements
├── map/               # Procedural map generator: grid, enemies, exit (+ top-down debug renderer)
└── engine/            # 2.5D raycaster + gameplay
    ├── engine.ts       # Game loop: sim, combat, damage, stats — ties every system below together
    ├── raycaster.ts    # DDA wall renderer + floor-cast background, with distance fog
    ├── player.ts       # Camera/movement + shared AABB wall-collision test
    ├── sprites.ts      # Billboard rendering for enemies/keys/teleporters + crosshair hit-testing
    ├── enemyAi.ts      # Enemy roam/chase/melee/ranged-fire behaviour (roam-target/fire-cooldown randomness takes a seeded rng)
    ├── projectiles.ts  # Enemy ranged bolts: spawn, move, collide, render
    ├── traps.ts        # Timed spike trap + proximity mine runtime behavior
    ├── weapons.ts      # Weapon stats/tracers/viewmodel kind per weapon + pellet spread
    ├── loot.ts         # Weighted random loot-drop resolution (bonus-level and difficulty aware)
    ├── scoring.ts      # End-of-level score breakdown (kills/health/ammo/speed/path/exploration/lore) — pure, recomputed live
    ├── highscores.ts   # SHA-256 AST+campaign hashing, persisted top-10 leaderboard (each entry can carry a replay payload)
    ├── replay.ts        # Deterministic replay: CampaignReplayRecorder (one segment per level played) + ReplayPlaybackInput (replays it)
    ├── bgm.ts          # Custom BGM: folder pick, shuffled looping playlist over the audio.ts BGM bus
    ├── rockets.ts      # Player rocket projectiles: spawn, move, AoE splash damage
    ├── viewmodel.ts    # First-person weapon sprite, head-bob, recoil
    ├── effects.ts      # Damage flash, bullet tracers, hit-flash, "digital blood" particles
    ├── audio.ts        # Procedural Web Audio sound effects (AudioManager singleton) + Master/SFX/BGM gain buses
    ├── hud.ts          # Native-canvas status bar + crosshair + exit compass (embedded in the minimap's frame)
    ├── automap.ts      # Togglable fog-of-war map overlay
    └── input.ts        # Keyboard/mouse polling + pointer lock + Gamepad API polling; captureSnapshot() feeds the replay recorder
```

## 🚀 Getting Started
Requires Node.js 18+.

```bash
# Clone repository
git clone https://github.com/mcdope/codeenstein3d.git
cd codeenstein3d

# Install dependencies
npm install

# Start Vite dev server
npm run dev
```

Then open the printed `localhost` URL in a Chromium-based browser, click **Select
Workspace**, pick a folder containing source code, and click a supported file to drop into its level.

### Useful scripts
```bash
npm run dev        # Vite dev server with HMR
npm run typecheck  # tsc --noEmit
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
```

## 📜 License
Copyright (C) 2026 Tobias Bäumer.

Codeenstein 3D is free software: you can redistribute it and/or modify it under
the terms of the **GNU Affero General Public License** as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed **without any warranty**. See the
[`LICENSE`](./LICENSE) file for the full text, or
<https://www.gnu.org/licenses/agpl-3.0.html>.

Note the AGPL's network clause: if you run a modified version of this software
as a network service, you must offer its users the corresponding source.
