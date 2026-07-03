# 🔫 Codeenstein 3D (Working Title)

**Turn your legacy code into a playable retro 3D shooter.**

## 👁️ Project Vision
What if you could physically walk through your software architecture? *Codeenstein 3D* is a browser-based retro raycaster that translates local source code into playable dungeons. 
Every folder is a level. Every file is a room. Every function is an enemy. The higher the cyclomatic complexity, the harder the boss.

Whether it's a massive Symfony enterprise project or low-level C code like the `pam_usb` module – this engine lets you "refactor" with a shotgun.

## 🏗️ Architecture & Pipeline
This project is strictly "Local-First". Proprietary code never leaves your machine.

1. **Local Access (File System Access API):** Direct read access to your local workspace. *Strictly no virtual devices or mocked file systems.*
2. **AST Parser (Web-Tree-Sitter via WASM):** Language-agnostic parsing. Translates source files into Abstract Syntax Trees (AST) to measure complexity, LOC, and entities.
3. **Procedural Map Generator:** Translates the AST JSON into a 2D tile matrix. Nested `if` conditions become labyrinths, global variables become hazard zones.
4. **Raycaster Engine:** A classic 2.5D raycaster, written entirely in the HTML5 `<canvas>`. No WebGL, no Three.js – pure retro mathematics (DDA algorithm).

## 💻 Tech Stack
* **Frontend:** Vanilla TypeScript + Vite (Blazing fast, minimal overhead)
* **Parser:** `web-tree-sitter` (WASM) with `tree-sitter-php` as the first PoC.
* **Rendering:** HTML5 Canvas 2D API
* **OS Focus:** Developed and optimized for modern browsers on Linux (CachyOS / Arch / Debian).

## 🚀 Getting Started
```bash
# Clone repository
git clone [https://github.com/your-username/codeenstein-3d.git](https://github.com/your-username/codeenstein-3d.git)
cd codeenstein-3d

# Install dependencies
npm install

# Start Vite dev server
npm run dev
