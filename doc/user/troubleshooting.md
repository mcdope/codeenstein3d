# Troubleshooting

[← Back to index](README.md)

Most of what looks like a bug here is the loader quietly deciding a file isn't code it can
use. That decision is almost always right, and it's almost always invisible — this page is
the list of things it does silently.

**The console is your friend.** Every skip below prints a reason. You don't need DevTools:
the console panel beside the canvas mirrors the same lines (it's hidden while the canvas is
fullscreen — press `F` to come back out).

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

## "A big GitHub repo loaded, but it seems incomplete"

GitHub's API truncates the file listing for very large repositories, and there is nothing
this app can do about it from the browser. When that happens the console says so:

```
[github] The tree for "owner/repo" was truncated by the GitHub API — this repo is
large enough that some files may be missing.
```

The campaign still plays; it's just built from whatever GitHub returned. For a repo that
size, cloning it and using the **Local** tab gets you the whole thing.

Note also that GitHub requests here are unauthenticated, so they're subject to the normal
public rate limit. If loads start failing after a lot of browsing, that's usually it —
waiting is the fix.

## "Select Workspace is greyed out"

Reading a local folder needs the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker),
which only Chromium-based browsers (Chrome, Edge, Brave) implement, and only over `localhost`
or HTTPS. The app detects this and says so in place of the workspace name.

Everything else works anywhere: the **GitHub** tab and the bundled **Demos** campaign don't
touch the local filesystem at all.

## "The Multiplayer tab isn't there"

You're on a local build that wasn't pointed at a signaling server. The address is baked in
when the dev server starts, so there's no in-app setting to flip — see
[Multiplayer](multiplayer.md), or just use the hosted build.

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

Add `?perfDebug=1` to the URL and reload. Frame timings and a per-frame breakdown appear in
the console panel, updating every couple of seconds and immediately whenever a frame is
genuinely slow. Nothing is transmitted anywhere — a screen recording of the panel is enough
to diagnose a framedrop. See [HUD & UI](hud-and-ui.md#performance-diagnostics-perfdebug1).
