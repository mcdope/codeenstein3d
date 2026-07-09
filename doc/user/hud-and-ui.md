# HUD & UI

[← Back to index](README.md)

## In-game HUD

The bottom status bar shows:

- **System Stability** — your health, as a bar and percentage
- **Swap** — your armor-like buffer, absorbs damage 1:1 before health, capped at 100
- **Ammo** — the current weapon's ammo count (or ∞ for the melee knife)
- **Keys** — how many of the level's keys you're holding, out of the total
- **Score** — your running total, updated live

The crosshair turns red over a valid target, and shows tick marks for weapons that fire in a spread cone.

## Minimap & Compass

An always-on minimap sits in the corner, showing your exact position and facing as a bright triangle, and a pulsing marker for the exit once it's been revealed. A small circular compass badge is attached to its bottom-right corner — its needle points toward the exit relative to whichever way you're currently facing (dead ahead reads as "up").

## Automap

Press `Tab` to open the automap — a translucent overlay, Diablo-style, that does **not** pause the game: you can keep walking, turning, and even firing (the crosshair stays visible) while it's up. It's fog-of-war — only tiles within a few tiles of anywhere you've actually walked are drawn — and shows walls, secret walls (with a very slight tint difference from real ones), lore terminals, doors, teleporters, traps (color-coded active/safe), hazard tiles, any mines you've already spotted, and the exit once found. Structural tiles (walls, doors, teleporters, secret walls, lore terminals) render in muted greyscale so the map doesn't visually dominate the screen; hazards, active traps, mines, and the exit keep distinct accent colors so danger and goals still read at a glance. The view is zoomed way out, showing a wide swath of the map at once; on maps too large to fit entirely, it follows you so you're always kept in view rather than scrolling off it.

## Sidebar Settings

- **Gore** — None / Normal / More, controls blood-particle volume and how long stains linger. (An "Extreme" tier exists in the code but is currently disabled and not shown in the dropdown.)
- **Difficulty** — Easy / Normal / Hard, scales enemy HP, enemy damage, and pickup scarcity. See [Mechanics](mechanics.md#difficulty) for exact numbers.
- **Master / SFX / Music** volume sliders, persisted across sessions.
- **Select BGM Folder** — pick a local folder of `.mp3`/`.ogg`/`.wav` files to play as a shuffled custom soundtrack instead of silence.

All of these are standing preferences, independent of any specific campaign run.

## Highscores

The **Highscores** button opens a top-10 leaderboard with columns for score, level/campaign name, the codebase's total lines/complexity, levels cleared, when the run ended, and an AST hash of the *whole workspace* (so you can compare runs against the exact same code, regardless of which level either run happened to end on). Entries with a recorded replay show a **Watch** button.

### Replay playback

Watching a replay gives you a transport bar: seek back/forward (⏪/⏩, jumps ~5 real-time seconds worth of frames), play/pause, and a speed stepper (0.25×–4×). Seeking backward rebuilds the level from scratch and fast-forwards to the target point, since the simulation itself isn't reversible.

## Console Sidebar

When not in fullscreen, a console panel next to the canvas mirrors everything logged to the browser console, plus the occasional in-character hint dropped every 18–40 seconds while a level is running. It's automatically hidden while the canvas is fullscreen.

## Footer

The bottom of the left sidebar has a small copyright/license line (AGPL-3.0-or-later) and a link back to the project's GitHub repository.
