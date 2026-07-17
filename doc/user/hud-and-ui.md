# HUD & UI

[← Back to index](README.md)

## In-game HUD

The bottom status bar shows:

- **System Stability** — your health, as a bar and percentage
- **Swap** — your armor-like buffer, absorbs damage 1:1 before health, capped at 100
- **Ammo** — the current weapon's ammo count (or ∞ for a melee weapon — the knife, or Toolchain once it replaces it)
- **Keys** — how many of the level's keys you're holding, out of the total
- **Score** — your running total, updated live

The crosshair turns red over a valid target, and shows tick marks for weapons that fire in a spread cone.

## Minimap & Compass

An always-on minimap sits in the corner, showing the full layout of the current level — walls, doors, hazard tiles, spike traps (color-coded active/safe), teleporters, uncollected keys, lore terminals, and the exit — from the moment the level loads, with **no fog-of-war**: unlike the Tab automap below, nothing here is gated on where you've actually walked. Your own position and facing are shown as a bright triangle, mines and enemies only appear once you've actually spotted them, and the exit marker is always visible, not revealed later. A small circular compass badge is attached to its bottom-right corner — its needle points toward the exit relative to whichever way you're currently facing (dead ahead reads as "up").

## Automap

Press `Tab` to open the automap — a translucent overlay, Diablo-style, that does **not** pause the game: you can keep walking, turning, and even firing (the crosshair stays visible) while it's up. It's fog-of-war — only tiles within a few tiles of anywhere you've actually walked are drawn — and shows walls, lore terminals, doors, teleporters, traps (color-coded active/safe), hazard tiles, any mines you've already spotted, and the exit once found. An unopened secret wall renders identically to a plain wall on both the automap and the corner minimap — neither map is allowed to give away where one is; the only hint is the much subtler tint visible in the normal 3D view up close. Structural tiles (walls, doors, teleporters, lore terminals) render in muted greyscale so the map doesn't visually dominate the screen; hazards, active traps, mines, and the exit keep distinct accent colors so danger and goals still read at a glance. The view is zoomed way out, showing a wide swath of the map at once; on maps too large to fit entirely, it follows you so you're always kept in view rather than scrolling off it.

## Sidebar Settings

- **Gore** — None / Normal / More, controls blood-particle volume and how long stains linger. (An "Extreme" tier exists in the code but is currently disabled and not shown in the dropdown.)
- **Difficulty** — Easy / Normal / Hard, scales enemy HP, enemy damage, and pickup scarcity. See [Mechanics](mechanics.md#difficulty) for exact numbers.
- **Master / SFX / Music** volume sliders, persisted across sessions.
- **Select BGM Folder** — pick a local folder of `.mp3`/`.ogg`/`.wav` files to play as a shuffled custom soundtrack instead of silence.
- **Load WAD Texture Pack** — pick a DOOM `.wad` file to source real wall/door/floor textures from instead of the built-in default look. The game automatically picks a handful of common, broadly-compatible textures/flats out of the WAD (no picker) and falls back silently to the defaults for anything it can't find — a status line under the button reports what was actually used.
- **Or pick an online texture pack** — a curated list of free, license-checked WADs and texture packs below the local-file button, no download or file picker needed. Each entry shows its license and credits, with an "info" link to the project's homepage; a license flagged in red (currently only HACX) carries a real usage restriction — read it before you rely on that pack for anything beyond casual play. Clicking a name loads it exactly like a local file would, updating the same status line. See [Credits & Third-Party Licenses](../../README.md#credits--third-party-licenses) in the main README for the full list with clickable attribution.

Gore, Difficulty, and the volume sliders are standing preferences, independent of any specific campaign run. The BGM folder and the WAD texture pack (local or online) are both session-only, though: neither the chosen folder nor the loaded WAD is remembered across a page reload — only the BGM volume level persists, not which folder is currently loaded.

## Highscores

The **Highscores** button opens a top-10 leaderboard with columns for score, level/campaign name, the codebase's total lines/complexity, levels cleared, when the run ended, and an AST hash of the *whole workspace* (so you can compare runs against the exact same code, regardless of which level either run happened to end on). Entries with a recorded replay show **Watch** and **Export** buttons.

If you haven't set any scores of your own yet, the board shows 3 example entries from the bundled Demo Campaign instead of an empty list, each watchable — these disappear the moment you set a real score of your own.

### Replay playback

Watching a replay gives you a transport bar: seek back/forward (⏪/⏩, jumps ~5 real-time seconds worth of frames), play/pause, a speed stepper (0.25×–4×), and a Record button (⏺) that exports the replay as a downloadable webm video. Seeking backward rebuilds the level from scratch and fast-forwards to the target point, since the simulation itself isn't reversible.

Recording captures in real time at 1× — starting it locks the rest of the transport bar (seek/pause/speed) and forces playback to 1× for the duration, so the exported video always plays back at the same pace you'd see live. Click the Record button again (or just let the replay end) to stop and download it. The Highscores dialog also has an "Export" button next to each entry's "Watch" — it jumps straight into a recording from the very first frame, after a one-time confirmation that recording locks the transport controls.

## Console Sidebar

When not in fullscreen, a console panel next to the canvas mirrors everything logged to the browser console, plus the occasional in-character hint dropped every 18–40 seconds while a level is running. It's automatically hidden while the canvas is fullscreen.

## Footer

The bottom of the left sidebar has a small copyright/license line (AGPL-3.0-or-later) and a link back to the project's GitHub repository.
