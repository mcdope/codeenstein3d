# Multiplayer support — feasibility research

Investigation of the `notes` "Open" checklist item (multiplayer support), against the
current codebase as of 2026-07-18. Nothing implemented — this is findings only.

## Follow-up specifications

This document is the entry point; four follow-on artifacts turned its decisions into
detailed, code-grounded plans (none of them modify anything under `src/` either):

- [`scripts/poc-cross-browser-determinism.mjs`](scripts/poc-cross-browser-determinism.mjs) —
  standalone Playwright PoC that measured (not just flagged) the cross-browser
  floating-point risk called out below — see
  [Cross-browser determinism: measured, not theoretical](#cross-browser-determinism-measured-not-theoretical).
- [`doc/dev/multiplayer-netcode-spec.md`](doc/dev/multiplayer-netcode-spec.md) —
  the lockstep-plus-reconciliation netcode design the PoC's result made necessary:
  star-topology `dt` unification, the input delay buffer, the exact state
  reconciliation payload, and hard-snap-vs-interpolation drift correction.
- [`doc/dev/multiplayer-server-spec.md`](doc/dev/multiplayer-server-spec.md) —
  the signaling + lobby server this doc's "Direct connect via a short code" and
  "Lobby folds into the same service" decisions require: endpoint/JSON schemas, the
  in-memory `Map`/TTL-sweep mechanics, and the IP rate-limiting/backoff design
  protecting the 6-character codes.
- [`doc/dev/multiplayer-game-state-spec.md`](doc/dev/multiplayer-game-state-spec.md) —
  the engine/UI-layer adaptation plan: gating the Host/Join UI to GitHub/Demos
  workspaces, a deterministic `pickMultiplayerSpawns` that never touches the
  existing single-player `pickSafeSpawn`, per-player scoring with kill-assist
  sharing, and player-count elite HP/damage scaling.

## Decisions (user, 2026-07-18)

1. **Multiplayer is scoped to GitHub-loaded repos and the bundled Demos campaign
   only.** No multiplayer for a locally-picked workspace. This is "Option C" from the
   original privacy analysis below — since both remaining sources are already public
   (a public GitHub repo, or content baked into the app's own bundle), the "generated
   level data embeds verbatim source text" concern stops being a privacy problem at
   all: there's nothing private left to leak. See [Privacy: resolved](#privacy-resolved).
2. **No backend, except where genuinely unavoidable.** Every networking design choice
   below is filtered through this: prefer a zero-infrastructure mechanism even at a UX
   cost, and only accept a hosted component for the one piece that structurally cannot
   work without one. See [Network design under a no-backend constraint](#network-design-under-a-no-backend-constraint).
3. **Connect flow: a short, human-typable code — not a QR scan.** Host generates a
   code, shares it with friends however they normally talk (paste in Discord/chat,
   read it out), they type it in to join. This turns out to move where "unavoidable"
   kicks in — see [Direct connect via a short code](#direct-connect-via-a-short-code-what-this-actually-requires)
   below: a *short* code specifically (not a big copy/pasted blob) cannot be
   self-contained, so this is the thing that makes a small backend piece unavoidable,
   sooner than the original "only the browsable lobby needs a server" framing assumed.
4. **Given a minimal backend is unavoidable anyway, fold the lobby feature into v1
   too** rather than deferring it — see [Lobby folds into the same service](#lobby-folds-into-the-same-service).
5. **Backend shape: one self-contained Node script**, matching every other piece of
   tooling in this repo (`scripts/*.mjs` are all plain Node already) — no framework,
   runnable directly as a systemd unit, with `--install`/`--uninstall` flags that
   register/remove that unit themselves. See [Self-hosting: a single Node script, systemd-managed](#self-hosting-a-single-node-script-systemd-managed).

## TL;DR

Technically feasible, still a major initiative (months, not weeks). With both
decisions above locked in, the privacy question is closed and the backend question has
a clear minimal-infra answer (below) rather than an open design space. The remaining
work is ordinary feature work with clean extension points already in the code, plus
the netcode itself.

## What already works in multiplayer's favor

- **The engine is already fully deterministic and already has a "feed it someone
  else's input" abstraction.** `src/engine/replay.ts`'s `ReplayPlaybackInput`
  implements the exact same `InputSource` interface `InputController` (real
  keyboard/mouse) does — `RaycasterEngine` cannot tell the difference between live
  input and played-back input. A `NetworkInputSource` implementing `InputSource` and
  merging local + received-from-peer input is the natural shape for a networked build,
  not a new concept.
- **Every simulation-relevant random draw already goes through one seeded
  `mulberry32` PRNG stream** (`src/prng.ts`), never `Math.random()` — enemy AI timing,
  loot rolls, weapon spread, map layout. This is *why* replay works today, and it's
  the same property lockstep-style netcode needs: same seed + same inputs + same dt
  sequence ⇒ byte-identical simulation on every peer.
- **`GameMap` is already plain, serializable, engine/DOM-free data** (`src/map/types.ts`
  doc comment: "the generator turns `ParsedFile` JSON into this and nothing more").
  Shipping it over a wire needs no new serialization design.
- **Scoring is already additive/summable.** `ScoreBreakdown` + `sumScoreBreakdowns()`
  (`scoring.ts`) already exist to carry a running total across levels for one player —
  giving each player their own running `ScoreBreakdown` and a final comparison table is
  a straightforward extension, not new architecture.
- **Difficulty scaling is already a small multiplier table applied once at engine
  construction** (`difficulty.ts`'s `DIFFICULTY_MULTIPLIERS`, applied in `engine.ts`
  right after building the map's enemies). "Elite enemies scale with player count"
  is the same shape: a `playerCount` axis multiplying HP/damage the same way difficulty
  does, applied at the same spot.
- **Cross-browser CI already exists** (`verify-browser` job: chromium/firefox/webkit
  matrix) — the infrastructure to test cross-browser determinism already exists. A
  standalone PoC (see [Cross-browser determinism: measured, not theoretical](#cross-browser-determinism-measured-not-theoretical))
  has since confirmed that property actually matters — the existing CI matrix is the
  natural place to wire in an ongoing check once the netcode itself is built, not just
  a one-off spike.

## Privacy: resolved

The checklist says: *"only transfer generated level data and sync stuff, never
sourcecode or AST."* The catch found during research: **the generated level data
already contains verbatim source snippets and identifiers as gameplay content**, by
design:

| `GameMap` field | Contains | Where it's user-visible |
|---|---|---|
| `LoreTerminal.text` | The **literal source comment**, delimiters kept as-is (`CodeComment` doc comment: *"kept as-is... meant to read like an artifact of the real source"*) | Pausing to read a lore terminal shows this text verbatim |
| `Room.entity.name` / `Enemy.entity.name` | The **literal function/method/class/global-variable name** | Not currently shown directly in UI, but it's real identifier text sitting in the payload |
| `Teleporter.label` | The **literal goto label name** | HUD/debug display (doc comment) |
| `ReplayLevelSegment.filePath` | The **workspace-relative file path** | Level briefing / replay data |

**Decision: multiplayer is restricted to GitHub-loaded repos and the Demos campaign.**
A locally-picked workspace can't be used to host or join a multiplayer session at all.
Since both remaining sources are already public (a public GitHub repo anyone could
`git clone`, or the Demos content baked into the app's own bundle), sending the
generated map's comments/identifiers to peers reveals nothing that wasn't already
public. This closes the privacy question outright — no redaction mechanism needed,
`doc/user/privacy.md`'s existing promises about a locally-picked workspace stay true
unmodified (multiplayer simply never touches that code path).

Implementation note for later: gate multiplayer session creation on the same
`workspaceIsRemote`/`workspaceIsDemo` flags `main.ts` already tracks (currently used to
decide whether autosave/"Continue Run" apply) — a local pick should hide/disable the
multiplayer entry point entirely, not just decline at connect time.

## Network design under a no-backend constraint

Confirmed from `.github/workflows/*.yml` and `package.json`: this ships as a static
SPA (`vite build` → `dist/`) deployed via plain FTP to a static host. No server
process, no database, no WebSocket endpoint, zero networking dependencies beyond the
opt-in GitHub REST/raw-content fetches. `privacy.md` states this as a feature: *"There
is no backend server."* The decision is to keep it that way except where it's
genuinely not possible otherwise.

A browser tab **cannot accept an inbound connection** — it can only make outbound
requests/connections. That one fact, plus "no backend unless unavoidable," gives a
fairly direct answer for each checklist item:

- **"Host" can never mean a literal server-in-a-browser-tab.** The host is just the
  peer with simulation authority (owns the map generation, is the tiebreaker on
  synced events) — the actual bytes-on-the-wire mechanism has to be something both
  browsers can use without either one *listening*.
- **`RTCDataChannel` (WebRTC) is the transport for all real traffic, LAN or WAN** —
  peer-to-peer once connected, no relay server in the path, and public STUN servers
  are free and require no hosting by this project. This part is fully zero-backend.
- **The one unavoidable piece is the signaling handshake**: two peers must exchange an
  SDP offer/answer (and ICE candidates) *before* the P2P channel exists, and that
  exchange needs a rendezvous point reachable by both sides — a browser can't just
  "broadcast" this, on a LAN or otherwise.

### Direct connect via a short code: what this actually requires

The original plan (copy/paste, or scan, the actual SDP offer/answer blob) is
genuinely zero-backend, but that blob is not a nice UX: a WebRTC offer carries a DTLS
certificate fingerprint plus one or more ICE candidates (this machine's local/
network-visible addresses), which in practice is several hundred bytes to a couple KB
of text — fine to copy/paste as one lump, useless as something a person reads out
over voice chat or retypes by hand. Scanning it as a QR code (the original idea)
sidesteps typing it, but still means "point your phone at your monitor," which is the
part that already felt clunky.

**A short, human-typable code cannot be the SDP blob itself — it has to be a lookup
key for it.** There's no way to compress a certificate fingerprint plus network
candidates down to something like `SWORDFISH-7`; the entropy and raw byte content
just doesn't fit. So getting the UX asked for (type/paste a short code, done) means
something has to hold the *real* blob temporarily, keyed by that short code, somewhere
both the host's and joiner's browser can reach it. That "somewhere" is a server —
this is the one place a small piece of backend is genuinely unavoidable, earlier than
the original framing (which only expected a server to be needed for a browsable public
lobby). **This is a well-trodden pattern, not a novel risk** — [Magic Wormhole](https://github.com/magic-wormhole/magic-wormhole)
solves the exact same "send a file to someone else's computer with no server-side file
storage" problem this way: a tiny relay whose only job is matching up two clients by a
short code (there, a number plus a couple of memorable words) so they can hand off
the real payload directly.

Recommended shape, keeping the service itself small even though its scope now covers
both signaling and the lobby:

- **A minimal session-mailbox: `PUT(code, offerBlob)` / `GET(code)` for the offer,
  same for the answer.** Host generates a code, `PUT`s its offer under it; joiner
  types the code, `GET`s the offer, `PUT`s its own answer back under the same code;
  host fetches the answer and the P2P connection completes from there. Once WebRTC
  negotiation finishes, **all real traffic (map data, per-tick input sync) flows
  peer-to-peer** — this service never sees any of it, only the one-time signaling
  exchange.
- **Ephemeral by design**: short TTL (a few minutes is plenty — this only bridges the
  handshake, not the session), entry deleted once the answer is retrieved or the TTL
  expires. No accounts, no game data ever stored — the same "least infrastructure
  that solves the actual problem" instinct as the rest of this doc.
- **Decision: as short as possible without risking uniqueness — 6 characters from a
  32-symbol safe alphabet.** That's ~30 bits of entropy, ~1.07 billion possible codes
  (`R4KJ9X`-style). **Correction, caught during implementation**: this doc originally
  described the alphabet as "uppercase letters + digits, excluding `0`/`O`, `1`/`I`/`l`,
  and similar-looking pairs" — but that's an arithmetic slip, not a valid 32-symbol
  set: 36 alphanumeric characters minus those 5 specific ones (`0`, `O`, `1`, `I`, `l`)
  leaves 31, not 32. Resolved in the actual implementation
  (`doc/dev/multiplayer-server-spec.md` §3) by adopting
  [Crockford's Base32](https://www.crockford.com/base32.html) alphabet verbatim —
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (all 10 digits, plus 22 letters excluding only
  `I`/`L`/`O`/`U`) — a real, proven standard for exactly this purpose, and genuinely
  32 symbols. Worth separating the two things "uniqueness" could mean here, since they
  have very different answers:
  - **Accidental collision** (two live sessions randomly getting the same code) is a
    non-issue regardless of length: the server already holds every live code in one
    in-memory map, so generation just checks for an existing entry and regenerates on
    the rare hit — a guaranteed-unique code, not a probabilistic one, at negligible
    cost.
  - **Deliberate guessing** (a third party brute-forcing a live code to hijack or
    grief someone else's session) is the real constraint on "how short can this be" —
    a code only needs to resist guessing for its own short TTL window, not forever.
    At 6 characters (~1.07B combinations), even a generous worst-case assumption (a
    few thousand concurrently-live codes, an attacker managing tens of thousands of
    guesses across the TTL despite rate-limiting) keeps the odds of guessing any live
    code astronomically low — comparable in spirit to how short-lived party-game room
    codes (Jackbox, Kahoot) get away with 4-6 characters precisely because the
    exposure window is minutes, not forever. 6 was picked as a comfortable margin
    above the minimum that analysis needs, while staying easy to read/type/paste in
    one glance — 5 would technically still clear the bar but with less headroom.
  - Rate-limiting/backoff on lookups (already noted below) is what keeps that
    guessing-budget assumption realistic in practice, not the code length alone —
    the two are a pair, not substitutes for each other.
- **This single mechanism now covers LAN, "direct connect," and casual online play
  uniformly** — the code-exchange step doesn't care whether the two browsers are on
  the same LAN or opposite sides of the planet; it's just how the offer/answer blobs
  get from one browser to the other. That's a nice simplification versus the earlier
  draft, which treated LAN/direct/online as three separate cases — they collapse into
  one "Host Game → get a code" / "Join Game → enter a code" flow. (WebRTC itself still
  transparently prefers a direct LAN path over a NAT'd one where possible — that part
  was never affected by how signaling happens.)
- **Abuse hygiene, since it's a small open service**: cap payload size per entry (it
  should only ever hold one SDP blob, not become a general-purpose paste bin), and
  rate-limit/backoff code lookups per IP — the pairing that makes the 6-character code
  above's guess-resistance hold in practice, not just in the abstract math.
- **TURN relays** (needed for WAN peers behind restrictive/symmetric NATs that plain
  STUN can't traverse) are a secondary "unavoidable-in-practice-for-some-users" case,
  not a day-one concern — ship with STUN-only P2P first, and only add a TURN relay
  later if real-world connection-failure rates justify it. No way to know that rate
  without shipping, so don't build it preemptively.

### Lobby folds into the same service

Given the mailbox above is now a real, always-running server process (see below —
not a serverless function), a browsable lobby stops being the "meaningfully bigger,
separate persistent-state system" the earlier draft assumed, and becomes almost free:
add one `public: boolean` flag (plus player count / campaign name) to the exact same
session record the mailbox already holds in memory, and one more endpoint
(`GET /lobby` → the list of sessions with `public: true` that haven't expired). No
new storage concept, no new deployment surface — the process that's already running
for signaling just also answers "what's open right now?" A lobby browser screen can
poll that endpoint every few seconds; that's plenty responsive for "who's hosting" and
needs no push/WebSocket mechanism.

**Decision: anonymous by default, with an optional host-chosen display name.** A
lobby entry needs no identity at all to be useful — campaign name + player count is
enough for "click to join" — so `displayName` on a session record is an optional
field, `undefined` unless the host bothers to set one, and the lobby UI falls back to
something generic (e.g. "Open Game — <campaign name>") when it's absent. No accounts,
no reserved/claimed names, no uniqueness constraint on the name itself — it's cosmetic
label text on an already-ephemeral, code-addressed session, not an identity system.

### Self-hosting: a single Node script, systemd-managed

The service should be a **long-running Node process, not a serverless function** —
this is what makes the lobby fold in for free (an in-memory `Map` naturally lives as
long as the process does) and matches how every other piece of tooling in this repo
already works (`scripts/*.mjs`, all plain Node, no framework). Concretely:

- **One `.mjs` file, Node built-ins only** (`node:http`, `node:crypto` for code
  generation) — no `npm install` needed to run it, consistent with this project's
  existing "avoid a dependency where a small amount of own code covers it" stance
  (the hand-rolled WAD/ZIP parsers are the same instinct). A `#!/usr/bin/env node`
  shebang plus `chmod +x` makes it directly executable — genuinely "one self-contained
  script," not "one script plus a `node_modules` directory."
- **In-memory only, on purpose.** Sessions (mailbox entries and lobby listings alike)
  live in one `Map`, swept on a `setInterval` for TTL expiry. A process restart drops
  whatever's currently mid-handshake or listed — an acceptable, even desirable trade
  given the alternative is a database to run, back up, and migrate for data that's
  only ever meant to live a few minutes anyway. Worth stating plainly as a deliberate
  choice, not an oversight, since "the signaling server restarted" becoming "just
  re-host, it takes 5 seconds" is a fine failure mode here.
- **`--install`/`--uninstall` CLI flags** that generate and write a systemd unit file
  themselves (`ExecStart=` pointing at the script's own absolute path, since the
  shebang makes it directly executable), then shell out to `systemctl daemon-reload`
  and (for `--install`) `enable --now`; `--uninstall` stops/disables the unit, removes
  the file, and reloads. **Decision: system-wide unit** under `/etc/systemd/system/`
  (needs root to install, runs independent of any login session) — no need for a
  `--user`-unit mode given the target below.
- **Decision: deploys to an existing VPS the user already runs.** This is the
  project's first piece of infrastructure that isn't a static file — the existing FTP
  deploy pushes `dist/` to a plain static host with no server-side runtime at all —
  so it's a genuinely new, separate deployment target and a new "thing that can go
  down" alongside the existing FTP pipeline, not a replacement for it. One concrete
  consequence worth flagging now rather than at implementation time: the game itself
  is served over HTTPS (`codeenstein3d.mcdope.org`), and a browser blocks a plain
  `http://` request/WebSocket made from an HTTPS page as mixed content — so the
  signaling service **must** be reachable over TLS too, not just plain HTTP on some
  port. Cleanest fit for "keep the Node script itself dependency-free": put a
  lightweight reverse proxy already available on most VPS setups (nginx/Caddy — either
  is a one-time, well-trodden setup, e.g. Caddy's automatic Let's Encrypt handling) in
  front to terminate TLS on a dedicated subdomain, with the Node process itself
  listening on `localhost` only — the script stays plain HTTP internally (no cert
  handling, no dependency on an ACME library), and the proxy is the only thing
  actually exposed on the VPS's firewall. The app itself then needs this subdomain
  baked in somewhere (a small build-time constant, the same pattern
  `vite.config.ts`'s `define` already uses for `__BUILD_TIME__`/`__BUILD_REF__`) —
  not a design problem, just a real wiring detail to remember when this gets built.

**Bottom line**: getting the connect-flow UX that was actually asked for (a short,
typable code, no QR scanning) means accepting one small piece of backend — but since
it has to be a real always-on process anyway, it's cheap to have that same process
also serve the lobby feature, and it fits the project's existing Node-scripting style
exactly: one dependency-free `.mjs` file that can install/manage its own systemd unit.

## Per-checklist-item notes

- **Coop, individual score, comparison table, spread spawn points** — feasible, clean
  extension points exist. `pickSafeSpawn()`/`pickExit()` (`src/map/generation/
  spawnExit.ts`) currently each return exactly one `Point` — spawn picks one corner of
  the first room, exit picks the center of the single farthest room.
  **Decision: spawn count is player-count-driven, and each spawn should be picked to
  maximize its distance from both the exit and every other chosen spawn** (not a fixed
  pool). Recommended shape to get that without re-opening the "same source → same map"
  determinism invariant (`architecture.md`'s "Determinism and replay" section; what
  lets `replay.ts` regenerate a level byte-identically from just an AST hash): pick the
  exit first exactly as today, then run a greedy farthest-point selection over room
  centers/corners — each successive spawn is whichever remaining candidate maximizes
  its *minimum* distance to the exit and every spawn already chosen. That greedy
  process is itself fully deterministic from the AST alone (no player count needed to
  run it) and naturally produces an *ordered* candidate list where earlier entries are
  already the most-dispersed; "player-count-driven" then just means a session activates
  the first N entries of that already-deterministic ordering. Net effect: the
  underlying generation step stays exactly as AST-deterministic as everything else in
  `mapGenerator.ts`, and only "how many of the ordered candidates are lit up as active
  spawns this session" depends on player count — the smallest surface area that
  actually needs to vary. Keep this as a new, separate multiplayer-only function
  alongside `pickSafeSpawn` rather than changing it — single-player's existing
  criterion (farthest from *enemy-bearing rooms*, for safety) is a different objective
  than multiplayer's (farthest from *exit and other spawns*, for spread), and
  single-player behavior/determinism shouldn't shift as a side effect of adding this.
  Per-player `ScoreBreakdown` + a final comparison table is straightforward given the
  existing summable shape.
- **Server/client, level-data-only transfer** — mechanism is straightforward: host
  generates the `GameMap` (as today) and sends it once to each peer. Privacy question
  is closed by the GitHub/Demos-only restriction (see above) — no redaction needed.
- **LAN lobby, direct IP/DNS connect, online lobby** — see
  [Direct connect via a short code](#direct-connect-via-a-short-code-what-this-actually-requires)
  and [Lobby folds into the same service](#lobby-folds-into-the-same-service): LAN,
  direct connect, and online play (with or without browsing a public list) all run
  through one self-hosted Node signaling/lobby service — now in scope for v1, not
  deferred.
- **Teamwork kill-bonus sharing** — no assist/damage-attribution concept exists at all
  today; `killPoints()` (`scoring.ts`) is a flat per-kill value with no notion of "who
  dealt the damage." Needs new tracking (which player(s) hit an enemy before its
  death) before a bonus-split rule can be defined. Small but real new state.
- **Synced level-advance on exit (with countdown)** — good fit for the deterministic-
  sim model: "player entered exit tile" is just another simulation event visible
  identically to every peer if state stays in sync; a countdown-then-advance is a
  shared timer broadcast alongside that event. No architectural obstacle, ordinary
  feature work once any sync layer exists.
- **Elite enemies scale with player count** — trivial once multiplayer state exists:
  same multiplier-table shape as `DIFFICULTY_MULTIPLIERS`, applied at the same
  post-construction rescale point in `engine.ts`.
- **Adapt balancing AI for deathmatch/bots** — the existing bot infrastructure
  (`scripts/lib/bot.mjs`, balancing telemetry) is built entirely around solo
  PvE navigation/combat against static AI enemies; it has no PvP concept (evading/
  targeting another *player*, no notion of "opponent" at all). This is a substantial,
  separate effort, not an adaptation of existing code — scope it as its own initiative
  once real multiplayer combat exists to build it against, not as part of core netcode
  work.

## The netcode shape this points toward

Given the determinism/replay foundation already in place, the natural starting point
is **lockstep-style input sync** (send inputs, not positions) — but see
[Cross-browser determinism: measured, not theoretical](#cross-browser-determinism-measured-not-theoretical)
below: a PoC has since confirmed pure lockstep alone isn't safe, so the design needs
periodic state reconciliation as a real component from day one, not a contingency:

1. Host generates the map locally (as today, from a GitHub-loaded repo or the Demos
   campaign — see the privacy decision above), and sends the resulting `GameMap` once
   to each connecting peer.
2. Every peer runs its own full `RaycasterEngine` instance against that same map +
   the same shared PRNG seed.
3. Each tick, every peer's local input reaches every other peer (small,
   `InputSnapshot`-shaped payloads — the exact same shape already recorded per-frame
   by the replay system); once a tick's full input set is known, every peer calls
   `advance(dt)` with the *same* `dt` and the *same* merged input for that tick.
   Topology-wise, this should be a **star through the host** (every guest has one
   `RTCPeerConnection` to the host, none to each other), not a full mesh — it matches
   the manual-signaling design above (a joiner only ever exchanges one signaling code,
   with the host) and keeps the O(N) rather than O(N²) connection count as player
   count grows. The host relays each guest's input to every other guest.
4. In theory, because sim-relevant randomness is already 100% seeded-PRNG-driven,
   identical inputs + identical `dt` would give identical simulation on every peer,
   with no need to transmit positions/HP/etc. at all — only tiny per-tick input
   packets. **In practice, this alone is false — see below.**

This reuses real, already-proven properties of the codebase (`InputSource`,
`ReplayFrame`'s `{dt, input}` shape, the seeded-PRNG/`Math.random()` split) rather than
inventing new sync architecture. Three real risks this surfaces that don't exist
today — two listed here, and a third (cross-browser float divergence) big enough
that it has its own section directly below:

- **`dt` is currently computed independently per client** from each browser's own
  `performance.now()` (`engine.ts`'s internal rAF loop, `frame()`). Lockstep needs one
  agreed `dt` per tick shared by every peer (host-authoritative, most likely) — today's
  "each browser ticks on its own clock" model is not multiplayer-safe as-is and needs
  an explicit change, not just a wrapper.
- **Naive lockstep stalls on the slowest peer's ping** (can't advance a tick until
  everyone's input for it has arrived) — real implementations buffer input a few
  frames ahead to hide latency. Not a blocker, just real scope: this needs an
  input-delay buffer, not "just forward packets."

### Cross-browser determinism: measured, not theoretical

This was flagged above as an open risk ("JS floats are IEEE-754 everywhere, but
transcendental functions aren't guaranteed bit-identical across engines by spec") —
it's no longer a guess. A standalone PoC
([`scripts/poc-cross-browser-determinism.mjs`](scripts/poc-cross-browser-determinism.mjs),
doesn't import or modify any real game code) reproduced `mulberry32` verbatim and ran
500,000 iterations of a synthetic loop shaped like this engine's real hot paths
(`player.ts`'s turn math, `enemyAi.ts`'s `Math.atan2`/`Math.cos`/`Math.sin`/
`Math.hypot` steering), sparsely sampling and SHA-256-hashing the accumulating state
for a bit-exact comparison across plain Node, headless Chromium, Firefox, and WebKit,
same seed, same inputs, same iteration count everywhere.

**All four produced different hashes.** Concretely (one real run):

```
Node (reference) v18.19.1      sha256=017db586d8...
Chromium         149.0.7827.55 sha256=44cdb684d3...
Firefox          151.0         sha256=9248f0f043...
WebKit           26.5          sha256=c7017c6709...

Chromium diverges from Node at sample #9  (-46.84925600125043 vs -46.849256001250424)
Firefox  diverges from Node at sample #7  (135.15326695332456 vs 135.1532669533246)
WebKit   diverges from Node at sample #6  (3.864442687633033 vs 3.8644426876330322)
```

Every divergence is a single-ULP (last-bit) difference — and the most telling data
point is that **Node and Chromium diverge too, despite both running V8** — just
different versions of it. Once one engine's `Math.sin`/`cos`/`atan2` result differs
from another's by even that one bit, the accumulating state (`facing`/`x`/`y` in the
PoC; enemy/player position in the real engine) never re-converges bit-exact — it
carries the divergence forward on every subsequent tick, not as a rare edge case.

**Correction (later, denser measurement):** the "~1% of a 500,000-iteration run"
figure above was itself an artifact of this PoC's own coarse, `sampleEvery`-only
sampling — it could only ever resolve a divergence to a multiple of the sample
interval, rounding the true onset up to whichever sample happened to land after it.
`scripts/verify-multiplayer-determinism.mjs` (the CI-wired sibling this PoC was
converted into) now samples every iteration for the first 300, and the real onset is
**iteration 5-23** across Chromium/Firefox/WebKit — two orders of magnitude earlier
than this section originally reported. The reassuring finding that denser measurement
also revealed: the resulting drift doesn't grow with iteration count — it stays
bounded at machine-epsilon scale (~10⁻¹²% of `SNAP_THRESHOLD_TILES`) for tens of
thousands of iterations afterward, not compounding into anything gameplay-visible.
The consequence below (periodic reconciliation as a required part of the design) was
already the right call — the real numbers just confirm the existing
`RECONCILE_INTERVAL_TICKS`/`SNAP_THRESHOLD_TILES` values were already comfortably
adequate against it, not that they need tightening.

**Consequence for the design above**: pure lockstep (send inputs only, trust identical
simulation) is confirmed unsafe as the *sole* mechanism — not "safe until proven
otherwise." The fallback named above — periodic authoritative state reconciliation
(host's state wins; guests get corrected toward it on a regular interval, same idea a
fighting-game rollback netcode or an RTS's periodic checksum-and-resync uses) — needs
to be treated as a required part of the design from the start, not an optional
insurance policy to add later if problems show up. Lockstep still does the useful
work of keeping bandwidth tiny tick-to-tick (only input packets, not full state); the
periodic reconciliation layer on top is what keeps small, guaranteed-to-happen float
drift from silently compounding into a real desync over a whole level. The full
design for both halves of that hybrid is worked out in
[`doc/dev/multiplayer-netcode-spec.md`](doc/dev/multiplayer-netcode-spec.md).

## Sizing

This is a major initiative, not an incremental feature:

- Map-gen changes (multi-spawn) — small. Plan:
  [`doc/dev/multiplayer-game-state-spec.md`](doc/dev/multiplayer-game-state-spec.md#2-multi-spawn-generation).
- Scoring (per-player breakdown + comparison table, assist tracking) — small/medium,
  contingent on the engine's own single-player-only internals becoming per-player
  first (a real, larger prerequisite — see the plan). Plan:
  [`doc/dev/multiplayer-game-state-spec.md`](doc/dev/multiplayer-game-state-spec.md#3-scoring--assists).
- Elite scaling by player count — small. Plan:
  [`doc/dev/multiplayer-game-state-spec.md`](doc/dev/multiplayer-game-state-spec.md#4-elite-scaling-by-player-count).
- Gating multiplayer to GitHub/Demos sources only — small (flags already exist). Plan:
  [`doc/dev/multiplayer-game-state-spec.md`](doc/dev/multiplayer-game-state-spec.md#1-ui-gating).
- Signaling + lobby service (new, minimal backend piece) — small/medium: a single
  dependency-free Node script (in-memory session map, a handful of HTTP endpoints,
  TTL sweep), plus its own `--install`/`--uninstall` systemd-unit management. Folding
  the lobby in adds very little on top of the mailbox itself, but this is still a new,
  separate deployment target (a machine that runs it) and ongoing hosting/maintenance
  surface the project doesn't have today. Full spec:
  [`doc/dev/multiplayer-server-spec.md`](doc/dev/multiplayer-server-spec.md).
- Host/Join code UI + lobby browser screen — small/medium.
- Netcode itself (input sync, `dt` unification, connection lifecycle, reconnect/
  disconnect handling, the countdown/advance-sync event, **and periodic authoritative
  state reconciliation — now confirmed required, not contingent, see the PoC above**)
  — large; this is the bulk of the work, and measurably larger than a pure-lockstep
  design would have been. Full spec:
  [`doc/dev/multiplayer-netcode-spec.md`](doc/dev/multiplayer-netcode-spec.md).
- Deathmatch bot AI — large, and should be scoped as its own follow-on effort, not
  bundled into "ship multiplayer."

## Open questions for the user

1. ~~Coop-only for v1, deathmatch/bots deferred?~~ **Decided: yes, coop-only for v1.**
2. ~~Code style for Host/Join?~~ **Decided: 6-character random-but-unambiguous code
   (~30 bits), paired with lookup rate-limiting/backoff.**
3. ~~System-wide or per-user systemd unit? Which machine?~~ **Decided: system-wide
   unit, deployed on an existing VPS** — implies TLS via a reverse proxy in front
   (see above), on a dedicated subdomain.
4. ~~Public lobby entries: identity needed?~~ **Decided: anonymous by default
   (campaign name + player count), with an optional host-chosen display name.**
5. ~~Spawn point count: player-count-driven or a fixed pool?~~ **Decided:
   player-count-driven, each spawn maximizing distance from the exit and every other
   spawn** (see the "Coop..." per-checklist note above for the recommended
   deterministic-candidate-ordering implementation shape).

All open questions from this research pass are now resolved.

## Implementation plan

High-level steps only — details live in the three specs. Work lands as multiple
PRs targeting the `multiplayer` branch; each step below is roughly one PR (split
further if one grows too large, never merged together). Order matters: 1 is
independent, 2 depends on 1, 3–5 are engine/map work independent of 1–2, and
6–9 need everything before them.

1. **Signaling + lobby server** — the standalone Node script
   (`multiplayer-server-spec.md`), including `--install`/`--uninstall` and its
   own verification script.
2. **Client connect flow** — Host/Join UI (gated to GitHub/Demos), signaling
   client, WebRTC connection + data-channel setup, lobby browser screen. Ends at
   "two browsers hold an open data channel," no gameplay yet.
3. **Engine: `simulate()`/`render()` split** — gated on the N=1
   byte-identical checks (test suite, replay playback, trajectory digest).
4. **Engine: N-player model** — per-player state, camera-parameterized shot
   resolution, enemy targeting, death/spectate (`multiplayer-game-state-spec.md`
   §6). Same N=1 gate.
5. **Map generation: multi-spawn** — `pickMultiplayerSpawns` + the
   avoidance/hazard integration, behind the `maxPlayers` parameter (inert for
   single-player).
6. **Netcode core** — worker tick clock, session-setup payload, input delay
   buffer, lockstep input sync over the channels from step 2.
7. **Reconciliation** — snapshots incl. PRNG-state resync, drift correction
   (snap + render smoothing).
8. **Session lifecycle** — disconnects (incl. loot drops), host-disconnect
   handling, level transitions with countdown, MP-specific rules (cheats off,
   replay/highscore off, pause suppression, lore overlay).
9. **Scoring & polish** — per-player scoring/assists, comparison table, elite
   scaling by player count, loot visibility on mini-/automap.
10. **Verification & docs** — cross-browser determinism check wired into CI,
    multi-peer e2e smoke test, user/dev docs + privacy.md updates, CHANGELOG.
