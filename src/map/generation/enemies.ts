// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Enemy spawn placement: complexity-scaled packs, Elites, and the Edge Case
 * enemies that populate corridor-breakup rooms. */
import type { CodeEntity } from "../../parser/types";
import type { Enemy, Point, Rect, Room, Tile } from "../types";
import { neighbors } from "./util";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

/** Extra enemies spawned per this many complexity points, beyond the first. */
const COMPLEXITY_PER_EXTRA_ENEMY = 10;
/**
 * Complexity at/above which a function spawns an Elite pack instead of a plain
 * one — this is exactly the complexity a plain pack would hit 5 members at
 * (`1 + floor(40/10)`), so "extreme complexity" means "would otherwise be the
 * biggest kind of pack, so make it a boss-tier encounter instead."
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
  for (const room of rooms) {
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
    const hp = elite
      ? Math.round(eliteTotal / count)
      : Math.max(HP_PER_COMPLEXITY, Math.round((complexity * HP_PER_COMPLEXITY) / count));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };

    for (const [index, pos] of enemyPositions(room, count, exit, rng, multiplayerSpawns).entries()) {
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
        // `damageMultiplierFor` (`enemyAi.ts:220`) applies
        // `ELITE_DAMAGE_MULTIPLIER` per *enemy*, so flagging all eight would
        // multiply the room's incoming DPS by the pack size and trade an
        // unwinnable fight for an unsurvivable one. It also keeps "one Elite
        // per Elite room" true for every report that counts the archetype.
        elite: elite && index === 0,
        edgeCase: false,
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
 * the (nonexistent) parsed entity a breakup room would otherwise need. Never
 * spawns in a normal AST-derived room, and normal enemies never spawn here —
 * both are guaranteed structurally, since `spawnEnemies` only ever iterates
 * `rooms: Room[]` and this only ever iterates `breakupRooms: Rect[]`.
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
