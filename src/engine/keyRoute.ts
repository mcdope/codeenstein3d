// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "I just bounced off a locked door — where do I go now?"
 *
 * **Why this exists.** Bumping a key-locked door pings that gate's key on the
 * minimap, and before 2026-08-21 it pinged *nothing at all* whenever that key
 * sat behind another locked door. Both halves of that were working as designed:
 * `placeKeys` never puts a key behind a lock the player has not already paid
 * for, and the ping deliberately refused to point at a key it could not reach,
 * on the reasoning that "a key behind another locked door isn't a suggestion".
 * Together they left the player with a colour name and silence.
 *
 * And the silent case was the *common* one, not an edge case. `placeKeyFor`'s
 * preferred tier puts each key in the room the previous gate just opened, so
 * chains are serial by construction: measured across 47 multi-gate levels in
 * git/curl/flask/django, **46 were fully serial**, the median level had exactly
 * one key reachable from spawn however many gates it had, and **116 of 163
 * doors (71%) had an unreachable key at the moment the player first met them**.
 *
 * So this answers the *next step* rather than the literal question. If the key
 * you asked for is reachable, that is the answer. If it is not, the answer is
 * the key that unblocks it — which is always reachable, because the level is
 * solvable in key order (`assertAllRoomsReachable`).
 *
 * **The algorithm is not new.** `placeKeys` and `assertAllRoomsReachable` both
 * already run this fixpoint — flood, collect the keys you can reach, open the
 * gates you now hold, flood again. This runs the same thing from the *player's*
 * tile instead of spawn, seeded with the keys they are already carrying. It is
 * kept here as a pure function rather than a third copy inside `engine.ts` so
 * it can be tested against a fixture grid without an engine.
 *
 * **Presentation only.** Nothing here touches simulation state, draws from the
 * seeded rng, or appears in a reconciliation snapshot — the whole locked-door
 * hint is a HUD cue. Cost is bounded by the caller: `cueLockedDoorHint` fires
 * at most once per ping window (~4s), and only on a door bump.
 */
import { gateIdAt } from "../map/gates";
import { DOOR_TILE, type GameMap, type KeyItem, type Point } from "../map/types";
import { isWall } from "./mapPredicates";

/**
 * What the player should go and get next.
 *
 * `direct` distinguishes the two cases the HUD words differently: the key they
 * asked for (`true`), or a different key that unblocks it (`false`, and the
 * toast names its colour).
 */
export interface KeyStep {
  key: KeyItem;
  direct: boolean;
}

/** Passable to a player who holds `opened`'s gates: ordinary walkable terrain,
 * plus the door tiles of gates whose key is already in hand.
 *
 * A held-but-unpushed door has to count as open, and that is a real fix rather
 * than a detail: the old ping floods with `PathField`, whose `isWall` calls any
 * still-`DOOR_TILE` solid, so a key sitting one unopened-but-owned door away
 * read as unreachable and the player was told nothing — or, worse, would now be
 * sent after a key they are already carrying. */
function passable(map: GameMap, x: number, y: number, opened: ReadonlySet<number>): boolean {
  if (!isWall(map, x, y)) return true;
  if (map.grid[y]?.[x] !== DOOR_TILE) return false;
  return opened.has(gateIdAt(map, x, y));
}

/** Tile keys reachable from `from`, treating `opened`'s gates as walked through.
 * 4-neighbour, same connectivity as every other flood in the codebase.
 *
 * Exported because "can the player get there right now, with the keys they are
 * holding" is needed by the proximity key hint as well as by `nextKeyStep`, and
 * `PathField` cannot answer it — see `passable`'s comment above for the
 * owned-but-unpushed door it gets wrong. Callers must keep this out of the
 * per-frame path: it floods the whole grid, so guard it behind a cheap
 * geometric test the way `cueNearbyKeyHint` does. */
export function reachable(map: GameMap, from: Point, opened: ReadonlySet<number>): Set<number> {
  const start = from.y * map.width + from.x;
  const seen = new Set<number>();
  if (!passable(map, from.x, from.y, opened)) return seen;
  seen.add(start);
  const stack: Point[] = [{ x: from.x, y: from.y }];
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = p.x + dx;
      const ny = p.y + dy;
      const id = ny * map.width + nx;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height || seen.has(id)) continue;
      if (!passable(map, nx, ny, opened)) continue;
      seen.add(id);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

const tileOf = (map: GameMap, key: KeyItem): number => Math.floor(key.y) * map.width + Math.floor(key.x);

/** Uncollected keys inside `region`, nearest-first by straight-line distance
 * from `from`. Straight-line rather than path length on purpose: every
 * candidate here is already *known* reachable, so this only breaks ties between
 * leads, and it costs no second flood to do it. */
function candidatesIn(map: GameMap, region: ReadonlySet<number>, from: Point, skip: ReadonlySet<number>): KeyItem[] {
  return map.keys
    .filter((k) => !k.collected && !skip.has(k.gateId) && region.has(tileOf(map, k)))
    .sort((a, b) => (a.x - from.x) ** 2 + (a.y - from.y) ** 2 - ((b.x - from.x) ** 2 + (b.y - from.y) ** 2));
}

/** Does the fixpoint ever reach `target`'s key, if `without`'s key is ignored? */
function targetReachableWithout(map: GameMap, from: Point, target: KeyItem, held: ReadonlySet<number>, without: number): boolean {
  const opened = new Set(held);
  for (let round = 0; round <= map.gates.length; round++) {
    const region = reachable(map, from, opened);
    if (region.has(tileOf(map, target))) return true;
    let grew = false;
    for (const k of map.keys) {
      if (k.collected || k.gateId === without || opened.has(k.gateId)) continue;
      if (!region.has(tileOf(map, k))) continue;
      opened.add(k.gateId);
      grew = true;
    }
    if (!grew) return false;
  }
  // Unreachable: every round either returns, or opens at least one gate, and
  // the loop is bounded by the gate count — so it cannot run out of rounds with
  // progress still being made. Kept as a total function rather than a `while
  // (true)` that a reader has to prove terminates.
  /* v8 ignore next -- @preserve */
  return false;
}

/**
 * The key to point the player at after they bump `targetGateId`'s door, or
 * `null` if there is genuinely nothing to follow.
 *
 * `from` is a tile coordinate (floored), `held` is the player's `heldGates`.
 *
 * Returns `direct: true` for the asked-for key, `direct: false` for a key that
 * unblocks it. `null` means no uncollected key is reachable at all, which
 * `assertAllRoomsReachable` makes vanishingly rare — it survives as the honest
 * answer rather than as a case worth inventing a message for.
 */
export function nextKeyStep(map: GameMap, from: Point, targetGateId: number, held: ReadonlySet<number>): KeyStep | null {
  const target = map.keys.find((k) => k.gateId === targetGateId && !k.collected);
  if (!target) return null;

  const here = reachable(map, from, held);
  if (here.has(tileOf(map, target))) return { key: target, direct: true };

  const leads = candidatesIn(map, here, from, held);
  if (leads.length === 0) return null;

  // Prefer a lead the target actually *depends* on, so the HUD's "first" is
  // true rather than merely plausible. `MAX_GATE_ROOMS` is 4, so this is at
  // most a handful of extra floods, once per ping window. When no single lead
  // is individually necessary — a level whose chain forks — the nearest one is
  // still reachable and still progress, which is what the player asked for.
  const necessary = leads.find((lead) => !targetReachableWithout(map, from, target, held, lead.gateId));
  return { key: necessary ?? leads[0], direct: false };
}
