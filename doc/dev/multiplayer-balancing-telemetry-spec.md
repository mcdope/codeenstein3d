# Multiplayer balancing & telemetry automation specification

**Status: specification only — nothing in this document is implemented.** No
file under `src/` or `scripts/` is modified by this document or by producing
it. It specifies a multiplayer mirror of the existing single-player bot-driven
telemetry/balancing toolchain (`scripts/run-balancing-telemetry.mjs` +
`npm run balancing:scan`, `scripts/run-balancing-campaign.mjs`, shared libs
`scripts/lib/bot.mjs`/`qualifyLoop.mjs`/`virtualClock.mjs`), used routinely as
a "did I break bot navigation/combat" regression gate before declaring
balance-affecting single-player changes done. Multiplayer has no equivalent
automation today.

This is the explicit revisit step 4's own notes flagged at the time:
multiplayer's telemetry was left single-instance/unscoped when the engine
became N-player-generic, "flagged, revisit if a later step needs them." This
document is that revisit — this is **step 11** of the multiplayer
implementation plan (`multiplayer-research.md`), following step 10's real
N-player (2-4) support.

## Goals / non-goals

**In scope**: full per-player telemetry parity with single-player's
7-category `getTelemetrySnapshot()` breakdown; driving 2-4 real
`MultiplayerBot` instances simultaneously in one live session (uniform and
mixed skill profiles); a repeatable sampling loop mirroring
`qualifyLoop.mjs`'s shape; gameplay-behavior anomaly detection (stall/frozen-
health-drain/rotation, already free via the shared `Bot` class) plus new
cross-peer detectors (tick-skew growth, disconnect isolation); and — added
per explicit request — **network/netcode-quality telemetry**: ping/RTT,
missed (held-fallback) ticks, and reconciliation-correction frequency/
magnitude per player.

**Out of scope / explicitly deferred**: a `balancing:campaign`-equivalent
large-scale resumable multi-process orchestrator, and a `balancing:watch`-
equivalent headed real-time observation mode — both meaningfully more
expensive to design well given multiplayer's real-time-only cost model (see
§4), and not needed for the immediate "automate the regression check" goal.
Also out of scope: fixing the pre-existing, single-player-scoped
`recordHeal("pickupHealth"/"pickupSwap", …)` gap (§1's own "out of scope"
note) and deathmatch-specific telemetry (deathmatch itself doesn't exist yet).

## 1. Engine-side per-player telemetry

`src/engine/telemetry.ts` is already 100% N-player-generic in itself — every
exported function (`recordDamage`, `recordHeal`, `recordShot`, `recordKill`,
`recordEnemyBoltFired`/`Hit`, `recordEnemyMeleeAttack`, `recordMineTriggered`/
`Disarmed`, `recordKillForcedByMelee`, `recordRegularKillLootRoll`,
`recordLootRolled`, `recordLootCollected`, `updatePerFrame`,
`updateMinHealth`, `recordEnemyAggro`, `recordEnemyDeath`, plus
`createTelemetryState`/`enemyCategory`) is a pure function taking an explicit
`state: TelemetryState` first argument. Nothing in the file is a singleton or
implicitly scoped to "the" local player. The single-instance-ness is entirely
a property of how `engine.ts` *stores* it: one `private readonly telemetry?:
TelemetryState` instance field (`engine.ts:724`), created once in the
constructor, gated on `PLAYER_STATS_ENABLED || ?testHooks=1`.

### Concrete design

Move telemetry onto `PlayerState` itself — a new `readonly telemetry?:
TelemetryState` field, created in `createPlayerState(id, …)` under the same
gating as today. This is consistent with how every other per-player thing
(`kills`, `priorScore`, `priorPlayerStats`, `ownedWeapons`) already lives on
`PlayerState`, rather than introducing a separate `Map<PlayerId,
TelemetryState>` alongside `players`.

### Already per-player-attributable — close to mechanical re-tagging

`id`/`shooter`/`p` are already in scope at every one of these call sites,
just pointed at the one shared `this.telemetry` today:

| Call site | Category updated |
|---|---|
| `damage(playerId, amount, source)` (`engine.ts:3138`) | `damageBySource`, `fatalDamageSource` |
| `fire(shooter, weapon)` (`3489`) / `damageEnemy(…, shooter)` (`3590`) | `weaponTallies` (shotsFired/hits/kills), `healingBySource: "lifesteal"`, `killsForcedByMelee`, `regularKillLootRolls`/`Misses` |
| `destroyMine(mine, shooter)` (`3551`) | `minesDisarmed` |
| `collectLoot()`'s per-player loop (`2933`) + the `lootCtx.recordApplied` closure built once per player inside `createPlayerState` (`990`) | `lootCollectedDynamic`/`lootCollectedStatic` (closure just needs to close over `id`) |

### Genuinely new tracking work — not just re-tagging

- **`EnemyAiEvents`' callbacks need a target id.** `onAggro`/`onMeleeAttack`/
  `onRangedFire`/`onEnemyBoltHit` (`src/engine/enemyAi.ts:68-74`, emitted at
  lines 178/194/204) only ever receive `(enemy: Enemy)` — never the player
  being targeted, even though `updateEnemy()` already has `nearest.id` at
  every emit site. Making `enemyBoltsFired`/`enemyBoltsHit`/
  `enemyMeleeAttacks` per-player needs the `EnemyAiEvents` type signatures and
  both call sites changed, plus `engine.ts`'s three closures (`741-753`)
  updated to route by id.
- **The per-frame health/ammo-desperation update is hardcoded to the local
  player.** `updateMinHealth`/`updateTelemetryPerFrame` at `engine.ts:2118-
  2121` read `this.players.get(this.localPlayerId)!` directly, not looped —
  needs a real `for (const id of this.sortedPlayerIds())` loop over every
  player with telemetry enabled.
- **`peakAggroedCount`/`combatTimeSec` need a new per-enemy concept.** These
  count team-wide "how many enemies are aggroed right now" — `Enemy.aggroed`
  is a bare boolean with no concept of *which* player it's aggroed at. A
  genuine per-player "how many enemies are hunting me" metric needs new state
  on `Enemy`, not just id-tagging an existing event.

### Recommended default: what stays team-level

TTK windows, `minesTriggered`, and `lootRolled` stay **team-level** buckets
even after this refactor — an enemy killed by team effort, or a mine that
blasts everyone in range, has no single obvious "owner" once multiple
players are in range/contributing, and forcing an attribution here would
invent precision the underlying event doesn't have. **Kill credit**
(`weaponTallies.kills`, TTK) stays attributed to the literal finishing-blow
`shooter` only, matching `recordKill`'s current shape and the same
"kill/streak credit goes only to the finishing blow" precedent step 4 already
established for scoring — assist damage remains visible via each assisting
player's own `weaponTallies.hits`/`damageBySource`, without also
double-counting the kill itself.

### Adjacent bug this work fixes for free

`PlayerState.priorPlayerStats` (the per-run player-facing stats carried via
`captureCarryoverFor(id)`, `engine.ts:3812`) already looks per-player, and
`multiplayerSessionHost.ts`'s `onWinFromEngine` already loops it over the
whole roster (`for (const id of currentResult.roster)`) — but
`captureCarryoverFor` builds it via `buildPlayerFacingStats(this.telemetry,
…)`, the one shared instance. In a real multiplayer session with telemetry
enabled today, every player's `priorPlayerStats` would silently show the
*team's* combined shots/hits/damage-taken/loot, not their own (`kills` is the
only field genuinely already per-player, via `p.kills`). Dormant only because
`PLAYER_STATS_ENABLED = false` by default — becomes a real, visible bug the
moment telemetry moves to `PlayerState` and someone re-enables it, so the fix
falls out of this work for free.

### Outward hook

New `RaycasterEngine.getMultiplayerTelemetrySnapshot(id: PlayerId)`, following
`getBotPlayerState(id)`'s exact existing pattern (`this.players.get(id)`,
`null` if absent) — builds the same flat object `getTelemetrySnapshot()`
already builds, reading `p.telemetry` instead of `this.telemetry`. Wire it
into `main.ts`'s `__codeensteinMultiplayerTestHooks` alongside the other
id-forwarding hooks (`getPlayerPosition(id)`, `getBotPlayerState(id)`, etc.).
`scripts/run-balancing-telemetry.mjs`'s existing `aggregateLevelRuntime()`
(the 7-category report builder) should be directly reusable against this
new hook's output with minimal adaptation, since it already reads a flat
snapshot object by field name, not by walking engine internals itself.

### Out of scope, flagged but not addressed

`HealSource`'s `"pickupHealth"`/`"pickupSwap"` variants exist in the type and
are read by `run-balancing-telemetry.mjs`'s `HEAL_SOURCES`, but no call site
ever actually calls `recordHeal` with either (health/swap pickups mutate
`p.health`/`p.swap` directly, bypassing `recordHeal`) — a pre-existing,
single-player-scoped gap, unrelated to multiplayer per-player scoping. Worth
a separate decision whenever it's touched, not part of this spec.

## 2. Shared multiplayer session bootstrap library

Extract `verify-multiplayer-multiguest.mjs`'s connect/join/start sequence
(`makeEligible`, host picks `maxPlayers` + creates, guests auto-join
sequentially via `armNextGuestSlot`'s own re-arm with a retry loop, host
clicks Start, wait for all peers to reach a target tick) into a new
`scripts/lib/multiplayerSessionBootstrap.mjs` — generalized from that
script's own fixed host/guest-1/guest-2 shape to arbitrary N (2-4), so both
this new tool and future verify scripts can share it instead of each
duplicating the sequence.

## 3. Driving N bots at once in one session

`MultiplayerBot` (`scripts/lib/multiplayerBot.mjs`) has only ever been
instantiated **once** per script (the host, in `verify-multiplayer-
transition.mjs`) — every other player in every existing script is either idle
or just holds a movement key. This tool needs N simultaneous instances, one
per roster member, each its own `page`/`playerId`/skill profile, each
computing its own BFS route from its own spawn (reusing existing
`routePlanner`/`staticLevelAnalysis`, already engine-agnostic), all ticking
independently within the same live session.

Bot-skill configuration must support **both**: a uniform profile applied to
every bot in a run (mirrors single-player's per-combo uniformity), and a
curated set of named mixed-skill scenarios (e.g. one-tier-apart pairs for 2p,
a "weakest + strongest + filler" shape for 3-4p) — not a blind cartesian
product of profiles across up to 4 slots, which explodes combinatorially for
no real signal gain.

## 4. Combo matrix & sampling loop

Reuse `scripts/lib/qualifyLoop.mjs`'s `runQualifyLoop()` as-is (already fully
generic — caller supplies `runAttempt`/`isQualifying`). Combo dimensions:
profile-configuration (uniform × 3, plus the curated mixed set) × difficulty
× playerCount (2-4) — sized deliberately smaller than a full cartesian
product for the reasons in §3.

**No virtual clock is possible.** `scripts/lib/virtualClock.mjs` cannot
fast-forward a real Web-Worker-timer-paced multiplayer simulation
(`multiplayerBot.mjs`'s own doc comment already states this: multiplayer is
always real-time). This is the single biggest structural difference from
single-player: every sample costs real wall-clock time, so default
concurrency must be modest and clearly documented as such, not copy
single-player's cheap 6-12-way concurrency.

## 5. Anomaly detection

The existing `Bot` stall/`healthDrainFrozen`/`heldKeyNoMovement`/rotation
detectors (`scripts/lib/bot.mjs`) already work for `MultiplayerBot` for free,
since they operate on the shared, un-overridden trace machinery — they just
need `logger: { trace: true, navDiag: true }` passed through, which no
existing multiplayer script currently does.

New cross-peer detectors to design and build (no reusable equivalent exists
today): a **tick-skew-growth-over-time** check (today
`verify-multiplayer-multiguest.mjs`'s `sampleTickSkewMs` is a one-shot,
explicitly informational-only sample with no threshold or trend), and a
**disconnect-isolation** metric as a repeatable, scored scenario (today only
ad hoc pass/fail assertions inline in verify scripts, not a reusable detector
function).

## 6. Network/netcode-quality telemetry (lag, ping, missed/corrected ticks)

Distinct from gameplay-behavior anomaly detection above — this is about the
*transport and lockstep mechanics themselves*, per player/link, aggregated
into the report the same way single-player's telemetry aggregates
combat/economy stats. Real signals already exist on the wire or are one real
API call away; none of this needs new instrumentation invented from scratch.

- **Ping/RTT** — not currently measured anywhere in this codebase. The
  standard, already-available source is `RTCPeerConnection.getStats()`'s
  active candidate-pair report (`currentRoundTripTime`) — real, per real
  connection, no new wire protocol needed. New plumbing: a
  `getConnectionStats(id)`-shaped method (host: per-guest, reading
  `link.peerConnection.getStats()`; guest: its one link toward the host),
  added to `MultiplayerSessionHandle`/`__codeensteinMultiplayerTestHooks`
  alongside the existing id-forwarding hooks — sampled periodically during a
  run, reported as min/mean/max per player (the same `spread()`-wrapper
  convention single-player telemetry already uses for judgment-call metrics,
  not a bare average).
- **Missed ticks (held-input fallback)** — already a real, currently-unused-
  for-reporting signal: `TickInputBundle.heldInputFallback: PlayerId[]`
  (`src/multiplayer/netcodeTypes.ts`) is broadcast by the host every tick,
  populated by `InputDelayBuffer.finalize()` whenever a player's real input
  for that tick hadn't arrived in time. Today this is read only as a
  bootstrap-transient signal in unit tests — a telemetry run should tally it
  per player over the whole run (count and %-of-ticks), a direct, real "how
  often was this player's real input late" measurement — no new engine work
  needed, only sampling/aggregation in the new script.
- **Reconciliation corrections** — frequency and magnitude of drift
  corrections per player over a run: `hasActiveRenderOffset(id)` (smoothed,
  below-threshold corrections) plus a count of at/above-threshold instant
  snaps (today only exercised as a one-shot pass/fail check in
  `verify-multiplayer-reconciliation.mjs`, via the test-only
  `debugInjectDesync` hook — for *real* sessions there's currently no running
  tally of how often genuine drift corrections actually fire). New plumbing:
  a per-player correction counter/last-magnitude value, exposed the same way
  `getLastReconciliationRngState()` already is.
- **Tick skew** (also relevant to §5) belongs conceptually in this same
  network-quality bucket for reporting purposes — present ping/missed-ticks/
  corrections/tick-skew together as one "netcode health" report section per
  player, not scattered across unrelated categories.

Every one of these lands in the new script's aggregate JSON output (§8) as
its own top-level category, mirroring single-player's 7-category shape, e.g.:

```jsonc
"netcodeHealth": {
  "host":    { "rttMs": { "mean": 4, "max": 11, "samples": 30 }, "missedTickPct": 0.3, "correctionsPerMin": 1.2, "tickSkewMs": { "mean": 0, "max": 33 } },
  "guest-1": { "rttMs": { "mean": 6, "max": 14, "samples": 30 }, "missedTickPct": 0.5, "correctionsPerMin": 0.8, "tickSkewMs": { "mean": 12, "max": 67 } }
}
```

## 7. Dedicated signaling server + rate-limit safety

The signaling server's rate limits are per-IP, not per-session (20
requests/60s on guess-sensitive endpoints, 30/min on `PUT /session`,
host-token traffic exempt but still capped at 120/min —
`multiplayer-server-spec.md` §4). Running many concurrent multiplayer
sessions from one test machine against one signaling server instance risks
tripping these budgets, especially once N-guest auto-join retries are
multiplied across concurrent sessions.

This tool should spin up its **own dedicated local signaling server
instance** (cheap — a dependency-free single script,
`scripts/multiplayer-server.mjs`, with every limit already
env-var-overridable) rather than share whatever signaling server a
developer's own dev session happens to be pointed at.

## 8. New scripts & npm entries

- `scripts/run-balancing-telemetry-multiplayer.mjs` — the main script,
  mirroring `run-balancing-telemetry.mjs`'s overall structure and output
  shape as closely as the constraints above sensibly allow.
- `npm run balancing:telemetry-multiplayer`
- `npm run balancing:scan-multiplayer` — a fast/cheap env-preset invocation
  of the same script, mirroring `balancing:scan`'s role as a pre-merge
  regression gate ("run before declaring multiplayer bot navigation/combat
  fixed").
- Deferred (see Goals/non-goals): `balancing:campaign-multiplayer`,
  `balancing:watch-multiplayer`.

## 9. Docs

Extend `doc/dev/balancing-telemetry.md` with a new section covering the
multiplayer variant: env vars, the combo-matrix shape, the `netcodeHealth`
report category (§6), and what's structurally different from single-player
(no virtual clock → real-time cost, the signaling-server rate-limit caveat,
per-session bootstrap cost) so a future reader doesn't assume single-player's
cost/concurrency assumptions carry over.

## Verification (once implemented)

- `npm run typecheck` clean; unit tests for any new engine-side per-player
  telemetry code, at 100% coverage (this project's standing bar).
- `balancing:scan-multiplayer` run locally against a real, isolated dev +
  dedicated signaling server pair before being trusted as a regression gate.
- Confirm single-player's own `getTelemetrySnapshot()`/`balancing:scan`
  behavior is provably unaffected — the multiplayer extension is additive,
  the same "N=1 is a case of the general shape" discipline already proven at
  every other engine-layer extension point in this project (spawns, elite
  scaling, reconciliation).
