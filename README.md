# 🔫 Codeenstein 3D

**Turn your legacy code into a playable retro 3D shooter.**

## Vision

What if you could physically walk through your software architecture? **Codeenstein 3D** is a browser-based retro raycaster that translates local source code into playable dungeons. There's no hand-authored level data — everything you walk through, fight, or read is generated directly from parsing the codebase you point it at.

Load anything from a massive Symfony enterprise project to low-level C code like `pam_usb` — then grab the Regex Shotgun and refactor your way through it.

### Play it right now

A hosted build runs at **[codeenstein3d.mcdope.org](https://codeenstein3d.mcdope.org)** — nothing to clone, install, or
build. The **Demos** tab launches a bundled multi-language campaign that ships inside the app (no local files and no
network needed), and the **Repo** tab turns any public repository — GitHub, GitLab or Codeberg — into a dungeon over the
network. Both work in any modern browser.

Pointing the game at your *own* code is the one thing the hosted build can't do everywhere: reading a local folder uses
the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), which only
Chromium-based browsers (Chrome, Edge, Brave) implement. Your source never leaves the machine either way — the parsing
and level generation happen entirely in the browser, and nothing is uploaded anywhere.

### What in your code becomes what in the game

| In your source code... | ...becomes this in-game |
|---|---|
| A file | A level |
| A folder | Nothing of its own — the tree order (directories first, then alphabetical) is the order you play the levels in |
| A function, method, class or global inside that file | A room of that level |
| A function/method (HP = `cyclomatic_complexity × 35`, split across its pack — doubled and capped for an Elite) | An enemy — higher complexity means more health, more enemies, or a gold-tinted Elite pack |
| A function with code smells (>5 params, >3 nesting levels) | A tougher enemy (scaled bonus complexity) |
| A global variable | An acid pool (hazard terrain) |
| A private/protected method | A locked room, gated behind a key found elsewhere in the level |
| A `goto`/label pair | A pair of linked teleporter pads |
| A large comment block | A lore terminal (press F to read) |
| Dead code, empty catch blocks, deprecated tags, commented-out code, magic-number/blob literals | A secret room hidden behind a fake wall |
| A `switch`/`match` with several cases | A **Switchboard** junction — one short dead-end spur per `case`, each behind a keyless amber door |
| A `try`/`catch`/`finally` | An **Exception Handling Zone** — an acid gauntlet that corrodes away behind you, a guaranteed health-and-Swap alcove, then a safe loot room |
| The `import`s at the top of a file (~1 per 4) | A **Vendor Depot** alcove in the spawn room's wall, stocked for the weapons you already carry |
| A function that allocates heavily (`malloc`/`new`) | An **Acid Overflow** room that floods while you're inside it, until you kill the enemy that function spawned |
| A header file (`.h`) | A bonus level (distinct teal theme, boosted loot) |

See [How It Works](#how-it-works) below for the full detail behind each of these mappings.

---

## Features at a Glance

### Core Gameplay
- ✅ **Multi-language support** — PHP, C/C++, JavaScript/TypeScript, Python, Java, Go, Rust, Ruby, C#, Bash, Scala, Objective-C
- ✅ **Smart entrypoint detection** — finds `main`, else the *least*-complex scoring file, else any parsable file (level 1 shouldn't be the hardest map in the repo)
- ✅ **Full arsenal** — echo pistol, Regex Shotgun, gdb (machine gun), ghidra (rocket launcher), Friday Hotfix (flamethrower), and two melee weapons (the SIGKILL Knife, later replaced by the unlockable Toolchain chainsaw)
- ✅ **Procedural maps** — rooms packed into a connected complex, corridors that vary in width and shape, loops and junctions rather than only dead ends, pillars, secret rooms, traps, teleporters
- ✅ **Advanced enemy AI** — roaming, chasing, melee, ranged attacks (ordinary packs or Elite packs)
- ✅ **Multi-level campaigns** — chain together all parsable files; save & continue progress
- ✅ **Multiplayer co-op** — host or join a real-time session (2-4 players) via a short code or public lobby; WebRTC peer-to-peer, lockstep netcode with drift reconciliation; see [`doc/user/multiplayer.md`](doc/user/multiplayer.md)

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
- ✅ **Gore levels** — adjustable blood particles (None/Normal/More/Extreme/Excessive/Absurd, the last leaving the floor permanently painted)
- ✅ **Difficulty modes** — Easy/Normal/Hard scales enemy HP, damage, ammo scarcity

### Mechanics
- ✅ **Acid pools** — global variables become hazardous terrain
- ✅ **Locked doors & keys** — private/protected methods gated behind dependency keys
- ✅ **Teleporters** — `goto` statements become linked warp pads
- ✅ **Lore terminals** — large code comments appear as glowing walls (press F to read)
- ✅ **Secret rooms** — dead code, swallowed exceptions, deprecated tags, commented-out code, and magic-number/blob literals hidden behind fake walls  
- ✅ **Timed spike traps & proximity mines** — corridor hazards at choke points
- ✅ **Code smells** — functions with more than 5 params or more than 3 nesting levels get tougher

### Loading Options
- ✅ **Local workspace** — pick any folder on your machine (File System Access API)
- ✅ **Public repositories** — paste a GitHub, GitLab or Codeberg URL (or a bare `owner/repo`, which still means GitHub) to load any public repo over the network
- ✅ **Bundled demo campaign** — a multi-language showcase campaign baked into the app itself, no local files or network needed
- ✅ **Replay from any source** — re-pick workspace, auto-fetch the repo from the host it came from, or rebuild the bundled demo campaign

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
- **Functions → Enemies** carrying `cyclomatic_complexity × 35` HP *between them* — one enemy below complexity 5, then one more per 5 on top, splitting that pool rather than inflating a single body
  - At complexity ≥ 40 the room becomes an **Elite pack** instead: 2× the room's HP budget, capped and split across up to 8 members, led by a gold-tinted Elite dealing 2× damage
  - Functions with code smells (more than 5 params, more than 3 nesting levels) get scaled bonus complexity
  
- **Global variables → Acid pools** (hazard terrain)
  
- **Private/protected methods → Locked rooms** (need dependency key to enter)
  
- **`goto`/label pairs → Teleporter pads** (linked, step on one to warp to the other)
  
- **Large comments → Lore terminals** (glowing walls; press F to read, W/S to scroll)
  
- **Dead code, empty catches, deprecated tags, commented-out code, magic blobs → Secret rooms** (hidden behind near-invisible fake walls)
  
- **`switch`/`match` → Switchboards** (a junction hub with one dead-end spur per `case`, each behind a keyless amber branch door — the second of the game's two door types)

- **`try`/`catch`/`finally` → Exception Handling Zones** (acid gauntlet with traps, then guaranteed health *and* Swap, then a safe loot room)

- **Imports → Vendor Depots** (supply alcoves in the spawn room's wall, roughly one per four top-level imports)

- **Allocation-heavy functions → Acid Overflow rooms** (the floor floods tile by tile, with an audible warning, until you kill that function's enemy)

- **Headers (`.h` files) → Bonus levels** (distinct cool-teal theme, boosted loot)

### Enemy Behavior
- **Roams** its room until they notice you (aggro radius + line-of-sight OR just took damage)
- **Chases** around corners and walls
- **Melees** up close on a cooldown
- **Lobs ranged bolts** at range if they have line-of-sight — one per archetype, and the colour tells you which: a regular enemy's magenta bolt, an Elite's slow, heavy orange shell (rare, dodgeable), an Edge Case's fast, weak, slightly-off-target cyan spray (twice as often). Each archetype's damage-over-time is unchanged; only its arrival shape is
- **Elite variants** do everything harder (gold-tinted, 2× damage)
- **Guarded rooms** — a private/protected method's pack puts a heavier gatekeeper up front with lighter escorts behind, at the same total room HP

### Player Combat
- **7 weapons** — echo pistol (hitscan), Regex Shotgun (pellet cone), gdb (auto, low damage), ghidra (slow rocket, splash damage), Friday Hotfix (auto flamethrower, full damage to 2.5 tiles decaying to nothing at 6.5), SIGKILL Knife (instant melee, infinite ammo), Toolchain (unlockable full-auto chainsaw that permanently replaces the knife)
- **Ammo pools** — Bullets (echo pistol), Shells (Regex Shotgun), SMG (gdb), Rockets (ghidra), and Gas (Friday Hotfix), with sparse map pickups as a backup; gdb/ghidra/Friday Hotfix's own pools only drop/spawn once each weapon is unlocked
- **Magazines & reloading** — every gun but the flamethrower holds a magazine (9 pistol, 2 shells, 45 gdb, 1 rocket) and reloads on `R` or automatically when it runs dry; a reload only ever *moves* ammo, and switching weapons cancels it
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
- **Node.js** 22.22.2+, 24.15+, or 26+ — required by jsdom 30 (Vite 8 alone would accept 20.19+/22.12+). Note the gaps: Node 23 and 25 are odd-numbered, never-LTS lines and are excluded; Node 20 reached end-of-life on 2026-04-30
- **Chromium-based browser** (Chrome, Edge, Brave) — File System Access API required, HTTPS or localhost

### Setup
```bash
git clone https://github.com/mcdope/codeenstein3d.git
cd codeenstein3d
npm install
npm run dev
```

Open the printed `localhost` URL, click **Select Workspace**, pick a folder with source code, and click a supported file to drop into its level.

The first `npm run dev` (or `npm run build`) also fetches the online WAD/texture-pack catalog — about 47 MB of downloads from three external hosts, extracting to roughly 99 MB in the gitignored `public/wads/`. It's idempotent, so it only happens once per checkout. **It does not need to succeed**: a download or parse failure warns and the run continues with whatever it got, because everything the catalog feeds is optional — the game ships procedural textures and plays fine without any of it, so a clone with no network still starts and builds. CI passes `--strict` to turn those warnings back into errors, which is what catches a catalog URL that has gone 404.

Multiplayer is the one feature a plain local build can't show you — its tab stays hidden until the build is pointed at a signaling server. See [Multiplayer Server Deployment](doc/dev/multiplayer-deployment.md) if you want it locally, or just use the [hosted build](https://codeenstein3d.mcdope.org).

### Development Scripts
```bash
npm run dev        # Vite dev server with HMR
npm run typecheck  # Type-check only (its own blocking CI gate)
npm test           # Vitest unit suite — blocking CI gate
npm run coverage   # Same, with the 99.9/99.5 coverage gate — blocking CI gate
npm run build      # Production build to dist/
npm run preview    # Serve production build locally
```

There are 16 further `npm run verify:*` scripts — 11 of them driving the real app through Playwright, the rest pure Node — plus the balancing-bot harness. They need a dev server you started yourself and, for the multiplayer ones, a signaling server started *before* it — see [Testing](doc/dev/testing.md#running-the-verify-scripts-locally), which is the file to read before running any of them.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope — `fix(multiplayer):`, `refactor(map):`, `docs:`. Player-visible changes get a line under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md), in player-facing voice.

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
- **1 / 2** — Switch to echo pistol/Regex Shotgun
- **3 / 4 / 5** — Switch to gdb/ghidra/Friday Hotfix (once unlocked)
- **Mousewheel** — Cycle through owned weapons
- **Space** — Quick-melee (SIGKILL Knife, infinite ammo, heals on kill — permanently replaced by the Toolchain chainsaw once found)

### Interaction & Navigation
- **R** — Reload the equipped weapon (also happens automatically when a magazine runs dry)
- **F** — Read nearby lore terminal (hold W/S to scroll) OR open fake wall to reveal secret
- **Tab** — Toggle automap (non-blocking — keep moving/fighting while open; only reveals explored areas)
- **Alt+Enter** — Toggle fullscreen
- **Esc** — Pause (freezes action under "PAUSED" overlay)
- **Right-Ctrl** — Toggle FPS/frame-time display (top-right)
- **F9** — Boss key: hide the game behind a code editor (pauses, leaves fullscreen, silences music); press again to bring it back

### Gamepad
- **Left stick** — Move/strafe
- **Right stick** — Turn
- **RT/R2** — Fire
- **LB/RB** — Cycle weapons
- **R3 or B** — Quick-melee
- **X** — Reload
- **A** — Read a lore terminal / open a fake wall
- **L3 (left-stick click)** — Sprint, held (same 2× speed as `Shift`)
- **Any button** — Dismiss level-start/commit-summary overlays (after ~1.2s lock)

### UI Controls

Everything below lives behind the sidebar's gear (**⚙**) **Settings** tab, grouped into Gameplay, Audio and Texture Pack — except the compass, which is drawn in-game.

- **Compass** — Circular badge (bottom-right of minimap), points toward exit relative to your facing
- **Player name** — Labels your highscore entries, and floats above your character in co-op
- **Gore** — None/Normal/More/Extreme/Excessive/Absurd, scaling blood-particle count, size and how long stains last; Absurd's stains never expire
- **Difficulty** — Easy/Normal/Hard, scaling enemy HP, damage, ammo scarcity
- **Render quality** — Classic (640×400, the default) or Sharp (1280×800 with a half-resolution floor); applies at the next level, and aiming is identical in both
- **Master / SFX / Music** — Volume sliders for each bus (persisted across sessions)
- **Select BGM Folder** — Pick a local folder of audio files for custom playlist (session-only — a browser can't hold onto the folder handle)
- **Load WAD Texture Pack** — Pick a DOOM `.wad` file to source real wall/door/floor textures from (auto-selected, no picker); session-only, falls back silently to defaults for anything not found
- **Or pick an online texture pack** — The curated, license-checked catalog; **remembered between sessions**, with **Use built-in textures** to revert and forget it

### Level Flow
- **Pick workspace** → Auto-starts at detected entrypoint (or first parsable file)
- **Reach green exit tile** → Commit summary screen (with an "Export Map as PNG" button for the level you just cleared) → Next level loads (health/ammo/weapons carry over)
- **Run out of files** → "Build Successful" screen
- **Die** → "Kernel Panic" screen
- **Continue Run button** — Resume a saved campaign exactly where you left off

---

## Status

Feature-complete and playable end to end: parsing for 14 languages, procedural map generation,
the full arsenal, multi-level campaigns, deterministic replays, highscores, WAD texturing, and
2-4 player coop — all covered by a ~99.9%-coverage unit suite plus 14 verify scripts in CI
(10 of them Playwright-driven).

Two features are implemented but shipped **off** behind source flags, both after playtest
feedback: room decorations (billboarding reads as visibly wrong on boxy shapes) and the
level-end player stats screen (a measurable frame-time cost). See
[Feature Flags](doc/dev/architecture.md#feature-flags) for the current defaults and the
reasoning behind each.

Releases are git tags (`beta-1` … `beta-N`) — that tag is the only release identity there is.
`package.json`'s `version` is deliberately unused (`0.0.0`, `private: true`), and nothing in the
running app reports a version, so "which build is this?" is answered by the tag or the commit,
not by the app.

- **[`CHANGELOG.md`](CHANGELOG.md)** — what's new, release by release.
- **[`doc/dev/history.md`](doc/dev/history.md)** — the full record, including the approaches
  that were measured and reverted. Worth more than it sounds: a reverted approach leaves no
  trace in the code, so without that file the next person re-attempts it.

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
docker/                       # Optional self-hosted multiplayer backend (signaling + TURN relay) — see docker/README.md
scripts/                      # Node/Playwright verification + balancing-bot scripts; lib/bot.mjs holds the shared Bot class both generate-default-highscore.mjs and run-balancing-telemetry.mjs drive, lib/combatPolicy.mjs its pure decision core, lib/profiles.mjs the skill tiers
src/
├── main.ts                  # App entry: wires sidebar, parser, map, engine, HUD
├── difficulty.ts            # Difficulty multiplier tables (Easy/Normal/Hard)
├── prng.ts                  # Seeded PRNG (map generation & engine randomness)
├── fs/                      # File System Access API, GitHub/GitLab/Codeberg repo loaders (remoteHost.ts is the shared adapter contract), and the bundled demo-campaign loader
├── ui/                      # Sidebar, console, highscores, overlays (gameHud.ts)
├── parser/                  # Language-agnostic AST layer
│   ├── php/                 # PHP adapter (bespoke)
│   ├── c/                   # C adapter (bespoke)
│   └── generic/             # 12-language data-driven adapter + vocabulary + refinements
├── map/                     # Procedural map generator (grid, enemies, hazards)
├── wad/                     # DOOM WAD parser (PLAYPAL/PNAMES/TEXTUREx/patches/flats) — feeds engine/textures.ts only
├── multiplayer/             # WebRTC session host/guest drivers, lockstep tick pacing, signaling client, netcode wire types
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
    ├── defaultHighscore.ts  # Bundled example leaderboard entries (bot-generated per skill profile, binary-packed + gzipped, lazily imported when the real board is empty)
    ├── replayCodec.ts       # Binary packing for replay frames (3.5x less localStorage than JSON+gzip)
    ├── storageCompression.ts # gzip helpers for localStorage payloads
    ├── replay.ts            # Recording & playback
    ├── audio.ts             # Web Audio synthesis + buses
    ├── bgm.ts               # Custom background-music playback
    ├── hud.ts               # Status bar, crosshair, compass
    ├── automap.ts           # Fog-of-war overlay
    ├── input.ts             # Keyboard, mouse, gamepad
    ├── perfDebug.ts         # Opt-in ?perfDebug=1 per-frame phase-timing diagnostics
    ├── playerStats.ts       # Level-end stats screen (dormant, disabled by default)
    └── telemetry.ts         # Balancing-bot tracking types/helpers
```

---

## Browser Requirements

**Loading a local folder** needs the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), which is currently only available in **Chromium-based browsers** (Chrome, Edge, Brave) served over `localhost` or HTTPS. That is the only feature gated on it: the Demos and Repo tabs, and everything downstream of them, work in any modern browser.

The app detects unsupported browsers and disables the workspace picker with a message, leaving the other tabs usable.

---

## Documentation

Full player-facing docs live in [`doc/user`](doc/user/README.md) — getting started, controls, HUD/UI, game mechanics, colours & pickups, designing your own levels, multiplayer, tips, and troubleshooting.

🔒 If you're wondering what happens to the workspace you point this at, or what gets stored on your machine, see [`doc/user/privacy.md`](doc/user/privacy.md).

Developer-facing docs — architecture, game design rationale, and notable design decisions — live in [`doc/dev`](doc/dev/README.md).

Running the tests, the `verify:*` scripts, or the balancing bot locally: start with [`doc/dev/testing.md`](doc/dev/testing.md). What changed and when: [`CHANGELOG.md`](CHANGELOG.md).

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

### Online WAD/texture-pack catalog (fetched at build time, bundled as static assets)

The sidebar's "Or pick an online texture pack" list offers free, redistributable DOOM-engine WADs and texture packs as an alternative to loading your own local `.wad` file. None of their original hosts send CORS headers that would allow a browser to fetch them directly, so `scripts/fetch-online-wads.mjs` downloads and extracts each one at build/dev time (`predev`/`prebuild` npm hooks — see [Dependency Minimalism](doc/dev/decisions.md#dependency-minimalism)) into `public/wads/`, which is gitignored, not committed; the game then serves them same-origin. See `src/wad/onlineWadCatalog.ts` for the full data model.

| Name | License | Credits | Link |
|---|---|---|---|
| [Freedoom: Phase 1](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) | BSD-3-Clause | [The Freedoom Project](https://freedoom.github.io/) | [freedoom.github.io](https://freedoom.github.io/) |
| [Freedoom: Phase 2](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) | BSD-3-Clause | [The Freedoom Project](https://freedoom.github.io/) | [freedoom.github.io](https://freedoom.github.io/) |
| [FreeDM](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) | BSD-3-Clause | [The Freedoom Project](https://freedoom.github.io/) | [freedoom.github.io](https://freedoom.github.io/) |
| [DOOM (Shareware)](https://doomwiki.org/wiki/DOOM) | id Software Shareware License — free redistribution, no fee for the WAD | [id Software](https://doomwiki.org/wiki/DOOM) | [doomwiki.org](https://doomwiki.org/wiki/DOOM) |
| [HACX 1.2](https://doomwiki.org/wiki/HACX) | **Freeware (Banjo Software / id Software) — non-commercial use only** | [Banjo Software, Inc.](https://doomwiki.org/wiki/HACX) | [doomwiki.org](https://doomwiki.org/wiki/HACX) |

Every entry above has been verified against this project's own `loadWadTextures` parser and resolves most or all of the 20 texture slots it looks for — three structural slots (wall/floor/door) for each of the five per-level stylesets, plus five shared gameplay-signal slots (see `src/wad/onlineWadCatalog.ts`'s doc comment; `npm run report:wad-stylesets` prints the full matrix) — two earlier candidates, Blasphemer (a Heretic-engine WAD with no matching lump names) and OTEX (a texture-only resource pack, no playable levels), were dropped after resolving 0 and 4 slots respectively, of the 10 the allowlist had at the time. HACX's license permits free redistribution but for non-commercial use only, same tier as OTEX before it — included because this project is non-commercial; a commercial fork would need to drop it.

If you believe any of these assets shouldn't be redistributed here, please [open an issue](https://github.com/mcdope/codeenstein3d/issues) and it will be removed promptly.
