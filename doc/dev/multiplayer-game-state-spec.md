# Multiplayer game-state adaptation plan

**Status: analysis and plan only — no file under `src/` is modified by this
document.** Covers the four areas `multiplayer-research.md` flagged as ordinary
feature work with existing extension points — UI gating, multi-spawn generation,
per-player scoring/assists, player-count elite scaling — plus loot-drop map
visibility (§5) and, most substantially, **the N-player engine model itself (§6)**:
the design for how one `RaycasterEngine` instance simulates every connected
player, which review identified as the largest unspecified prerequisite for the
whole initiative. Cross-references:
[`multiplayer-research.md`](../../multiplayer-research.md) (the governing decisions)
and [`multiplayer-netcode-spec.md`](multiplayer-netcode-spec.md) (the per-peer,
full-engine-instance lockstep model this plan assumes — §6 here is what makes that
model actually implementable).

## 1. UI gating

### The actual condition, precisely

Confirmed directly in `main.ts`: `workspaceIsRemote` is set `true` for **both** a
GitHub load (line 622) and the Demos campaign (line 697) — the Demos path sets
`workspaceIsDemo = true` *alongside* `workspaceIsRemote = true`, never on its own.
A local pick (and `Continue Run`) sets both `false` (lines 570–571, 753–754). So
`workspaceIsDemo` implies `workspaceIsRemote` in every code path that exists today —
checking `workspaceIsRemote` alone is already functionally equivalent to checking
"GitHub or Demos," which is the eligibility this needs.

**Recommendation**: don't rely on that implication going forward, silently correct
as it is today. Extract a named helper —

```ts
/** Multiplayer hosting/joining is only available for a GitHub-loaded repo or the
 * Demos campaign — never a locally-picked workspace (see
 * multiplayer-research.md's "Privacy: resolved"). `workspaceIsDemo` always implies
 * `workspaceIsRemote` in every load path today, but this checks both explicitly
 * rather than depending on that implication silently holding forever. */
function isMultiplayerEligibleWorkspace(): boolean {
  return workspaceIsRemote || workspaceIsDemo;
}
```

— so the eligibility condition is a named, intentional check, not an incidental
consequence of how two unrelated flags happen to be wired today. Every site below
calls this helper rather than re-deriving the condition inline.

### Where the UI itself lives, and how it's already hidden today

`index.html`'s sidebar (`#sidebar`) already has the exact pattern to mirror: the
`Continue` workspace tab (`#tab-continue`) ships with inline `style="display: none"`
in the markup and is shown/hidden purely via `tabContinue.style.display = "" | "none"`
in `main.ts` (confirmed: line 553 on load, line 1847 on reset) — **not** the `hidden`
attribute. This matters specifically because of a documented past bug class in this
project: a CSS class that sets `display` on an element *also* toggled via the
`hidden` attribute needs an explicit `[hidden]` override or the class silently wins.
Following the existing `tabContinue.style.display` pattern for a new multiplayer
entry point sidesteps that whole class of bug by construction — no new CSS rule is
needed at all, so there's nothing for a stylesheet class to conflict with.

**Plan**:
1. Add a `#tab-multiplayer` sidebar entry (or a `#multiplayer-panel` section,
   depending on final UX — either way, same visibility mechanism) styled/wired
   identically to `#tab-continue`: ships `style="display: none"` in `index.html`,
   toggled by a new `setMultiplayerUiVisible(eligible: boolean)` helper in `main.ts`.
2. Call `setMultiplayerUiVisible(isMultiplayerEligibleWorkspace())` at **every** site
   that currently assigns `workspaceIsRemote`/`workspaceIsDemo` — confirmed exact
   locations: the local-pick reset (~570–571), the GitHub load (~622–623), the Demos
   load (~697–698), and the `Continue Run` reset (~753–754). This is the same set of
   call sites `tabContinue.style.display` itself is driven from — no new lifecycle
   hook needed, just one more line at each existing one.
3. **Defense in depth, not just a hidden button**: hiding the entry point prevents a
   normal user from stumbling into hosting a local workspace, but the actual
   session-creation code path (wherever it ends up calling
   `PUT /session` on the signaling server, per `multiplayer-server-spec.md`) should
   *also* assert `isMultiplayerEligibleWorkspace()` before proceeding, independent of
   whether the UI is visible — the UI gate is a UX nicety; the guard at the point
   where a `GameMap` would actually leave the machine is the real privacy boundary
   `multiplayer-research.md` cares about. Never trust "the button was hidden" as the
   only enforcement.

## 2. Multi-spawn generation

### New function, not a modification

`src/map/generation/spawnExit.ts` today: `pickSafeSpawn(rooms)` returns **one**
`Point` — the corner of `rooms[0]` farthest from every enemy-bearing room's *center*
(a safety objective). `pickExit(rooms, spawn)` returns the center of whichever
room's center is farthest from `spawn`. Neither function reads from the seeded
`rng` — both are pure geometry over already-placed room positions. That's directly
relevant: **a new function that also never touches `rng` cannot perturb the existing
deterministic draw sequence no matter where in `generate()` it's called** — the
`architecture.md` warning about reordering rng-consuming calls simply doesn't apply
here, since there's nothing to reorder relative to.

```ts
/** Deterministic multiplayer spawn selection: greedily picks up to `count`
 * room centers, each one maximizing its minimum distance to the exit and every
 * spawn already chosen — spreads players across the level rather than
 * clustering them. Pure geometry over already-placed rooms, like
 * `pickSafeSpawn`/`pickExit` — draws nothing from `rng`, so calling it changes
 * nothing about single-player's existing deterministic layout regardless of
 * where in `generate()` it's invoked. Never modifies, or is called by,
 * `pickSafeSpawn` — the two serve different objectives (safety-from-enemies vs.
 * spread-from-exit-and-each-other) and single-player's spawn/behavior must not
 * shift as a side effect of adding this. */
export function pickMultiplayerSpawns(rooms: Room[], exit: Point, count: number): Point[] {
  if (rooms.length === 0) return [{ x: exit.x, y: exit.y }]; // mirrors pickExit's own empty-rooms fallback; expected unreachable in practice, same as that fallback
  // The exit's own room is excluded outright: pickExit returns exactly some
  // room's center, so without this filter a large-enough player count would
  // eventually assign a spawn ON the exit tile itself — under the multiplayer
  // level-advance rule (netcode spec §7, "exit touch is a shared simulation
  // event") that player would trigger the next-level countdown at tick 0.
  const pool = rooms.map((r) => r.center).filter((c) => !(c.x === exit.x && c.y === exit.y));
  const chosen: Point[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let j = 0; j < pool.length; j++) {
      const c = pool[j];
      let minDist = dist(c.x + 0.5, c.y + 0.5, exit.x + 0.5, exit.y + 0.5);
      for (const s of chosen) minDist = Math.min(minDist, dist(c.x + 0.5, c.y + 0.5, s.x + 0.5, s.y + 0.5));
      if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = j; }
    }
    chosen.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return chosen; // may be shorter than `count` if rooms.length < count — see below
}
```

Reuses `dist()` from `./util`, same helper `pickSafeSpawn`/`pickExit` already
import — no new geometry utility needed. Room **centers** only (not corners): with
`count` bounded by a real player cap and `mapSize` already scaling with entity
count, a real codebase almost always has far more rooms than needed spawn slots, so
centers alone give plenty of spread without the extra complexity of scoring 4
corners per room too. Worth revisiting only if playtesting shows otherwise — not
worth the complexity pre-emptively.

### Spawn-on-enemy collision — a flaw caught in review, not in the first pass

Room centers are **also exactly where enemies spawn**: `enemyPositions`
(`generation/enemies.ts`) anchors every pack's *first member* at the room center
("the first at the room center, the rest scattered randomly"), and `pickSafeSpawn`'s
whole reason for picking a *corner* of room 0 is precisely that centers are
enemy-occupied. As first specced, players 2..N would spawn literally on top of a
pack's anchor enemy in any `function`/`method` room the greedy selection picks.
The first pass covered pillars (`avoidPoints`), floor (`clearCriticalTiles`), and
hazards (`fillHazards`) — and missed the enemies standing right there.

**Fix — mirror the exit-avoidance mechanism that already exists for exactly this
problem.** `enemyPositions(room, count, exit, rng)` already re-rolls any candidate
landing on the exit tile (`onExit` check: up to 8 re-rolls, then a corner
fallback) — because "an enemy must not sit on this special tile" is a problem the
generator already solved once, for the exit. Extend the same mechanism: thread
`multiplayerSpawns` into `spawnEnemies` → `enemyPositions` as an additional
avoid-list, checked by the same tile-coordinate comparison the `onExit` predicate
uses, triggering the same re-roll-then-corner-fallback path. Enemies move aside
for spawns (not vice versa) because spawn placement runs on pure geometry the
greedy dispersal depends on, while enemy placement is already random-with-re-rolls
by construction — the side that's already built to yield is the side that yields.

Two consequences to state precisely rather than discover later:

- **Generation order**: `multiplayerSpawns` must now be computed **before**
  `spawnEnemies` runs — in `generate()`, between `pickExit` and `spawnEnemies`
  (they're adjacent calls, so this is an insertion, not a reordering of anything
  existing). The "immediately after `exit` is known" hook description below is
  this same point.
- **RNG-draw neutrality holds for single-player, and needs one sentence of
  honesty for multiplayer**: a re-roll consumes `rng()` draws, so an avoid-list
  hit changes the draw sequence from that point on. For single-player generations
  the avoid list is empty, no re-roll can trigger, and the sequence is
  byte-identical to today — the §2 guarantee stands. For *multiplayer*
  generations the layout may differ from the single-player map of the same file —
  which is fine by construction: the host generates the map once and *sends* it
  (peers never independently re-generate it), and multiplayer runs record no
  replays, so nothing anywhere depends on multiplayer and single-player
  generations of the same source being identical.

**Fewer eligible rooms than requested spawns** (a tiny map, or a large lobby): the
function returns however many it could place rather than padding with duplicates —
and the session handles the shortfall at *assignment* time, not generation time.
An earlier revision left this open as a join-flow decision; that can't actually
work — a campaign spans many levels, and a *later* level can have fewer rooms than
the already-joined player count no matter what any join cap enforced up front, so
the mid-campaign case has to be handled regardless. **Rule: spawn assignment
wraps** — players (in sorted-`playerId` order, the same canonical roster order the
N-player engine model in §6 uses everywhere) are assigned
`multiplayerSpawns[i % multiplayerSpawns.length]`, so a shortfall means two
players share a spawn point. This is made *literally* costless by §6's own
no-player-collision decision: players pass through each other, so co-located
spawning has no physical consequence at all — a resolution that would have needed
real design work under player collision becomes a one-line modulo without it.

### `GameMap` shape and where this hooks into `generate()`

Add an optional field to `GameMap` (`src/map/types.ts`) — optional so every existing
single-player call site and every existing test/fixture stays valid untouched:

```ts
/** Spread spawn points for a multiplayer session, one per potential player slot
 * — undefined for a normal single-player generation call. Never used by
 * single-player code; `spawn` above remains the one true single-player spawn,
 * computed exactly as before. See `pickMultiplayerSpawns` (generation/spawnExit.ts). */
multiplayerSpawns?: Point[];
```

In `MapGenerator.generate()` (`mapGenerator.ts`): the single-player `spawn`/`exit`
computation at lines ~127–130 is **completely unchanged**. Immediately after `exit`
is known, optionally compute the extra field:

```ts
const multiplayerSpawns = maxPlayers > 1 ? pickMultiplayerSpawns(rooms, exit, maxPlayers) : undefined;
```

behind a new `maxPlayers = 1` parameter on `generate()` (default preserves every
existing call site's behavior exactly — `multiplayerSpawns` simply comes back
`undefined`, same as today).

**Real integration work this creates, called out explicitly rather than left
implicit** — every downstream system that currently only knows about the *one*
`spawn` point needs to also consider `multiplayerSpawns` when it's present, or a
multiplayer session's extra spawns can end up inside a wall, under a pillar, or
inside a hazard pool:

- **`clearCriticalTiles(grid, spawn, exit, enemies)`** (`generation/geometry.ts`) —
  currently guarantees the single `spawn`, `exit`, and every enemy stand on open
  floor even inside a labyrinth. Needs a new parameter (or a second call per extra
  spawn) so every multiplayer spawn point gets the same floor-clearing guarantee.
- **`avoidPoints`** (`mapGenerator.ts`, feeds `placePillars`/`placeDecorations`) —
  currently `[spawn, exit, ...enemies]`. Needs every entry in `multiplayerSpawns`
  added, or a structural pillar/decoration could land directly on a secondary
  spawn point.
- **`fillHazards(rooms, grid, spawn, exit)`** (`generation/trapsHazards.ts`) — audit
  resolved by reading the real implementation, not deferred. It turns every
  `"global"`-entity room into an acid pool by flooding its interior (leaving a
  1-tile walkable rim), and protects `spawn`/`exit` through **two different
  mechanisms that need two different fixes**:
  - **Room-level**: `rooms.forEach((room, index) => { if (room.entity.kind !==
    "global") return; if (index === 0) return; ...`) — room index `0` is skipped
    *entirely*, never flooded regardless of its entity kind. This is what actually
    protects `spawn` today, not the per-tile check below: `pickSafeSpawn` always
    returns a point strictly inside `rooms[0]`, so as long as room `0` is never
    flooded at all, `spawn` can never end up inside a flooded region — full-room
    exclusion, not a single-tile carve-out, which matters because a single safe
    tile surrounded on every side by acid would be exactly as bad as no
    protection at all.
  - **Tile-level**: inside the per-room flood loop, `if (x === spawn.x && y ===
    spawn.y) continue;` and `if (x === exit.x && y === exit.y) continue;` carve
    out the exact `spawn`/`exit` coordinates from whatever room *does* get
    flooded. The `spawn` check here is actually dead code in practice — room `0`'s
    interior is never reached by this loop at all, per the room-level skip above —
    but the `exit` check is load-bearing and necessary: `pickExit` can select any
    room's center as the exit, including a `"global"` room's, and unlike `spawn`,
    `exit`'s containing room gets *no* room-level exclusion, only this one tile
    carved out of an otherwise-flooded room.
  - **The bug this creates for multiplayer, confirmed rather than assumed**:
    `pickMultiplayerSpawns` (§2 above) selects from *every* room's center, the
    same pool `pickExit` already draws from — not just room `0`. A chosen
    multiplayer spawn can therefore land inside a `"global"` room exactly the way
    `exit` already can, but `fillHazards` has no parameter for these points at
    all today, at either the room level or the tile level. Without a fix, a
    multiplayer spawn assigned to a `"global"` room is flooded with acid at level
    start — a player could spawn standing in (or immediately adjacent to)
    permanent damage.
  - **Exact fix**: add a fifth parameter, `multiplayerSpawns: readonly Point[] =
    []` (default preserves every existing single-player call site exactly
    unchanged, same pattern as `multiplayerSpawns` on `GameMap` itself), and apply
    it at **both** levels this function already operates at — mirroring, not
    replacing, its two existing mechanisms:
    ```ts
    export function fillHazards(
      rooms: Room[],
      grid: Tile[][],
      spawn: Point,
      exit: Point,
      multiplayerSpawns: readonly Point[] = [],
    ): Point[] {
      const hazards: Point[] = [];
      rooms.forEach((room, index) => {
        if (room.entity.kind !== "global") return;
        if (index === 0) return; // never flood the single-player spawn room
        // NEW — room-level: never flood a room chosen as a multiplayer spawn
        // either, same "don't surround the one safe tile with acid" reasoning
        // as the room-0 check above. A multiplayer spawn is always exactly some
        // room's center (see pickMultiplayerSpawns), so a coordinate match
        // against room.center reliably identifies "this is a spawn room".
        if (multiplayerSpawns.some((s) => s.x === room.center.x && s.y === room.center.y)) return;
        for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
          for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
            if (x === spawn.x && y === spawn.y) continue;
            if (x === exit.x && y === exit.y) continue;
            // NEW — tile-level: belt-and-suspenders alongside the room-level
            // check above (which should already prevent this branch from ever
            // matching in practice) — kept anyway because it's the *only*
            // protection left if a future change ever picks a multiplayer
            // spawn that isn't exactly a room center, the same "defensive,
            // not just structural" role the existing (currently-dead) spawn
            // check already plays today.
            if (multiplayerSpawns.some((s) => s.x === x && s.y === y)) continue;
            grid[y][x] = HAZARD_TILE;
            hazards.push({ x, y });
          }
        }
      });
      return hazards;
    }
    ```
    Call site (`mapGenerator.ts`, where `fillHazards` is invoked): pass the same
    `multiplayerSpawns` value computed earlier in `generate()` per §2 —
    `fillHazards(rooms, grid, spawn, exit, multiplayerSpawns)` — no other call
    site exists to update.
  - **Why not fold this into a single flat `avoid: Point[]`** the way this same
    file's sibling `placeTraps` already does for its own avoid-list: `placeTraps`
    only ever needs a simple distance check against a flat list, so genericizing
    it there is a clean fit. `fillHazards` genuinely needs to distinguish
    `multiplayerSpawns` as its own group for the *room-level* check (matching
    against `room.center`, not just "is this raw coordinate in a list") — keeping
    it as its own explicitly-named parameter is clearer here specifically because
    that room-level logic depends on knowing which points are multiplayer spawns,
    not just that they're somewhere to avoid.
  - **Deliberately not addressed here**: whether `exit`'s own containing room
    should *also* get the same room-level exclusion `spawn`/multiplayer spawns
    get (today it only gets the tile-level carve-out) is a pre-existing
    single-player question this audit surfaced but wasn't asked to resolve —
    named here so it isn't mistaken for something this fix silently covers, not
    expanded into a second fix this document wasn't scoped to make.

None of this touches `assertAllRoomsReachable`'s existing invariant: that check (and
`connectRooms`' own graph-connectivity guarantee it verifies) already establishes
that *every* room is mutually reachable from *every other* room via corridors —
reachability doesn't depend on which specific point within the graph is designated
"the" spawn. Picking additional spawns from room centers already known to be
reachable introduces no new reachability risk, so this needs no new assertion.

## 3. Scoring & assists

### The real prerequisite this section depends on

`ScoreBreakdown`/`ScoreInput`/`computeScore()`/`killPoints()` (`scoring.ts`) need
**zero shape changes**. Every one of them already takes a flat "one player's
current stats" input and returns that one player's breakdown — that contract is
already exactly what per-player scoring needs, called once per player instead of
once globally.

What actually has to change is upstream of `scoring.ts` entirely, and it's the
biggest single piece of work implied by "adapt scoring for multiplayer," so it's
worth stating plainly rather than letting §3 read as smaller than it is: **today's
`RaycasterEngine` is internally single-player** — one `Player` instance
(`this.player`), one `this.health`, one `this.ammo`, one `this.weaponIndex`. Per
`multiplayer-netcode-spec.md`'s design, every peer runs a full engine instance that
simulates *every connected player's* position/health/ammo/weapon (combat and loot
are shared-world mechanics — any player can hit any enemy, any player can pick up
any drop), not just "the local one." Making `ScoreInput`'s fields
(`finalHealth`, `finalBullets`, etc.) meaningful *per player* requires the engine to
already hold that data per player — i.e. `this.player: Player` becoming something
keyed by player ID, and `this.health`/`this.ammo`/`this.weaponIndex` following the
same shape. That refactor is a prerequisite this document depends on, not something
§3 can route around — it is now specified in full as
[§6, The N-player engine model](#6-the-n-player-engine-model), and must be
sequenced before both this section and all of `multiplayer-netcode-spec.md`'s
implementation.

### Given that prerequisite, the scoring refactor itself is small

Once the engine holds per-player state, the orchestration layer (wherever the
session lives above individual `RaycasterEngine` instances) maintains:

```ts
const scoresByPlayer: Record<PlayerId, ScoreBreakdown> = {};
// populated by calling the existing, unchanged computeScore() once per player,
// fed that player's own slice of the now-per-player engine state — exactly
// EngineStats.levelScoreBreakdown's existing shape, just one per player instead
// of implicitly "the" player.
```

This is also exactly what the checklist's "end-of-run comparison table" needs: a
`Record<PlayerId, ScoreBreakdown>` snapshot at run end, built from data every peer
*already has locally* (per the lockstep model, every peer's simulation already
tracks every player's stats identically) — no new network message required purely
for scoring, beyond whatever `PlayerSnapshot` reconciliation already carries per
`multiplayer-netcode-spec.md`.

### Assist tracking: genuinely new state

`killPoints(enemy)` stays a pure function, unchanged — it computes one flat value
for one dead enemy, same as today. What's new is **who that value gets credited
to**, and that requires tracking damage contribution *before* the kill happens,
since by the time `damageEnemy()` (`engine.ts`, ~line 2194) marks an enemy dead,
there's no record left of who else hit it along the way.

Confirmed directly: `damageEnemy(enemy, amount, ...)` is the single choke point
where any weapon hit reduces `enemy.hp` — every call site (`fire()`'s pellet-hit
loop, the rocket-splash handler, etc.) already funnels through it. That's the one
place a new player-attribution parameter needs to land.

```ts
/** Which players have damaged which currently-alive enemy this level, keyed by
 * the enemy's stable array index into GameMap.enemies — the same identity
 * scheme multiplayer-netcode-spec.md's EnemySnapshot already uses, reused here
 * rather than inventing a second one. Cleared per-entry the moment that enemy
 * dies (no assist data to keep once the kill's been credited). */
const enemyAssists = new Map<number, Set<PlayerId>>();
```

- `damageEnemy` gains a `sourcePlayerId: PlayerId` parameter (threaded from
  wherever it's called — under the multiplayer engine, every shot is already
  attributable to whichever connected player's input fired it, per the lockstep
  input model). At the top of `damageEnemy`, before the HP reduction: record
  `sourcePlayerId` into `enemyAssists.get(enemyIndex)` (creating the `Set` on first
  hit).
- At the existing kill branch (`enemy.alive = false; ...; this.killScore +=
  killPoints(enemy)`, ~line 2217–2220): instead of crediting one local score,
  compute `killPoints(enemy)` once (unchanged) and **split it evenly across every
  `PlayerId` in `enemyAssists.get(enemyIndex)`**, crediting each contributing
  player's own running score. Then `enemyAssists.delete(enemyIndex)` — the kill's
  been paid out, the bookkeeping for that enemy is done.
- **Even split, not damage-weighted, for v1** — matches the checklist's own framing
  ("teamwork for kill should share pointbonus," not "reward whoever landed the
  killing blow more"), and is meaningfully simpler: no need to track *how much*
  damage each contributor dealt, only *whether* they did at all. A
  damage-proportional split is a legitimate future refinement if playtesting wants
  it, not a v1 requirement — flagged here rather than silently assumed away.
- **Memory bound**: `enemyAssists` only ever holds entries for currently-alive,
  currently-damaged enemies on the current level — bounded by `GameMap.enemies`'s
  own (already-bounded) size, cleared per-enemy on death and implicitly reset
  wholesale on every level transition (a fresh `Map` per level, same lifecycle
  every other level-scoped engine field already has).

## 4. Elite scaling by player count

### Where difficulty does the equivalent thing today — the pattern to mirror

Confirmed exact hook, `engine.ts` constructor (~lines 753–765): difficulty's HP
multiplier is applied **once, in place, right after construction** —
`enemy.hp = Math.round(enemy.hp * this.difficultyMultipliers.hp)` for every enemy,
not threaded through `MapGenerator.generate()` (deliberately — `difficulty.ts`'s own
doc comment explains why: it would cross the map/engine layering boundary for no
benefit). Elite HP's own *base* 4× multiplier (`ELITE_HP_MULTIPLIER`,
`map/generation/enemies.ts`) is set even earlier, at generation time, baked into
`enemy.maxHp` before difficulty ever touches it — difficulty's rescale multiplies
whatever's already there, elite included.

Elite damage output is a separate, second ladder: `damageMultiplier(enemy)` in
`enemyAi.ts` (~line 181) — `enemy.elite ? ELITE_DAMAGE_MULTIPLIER : enemy.edgeCase ?
EDGE_CASE_DAMAGE_MULTIPLIER : 1` — the one place both melee and ranged attacks read
an enemy's damage scale from. Difficulty's own `damage` multiplier is applied
*separately*, at the `engine.ts` call sites that consume `updateEnemies()`'s
returned total (~lines 1625, 1639) — but critically, that total can already be a
mix of elite and non-elite hits landed in the same frame, so difficulty's multiplier
is deliberately applied to the *aggregate*, post-hoc. **Player-count scaling for
elites specifically cannot use that same aggregate-multiply trick** — multiplying
the whole frame's total damage would incorrectly also scale non-elite hits. It has
to go in at the same place `ELITE_DAMAGE_MULTIPLIER` itself already lives:
per-enemy, inside `damageMultiplier()`, before the per-enemy amounts get summed.

### New module, new multiplier shape

A new small engine-layer module (no need for `difficulty.ts`'s `src/`-root
placement — that module lives there specifically because *both* the map and engine
layers need it and map must never import engine; player-count elite scaling is
consumed entirely within the engine layer, so it belongs alongside the other
engine-only constants, e.g. a new `src/engine/multiplayerScaling.ts`):

```ts
export interface EliteScalingMultipliers {
  hp: number;
  damage: number;
}

/** How much extra HP/damage an Elite enemy gets per player beyond the first —
 * mirrors DIFFICULTY_MULTIPLIERS' shape (difficulty.ts) deliberately: a small,
 * named, tunable constants table rather than a formula buried at the call site.
 * Starting values, not balanced ones — see this module's own note on tuning. */
const ELITE_HP_SCALE_PER_EXTRA_PLAYER = 0.5;
const ELITE_DAMAGE_SCALE_PER_EXTRA_PLAYER = 0.25;

export function eliteScalingFor(playerCount: number): EliteScalingMultipliers {
  const extra = Math.max(0, playerCount - 1);
  return {
    hp: 1 + extra * ELITE_HP_SCALE_PER_EXTRA_PLAYER,
    damage: 1 + extra * ELITE_DAMAGE_SCALE_PER_EXTRA_PLAYER,
  };
}
```

A formula over a fixed lookup table (unlike `DIFFICULTY_MULTIPLIERS`, which only
ever needs exactly three named tiers) because player count is an open-ended integer
(the signaling server's own `playerCount` cap is 16, per
`multiplayer-server-spec.md`) — a table would need an entry per supported count for
no real benefit over a one-line formula.

### The two injection points

- **HP** (`engine.ts` constructor, immediately alongside the existing difficulty
  rescale loop at ~753–765): a second pass, filtered to `enemy.elite` only —
  `if (enemy.elite) { enemy.hp = Math.round(enemy.hp * eliteMultipliers.hp); enemy.maxHp
  = Math.round(enemy.maxHp * eliteMultipliers.hp); }`. Order relative to the
  difficulty pass doesn't matter (both are simple multiplications of the same
  field), but doing it as a visually separate loop/branch — not folded into the
  existing unconditional difficulty loop — keeps "this only touches Elites" obvious
  at the call site rather than requiring a reader to trace a conditional buried
  inside a loop meant for everyone.
- **Damage** (`enemyAi.ts`'s `damageMultiplier(enemy)`, ~line 181): thread a new
  parameter through the same way `enemyAimSpreadDeg` already is (`engine.ts` already
  passes that one difficulty-derived value into `updateEnemies()` today, exact same
  pattern to copy) — `damageMultiplier(enemy, eliteDamageScale)` returning
  `enemy.elite ? ELITE_DAMAGE_MULTIPLIER * eliteDamageScale : enemy.edgeCase ?
  EDGE_CASE_DAMAGE_MULTIPLIER : 1`. Edge Case enemies deliberately excluded from
  player-count scaling — the original checklist item is specifically about Elites,
  and Edge Case enemies are a different, unrelated tier (weak "bug in the system"
  filler, not a boss-adjacent threat that should scale with lobby size).

### Tuning caveat, stated the same way this project already treats balance numbers

`0.5`/`0.25` above are reasoned starting points (roughly "each extra player adds
half again the HP a solo Elite would have, and a quarter more bite"), not validated
ones — this project already has a real mechanism for turning "reasoned guess" into
"validated number" (`npm run balancing:telemetry`, `doc/dev/balancing-telemetry.md`)
and elite/player-count scaling should go through the same process once there's a
multiplayer session to actually generate telemetry from, not ship on the strength of
this document's reasoning alone.

## 5. Loot-drop visibility on minimap and automap

Raised by `multiplayer-netcode-spec.md`'s disconnect-handling rule: a disconnected
player's ammo/weapons return to the world as ordinary `LootDrop`s, but a teammate
has no in-fiction way to know one exists three rooms away unless it shows up on a
map.

**Correction to this section's first pass**: checked directly against both map
renderers, neither shows loot drops today — `renderMinimap` (`raycaster.ts`) draws
walls, lore terminals, and (further down, not quoted above)
enemies/doors/keys/teleporters; `drawAutomap` (`automap.ts`) draws terrain, mines,
and the exit; `LootDrop` never appears in either file. The first pass of this
document read that as an oversight to fix universally. **It isn't one — it's
deliberate single-player design** (the same discovery-over-convenience instinct
already documented elsewhere in this codebase: an unopened secret wall rendering
identically to a plain one, the minimap having no general fog-of-war at all,
neither map spoiling a room's contents before the player earns finding them by
actually going there). Single-player's behavior is correct as-is and **must stay
exactly as it is** — this change is **multiplayer-only**, for a different pair of
reasons than single-player's design optimizes for: fun (a team shouldn't have to
grid-search a level for a returned item) and fairness (per the disconnect rule's
own reasoning, a drop existing specifically so a teammate who lacks it can find it
doesn't work if finding it is left to chance).

### Data is already available — the gate belongs at the call site, not in the renderers

`LootDrop[]` already lives on the engine instance today (`RaycasterEngine`'s own
array, populated by `pushLootDrop` — confirmed directly, it's not part of
`GameMap`, unlike enemies/mines/pickups). Both render functions are called from
`engine.ts`. The multiplayer-only restriction belongs entirely at **that call
site**, not inside `renderMinimap`/`drawAutomap` themselves: those two functions
just draw whatever array they're handed and have no need to know or care whether a
session is multiplayer — so `engine.ts` passes `this.lootDrops` when (and only
when) a multiplayer session is active, and an empty array otherwise. Single-player
call sites need **zero changes** — an always-empty array from them is
indistinguishable from "this parameter doesn't exist," which is exactly the
guarantee needed here. No `ReconciliationSnapshot`/wire-format change is implied
either way: every peer already has its own accurate `LootDrop[]` from its own
local simulation (per the lockstep model), so this is purely about what each
peer's own renderer is *allowed* to draw with data it already has — a client-local
policy decision, fully decoupled from netcode.

### Minimap (`renderMinimap`, `raycaster.ts`)

New parameter, e.g. `lootDrops: readonly LootDrop[]`. Draw one marker per entry, in
the same "small square at the entity's fractional position" style already used for
other point markers on this panel, in a **new, distinct color** — every existing hue
is already claimed (lore-terminal teal, hazard/mine warm reds/orange, exit green,
player yellow) — a warm gold/amber reads as "valuable, go get it" without
colliding with any existing meaning.

**Visibility gate, mirroring an existing precedent rather than inventing one**: this
panel's own doc comment is explicit that it has *no* fog-of-war for walls — but
enemies are the one existing exception, gated by `Enemy.discovered` (the player has
physically entered that enemy's room) specifically so the minimap can't spoil
content ahead of discovery. Loot drops need the same treatment, not the wall
default: gate each drop on `map.visited` at its tile (see below for why `visited`
itself, not a new sticky per-drop flag, is the right check) — an ungated drop would
otherwise broadcast a disconnect's exact location the instant it happens, in a room
nobody's been near yet, which is exactly the kind of unearned spoiler this
project's minimap design already goes out of its way to avoid elsewhere (see the
identical reasoning already in this file's own doc comment for why an unopened
secret wall renders identically to a plain one).

### Automap (`drawAutomap`, `automap.ts`)

Same new parameter, same gate (`map.visited` at the drop's tile — this renderer
already gates literally everything else on it, so a loot drop is just one more
thing that follows the existing rule, not a new one). Rendering technique: copy the
mine marker's exact pattern (viewport-cull first — `if (drop.x < tileX0 - 1 || ...)
continue`, same bounds check mines already use — then a small fixed-size square at
the drop's camera-relative position), new gold/amber color matching the minimap's
choice for visual consistency between the two views of the same data.

### `visited` as team-shared fog-of-war, not per-player

Both gates above assume `map.visited` continues to mean "has *anyone* been near
this tile," not "has *this specific* player" — i.e., **fog-of-war stays one shared
grid for the whole session, not split per player**. This is a real design choice
worth stating explicitly rather than assuming: it means one teammate scouting a
room reveals it on *everyone's* map, coop-appropriate (shared team knowledge, not
individually re-earned per player) and simpler than the alternative (no per-player
`visited` duplication needed at all). It's also the natural complement to this
document's own §3 prerequisite: `visited` staying a single shared structure is one
fewer piece of state that needs to become "per player" alongside `Player`/health/
ammo/weaponIndex.

### Not addressed here, on purpose

Whether a `weapon`-kind drop should get a visually distinct marker from an ammo
drop (e.g. so a teammate can tell at a glance "that one's worth a detour") is a
polish question, not a requirement — a single uniform loot-marker color satisfies
the actual ask (drops must be *findable*, not necessarily *categorized* at a
glance) and is simpler to ship first.

## 6. The N-player engine model

Review found this was the largest piece of the whole initiative left unspecified:
`multiplayer-netcode-spec.md` originally claimed `advance()` needs no modification,
while this document's own §3 established the engine is internally single-player —
both couldn't be true, and neither document said how N players actually get
simulated. This section is that design. It is a **hard prerequisite** for
implementing anything in `multiplayer-netcode-spec.md`: the netcode drives an
engine shape that doesn't exist until this refactor lands.

### State split: per-player vs shared

Everything the engine holds today sorts cleanly into one of two buckets. Getting
this split right *is* most of the design:

| Per-player (one per connected player) | Shared (one per engine instance) |
|---|---|
| `Player` instance (position, dir/plane camera, `noClip`) | `GameMap` (grid, `visited`, `gridVersion`) |
| `health`, `swap` | `enemies`, `lootDrops`, `ammoPickups`, `keys` state |
| `ammo` pools, `weaponIndex`, `ownedWeapons`, `keysHeld` | `projectiles`, `rockets`, mines/spike state |
| `InputSource` (see below) | `levelTime` |
| viewmodel state (recoil, muzzle flash) | the one seeded `mulberry32` stream |
| score trackers (killScore, kills, accuracy, distance traveled, multikill window) | cosmetic particles/traces (`Math.random`-driven, never sim-relevant) |
| `PathField` (player-rooted BFS — one per player, refloods on that player's tile change) | |
| render offsets (netcode spec mechanism 4) | |

Concretely: `this.player`/`this.health`/`this.ammo`/etc. become a
`players: Map<PlayerId, PlayerState>` plus a `localPlayerId`, where `PlayerState`
bundles the left column. Single-player is the N=1 case of the same structure —
**not** a separate code path kept alongside a multiplayer one.

### Input: one `InputSource` per player, reusing the replay seam

Each `PlayerState` carries its own `InputSource`. This is the same abstraction the
engine already consumes and the replay system already proves out: in a multiplayer
session, every player — remote *and* local, since the local player's input went
through the delay buffer too — is fed a `ReplayPlaybackInput`-style object whose
`loadFrame(snapshot)` is called from the tick's `TickInputBundle` before
`advance()`. In single-player, the one `PlayerState` holds the live
`InputController`. `advance()` stops reading `this.input` and instead processes
each player's input from their own source — same interface, N of them.

### Deterministic iteration order is a correctness requirement, not a style choice

Processing a player's input **consumes shared PRNG draws** — confirmed directly:
`fire()`'s Cone-of-Fire rolls `this.rng()` once per pellet. If peer A processes
players in the order `[p1, p2]` and peer B in `[p2, p1]` on a tick where both
players shoot, the two peers assign different spread rolls to different shots and
desync instantly — with identical inputs and identical state. Therefore:
**every per-player loop in `advance()` iterates the roster in sorted-`playerId`
order, always** — never the received bundle's object-key order, never `Map`
insertion order. The same rule applies to any "first match wins" world interaction
(two players on the same loot drop in the same tick: sorted order decides).

### `advance()` splits into `simulate()` and `render()`

Verified directly, not assumed: today `advance()` doesn't just simulate — **it
renders, in the same call** (`renderScene`, the billboard pass, and the
crosshair-target pick all run inside it). The netcode design requires those to
separate: simulation is tick-locked (30 Hz, worker/bundle-driven per
`multiplayer-netcode-spec.md` §1) while rendering runs on each peer's own
`requestAnimationFrame` at native rate. An earlier revision of the netcode spec
silently assumed this split was free; it's a real, structural piece of this
refactor. The split:

- **`simulate(dt)`** — input application through `checkExit`, every state
  mutation. **`render()`** — raycast, billboards, HUD, and the crosshair-target
  pick, reading whatever simulation state currently exists. The crosshair pick
  (`findTargetUnderCrosshair`) moves to `render()` safely: verified, it only
  feeds the crosshair highlight — firing runs its own projection pass and never
  reads it.
- **`advance(dt)` remains, as a thin `simulate(dt); render();` wrapper** — so
  every existing caller (the internal rAF loop, the replay viewer's
  `step`/`burstTo`, headless harnesses) is untouched, and `advance()`'s composed
  behavior stays part of the N=1 compatibility surface below: same call, same
  simulated state, same rendered frame.
- In multiplayer, ticks call `simulate(FIXED_DT)` alone; a separate local rAF
  loop calls `render()`. A 144Hz player renders at 144Hz off 30Hz sim state
  (with mechanism 4's render-offset smoothing layered on the same seam).

### Shot resolution becomes camera-parameterized

Today's hit detection is screen-space *from the local render pass*: `fire()` reads
`this.ctx.canvas` dimensions, projects enemies from `this.player`'s camera, reads
the render `zBuffer` for Cone-of-Fire range and occlusion. A remote player's shot
has no local render pass to read. Two facts make the fix clean, both verified:

- The internal resolution is a **fixed 640×400 on every client**
  (`main.ts`'s `SCENE_WIDTH`/`SCENE_HEIGHT`; `canvasFit.ts` only ever touches CSS
  `style.width`/`height`, never the backing store) — so screen-space math at
  internal resolution is identical on every peer given the same camera.
- The render `zBuffer` *is* per-column DDA results — casting a fresh DDA ray from
  the same camera yields the identical value.

So: extract a `resolveShot(camera, weapon, rng)` path that projects
enemies/mines from the **shooter's** camera at internal resolution and casts one
DDA occlusion ray per pellet column, instead of reading the local render pass's
buffers. For the local player this produces byte-identical results to today
(same math, same inputs) — which is what makes the N=1 compatibility gate below
achievable. Melee (`meleeWouldHit`) is the same screen-space mechanism and gets
the same treatment.

### Enemy AI: target selection

`updateEnemies(enemies, player, ...)` takes the one player today. Changes:

- **Target**: each chasing enemy targets the **nearest living, non-dead player**,
  ties broken by sorted-`playerId` order (determinism again). Aggro triggers if
  *any* player is within radius+LOS (or on damage, as today); sticky as today.
- **Steering**: an enemy steers by its *target's* `PathField` — one field per
  player (the left column above), each refloods on its own player's tile change,
  same mechanism as today times N.
- **Attacks**: melee bites and ranged bolts (`spawnProjectile`) go at the target.
  `updateEnemies`' current single-number melee-damage return becomes per-target
  attribution (a per-player damage map, or an `applyDamage(playerId, amount)`
  callback) so difficulty scaling and swap-absorption apply to the right player.
- **Projectiles in flight** check collision against **every** living player, in
  sorted order, first hit wins.

### World interactions become any-player

Hazard/spike damage applies to each player standing on the tile; a mine becomes
`visible` when any player enters sight radius, its fuse arms while ≥1 player is
inside the fuse radius, and its blast damages every player in range (environmental
damage, not friendly fire); teleporters warp whichever player steps on the pad;
loot/keys/pickups collect on any player's walk-over and apply to *that* player —
with **every** weapon-kind drop in a multiplayer session following the
no-op-if-already-owned rule (an owner walks through it, a non-owner collects it;
`multiplayer-netcode-spec.md` §5 resolves this as uniform across drop origins,
enemy-kill and secret-room drops included — single-player's top-up behavior is
untouched);
doors open for the pushing player if *they* hold a key; secret walls and lore
terminals respond to the interacting player (`interact` is already in
`InputSnapshot`, so the bundle carries it) — with discoveries (lore read, secret
opened, `visited`) being team-shared, per §5's fog-of-war decision.

### Friendly fire and player collision: none, by construction

- **Hitscan can't hit players today and keeps it that way**: `fire()` only tests
  enemy/mine projections; player billboards (below) are simply never added to the
  hit-test set. No FF logic to write — just don't create the possibility.
- **Rocket splash**: today it damages "everything in the blast radius — including
  the player." Multiplayer rule: splash damages enemies and the **firer** (the
  existing self-damage risk stays — it's a core Ghidra trade-off), but never
  teammates. One explicit exclusion at the engine's splash fan-out.
- **Player-player collision: none** — players pass through each other. Avoids
  doorway-blocking griefs, adds zero new collision code, and removes an entire
  desync-sensitive interaction surface.

### Rendering, HUD, audio

Remote players render as billboards in the **existing single depth-sorted
billboard pass** (a new `collectPlayerBillboards` alongside the enemy/item
collectors — occlusion via the zBuffer comes free). The local player is the
camera and is never billboarded. HUD, viewmodel, crosshair targeting, and the
automap/minimap player *marker* are strictly local-player; teammates appear on
minimap/automap as distinct-colored markers (team-shared knowledge, same spirit
as §5). Audio stays local-perspective; remote players' shots may play sounds
(cosmetic, `Math.random` pitch variance stays fine — it never feeds the sim).

### Death in coop

A player reaching 0 health **dies for the remainder of the level**: their entity
leaves the world simulation (no corpse collision, enemies drop them as a target),
they keep their score and inventory, and their view becomes a spectator camera
following a living teammate (cycle targets with fire; local-only, not
sim-relevant — their `InputSnapshot` still rides the bundle unchanged so the
roster and bundle shape stay stable, it just applies to nothing). They **revive at
the next level transition** (`multiplayer-netcode-spec.md` §7) with inventory
intact and health at `REVIVE_HEALTH` (e.g. 50 — a balance value to validate via
the telemetry process like everything else here). Death deliberately drops
nothing — unlike a disconnect, the player is still present and revives with their
inventory, so stripping it would double-punish; the team already paid the price of
losing a gun for the rest of the level. **One exception: held dependency keys drop
at the death position** (as `kind: "key"` `LootDrop`s, the same new kind the
disconnect rule defines in `multiplayer-netcode-spec.md` §5) — keys are
level-scoped and one-per-door, so a dead player holding one until next level's
revive is the same door-soft-lock the disconnect rule exists to prevent, just
slower; and unlike weapons/ammo, keys are worthless to the dead player anyway
(they don't carry across levels, and the revive is next level). **All players dead
ends the run for everyone** — Kernel Panic, comparison table, same as
single-player death.

### Scoring inputs: which are per-player, which are team-shared

`computeScore()` stays untouched (§3); what changes is the classification of what
feeds it, stated here so it isn't improvised during implementation: **per-player**
— killPoints (assist-split, §3), health/swap bonus, ammo bonus, accuracy,
`distanceTraveledTiles` (each player's own), multikill streaks. **Team-shared** —
`levelTimeSec` (identical for all, so the speed bonus is equal for everyone),
`shortestPathTiles`, `mapCompletionFrac` (from the shared `visited`), lore and
secret-room bonuses (any player's discovery counts for all — the coop-natural
reading, consistent with shared fog-of-war). Net effect: players differentiate on
combat performance and efficiency, while exploration achievements reward the team.

### The N=1 compatibility gate — sequencing, and the definition of done

This refactor lands **first, alone, verified in single-player, before any netcode
exists on top of it**. The bar: with N=1, the refactored engine must be
*behaviorally byte-identical* to today's — including the
`advance() = simulate() + render()` split above, whose composed form is part of
the compatibility surface (the replay viewer and every harness call `advance()`
directly and expect a rendered frame per step). Three existing tools gate it,
none new:

1. The full Vitest suite (100%-coverage gate) passes unchanged.
2. **Existing recorded replays still play back correctly** — the strongest
   available proof, since replay playback fails visibly if the PRNG draw sequence
   or any simulation math shifted by even one call.
3. The map-snapshot-diff + replay-trajectory-digest recipe this project already
   uses for refactor-exactness verification, run over the demo campaign.

Only once that gate passes does netcode implementation start — against an engine
whose N-player shape now actually exists and whose N=1 behavior is proven
unchanged.
