// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Map data types produced by the procedural generator and consumed by the
 * raycaster. Like the parser layer, these are plain serializable structures —
 * the generator turns `ParsedFile` JSON into this and nothing more.
 */
import type { CodeEntity } from "../parser/types";

/**
 * A grid cell: 0 = empty floor, 1 = wall, 2 = hazard (acid, walkable),
 * 3 = locked door (solid until opened with a key, then becomes 0),
 * 4 = goto/label teleporter pad (walkable; warps the player elsewhere),
 * 5 = timed spike trap (walkable; damages only while in its active phase),
 * 6 = fake wall hiding a secret room (solid and indistinguishable from a
 * normal wall until interacted with, then becomes 0 permanently),
 * 7 = lore terminal (solid; renders as a distinct glowing wall texture,
 * readable from an adjacent tile),
 * 8 = keyless "branch door" on a Switchboard spoke (solid until pushed open
 * like a door, but costs no key, and renders with its own texture).
 */
export type Tile = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Tile value for a walkable hazard (acid pool) cell. */
export const HAZARD_TILE = 2;
/** Tile value for a locked door (blocks like a wall until a key opens it). */
export const DOOR_TILE = 3;
/** Tile value for a goto/label teleporter pad (walkable, not a wall). */
export const TELEPORTER_TILE = 4;
/** Tile value for a timed spike trap (walkable; see `SpikeTrap`). */
export const SPIKE_TRAP_TILE = 5;
/** Tile value for a fake wall hiding a secret room (solid; see `Tile`). */
export const SECRET_WALL_TILE = 6;
/** Tile value for a lore terminal wall (solid; see `Tile`). */
export const LORE_TILE = 7;
/**
 * Tile value for a keyless "branch door" — the mouth of a Switchboard spoke
 * (see `placeSwitchboards`). Blocks like `DOOR_TILE` and opens the same way (a
 * push turns it into plain floor `0`, permanently), but costs no dependency
 * key: a `switch`'s internal branching is control flow, not encapsulation, so
 * gating it behind a key would be wrong in-fiction *and* would bury a
 * private-method level in doors and keys. Rendered with its own texture so it
 * never reads as a key-locked door.
 */
export const BRANCH_DOOR_TILE = 8;

/** Tile coordinate (integer grid position). */
export interface Point {
  x: number;
  y: number;
}

/**
 * A plain axis-aligned tile rectangle: `[x, x+w)` × `[y, y+h)`. Used wherever
 * geometry needs to be checked/reused without carrying a `Room`'s `CodeEntity`
 * back-reference — e.g. a corridor-breakup room injected by
 * `dressCorridors`, which has no parsed entity behind it. `Room`
 * structurally satisfies this shape, so helpers that only need `x/y/w/h` can
 * take a `Rect` and work for both.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rectangular room carved for one code entity. Coordinates are the top-left
 * tile; the room spans `[x, x+w)` × `[y, y+h)`. Keeps a back-reference to the
 * entity so later stages (enemies, bosses) can scale off its complexity.
 */
export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center tile, used for corridors and spawn. */
  center: Point;
  entity: CodeEntity;
}

/**
 * An enemy spawned for a code entity (a function or method). Lives at a
 * fractional tile position and carries HP scaled from the entity's complexity.
 */
export interface Enemy {
  /** World position in fractional tile units. */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /**
   * Seconds remaining before this enemy can melee the player again. Ticked
   * down by the engine's enemy AI each frame; 0 means "ready to bite". Starts
   * at 0. (Behaviour lives in src/engine/enemyAi.ts — this stays plain data.)
   */
  attackCooldown: number;
  /**
   * Frames remaining for which the sprite renders tinted red after being hit
   * (a "bleed" flash). Ticked down by the engine each frame; 0 = normal color.
   * Starts at 0.
   */
  hitFlash: number;
  /**
   * Origin room's walkable rectangle (tile units): the enemy roams only within
   * `[x, x+w) × [y, y+h)` while idle, so it never wanders out of its room.
   */
  home: { x: number; y: number; w: number; h: number };
  /**
   * Whether the enemy is in the chase state. Set once the player comes within
   * aggro range, or instantly when the enemy is shot ("damage aggro"). Sticky:
   * an aggroed enemy keeps chasing even after the player leaves aggro range.
   */
  aggroed: boolean;
  /**
   * Whether the player has ever physically entered this enemy's room (an AABB
   * intersection between the player's collision box and `home`). Sticky, once
   * true stays true. Gates whether the always-on HUD minimap draws this enemy
   * at all — see `renderMinimap` in `raycaster.ts`.
   */
  discovered: boolean;
  /** Current roam destination (world coords) while idle; re-picked on arrival. */
  roamX: number;
  roamY: number;
  /**
   * Seconds until this enemy may fire its next ranged bolt. Ticks down each
   * frame and resets after a shot; randomized on spawn so a pack doesn't volley
   * in unison. Only fires while chasing with line of sight to the player.
   */
  fireCooldown: number;
  /** The function/method this enemy represents. */
  entity: CodeEntity;
  /**
   * The **anchor** of an "extreme complexity" function's boss-tier pack: higher
   * melee/ranged damage (see `enemyAi.ts` and `ENEMY_WEAPONS.elite`), a larger
   * sprite and a distinct tint (see `sprites.ts`), and a guaranteed high-value
   * drop on death instead of the normal loot roll.
   *
   * **Not "a single boss-tier enemy instead of a multi-member pack"**, which is
   * what this said until 2026-08-20 and which the Elite-pack split had already
   * made wrong. An Elite room's budget is `ELITE_HP_MULTIPLIER` times what one
   * enemy would have at that complexity (2x — see `generation/enemies.ts` for
   * why it came down from 4x), capped at `ELITE_MAX_MEMBERS * ELITE_MEMBER_HP_CAP`
   * and split across the pack like any other. Only the anchor carries this
   * flag: `damageMultiplier` applies per *enemy*, so flagging all eight would
   * multiply the room's incoming DPS by its size.
   */
  elite: boolean;
  /**
   * A weak, small, jarringly-tinted "bug in the system" enemy: very fast,
   * erratic idle roaming, low melee damage, and its own quick/weak/scattering
   * bolt (`ENEMY_WEAPONS.edgeCase`). It still uses the ordinary aggro/LOS/chase
   * state machine — only its constants and roam behaviour differ. Visuals
   * (small size, cyan tint) live in `sprites.ts`.
   *
   * **This used to say "never in a normal AST-derived room", and that stopped
   * being true on 2026-08-20.** It is spawned from three places now:
   * `spawnEdgeCaseEnemies` (the corridor features `dressCorridors` injects,
   * still the overwhelming majority), `placeSwitchboardEncounters` (a
   * Switchboard's case rooms — which was already true when the old wording was
   * written), and `spawnEnemies`, which may trade a `switch`-heavy function's
   * tail pack member for one. Read the flag as *which weapon and behaviour
   * this enemy has*, never as *where it came from*.
   */
  edgeCase: boolean;
}

/**
 * The one visual styleset a level keeps for its whole duration — an opaque
 * identifier as far as this layer is concerned. The map layer never learns
 * what a wall looks like; `src/engine/textures.ts` owns the id-to-pixels
 * table (wall/floor/door bitmaps, ceiling colour, automap wall colour), and
 * `generation/styleSet.ts` owns which id a given level gets.
 *
 * Only the *structural* surfaces vary between these. The gameplay-signal
 * textures — lore terminal, hazard/acid, teleporter pad, spike trap — are
 * identical in every styleset on purpose: "this tile will hurt me" must never
 * depend on which level you happen to be on.
 */
export type StyleSetId = "stone" | "rust" | "tech" | "marble" | "techCool";

/** Every `StyleSetId`, in a stable order — the iteration order for anything
 * that has to build one entry per styleset (`STYLE_PALETTES` in
 * `src/engine/textures.ts`, the WAD resolver's cross-styleset fallback in
 * `src/wad/loadWad.ts`). Kept beside the union so the two can't drift: a
 * `Record<StyleSetId, ...>` built from this fails to typecheck if a member is
 * added to one and not the other. */
export const STYLE_SET_IDS: readonly StyleSetId[] = ["stone", "rust", "tech", "marble", "techCool"];

/** The full generated level. */
export interface GameMap {
  width: number;
  height: number;
  /** Row-major grid; index as `grid[y][x]`. */
  grid: Tile[][];
  /**
   * `visited[y][x]` becomes true once a player has been on or next to that
   * tile. Same dimensions as `grid`; starts all-false. Team-shared in coop —
   * any player's reveal counts for everyone.
   *
   * **No longer what the automap draws.** That map dropped fog of war and now
   * renders the carved level from the moment it loads, like the corner minimap
   * always has. Two consumers remain, and both matter: the "100% Clear" score
   * bonus counts revealed walkable tiles (`RaycasterEngine`'s
   * `visitedWalkableCount`, `VISITED_REVEAL_RADIUS`), and the multiplayer
   * loot-drop markers still gate on it so a disconnected teammate's position
   * is not broadcast into a room nobody has entered.
   */
  visited: boolean[][];
  rooms: Room[];
  /**
   * Enclosed spaces injected mid-corridor by `dressCorridors`
   * (`mapGenerator.ts`) to break up otherwise-too-long straight sightlines.
   * Deliberately not part of `rooms` — they have no backing `CodeEntity`, so
   * kind-gated systems (enemies, doors, hazards, ...) never see them. Home to
   * the "Edge Case" enemies exclusively (see `Enemy.edgeCase`).
   */
  breakupRooms: Rect[];
  /** Player spawn, in a corner of the first room (clear of its enemy). */
  spawn: Point;
  /**
   * Spread spawn points for a multiplayer session, one per potential player
   * slot — undefined for a normal single-player generation call. Never used
   * by single-player code; `spawn` above remains the one true single-player
   * spawn, computed exactly as before. May be shorter than the requested
   * player count if the level doesn't have enough rooms — a session assigns
   * players via `multiplayerSpawns[i % multiplayerSpawns.length]`. See
   * `pickMultiplayerSpawns` (`generation/spawnExit.ts`).
   */
  multiplayerSpawns?: Point[];
  /** Enemies to populate the rooms (one per function/method). */
  enemies: Enemy[];
  /** Exit tile (the `return` statement) in the room furthest from spawn. */
  exit: Point;
  /** BFS-shortest walkable tile distance from `spawn` to `exit` (doors count
   * as passable — a perfect run always ends up opening every one of them
   * anyway). The scoring system's path-efficiency bonus compares this against
   * how much ground the player actually covered (see `src/engine/scoring.ts`). */
  shortestPathTiles: number;
  /** Generation-time hazard (acid) tiles: one pool per global-variable room,
   * plus each Exception Handling Zone's `try` gauntlet. Runtime-expanded Acid
   * Overflow tiles are deliberately NOT listed here — they live only in the
   * grid, see `acidOverflows` and `src/engine/acidOverflow.ts`. */
  hazards: Point[];
  /** Locked-door tiles guarding private/protected-method rooms — the flat
   * union of every `gates[].doors`, in the same order. */
  doors: Point[];
  /** The locked rooms, one per key. See `Gate`. */
  gates: Gate[];
  /** Collectible dependency keys scattered in reachable public areas — exactly
   * one per entry in `gates`. */
  keys: KeyItem[];
  /** Cosmetic, non-blocking props scattered in larger rooms (set dressing). */
  decorations: Decoration[];
  /** Goto/label teleporter pads — one entry per pad, each pointing at its
   * paired pad's position. */
  teleporters: Teleporter[];
  /** Timed spike traps, procedurally placed at corridor choke points. */
  spikeTraps: SpikeTrap[];
  /** Proximity mines, procedurally placed at corridor choke points. */
  mines: Mine[];
  /**
   * Sparse, statically-placed pickups — a backup source, not the primary one
   * (spawn heap + enemy loot drops cover most of a run). Almost always
   * bullets/rockets scattered by `placeAmmoPickups`; also carries the
   * high-value health/rockets left inside a secret room by `placeSecretRooms`
   * (see `AmmoPickup.kind`). See `LootDrop` for the runtime, enemy-death
   * equivalent.
   */
  ammoPickups: AmmoPickup[];
  /**
   * Wall tiles rendered as glowing "lore terminals" (`LORE_TILE`), each
   * carrying the source comment it was generated from. Interacting with one
   * from an adjacent tile pauses the game and shows its text (see
   * `placeLoreTerminals` in `mapGenerator.ts`).
   */
  loreTerminals: LoreTerminal[];
  /**
   * True for a "bonus level" generated from a header (or equivalent) file: a
   * distinct visual theme and a boosted loot rate, treating it as a restock
   * arena rather than a normal combat level (see `placeAmmoPickups` and
   * `rollLoot`).
   */
  bonusLevel: boolean;
  /**
   * Which visual styleset this level keeps throughout (see `StyleSetId`).
   * Derived purely from the parsed source's own content hash — see
   * `generation/styleSet.ts` for why it deliberately draws nothing from the
   * generator's shared `rng`. Being plain JSON it rides the multiplayer
   * `GameMap` transfer unchanged, so every peer renders the same level alike.
   */
  styleSet: StyleSetId;
  /** Number of secret rooms actually carved by `placeSecretRooms` — shown on
   * the level-start briefing so the player knows to watch the walls. */
  secretRoomCount: number;
  /**
   * "Switchboard" case dead-end rooms, one per `case` branch of a
   * switch-containing function, carved off that function's own room and
   * reached through a `BRANCH_DOOR_TILE` (see `placeSwitchboards`).
   * Deliberately not part of `rooms` — the same reasoning as `breakupRooms`:
   * they have no backing `CodeEntity`, so kind-gated systems (enemies, doors,
   * hazards, ...) never see them by construction rather than by guard clause.
   */
  switchboardRooms: Rect[];
  /** Sequential `try`/`catch`/`finally` gauntlets hung off a room that
   * contains one (see `placeExceptionZones`). */
  exceptionZones: ExceptionZone[];
  /** Third-party supply alcoves carved directly into the spawn room's wall,
   * one per few top-level imports (see `placeVendorDepots`). */
  vendorDepots: Rect[];
  /** Rooms whose floor floods with acid at runtime once a player walks in,
   * until the function's own enemy is killed (see `planAcidOverflows` and
   * `src/engine/acidOverflow.ts`). */
  acidOverflows: AcidOverflow[];
}

/**
 * A 3-part "Exception Handling Zone" generated from one `try`/`catch`/`finally`
 * construct: a hazard-heavy gauntlet, a restoration alcove at its end, then a
 * safe loot room past it. The three rects are laid out in a straight line away
 * from the anchor room and are always carved together or not at all.
 */
export interface ExceptionZone {
  /** The hazard-heavy `try` gauntlet — acid floor, spike traps, one mine. */
  tryRect: Rect;
  /** The `catch` alcove at its end, holding guaranteed restoration. */
  catchRect: Rect;
  /** The safe `finally` room past it, holding guaranteed standard loot. */
  finallyRect: Rect;
}

/**
 * A room that leaks. Once any living player enters `room`, `tiles` are turned
 * into `HAZARD_TILE` one at a time, `intervalSeconds` apart, until either the
 * list runs out or `enemies[enemyIndex].alive` goes false — kill the function
 * that's leaking and the leak stops.
 *
 * `tiles` is precomputed at generation time from the FINAL grid, breadth-first
 * outward from the room center, and every tile in it was plain floor (`0`) and
 * claimed by nothing else at that moment. That is what makes the runtime
 * expansion (a) fully deterministic with zero engine-side rng, (b) structurally
 * unable to overwrite a door/teleporter/spike/secret/lore/pre-existing-hazard
 * tile, and (c) confined to a tile set disjoint from every other runtime grid
 * mutation — which is what lets the acid stay off `pendingGridDelta` entirely
 * and leaves `RaycasterEngine.applyGridReconciliation`'s LOAD-BEARING
 * INVARIANT intact. See `src/engine/acidOverflow.ts`.
 */
export interface AcidOverflow {
  /** The flooding room's walkable rectangle (tile units). */
  room: Rect;
  /**
   * Index into `GameMap.enemies` of the enemy representing the leaking
   * function — killing it freezes the flood. Stable: `enemies` is fixed at
   * generation time and only ever appended to, never reordered.
   */
  enemyIndex: number;
  /** Ordered candidate tiles, claimed front to back. */
  tiles: Point[];
  /** Seconds between two consecutive tiles being claimed. Computed at
   * generation time and shipped here rather than recomputed per peer, so a
   * multiplayer guest can't drift on it. */
  intervalSeconds: number;
}

/** What a defeated enemy (or a scattered map pickup) can leave behind.
 * `"smg"`/`"gas"` (gdb's/Friday Hotfix's own ammo pools) used to be
 * `LootDrop`-only, but "Vendor Depot" alcoves stock them statically too — see
 * `AmmoPickup.kind`. `"key"` is still `LootDrop`-only: dropped at a coop player's
 * death position (held dependency keys are level-scoped and one-per-door, so
 * a dead player holding one until revive would soft-lock a door — see
 * `RaycasterEngine.killPlayer`), collectible by any living player. */
export type LootKind = "bullets" | "shells" | "rockets" | "smg" | "gas" | "health" | "swap" | "weapon";

/**
 * A dynamic loot drop left at a defeated enemy's death position. Spawned at
 * runtime by the engine and removed once the player walks over it — the
 * runtime counterpart to the map generator's statically-placed `AmmoPickup`.
 */
export interface LootDrop {
  /** World position in fractional tile units. */
  x: number;
  y: number;
  kind: LootKind;
  /** Overrides the kind's default pickup amount (elite kills drop more). Not
   * used for `"weapon"`. */
  amount?: number;
  /** For a `"weapon"` drop: which `WEAPONS` index it grants. */
  weaponIndex?: number;
  /** Stable multiplayer-reconciliation identity, assigned at push time —
   * `undefined` in single-player, which never reconciles. Not index-stable
   * (unlike `GameMap.enemies`/`.mines`), since drops are appended dynamically
   * during play — see `RaycasterEngine.pushLootDrop`'s doc comment for the
   * assignment scheme. */
  id?: string;
  /** Set only for a drop created by a player's inventory converting to loot
   * on disconnect (`multiplayer-netcode-spec.md` §5) — `undefined` for
   * every other drop source (enemy kill, death-key-drop). A tag rather than
   * a boolean deliberately, so a future drop origin can add its own value
   * instead of overloading this one. */
  source?: "disconnect";
}

/**
 * A sparse, statically-placed pickup scattered across the map at generation
 * time — a backup source, separate from enemy loot drops. `placeAmmoPickups`
 * only ever creates "bullets"/"rockets" ones; `placeSecretRooms` also drops
 * one guaranteed pickup (a bigger amount, see
 * `SECRET_LOOT_HEALTH_AMOUNT`/`SECRET_LOOT_ROCKETS_AMOUNT`/`SECRET_LOOT_SWAP_AMOUNT`,
 * or a still-unowned weapon unlock) inside each secret room it carves, which
 * is why the type covers more than just ammo; `placeVendorDepots` adds the
 * `"smg"`/`"gas"` pools on top, gated on the player already owning the weapon
 * each one feeds (see `placeVendorDepots`).
 */
export interface AmmoPickup {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  kind: "bullets" | "shells" | "rockets" | "smg" | "gas" | "health" | "swap" | "weapon";
  /** Unused (0) for a `"weapon"` pickup — see `weaponIndex` instead. */
  amount: number;
  /** Only set for a `"weapon"` pickup: which `WEAPONS` index it grants (or,
   * if already owned by the time it's collected, tops up that weapon's ammo
   * pool instead — see `RaycasterEngine`'s `grantOrTopUpWeapon`). */
  weaponIndex?: number;
  collected: boolean;
}

/**
 * A glowing wall texture generated from a large source comment (see
 * `placeLoreTerminals` in `mapGenerator.ts`). Solid, like a normal wall —
 * interacting with it from an adjacent tile pauses the game and shows `text`.
 */
export interface LoreTerminal {
  /** Tile coordinates (integers) of the wall tile itself. */
  x: number;
  y: number;
  text: string;
}

/** A collectible "dependency key" — opens every door of its own gate, and is
 * never spent (see `Gate`). */
export interface KeyItem {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  collected: boolean;
  /** Which `Gate` this key belongs to — its `id`, i.e. its index in
   * `GameMap.gates`. Exactly one key exists per gate; `placeKeys` guarantees
   * it, and `assertAllRoomsReachable` relies on it. */
  gateId: number;
}

/** How many distinct gate colours exist. The gate cap is kept at or below this
 * so no level ever reuses one — "the blue door is the way on" has to stay true
 * within a level. The map layer only knows the *count* and an index; the
 * engine owns which pixels each index means, exactly as it does for
 * `StyleSetId`. */
export const GATE_COLOR_COUNT = 4;

/**
 * One locked room, and the single key that opens it.
 *
 * A key belongs to a *room*, not a doorway. Before this existed the engine
 * spent one key per doorway, so a room with six mouths cost six keys for one
 * space, and re-opening a door from the other side charged again — which reads
 * as a bug to anyone playing it. `MAX_GATE_ROOMS` now budgets rooms, and a
 * player holding this gate's key can push open any of its doors, permanently.
 *
 * `doors` is a partition of `GameMap.doors`, in the same order, so anything
 * iterating the flat list (the minimap, the route planner's greedy order) is
 * unaffected by gates existing.
 */
export interface Gate {
  /** Index into `GameMap.gates`. */
  id: number;
  /** 0..`GATE_COLOR_COUNT`-1, distinct within a level. */
  colorIndex: number;
  /** The gated room's rect. */
  room: Rect;
  /** Every door tile of this gate. */
  doors: Point[];
}

/** Visual flavor of a decorative prop; purely cosmetic, no gameplay effect. */
export type DecorKind = "rack" | "plant" | "desk" | "block";

/**
 * A cosmetic, non-blocking set-dressing sprite (server rack, potted plant,
 * desk, or abstract code-block) scattered in larger rooms so they don't feel
 * like an empty wasteland. Purely decorative: no collision, no interaction.
 */
export interface Decoration {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  kind: DecorKind;
}

/**
 * One pad of a bidirectional goto↔label teleporter pair, generated from a
 * `goto` statement and the label it jumps to (see `GotoLink`). Stepping onto
 * this pad's tile warps the player to (`targetX`, `targetY`) — the paired
 * pad's center. Each resolved goto link contributes two `Teleporter` entries,
 * one per pad, each pointing at the other.
 */
export interface Teleporter {
  /** World position in fractional tile units (this pad's tile center). */
  x: number;
  y: number;
  /** World position of the paired pad this one warps the player to. */
  targetX: number;
  targetY: number;
  /** The label name, for HUD/debug display. */
  label: string;
}

/**
 * A timed spike trap tile (grid value `SPIKE_TRAP_TILE`): alternates between a
 * safe first half and a damaging second half of each `period`-second cycle.
 * `phase` offsets that cycle per-trap so a level's traps don't all click in
 * unison. Always walkable — only the active half deals damage.
 */
export interface SpikeTrap {
  /** Tile coordinates (integers). */
  x: number;
  y: number;
  /** Full safe→active→safe cycle length, in seconds. */
  period: number;
  /** Per-trap offset into the cycle, in seconds. */
  phase: number;
}

/**
 * A proximity mine: invisible until the player lingers within its trigger
 * radius, then detonates for AoE damage if they don't back off in time.
 * One-shot — `alive` goes false forever once it detonates. Runtime behavior
 * lives in `src/engine/traps.ts`; this stays plain data.
 */
export interface Mine {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  /** False once detonated (consumed; no longer rendered or dangerous). */
  alive: boolean;
  /**
   * True once the player has come within the proximity radius at least once.
   * Sticky, like `Enemy.discovered` — a spotted mine stays visible even after
   * the player backs away.
   */
  visible: boolean;
  /** Seconds the player has been continuously within the proximity radius;
   * resets to 0 the moment they back out of it. Detonates on reaching the fuse
   * threshold — see `MINE_FUSE_SECONDS` in `traps.ts`. */
  closeTimer: number;
}
