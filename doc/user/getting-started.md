# Getting Started

[← Back to index](README.md)

## Requirements

- A Chromium-based browser — Chrome, Edge, or Brave. The File System Access API (used to pick a local folder) doesn't exist elsewhere.
- The page needs to be served over `localhost` or HTTPS.

## Picking a workspace

Before you've loaded anything, the main viewport shows an intro screen explaining what the
game is, how source code maps onto the dungeon (folders → levels, files → rooms, functions →
enemies, and so on), and what to expect once you're inside a level. It's replaced the moment a
level launches and won't reappear for the rest of the session.

The sidebar has four tabs for starting a run:

- **Local** — click **Select Workspace** and pick a folder on your machine. Anything with source code works, from a single script to a large repo.
- **Continue** — only appears once you have a saved run. Click **Continue Run** to resume exactly where you left off (health, ammo, weapons, and campaign position all restored).
- **GitHub** — type an `owner/repo` reference and click **Load from GitHub** to pull any public repository over the network instead of picking a local folder. Four "Suggested repos" quick-pick buttons (Easy/Medium/Hard/Nightmare) below the input fill in and load a known repo of increasing size/complexity if you don't have one in mind.
- **Demos** — click **Launch Demo Campaign** for a bundled, multi-language showcase campaign that ships with the app itself. No local files or network access needed — every level is baked into the app at build time, so it also works offline.

Once a workspace loads, the game looks for a sensible starting point — a `main` function, `index.php`, the highest-complexity file, or just the first parsable file it finds — and launches straight into it. You don't need to manually pick a file to begin, though you can also click any file in the sidebar's file tree to jump into it directly. A spinner with a status line (fetching the tree, scanning for an entrypoint, parsing, generating the world) shows in the viewport while this is in progress — for a large repository (a full Linux kernel checkout, say) this can take real seconds, especially over GitHub.

## The first level

Every level opens with a **briefing overlay**: the campaign name, the level name ("Compiling `<file>`…"), and stats on how many rooms and enemies the level generated. Click **Start** (or press Space/Enter/Escape, or any gamepad button) to begin — this and every other blocking overlay ignores its own dismiss inputs for the first 1.2 seconds, so mashing fire in the fight that triggered it can't skip it by accident.

From there you explore, fight, loot, and make your way to the level's exit tile.

## Ending a level

- **Reach the exit** → a **Commit Summary** overlay shows stats ("Lines refactored", "Bugs squashed") and a **Continue** button loads the next level, carrying your health, ammo, and weapons forward.
- **Run out of levels** (you've cleared the whole tree) → **Build Successful**.
- **Die** → **Kernel Panic**, and you're returned to the file tree.

Your progress autosaves as you play — but only for a **Local** workspace, so if you close the tab mid-campaign, **Continue Run** picks it back up (you'll be asked to re-pick the same local folder, since a browser can't hold onto a file handle across sessions). A **GitHub** or **Demos** run doesn't persist or offer a "Continue Run": there's no local folder to re-pick for either, and re-fetching/rebuilding one from scratch would silently start the campaign back over rather than truly resuming it, so neither pretends to save.
