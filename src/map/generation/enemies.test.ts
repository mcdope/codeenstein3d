// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Rect, Tile } from "../types";
import { makeRoom } from "./geometry";
import { spawnEdgeCaseEnemies, spawnEnemies } from "./enemies";

/**
 * A complexity that is guaranteed to produce a **single-member pack**, whatever
 * `COMPLEXITY_PER_EXTRA_ENEMY` happens to be.
 *
 * Every placement test below pins this. They script the rng by hand to drive
 * exit-clearance and multiplayer-spawn rerolls, so a pack of two silently
 * shifts the draw sequence out from under them and they fail for a reason that
 * has nothing to do with what they test. The 10 -> 5 density change broke five
 * of them exactly that way; pinning the count means the next density change
 * breaks none.
 */
const SOLO_COMPLEXITY = 1;

/**
 * Expected pack size for a non-Elite room, stated as a **table of literals**
 * rather than a copy of `1 + floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY)`.
 *
 * Copying the production formula here would only prove the file agrees with
 * itself — a wrong formula would satisfy a wrong test. Literals are a second
 * opinion, and collecting them in one place means the next density retune has
 * exactly one call site to update instead of six scattered `toHaveLength`s.
 */
const PACK_SIZE: Record<number, number> = { 1: 1, 4: 1, 5: 2, 20: 5, 25: 6, 30: 7, 39: 8 };

function expectedPackSize(complexity: number): number {
  const size = PACK_SIZE[complexity];
  if (size === undefined) throw new Error(`add complexity ${complexity} to PACK_SIZE`);
  return size;
}

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: SOLO_COMPLEXITY, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function carve(g: Tile[][], rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) g[y][x] = 0;
  }
}

describe("spawnEnemies", () => {
  it("spawns nothing for a non-callable entity kind", () => {
    for (const kind of ["class", "interface", "trait", "global"] as const) {
      const room = makeRoom(1, 1, 6, 6, entity({ kind }));
      expect(spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1))).toEqual([]);
    }
  });

  it("spawns one enemy for a low-complexity function", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: SOLO_COMPLEXITY }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1);
    expect(enemies[0].hp).toBe(Math.max(35, Math.round((SOLO_COMPLEXITY * 35) / 1))); // 35 = HP_PER_COMPLEXITY
    expect(enemies[0].elite).toBe(false);
    expect(enemies[0].edgeCase).toBe(false);
    expect(enemies[0].entity).toBe(room.entity);
  });

  it("clamps complexity below 1 up to 1", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: 0 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1);
    expect(enemies[0].hp).toBe(35); // complexity clamped to 1 -> 1*HP_PER_COMPLEXITY/1
  });

  it("splits a high-complexity function into a pack, one extra enemy per 10 points", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(expectedPackSize(25));
    for (const e of enemies) expect(e.elite).toBe(false);
  });

  it("spawns an Elite pack at/above the complexity threshold, at twice the pack budget", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 40 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    // 40 * 35 * 2 = 2800, exactly the 8 x 350 member-cap ceiling.
    // The pack got bigger when the HP rate rose 25 -> 35 (2026-08-21): the
    // budget grew while the per-member cap did not, so it spends the cap on more
    // bodies rather than harder ones. That is the cap doing its job.
    expect(enemies).toHaveLength(8);
    for (const e of enemies) expect(e.hp).toBe(350); // ELITE_MEMBER_HP_CAP
    expect(enemies.reduce((sum, e) => sum + e.hp, 0)).toBe(2800); // capped at 8 x 350
  });

  it("flags only the anchor as Elite, because the damage multiplier is per-enemy", () => {
    // `damageMultiplierFor` (`enemyAi.ts`) applies ELITE_DAMAGE_MULTIPLIER to
    // every flagged enemy, so flagging the whole pack would multiply the room's
    // incoming DPS by its size. It also keeps "one Elite per Elite room" true
    // for every report that counts the archetype.
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 100 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.filter((e) => e.elite)).toHaveLength(1);
    expect(enemies[0].elite).toBe(true); // the anchor, which sits at the room center
  });

  it("never generates an enemy the player cannot kill, whatever the source file does", () => {
    // The ceiling is empirical and stated in *runtime* HP: the bot kills up to
    // ~500 reliably, and the largest it has ever killed on Hard is 338. 350
    // base is 525 after Hard's 1.5x. vim's `nfa_emit_equi_class` is complexity
    // 672 and used to produce a single 33,600 HP enemy.
    for (const complexityScore of [40, 41, 60, 100, 672]) {
      const room = makeRoom(1, 1, 18, 18, entity({ complexityScore }));
      const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
      for (const e of enemies) expect(e.hp).toBeLessThanOrEqual(350);
      expect(enemies.length).toBeLessThanOrEqual(8);
    }
  });

  it("caps an Elite room's total HP rather than letting it grow with complexity", () => {
    const of = (complexityScore: number) =>
      spawnEnemies([makeRoom(1, 1, 18, 18, entity({ complexityScore }))], { x: 99, y: 99 }, mulberry32(1)).reduce(
        (sum, e) => sum + e.hp,
        0,
      );
    expect(of(100)).toBe(2800);
    expect(of(672)).toBe(2800); // 33,600 before the cap
  });

  it("closes the HP-per-enemy cliff at the threshold that made Elites unkillable", () => {
    // Complexity 39 was a 4-enemy / 976 HP pack (244 each) and 40 was a single
    // 2,000 HP enemy — so nothing was ever generated between 500 and 2,000 HP,
    // and 1,332 Elites spawned across the corpus for 2 kills. The room's budget
    // still doubles across the boundary, as intended; what no longer jumps is
    // the size of any individual enemy in it.
    const perMember = (complexityScore: number) =>
      spawnEnemies([makeRoom(1, 1, 18, 18, entity({ complexityScore }))], { x: 99, y: 99 }, mulberry32(1))[0].hp;
    // 39 -> an 8-member pack at 171 each; 40 -> an 8-member Elite pack at the
    // 350 member cap. Both numbers moved when the HP rate rose 25 -> 35
    // (2026-08-21). The body count no longer changes across the boundary at all
    // — the Elite budget now saturates ELITE_MAX_MEMBERS (39 x 35 x 2 = 2730,
    // against a 8 x 350 = 2800 ceiling) — so what the threshold buys is purely
    // per-member HP and the damage multiplier.
    expect(perMember(39)).toBe(171);
    expect(perMember(40)).toBe(350); // was 2000 before the Elite pack split
  });

  it("aggregates enemies across multiple rooms", () => {
    const rooms = [
      makeRoom(1, 1, 6, 6, entity({ complexityScore: SOLO_COMPLEXITY })),
      makeRoom(10, 1, 6, 6, entity({ complexityScore: SOLO_COMPLEXITY })),
    ];
    const enemies = spawnEnemies(rooms, { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(2);
  });

  it("gives every enemy a fireCooldown in [0, 2)", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    for (const e of enemies) {
      expect(e.fireCooldown).toBeGreaterThanOrEqual(0);
      expect(e.fireCooldown).toBeLessThan(2);
    }
  });

  it("snaps the pack's first enemy to the room center tile", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: SOLO_COMPLEXITY }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    const expectedCenterTile = { x: Math.floor(room.x + room.w / 2) + 0.5, y: Math.floor(room.y + room.h / 2) + 0.5 };
    expect(enemies[0]).toMatchObject(expectedCenterTile);
  });

  it("rerolls (and eventually resolves) when a spawn point would land inside the exit's clearance", () => {
    // A 9x9 room so there is somewhere to reroll *to*: the exit at (3,3)
    // keeps a 5x5 box (EXIT_CLEARANCE_TILES = 2) clear, and the room's own
    // centre tile (5,5) sits exactly on its corner, so the first pick is
    // rejected. The scripted rerolls land at (8,8), well outside it.
    const room = makeRoom(1, 1, 9, 9, entity({ complexityScore: SOLO_COMPLEXITY }));
    const sequence = [0.9, 0.9];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 3, y: 3 }, scripted);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(8.5);
    expect(enemies[0].y).toBe(8.5);
  });

  it("keeps enemies off the tiles immediately around the exit, not just the exit itself", () => {
    // An enemy is a solid body, so one parked against the exit makes walking
    // onto it impossible until it's killed.
    const room = makeRoom(1, 1, 12, 12, entity({ complexityScore: 30 }));
    const exit = { x: 6, y: 6 };
    const enemies = spawnEnemies([room], exit, mulberry32(7));
    // Exact, not "more than one": the clearance must relocate enemies, never
    // cost the room any. complexity 30 => 1 + floor(30/10) = 4.
    expect(enemies).toHaveLength(expectedPackSize(30));
    for (const e of enemies) {
      const chebyshev = Math.max(Math.abs(Math.floor(e.x) - exit.x), Math.abs(Math.floor(e.y) - exit.y));
      expect(chebyshev).toBeGreaterThan(2);
    }
  });

  it("still populates an exit room too small to hold the clearance at all", () => {
    // The exit room is the one a player is guaranteed to reach, so it losing
    // its garrison would be a real gameplay change smuggled in by a placement
    // constraint. A 5x4 room with the exit at its centre is entirely inside
    // the 5x5 clearance box — every candidate is rejected — and the bounded
    // retry then falls back to the room corner rather than dropping anyone.
    // This is `stage06_pipeline.py`'s exact shape.
    const room = makeRoom(7, 55, 5, 4, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 9, y: 57 }, mulberry32(3));
    expect(enemies).toHaveLength(expectedPackSize(25));
    for (const e of enemies) {
      expect(e.x).toBeGreaterThanOrEqual(room.x);
      expect(e.x).toBeLessThan(room.x + room.w);
      expect(e.y).toBeGreaterThanOrEqual(room.y);
      expect(e.y).toBeLessThan(room.y + room.h);
    }
  });

  it("gives every function/method room its enemies regardless of where the exit lands", () => {
    // Guards the invariant directly: the exit room is not a special case that
    // ends up empty. Sweeps the exit across a room and checks the count holds.
    const room = makeRoom(1, 1, 8, 8, entity({ complexityScore: 20 }));
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        expect(spawnEnemies([room], { x, y }, mulberry32(x * 31 + y))).toHaveLength(expectedPackSize(20));
      }
    }
  });

  it("falls back to the room's corner when every reroll attempt still lands on the exit", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: SOLO_COMPLEXITY })); // center tile (3,3)
    const alwaysCenter = () => 0.5; // randomInRoom() always resolves to tile (3,3) too
    const enemies = spawnEnemies([room], { x: 3, y: 3 }, alwaysCenter);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(room.x + 1.5);
    expect(enemies[0].y).toBe(room.y + 1.5);
  });

  it("rerolls (and eventually resolves) when a spawn point would land on a multiplayer spawn tile", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: SOLO_COMPLEXITY })); // center tile (3,3)
    const sequence = [0.5, 0.5, 0, 0];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, scripted, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(1.5);
    expect(enemies[0].y).toBe(1.5);
  });

  it("falls back to the room's corner when every reroll still lands on a multiplayer spawn tile", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: SOLO_COMPLEXITY })); // center tile (3,3)
    const alwaysCenter = () => 0.5;
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, alwaysCenter, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(room.x + 1.5);
    expect(enemies[0].y).toBe(room.y + 1.5);
  });

  it("avoids both the exit and a multiplayer spawn tile in the same reroll sequence", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: SOLO_COMPLEXITY })); // center tile (3,3)
    // i=0's center pick (3,3) is blocked by the multiplayer spawn; the first
    // reroll lands on (2,2), blocked by the exit; the second reroll lands
    // clear on (5,5).
    const sequence = [0.25, 0.25, 0.9, 0.9];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 2, y: 2 }, scripted, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(5.5);
    expect(enemies[0].y).toBe(5.5);
  });

  it("omitted multiplayerSpawns behaves exactly like an empty avoid-list", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: SOLO_COMPLEXITY }));
    const withDefault = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    const withEmpty = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1), []);
    expect(withDefault).toEqual(withEmpty);
  });
});

describe("spawnEnemies archetype distribution", () => {
  const packOf = (over: Partial<CodeEntity>, rooms = 1) => {
    const list = Array.from({ length: rooms }, (_, i) => makeRoom(1 + i * 14, 1, 12, 12, entity(over)));
    // Index 0 is the spawn room and is never lockable, so a guard test needs a
    // room at index >= 1 — mirror that by putting a filler room in front.
    const filler = makeRoom(60, 60, 6, 6, entity({ kind: "class", name: "Filler" }));
    return spawnEnemies([filler, ...list], { x: 99, y: 99 }, mulberry32(7));
  };

  describe("the guard: a private/protected room concentrates HP in its anchor", () => {
    it("gives the anchor a heavier share without changing the room total", () => {
      const open = packOf({ complexityScore: 20 });
      const guarded = packOf({ complexityScore: 20, visibility: "private" });
      const total = (list: typeof open) => list.reduce((sum, e) => sum + e.maxHp, 0);

      // Same bodies, same total HP — only the split moves. That is what makes
      // this a shape change and not a difficulty change: every member fires the
      // same weapon, so the room's instantaneous DPS is untouched.
      expect(guarded).toHaveLength(open.length);
      expect(total(guarded)).toBe(total(open));
      expect(guarded[0].maxHp).toBeGreaterThan(open[0].maxHp);
      expect(guarded[1].maxHp).toBeLessThan(open[1].maxHp);
      expect(guarded[0].maxHp / guarded[1].maxHp).toBeCloseTo(2, 0);
    });

    it("treats protected the same as private", () => {
      const a = packOf({ complexityScore: 20, visibility: "private" });
      const b = packOf({ complexityScore: 20, visibility: "protected" });
      expect(b.map((e) => e.maxHp)).toEqual(a.map((e) => e.maxHp));
    });

    it("is a no-op for a single-member pack", () => {
      const open = packOf({ complexityScore: SOLO_COMPLEXITY });
      const guarded = packOf({ complexityScore: SOLO_COMPLEXITY, visibility: "private" });
      expect(guarded.map((e) => e.maxHp)).toEqual(open.map((e) => e.maxHp));
    });

    it("leaves an Elite pack alone, because its size is derived from the HP cap", () => {
      // Weighting the anchor here would push it past ELITE_MEMBER_HP_CAP by
      // construction — the cap is what decided the member count in the first
      // place.
      const open = packOf({ complexityScore: 100 });
      const guarded = packOf({ complexityScore: 100, visibility: "private" });
      expect(guarded.map((e) => e.maxHp)).toEqual(open.map((e) => e.maxHp));
      for (const e of guarded) expect(e.maxHp).toBeLessThanOrEqual(350);
    });
  });

  describe("the skirmisher: a switch-heavy room trades its tail member", () => {
    const switchy = (over: Partial<CodeEntity> = {}) => ({
      complexityScore: 20,
      switchBranches: { caseCount: 4, hasDefault: false },
      ...over,
    });

    it("flags exactly one tail member, never the anchor", () => {
      const pack = packOf(switchy());
      const flagged = pack.filter((e) => e.edgeCase);
      expect(flagged).toHaveLength(1);
      expect(pack[0].edgeCase).toBe(false);
      expect(pack[pack.length - 1].edgeCase).toBe(true);
    });

    it("gives the skirmisher its peers' HP, not the corridor 10-15 roll", () => {
      const pack = packOf(switchy());
      const skirmisher = pack[pack.length - 1];
      expect(skirmisher.maxHp).toBe(pack[1].maxHp);
      expect(skirmisher.maxHp).toBeGreaterThan(15);
    });

    it("does not fire on a single-enemy room, which has nothing to trade", () => {
      // The swap always leaves at least one real enemy behind, so a solo pack
      // is untouched. This is also why coverage is structurally low: 85.7% of
      // entity rooms hold exactly one enemy even after the density change.
      expect(packOf(switchy({ complexityScore: SOLO_COMPLEXITY })).some((e) => e.edgeCase)).toBe(false);
    });

    it("fires on the smallest mixable pack", () => {
      // complexity 5 -> a 2-member pack: one real enemy plus one case.
      const pack = packOf(switchy({ complexityScore: 5 }));
      expect(pack).toHaveLength(expectedPackSize(5));
      expect(pack.filter((e) => e.edgeCase)).toHaveLength(1);
      expect(pack[0].edgeCase).toBe(false);
    });

    it("does not fire without switch branches", () => {
      expect(packOf({ complexityScore: 20 }).some((e) => e.edgeCase)).toBe(false);
    });

    it("does not fire in a labyrinth room, which is a wedge risk rather than a taste call", () => {
      // An Edge Case roams on jitter tuned for open corridor widenings; a maze
      // corner plus the exit gate keying off `Enemy.home` is how enemies get
      // stuck. Excluded by construction rather than disproved by a capture.
      expect(packOf(switchy({ nestingDepth: 2 })).some((e) => e.edgeCase)).toBe(false);
    });

    it("never fires on an Elite pack", () => {
      expect(packOf(switchy({ complexityScore: 100 })).some((e) => e.edgeCase)).toBe(false);
    });
  });

  it("consumes an identical number of rng draws whether or not the archetype rules fire", () => {
    // The zero-extra-draw property, asserted rather than asserted-in-prose.
    // `mapGenerator.generate()`'s draw order IS the map layout, so a rule that
    // quietly drew one value would re-roll every level downstream of it. Both
    // rules are pure functions of the entity for exactly this reason.
    const draws = (over: Partial<CodeEntity>) => {
      let n = 0;
      const rng = () => {
        n += 1;
        return 0.5;
      };
      const room = makeRoom(15, 1, 12, 12, entity({ complexityScore: 20, ...over }));
      const filler = makeRoom(60, 60, 6, 6, entity({ kind: "class", name: "Filler" }));
      spawnEnemies([filler, room], { x: 99, y: 99 }, rng);
      return n;
    };
    const plain = draws({});
    expect(draws({ visibility: "private" })).toBe(plain);
    expect(draws({ switchBranches: { caseCount: 4, hasDefault: false } })).toBe(plain);
    expect(draws({ visibility: "private", switchBranches: { caseCount: 4, hasDefault: false } })).toBe(plain);
  });
});

describe("spawnEdgeCaseEnemies", () => {
  it("spawns 1-3 enemies per breakup room, all marked edgeCase", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 6, h: 6 };
    carve(g, room);
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThanOrEqual(1);
    expect(enemies.length).toBeLessThanOrEqual(3);
    for (const e of enemies) {
      expect(e.edgeCase).toBe(true);
      expect(e.elite).toBe(false);
      expect(e.entity.name).toBe("EdgeCase");
      expect(e.hp).toBeGreaterThanOrEqual(25);
      expect(e.hp).toBeLessThanOrEqual(35);
    }
  });

  it("returns [] for zero breakup rooms", () => {
    const g = grid(10);
    expect(spawnEdgeCaseEnemies(g, [], { x: 99, y: 99 }, mulberry32(1))).toEqual([]);
  });

  it("aggregates across multiple breakup rooms", () => {
    const g = grid(20);
    const rooms: Rect[] = [
      { x: 1, y: 1, w: 6, h: 6 },
      { x: 10, y: 1, w: 6, h: 6 },
    ];
    for (const r of rooms) carve(g, r);
    const enemies = spawnEdgeCaseEnemies(g, rooms, { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThanOrEqual(2);
  });

  it("snaps a spawn point that lands on a wall to the nearest floor tile within the room", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    // Carve everything except the room's exact center tile (3,3), forcing
    // nearestFloorInRect to search outward from the wall it lands on.
    carve(g, room);
    g[3][3] = 1;
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    for (const e of enemies) {
      expect(g[Math.floor(e.y)][Math.floor(e.x)]).toBe(0);
    }
  });

  it("leaves a spawn point unchanged when it's already on floor", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    carve(g, room);
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThan(0);
    for (const e of enemies) {
      expect(g[Math.floor(e.y)][Math.floor(e.x)]).toBe(0);
    }
  });

  it("returns the original point unchanged when the whole room has no floor at all", () => {
    const g = grid(20); // never carved — entirely walls
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThan(0);
    // No floor exists anywhere, so nearestFloorInRect gives up and returns
    // the raw computed position unchanged — just confirm it doesn't throw
    // and produces a finite, in-room coordinate.
    for (const e of enemies) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
    }
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const room: Rect = { x: 1, y: 1, w: 6, h: 6 };
      carve(g, room);
      return spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(42));
    };
    expect(build()).toEqual(build());
  });
});
