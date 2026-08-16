# HUD & UI

[← Back to index](README.md)

## In-game HUD

The bottom status bar shows:

- **System Stability** — your health, as a bar and percentage
- **Swap** — your armor-like buffer, absorbs damage 1:1 before health, capped at 100
- **Ammo** — the current weapon's ammo count (or ∞ for a melee weapon — the knife, or Toolchain once it replaces it)
- **Keys** — one pip per locked room on the level, in that room's own colour: hollow while you still need it, filled once you're holding it. A key is permanent and opens every door of its room, so a held/total count would only tell you how much collecting you had left — which colours you have is what decides whether the door in front of you opens. A level with nothing locked shows a dash
- **Score** — your running total, updated live

The crosshair turns red over a valid target, and shows tick marks for weapons that fire in a spread cone. Pulling the trigger on an empty weapon shows a fading "Out of ammo!" toast instead of just doing nothing.

If you enter a cheat code, a badge appears here and stays for the rest of the campaign — a cheated run can't post a score or a replay, and this says so while you're still playing rather than only once the run is over.

Three warning toasts share the top of the screen, each on its own row so they never cover each other when more than one fires at once: "Out of ammo!" on the first, "Memory leak — acid rising!" on the second, and "You need a key!" — walking into a key-locked door empty-handed — on the third, in that door's own blue.

## Minimap & Compass

An always-on minimap sits in the corner, showing the full layout of the current level — walls, doors, hazard tiles, spike traps (color-coded active/safe), teleporters, uncollected keys, lore terminals, and the exit — from the moment the level loads, with **no fog-of-war**: unlike the Tab automap below, nothing here is gated on where you've actually walked. Your own position and facing are shown as a bright triangle, mines and enemies only appear once you've actually spotted them, and the exit marker is always visible, not revealed later. A small circular compass badge is attached to its bottom-right corner — its needle points toward the exit relative to whichever way you're currently facing (dead ahead reads as "up").

Walking into a key-locked door with no key **pings** a key here for a few seconds: its marker brightens and a sonar ring sweeps outward from it, with a soft ping per beat, so you can tell which of several uncollected keys the game is pointing you at. It picks the nearest one by walking distance, not by straight line — a key behind another locked door isn't a suggestion — and the ring is clipped to the panel, so a key near an edge doesn't sweep out over the view.

## Automap

Press `Tab` to open the automap — a translucent overlay, Diablo-style, that does **not** pause the game: you can keep walking, turning, and even firing (the crosshair stays visible) while it's up. It's fog-of-war — only tiles within a few tiles of anywhere you've actually walked are drawn — and shows walls, lore terminals, doors, teleporters, traps (color-coded active/safe), hazard tiles, any mines you've already spotted, and the exit once found. An unopened secret wall renders identically to a plain wall on both the automap and the corner minimap — neither map is allowed to give away where one is; the only hint is the much subtler tint visible in the normal 3D view up close. Structural tiles (walls, doors, teleporters, lore terminals) render in muted greyscale so the map doesn't visually dominate the screen; hazards, active traps, mines, and the exit keep distinct accent colors so danger and goals still read at a glance. The view is zoomed way out, showing a wide swath of the map at once; on maps too large to fit entirely, it follows you so you're always kept in view rather than scrolling off it.

## The Settings tab

All of the game's settings live behind the gear (⚙) tab in the sidebar's tab bar, grouped into Gameplay, Audio and Texture Pack — and they're remembered between sessions (the exceptions are spelled out below).

- **Player name** — labels your runs on the leaderboard, and in multiplayer floats above your character in the 3D view in your own marker colour. Remembered between sessions. Leave it blank and everything reads as it did before you set one.
- **Gore** — None / Normal / More / Extreme, controls blood-particle volume and how long stains linger.
- **Difficulty** — Easy / Normal / Hard, scales enemy HP, enemy damage, and pickup scarcity. See [Mechanics](mechanics.md#difficulty) for exact numbers.
- **Render quality** — Classic or Sharp. Classic keeps the game's intended chunky retro look (640×400) and is the default. Sharp renders internally at 1280×800 — crisper walls, sprites and weapon — paired with a half-resolution floor so it stays fast, and is worth trying on a high-refresh (120Hz+) display. Like gore and difficulty, a change applies at the next level you launch (a small note in the panel says so), and aiming and shots behave identically in both modes — the quality is purely visual.
- **Master / SFX / Music** volume sliders, persisted across sessions.
- **Select BGM Folder** — pick a local folder of `.mp3`/`.ogg`/`.wav` files to play as a shuffled custom soundtrack instead of silence.
- **Load WAD Texture Pack** — pick a DOOM `.wad` file to source real wall/door/floor textures from instead of the built-in default look. The game automatically picks common, broadly-compatible textures/flats out of the WAD (no picker), choosing a *separate* wall/floor/door set for each of the game's stylesets so levels still look different from one another, and falls back silently to the defaults for anything it can't find — a status line under the button reports what was actually used, per styleset.
- **Or pick an online texture pack** — a curated list of free, license-checked WADs and texture packs below the local-file button, no download or file picker needed. Each entry shows its license and credits, with an "info" link to the project's homepage; a license flagged in red (currently only HACX) carries a real usage restriction — read it before you rely on that pack for anything beyond casual play. Clicking a name loads it exactly like a local file would, updating the same status line — and it is remembered, so it comes back on its own next time. **Use built-in textures** appears once anything is loaded and puts the original look back, forgetting the choice. See [Credits & Third-Party Licenses](../../README.md#credits--third-party-licenses) in the main README for the full list with clickable attribution.

Gore, Difficulty, Render quality, the volume sliders and your **online texture pack** are standing preferences, independent of any specific campaign run — pick a pack from the Online list and it is restored automatically on your next visit. The BGM folder and a **local** `.wad` file stay session-only: a browser gives a page no durable handle to a file you picked, so neither the chosen music folder nor a local WAD survives a reload (only the BGM *volume* persists, not which folder is loaded). Picking a local file therefore also clears a remembered online pack, rather than letting it override your choice next time.

## The file tree

The bottom of the sidebar lists the files of the workspace loaded under the tab you are currently looking at — **each tab keeps its own**. Load the Demos campaign, switch to **GitHub** and load a repository, and both are still there: switch between the two tabs and each shows its own files, with the folders you expanded still expanded. **Local** and **Continue** share one, since both are the same local folder on your machine. **Settings** and **Multiplayer** have no workspace of their own and say so rather than showing you another tab's files.

Switching tabs is purely a change of view — it never disturbs the level you are playing. A small dot on a tab marks the workspace the game is actually running from, so you can tell at a glance even while looking at a different one. Clicking a **file** is what switches: it drops you into that file's level and the rest of that workspace becomes the campaign you are playing, exactly as loading it fresh would, which also means it starts that campaign from the beginning.

## Highscores

The **Highscores** button opens a top-10 leaderboard with columns for player, score, level/campaign name, the codebase's total lines/complexity, levels cleared, when the run ended, and an AST hash of the *whole workspace* (so you can compare runs against the exact same code, regardless of which level either run happened to end on). Entries with a recorded replay show **Watch** and **Export** buttons.

If you haven't set any scores of your own yet, the board shows 3 example entries from the bundled Demo Campaign instead of an empty list, each watchable — these disappear the moment you set a real score of your own. They're named **Casual**, **Gamer** and **Pro** after the playtest bot's own skill profiles, which is what makes their scores differ.

### Replay playback

Watching a replay gives you a transport bar: seek back/forward (⏪/⏩, jumps ~5 real-time seconds worth of frames), play/pause, a speed stepper (0.25×–4×), and a Record button (⏺) that exports the replay as a downloadable webm video. Seeking backward rebuilds the level from scratch and fast-forwards to the target point, since the simulation itself isn't reversible.

Recording captures in real time at 1× — starting it locks the rest of the transport bar (seek/pause/speed) and forces playback to 1× for the duration, so the exported video always plays back at the same pace you'd see live. Click the Record button again (or just let the replay end) to stop and download it. The Highscores dialog also has an "Export" button next to each entry's "Watch" — it jumps straight into a recording from the very first frame, after a one-time confirmation that recording locks the transport controls.

## Console Sidebar

When not in fullscreen, a console panel next to the canvas mirrors everything logged to the browser console, plus the occasional in-character hint dropped every 18–40 seconds while a level is running. It's automatically hidden while the canvas is fullscreen.

### Performance diagnostics (`?perfDebug=1`)

If the game ever feels choppy and you want to report it, add `?perfDebug=1` to the page URL and reload. Extra `[perf]` lines appear in the console sidebar — frame timings, what the engine spent each frame on, and basic machine info — updating every couple of seconds and immediately whenever a frame is genuinely slow. Nothing is sent anywhere: the lines only exist in the sidebar (and your browser console), which is exactly the point — a plain screen recording of your game session captures everything needed to diagnose a framedrop, with no developer tools required. Without the URL flag, none of this runs at all.

## Footer

The bottom of the left sidebar has a small copyright/license line (AGPL-3.0-or-later) and a link back to the project's GitHub repository.
