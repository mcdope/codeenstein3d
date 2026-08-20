# Troubleshooting

[← Back to index](README.md)

Most of what looks like a bug here is the loader quietly deciding a file isn't code it can
use. That decision is almost always right, and it's almost always invisible — this page is
the list of things it does silently.

**The console is your friend.** Every skip below prints a reason. You don't need DevTools:
the console panel beside the canvas mirrors the same lines (it's hidden while the canvas is
fullscreen — press `Alt`+`Enter` to come back out).

## "I picked a folder and nothing happened"

Only files whose extension has a parser become levels. Everything else is skipped without a
word. The full list:

| Language | Extensions |
|---|---|
| PHP | `.php` `.php3` `.php4` `.php5` `.phtml` |
| C | `.c` `.h` |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` |
| TypeScript | `.ts` `.mts` `.cts` `.tsx` |
| Python | `.py` `.pyw` |
| Java | `.java` |
| Go | `.go` |
| Rust | `.rs` |
| Ruby | `.rb` |
| C# | `.cs` |
| Bash | `.sh` `.bash` |
| Scala | `.scala` `.sc` |
| Objective-C | `.m` `.mm` |

A file with **no extension at all** still gets a chance: if it opens with a `#!` line naming
`sh`, `bash`, `dash`, `zsh`, `ksh`, `python`, `ruby`, `php`, or `node`, it's parsed as that
language. Trailing version digits are ignored, so `#!/usr/bin/env python3` works.

If a folder has none of these in it, there's nothing to build a campaign from.

## "My repo produced far fewer levels than it has files"

Four things drop files before anything is parsed, and all four are deliberate:

- **Tooling and dependency directories** — `.git`, `node_modules`, `vendor`, `dist`, `build`,
  `.cache`, `.idea`, `.vscode`, `__pycache__`. Matched case-insensitively, at any depth.
- **Test directories** — `test`, `tests`, `__tests__` — and colocated test files alongside
  their subjects: `foo_test.go`, `FooTests.cs`, `bar.spec.ts`, `test_thing.py`. Test code is
  someone else's map of your code; letting it in roughly doubles a well-tested repo's
  campaign with levels that read as duplicates of the ones next to them.
- **Files over 4 MiB** — a generated bundle or a vendored blob isn't a level anyone wants to
  walk. Logged as `[parser] Skipping "…": file exceeds 4194304 byte parse limit`.
- **Files that look binary** — a `NUL` byte anywhere, or too high a share of non-printable
  bytes in the first 8 KB. Logged as `[parser] Skipping "…": file content looks binary`.

A file whose parse simply *fails* is also skipped rather than ending the run, with
`[parser] Skipping "…": parse failed — …` in the console.

## "A big repo loaded, but it seems incomplete"

Very large repositories can come back with an incomplete file listing, and there is nothing
this app can do about it from the browser. GitHub's API truncates the listing itself; GitLab
and Codeberg instead hand it over 100 files at a time, and since an unauthenticated caller
only gets a few hundred requests an hour, the app stops after 40 pages rather than spending
the whole hour on one repo. You don't have to guess when it happened: a marker sits above
that repo's file tree, under the Repo tab, for as long as it is loaded —

> ⚠ Partial listing — the file list for this repo came back incomplete, so some files
> are missing. Clone it and use the Local tab for the whole thing.

— and the console panel says the same thing in more words:

```
[github] The tree for "owner/repo" was truncated by the GitHub API — this repo is
large enough that some files are missing. The campaign still plays, built from
whatever GitHub returned; clone the repo and use the Local tab to get all of it.
```

The campaign still plays; it's just built from whatever the host returned. For a repo that
size, cloning it and using the **Local** tab gets you the whole thing. GitLab and Codeberg
log the same thing under their own `[gitlab]`/`[codeberg]` prefix, saying the tree was
truncated after 40 pages rather than by the API.

Note also that requests here are unauthenticated on every host, so they're subject to that
host's normal public rate limit. If loads start failing after a lot of browsing, that's
usually it — waiting is the fix, and the app now says so outright rather than reporting a
bare `403`:

```
Failed to fetch repository tree: you've hit GitHub's public rate limit — it resets in
about 7 minutes. Requests from this app are unauthenticated, so a lot of browsing runs
the limit down. Waiting is the fix — or load a local folder from the Local tab in the
meantime.
```

The same message can appear **mid-session**, when a level's source file is fetched — file
contents are loaded one at a time as you reach them, not all at once with the listing, so a
repo that loaded fine ten minutes ago can start failing partway through a campaign.

## "Select Workspace is greyed out"

Reading a local folder needs the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker),
which only Chromium-based browsers (Chrome, Edge, Brave) implement, and only over `localhost`
or HTTPS. The app detects this and says so in place of the workspace name.

Everything else works anywhere: the **Repo** tab and the bundled **Demos** campaign don't
touch the local filesystem at all.

## Multiplayer

### "The Multiplayer tab isn't there"

You're on a local build that wasn't pointed at a signaling server. The address is baked in
when the dev server starts, so there's no in-app setting to flip — see
[Multiplayer](multiplayer.md), or just use the hosted build.

### "The Host sub-tab is greyed out"

Hovering it says *"Hosting requires a loaded repository or the Demos campaign"*, and that's
the whole rule: **a locally-picked folder can't be hosted.** Your guests need the same source
to build the same level from, and shipping your local files to them is exactly what this
project doesn't do — so hosting is limited to sources they can obtain themselves. Load the
repo through the **Repo** tab instead (GitHub, GitLab or Codeberg all count), or host the
**Demos** campaign.

Joining has no such restriction. A guest receives the map from the host and needs no
workspace of its own.

### What the error messages mean

| Message | What actually happened |
|---|---|
| "No session found for that code — it may have expired." | Either a typo, or the session is genuinely gone. Codes live **5 minutes from the last time anything touched them**, not from when they were created — so a code sitting unused while you paste it into a chat can lapse. The host can just create a new one. |
| "Someone else already joined that session." | That code's current slot is taken. This is normal in a 3-4 player session: the host re-arms a fresh slot under the same code the moment each guest connects, so wait a couple of seconds and click Join again rather than asking for a new code. |
| "Rate-limited by the multiplayer server — try again shortly." | Too many requests from your address in a short window — usually repeated Join attempts on a wrong code. It clears on its own, but the backoff lengthens each time you trip it, so wait rather than retrying hard. |
| "Multiplayer is not configured…" | The build has no signaling server — see the first entry above. |
| "Multiplayer connection failed." / "Multiplayer session setup failed." | The handshake didn't complete. Almost always the network case below. |

### A join that hangs on "Establishing connection…"

This is the network case, not a bug — some networks block direct browser-to-browser links.
[Multiplayer § If you can't connect](multiplayer.md#if-you-cant-connect) has the detail and
what to do about it.

### The session ended on its own

Four things end a session, and the on-screen message says which: every player was eliminated,
the host disconnected, the campaign was completed, or a level transition failed to complete.
Only the last is a fault — the other three are the session finishing normally.

A *guest* dropping doesn't end anything: the rest of the team waits out a short grace period
in case they reconnect, then continues without them, keeping their score on the final
scoreboard marked as disconnected.

### "My highscore from that run is missing"

Multiplayer runs are deliberately never recorded to the Highscores board and can't be watched
back — you get the shared end-of-run scoreboard instead. Cheat codes are disabled for the
same reason. See [Multiplayer § What's different](multiplayer.md#whats-different-in-multiplayer).

## "The level briefing won't dismiss"

Every blocking overlay ignores its own dismiss inputs for the first 1.2 seconds, so a
mistimed click during the fight that triggered it can't skip it by accident. Past that, if
Start still doesn't respond — especially right after a page reload, or on Linux/GNOME — your
first click may only be re-focusing the browser window at the OS level rather than reaching
the page. Click or press it again.

## "I'm standing on the exit and nothing happens"

The exit stays inert while any enemy that spawned in *its own room* is still alive. There's
no message for this on purpose. Backtrack and finish the fight — see [Tips](tips.md).

## "The game feels choppy"

First: if **Render quality** is set to **Sharp** in the Settings tab (the gear ⚙), switch it back
to **Classic** — Sharp renders at double the internal resolution and is aimed at machines with
headroom to spare and high-refresh displays; Classic is the intended look and the fast path.
The change takes effect on the next level you launch.

Still choppy? Add `?perfDebug=1` to the URL and reload. Frame timings and a per-frame breakdown appear in
the console panel, updating every couple of seconds and immediately whenever a frame is
genuinely slow. Nothing is transmitted anywhere — a screen recording of the panel is enough
to diagnose a framedrop. See [HUD & UI](hud-and-ui.md#performance-diagnostics-perfdebug1).
