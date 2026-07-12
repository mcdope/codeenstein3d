# Changelog

## Unreleased

- Workspace/GitHub loads now skip `test`, `tests`, and `__tests__` directories (matched case-insensitively) alongside the existing `node_modules`/`.git`/etc. noise list, and also skip colocated test files (`foo.test.ts`, `foo_test.go`, `FooTest.java`, and similar conventions) even when they sit right next to real source rather than in a dedicated test folder — so test suites no longer generate levels
- Fix: watching a replay recorded from a GitHub repo re-fetched the whole repo with no loading indicator at all, unlike every other workspace load — it now shows the same loading screen, byte-received readout, and file-tree-scan progress the "Load GitHub repo" button already had; a failed re-fetch also now resets the UI instead of leaving the screen stuck on "Fetching…" forever
- Fix: a lore terminal kept pulsing/glowing forever, even after you'd already read it — both the in-world wall tint and the minimap marker now stop pulsing once a terminal's been interacted with at least once (it keeps its distinct wall texture in the 3D view, so it's still findable, just no longer animated)

## beta-3

- Texture-mapped walls, doors, floors, lore terminals, hazard (acid) floors, teleporter pads, and spike traps — procedural defaults, or real textures/flats sourced from a loaded DOOM `.wad` file
- Fix: holding Toolchain's melee-fire (previously Left-Ctrl) while also moving forward could close the entire browser — `Ctrl+W` is a browser-reserved "close tab" shortcut page JavaScript cannot block. Quick-melee (knife/Toolchain) is now bound to Space instead; ranged weapon fire is mouse/gamepad-only (no keyboard fire key — keyboard-only play was never a supported control scheme)
- Fix: a GitHub repo load left running while starting a different workspace (another repo, a local folder, the demo campaign, Continue Run, or Watch Replay) could resolve later and clobber the newer load's state; superseded loads are now aborted and their results discarded
- Fix: loading a GitHub repo could fire off far more requests than needed to start playing — entrypoint detection now checks filenames before it needs any network content sniffing and no longer falls back to scoring every file's content when a repo has no conventional entrypoint filename, the whole-codebase highscore stats pass now always skips itself for a remote repo instead of trying to fetch and parse every file, and the file list is no longer re-scanned from scratch (with a fresh round of content sniffing) on every single level clear. Measured on a real repo with no conventional entrypoint filename: 99 requests on load down to 13
- Fix: map generation could silently produce a room with no real exit corridor (surfaced when parsing DockerManager.php) — added a filler-room top-up, a maze connectivity repair pass, and a dev-time reachability check so a regression like this is loud instead of silent
- Fix: every whiffed shot or melee swing printed a "missed" line to the console sidebar, spamming it during any real firefight — only hits are logged now
- Fix: the file tree's folder expand/collapse arrow could stop responding

## beta-2

- Bundled Demo Campaign with default highscores/replays, a Demos launch tab, and verification scripts
- Unlockable chainsaw "Toolchain" (melee, replaces knife) and flamethrower "Friday Hotfix" (own gas ammo pool)
- Enemy kills can now drop unlockable weapons (regular: tiny chance, elite: 60% odds)
- Corridor breakup rooms with Edge Case enemies to vary long stretches
- Automap reworked into a non-blocking, Diablo-style overlay with wider fog-of-war reveal
- Secret rooms broadened, hidden properly, richer loot, and award a score bonus
- Per-weapon procedural fire sounds, explosion particle bursts, and a dedicated rocket boom sound
- Antialiased wall top/bottom edges in the raycaster
- Canvas now fills available space instead of a fixed 960px cap
- New intro screen, loading overlay, and a keycap legend for controls
- Weapon balance tuning across pistol, shotgun, gdb, and ghidra rocket
- Fixes: pause on focus/pointer-lock loss, cheat-code input bleeding into movement, highscore hash scoping, viewmodel alignment, melee tracer line, Friday Hotfix gas cost, and more

## beta-1

- Initial beta release
