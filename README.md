# 🔫 Codeenstein 3D (Working Title)

**Turn your legacy code into a playable retro 3D shooter.**

## Vision

What if you could physically walk through your software architecture? **Codeenstein 3D** is a browser-based retro raycaster that translates local source code into playable dungeons.

- Every **folder** is a level
- Every **file** is a room  
- Every **function** is an enemy (HP = cyclomatic complexity)
- The higher the code complexity, the harder the fight

Load anything from a massive Symfony enterprise project to low-level C code like `pam_usb` — then grab a shotgun and refactor your way through it.

---

## Features at a Glance

### Core Gameplay
- ✅ **Multi-language support** — PHP, C/C++, JavaScript/TypeScript, Python, Java, Go, Rust, Ruby, C#, Bash, Scala, Objective-C
- ✅ **Smart entrypoint detection** — finds `main`, highest complexity, or any parsable file
- ✅ **Full arsenal** — pistol, shotgun, machine gun, rocket launcher, and a melee knife
- ✅ **Procedural maps** — rooms, corridors with jogs, pillars, secret rooms, traps, teleporters
- ✅ **Advanced enemy AI** — roaming, chasing, melee, ranged attacks (packed or elite bosses)
- ✅ **Multi-level campaigns** — chain together all parsable files; save & continue progress

### Game Systems
- ✅ **Retro raycaster engine** — DDA algorithm, distance fog, collision detection
- ✅ **Scoring system** — kills scaled by complexity, bonuses for speed/health/exploration/lore
- ✅ **Persistent leaderboards** — top-10 board with AST+campaign hashing (compare runs)
- ✅ **Deterministic replay** — record and playback entire multi-level campaigns frame-for-frame
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
- ✅ **Secret rooms** — dead code hidden behind fake walls  
- ✅ **Timed spike traps & proximity mines** — corridor hazards at choke points
- ✅ **Code smells** — functions with 5+ params or 3+ nesting levels get tougher

### Loading Options
- ✅ **Local workspace** — pick any folder on your machine (File System Access API)
- ✅ **GitHub repos** — type `owner/repo` to load any public repo over the network
- ✅ **Replay from either source** — re-pick workspace or auto-fetch GitHub repo

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
  - Functions with code smells (5+ params, 3+ nesting levels) get scaled bonus complexity
  
- **Global variables → Acid pools** (hazard terrain)
  
- **Private/protected methods → Locked rooms** (need dependency key to enter)
  
- **`goto`/label pairs → Teleporter pads** (linked, step on one to warp to the other)
  
- **Large comments → Lore terminals** (glowing walls; press R to read, W/S to scroll)
  
- **Dead code regions → Secret rooms** (hidden behind near-invisible fake walls)
  
- **Headers (`.h` files) → Bonus levels** (distinct cool-teal theme, boosted loot)

### Enemy Behavior
- **Roams** its room until they notice you (aggro radius + line-of-sight OR just took damage)
- **Chases** around corners and walls
- **Melees** up close on a cooldown
- **Lobs ranged plasma bolts** at range if they have line-of-sight
- **Elite variants** do everything harder (gold-tinted, 2× damage)

### Player Combat
- **5 weapons** — echo pistol (hitscan), shotgun (pellet cone), gdb (auto, low damage), ghidra (slow rocket, splash damage), SIGKILL Knife (instant melee, infinite ammo)
- **Ammo pools** — Bullets and Rockets, with sparse map pickups as backup; rocket ammo only drops/spawns once ghidra is unlocked, bullets otherwise
- **Swap buffer** — absorbs damage 1:1 before health, capped at 100
- **No wasted health drops** — a kill never drops a health pack while you're at full health (elites included); it rolls ammo/swap instead
- **Quick-melee** — Left-Ctrl for instant knife swing (heals sliver on kill, never switches weapon)
- **Ranged accuracy** — pellets deviate cubically with distance (medium range reliable, far range spreads)

### Scoring
- **Running campaign total** — carries forward across every level cleared, never resets at a level transition
- **Kill value** scaled by enemy complexity (tripled for elites)
- **Health/ammo bonuses** for finishing with resources left (lower health/ammo scales the bonus down, no separate penalty on top)
- **Speed bonus** for clearing quickly
- **Route efficiency** bonus (how close to BFS shortest path)
- **Lore bonus** flat points per unique terminal read
- **100% Exploration bonus** for visiting 95%+ walkable tiles

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
- **Click / Space** — Fire active weapon
- **1 / 2** — Switch to pistol/shotgun
- **4 / 5** — Switch to gdb/ghidra (once unlocked)
- **Mousewheel** — Cycle through owned weapons
- **Left-Ctrl** — Quick-melee (SIGKILL Knife, infinite ammo, heals on kill)

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
- **Any button** — Dismiss level-start/commit-summary overlays (after ~1.5s lock)

### UI Controls
- **Compass** — Circular badge (bottom-right of minimap), points toward exit relative to your facing
- **Gore** — Sidebar dropdown (None/Normal/More) scales blood-particle effects
- **Difficulty** — Sidebar dropdown (Easy/Normal/Hard) scales enemy HP, damage, ammo scarcity
- **Master / SFX / Music** — Volume sliders for each bus (persisted across sessions)
- **Select BGM Folder** — Pick a local folder of audio files for custom playlist

### Level Flow
- **Pick workspace** → Auto-starts at detected entrypoint (or first parsable file)
- **Reach green exit tile** → Commit summary screen → Next level loads (health/ammo/weapons carry over)
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
| — | Room decorations | ⏸️ Implemented, disabled (playtest feedback) |

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
- **Highscores** — SHA-256 AST+campaign hashing, gzip compression to localStorage

---

## Project Structure

```
src/
├── main.ts                  # App entry: wires sidebar, parser, map, engine, HUD
├── difficulty.ts            # Difficulty multiplier tables (Easy/Normal/Hard)
├── prng.ts                  # Seeded PRNG (map generation & engine randomness)
├── fs/                      # File System Access API + GitHub repo loader
├── ui/                      # Sidebar, console, highscores, overlays (gameHud.ts)
├── parser/                  # Language-agnostic AST layer
│   ├── php/                 # PHP adapter (bespoke)
│   ├── c/                   # C adapter (bespoke)
│   └── generic/             # 12-language data-driven adapter + vocabulary + refinements
├── map/                     # Procedural map generator (grid, enemies, hazards)
└── engine/                  # 2.5D raycaster + gameplay
    ├── engine.ts            # Game loop (sim, combat, stats)
    ├── raycaster.ts         # DDA wall renderer + fog
    ├── player.ts            # Camera, movement, collision
    ├── sprites.ts           # Enemy/key/teleporter billboards
    ├── enemyAi.ts           # AI behavior (roam/chase/melee/ranged)
    ├── projectiles.ts       # Enemy bolts & player rockets
    ├── traps.ts             # Spike traps & proximity mines
    ├── weapons.ts           # Weapon stats, tracers, spread
    ├── loot.ts              # Weighted random drops
    ├── scoring.ts           # Score calculation
    ├── highscores.ts        # Leaderboard (hashing, compression)
    ├── replay.ts            # Recording & playback
    ├── audio.ts             # Web Audio synthesis + buses
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
