// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A fingerprint of everything that decides how a recorded run plays back,
 * beyond the source file it was generated from.
 *
 * **Why this exists.** A replay is a raw input stream — `dt` plus a digested
 * `InputSnapshot` per frame (`replay.ts`) — replayed against a freshly built
 * engine. Its `astHash` covers *"parsed AST JSON + campaign name"*, which is
 * exactly the right guard for "did the source file change since". It is not a
 * guard for anything else, and the gap is not hypothetical: halving
 * `ELITE_HP_MULTIPLIER` changed generated enemy HP without touching a single
 * byte of any demo-campaign source, so `astHash` still matched and every
 * shipped replay whose final level contained an Elite would have played back
 * *silently diverged* — the same inputs against a differently balanced world,
 * showing a run that no longer matches its own recorded score.
 *
 * The general shape of that bug: enemy HP is generated **from** the AST rather
 * than being part of it, so any change to the generator or to a simulation
 * constant invalidates every existing replay while leaving `astHash` intact.
 *
 * **What it covers.** Two independent axes, because neither implies the other:
 *
 * 1. *The generated enemy roster* — taken from the freshly generated `GameMap`
 *    rather than from a list of the constants that produced it. That is
 *    deliberate: a maintained list has precisely the failure mode this guard
 *    exists to prevent (someone adds a balance constant and forgets to
 *    register it), whereas the roster is generator output by construction, so
 *    enemy HP, counts, kinds and placement are all in scope automatically.
 * 2. *Simulation constants the map cannot express* — player speed, weapon
 *    damage, projectile behaviour and similar live in the engine, never touch
 *    the map, and are supplied by the caller as `SIMULATION_BALANCE`.
 *
 * **Why only the roster, and not the whole map.** Measured: the generator's
 * weapon-ownership options (`hasRocketLauncher`/`hasSmg`/`hasGas`/
 * `missingWeaponIndices`) leave the enemy roster byte-identical but *do*
 * change `ammoPickups` and the grid — Vendor Depots stock what you already
 * own. And those options are not stable across record and playback: at record
 * time `main.ts` generates the map from `carryover`, while the segment stores
 * `effectiveCarryover`, which force-adds gdb/ghidra/Friday Hotfix at campaign
 * levels 4/8/12. So hashing pickups or layout would refuse perfectly good
 * replays whenever that safety net fires. (That asymmetry means playback
 * already rebuilds a slightly different map than was recorded — a real,
 * pre-existing issue tracked separately in `notes`; this guard is deliberately
 * scoped not to depend on it either way.)
 *
 * **What it deliberately does not cover.** Difficulty and gore are already
 * recorded per segment and applied at playback, so they are not balance drift.
 * Nor is anything that changes only *rendering*.
 *
 * **Call it on a freshly generated map, before any simulation.** Only the
 * roster's *static* fields are read (`x`, `y`, `maxHp`, `elite`) precisely
 * because the rest — `hp`, `alive`, `aggroed`, `roamX`/`roamY` — mutate during
 * play, and folding live state into the fingerprint would make it depend on
 * when it was taken. Both call sites (the recorder in `main.ts`, and
 * `buildEngineFor` at playback) hash the map immediately after generating it.
 */

/**
 * Deterministic JSON with object keys sorted at every level.
 *
 * `JSON.stringify` preserves insertion order, which is stable for objects
 * built by one version of the generator but not guaranteed across versions —
 * a purely cosmetic field reorder would otherwise invalidate every shipped
 * replay and demand a multi-hour regeneration for no behavioural reason.
 * Sorting keys means the fingerprint moves when the *values* move.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // No equal case: `Object.entries` keys are unique by construction, so a
    // three-way comparator would leave a branch that can never be taken.
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 of `text`, lowercase hex — same digest and encoding as `hashRun`. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The only `Enemy` fields the fingerprint reads — see the module comment on
 * why the mutable ones are excluded. Structural, so a real `GameMap` satisfies
 * it without this module importing the map types. */
export interface BalanceRelevantEnemy {
  x: number;
  y: number;
  maxHp: number;
  elite: boolean;
}

/**
 * Fingerprint of one level's balance: the generated enemy roster plus the
 * engine-side simulation constants in force.
 *
 * `map` must be freshly generated (see the module comment). `simulation` is
 * `SIMULATION_BALANCE` from `engine.ts`, passed in rather than imported so
 * this module stays free of any engine dependency and is trivially testable.
 *
 * Its values are `unknown`, not `number`: they started out as bare scalars,
 * but the `WEAPONS` table is now folded in wholesale (see `SIMULATION_BALANCE`
 * itself) rather than as a hand-picked list of the two or three weapon
 * constants someone happened to tune — the same "hash the output, not a
 * maintained list of inputs" reasoning the enemy roster already gets.
 * `stableStringify` recurses through arrays and nested objects and drops
 * `undefined` members, so a `readonly Weapon[]` with optional fields
 * serializes deterministically with no help from here.
 */
export async function computeBalanceHash(
  map: { enemies: readonly BalanceRelevantEnemy[] },
  simulation: Readonly<Record<string, unknown>>,
): Promise<string> {
  const roster = map.enemies.map((e) => [e.x, e.y, e.maxHp, e.elite ? 1 : 0]);
  return sha256Hex(stableStringify({ roster, simulation }));
}

/**
 * Whether a recorded `balanceHash` is still valid against the current build.
 *
 * `undefined` recorded means the run predates this guard. Those are accepted
 * rather than refused: the guard shipped alongside a `defaultHighscore.ts`
 * that has no hashes yet, and failing them closed would break the shipped
 * leaderboard's "Watch Replay" for every first-time visitor until a
 * multi-hour regeneration lands. They get the pre-existing behaviour — no
 * worse than before this module existed — and every run recorded from here on
 * is checked. Once the bundled entries carry hashes, this branch only affects
 * a player's own older local runs.
 */
export function balanceHashMatches(recorded: string | undefined, current: string): boolean {
  return recorded === undefined || recorded === current;
}
