# Changelog

## Unreleased

- New: Multiplayer — host or join a real-time coop session (2-4 players) with a friend, no account or setup needed. Pick a campaign/workspace as usual, choose how many players you want, then share the short code your browser gives you; anyone who joins with that code connects directly to you (peer-to-peer), and more players can join the same code one at a time with nothing extra to share. A public lobby list is also available if you'd rather browse for an open session than trade a code
- Everyone in a session stays in perfect lockstep — the exact same simulation, ticking in sync — even across different browsers or devices, with automatic correction if anything ever drifts
- If a player's connection drops, the rest of the session keeps going without them after a short grace period; when the group reaches a level's exit together, a countdown gives everyone a moment to catch up before advancing
- A shared end-of-run scoreboard shows everyone's score and kills side by side. Elite enemies get tougher (more HP and damage) the more players join, and any loot dropped is visible to the whole team on the minimap/automap. Multiplayer runs don't use cheat codes, highscores, or replays — those stay single-player features

## beta-4

- Dev: a repeatable frame-time benchmark harness (`npm run perf:bench`) and chart report (`npm run perf:report`) — real-clock Playwright runs over deterministic scenarios (idle, replay-combat, particle stress, a huge GitHub-repo map, bot play) with per-frame phase timing via `?perfDebug=1` and interleaved A/B for the build flags. First full audit's verdicts: distance fog and wall-edge antialiasing are essentially free on typical maps (antialiasing costs ~0.4ms/frame on huge ones), and no engine-side hotspot reproduces the reported huge-repo framedrops — details in `perf-findings.json`
- Fix: the FPS overlay (Right-Ctrl) and the IDDQD/IDCLIP cheat toggles all silently reset every time you advanced to the next level, needing to be re-activated each time — they now carry over for the rest of the run, same as your health/ammo/weapons already did
- Wall-edge antialiasing and windowed-mode canvas resizing are both on by default now: the perf audit measured antialiasing as undetectable on normal maps (~0.4ms/frame on huge ones) and the canvas resizing as completely free on both the engine and compositing side — so you get smoother wall silhouettes, and the game window finally grows past 640×400 to fill the space your browser window actually has
- New: rebranded with a custom "CODE" wordmark logo — replaces the gun-emoji sidebar header text and the full favicon/icon set (browser tab, bookmarks, Android/iOS home screen, Windows tiles)
- New: a curated "Or pick an online texture pack" list in the sidebar, next to the existing Load WAD Texture Pack button — Freedoom (Phase 1, Phase 2, FreeDM), DOOM (Shareware), and HACX 1.2, each showing its license, credits, and a link to the source project. No download or file picker needed; fetched at build time, not committed to the repo (see the README's Credits section for full attribution)
- The 3 example runs shown in the Highscores dialog before you have any of your own are now played by the same Casual/Gamer/Pro skill levels used elsewhere (previously 3 generic, skill-blind attempts) and load much faster the first time you open that dialog — the bundled data shrank from tens of megabytes to under a megabyte
- Workspace/GitHub loads now skip `test`, `tests`, and `__tests__` directories (matched case-insensitively) alongside the existing `node_modules`/`.git`/etc. noise list, and also skip colocated test files (`foo.test.ts`, `foo_test.go`, `FooTest.java`, and similar conventions) even when they sit right next to real source rather than in a dedicated test folder — so test suites no longer generate levels
- Fix: watching a replay recorded from a GitHub repo re-fetched the whole repo with no loading indicator at all, unlike every other workspace load — it now shows the same loading screen, byte-received readout, and file-tree-scan progress the "Load GitHub repo" button already had; a failed re-fetch also now resets the UI instead of leaving the screen stuck on "Fetching…" forever
- Fix: a lore terminal kept pulsing/glowing forever, even after you'd already read it — both the in-world wall tint and the minimap marker now stop pulsing once a terminal's been interacted with at least once (it keeps its distinct wall texture in the 3D view, so it's still findable, just no longer animated)
- Fix: a corridor-breakup room's internal wall could occasionally seal off part of a level, permanently disconnecting some rooms from the exit
- Fix: moving diagonally (e.g. forward + strafe together) covered about 41% more ground per step than moving in a straight line
- Loot rebalanced: regular kills now sometimes drop nothing instead of always dropping something, and drop amounts are lower overall — ammo/health/armor felt too plentiful; a "miss" also now carries a small chance to grant the Toolchain chainsaw, giving it a real, repeatable way to unlock beyond secret rooms or a lucky Elite kill
- Easy difficulty deals more damage than before — the old curve combined with cautious play could make a run nearly unkillable
- Enemy aim now gets noticeably worse on Easy and Normal difficulty, not just their HP and damage — difficulty finally affects how "smart" enemies feel, not only how tough they are; Hard is unchanged
- Fix: a level's keys often spawned clustered near each other, all inside the biggest room reachable before opening any door — later keys are now confined to the tiles newly reached since the previous door, so they're spread across the level instead of piling up in the same starting area
- Fix: the 3 bundled example replays a first-time player sees in the Highscores dialog played back at roughly 3x real speed instead of matching the pace of the original run
- Watching a replay now returns you to the Highscores dialog once it ends (a natural win/death, stopping early, or an error), instead of dropping you back at the plain file-tree screen
- New: export a "Watch Replay" viewing as a downloadable webm video — a Record button on the replay's own transport bar, or a one-click "Export" shortcut next to each Highscores entry's "Watch" button. Recording always captures at real 1x speed and locks the transport controls for the duration
- The startpage now leads with a plain-English "New to coding?" card pointing straight at the no-setup Demos tab, before the more technical code→dungeon mapping
- New: an "Export Map as PNG" button appears once you clear a level — downloads a top-down image of it, textured with the actual walls/doors/floors/hazards you were seeing in-game (not a flat debug-style diagram), for sharing. Only ever available for a level you've already finished
- New: chaining 3 kills within 3 seconds now triggers a "Multi Kill" bonus (on-screen banner, stinger sound, and a flat score bonus); chaining 6 within 6 seconds triggers a bigger "Ultra Kill" instead
- Fix: Extreme gore mode's blood particles could render at nearly twice the canvas height at point-blank range — particle size and particle count are now capped across every gore tier, not just Extreme
- Dev: the browser tab title now stamps on the exact git ref of the running build (a real release tag if HEAD is tagged, otherwise a short commit hash), instead of just a build timestamp — makes a stale cached build after a deploy obvious at a glance

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
