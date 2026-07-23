# Privacy

[← Back to index](README.md)

Codeenstein 3D runs entirely in your browser. There is no account, no analytics, and no crash/error reporting of any kind. The only network calls it ever makes are the ones described below, and only when you use the specific feature that triggers them — that includes one first-party backend, the multiplayer signaling server (see [Multiplayer](#multiplayer)), which exists solely to introduce two browsers to each other and holds nothing beyond that, plus, only during that same introduction, a third-party STUN server (also covered in that section).

## Your workspace (the code you point it at)

- **Local folder** — picked via the browser's File System Access API. The folder is read directly by your browser and parsed locally (client-side, via `web-tree-sitter` running as WebAssembly). Its contents never leave your machine.
- **GitHub repo** (`owner/repo`, via the "Load from GitHub" tab) — this is the one feature that talks to a remote server, and only when you explicitly use it:
  - The repository's `owner/repo` name is sent to GitHub's REST API (`api.github.com`) to look up its default branch and fetch the full file tree.
  - Individual file contents are fetched lazily — only once a file is actually opened/parsed — from `raw.githubusercontent.com`, GitHub's raw-content CDN.
  - These requests are unauthenticated (no login, no token sent), so they're subject to GitHub's normal public rate limits, and are visible to GitHub the same way any plain `fetch()` to their servers would be (your IP address, standard HTTP headers, and the repo/file path you requested — nothing added by this app on top of a normal browser request).
  - Nothing is ever pushed, written, or reported back to GitHub — these are read-only `GET` requests.
- **Demos** (the "Demos" tab's bundled showcase campaign) — makes no network request and reads no local files at all. Every level's source text is baked directly into the app's own bundle at build time, so it works fully offline.

No other feature besides Multiplayer (below) makes any network request. A locally-picked workspace never touches the network at all, including in multiplayer — hosting or joining a session is only available for a GitHub-loaded repo or the Demos campaign, never a local folder.

## Multiplayer

Hosting or joining a multiplayer session (see the [Multiplayer](multiplayer.md) guide) talks to one first-party backend: a small signaling/lobby server, used only to introduce your browser and a friend's to each other. It's only ever contacted if you actively open the Multiplayer tab and click Host, Join, or Browse Lobby. Establishing that direct connection also contacts a third-party STUN server (`stun.l.google.com` by default, operated by Google, not this project) — a standard, unavoidable part of how WebRTC discovers a connectable network path; it sees your IP address and the other player's, the same way any WebRTC-based video call or app would.

- **What the signaling server sees**: the short join code, the WebRTC connection-setup blobs (SDP offer/answer — handshake metadata, not gameplay data) needed to establish a direct connection, and your IP address, tracked only for rate-limiting bookkeeping (detecting abuse like guessing at other players' codes) — that tracking entry clears itself automatically, typically within about a minute of your last request, though a sustained burst of requests that trips the abuse-rate limiter can keep it around for up to an hour. The server has no database — everything lives in memory and expires on its own.
- **What it never sees**: once two browsers are connected, all real gameplay — the generated map, player positions, inputs — travels directly between them (peer-to-peer), never through the signaling server. And per this project's own hard rule, only that generated map and sync data is ever transferred at all — your actual source code or its parsed structure never crosses the wire to another player, exactly as it never leaves your machine in single-player.
- **If a relay is used**: some networks (strict NAT, corporate/mobile firewalls) block a direct browser-to-browser link. *If* whoever runs the signaling server has also set up a relay server (TURN), your connection is routed through it instead of going directly — but it stays end-to-end encrypted, so the relay only ever sees connection metadata (your IP and the other player's, and the timing/volume of traffic), never the gameplay itself: the map, positions, and inputs passing through it are unreadable to it. The relay, when it exists, is run by the same first-party operator as the signaling server — not a new third party — and most connections never need it. When credentials for it are issued they're short-lived and kept only in your own browser's memory for that one connection.
- Your session's display name and campaign name are visible to **anyone who has the join code**, not only to browsers of the public lobby listing — the code itself is the only thing gating who can see them. Checking "List in public lobby" additionally publishes the code (and those same names) to anyone browsing the lobby, without them needing the code at all. Don't set a display name if you'd rather stay anonymous.

## What's stored on your machine

Everything the game remembers between sessions lives in your browser's `localStorage` for this site, under a handful of keys prefixed `codeenstein-`. Nothing is ever synced anywhere — clearing your browser's site data for this page removes all of it.

| Stored as | Contains |
|---|---|
| Campaign save (`codeenstein-campaign-save`) | Workspace name, the current file's path *within that workspace* (not its contents), health/swap/ammo/weapons/score, and campaign level position — enough to resume a run, no source code |
| Highscore board (`codeenstein-highscores`) | Score, campaign/level name, levels cleared, a SHA-256 hash of the *whole workspace's* parsed code structure (used only to tell "same code" runs apart, regardless of which level a run ended on — not reversible into source), lines-of-code/complexity totals, and — if captured — a replay |
| Replay (attached to a highscore entry) | Per level: its file path, a random-number seed, a hash of that one level's parsed code structure (distinct from the whole-workspace hash above — used only to verify that specific file hasn't changed before trusting a replay to regenerate the same map), difficulty/gore settings, and a frame-by-frame recording of your *inputs* (keys/mouse/gamepad) for that level. No source code or file contents are recorded — a replay is only watchable by re-loading the same workspace/repo and regenerating the map from it |
| Preferences | Gore level, difficulty, and Master/SFX/Music volume — simple settings, not tied to any run |

Replay/highscore data is gzip-compressed before being stored purely to fit within the browser's storage quota; this is a size optimization, not obfuscation, and doesn't change what's recorded.

If you haven't set any scores of your own yet, the Highscores dialog shows 3 example entries from the bundled Demo Campaign instead of an empty list. These are baked into the app's own bundle at build time (the same offline, no-network approach as the Demos tab itself) — they're never written to your `localStorage`, and disappear from the display the instant you set a real score of your own.

## What is never stored or sent anywhere

- The actual text/contents of your source files
- Anything from a **custom BGM folder** — picked the same way as a workspace, played locally via a local object URL, never read into memory as a whole file or transmitted anywhere
- Your **local WAD texture pack** file — read locally into memory to extract textures, never transmitted anywhere, and never persisted: it's gone the moment you reload the page
- Nothing about *you* — picking an **online texture pack** from the sidebar's curated list does perform a network request, but only a same-origin one to the game's own server for a static file it already ships (fetched and bundled at build time — see [Credits & Third-Party Licenses](../../README.md#online-wadtexture-pack-catalog-fetched-at-build-time-bundled-as-static-assets)), never to a third party, and no information about you or your workspace is sent
- Any personal or account information — there's nothing to log in with
- Anything from the opt-in `?perfDebug=1` diagnostics mode (see [HUD & UI](hud-and-ui.md#performance-diagnostics-perfdebug1)) — its frame-timing and machine-info lines (screen size, CPU core count, browser user-agent) are only printed to your own console sidebar, never transmitted; sharing them is entirely your choice, e.g. via a screen recording you make yourself
- Any of the above while a Doom-style cheat code (`IDDQD`/`IDCLIP`/`IDKFA`) is active for that run — a cheated run isn't recorded to the highscore board at all

## Automated/bot traffic

The engine checks `navigator.webdriver` (the standard flag automation tools like Playwright/Puppeteer set) purely to silence game audio during automated testing — it has no effect on privacy or data handling.
