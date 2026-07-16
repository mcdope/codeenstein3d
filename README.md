# 🔫 Codeenstein 3D

**Turn your legacy code into a playable retro 3D shooter.**

## Vision

What if you could physically walk through your software architecture? **Codeenstein 3D** is a browser-based retro raycaster that translates local source code into playable dungeons. There's no hand-authored level data — everything you walk through, fight, or read is generated directly from parsing the codebase you point it at.

Load anything from a massive Symfony enterprise project to low-level C code like `pam_usb` — then grab a shotgun and refactor your way through it.

### What in your code becomes what in the game

| In your source code... | ...becomes this in-game |
|---|---|
| A folder | A level |
| A file | The rooms/corridors of that level |
| A function/method (HP = `cyclomatic_complexity × 25`) | An enemy — higher complexity means more health, pack spawns, or a gold-tinted elite boss |
| A function with code smells (>5 params, >3 nesting levels) | A tougher enemy (scaled bonus complexity) |
| A global variable | An acid pool (hazard terrain) |
| A private/protected method | A locked room, gated behind a key found elsewhere in the level |
| A `goto`/label pair | A pair of linked teleporter pads |
| A large comment block | A lore terminal (press R to read) |
| Dead code, empty catch blocks, deprecated tags, commented-out code, magic-number/blob literals | A secret room hidden behind a fake wall |
| A header file (`.h`) | A bonus level (distinct teal theme, boosted loot) |

See [How It Works](#how-it-works) below for the full detail behind each of these mappings.

---

## Features at a Glance

### Core Gameplay
- ✅ **Multi-language support** — PHP, C/C++, JavaScript/TypeScript, Python, Java, Go, Rust, Ruby, C#, Bash, Scala, Objective-C
- ✅ **Smart entrypoint detection** — finds `main`, highest complexity, or any parsable file
- ✅ **Full arsenal** — pistol, shotgun, machine gun, rocket launcher, flamethrower, and two melee weapons (a knife, later replaced by an unlockable chainsaw)
- ✅ **Procedural maps** — rooms, corridors with jogs, pillars, secret rooms, traps, teleporters
- ✅ **Advanced enemy AI** — roaming, chasing, melee, ranged attacks (packed or elite bosses)
- ✅ **Multi-level campaigns** — chain together all parsable files; save & continue progress

### Game Systems
- ✅ **Retro raycaster engine** — DDA algorithm, distance fog, collision detection
- ✅ **Textured walls, doors & floors** — procedural default textures, or load a real DOOM `.wad` file to source them instead
- ✅ **Scoring system** — kills scaled by complexity, bonuses for speed/health/exploration/lore
- ✅ **Persistent leaderboards** — top-10 board with AST+campaign hashing (compare runs)
- ✅ **Deterministic replay** — record and playback entire multi-level campaigns frame-for-frame
- ✅ **Export replays as video** — record any "Watch Replay" playback as a downloadable webm, from the transport bar or a one-click Highscores "Export" shortcut
- ✅ **Export a cleared level as a PNG** — a top-down, actually-textured image of the level you just won, for sharing (only ever available for a level you've already finished)
- ✅ **Automap with fog of war** — toggle with Tab, non-blocking (keep moving/fighting while it's open), reveals explored areas only
- ✅ **Fullscreen & gamepad** — canvas stays crisp, gamepad works alongside keyboard/mouse

### Audio & Polish  
- ✅ **Procedural audio** — every sound effect synthesized from oscillators (no audio files)
- ✅ **Custom BGM** — pick a local folder of `.mp3`/`.ogg`/`.wav` files, shuffled playlist
- ✅ **Master/SFX/Music sliders** — balanced audio mixing, persisted across sessions
- ✅ **Gore levels** — adjustable blood particles (None/Normal/More)
- ✅ **Difficulty modes** — Easy/Normal/Hard scales enemy HP, damage, ammo scarcity

### Mechanics
- ✅ **Acid pools** — global variables become hazardous terrain
- ✅ **Locked doors & keys** — private/protected methods gated behind dependency keys
- ✅ **Teleporters** — `goto` statements become linked warp pads
- ✅ **Lore terminals** — large code comments appear as glowing walls (press R to read)
- ✅ **Secret rooms** — dead code, swallowed exceptions, deprecated tags, commented-out code, and magic-number/blob literals hidden behind fake walls  
- ✅ **Timed spike traps & proximity mines** — corridor hazards at choke points
- ✅ **Code smells** — functions with more than 5 params or more than 3 nesting levels get tougher

### Loading Options
- ✅ **Local workspace** — pick any folder on your machine (File System Access API)
- ✅ **GitHub repos** — type `owner/repo` to load any public repo over the network
- ✅ **Bundled demo campaign** — a multi-language showcase campaign baked into the app itself, no local files or network needed
- ✅ **Replay from any source** — re-pick workspace, auto-fetch GitHub repo, or rebuild the bundled demo campaign

---

## How It Works

### Data Pipeline
```
Source Code
    ↓
AST Parser (web-tree-sitter, 14 languages)
    ↓
Normalized JSON (entities, complexity, visibility, comments)
    ↓
Procedural Map Generator (grid, enemies, hazards, teleporters)
    ↓
2.5D Raycaster Engine (DDA, collision, gameplay)
```

Each stage only consumes the data structure from the previous stage — languages, map styles, and renderers can evolve independently.

### Level Generation
- **Functions → Enemies** whose HP equals `cyclomatic_complexity × 25`
  - High complexity = more health, pack spawns, or a single elite boss (4× HP, gold tint, 2× damage)
  - Functions with code smells (more than 5 params, more than 3 nesting levels) get scaled bonus complexity
  
- **Global variables → Acid pools** (hazard terrain)
  
- **Private/protected methods → Locked rooms** (need dependency key to enter)
  
- **`goto`/label pairs → Teleporter pads** (linked, step on one to warp to the other)
  
- **Large comments → Lore terminals** (glowing walls; press R to read, W/S to scroll)
  
- **Dead code, empty catches, deprecated tags, commented-out code, magic blobs → Secret rooms** (hidden behind near-invisible fake walls)
  
- **Headers (`.h` files) → Bonus levels** (distinct cool-teal theme, boosted loot)

### Enemy Behavior
- **Roams** its room until they notice you (aggro radius + line-of-sight OR just took damage)
- **Chases** around corners and walls
- **Melees** up close on a cooldown
- **Lobs ranged plasma bolts** at range if they have line-of-sight
- **Elite variants** do everything harder (gold-tinted, 2× damage)

### Player Combat
- **7 weapons** — echo pistol (hitscan), shotgun (pellet cone), gdb (auto, low damage), ghidra (slow rocket, splash damage), Friday Hotfix (auto flamethrower, short hard max range), SIGKILL Knife (instant melee, infinite ammo), Toolchain (unlockable full-auto chainsaw that permanently replaces the knife)
- **Ammo pools** — Bullets (pistol/shotgun), SMG (gdb), Rockets (ghidra), and Gas (Friday Hotfix), with sparse map pickups as a bullets/rockets backup; gdb/ghidra/Friday Hotfix's own pools only drop/spawn once each weapon is unlocked
- **Swap buffer** — absorbs damage 1:1 before health, capped at 100
- **No wasted health drops** — a kill never drops a health pack while you're at full health (elites included); it rolls ammo/swap instead
- **Quick-melee** — Space for an instant knife swing (heals sliver on kill, never switches weapon); once Toolchain is found it permanently takes over Space instead, revving continuously (infinite ammo) for as long as the button's held
- **Ranged accuracy** — pellets deviate cubically with distance (medium range reliable, far range spreads)

### Scoring
- **Running campaign total** — carries forward across every level cleared, never resets at a level transition
- **Kill value** scaled by enemy complexity (tripled for elites)
- **Health/ammo bonuses** for finishing with resources left (lower health/ammo scales the bonus down, no separate penalty on top)
- **Speed bonus** for clearing quickly
- **Route efficiency** bonus (how close to BFS shortest path)
- **Lore bonus** flat points per unique terminal read
- **Secret room bonus** flat points per unique secret room opened (double the lore bonus)
- **100% Exploration bonus** for visiting 95%+ walkable tiles
- **Multi Kill / Ultra Kill** — 3 kills within 3 seconds triggers a "MULTI KILL!" bonus + banner + stinger; 6 within 6 seconds triggers a bigger "ULTRA KILL!" instead

---

## Quick Start

### Requirements
- **Node.js** 18+ 
- **Chromium-based browser** (Chrome, Edge, Brave) — File System Access API required, HTTPS or localhost

### Setup
```bash
git clone https://github.com/mcdope/codeenstein3d.git
cd codeenstein3d
npm install
npm run dev
```

Open the printed `localhost` URL, click **Select Workspace**, pick a folder with source code, and click a supported file to drop into its level.

### Development Scripts
```bash
npm run dev        # Vite dev server with HMR
npm run typecheck  # Type-check only
npm run build      # Production build to dist/
npm run preview    # Serve production build locally
```

---

## Controls

### Movement & Aiming
- **W / S** — Move forward/backward
- **A / D** — Strafe left/right
- **Q / E** — Turn left/right
- **Shift** — Sprint (2× speed)
- **Mouse** — Look around (click canvas or auto-focused on load)

### Combat & Weapons
- **Click** — Fire active weapon (mouse/gamepad only, no keyboard fire key)
- **1 / 2** — Switch to pistol/shotgun
- **3 / 4 / 5** — Switch to gdb/ghidra/Friday Hotfix (once unlocked)
- **Mousewheel** — Cycle through owned weapons
- **Space** — Quick-melee (SIGKILL Knife, infinite ammo, heals on kill — permanently replaced by the Toolchain chainsaw once found)

### Interaction & Navigation
- **R** — Read nearby lore terminal (hold W/S to scroll) OR open fake wall to reveal secret
- **Tab** — Toggle automap (non-blocking — keep moving/fighting while open; only reveals explored areas)
- **F** — Toggle fullscreen
- **Esc** — Pause (freezes action under "PAUSED" overlay)
- **Right-Ctrl** — Toggle FPS/frame-time display (top-right)

### Gamepad
- **Left stick** — Move/strafe
- **Right stick** — Turn
- **RT/R2** — Fire
- **LB/RB** — Cycle weapons
- **R3 or B** — Quick-melee
- **Any button** — Dismiss level-start/commit-summary overlays (after ~1.2s lock)

### UI Controls
- **Compass** — Circular badge (bottom-right of minimap), points toward exit relative to your facing
- **Gore** — Sidebar dropdown (None/Normal/More) scales blood-particle effects
- **Difficulty** — Sidebar dropdown (Easy/Normal/Hard) scales enemy HP, damage, ammo scarcity
- **Master / SFX / Music** — Volume sliders for each bus (persisted across sessions)
- **Select BGM Folder** — Pick a local folder of audio files for custom playlist
- **Load WAD Texture Pack** — Pick a DOOM `.wad` file to source real wall/door/floor textures from (auto-selected, no picker); session-only, falls back silently to defaults for anything not found

### Level Flow
- **Pick workspace** → Auto-starts at detected entrypoint (or first parsable file)
- **Reach green exit tile** → Commit summary screen (with an "Export Map as PNG" button for the level you just cleared) → Next level loads (health/ammo/weapons carry over)
- **Run out of files** → "Build Successful" screen
- **Die** → "Kernel Panic" screen
- **Continue Run button** — Resume a saved campaign exactly where you left off

---

## Completion Status

| # | Feature | Status |
|---|---------|--------|
| 1–2 | File access, AST parsing | ✅ |
| 3–6 | Map generation, raycaster, enemies, HUD | ✅ |
| 7–8 | C-language support, hazards & weapons | ✅ |
| 9–10 | Nested-scope mazes, locked doors & keys | ✅ |
| 11–13 | Canvas HUD, enemy AI, visual feedback | ✅ |
| 14–16 | Procedural audio, weapon viewmodel, fog | ✅ |
| 17–19 | Automap, AI overhaul, ranged combat | ✅ |
| 20–21 | Sprint/strafe/turning, corridor geometry | ✅ |
| 22–23 | Teleporters, multi-level, parser security | ✅ |
| 24–26 | Minimap, entrypoints, save & continue | ✅ |
| 27–30 | Line-of-sight aggro, knife, scoring, sidebar | ✅ |
| 31–33 | Weapon tuning, gamepad, canvas scaling | ✅ |
| 34–35 | Compass redesign, seeded PRNG, replay | ✅ |
| 36–39 | Multi-level replay, GitHub repos, TODO/FIXME | ✅ |
| 40–42 | Test-audio silencing, shebang/no-extension files, license-header lore exclusion | ✅ |
| 43–48 | Highscore/scoring fixes, codebase-stats hash, Armor→Swap rename | ✅ |
| 49–54 | Continue-run fix, full-health drop gating, mine spawn safety, intro screen, control panel redesign | ✅ |
| 55–59 | Loading indicator, weapon hotkey reorder, gdb's own ammo pool, build timestamp, canvas fill | ✅ |
| 60–66 | ghidra damage buff, rocket impact VFX, minimap shrink, sidebar license footer, highscore hash fix, broader/bonus-scoring secret rooms | ✅ |
| 67–70 | Friday Hotfix flamethrower, canvas-blur pause fix, cheat-sequence input guard | ✅ |
| 71–73 | Wall-edge antialiasing, corridor Edge Case enemies, compass flag removal | ✅ |
| 74–78 | Bonus/Elite weapon drops, bundled Demo Campaign + Demos tab, Toolchain chainsaw | ✅ |
| 79–80 | Engine frame-cap investigation (reverted), headless-bot-generated default highscores + replays for the Demo Campaign | ✅ |
| 81 | GitHub Action for the demo-campaign structural verify script | ✅ |
| 82–85 | Perf pass: per-shot enemy/mine projection reuse, ammo/loot/AI dedup, LOS memoization + rocket spatial hash, shared BFS enemy path field | ✅ |
| 86 | Texture-mapped walls/doors/floors (procedural default, or sourced from a loaded DOOM WAD file) | ✅ |
| 87 | Full CI pipeline — browser (Playwright) + no-browser GitHub Actions jobs running every `verify:*` script on push/PR | ✅ |
| 88 | WAD/procedural texturing extended to lore-terminal walls, hazard/teleporter floors, and spike traps | ✅ |
| 89–91 | GitHub-repo workspace loading: stale-load cancellation, and entrypoint-scan/codebase-stats request reduction (a ~100-file repo went from 99 to 13 requests) | ✅ |
| 92 | 100%-coverage Vitest unit test suite (1528 tests), wired as a blocking CI gate | ✅ |
| — | `tsc --noEmit && vite build` added as its own CI gate, after a TypeScript bump broke a build the existing test jobs didn't catch | ✅ |
| — | Room decorations | ⏸️ Implemented, disabled (playtest feedback) |
| — | Automated headless-bot balancing/telemetry system, plus 2 real engine bugs it surfaced (diagonal movement ~41% too fast, a corridor-breakup room silently severing unrelated crossing corridors) and an ammo/loot/difficulty rebalance | ✅ |
| — | Keys no longer cluster in the largest reachable region; default highscore replays now play back at the correct real-time pace instead of ~3x too fast | ✅ |
| — | Watching a replay now returns to the Highscores dialog it was launched from, instead of the plain file-tree placeholder, once it ends | ✅ |
| — | Export "Watch Replay" playback as a downloadable webm video — a Record button on the transport bar, plus a one-click "Export" shortcut in the Highscores dialog | ✅ |
| — | Startpage leads with a plain-English "New to coding?" card, before the more technical code→dungeon mapping | ✅ |
| — | Export a cleared level as a top-down PNG — actual wall/door/floor/hazard/teleporter/spike/lore textures stamped from above, not a flat-color diagram; only available once that level is won | ✅ |
| — | Multi Kill / Ultra Kill score bonus, on-screen banner, and stinger SFX for chaining kills (3-in-3s / 6-in-6s) | ✅ |
| — | Full favicon/icon set (all platforms) generated from the CODE logo | ✅ |
| — | SEO: meta description, Open Graph/Twitter Card tags, JSON-LD, robots.txt, sitemap.xml | ✅ |

---

## Architecture & Tech Stack

### Frontend & Rendering
- **Vanilla TypeScript + Vite** — minimal dependencies, no UI framework
- **HTML5 Canvas 2D** — walls, sprites, HUD, automap (no DOM overlay during gameplay)
- **14 Language Grammars** — `web-tree-sitter` with PHP, C, JavaScript, TypeScript, Python, Java, C++, Go, Rust, Ruby, C#, Bash, Scala, Objective-C

### Audio  
- **Web Audio API** — every sound effect is synthesized from oscillators/noise at runtime
- **Custom BGM** — optional local `.mp3`/`.ogg`/`.wav` playlist, separate gain bus

### Parser Details (Language Support)
- **PHP & C** — hand-written adapters (grammar quirks need precision)
- **12 Generic languages** — single data-driven adapter with per-language refinements
  - Real method vs function distinctions (Python/Scala/C++)
  - Visibility modifiers (Java/C#/Go/Rust/Python/C++)
  - Full Objective-C selector assembly
  - Arrow functions in JS/TS
- **Security layer** — file size caps, binary-content sniff, parse-error handling (no code execution)

### Game Systems
- **Seeded PRNG** — deterministic replay and balance (enemy AI timing, loot rolls, weapon spread)
- **DDA Raycaster** — classic algorithm, no WebGL
- **AABB Collision** — wall & world interaction
- **Scoring** — real-time live updates, final on exit reach
- **Highscores** — SHA-256 AST+campaign hashing, gzip compression to localStorage; a first-time player with no scores yet sees 3 bundled example entries (real, bot-played Demo Campaign runs) instead of an empty board

---

## Project Structure

```
demo-campaign/                # Bundled "Demos" showcase campaign (one level per parser language)
scripts/                      # Node/Playwright verification scripts for demo-campaign/, plus generate-default-highscore.mjs (bakes src/engine/defaultHighscore.ts)
src/
├── main.ts                  # App entry: wires sidebar, parser, map, engine, HUD
├── difficulty.ts            # Difficulty multiplier tables (Easy/Normal/Hard)
├── prng.ts                  # Seeded PRNG (map generation & engine randomness)
├── fs/                      # File System Access API, GitHub repo loader, and the bundled demo-campaign loader
├── ui/                      # Sidebar, console, highscores, overlays (gameHud.ts)
├── parser/                  # Language-agnostic AST layer
│   ├── php/                 # PHP adapter (bespoke)
│   ├── c/                   # C adapter (bespoke)
│   └── generic/             # 12-language data-driven adapter + vocabulary + refinements
├── map/                     # Procedural map generator (grid, enemies, hazards)
├── wad/                     # DOOM WAD parser (PLAYPAL/PNAMES/TEXTUREx/patches/flats) — feeds engine/textures.ts only
└── engine/                  # 2.5D raycaster + gameplay
    ├── engine.ts            # Game loop (sim, combat, stats)
    ├── raycaster.ts         # DDA wall renderer + fog
    ├── textures.ts          # Wall/door/floor TextureSet: procedural defaults, or WAD-sourced via src/wad/
    ├── player.ts            # Camera, movement, collision
    ├── sprites.ts           # Enemy/key/teleporter billboards
    ├── effects.ts           # Bullet tracers, flame streams, blood, explosions
    ├── enemyAi.ts           # AI behavior (roam/chase/melee/ranged)
    ├── pathField.ts         # Shared player-rooted BFS distance field all chasing enemies steer by
    ├── spatialGrid.ts       # Tile-bucketed enemy index for rocket proximity/blast queries
    ├── projectiles.ts       # Enemy bolts
    ├── rockets.ts           # Player rocket projectiles & splash damage
    ├── traps.ts             # Spike traps & proximity mines
    ├── weapons.ts           # Weapon stats, tracers, spread
    ├── ammo.ts              # Ammo pool state & per-pool metadata
    ├── viewmodel.ts         # First-person weapon sprite (Canvas 2D)
    ├── loot.ts              # Weighted random drops
    ├── lootApply.ts         # Drop/pickup application (grant, top-up, elite bonus)
    ├── scoring.ts           # Score calculation
    ├── highscores.ts        # Leaderboard (hashing, compression)
    ├── defaultHighscore.ts  # Bundled example leaderboard entries (bot-generated, shown when the real board is empty)
    ├── storageCompression.ts # gzip helpers for localStorage payloads
    ├── replay.ts            # Recording & playback
    ├── audio.ts             # Web Audio synthesis + buses
    ├── bgm.ts               # Custom background-music playback
    ├── hud.ts               # Status bar, crosshair, compass
    ├── automap.ts           # Fog-of-war overlay
    └── input.ts             # Keyboard, mouse, gamepad
```

---

## Browser Requirements

The [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) is required and is currently only available in **Chromium-based browsers** (Chrome, Edge, Brave) served over `localhost` or HTTPS.

The app detects unsupported browsers and disables the picker with a message.

---

## Documentation

Full player-facing docs live in [`doc/user`](doc/user/README.md) — getting started, controls, HUD/UI, game mechanics, and tips.

🔒 If you're wondering what happens to the workspace you point this at, or what gets stored on your machine, see [`doc/user/privacy.md`](doc/user/privacy.md).

Developer-facing docs — architecture, game design rationale, and notable design decisions — live in [`doc/dev`](doc/dev/README.md).

---

## License

Copyright (C) 2026 Tobias Bäumer.

**Codeenstein 3D** is free software under the **GNU Affero General Public License v3** (or later). See the [`LICENSE`](./LICENSE) file or https://www.gnu.org/licenses/agpl-3.0.html.

⚠️ **Note:** The AGPL's network clause requires that if you run a modified version as a network service, you must offer users the corresponding source code.

---

## Credits & Third-Party Licenses

Codeenstein 3D has almost no runtime dependencies by design (see [Dependency Minimalism](doc/dev/decisions.md#dependency-minimalism)) — the DOOM WAD parser, raycaster, audio synthesis, and PHP/C parser adapters are all hand-rolled. What it does depend on:

### Shipped to players (bundled into the app itself)

| Package | License | Repository |
|---|---|---|
| `web-tree-sitter` | MIT | https://github.com/tree-sitter/tree-sitter |

Plus the 14 Tree-sitter language grammars, compiled to WASM and bundled at build time — all MIT-licensed:

`tree-sitter-bash`, `tree-sitter-c`, `tree-sitter-c-sharp`, `tree-sitter-cpp`, `tree-sitter-go`, `tree-sitter-java`, `tree-sitter-javascript`, `tree-sitter-php`, `tree-sitter-python`, `tree-sitter-ruby`, `tree-sitter-rust`, `tree-sitter-scala`, `tree-sitter-typescript` — all from https://github.com/tree-sitter/, plus `tree-sitter-objc` from https://github.com/tree-sitter-grammars/tree-sitter-objc.

### Build & test tooling (development only, never shipped)

| Package | License | Repository |
|---|---|---|
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Vite | MIT | https://github.com/vitejs/vite |
| esbuild | MIT | https://github.com/evanw/esbuild |
| Vitest / `@vitest/coverage-v8` | MIT | https://github.com/vitest-dev/vitest |
| Playwright | Apache-2.0 | https://github.com/microsoft/playwright |
| jsdom | MIT | https://github.com/jsdom/jsdom |
| `@types/node` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

See each project's own repository for full license text.
