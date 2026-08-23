# Getting Started

[← Back to index](README.md)

## Requirements

- A Chromium-based browser — Chrome, Edge, or Brave. The File System Access API (used to pick a local folder) doesn't exist elsewhere.
- The page needs to be served over `localhost` or HTTPS.

## Picking a workspace

Before you've loaded anything, the main viewport shows an intro screen explaining what the
game is, how source code maps onto the dungeon (files → levels, functions → a room each with
an enemy inside, and so on), and what to expect once you're inside a level. It's replaced the moment a
level launches and won't reappear for the rest of the session.

The very first time you open the game, a short guided tour points at the controls this page
describes — the launch tabs one by one (**Local** for a folder on your machine, **Repo** for a
public repository you don't have a copy of, **Demos** as the path that needs no setup, and
co-op), the file tree, the highscore board (including what **Watch** and **Export** do) and
the console. Along the way it opens the **Settings** tab and walks
through its controls (difficulty, gore, render quality and the rest), then returns you to the
tab you were on. Use the arrow keys or **Back**/**Next** to move through it, **Skip** or
**Escape** to dismiss it. It won't come back once dismissed; everything it covers is written
out below and in the rest of this guide.

The sidebar's tabs are the ways to start a run, plus the gear (⚙), which holds the game's settings and is covered in [HUD & UI](hud-and-ui.md#the-settings-tab). How many you see varies: **Continue** is hidden until you have a saved run, and **Multiplayer** — covered in its own [guide](multiplayer.md) — only appears if the build you are playing was given a signaling server, so a first visit to a fresh copy typically shows four.

- **Local** — click **Select Workspace** and pick a folder on your machine. Anything with source code works, from a single script to a large repo.
- **Continue** — only appears once you have a saved run. Click **Continue Run** to resume exactly where you left off (health, ammo, weapons, and campaign position all restored).
- **Repo** — paste a repository URL from **GitHub, GitLab or Codeberg** and click **Load** to pull any public repository over the network instead of picking a local folder. The host is worked out from the URL, and the button says which one it recognised ("Load from GitLab") so you can see it got the right one before the download starts. A bare `owner/repo` with no host still means GitHub. Four "Suggested repos" quick-pick buttons (Easy/Medium/Hard/Nightmare) below the input fill in and load a known repo of increasing size/complexity if you don't have one in mind.
- **Demos** — click **Launch Demo Campaign** for a bundled, multi-language showcase campaign that ships with the app itself. No local files or network access needed — every level is baked into the app at build time, so it also works offline.

Whichever you use, the loaded workspace's files are listed under the tab you loaded it from, and the other tabs say what they'd load instead. Switching tabs only changes what you're looking at — it never disturbs the level you're playing — and a small **▶** marks the tab the game is running from, turning to **❚❚** whenever it's paused and disappearing altogether once no level is loaded. See [HUD & UI](hud-and-ui.md#the-file-tree) for the details.

Once a workspace loads, the game looks for a sensible starting point — a `main` function, `index.php`, otherwise the *least* complex file it can parse, since complexity is what becomes enemies and health and level 1 shouldn't be the hardest map in the repository — and launches straight into it. You don't need to manually pick a file to begin, though you can also click any file in the sidebar's file tree to jump into it directly. A spinner with a status line (fetching the tree, scanning for an entrypoint, parsing, generating the world) shows in the viewport while this is in progress — for a large repository this can take tens of seconds over the network — the built-in **Nightmare** suggestion (`magento/magento2`) is deliberately about as slow as it gets. If a repo that size comes up short, see [Troubleshooting](troubleshooting.md#a-big-repo-loaded-but-it-seems-incomplete).

## The first level

Every level opens with a **briefing overlay**: the campaign name, the level name ("Compiling `<file>`…"), and stats on how many rooms and enemies the level generated. Click **Start** (or press Space/Enter/Escape, or any gamepad button) to begin — this and every other blocking overlay ignores its own dismiss inputs for the first 1.2 seconds, so mashing fire in the fight that triggered it can't skip it by accident.

**If the briefing seems unresponsive** (especially right after reloading the page, or on Linux/GNOME): your very first click or keypress may only be re-focusing the browser window itself at the OS level, rather than reaching the page — a real desktop-environment behavior (confirmed with GNOME's own `click` focus mode), not a bug in the game. If Start doesn't respond, just click or press it again.

From there you explore, fight, loot, and make your way to the level's exit tile.

## Ending a level

- **Reach the exit** → a **Commit Summary** overlay shows how the level went and a **Continue** button loads the next level, carrying your health, ammo, and weapons forward. An **Export Map as PNG** button also appears below the canvas — it downloads a top-down image of the level you just cleared, textured the same as what you actually saw in-game, for sharing. It's only ever available for a level you've already finished.
  - **The exit only works once its own room is clear.** Standing on the exit tile does nothing at all while any enemy that spawned in that same room is still alive — no message, it just doesn't trigger. Clear the room first.
- **Run out of levels** (you've cleared the whole tree) → **Build Successful**.
- **Die** → **Kernel Panic**. If your run still has a **rollback** left, the screen offers one: **Roll back** restarts the level you died on exactly as you entered it, and **Give up** ends the run and returns you to the file tree. With none left there is no choice to make — the run is over, same as it always was.

### Rollbacks

A run starts with a small budget of rollbacks — **2 on Easy, 1 on Normal, none on Hard** — and the number left is shown above the status bar while you play. On Hard there are none to spend and the Kernel Panic screen keeps its single button: death there is final, which is part of what the tier means. Spending one puts you back at the start of the level you died on, with the health, armour, ammunition, weapons and score you *walked in with*. Whatever you picked up or scored during the failed attempt is gone; so is the damage you took.

Two things are worth knowing. The **level layout is the same** — it is built from the source file and does not change — but the enemies will not behave identically, because their timing, their aim and what they drop are rolled fresh each time you enter. And a run that spends a rollback **still gets a leaderboard entry**; the Highscores dialog marks it in the **RB** column, so a continued run and a clean one are told apart rather than one of them being thrown away. The **Difficulty** column next to it says which setting the run was played on, so the two rows can actually be weighed against each other.

A rollback is spent the moment you die, not when you press the button, so closing the tab at the Kernel Panic screen is not a way to get a free one — resume it later and you will pick up at the start of that level with the rollback already used.

Your progress autosaves as you play — but only for a **Local** workspace, so if you close the tab mid-campaign, **Continue Run** picks it back up (you'll be asked to re-pick the same local folder, since a browser can't hold onto a file handle across sessions). A **Repo** or **Demos** run doesn't persist or offer a "Continue Run": there's no local folder to re-pick for either, and re-fetching/rebuilding one from scratch would silently start the campaign back over rather than truly resuming it, so neither pretends to save.

## Watching a replay

Every highscore entry can be watched back frame-for-frame from the Highscores dialog's **Watch** button, regardless of which tab the original run came from — a Local run asks you to re-pick the same folder, a repo run re-fetches the same repo automatically from the host it came from, and a Demos run rebuilds the bundled campaign on the spot, so the source code needed to reconstruct the level is always available one way or another. From the replay's transport bar you can also **Record** the playback as a downloadable webm video, or use the one-click **Export** shortcut next to the entry in the Highscores dialog itself.
