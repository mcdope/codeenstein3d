# 🔫 Codeenstein 3D (Working Title)

**Turn your legacy code into a playable retro 3D shooter.**

## 👁️ Project Vision
What if you could physically walk through your software architecture? *Codeenstein 3D* is a browser-based retro raycaster that translates local source code into playable dungeons.
Every folder is a level. Every file is a room. Every function is an enemy. The higher the cyclomatic complexity, the harder the boss.

Whether it's a massive Symfony enterprise project or low-level C code like the `pam_usb` module – this engine lets you "refactor" with a shotgun.

## 🚦 Current Status
Playable end-to-end: pick a local folder, click a PHP file, and fight your way
through the dungeon generated from its structure to the `return` statement.

| Stage | Status |
| --- | --- |
| 1. Local file access (File System Access API) | ✅ Done |
| 2. AST parsing (web-tree-sitter, PHP grammar) | ✅ Done |
| 3. Procedural map generation (rooms + corridors) | ✅ Done |
| 4. Raycaster engine (DDA, first-person controls) | ✅ Done |
| 5. Enemies from entities + hitscan combat | ✅ Done |
| 6. Developer HUD + win/lose game state | ✅ Done |
| Multi-file "levels" / bosses from complexity | 🔜 Planned |
| Additional language grammars (C, JS, …) | 🔜 Planned |

## 🏗️ Architecture & Pipeline
This project is strictly "Local-First". Proprietary code never leaves your machine.

1. **Local Access (File System Access API):** Direct read access to your local workspace via `showDirectoryPicker()`. *Strictly no virtual devices or mocked file systems.* — `src/fs/`
2. **AST Parser (web-tree-sitter via WASM):** Language-agnostic parsing behind a `CodeParserAdapter` interface. Source files are normalized into plain JSON (`linesOfCode` + `entities[]` with start/end lines and a cyclomatic `complexityScore`). The rest of the engine never touches Tree-sitter directly. First grammar: PHP. — `src/parser/`
3. **Procedural Map Generator:** Deterministically translates the normalized JSON into a 2D tile matrix (`0` = floor, `1` = wall). Each entity becomes an enclosed rectangular room; rooms are linked by corridors. It also places an enemy for every function/method (HP scaled from its complexity) and a green **exit tile** — the `return` statement — in the room furthest from spawn. — `src/map/`
4. **Raycaster Engine & Gameplay:** A classic 2.5D raycaster written entirely on the HTML5 `<canvas>` 2D context. No WebGL, no Three.js – pure retro mathematics (DDA algorithm), distance shading, delta-timed first-person movement, and AABB wall collision. Layered on top: billboard enemy sprites (z-buffer occluded), a hitscan "echo pistol", contact damage, and win/lose state. — `src/engine/`

### Gameplay loop
Every **function/method is an enemy** whose **HP equals its cyclomatic complexity** (×25) — so a gnarly function takes more shots to clear. You have **System Stability** (health) and a **Heap / RAM** ammo pool sized to the level. Touching an enemy drains stability; hitting 0 is a **Kernel Panic** (game over). Reach the green `return` tile for a **Build Successful** and drop back to the file tree.

### Data flow
```
Local folder ──▶ CodeParserAdapter ──▶ ParsedFile JSON ──▶ MapGenerator ──▶ GameMap (grid+enemies+exit) ──▶ RaycasterEngine
 (src/fs)          (src/parser)                              (src/map)                                        (src/engine)
```
Each stage only depends on the plain data structure produced by the previous one, so languages, map styles, and renderers can evolve independently.

## 🎮 Controls
Click a `.php` file in the sidebar to generate and enter its level.

* **W / S** – move forward / backward
* **A / D** – turn left / right
* **Mouse** – click the canvas to capture the pointer and look around (`Esc` releases)
* **Click / Space** – fire the echo pistol (hitscan; costs 1 heap)
* **Objective** – clear (or dodge) the enemies and step on the green `return` tile
* A bottom **HUD** shows System Stability, Heap/RAM, processes remaining, and your current target; a top-left minimap shows walls, enemies, the exit, and your facing.

## 💻 Tech Stack
* **Frontend:** Vanilla TypeScript + Vite (no UI framework; minimal dependencies)
* **Parser:** `web-tree-sitter` (WASM) with `tree-sitter-php` as the first PoC grammar
* **Rendering:** HTML5 Canvas 2D API
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
├── ui/                # File-tree sidebar + in-game HTML HUD / end screens (gameHud.ts)
├── parser/            # Language-agnostic AST layer (CodeParserAdapter, registry)
│   └── php/           # PHP adapter backed by tree-sitter-php
├── map/               # Procedural map generator: grid, enemies, exit (+ top-down debug renderer)
└── engine/            # 2.5D raycaster + gameplay: player/camera, DDA renderer, sprites,
                       #   input, hitscan combat, HUD crosshair, and the game loop
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
Workspace**, pick a folder containing PHP, and click a `.php` file to drop into its level.

### Useful scripts
```bash
npm run dev        # Vite dev server with HMR
npm run typecheck  # tsc --noEmit
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
```
