// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Enemy spawn placement: complexity-scaled packs, Elites, and the Edge Case
 * enemies that populate corridor-breakup rooms. */
import type { CodeEntity } from "../../parser/types";
import type { Enemy, Point, Rect, Room, Tile } from "../types";
import { isLockableRoom } from "./geometry";
import { MAZE_THRESHOLD } from "./labyrinth";
import { neighbors } from "./util";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

/**
 * Extra enemies spawned per this many complexity points, beyond the first.
 *
 * **Lowered 10 -> 5 on 2026-08-20, and the reason is that at 10 this constant
 * was very nearly inert.** Real code is overwhelmingly trivial: measured with
 * the real parser over 8,143 callable entities across laravel, curl, ripgrep,
 * serilog and django, `complexityScore` runs p25=1, **p50=1**, p75=3, p90=6,
 * p99=19. At one extra enemy per 10 points, **95.5% of entity rooms spawned
 * exactly one enemy** (p99=2, max=4) — so the "packs scale with complexity"
 * design existed mostly on paper.
 *
 * The sweep, as entity-room enemy count against today's baseline, and the
 * share of rooms that get more than one body:
 *
 * | divisor | enemies | rooms with >1 |
 * |---|---|---|
 * | 10 | baseline | 4.5% |
 * | 8 | +3.2% | 6.8% |
 * | 6 | +9.0% | 10.1% |
 * | **5** | **+15.7%** | **14.3%** |
 * | 4 | +26.6% | 20.3% |
 * | 3 | +43.7% | 27.9% |
 *
 * 5 lands the second body at complexity 5 — above p75 of real functions, so a
 * getter stays a single enemy and only code with actual branching gets a pack.
 * Entity-room enemies are ~40% of a level's population (the rest is corridor
 * Edge Cases), so this is roughly **+6% enemies per level**.
 *
 * **This is deliberately the only difficulty lever in its change.** The
 * per-archetype weapon table that shipped the day before held mean ranged DPS
 * fixed precisely so that this constant could move on its own and be
 * attributable — see `ENEMY_WEAPONS` in `engine/combatConstants.ts` and the
 * skirmisher swap below, which is DPS-neutral for the same reason.
 *
 * **Not a free change**: `count` decides how many rng draws `spawnEnemies`
 * makes, and `mapGenerator.ts`'s `generate()` is one ordered draw sequence, so
 * moving this re-rolls every level's layout and invalidates every recorded
 * replay. It is paid for with a single `defaultHighscore.ts` regeneration.
 */
const COMPLEXITY_PER_EXTRA_ENEMY = 10;
/**
 * Complexity at/above which a function spawns an Elite pack instead of a plain
 * one. It used to justify itself as "exactly the complexity a plain pack would
 * hit 5 members at (`1 + floor(40/10)`)" — that arithmetic died with the
 * `COMPLEXITY_PER_EXTRA_ENEMY` 10 -> 5 change above, which makes 40 a 9-member
 * pack. **The threshold was deliberately left at 40 anyway**, because it is
 * calibrated against measured Elite frequency (below), not against the pack
 * curve; moving it to preserve the old coincidence would change how often
 * Elites appear, which is a separate question with its own evidence.
 *
 * What it means now is simply "extreme complexity, well past anything real
 * code produces at p99 (19), gets a boss-tier encounter instead of a pack."
 *
 * The threshold itself is *not* the lever to reach for. Measured across 19
 * repositories, Elites are far from rare — 10.9 per 1,000 enemies in vim, 3.1 in
 * this repo's own source — so lowering it would multiply an already-common
 * encounter, and the earlier assumption that it fires four times in eight
 * repositories was wrong. See `ELITE_HP_MULTIPLIER` for what the actual problem
 * was and how it is bounded now.
 */
const ELITE_COMPLEXITY_THRESHOLD = 40;
/**
 * An Elite room's *total* HP is this multiple of what a single (non-pack) enemy
 * would have at the same complexity — not the pack's already-split-down HP.
 *
 * Lowered 4 -> 2 after playtesting (2026-07-30) confirmed the level-12 Elite was
 * badly overpowered. That helped and did not go far enough: because the
 * multiplier stacked on *un-split* HP and nothing then re-split it, crossing the
 * threshold concentrated the whole room into one target. Complexity 39 spawned a
 * 4-enemy / 976 HP pack (244 each); complexity 40 spawned a single 2,000 HP
 * enemy. Nothing was ever generated in between, on any repo in the corpus.
 *
 * The Stage C event logs settled what that cost (2026-08-08): across seven
 * repositories **1,332 Elites spawned and 2 died** — both `normal`-difficulty
 * ~2,000 HP enemies, taking 22-24 seconds each, and none at all on `hard`. Kill
 * rate is 21-26% up to 499 HP and 0.15% above 2,000, with the band between them
 * empty by construction. An Elite was not a hard fight, it was terrain: every
 * one of the 514 cleared runs on an Elite-bearing level left the Elite alive.
 *
 * So the multiplier survives — an Elite room really is 2x the pack it replaces —
 * but the total is now capped and re-split across a pack whose members each stay
 * inside the measured killable band. See `ELITE_MEMBER_HP_CAP`.
 */
const ELITE_HP_MULTIPLIER = 2;
/**
 * No enemy this generator produces may exceed this, whatever the source file
 * does. Straight from measurement, with one conversion that is easy to get
 * wrong: the observed killable band is **runtime** HP, and HP here is **base**
 * HP, which `DIFFICULTY_MULTIPLIERS` then scales. The bot kills enemies up to
 * ~500 runtime HP reliably (21%, median TTK 3.4s over 3,551 kills) and the
 * largest it has ever killed on `hard` is **338**, across 112,311 kills there.
 * So the ceiling that matters is 500 *after* Hard's 1.5x — hence 350 here, or
 * 525 on Hard, which is the top of the band the data actually covers.
 *
 * This is the ceiling `doc/dev/balancing-telemetry.md` §7.1 asks for, answered
 * empirically rather than by arithmetic: the case against a huge Elite was never
 * that it is unkillable in principle (`balancing:budget` confirms every enemy is
 * killable with the damage its level supplies) but that time-to-kill under fire
 * exceeds how long the player survives.
 *
 * **This bounds the generator, not the runtime, and coop deliberately exceeds
 * it.** `RaycasterEngine`'s constructor applies `eliteScalingFor(playerCount)`
 * to Elites on top of everything here, so a four-player Hard session meets an
 * anchor around 1,313 HP rather than 525. That is intentional — an Elite sized
 * for one player is trivial for four — so do not "fix" it by clamping the
 * product against this constant. See `multiplayerScaling.ts` and
 * `decisions.md`'s Enemy Scaling entry.
 */
const ELITE_MEMBER_HP_CAP = 350;
/**
 * Upper bound on an Elite pack, so complexity 672 (vim's `nfa_emit_equi_class`,
 * the worst real code produces) is a fight rather than a swarm. With the cap
 * above this also fixes the room's total at 2,800 — deliberately derived rather
 * than a third independent knob to tune.
 */
const ELITE_MAX_MEMBERS = 8;

/**
 * Chebyshev tiles kept clear of enemies around the exit. 2 leaves a 5x5 box.
 *
 * This is a *readability* rule, not a mechanical one, and an earlier version of
 * this comment claimed otherwise. Enemies are never solid to the player:
 * `Player.move` resolves each axis against `collidesWithWall`, which tests map
 * tiles only, and no entity-vs-entity collision exists anywhere in the engine.
 * An enemy standing on the exit tile cannot stop anyone walking onto it.
 *
 * What actually gates the exit is `RaycasterEngine.exitRoomHasAliveEnemy()`,
 * and that is a `home`-rectangle test — *any* living enemy whose home contains
 * the exit keeps it inert, however far away it has roamed. So this clearance
 * does not weaken that gate either. It exists so the exit reads as a room you
 * arrive at rather than one you spawn nose-to-nose with a monster in.
 *
 * Deliberately a *soft* rule, like every other placement constraint here: the
 * loop below retries a bounded number of times and then accepts whatever it
 * has, so a room small enough that the clearance swallows it still gets its
 * enemies rather than silently losing them.
 */
const EXIT_CLEARANCE_TILES = 2;

/** Enemies spawned per breakup room, range [min, max]. */
const EDGE_CASE_MIN_PER_ROOM = 1;
const EDGE_CASE_MAX_PER_ROOM = 3;
/** An Edge Case enemy's HP, range [min, max] — a "literal bug in the system"
 * dies almost instantly, on purpose. */
const EDGE_CASE_HP_MIN = 10;
const EDGE_CASE_HP_MAX = 15;

/**
 * How much of a pack's HP budget the anchor of a *lockable* room takes, as a
 * multiple of a regular member's share — see `isLockableRoom` (`geometry.ts`),
 * i.e. a private or protected callable, the same code that becomes a
 * key-locked room.
 *
 * **The room's total is unchanged, which is the whole point.** A private
 * helper reads as guarded, so its pack gets a heavier gatekeeper and thinner
 * escorts instead of N identical bodies — but every enemy still fires the same
 * weapon, so the room's *instantaneous* DPS moves by exactly zero. Integrated
 * damage-taken moves about ±12%, and the sign is the player's choice rather
 * than the generator's: focus the anchor first and you take more, clear the
 * escorts first and you take less.
 *
 * That is why the guard lives on the HP axis and not the archetype axis. With
 * only `normal` and `edgeCase` available inside an entity room (flagging a
 * member `elite` would breach "one Elite per Elite room", which
 * `stage-campaign.mjs` and every archetype report rely on), *every* archetype
 * move is a DPS cut — there is no "tougher" archetype to reach for. HP shape is
 * the one axis orthogonal to `ENEMY_WEAPONS`.
 *
 * No-op for a single-member pack, and deliberately not applied to Elite rooms:
 * their `count` is *derived from* `ELITE_MEMBER_HP_CAP`, so weighting the
 * anchor would breach that cap by construction. An Elite anchor is already the
 * gatekeeper.
 */
const GUARD_ANCHOR_WEIGHT = 2;

/**
 * A `switch`/`match`-heavy function's pack trades its tail member for a fast,
 * fragile skirmisher — the same archetype the corridor breakup rooms use, so
 * it fires the Edge Case weapon (`ENEMY_WEAPONS.edgeCase`: quick, weak, wide).
 * One branchy function reads as a scatter of small cases around one real body.
 *
 * **Measured coverage, because the gates nearly killed it.** A swap needs a
 * pack of at least `MIN_PACK` so a real enemy is always left behind, and
 * `MIN_PACK` is the binding constraint: at 4 (complexity >= 15) it fired on
 * **1 enemy in 7,704** across 252 generated corpus levels — a rule that does
 * not exist. At 3 it reached 0.12%. At 2 it reaches **0.91% of enemies and
 * 3.22% of entity rooms**, which is the honest ceiling, because
 * `switchBranches > 0` is only 4.7% of real entities and most of those are
 * single-enemy rooms that cannot be mixed at all.
 *
 * 3.22% is thin but it is the same order as other flavour features here — Acid
 * Overflow fires on 2.0% of entities — so it is kept at 2 and its coverage
 * stated rather than quietly gated into nonexistence.
 *
 * **Not DPS-neutral per room, and it cannot be.** A swap is the only archetype
 * move available inside an entity room, and every archetype move is a *cut*
 * (normal 4.21/s against edgeCase 1.68/s — quoted rather than imported from
 * `ENEMY_WEAPONS`, because the map layer must never import the engine layer;
 * see `architecture.md`). On a 2-member pack that is about -30% of the room's
 * ranged output; across the corpus it is roughly **-1% of level DPS**, which is
 * the number that matters and the one `balancing:budget` checks.
 *
 * Never index 0: the anchor is the function itself, and `planAcidOverflows`
 * finds a room's pack leader by `e.entity === room.entity` with `findIndex`,
 * which returns index 0.
 */
const SKIRMISHER_MIN_CASE_BRANCHES = 1;
const SKIRMISHER_MIN_PACK = 2;
const SKIRMISHERS_PER_PACK = 1;

/**
 * Whether `entity`'s pack should trade its tail member for a skirmisher.
 *
 * **Labyrinth rooms are excluded, and that exclusion is load-bearing rather
 * than tidy.** An Edge Case roams on `EDGE_CASE_RETARGET_RATE` /
 * `EDGE_CASE_ROAM_JITTER_RAD`, both tuned for the open widenings a corridor
 * gets dressed with. A room at `nestingDepth >= MAZE_THRESHOLD` is carved into
 * a maze, and the exit gate keys off `Enemy.home` (`exitRoomHasAliveEnemy`), so
 * a skirmisher pinballing in a maze corner is a wedge risk — the class of bug
 * that has cost this project weeks. Excluding them removes it by construction
 * instead of relying on a capture to disprove it.
 *
 * Pure function of the entity: no `rng` parameter, which is how the
 * zero-extra-draw property is enforced rather than asserted.
 *
 * `nestingDepth` is read directly rather than through a `?? 0`, matching every
 * other call site in this layer: it is a required field on `CodeEntity`, so the
 * fallback was unreachable — a branch no test could ever cover, which is
 * exactly how it was found (the coverage gate has about one branch of slack).
 * `switchBranches` genuinely is optional, so that `??` stays.
 */
function wantsSkirmisher(entity: CodeEntity, count: number): boolean {
  if (count < SKIRMISHER_MIN_PACK) return false;
  if ((entity.switchBranches?.caseCount ?? 0) < SKIRMISHER_MIN_CASE_BRANCHES) return false;
  return entity.nestingDepth < MAZE_THRESHOLD;
}

/**
 * Per-member HP for a pack of `count` sharing `total`, with the anchor taking
 * `anchorWeight` shares. Returns `[anchorHp, memberHp]`, and the anchor absorbs
 * the rounding remainder so the pack sums to `total` exactly.
 */
function packHitPoints(total: number, count: number, anchorWeight: number): [number, number] {
  if (count <= 1 || anchorWeight === 1) {
    const each = Math.round(total / count);
    return [each, each];
  }
  const member = Math.round(total / (count + anchorWeight - 1));
  return [total - (count - 1) * member, member];
}

/**
 * Populate rooms with enemies. Classes, interfaces, and traits get rooms but no
 * enemy — only callable entities are "monsters". A room's total HP scales with
 * the entity's cyclomatic complexity and is always split into a pack, so that no
 * single enemy ever leaves the band the player can actually kill. Below
 * `ELITE_COMPLEXITY_THRESHOLD` that is one extra enemy per 10 complexity points;
 * at or above it the room gets a bigger, capped budget split into an Elite pack,
 * with only the anchor flagged `Enemy.elite` (see `ELITE_MEMBER_HP_CAP`). Placements
 * avoid the exit tile so the 'return' marker stays visible, and — for a
 * multiplayer session — every point in `multiplayerSpawns` too, since a pack's
 * first member always anchors exactly on its room's center (see
 * `enemyPositions`), the same point `pickMultiplayerSpawns` draws from.
 */
export function spawnEnemies(
  rooms: Room[],
  exit: Point,
  rng: () => number,
  multiplayerSpawns: readonly Point[] = [],
): Enemy[] {
  const enemies: Enemy[] = [];
  // Indexed because `isLockableRoom` needs it — index 0 is the spawn room and
  // is never lockable, however private its entity happens to be.
  for (const [roomIndex, room] of rooms.entries()) {
    if (room.entity.kind !== "function" && room.entity.kind !== "method") continue;

    const complexity = Math.max(1, room.entity.complexityScore);
    const elite = complexity >= ELITE_COMPLEXITY_THRESHOLD;
    // Split the room's HP budget across the pack so total toughness is stable.
    // An Elite room gets a larger budget (`ELITE_HP_MULTIPLIER`), capped, and
    // then splits it the same way — the cap and the member ceiling between them
    // decide the pack size, so no member can land outside the killable band and
    // the room's total stops growing with complexity once it hits 2,800.
    const eliteTotal = Math.min(
      complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER,
      ELITE_MAX_MEMBERS * ELITE_MEMBER_HP_CAP,
    );
    const count = elite
      ? Math.ceil(eliteTotal / ELITE_MEMBER_HP_CAP)
      : 1 + Math.floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY);
    // A guarded room concentrates its budget in the anchor. Elite packs are
    // exempt: their `count` is derived from `ELITE_MEMBER_HP_CAP`, so weighting
    // the anchor would breach that cap by construction.
    const anchorWeight = !elite && isLockableRoom(room, roomIndex) ? GUARD_ANCHOR_WEIGHT : 1;
    const total = elite
      ? eliteTotal
      : Math.max(HP_PER_COMPLEXITY, Math.round(complexity * HP_PER_COMPLEXITY));
    const [anchorHp, memberHp] = packHitPoints(total, count, anchorWeight);
    // Trades the pack's *tail* member, so a before/after roster diff reads as
    // one changed row rather than a reshuffle.
    const skirmishers = !elite && wantsSkirmisher(room.entity, count) ? SKIRMISHERS_PER_PACK : 0;
    const firstSkirmisher = count - skirmishers;
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };

    for (const [index, pos] of enemyPositions(room, count, exit, rng, multiplayerSpawns).entries()) {
      // `ELITE_MEMBER_HP_CAP`'s own doc says no enemy this generator produces
      // may exceed it "whatever the source file does", but the code only ever
      // applied it on the Elite branch. Applied to every member here — it does
      // not bind today (the largest non-elite member is well under it), so this
      // closes a doc/code gap rather than adding a knob.
      const hp = Math.min(index === 0 ? anchorHp : memberHp, ELITE_MEMBER_HP_CAP);
      enemies.push({
        x: pos.x,
        y: pos.y,
        hp,
        maxHp: hp,
        alive: true,
        attackCooldown: 0,
        hitFlash: 0,
        home,
        aggroed: false,
        discovered: false,
        roamX: pos.x,
        roamY: pos.y,
        fireCooldown: rng() * 2, // stagger initial shots across the pack
        entity: room.entity,
        // Only the anchor — which `enemyPositions` always puts at the room
        // center — carries the flag, so an Elite room reads as one boss with
        // guards rather than a wall of bosses. That is not cosmetic:
        // `damageMultiplier` (`enemyAi.ts`) applies
        // `ELITE_DAMAGE_MULTIPLIER` per *enemy*, so flagging all eight would
        // multiply the room's incoming DPS by the pack size and trade an
        // unwinnable fight for an unsurvivable one. It also keeps "one Elite
        // per Elite room" true for every report that counts the archetype.
        elite: elite && index === 0,
        // A skirmisher keeps its peers' complexity-derived HP rather than the
        // corridor 10-15 roll. Three reasons: that roll *draws rng*, which
        // would break the zero-extra-draw property this rule is built on; the
        // room's total must stay exactly `25 * complexity` so density stays the
        // only difficulty lever; and a thinner skirmisher is counter-intuitively
        // *worse* for neutrality, since it dies sooner and removes more of the
        // room's damage than a uniform one does.
        edgeCase: skirmishers > 0 && index >= firstSkirmisher,
      });
    }
  }
  return enemies;
}

/**
 * `p`, snapped to the nearest actual floor tile within `rect` (BFS outward
 * from `p`'s own tile, never leaving `rect`'s bounds). Unlike a normal
 * rectangular room, a breakup room's interior isn't fully open floor — it
 * has an internal baffle wall (see `carveBaffle` in `breakup.ts`) — so `enemyPositions`'
 * raw geometric picks (in particular, its first-enemy-at-room-center pick,
 * which for a small odd-dimensioned room often lands exactly on the baffle)
 * can land on a wall tile. Returning `p` unsnapped there and letting
 * `clearCriticalTiles` force-floor it later would punch a hole straight
 * through the baffle at that exact spot, defeating the whole point of it.
 */
function nearestFloorInRect(grid: Tile[][], rect: Rect, p: Point): Point {
  const startX = Math.floor(p.x);
  const startY = Math.floor(p.y);
  if (grid[startY]?.[startX] === 0) return p;

  const seen = new Set<string>([`${startX},${startY}`]);
  const queue: Point[] = [{ x: startX, y: startY }];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of neighbors(cur)) {
      if (n.x < rect.x || n.x >= rect.x + rect.w || n.y < rect.y || n.y >= rect.y + rect.h) continue;
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (grid[n.y][n.x] === 0) return { x: n.x + 0.5, y: n.y + 0.5 };
      queue.push(n);
    }
  }
  return p;
}

/**
 * Populate every corridor feature (see `dressCorridors`) with 1-3
 * "Edge Case" enemies — small, fast, low-HP nuisances that break up the
 * "endless walk" feeling of a long corridor stretch. Modeled directly on
 * `placeTodoEncounter`'s enemy branch: a synthetic `CodeEntity` stands in for
 * the (nonexistent) parsed entity a breakup room would otherwise need.
 *
 * **One half of the old structural guarantee here is gone.** It used to read
 * "never spawns in a normal AST-derived room, and normal enemies never spawn
 * here — both are guaranteed structurally". The second half still holds, for
 * exactly the reason it always did: this only ever iterates
 * `breakupRooms: Rect[]` and `spawnEnemies` only ever iterates `rooms: Room[]`.
 * The first half does not — `spawnEnemies` may now flag a `switch`-heavy room's
 * tail member `edgeCase`. Nothing about *this* function changed; read
 * `Enemy.edgeCase` as an archetype rather than as a location.
 *
 * No `multiplayerSpawns` avoid-list needed here, unlike `spawnEnemies`: a
 * breakup room is only ever injected where it doesn't overlap any real room
 * (`roomsOverlap(..., roomMargin)` in `breakup.ts`), and a multiplayer spawn
 * is always a real room's center — so one can never land inside a breakup
 * room's rect in the first place.
 */
export function spawnEdgeCaseEnemies(grid: Tile[][], breakupRooms: Rect[], exit: Point, rng: () => number): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of breakupRooms) {
    const count =
      EDGE_CASE_MIN_PER_ROOM + Math.floor(rng() * (EDGE_CASE_MAX_PER_ROOM - EDGE_CASE_MIN_PER_ROOM + 1));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };
    const entity: CodeEntity = {
      name: "EdgeCase",
      kind: "class",
      startLine: 0,
      endLine: 0,
      complexityScore: 1,
      nestingDepth: 0,
    };

    for (const rawPos of enemyPositions(room, count, exit, rng)) {
      const pos = nearestFloorInRect(grid, room, rawPos);
      const hp = EDGE_CASE_HP_MIN + Math.floor(rng() * (EDGE_CASE_HP_MAX - EDGE_CASE_HP_MIN + 1));
      enemies.push({
        x: pos.x,
        y: pos.y,
        hp,
        maxHp: hp,
        alive: true,
        attackCooldown: 0,
        hitFlash: 0,
        home,
        aggroed: false,
        discovered: false,
        roamX: pos.x,
        roamY: pos.y,
        fireCooldown: rng() * 2,
        entity,
        elite: false,
        edgeCase: true,
      });
    }
  }
  return enemies;
}

/**
 * Fractional spawn points for a room's enemy pack: the first at the room center,
 * the rest scattered randomly inside it. Any point landing on the exit tile, or
 * (for a multiplayer session) a point in `avoidSpawns`, is re-rolled (then
 * nudged to a corner as a last resort) so nothing hides it or spawns a player
 * on top of a monster.
 *
 * Every candidate is snapped to the center of whichever tile it falls in
 * before being returned — not left at its raw continuous (or, for the room
 * center, possibly boundary-straddling) coordinate. Two things otherwise leave
 * an enemy's collision box (`ENEMY_RADIUS` in `enemyAi.ts`) overlapping a
 * neighboring wall tile, which visually looks like it's embedded in the wall:
 * a room center calculated as `room.x + room.w / 2` lands exactly *on* a grid
 * line whenever `room.w`/`room.h` is even, straddling up to four tiles instead
 * of centering in one; and for a labyrinth room (deeply nested functions —
 * most of its bounding rectangle is actually wall, not floor), a fully
 * continuous random point can land close enough to an internal maze wall for
 * the same overlap even without hitting a boundary exactly. `clearCriticalTiles`
 * already force-clears the one tile under each enemy's *position* to
 * guarantee it's floor — snapping to that tile's center is what makes the
 * enemy's full collision box actually fit inside it, on every side.
 */
function enemyPositions(
  room: Rect,
  count: number,
  exit: Point,
  rng: () => number,
  avoidSpawns: readonly Point[] = [],
): Point[] {
  const spots: Point[] = [];
  const blocked = (p: Point): boolean => {
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    // Clearance, not just the tile itself — "the 'return' marker must never be
    // hidden under a monster" reads better with a little room around it. See
    // `EXIT_CLEARANCE_TILES` for why this is presentation and not mechanics:
    // enemies are not solid to the player, and the real exit gate keys off
    // `Enemy.home`, not proximity.
    if (Math.max(Math.abs(tx - exit.x), Math.abs(ty - exit.y)) <= EXIT_CLEARANCE_TILES) return true;
    return avoidSpawns.some((s) => tx === s.x && ty === s.y);
  };
  const randomInRoom = (): Point => ({
    x: room.x + 0.5 + rng() * (room.w - 1),
    y: room.y + 0.5 + rng() * (room.h - 1),
  });
  const tileCenter = (p: Point): Point => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 });

  for (let i = 0; i < count; i++) {
    // First enemy anchors at the room center; the rest scatter randomly.
    let p = tileCenter(i === 0 ? { x: room.x + room.w / 2, y: room.y + room.h / 2 } : randomInRoom());
    for (let guard = 0; blocked(p) && guard < 8; guard++) p = tileCenter(randomInRoom());
    if (blocked(p)) p = { x: room.x + 1.5, y: room.y + 1.5 }; // last-resort corner
    spots.push(p);
  }
  return spots;
}
