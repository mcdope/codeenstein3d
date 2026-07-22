# Multiplayer netcode specification

**Status: implemented** (`src/multiplayer/*.ts`, engine integration in
`src/engine/engine.ts`) and CI-verified (`scripts/verify-multiplayer-*.mjs`) —
this document specifies the netcode layer that sits *above* the existing
single-player `RaycasterEngine`, per
the design direction and constraints already decided in
[`multiplayer-research.md`](../../multiplayer-research.md) (star topology through a
host, GitHub/Demos-only sourcing, the signaling/lobby service) and the finding from
`scripts/poc-cross-browser-determinism.mjs`: cross-engine (and even cross-*version*,
same-engine) transcendental math (`Math.sin`/`cos`/`atan2`/`sqrt`/`hypot`) is not
bit-identical, so pure input-only lockstep is confirmed unsafe as the sole
synchronization mechanism. This document specifies the hybrid that research settled
on: **lockstep input sync as the primary transport, plus mandatory periodic
host-authoritative state reconciliation** to bound the drift lockstep alone can't
prevent.

## Goals / non-goals

**In scope**: the mechanics of keeping N peers' independent `RaycasterEngine`
instances close enough to a single shared, playable reality — tick pacing, input
distribution, drift correction (including keeping the shared PRNG stream itself in
sync, not just visible entity state — see mechanism 3), what happens when a
connected player's connection drops mid-session (see
[Session lifecycle](#5-session-lifecycle-joining-and-disconnects)), which local
signals (pause/blur/lore-freeze, Doom cheat codes) must never be allowed to reach
the shared simulation at all (see
[What the shared simulation's input source must never allow through](#6-what-the-shared-simulations-input-source-must-never-allow-through)),
and how a session moves from one level to the next (see
[Level transitions](#7-level-transitions)).
**Out of scope**: the signaling/lobby service itself (`multiplayer-research.md`), per-player
scoring/kill-bonus rules, multi-spawn generation, deathmatch, anything about the
actual `RTCPeerConnection`/`RTCDataChannel` setup handshake beyond "assume it already
exists and two data channels are open" (this document starts from "peers are
connected," not "peers are connecting") — and, explicitly, **late-joining**: a
player can only join before the host starts the level, never mid-session (see
[Session lifecycle](#5-session-lifecycle-joining-and-disconnects) for why, and what
enforces it).

## Roles and terminology

- **Host** — the peer that generated the `GameMap` (per `multiplayer-research.md`'s
  privacy decision, always from a GitHub-loaded repo or the Demos campaign) and holds
  simulation authority. Structurally, the host is *also* just a peer running its own
  `RaycasterEngine` instance — it has no special rendering or input path, only the
  extra orchestration responsibilities this document assigns it.
- **Guest** — any other connected player. Each guest also runs a full, real
  `RaycasterEngine` instance locally (per `multiplayer-research.md`'s lockstep
  design: guests are not thin clients rendering host-streamed frames).
- **Tick** — one discrete simulation step, i.e. one `engine.advance(dt)` call. Under
  this spec, ticks — not wall-clock frames — are the unit of network synchronization.
  The *driving seam* is the one the replay system already proves out
  (`ReplayPlaybackInput` + `main.ts`'s replay-viewer loop already call
  `engine.advance(frame.dt)` externally instead of relying on the engine's own
  internal `requestAnimationFrame` loop — see `src/engine/engine.ts`'s
  `frame()`/`advance()` split), and a multiplayer tick driver is a new caller of
  that same existing public seam. **Correction from this document's first pass**: an
  earlier revision claimed `advance()` itself needs no modification — that was
  wrong, and contradicted `multiplayer-game-state-spec.md`'s own finding that the
  engine is internally single-player (one `Player`, one health/ammo/weapon set).
  `advance()`'s *internals* must become per-player to consume a `TickInputBundle`
  at all; that engine-side design is specified in
  [`multiplayer-game-state-spec.md` §6](multiplayer-game-state-spec.md#6-the-n-player-engine-model)
  and is a hard prerequisite for everything in this document.
- **Session** — one connected multiplayer game, star-topology: every guest holds one
  `RTCPeerConnection` to the host, none to each other (per `multiplayer-research.md`).

Two data channels per host↔guest connection, both **reliable and ordered** — WebRTC's
default `createDataChannel()` configuration, no special options:

- `input` — per-tick input distribution (mechanism 1/2 below).
- `reconciliation` — periodic authoritative state snapshots (mechanism 3/4 below).

Both are reliable/ordered deliberately, not the unreliable/unordered ("like UDP")
config a naive real-time position broadcast would use: genuine lockstep requires
*every* tick's input to eventually reach *every* peer, in order — dropping one
tick's input outright is a permanent desync, categorically worse than the float
drift this whole document exists to correct. The input-delay buffer (mechanism 2)
is what absorbs ordinary latency; reliability absorbs packet loss. Bandwidth for
both channels is small enough (tiny per-tick input packets; an infrequent, bounded
snapshot) that there's no real cost to defaulting both to the safer setting.

## 1. Star topology & `dt` unification

### Topology

```
        ┌────────┐
        │ Host   │  runs RaycasterEngine, owns the GameMap,
        │ (peer) │  owns tick pacing
        └───┬────┘
    ┌────────┼────────┐
    │        │        │
┌───┴───┐┌───┴───┐┌───┴───┐
│Guest 1││Guest 2││Guest 3│  each runs its own full RaycasterEngine
└───────┘└───────┘└───────┘
```

Every guest talks only to the host (matches the signaling design: a joiner only
ever exchanges one code, with the host — see `multiplayer-research.md`). The host
relays; guests never see each other's connections directly. This keeps connection
count at O(N) instead of a full mesh's O(N²), same reasoning already applied to the
signaling layer.

### `dt` unification: fixed tick rate, not measured wall-clock time

Today, single-player `RaycasterEngine.frame()` computes `dt` from
`(now - lastTime) / 1000` against each browser's own `performance.now()`, clamped
by `MAX_DT` — every player's simulation runs at a *slightly* different, real,
locally-measured rate. That's fine solo; it's not safe multiplayer, because it means
every peer would be feeding a different `dt` value into `advance()` even before any
`Math.sin`/`cos` divergence enters the picture at all.

**Decision: multiplayer sessions use a fixed simulation tick rate, agreed once at
session start, not a measured per-frame `dt`.**

- `TICK_RATE_HZ = 30` (tunable — see [Open tuning parameters](#open-tuning-parameters-not-final-values)).
  `FIXED_DT = 1 / TICK_RATE_HZ` (≈ 0.0333s), a **constant**, sent once as part of
  session setup alongside the `GameMap` transfer.
- Every peer calls `engine.advance(FIXED_DT)` — literally the same hardcoded number,
  every tick, on every peer. There is no "dt synchronization protocol" beyond
  agreeing on this one constant up front; measurement/rounding differences in `dt`
  itself are eliminated entirely, not merely minimized. (This does **not** fix the
  `Math.sin`/`cos` cross-engine divergence the PoC found — that's an independent
  source of drift, handled by mechanisms 3/4. Fixed `dt` only removes a *second,
  otherwise-compounding* source of disagreement that would make diagnosing the first
  one harder.)
- Rendering is **decoupled from the simulation tick rate**: each peer's own
  `requestAnimationFrame` loop still runs at its native rate and redraws from
  whatever the most recently completed tick's state is (optionally interpolated —
  see mechanism 4). A 144Hz-monitor player's *rendering* isn't throttled to 30Hz;
  only the *simulation* is tick-rate-locked. **This requires an engine-side seam
  that doesn't exist yet**: today `advance()` simulates *and renders* in one call
  — the split into `simulate(dt)` + `render()` is specified in
  [`multiplayer-game-state-spec.md` §6](multiplayer-game-state-spec.md#6-the-n-player-engine-model)
  (an earlier revision of this bullet silently assumed the split was free).
- `levelTime` (`this.levelTime += dt` each `advance()` call, `engine.ts`) needs no
  special handling under this design: since every peer accumulates the exact same
  sequence of the exact same constant, and IEEE-754 addition (unlike `Math.sin`/
  `cos`) is fully specified and bit-identical across engines, `levelTime` — and
  anything purely derived from it, like `isSpikeActive()`'s phase check in
  `traps.ts` — stays bit-identical across all peers by construction. It does not
  need to be part of the reconciliation payload.

### Session setup: what the host sends before tick 0

The first pass said only "`FIXED_DT`, sent once alongside the `GameMap`" — enough
of an underspecification to hide a guaranteed desync (difficulty, below). The
full setup exchange, per guest, after its data channels open and before any tick:

1. **Build-version handshake, both directions, first.** Peers exchange
   `__BUILD_REF__`/`__BUILD_TIME__` (already baked into every bundle by
   `vite.config.ts`'s `define`) and the host refuses the join on mismatch. Two
   peers on different cached bundles run *different simulation code* — a desync
   source no amount of reconciliation can paper over, and near-impossible to
   diagnose from symptoms. Cheapest check in this entire document.
2. **Roster**: the full sorted `playerId` list and the joiner's own assigned id.
3. **Tick constants**: `TICK_RATE_HZ`/`FIXED_DT`, `INPUT_DELAY_TICKS`.
4. **The level-1 `gameplaySeed`** — §7 already specifies per-level reseeding at
   transitions; the *first* level needs the identical treatment at setup, which
   the first pass only ever implied.
5. **Difficulty — host-authoritative, because it's sim-relevant.** Verified:
   difficulty is a per-client localStorage preference passed into the engine
   constructor, and it scales enemy HP, enemy-dealt damage, and
   `enemyAimSpreadDeg` — all simulation state. Two peers applying different
   multipliers desync *structurally*, before any float drift enters the picture.
   The session runs on the host's difficulty for every peer; a guest's own local
   preference is ignored for the session's duration (their UI should say so).
   **Frozen for the whole session, including across level transitions** — in
   single-player a difficulty change "takes effect on the next level load"
   (`replay.ts`'s own documented behavior); in a session that rule would let the
   *host's* selector silently feed a different multiplier into its own
   next-level engine than the guests construct with, since §7's transition
   payload doesn't carry difficulty. Simplest correct rule: the difficulty
   captured here at setup is the session's difficulty until the session ends;
   the host's selector is inert mid-session like every guest's.
   Gore, by contrast, stays local: it's cosmetic-only (`Math.random`-driven
   particle counts) and never feeds the simulation.
6. **The session's player count** for elite scaling (game-state §4), fixed per
   level per §5's no-mid-level-recompute rule.
7. **The `GameMap` — chunked, with `visited` stripped, and backpressure-aware.**
   An `RTCDataChannel` message has a practical cross-browser size floor around
   64 KiB; a 160×160 map's JSON crosses that on grid data alone (~50 KB before
   enemies/rooms/terminals). Send the serialized map in fixed-size chunks (16
   KiB is the conventional safe size) with a final end-marker over the
   reliable channel — routine once planned, a mid-implementation surprise
   otherwise. `visited` is omitted from the wire entirely: it's all-`false` at
   generation time by definition, so each peer just constructs it locally.
   **Firing every chunk synchronously with nothing watching
   `bufferedAmount` is a real bug, not a theoretical one** — confirmed
   directly as the cause of a real, reproducible CI failure (WebKit's own
   `RTCDataChannel.send()` throwing mid-burst). `sendJsonWithBackpressure`/
   `sendJsonSequence` (`dataChannelMessaging.ts`) pause and wait for a real
   `"bufferedamountlow"` event once buffered data exceeds a watermark, and
   reject cleanly (instead of throwing synchronously into a message-handler
   callback) on a non-`"open"` channel — every chunked transfer (this one, and
   §7's level-transition payload) must go through them, not a bare `send()`.

### Message flow per tick

The host is the *sequencer*, not a relay of raw peer-to-peer packets — it collects,
merges, and re-broadcasts one canonical bundle per tick, which is what lets every
peer (including itself) call `advance()` against the exact same input set:

```
Guest samples local input for tick T+delay
        │  (send once, over the reliable `input` channel)
        ▼
   Host collects every connected player's input for tick T
   (including its own, sampled the same delayed way — see mechanism 2)
        │
        ▼
   Host finalizes the merged TickInputBundle for tick T
   (real input where received; held-last-input fallback for anyone late)
        │  (broadcast to every guest, over `input`)
        ▼
Host calls advance(FIXED_DT) for T  ──  Guests call advance(FIXED_DT) for T
      (using the bundle)                     (using the same received bundle)
```

Wire shape for the per-tick bundle:

```ts
/** One player's sampled input for one tick — same shape `replay.ts`'s
 * `InputSnapshot` already records per-frame; reused as-is, not reinvented. */
interface TickInput {
  tick: number;
  playerId: string;
  input: InputSnapshot; // src/engine/input.ts — unchanged
}

/** What the host actually broadcasts once a tick's input set is finalized —
 * every peer (host included) advances from this, not from its own locally
 * sampled input alone. */
interface TickInputBundle {
  tick: number;
  dt: number; // always FIXED_DT — included for a receiver-side sanity check,
              // not because it varies
  inputs: Record<string /* playerId */, InputSnapshot>;
  /** playerIds whose input for this tick used the held-last-input fallback
   * (mechanism 2) rather than a real, on-time packet — diagnostic-only,
   * lets a guest's UI show a "so-and-so's connection is lagging" hint
   * without needing separate connection-quality plumbing. */
  heldInputFallback: string[];
  /** playerIds removed from the session effective THIS tick (disconnect
   * grace-period expiry — §5). Roster changes ride the bundle so removal is a
   * synchronized lockstep event applied by every peer at the same tick — not
   * an eventually-consistent side effect of snapshot shape (the superseded
   * first-pass design; see §5). Empty on almost every tick. */
  rosterRemove?: string[];
}
```

### Tick pacing must survive background tabs

Mechanism 6 below suppresses the *logical* pause (Escape/blur setting `isPaused`) —
but that alone is defeated one layer down by the browser itself, and this spec's
first pass missed it: `requestAnimationFrame` stops firing entirely in a hidden
tab, and main-thread `setTimeout`/`setInterval` are throttled (to ~1Hz baseline,
and far more aggressively under Chrome's intensive throttling). If the **host's**
fixed-tick accumulator is driven by rAF or a main-thread timer, the host
alt-tabbing physically stops `TickInputBundle` production and freezes the session
for everyone — the exact failure mechanism 6 exists to prevent, reintroduced by
the scheduler instead of the pause flag.

- **The host's tick clock runs in a dedicated Web Worker**, posting a message per
  due tick to the main thread, which does the actual collect/finalize/broadcast/
  `advance()` work. Worker timers are not subject to the hidden-tab throttling
  that main-thread timers and rAF are — this is the standard, well-trodden fix for
  exactly this problem in browser game/audio scheduling. (Chrome additionally
  exempts pages holding an open `RTCPeerConnection` from *intensive* timer
  throttling, which helps, but that's a browser-specific relaxation to benefit
  from, not a guarantee to build on — the worker clock is the load-bearing fix.)
- **Guests are naturally throttle-resistant if bundle application is
  event-driven, and must be built that way**: a guest advances when a
  `TickInputBundle` *arrives* (`RTCDataChannel`'s `onmessage`, which still fires
  in hidden tabs), not on its own rAF/timer schedule — so a backgrounded guest's
  simulation keeps pace with the host automatically, with no separate catch-up
  protocol needed. If application ever lags anyway (a slow device, a long GC
  pause), the reliable/ordered channel means the backlog is simply applied in
  arrival order, oldest first, in a bounded fast-forward loop — never skipped.
- **Rendering stays on rAF and is allowed to freeze in a hidden tab** — that's
  correct behavior, not a gap: nobody is looking at it. Only *simulation* must
  keep running, which is exactly the split mechanism 1's render/simulation
  decoupling already established.

## 2. Input delay buffer

Waiting for a genuinely-current tick's input from every peer before advancing (naive
lockstep) stalls the whole session on the slowest peer's round-trip time. The
standard fix — and the one this spec adopts — is an **input delay buffer**: sample
input now, but schedule it for a tick slightly in the future, giving the network
time to deliver it before that tick actually needs to run.

- `INPUT_DELAY_TICKS = 3` at `TICK_RATE_HZ = 30` ≈ 100ms of buffer (tunable — see
  [Open tuning parameters](#open-tuning-parameters-not-final-values); should
  ultimately track measured RTT rather than being a flat constant, but a fixed
  conservative default is the correct v1 starting point, not an adaptive scheme from
  day one).
- Every peer — **including the host, for its own local input** — samples its
  `InputSnapshot` for the current tick `T` and tags it for tick `T + INPUT_DELAY_TICKS`,
  sending it immediately rather than waiting. Applying the delay to the host's own
  input too is deliberate, not an oversight: skipping it would give the host a
  built-in input-latency advantage over every guest, a real, known fairness bug
  class in naive networked-game implementations.
- The host buffers incoming `TickInput`s in a small structure keyed by tick:
  `Map<tick, Map<playerId, InputSnapshot>>`. When real time (paced by the host's own
  fixed-tick accumulator — accumulate real elapsed `dt`, and whenever the
  accumulator has banked at least `FIXED_DT`, tick `T` is *due*) reaches the point
  where tick `T` is due, the host finalizes `T`'s bundle from whatever's arrived:
  - If every connected player's input for `T` has arrived: use it as-is.
  - If a given player's input for `T` hasn't arrived yet (a real but expected-to-be-
    rare case — a momentary latency spike beyond the buffer's margin, not routine
    operation): **hold that player's last-received `InputSnapshot`** for `T` rather
    than stalling the whole session for one slow peer. This is the policy that keeps
    "never fully stall" true even under an imperfect network. It's also exactly why
    periodic reconciliation (mechanism 3) is mandatory rather than optional: a
    held-input tick is a deliberate, known-approximate tick, and reconciliation is
    what bounds how far that approximation is allowed to drift before being
    corrected outright.
- The delay is deliberately expressed in **ticks**, not milliseconds, so it composes
  cleanly with the fixed tick rate above — no unit conversion at the point of use.

### A consequence of the delay: hit resolution needs lag compensation

Because a fire input's *execution* is `INPUT_DELAY_TICKS` ticks behind the
*decision* it represents (for every player, host included — see above), naively
hit-testing a shot against a target's live, current-tick position is wrong: a
moving enemy has had up to `INPUT_DELAY_TICKS` ticks (~100ms) to leave the window
the shooter actually aimed at by the time the shot resolves. This is negligible for
a slow, wide ranged cone-of-fire but breaks melee outright (a very tight
range/facing check) — found the hard way, via a real end-to-end bot that could
never land a single melee hit in multiplayer despite winning single-player
reliably with byte-identical decision logic.

`RaycasterEngine` fixes this the standard way real networked shooters do (rewind
the *target*, never the shooter — the shooter's own position, itself continuously
informed by the same fixed delay, is already the correct reference frame the
decision was made from): a per-tick ring buffer of past enemy positions
(`enemyPositionHistory`, capped at `INPUT_DELAY_TICKS + 1` frames, multiplayer-only)
feeds `resolveShot()` the enemy positions from exactly `INPUT_DELAY_TICKS` ticks
ago instead of live ones. Only the *hit-test* projection is rewound — actual
damage still mutates the real, live `Enemy` object. Single-player never populates
the buffer at all, so it's byte-identical to pre-lag-compensation behavior.

## 3. State reconciliation payload

### Cadence and transport

`RECONCILE_INTERVAL_TICKS = 30` at `TICK_RATE_HZ = 30` → once per second (tunable —
see [Open tuning parameters](#open-tuning-parameters-not-final-values)). Sent by the
host only, over the reliable/ordered `reconciliation` channel, tagged with the tick
it reflects (post-`advance()` for that tick) so a receiver knows exactly which local
tick to reconcile against.

### Entity identity — how a guest maps a snapshot entry back to its own local object

Reconciliation only works if both sides agree on *which* enemy/mine/pickup a given
entry refers to, without shipping a full re-identification scheme:

- **Map-authored entities** (`GameMap.enemies`, `.mines`, `.ammoPickups`, `.keys`) —
  every peer received the identical `GameMap` at session start (generated once, by
  the host, per `multiplayer-research.md`), so **array index is already a stable,
  shared identity** for all of these. No new ID scheme needed.
- **Runtime-spawned loot drops** (`GameMap` doesn't have these — `LootDrop[]` is
  built up during play, via `RaycasterEngine.pushLootDrop`, `engine.ts`) — array
  index is *not* stable here, since drops are created dynamically. Checked directly
  against the real drop logic (`engine.ts`, the on-kill loot block): **a single
  enemy death can push more than one `LootDrop`** — a health drop (its own
  always-on check) and a separate weighted roll can both fire for the same kill.
  Identity is therefore `` `${enemyIndex}:${dropSeq}` ``, where `enemyIndex` is the
  dying enemy's stable array index and `dropSeq` is that enemy's drop count so far
  this level (0, 1, ...) — both sides can compute this without a shared counter,
  since the source's own drop-call order (health check first, then the main roll)
  is itself deterministic.
- **Grid tile mutations** (a door opening, a secret wall's flood-fill reveal) — both
  already funnel through the engine's existing `gridVersion` counter (`engine.ts`,
  bumped in `tryOpenSecretWall()` and the key-unlock handler), which exists today
  purely to invalidate render/pathfinding caches. This spec reuses that exact seam
  rather than inventing a parallel one: alongside bumping `gridVersion`, record the
  list of `{x, y, newValue}` tiles that changed in that mutation (a door open is one
  entry; a secret-room flood-fill reveal is however many tiles the flood fill
  touched — confirmed directly in `tryOpenSecretWall()`, it's a real multi-tile
  flood fill, not a single tile, so the delta list length genuinely varies per
  event). The reconciliation payload carries `gridVersion` plus every tile-delta
  entry since the last snapshot the receiver already has.

### Payload shape

```ts
interface ReconciliationSnapshot {
  tick: number;
  /** The shared `mulberry32` stream's raw internal 32-bit state at this tick,
   * post-`advance()` — see "The PRNG state gap" below. Not optional, and not
   * one of the fields covered by mechanism 4's magnitude-threshold logic:
   * always overwritten exactly, every snapshot, regardless of whether it
   * currently differs from the receiver's own. */
  rngState: number;
  players: Record<string /* playerId */, PlayerSnapshot>;
  enemies: EnemySnapshot[];       // index-aligned with GameMap.enemies
  mines: MineSnapshot[];          // index-aligned with GameMap.mines
  lootDrops: LootDropSnapshot[];  // full current set, id-tagged (see above)
  pickupsCollected: number[];     // indices into GameMap.ammoPickups now collected
  keysCollected: number[];        // indices into GameMap.keys now collected
  gridVersion: number;
  gridDelta: TileMutation[];      // tiles changed since the last snapshot
}

interface PlayerSnapshot {
  posX: number;
  posY: number;
  dirX: number;
  dirY: number;
  planeX: number;
  planeY: number;
  health: number;
  swap: number;
  ammo: { bullets: number; rockets: number; smg: number; gas: number };
  weaponIndex: number;
  /** Dependency keys currently held (unused, in inventory). Gameplay-critical,
   * not cosmetic — keys gate door opening, and a guest can drift on a key
   * pickup during a PRNG-desync window exactly like any other field here.
   * Added in review; the first pass omitted it. */
  keysHeld: number;
  /** Indices into WEAPONS currently owned, sorted ascending (a canonical
   * order, so two peers' snapshots of identical state are byte-identical).
   * Same review rationale as keysHeld: owning a weapon gates firing and
   * switching, and weapon pickups are loot-roll-derived — drift-prone. */
  ownedWeapons: number[];
  /** False once dead-but-spectating (coop death, game-state §6). A dead
   * player REMAINS in this Record — absence from `players` is a protocol
   * error, never a signal. (An earlier revision used snapshot omission to
   * mean "player removed"; that collided head-on with dead-but-present
   * spectators and is superseded by `TickInputBundle.rosterRemove` — §5.) */
  alive: boolean;
  /** Kill/assist score credited so far — the one score component whose drift
   * would otherwise be permanent (see the score note under "Deliberately
   * excluded" below). */
  killScore: number;
  kills: number;
}

interface EnemySnapshot {
  index: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  aggroed: boolean;
}

interface MineSnapshot {
  index: number;
  alive: boolean;
  visible: boolean;
}

interface LootDropSnapshot {
  id: string; // `${enemyIndex}:${dropSeq}` or `disconnect:${playerId}:${dropSeq}` —
              // identity only, for matching entries across peers; see below for
              // why pickup *behavior* must never be branched on this string.
  /** Explicit behavior tag — absent for every ordinary (enemy-kill/secret-room)
   * drop, so every existing single-player pickup path needs zero changes.
   * `"disconnect"` is the one value that currently changes pickup behavior (see
   * §5's no-op-if-already-owned rule) — see below for why this exists as its own
   * field rather than being inferred from `id`. */
  source?: "disconnect";
  x: number;
  y: number;
  kind: LootKind;
  amount?: number;
  weaponIndex?: number;
}

interface TileMutation {
  x: number;
  y: number;
  value: Tile; // src/map/types.ts's Tile union
}
```

### The PRNG state gap — a critical flaw in the payload as first scoped

Every other field in `ReconciliationSnapshot` corrects *visible* state — a
position, an HP total, whether something is alive. Correcting all of them is
**not sufficient** on its own, and treating it as sufficient was a real gap in this
document's first pass: it silently assumed that once entity state matches, the
two simulations are back in sync. They aren't, and the reason is the shared
`mulberry32` stream.

`mulberry32`'s own arithmetic (`|=`, `+`, `Math.imul`, `^`, `>>>`) is exact 32-bit
integer math — unlike `Math.sin`/`cos`/`atan2`, it genuinely is bit-identical
across every engine, which is *why* `replay.ts` can already trust it today. That's
not the problem. The problem is **how many times each peer has called it** by a
given tick. Per this project's own architecture docs, "sim-relevant randomness is
already 100% seeded-PRNG-driven" — weapon spread, loot rolls, enemy roam-target
picks, fire-cooldown jitter all draw from the one stream. The *number* of draws a
tick consumes depends on which code paths actually ran — which depends on entity
state (is this enemy still alive; is it in range; did its cooldown just expire).
The instant entity state between two peers differs by *anything* — including the
`Math.sin`/`cos` ULP-level drift this whole document already exists to correct —
a tick can take a different number of PRNG draws on one peer than another (an
enemy that's already dead on peer A skips its entire AI/fire-cooldown logic that
tick; the same enemy, still alive on peer B by one HP, does not). The moment that
happens, **the two peers' PRNG streams are no longer at the same position in the
sequence** — every future draw returns a different value on each side, meaning
every future weapon-spread angle, loot roll, and roam target diverges too, not just
the one field that first triggered it.

Snapping every visible field in the payload to the host's values, without also
snapping the PRNG stream itself back into alignment, fixes the *symptom* for
exactly one tick and guarantees a *new* divergence on the very next PRNG-consuming
decision — which, given how much of this engine's logic draws from that one
stream, is likely to be the very next tick. This is why `rngState` is a mandatory
field, not an optional add-on: without it, reconciliation looks like it's working
(the numbers match right after a snapshot) while actually re-diverging almost
immediately, in a way that's *harder* to notice than uncorrected drift would have
been, not easier.

**The fix**: `ReconciliationSnapshot.rngState` carries the shared stream's raw
32-bit internal counter at the tick the snapshot reflects. On receipt, a guest
overwrites its own local stream's internal counter with this value directly —
not "re-seed from a fresh number" (that would restart the sequence from the
beginning), but "resume from this exact point in the sequence," so the very next
`rng()` call on every peer returns the same value. This requires the engine's PRNG
wrapper to expose a way to *read* its current internal state and to be
*resumed* from an arbitrary raw state, not just constructed from a fresh seed —
`mulberry32(seed)` today only supports the latter. Scoping that small new
capability is implementation work for later, not this document, but the
requirement itself belongs here: without it, this fix has nothing to call.

**No magnitude threshold applies to this field, unlike position** — see mechanism
4's "simulation value always snaps immediately." A position can be "off by a
little," which is what the smoothing/threshold logic in mechanism 4 exists to
handle gracefully. A PRNG stream position cannot be "off by a little": it is either
byte-identical to the host's (already in sync, the write is a no-op) or it is
*completely* wrong from that point forward (off by even one draw is the same
category of wrong as off by a thousand). It is therefore always overwritten
unconditionally, every snapshot, with no smoothing concept applicable at all —
there's no "render offset" for an integer that isn't rendered.

**This does not close the gap between divergence and correction, and that's worth
being honest about rather than overselling the fix**: between the moment two
peers' PRNG streams actually diverge and the next `ReconciliationSnapshot`
(`RECONCILE_INTERVAL_TICKS` later — up to ~1 second at the current default), every
PRNG-consuming decision on the affected peer is genuinely, visibly wrong on that
peer (a different loot kind, a different roam target, a different spread angle) —
`rngState` guarantees the desync doesn't become *permanent*, it doesn't make it
*instant to correct*. That's an argument for keeping the reconciliation interval
tight, not a reason to treat this fix as a complete solution on its own — folded
into the existing tuning caveat below, not a reason to revisit the interval value
in this document.

### Deliberately excluded from the payload

Rigor here means including exactly the fields where drift is *consequential*, not
every mutable field that exists:

- **`Enemy.attackCooldown` / `.hitFlash` / `.roamX` / `.roamY` / `.fireCooldown`** —
  short-lived timers and idle-roam targets. A guest's copy being briefly off by a
  fraction of a cooldown cycle doesn't change a fight's outcome and self-corrects
  within roughly one cooldown period; including them would add real bytes for no
  fairness benefit.
- **`Mine.closeTimer`** — sub-second fuse-arming state; same reasoning. The
  fairness-relevant moment (does it detonate) is fully captured by the `alive`
  correction the instant it actually does, host-side.
- **`SpikeTrap` entirely** — as established under mechanism 1, its active/safe phase
  is a pure function of `levelTime` (itself drift-free by construction), so it needs
  no correction at all.
- **In-flight `Projectile`/`Rocket`s** (`projectiles.ts`/`rockets.ts`) — high-
  frequency, extremely short-lived (a rocket exists for a fraction of a second
  before detonating). Excluding them keeps the payload small; any resulting
  visual-only divergence in a bolt's exact mid-flight pixel position is invisible
  in practice (it resolves within a fraction of a second), and the outcome that
  actually matters — damage dealt on detonation — is captured by the
  `PlayerSnapshot`/`EnemySnapshot` health corrections regardless.
- **Score / `ScoreBreakdown`** — *mostly* excluded, with a review correction: the
  first pass excluded score entirely while elsewhere claiming peers' end-of-run
  tables are "identical by lockstep construction" — false under the very drift
  model this document is built on. A kill landing during a desync window credits
  differently on different peers and, uncorrected, stays different *forever* —
  kill credit is an accumulator, not derivable from current state. Resolution:
  the drift-permanent accumulators (`killScore`, `kills`) ride `PlayerSnapshot`
  (above) and get corrected like any other field. The remaining `ScoreInput`
  components genuinely need no sync: they're either recomputed live from
  already-reconciled state (health/ammo bonuses), deterministic-shared
  (`levelTimeSec`, `shortestPathTiles`), or per-player local counters whose
  drift is bounded and cosmetic mid-level (accuracy, distance traveled). The
  authoritative end-of-level table comes from the host with the §7 transition
  payload; only the host-disconnect case falls back to local best-effort values,
  labeled as such (§5).

## 4. Drift correction: hard snap vs. interpolation

Two different things need two different treatments here, and conflating them is the
usual way this class of netcode ends up feeling bad: the **authoritative simulation
value** (what collision/AI/scoring math actually uses) and the **rendered
value** (what the player's eyes see). They are allowed to briefly disagree on
purpose.

### The simulation value always snaps immediately

The moment a `ReconciliationSnapshot` arrives, every field it carries overwrites the
receiving peer's corresponding local simulation state **immediately, in full** — no
partial/eased application to the numbers `advance()` itself will compute from next
tick. Reasoning: leaving the simulation running from a known-wrong value even
briefly lets that tick's `Math.sin`/`cos`/`atan2` calls compound *more* drift on top
of the drift already being corrected — the opposite of the goal. Correctness of the
next tick's simulation takes priority over how this tick's correction looks.

### The rendered value interpolates — decoupled from the simulation value

To avoid every correction reading as a visible teleport, each peer keeps a small
**render offset** per corrected entity (own player included), separate from that
entity's authoritative simulation position:

1. Immediately before applying a snapshot: record `renderOffset = oldSimPosition - newAuthoritativePosition` (a small vector, since ordinary drift per the PoC's evidence is single-ULP-scale per tick and only becomes visible after many uncorrected ticks — see the magnitude split below).
2. Snap the simulation position to `newAuthoritativePosition` (previous section).
3. For rendering only, draw at `simPosition + renderOffset`, then decay `renderOffset` toward zero over a short fixed window — `CORRECTION_SMOOTH_MS = 150` (tunable — see [Open tuning parameters](#open-tuning-parameters-not-final-values)) — e.g. linearly or via a simple ease-out, recomputed each render frame independent of the simulation tick rate (this is exactly the render/simulation decoupling mechanism 1 already established, reused here).
4. Once the window elapses, `renderOffset` is zero and the rendered and simulated positions are identical again.

This applies uniformly to the player's own avatar, other players, and enemies —
with one asymmetry worth calling out for the **local player specifically**: the
local player's own future ticks keep being driven by their own real, live input
starting from the snapped (correct) position — the correction never fights or
overrides what the player is actively doing, it just relocates the baseline they're
moving from, smoothed visually so that relocation doesn't read as a stutter. Other
players' and enemies' positions have no local-input-prediction complexity at all
(they're driven purely by the shared lockstep simulation), so the same
snap-sim/smooth-render treatment applies to them even more simply.

### Magnitude threshold: small drift smooths, large mismatch snaps outright — visually too

The interpolation above is for the *common* case the PoC evidence describes: tiny,
steadily-accumulating float disagreement, where the correction delta is small (well
under one tile) by the time a reconciliation catches it. That's not the only case
that can occur:

- **Below `SNAP_THRESHOLD_TILES` (e.g. 0.5 tiles — tunable, see below)**: use the
  smoothed-render treatment above. This is expected to be the overwhelming majority
  of corrections in practice, per the PoC's own measured drift rate — denser,
  corrected measurement (`scripts/verify-multiplayer-determinism.mjs`'s
  `reportDriftMagnitudes`) found ULP-scale differences actually appear far earlier
  than this section originally said (iteration 5-23 of a run, not "~1%" of it — that
  figure was an artifact of the original PoC's coarse sampling), but confirmed the
  more important claim directly instead of assuming it: the resulting drift stays
  bounded at machine-epsilon scale (~10⁻¹²% of `SNAP_THRESHOLD_TILES`) for tens of
  thousands of iterations afterward, i.e. real per-tick position math does not turn
  this into anything gameplay-visible.
- **At or above `SNAP_THRESHOLD_TILES`**: apply the correction with **no render
  smoothing at all** — an instant, visible snap. A mismatch this large means
  something categorically worse than ordinary float drift happened (a missed/held
  input tick that mattered, a reconnect that skipped ticks, a real bug) — trying to
  smooth a correction that size over 150ms would look like *worse* netcode
  (rubber-banding), not better, and would briefly let a guest's local, wrong state
  govern collision/visibility against a wall or an enemy that's already elsewhere
  from the host's point of view. An honest, instant correction is the better
  failure mode than a smooth but momentarily-fictional one.

## 5. Session lifecycle: joining and disconnects

Two lifecycle events this document's first pass left undefined. Both need an
explicit rule before implementation — not because the mechanics are hard, but
because leaving them implicit invites two different, incompatible assumptions to
get built on either side of the host/guest split.

### Late-joining: explicitly out of scope for v1

**A player can only join during the pre-level lobby/waiting-room state. Once the
host starts the level, no new player can join that session for the rest of it.**
This is a scope decision, not a technical impossibility — admitting a genuinely new
peer mid-level is a real, solvable problem (it would need to hand the joiner a full
current-state snapshot equivalent to `ReconciliationSnapshot` rather than the
initial `GameMap` alone, and fold them into tick pacing without disrupting
everyone already playing), but it's meaningfully *more* than what mechanisms 1–4
already specify, and nothing about the checklist this work traces back to
(`multiplayer-research.md`) requires it for coop to be playable. Deferred as its
own follow-on, not built implicitly by accident.

Enforced at two layers, deliberately redundant with each other:

- **Signaling/lobby layer** (`multiplayer-server-spec.md`): the moment the host
  starts the level, it stops publishing fresh `PUT /session` offer rounds for that
  code — there is no next join round for a new joiner's `POST /session/<code>/answer`
  to land in. As an immediate courtesy update (rather than waiting out the
  session's TTL), the host also `PUT`s once more with `public: false`, dropping it
  from `GET /lobby` right away. No new server endpoint needed — this reuses exactly
  the existing `PUT`/TTL mechanics, just stops calling them for new rounds.
- **Netcode layer** (this document): independent of the signaling layer, the set of
  `playerId`s admitted into the session's `TickInputBundle` is **frozen the moment
  the level starts**, for that level's duration. Even if someone — a slow clicker
  who had the code before the level started, or anyone else who still holds a
  stale offer — somehow completes a WebRTC handshake with the host after that
  point, the host simply never adds their `playerId` to the roster tick pacing
  reads from. A completed `RTCPeerConnection` is necessary but not sufficient for
  being "in" the session.
- **Reconnection of an *already-admitted* player is a special case of the same
  restriction, not an exception to it** — see disconnects below. A player who was
  admitted, dropped, and wants back in is asking for exactly what late-joining
  denies (being added back into an already-started session's roster), so the same
  restriction applies to them too: once removed, that's final for the rest of the
  level.

### Disconnects: a simple, decisive rule

**On confirmed disconnect: the player's entity is removed from the level, their
current ammo pools are dropped as ordinary loot at their last known position, and
their score up to that point is preserved (marked disconnected) for the end-of-run
comparison table.**

Distinguishing this from mechanism 2's held-input fallback first, since the two
operate at different severities and conflating them is exactly what made this gap
easy to miss: **held-last-input** (mechanism 2) is for a single tick's packet
arriving a little late — normal, expected, resolved the instant the next real
packet arrives, no entity-lifecycle consequence at all. **Disconnect handling**
below is triggered by an actual transport-layer signal (`RTCPeerConnection`'s
`connectionState` reaching `disconnected`/`failed`, not merely "one tick was
late") and governs a much longer timescale.

1. **Grace period**: `DISCONNECT_GRACE_MS = 10_000` (10s — tunable, see
   [Open tuning parameters](#open-tuning-parameters-not-final-values)) from the
   transport-layer signal firing. During this window the player isn't yet
   considered gone — a real reconnection attempt (the same underlying WebRTC
   connection recovering, not a fresh join — see above, this isn't late-joining)
   can still succeed. While the grace period is running, the host substitutes
   `EMPTY_SNAPSHOT` (`replay.ts`'s existing all-neutral idle `InputSnapshot` — keys
   released, no fire, no turn — reused as-is, not reinvented) for that player every
   tick instead of continuing to hold whatever their last *active* input was: their
   entity stands inert rather than sliding along on stale movement input. This
   substitution is broadcast as part of the same canonical `TickInputBundle` every
   peer already applies uniformly, so — like the ordinary held-input case — it
   introduces no new inter-peer divergence risk on its own; the mechanism this
   section relies on to correct any that occurs anyway is the very fix from
   mechanism 3 above (`rngState`, plus the rest of the snapshot).
2. **If the grace period elapses without recovery**: the host removes the player
   as a **synchronized lockstep event** — their `playerId` rides
   `TickInputBundle.rosterRemove` for the tick the removal takes effect, and
   every peer (host included) applies it at exactly that tick: drop the player
   from the roster, delete their entity, convert their inventory to drops
   (item 3). An earlier revision instead signaled removal by *omitting* the
   player from the next `ReconciliationSnapshot` — superseded, for two reasons
   caught in review: it deliberately built in a window of up to
   `RECONCILE_INTERVAL_TICKS` where host and guests simulated *different
   rosters* (different enemy targeting → different PRNG consumption → a
   guaranteed desync window by design), and "absent from the snapshot" collided
   head-on with dead-but-spectating players, who are still session members and
   must never be deleted. The invariants are now: the snapshot's `players`
   Record **always contains every current roster member, dead or alive** (the
   `alive` flag distinguishes them); a bundle **always contains an input for
   every roster member** (real, held-fallback, or `EMPTY_SNAPSHOT` during
   grace). A guest receiving a bundle missing a roster member's input — which
   by construction should never happen — substitutes `EMPTY_SNAPSHOT` and logs
   a protocol warning rather than guessing at roster intent.
3. **Their currently-held ammo, and any weapon they'd unlocked beyond the default
   starting set, are converted into ordinary `LootDrop` entries** (reusing the
   existing `LootKind`s — no new drop type) at their last known position. The
   conversion is performed **locally by every peer at the `rosterRemove` tick**
   (deterministic from each peer's own copy of the departing player's state —
   which reconciliation keeps corrected like everything else; any residual
   divergence in the resulting drops is itself corrected by the next snapshot's
   `lootDrops` list):
   - One entry per non-zero ammo pool (`bullets`/`rockets`/`smg`/`gas`).
   - One `kind: "weapon"` entry per index in their `ownedWeapons` that isn't
     already in `STARTING_WEAPONS` (`weapons.ts`: pistol/shotgun/knife — every
     player already has these regardless, so "dropping" one would be redundant
     with the ammo drop above and grant nothing a picker doesn't already have).
     Concretely, this means their `UNLOCKABLE_WEAPONS` (`weapons.ts`) that they'd
     actually gone and unlocked — gdb, Ghidra, Friday Hotfix, Toolchain, whichever
     they had — return to the world rather than vanishing with them.
   - **The ammo entries land through the exact same pickup path every other
     `LootDrop` already uses, unchanged.** The weapon entries deliberately do
     **not**: single-player's existing `grantOrTopUpWeapon` (`lootApply.ts`) —
     "already own it? top up its ammo instead of a redundant grant" — is the
     *wrong* rule here, corrected from this document's first pass, which assumed
     reusing it unchanged was sufficient. In single-player, "already own it" only
     ever means one thing (there's only one player, so a same-weapon drop is
     genuinely just excess ammo). In multiplayer, a disconnect-sourced weapon drop
     exists specifically so a *teammate who doesn't have it yet* can find it —
     letting whichever player happens to walk near it first silently consume it
     into an ammo top-up (removing the drop) can permanently deny that weapon to
     someone who actually needed it, just because someone who didn't need it got
     there first.
   - **New rule for these specifically: a player who already owns the weapon
     doesn't collect it at all** — no grant (they have it already), no ammo
     top-up, no removal. The drop simply has no effect on them and stays exactly
     where it is, available to the next player who checks it. Only a player who
     does *not* yet own it triggers the normal grant-and-remove outcome. This is a
     genuinely new pickup outcome this codebase doesn't have today (every existing
     pickup, in single-player, has *some* effect on every collector) — a
     "no-op, drop persists" result specific to this drop kind/origin, not a
     variation on `grantOrTopUpWeapon`'s existing branches. If every connected
     player already owns the weapon, the drop simply sits uncollectable
     indefinitely — accepted as harmless (visual clutter at worst), not worth
     adding despawn logic for.
   - **Correction to this section's first pass — identification must be an
     explicit field, not a parsed `id` string.** The original version of this
     rule relied on checking whether a drop's `id` started with `disconnect:` to
     decide which pickup behavior applies — overloading a string that exists
     *only* to let both sides agree on drop identity across the wire (matching a
     snapshot entry back to a local object) into also driving real gameplay
     logic. That's exactly the kind of fragile, implicit coupling worth catching
     before implementation, not after: a future change to the ID format for
     unrelated reasons (a different `dropSeq` scheme, say) would silently break
     pickup behavior with no type error to catch it. **Fixed by adding an
     explicit `source?: "disconnect"` field** to both `LootDropSnapshot` (§3's
     payload shape, updated above) and the local, runtime `LootDrop` type itself
     (`map/types.ts` — today's single-player interface has no such field; it
     gains one, optional, `undefined` for every existing single-player drop
     source, so no existing code path changes). The collision/pickup-check code
     that runs every tick against the local `this.lootDrops` array branches on
     `drop.source === "disconnect"` directly — a plain field check, not a string
     match against a value meant for something else. When a guest reconstructs a
     local `LootDrop` from a received `LootDropSnapshot` entry, `source` copies
     straight across unchanged; `id` remains purely an identity key and is never
     read for behavioral purposes anywhere.
   - **Tag over boolean, deliberately**: `source?: "disconnect"` rather than
     `isPersistent: boolean` (the doc comment's own second suggested shape) — a
     named tag self-documents *why* the drop behaves differently at the point
     `drop.source === "disconnect"` is read, where a bare `isPersistent` would
     require a reader to already know the one reason a drop is ever persistent
     today. It also costs nothing to extend later if a second kind of drop ever
     needs equivalent treatment for a different reason (e.g. the "ordinary
     multiplayer weapon drop" question raised just below), where a boolean would
     need a second, differently-named flag instead of one more tag value.
   - This question was originally deferred; with the N-player engine model now
     specified (`multiplayer-game-state-spec.md` §6, which owns loot-pickup
     interaction), it's **resolved: the no-op-if-already-owned rule applies to
     *every* weapon-kind drop in a multiplayer session, regardless of origin** —
     enemy-kill and secret-room weapon drops included. The "shouldn't be silently
     consumed by someone who doesn't need it" fairness logic is identical no
     matter what spawned the drop, and one uniform rule keyed on
     (multiplayer session ∧ `kind === "weapon"`) is simpler to implement, test,
     and explain to players than two behaviors keyed by drop origin.
     Single-player is untouched: `grantOrTopUpWeapon`'s already-owned-→-ammo
     top-up stays exactly as it is there, where it remains the right call (one
     player, so a same-weapon drop genuinely is just excess ammo). Note this
     makes the `source` field identity/diagnostic rather than the behavior key
     for pickups — it still drives the `disconnect:` ID namespace and remains
     the honest record of where a drop came from, but pickup logic branches on
     session mode + kind, not on `source`.
   - Every entry from one disconnect is identified as `` `disconnect:${playerId}:${dropSeq}` ``
     (`dropSeq` 0, 1, 2, ... in a fixed, independently-computable order — ammo
     pools first in `bullets`/`rockets`/`smg`/`gas` order, then unlocked weapons in
     `WEAPONS`-index order) — the same shape as, but a distinct namespace from,
     the `` `${enemyIndex}:${dropSeq}` `` scheme this document's own §3 already
     defines for enemy-sourced drops, extended here since a single disconnect can
     now drop more than one item, unlike the original ammo-only version of this
     rule.
   - **Held dependency keys drop too — resolved, no longer an open question**
     (an earlier revision deferred this to the per-player inventory design; that
     design now exists as `multiplayer-game-state-spec.md` §6, so deferring is no
     longer honest). The reason this can't be left vague: keys are **level-scoped**
     (`EngineCarryover` doesn't carry them across levels) and `placeKeys`
     generates exactly **one key per door** — a removed player's held keys
     vanishing with them can permanently lock a door, potentially on the team's
     only route forward: a real soft-lock, not an inventory nicety. Rule: one
     `kind: "key"` `LootDrop` per held key, appended after the weapon entries in
     the `dropSeq` ordering (ammo pools, then weapons, then keys); walking over
     one grants the collector `keysHeld + 1`. `"key"` is a new `LootKind` value —
     multiplayer-only in practice (nothing in single-player ever creates one),
     but an ordinary drop kind mechanically, riding the same pickup and
     reconciliation paths as everything else.
   - **Deliberately still excludes health/swap**: no precedent in the existing
     single-player design for handing health from one entity to another (unlike
     ammo, weapons, and now keys, which are all ordinary `LootDrop` kinds), and
     inventing one here would be scope creep this document doesn't need to
     resolve.
   - **These drops must be visible on the minimap/automap, not just discoverable
     by walking into them.** A player has no in-fiction reason to know a
     teammate disconnected three rooms away, let alone that it left something
     worth backtracking for — without a map marker, this whole mechanism is
     invisible in practice. This is a client-side rendering gap, not a netcode
     one (every peer already has the real `LootDrop[]` data locally), so it's
     specified in full in
     [`multiplayer-game-state-spec.md`](multiplayer-game-state-spec.md#5-loot-drop-visibility-on-minimap-and-automap)
     rather than here.
4. **Score is preserved, not erased**: their `ScoreBreakdown` as of the moment of
   disconnect stays in the end-of-run comparison table, labeled disconnected —
   simpler than trying to erase or partially-refund it, and gives the remaining
   players closure on what happened rather than a player just vanishing from the
   results entirely.
5. **Elite scaling (`multiplayer-game-state-spec.md`'s player-count multiplier) is
   *not* recomputed when a player leaves mid-level.** It was fixed once, at level
   start, from the player count at that moment, and stays fixed for the rest of
   that level — deliberately mirroring an existing precedent in this codebase:
   difficulty and gore settings changed mid-campaign already only "take effect on
   the next level load" (`replay.ts`'s own `ReplayLevelSegment` doc comment), never
   retroactively mid-level. A departing player not retroactively softening a fight
   already in progress is the same rule applied to a new axis, not a new one.
6. **Reconnection after removal, and late-joining, are the same restriction** —
   see above. Once the grace period elapses and removal happens, that player (or
   anyone else) cannot re-enter that specific level's session; the next level (or a
   fresh session) is the earliest they can play again.

### Host disconnect: the session ends

The rules above cover a *guest* dropping. This spec's first pass never said what
happens when the **host** drops — a real omission, since the host is not just
another player: it's the tick sequencer (mechanism 1), the reconciliation
authority (mechanism 3), and every guest's only connection (star topology).

**Rule: if the host's connection is lost, the session is over for everyone.** No
host migration in v1 — migrating authority to a surviving guest would require a
full authoritative-state handoff, a new tick sequencer election, and fresh
signaling between guests who deliberately have no connections to each other; that
is a large, separate feature, explicitly out of scope, not a small fallback to
sneak in. Concretely, on each guest:

- Detection uses the same transport-layer signal as guest disconnects
  (`RTCPeerConnection.connectionState` reaching `disconnected`/`failed`), with the
  same `DISCONNECT_GRACE_MS` grace period for transient recovery — during which
  the guest's simulation simply stops receiving bundles and therefore stops
  advancing (nothing to fabricate: without the sequencer there is no next tick).
- If the grace period elapses: show a plain "host disconnected — session ended"
  state, present the end-of-run comparison table from each player's
  `ScoreBreakdown` as of the last fully-applied tick — **using the guest's own
  local values, honestly labeled as provisional**: without the host there is no
  authoritative score source (§3's `killScore`/`kills` reconciliation and §7's
  level-end table both come *from* the host), and local accumulators can carry
  small uncorrected drift. An earlier revision claimed these values were
  "identical by lockstep construction" — wrong, for the same reason
  reconciliation exists at all; corrected in review rather than shipped as a
  quiet false promise. Then return to the pre-session menu.
- Nothing needs doing on the signaling server: the host's lobby/mailbox entry
  simply expires via its own TTL (§ `multiplayer-server-spec.md`), since the host
  is no longer around to refresh it.

## 6. What the shared simulation's input source must never allow through

Two distinct gaps, both critical, both share the same underlying shape: a *local*
signal that today mutates simulation state (or halts the sim outright) directly,
with no concept of "this is a shared session other peers are also relying on."
Both need to be neutralized at the same layer — the `InputSource` a networked
session feeds into `advance()` — not by adding multiplayer-aware branching inside
the engine's pause/cheat handling. (The engine *is* refactored for multiplayer —
the N-player model in `multiplayer-game-state-spec.md` §6 — but that refactor is
about per-player state, not about the engine learning to second-guess its input;
these two suppressions stay in the input layer precisely so it never has to.)

### Pause/blur/lore-freeze must never halt the tick loop

Confirmed directly in `engine.ts`'s `advance()`: an Escape press, a window
`blur`, or a pointer-lock release sets `this.isPaused = true`, and the very next
statement is `if (this.isPaused) { this.notifyFrozen(true); this.renderPausedOverlay();
return; }` — a **hard early return**. No movement, no enemy AI, no damage, nothing
in that tick at all. Reading a lore terminal (`this.loreText !== null`) has the
*exact same shape* — its own early return, before any of the movement/combat code
later in the function ever runs — despite the automap toggle right next to it
explicitly being documented as non-blocking ("sim keeps running... while it's
shown"). This is the same critical flaw for both, not one flaw and one unrelated
cousin of it: a **Guest** doing either instantly stops advancing while every other
peer's simulation keeps going, and a **Host** doing either — since the host is also
the tick sequencer (mechanism 1) — stops producing new `TickInputBundle`s
entirely, freezing the session for *everyone*, not just themselves.

**Fix**: neither `isPaused` nor the lore-terminal freeze may ever cause a
multiplayer session's `advance()` call to skip simulating, for host or guest,
without exception. The correct point to enforce this is upstream of `advance()`
entirely: whatever assembles the local `InputSnapshot` for inclusion in a tick's
shared bundle (the `NetworkInputSource` `multiplayer-research.md` already named as
the natural shape for this) forces `escape`, `blur`, `pointerUnlock`, and `click`
to their neutral/false values before that snapshot ever gets sent or locally
applied — the same "strip it before it reaches the shared stream" principle
mechanism 2 already uses for input-delay, just applied to different fields.
`advance()` itself needs no new multiplayer-aware branching: it already can't
distinguish "the real player didn't press Escape this tick" from "a multiplayer
session suppressed it," because those two things produce an identical
`InputSnapshot`.

- **The local player may still see a local UI reaction to their own real Escape
  keypress** (e.g. a "Leave Session?" prompt) — that's a `main.ts`-level DOM
  concern, entirely outside `InputSnapshot`, and doesn't need suppressing. What
  must never happen is that keypress's effect reaching the *shared* stream as a
  pause/freeze signal.
- **Alt-tabbing (or reading a lore terminal) mid-fight in multiplayer leaves your
  character exposed** — accepted plainly as the correct behavior, not a gap to
  soften. Every real multiplayer game already works this way; the alternative
  (your character becoming briefly invincible, or the *whole session* freezing,
  because you looked away) is categorically worse.
- Lore-terminal *reading itself* stays a purely local, cosmetic overlay — only
  the "freeze the sim while it's open" half of that branch goes away for
  multiplayer. But **the overlay's controls must change too, not just its
  freeze** — a review correction to this bullet's first pass, which glossed over
  a real conflict: today's overlay repurposes W/S for text scrolling *because*
  movement is frozen while it's open. With the sim unfrozen, those same W/S
  presses ride the `TickInputBundle` and every peer's simulation keeps applying
  them as movement — the reading player would literally walk away (possibly into
  acid) while "scrolling." And no sim-relevant key can do double duty, because
  lockstep requires every peer to interpret a given input identically — there's
  no way for "W means scroll for the reader but movement for everyone else's
  copy of them" to work. The multiplayer overlay is therefore **static and
  dismiss-only, dismissed by Escape alone** — a signal this section already
  strips from the shared stream, so dismissal is invisible to the simulation
  *by construction*. Click was considered as a second dismiss trigger and
  rejected on a verified detail: the `click` flag is stripped from the shared
  stream, but a physical mousedown *also* sets `fireQueued`
  (`input.ts`'s `onMouseDown`), which is a real sim input that rides the
  bundle — click-to-dismiss would fire the reader's weapon in everyone's
  simulation as a side effect.

### Cheat codes are disabled in multiplayer

Confirmed directly: `IDDQD`/`IDCLIP`/`IDKFA` (`engine.ts`'s `applyCheat`, matched
via `InputController.consumeCheat()`, `input.ts`) mutate `this.godMode`/
`this.player.noClip`/`this.ownedWeapons`/`this.ammo`/`this.swap` directly, on
whichever engine instance's `advance()` call detects the code. In a lockstep
session where every peer runs a full engine instance, a Guest typing `IDDQD` only
mutates *that Guest's own local copy* — outside the shared, synced state entirely
— which the next `ReconciliationSnapshot` (authoritative from the Host) simply
overwrites away, since god-mode/no-clip/ammo aren't fields any snapshot is meant
to preserve as "a legitimate local override." Even setting aside reconciliation
undoing it: a Host who typed one of these would have it *stick* (the Host's state
*is* authoritative), which is a real fairness/integrity gap of its own — cheats
must be disabled uniformly regardless of role, not just rendered pointless for
Guests specifically.

**This is easier to fix than it might look, because the codebase already has the
exact needed precedent**: cheat state is deliberately *not* part of
`InputSnapshot` at all (confirmed — `input.ts`'s `InputSnapshot` interface has no
cheat-related field whatsoever) — `consumeCheat(): string | null` is instead its
own separate method on the `InputSource` interface, read directly by `advance()`,
entirely outside the recorded/replayed snapshot shape. `replay.ts`'s own
`ReplayPlaybackInput` — the existing playback-time `InputSource` implementation —
already makes this method a **permanent no-op** (`consumeCheat(): string | null {
return null; }`), for exactly the same underlying reason this document's whole
premise rests on: a mode where "every peer must derive the same result from the
same recorded/shared input" cannot tolerate an input path that mutates state
outside that stream.

**Fix**: the multiplayer `NetworkInputSource` makes `consumeCheat()` a permanent
no-op too, identically to `ReplayPlaybackInput`'s own existing implementation —
not a new pattern, the same one already proven for the same reason, applied to a
second `InputSource` implementation. `applyCheat()` itself needs zero changes; it
simply becomes unreachable during a multiplayer session, since nothing ever calls
it with a non-null code. Applies uniformly to the Host's own local engine instance
too — no role-based exception.

- **Optional, not required**: detecting the typed sequence anyway purely to show a
  "cheats are disabled in multiplayer" toast (reusing the existing
  `showCheatToast` mechanism cosmetically, without ever calling `applyCheat`) is a
  reasonable UX nicety. Not specifying it as a requirement — silently having no
  effect is a complete, correct fix on its own; the toast is polish.

## 7. Level transitions

Flagged as ordinary feature work in `multiplayer-research.md` ("when one player
enters the return tile, all players advance to the next level (after an
informational countdown)"), but no spec ever defined the actual mechanism — this
section closes that gap.

1. **Exit touch is a shared simulation event, not a message.** Any player's
   collision with the exit tile happens identically on every peer at the same tick
   (lockstep) — no "player X reached the exit" packet exists or is needed. What it
   triggers changes for multiplayer: instead of single-player's immediate
   `onWin`/level-end, it starts the **countdown** — a plain tick counter,
   `COUNTDOWN_TICKS` (e.g. 5 seconds' worth; tunable, see below), decremented by
   every peer's own simulation in lockstep, with an informational overlay
   ("Build finishing in N…") rendered locally by each peer. The simulation keeps
   running normally during the countdown — players can keep fighting/looting;
   re-touching or leaving the exit tile doesn't cancel or restart it (simplest
   rule; a cancelable countdown is a design refinement, not a v1 need).
2. **At countdown expiry, the host drives the transition; guests wait for it.**
   The host: stops ticking level N, computes every player's `EngineCarryover`
   (per-player — each player carries *their own* health/ammo/weapons forward,
   exactly the existing single-player carryover shape, once per player), generates
   the next level's `GameMap` exactly as it generated the first (same
   GitHub/Demos-sourced pipeline, `maxPlayers` param per
   `multiplayer-game-state-spec.md` §2), picks a fresh `gameplaySeed`, and sends
   all of it — map, per-player carryovers, seed — to every guest over the
   `reconciliation` channel. The host's computed carryovers are authoritative by
   definition (they're derived from its own state, which reconciliation already
   makes canonical); a guest discards its own locally-computed equivalents.
3. **Tick numbering and the PRNG stream reset per level.** Each level is its own
   tick epoch starting at 0, with the shared `mulberry32` stream freshly seeded
   from the transition payload's `gameplaySeed` — deliberately mirroring the
   existing per-level structure the replay system already uses
   (`ReplayLevelSegment`: one seed, one frame sequence, per level). No cross-level
   PRNG or tick state to keep aligned.
4. **Guests acknowledge; the host starts ticking level N+1 when every connected
   guest has acked or `TRANSITION_ACK_TIMEOUT_MS` elapses** — a guest that never
   acks in time is handled by the existing disconnect path (§5), not a special
   case. Because both channels are reliable/ordered, a slow guest still applying
   level-N bundles when the transition payload arrives simply processes it in
   order after them — no interleaving hazard.
5. **Dead players revive at the transition** — per the coop death rule in
   [`multiplayer-game-state-spec.md` §6](multiplayer-game-state-spec.md#6-the-n-player-engine-model),
   which owns what state they revive with.

## 8. Replays and the highscore board stay single-player

Two existing systems would silently misbehave in a multiplayer session unless
explicitly switched off — verified against `main.ts`, which today wires both up
unconditionally per run:

- **Replay recording is disabled in multiplayer sessions.** `main.ts` constructs
  a `CampaignReplayRecorder` for every run; a replay records exactly *one*
  `InputSource`'s frames, and playback reconstructs the run from map + seed +
  that single input stream. A multiplayer session's outcome depends on N input
  streams *plus* reconciliation corrections — a recorded MP "replay" would play
  back as a desynced fiction from its first divergent tick, saved to
  `localStorage` as if it were real. A multiplayer session simply never
  constructs a recorder; all existing replay plumbing stays untouched for
  single-player.
- **Multiplayer runs don't write the local highscore board in v1.** The board's
  entries assume single-player comparability — one player's run, an attachable
  replay, difficulty as a personal setting, the codebase hash as a fairness
  key. A team-context score mixed into that list would compare
  apples-to-oranges with every existing entry, for no v1 benefit — the
  end-of-run comparison table (§7, game-state §3) is multiplayer's own
  scoreboard. An MP-specific board (or spectator replays) is a possible future
  feature, deliberately not designed here.

## Open tuning parameters (not final values)

Every constant named above (`TICK_RATE_HZ`, `INPUT_DELAY_TICKS`,
`RECONCILE_INTERVAL_TICKS`, `CORRECTION_SMOOTH_MS`, `SNAP_THRESHOLD_TILES`,
`DISCONNECT_GRACE_MS`, `COUNTDOWN_TICKS`, `TRANSITION_ACK_TIMEOUT_MS`) is a
reasonable starting point grounded in this document's
own reasoning, not a value this spec claims is correct — real tuning needs actual
multi-peer network conditions (real RTT distributions, real packet loss) to
validate against, which a specification pass can't produce. Treat them as the
initial values to build and test with, expect to revisit once real playtesting data
exists, same spirit as this project's existing balance-telemetry-driven tuning for
difficulty/loot (see `doc/dev/balancing-telemetry.md`) rather than a one-shot
decision. `RECONCILE_INTERVAL_TICKS` specifically now has a second pressure on it
beyond bandwidth, worth weighing together rather than separately once real data
exists: it's also the upper bound on how long a PRNG-stream desync (§3) can persist
before being corrected.

## Testing & verification

Nothing in this spec is verified by inspection alone — every mechanism above has
a real, end-to-end Playwright check behind it, run against a live signaling
server + dev server pair (never the developer's own dev server) and wired into
CI: `verify:multiplayer-connect` (the connect flow itself), `verify:multiplayer-netcode`
(§1/§2, lockstep tick agreement), `verify:multiplayer-reconciliation` (§3/§4,
forced-divergence correction), `verify:multiplayer-disconnect` (§5),
`verify:multiplayer-transition` (§7), and `verify:multiplayer-multiguest` (a
3-peer — host + 2 guests — smoke test covering the same ground at N>2, including
that one guest's disconnect never affects another's session). A separate
`verify:multiplayer-determinism` guards this spec's own core assumption — that
lockstep survives long enough for periodic reconciliation to actually catch a
real cross-engine float divergence — as a regression alarm, not a claim of
eternal bit-identical engines. See `doc/dev/testing.md`'s "Cross-browser
verification" section for the shared cross-browser caveats (confirmed
CI-only WebRTC/ICE limitations, timing lessons) all of these scripts inherit.
