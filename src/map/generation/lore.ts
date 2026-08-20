// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Lore terminals from large source comments, and the TODO/FIXME "technical
 * debt" encounters (trap/mine/Bug) placed beside flagged terminals. */
import type { CodeComment, CodeEntity } from "../../parser/types";
import { isTodoFlagged } from "../../parser/astUtils";
import { LORE_TILE, SPIKE_TRAP_TILE, type Enemy, type LoreTerminal, type Mine, type Point, type Room, type SpikeTrap, type Tile } from "../types";
import { roomForLine } from "./geometry";
import { fnv1a } from "./seed";
import { SPIKE_PERIOD_MAX, SPIKE_PERIOD_MIN, TRAP_SPACING } from "./trapsHazards";
import { dist, key, neighbors, shuffle } from "./util";

/** How many lore terminals any single file may spawn, so a huge file doesn't
 * wallpaper every room in glowing text. Which comments are even eligible is a
 * separate gate that lives in the parser — `LORE_COMMENT_MIN_LENGTH` in
 * `astUtils.ts`, plus the multi-line and TODO/FIXME bypass rules in
 * `extractLargeComments`. */
const MAX_LORE_TERMINALS = 6;

/** Flat HP for a TODO/FIXME "Bug" enemy — well under `HP_PER_COMPLEXITY`
 * (25, the existing floor for a normal complexity-scaled enemy from
 * `spawnEnemies`), so it reads as a minor nuisance, not a real fight. */
const TODO_BUG_HP = 10;

/**
 * Turn each large source comment into a glowing "lore terminal": a normal
 * wall tile, just outside whichever room contains the comment's source line,
 * re-tagged `LORE_TILE` so the raycaster renders it distinctly. Never a hard
 * failure — a comment whose room has no free wall tile left simply doesn't
 * get one. A TODO/FIXME-flagged comment (see `isTodoFlagged`) also gets a
 * small "technical debt" encounter — a timed spike trap, a proximity mine, or
 * a weak "Bug" enemy, picked per-instance via the seeded `rng` — on the floor
 * tile just inside the room, right next to its terminal. Never placed within
 * `TRAP_SPACING` of `spawn`, same as every other hazard system, so a comment
 * that happens to resolve to the spawn room can't ambush the player before
 * they can react.
 */
export function placeLoreTerminals(
  rooms: Room[],
  grid: Tile[][],
  comments: CodeComment[],
  rng: () => number,
  spawn: Point,
): { terminals: LoreTerminal[]; todoTraps: SpikeTrap[]; todoMines: Mine[]; todoEnemies: Enemy[] } {
  const terminals: LoreTerminal[] = [];
  const todoTraps: SpikeTrap[] = [];
  const todoMines: Mine[] = [];
  const todoEnemies: Enemy[] = [];
  const used = new Set<string>();
  const claimedFloor = new Set<string>();

  for (const comment of comments.slice(0, MAX_LORE_TERMINALS)) {
    const room = roomForLine(rooms, comment.startLine) ?? rooms[0];
    if (!room) continue;
    const spot = findWallPerimeterSpot(room, grid, used, rng);
    if (!spot) continue;
    used.add(key(spot));
    grid[spot.y][spot.x] = LORE_TILE;
    terminals.push({ x: spot.x, y: spot.y, text: comment.text });

    if (isTodoFlagged(comment.text)) {
      const encounter = placeTodoEncounter(room, grid, spot, comment, claimedFloor, rng, spawn);
      if (encounter && "trap" in encounter) todoTraps.push(encounter.trap);
      else if (encounter && "mine" in encounter) todoMines.push(encounter.mine);
      else if (encounter) todoEnemies.push(encounter.enemy);
    }
  }
  return { terminals, todoTraps, todoMines, todoEnemies };
}

/** The floor tile just inside `room`, adjacent to `spot` — `spot` (from
 * `findWallPerimeterSpot`) always sits exactly one tile outside one of the
 * room's four sides, so this deterministically steps back in from it. */
function interiorNeighborOf(room: Room, spot: Point): Point {
  if (spot.y === room.y - 1) return { x: spot.x, y: room.y };
  if (spot.y === room.y + room.h) return { x: spot.x, y: room.y + room.h - 1 };
  if (spot.x === room.x - 1) return { x: room.x, y: spot.y };
  return { x: room.x + room.w - 1, y: spot.y };
}

/**
 * Places a small "technical debt" encounter — a timed spike trap, a
 * proximity mine, or a weak "Bug" enemy, each equally likely — on a free
 * floor tile next to a TODO/FIXME terminal's `spot`. Deliberately a *trap*
 * or *mine* (both reusing `placeTraps`' own shapes/mechanics), not a
 * `fillHazards`-style permanent acid pool: the candidate tile is right where
 * the player has to stand to interact with the terminal, and a permanently
 * damaging tile there would make it painful to ever reach rather than just
 * riskier — a trap/mine keeps a genuine safe approach instead. Never a hard
 * failure — a room with no free adjacent floor tile simply gets nothing, and
 * the same holds if every free tile is within `TRAP_SPACING` of `spawn` (a
 * TODO comment can resolve to the spawn room itself), so the player can never
 * take unavoidable damage in the first instants of a level.
 */
function placeTodoEncounter(
  room: Room,
  grid: Tile[][],
  spot: Point,
  comment: CodeComment,
  claimedFloor: Set<string>,
  rng: () => number,
  spawn: Point,
): { trap: SpikeTrap } | { mine: Mine } | { enemy: Enemy } | null {
  const anchor = interiorNeighborOf(room, spot);
  const candidates = [anchor, ...neighbors(anchor)];
  shuffle(candidates, rng);
  const free = candidates.filter(
    (p) =>
      grid[p.y]?.[p.x] === 0 &&
      !claimedFloor.has(key(p)) &&
      dist(p.x + 0.5, p.y + 0.5, spawn.x + 0.5, spawn.y + 0.5) >= TRAP_SPACING,
  );
  if (free.length === 0) return null;

  const p = free[0];
  claimedFloor.add(key(p));

  // Which of the three outcomes this TODO gets is derived from the comment's
  // own text, NOT from `rng()`.
  //
  // **Why this is not a roll.** Each TODO used to draw `rng()` and split it
  // into thirds, so the campaign's mix of trap/mine/Bug was a property of the
  // shared PRNG stream — and therefore re-rolled by any change that shifted
  // that stream, however unrelated. `verify:campaign` asserts all three
  // outcomes appear somewhere in the demo campaign (it is the showcase
  // campaign; a mechanic that stops being demonstrated is a real regression),
  // and with the 8 TODO encounters the campaign actually carries, the chance
  // some outcome went missing was ~12% for *any* rng-shifting edit. It duly
  // fired: the coloured-keys change deleted the trap outcome outright, and was
  // only rescued by authoring another TODO.
  //
  // Hashing the text removes the coupling rather than reducing it. The mix is
  // now a fixed property of the campaign's own source comments: it cannot be
  // disturbed by a change to keys, weapons, enemies or anything else that
  // draws from `rng`, and if an author does need a different outcome they edit
  // that comment's wording and it stays edited.
  //
  // Measured on the real campaign before landing: trap 4 / mine 3 / Bug 1
  // across its 8 TODO comments, so the coverage check passes with all three
  // present.
  //
  // **That "Bug 1" was load-bearing on a coincidence, and it broke again on
  // 2026-08-20.** Hashing the text removed the *rng* coupling, but not the
  // other one: an encounter still needs a free floor tile near its terminal
  // (`free.length === 0` above), and raising enemy density crowded that tile
  // out on the one level whose TODO hashed to Bug — so the campaign spawned
  // zero of them while every comment stayed exactly as authored. Rescued the
  // same way the keys change was, by authoring more Bug-hashing TODOs; there
  // are now three across three levels (`stage06_pipeline.py`,
  // `stage09_worker.go`, `stage11_core_service.cs`), so the check no longer
  // rests on a single placement succeeding. If you are here because it failed
  // again, add a fourth rather than relaxing the check — it is guarding a
  // mechanic the showcase campaign is supposed to showcase. (The backlog's own proposal — cycle the outcomes per level —
  // could not have worked: it guarantees all three only on a level holding
  // three TODOs, and no level holds more than two. Cycling from a fixed start
  // would have given seven levels a trap and produced no Bug enemy at all.)
  const outcome = fnv1a(comment.text) % 3;
  if (outcome === 0) {
    grid[p.y][p.x] = SPIKE_TRAP_TILE;
    return {
      trap: {
        x: p.x,
        y: p.y,
        period: SPIKE_PERIOD_MIN + rng() * (SPIKE_PERIOD_MAX - SPIKE_PERIOD_MIN),
        phase: rng() * SPIKE_PERIOD_MAX,
      },
    };
  }

  if (outcome === 1) {
    // Mines stay on plain floor (tile 0) — same as `placeTraps`' own mines,
    // invisible until triggered, so nothing marks the grid tile itself.
    return { mine: { x: p.x + 0.5, y: p.y + 0.5, alive: true, visible: false, closeTimer: 0 } };
  }

  const entity: CodeEntity = {
    name: "Bug",
    kind: "class",
    startLine: comment.startLine,
    endLine: comment.endLine,
    complexityScore: 1,
    nestingDepth: 0,
  };
  return {
    enemy: {
      x: p.x + 0.5,
      y: p.y + 0.5,
      hp: TODO_BUG_HP,
      maxHp: TODO_BUG_HP,
      alive: true,
      attackCooldown: 0,
      hitFlash: 0,
      home: { x: room.x, y: room.y, w: room.w, h: room.h },
      aggroed: false,
      discovered: false,
      roamX: p.x + 0.5,
      roamY: p.y + 0.5,
      fireCooldown: rng() * 2,
      entity,
      elite: false,
      edgeCase: false,
    },
  };
}

/** A still-untouched wall tile (`grid` value `1`) on `room`'s own perimeter,
 * not already claimed by an earlier call — used by lore terminal placement,
 * which (unlike a door/corridor mouth) doesn't need floor on the far side. */
function findWallPerimeterSpot(
  room: Room,
  grid: Tile[][],
  used: Set<string>,
  rng: () => number,
): Point | null {
  const candidates: Point[] = [];
  for (let x = room.x; x < room.x + room.w; x++) {
    candidates.push({ x, y: room.y - 1 });
    candidates.push({ x, y: room.y + room.h });
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    candidates.push({ x: room.x - 1, y });
    candidates.push({ x: room.x + room.w, y });
  }
  shuffle(candidates, rng);
  for (const c of candidates) {
    if (used.has(key(c))) continue;
    if (grid[c.y]?.[c.x] === 1) return c;
  }
  return null;
}
