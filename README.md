# 🔫 Codeenstein 3D (Working Title)

**Turn your legacy code into a playable retro 3D shooter.**

## 👁️ Project Vision
What if you could physically walk through your software architecture? *Codeenstein 3D* is a browser-based retro raycaster that translates local source code into playable dungeons.
Every folder is a level. Every file is a room. Every function is an enemy. The higher the cyclomatic complexity, the harder the boss.

Whether it's a massive Symfony enterprise project or low-level C code like the `pam_usb` module – this engine lets you "refactor" with a shotgun.

## 🚦 Current Status
Playable end-to-end: pick a local folder, click a source file in any of 14
supported languages, and fight your way through the dungeon generated from its
structure to the `return` statement — strafing/sprint movement, native HUD,
procedural retro audio, a swaying weapon viewmodel, an active enemy AI that
roams, chases, melees and shoots back, jogged corridors with pillar-broken
rooms, `goto`-driven teleporter pads, and a togglable automap. Reaching
`return` doesn't end the run: it carries your health and ammo into the next
parsable file in the tree, so a whole codebase plays as one continuous
multi-level run.

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
| Room decorations (racks/plants/desks/blocks) | ⏸️ Implemented, disabled (playtest feedback) |
| Bosses from complexity | 🔜 Planned |
| Scoring + persisted highscores | 🔜 Planned |

## 🏗️ Architecture & Pipeline
This project is strictly "Local-First". Proprietary code never leaves your machine.

1. **Local Access (File System Access API):** Direct read access to your local workspace via `showDirectoryPicker()`. *Strictly no virtual devices or mocked file systems.* — `src/fs/`
2. **AST Parser (web-tree-sitter via WASM):** Language-agnostic parsing behind a `CodeParserAdapter` interface. Source files are normalized into plain JSON (`linesOfCode` + `entities[]` with start/end lines, `visibility`, and a cyclomatic `complexityScore`, plus `gotos[]`: every `goto label;` resolved against its `label:` target by line). The rest of the engine never touches Tree-sitter directly. **14 languages** are supported: PHP and C keep bespoke, hand-written adapters (their grammars have quirks — PHP's global-at-program-scope detection, C's buried function declarator — a generic pass can't capture precisely); JavaScript, TypeScript/TSX, Python, Java, C++, Go, Rust, Ruby, C#, Bash, Scala, and Objective-C all go through one data-driven `GenericParserAdapter`, keyed off a cross-language node-type vocabulary (`src/parser/generic/vocabulary.ts`) verified against each grammar's real `node-types.json` — adding another language is one grammar wasm import + one `LanguageConfig` entry, no new parsing code. On top of the shared defaults, each of those 12 languages gets its own precision refinements (`src/parser/generic/refinements.ts`) so nothing is left as a lowest-common-denominator guess: real method-vs-function distinctions (Python/Scala/C++ class-body ancestry, Rust `impl`/`trait` blocks), real visibility (Java/C#/Scala access modifiers, Rust `pub`, Python's underscore convention, Go's export-by-capitalization convention, C++'s `public:`/`private:`/`protected:` section tracking with correct `class`-vs-`struct` defaults, Ruby's stateful `private`/`protected` toggle), full Objective-C selector assembly (`add:with:`, not just the first name fragment), and JS/TS/TSX capturing `const foo = () => {}`/class-field arrow functions as real entities rather than silently dropping the majority of real-world function definitions. Every grammar wasm is ABI-checked against the pinned `web-tree-sitter` runtime before use (a bulk `tree-sitter-wasms` package and the `tree-sitter-kotlin`/`tree-sitter-lua` npm packages were tried and rejected — wrong ABI or no prebuilt wasm at all). **Security:** only extensions a registered adapter claims ever reach a parser (`isParsable`); on top of that, a size cap and binary-content sniff (`src/parser/security.ts`) reject oversized or binary-looking files before parsing, and any parse failure is caught, logged as a warning, and skipped rather than crashing the map generator or game loop. Source text is only ever fed to `Parser.parse()` — nothing in `src/parser/` evaluates, compiles, or executes loaded code. — `src/parser/`
3. **Procedural Map Generator:** Deterministically translates the normalized JSON into a 2D tile matrix (`0` = floor, `1` = wall, `2` = acid hazard, `3` = locked door, `4` = goto teleporter pad). Each entity becomes an enclosed room — but a **deeply nested function turns into a labyrinth** (recursive-division maze of `1`-walls, passages kept ≥1 tile wide) rather than an open box. Rooms are linked by corridors that **jog with 1-2 turns instead of one straight line** once they get long, so hallways don't offer a full sightline end-to-end; large open rooms also get a scattering of **1-tile pillars** to break up empty floor. It places an enemy for every function/method (HP scaled from its complexity, split into a pack above a complexity threshold), floods every global-variable room with an **acid pool**, locks **private/protected-method** rooms behind **doors** and scatters a matching **dependency key** in reachable public floor (so every level stays solvable), turns every resolved `goto` → label jump into a **linked teleporter pad pair** dropped in the rooms containing the goto and its label, and puts a green **exit tile** — the `return` statement — in the room furthest from spawn, always kept clear of enemies/pillars/pads. (Cosmetic room decorations — server racks, plants, desks, code-blocks — are implemented but currently disabled behind a feature flag pending a design rethink.) — `src/map/`
4. **Raycaster Engine & Gameplay:** A classic 2.5D raycaster written entirely on the HTML5 `<canvas>` 2D context. No WebGL, no Three.js – pure retro mathematics (DDA algorithm), distance-fog shading (full bright near, black beyond ~14 tiles), floor-cast acid/teleporter tiles, delta-timed first-person movement, and AABB wall collision. Layered on top: billboard enemy/key/ammo/teleporter sprites (z-buffer occluded), a weapon arsenal (hitscan pistol + cone shotgun) with a swaying, recoiling viewmodel and head-bob, active enemy AI (roams its room, chases on aggro or on taking damage, melees up close, lobs ranged bolts with line-of-sight at range), impact feedback (screen damage flash, bullet tracers, enemy bleed-flash, falling "digital blood" particles), procedural Web-Audio sound effects, a native-canvas HUD, a togglable automap with fog of war, key-unlocked doors, goto-warp teleporter pads, and win/lose state. When the exit is reached, instead of always ending the run the host (`main.ts`) checks the workspace tree for the next parsable file and — if there is one — silently loads it as the next level with health/ammo carried over; the "Build Successful" screen only appears after the last file. — `src/engine/`

### Gameplay loop
Every **function/method is an enemy** whose **HP equals its cyclomatic complexity** (×25) — so a gnarly function takes more shots to clear, and functions above a complexity threshold spawn a whole *pack* instead of one boss. Enemies aren't static: they **roam** their room until they notice you (within an aggro radius, or the instant you shoot them from further away), then **chase** you around corners and walls, **melee** you up close on a cooldown, or **lob ranged plasma bolts** when they have a clear line of sight at range. Every **global variable becomes an acid pool** (a hazard room) that drains you if you wade through it. **`private`/`protected` methods are locked rooms**: their doors (steel-blue) block you until you pick up a scattered **dependency key** and walk into them, which consumes the key. You have **System Stability** (health) and a shared **Heap / RAM** ammo pool sized to the level — topped up by ammo pickups dropped by defeated enemies — plus a two-weapon arsenal: the **echo pistol** (precise single hitscan) and the **Regex Shotgun** (a cone of pellets — devastating up close, useless at range). Every hit lands with feedback: a screen-shaking damage flash, bullet tracers, enemies flashing red and spraying "digital blood", and procedurally synthesized retro sound effects (no audio files — pure Web Audio oscillators). Touching an enemy, a bolt, or acid drains stability; below 25% a pulsing alarm kicks in. Hitting 0 is a **Kernel Panic** (game over). Any `goto` in the source becomes a pair of linked, pulsing violet **teleporter pads** — step on one and you're warped straight to the other, UT-style. Reach the green `return` tile and, if there's another parsable file left in the tree, you're dropped straight into it as the next level with your stability and heap intact; only run out of files and you get a **Build Successful** screen back to the file tree. Lost? Hit **Tab** for a togglable automap that reveals only the rooms and corridors you've already explored.

### Data flow
```
Local folder ──▶ CodeParserAdapter ──▶ ParsedFile JSON ──▶ MapGenerator ──▶ GameMap (grid+enemies+doors+keys+teleporters+exit) ──▶ RaycasterEngine
 (src/fs)          (src/parser)                              (src/map)                                               (src/engine)
```
Each stage only depends on the plain data structure produced by the previous one, so languages, map styles, and renderers can evolve independently.

## 🎮 Controls
Click a supported source file in the sidebar to generate and enter its level —
PHP, C/C++, JavaScript/TypeScript, Python, Java, Go, Rust, Ruby, C#, Bash,
Scala, or Objective-C.

* **W / S** – move forward / backward
* **A / D** – strafe left / right
* **Q / E** – turn left / right
* **Shift** – sprint (2× move speed)
* **Mouse** – click the canvas to capture the pointer and look around (`Esc` releases)
* **Click / Space** – fire the active weapon
* **1 / 2** – switch weapon (echo pistol / Regex Shotgun)
* **Tab** – toggle the full-screen automap (pauses the action; only explored areas are revealed)
* **Keys & doors** – walk over a gold key to collect it; walk into a blue locked door while holding a key to open it (consumes the key)
* **Ammo pickups** – defeated enemies drop a heap refill; walk over it to collect
* **Teleporter pads** – glowing violet pads generated from `goto`/label jumps; step on one to warp straight to its paired pad
* **Objective** – clear (or dodge) the enemies, avoid the green acid pools and enemy bolts, unlock any doors in your way, and step on the green `return` tile — reaching it advances straight into the next file in the workspace (health/ammo carried over) until you run out of files
* A native-canvas bottom **HUD** keeps it minimal: System Stability, Heap/RAM, keys held, and score (no weapon name or targeted-entity name); a top-left minimap shows walls, enemies, acid, doors, keys, teleporter pads, the exit, and your facing.

## 💻 Tech Stack
* **Frontend:** Vanilla TypeScript + Vite (no UI framework; minimal dependencies)
* **Parser:** `web-tree-sitter` (WASM) with 14 grammars: `tree-sitter-php`, `-c`, `-javascript`, `-typescript`, `-python`, `-java`, `-cpp`, `-go`, `-rust`, `-ruby`, `-c-sharp`, `-bash`, `-scala`, `-objc`
* **Rendering:** HTML5 Canvas 2D API (walls, sprites, HUD, and the automap are all native canvas draws — no DOM overlay for gameplay)
* **Audio:** Web Audio API — every sound effect is synthesized from oscillators/noise at runtime; no audio files
* **OS Focus:** Developed and optimized for modern browsers on Linux (CachyOS / Arch / Debian)

## 🌐 Browser Requirements
The [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
(`showDirectoryPicker()`) is required and is currently only available in Chromium-based
browsers (**Chrome, Edge, Brave**) served over `localhost` or HTTPS. The app detects
unsupported browsers and disables the picker with a message.

## 📂 Project Structure
```
src/
├── main.ts            # App entry: wires the sidebar, parser, map, engine, and HUD together
├── fs/                # File System Access API: workspace picker + directory walk
├── ui/                # File-tree sidebar + end-of-run overlay (gameHud.ts; the live HUD is native canvas)
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
    ├── enemyAi.ts      # Enemy roam/chase/melee/ranged-fire behaviour
    ├── projectiles.ts  # Enemy ranged bolts: spawn, move, collide, render
    ├── weapons.ts      # Weapon stats (pistol/shotgun) + pellet spread
    ├── viewmodel.ts    # First-person weapon sprite, head-bob, recoil
    ├── effects.ts      # Damage flash, bullet tracers, hit-flash, "digital blood" particles
    ├── audio.ts        # Procedural Web Audio sound effects (AudioManager singleton)
    ├── hud.ts          # Native-canvas status bar + crosshair
    ├── automap.ts      # Togglable fog-of-war map overlay
    └── input.ts        # Keyboard/mouse polling + pointer lock
```

## 🚀 Getting Started
Requires Node.js 18+.

```bash
# Clone repository
git clone https://github.com/your-username/codeenstein-3d.git
cd codeenstein-3d

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
