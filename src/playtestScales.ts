// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * **Temporary. Delete this module when the backlog item that created it closes.**
 *
 * Two throwaway playtest knobs, wired 2026-08-23 for `notes`' "revisit enemy
 * dmg, seems a bit low". They exist to let a value be chosen *by play*, and the
 * moment one is, the chosen number moves into `combatConstants.ts` /
 * `loot.ts` and this file, its `<select>`s in `index.html`, its `main.ts`
 * wiring and the engine's constructor parameter all go with it.
 *
 * **Why they are not in `difficulty.ts`.** `DIFFICULTY_MULTIPLIERS` is a
 * shipped, player-facing concept whose values are recorded into replays and
 * shown on the highscore board. These are neither: they are dev-build-only,
 * never recorded anywhere, and deliberately kept in one deletable file so that
 * removing the experiment is a `git rm` plus four call sites rather than an
 * untangling job inside a module that has to keep working afterwards.
 *
 * **Why they are not in `combatConstants.ts`.** Every value-carrying export of
 * that module is folded into `COMBAT_BALANCE` -> `SIMULATION_BALANCE` ->
 * `balanceHash`, and `simulationBalanceCoverage.test.ts` fails if one is
 * missing. Adding a knob there would move the balance hash, invalidate every
 * shipped replay and force a `defaultHighscore.ts` regeneration — a real cost
 * that is paid **once**, later, for the value this experiment picks, and not
 * for the experiment itself. Applied as runtime scales at three call sites in
 * `engine.ts` instead, the hash does not move and no shipped replay notices.
 *
 * Dependency-free and layer-neutral, the same shape (and for the same reason)
 * as its neighbour `difficulty.ts`.
 */

export interface PlaytestScales {
  /**
   * Multiplies damage the player takes **from enemies** — melee bites and
   * ranged bolts — on top of the difficulty tier's own `damage` factor.
   *
   * Scoped exactly like `DifficultyMultipliers.damage`: trap, hazard and
   * self-inflicted (rocket splash) damage are not "enemy dealt" and are left
   * alone, so turning this knob isolates the roster rather than the level
   * furniture. That distinction is load-bearing here — environmental damage
   * was measured at 5-30% of everything a run takes depending on the
   * repository.
   */
  enemyDamage: number;
  /**
   * Multiplies the health a **kill** drops — both the guaranteed regular-kill
   * pack (`HEALTH_DROP_AMOUNT * maxHp / HEALTH_SCALE_REFERENCE_HP`) and the
   * Elite one (`ELITE_HEALTH_DROP_AMOUNT`).
   *
   * Generator-placed static health pickups are deliberately **not** scaled:
   * those are a per-level budget the map layer decided, whereas the kill heal
   * is the free-top-up mechanism actually under question — `loot.ts`'s
   * `HEALTH_SCALE_REFERENCE_HP` describes itself as "unproven, wired for
   * playtest on 2026-08-21 and not yet validated by anything but the solver",
   * and the solver has a level refilling the whole 100-point bar a median 2.3
   * times over.
   *
   * The ladder is the deliberate mirror of `ENEMY_DAMAGE_SCALES` (1/1.5, 1/2,
   * 1/3), because "enemy damage is low" and "healing is too generous" feel
   * identical in play while being different levers — damage moves spike
   * lethality, healing moves attrition. Playing both ways round the same net
   * margin is what tells them apart.
   */
  killHeal: number;
}

/** Identity: exactly today's balance. Every engine caller that omits the
 * constructor parameter — multiplayer, replay playback, every harness — gets
 * this, so the experiment is invisible to all of them. */
export const DEFAULT_PLAYTEST_SCALES: PlaytestScales = { enemyDamage: 1, killHeal: 1 };

/**
 * The selectable enemy-damage multipliers, in the order the `<select>` lists
 * them. `1` first so the control opens on "unchanged".
 *
 * Spread rather than fine steps on purpose: the bot takes ~16 damage a level
 * against a 100-point bar, so a 1.25x step is well below what a player could
 * notice and would waste a slot. `1.5` is the one value here already known to
 * be playable — it is Hard's shipped `damage` factor. `3` deliberately
 * overshoots so the ceiling can be found from above rather than crept up on;
 * note it puts an Elite bolt at 96 against a 100-point bar (144 on Hard, i.e.
 * lethal from full), which is a finding to watch for and not an oversight.
 */
export const ENEMY_DAMAGE_SCALES: readonly number[] = [1, 1.5, 2, 3];

/** The selectable kill-heal multipliers — the reciprocals of
 * `ENEMY_DAMAGE_SCALES`, see `PlaytestScales.killHeal`. */
export const KILL_HEAL_SCALES: readonly number[] = [1, 0.67, 0.5, 0.33];

/**
 * Read one scale back out of storage (or any other untrusted string).
 *
 * Membership in `allowed` rather than a range check, so a value that was valid
 * under an earlier ladder does not survive a change to it — the whole point of
 * the control is that only the listed candidates are ever played. Returns
 * `undefined` for anything unrecognised, leaving the caller to supply the
 * default; same "storage is not a trusted source" rule `main.ts`'s other
 * preference loaders follow.
 */
export function parsePlaytestScale(raw: string | null, allowed: readonly number[]): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return allowed.includes(value) ? value : undefined;
}
