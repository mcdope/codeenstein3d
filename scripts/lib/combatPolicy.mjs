// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The playtest bot's decision core: given a snapshot of the world, decide which
 * keys to hold, for how long, and whether to fire. Extracted from `bot.mjs`,
 * which keeps everything this deliberately has none of — the Playwright page,
 * the drive loops, trace recording, anomaly reporting.
 *
 * ## Why this is a separate module
 *
 * Two reasons, and the second is the one that constrains how it's written.
 *
 * 1. It makes the decision logic testable. `scripts/lib/` had no automated
 *    coverage at all for ~1400 lines of movement and combat behaviour; a pure
 *    function that returns an intent object can be asserted directly, without a
 *    browser. See `combatPolicy.test.mjs`.
 * 2. It is shaped to be liftable into `src/engine/combatPolicy.ts` later, as
 *    the basis of a real in-game deathmatch opponent. `src/` cannot import from
 *    `scripts/`, so the move has to be a copy — and a copy is only mechanical if
 *    this file never acquires a dependency that `src/engine/` couldn't satisfy.
 *
 * ## Rules this file must keep (they exist to keep rule 2 true)
 *
 * - No `page`, no `async`/`await`, no Node builtins, no DOM. Nothing here does
 *   I/O; it takes a snapshot and returns an intent.
 * - **All tuning is injected.** Every function that reads a tuning value takes
 *   it as a parameter rather than closing over `DEFAULT_TUNING`. This also
 *   fixes a real latent bug: `pickThreat`, `pickRangedWeapon`, `rocketAimUnsafe`,
 *   `findDisarmableMine` and `findDangerousMine` previously read
 *   `DEFAULT_TUNING` directly, so a caller's `opts.tuning` override silently did
 *   not reach them. The parameters default to `DEFAULT_TUNING`, so this is
 *   behaviour-neutral today — nothing overrides those particular keys — but it
 *   stops being a trap.
 * - No `Math.random()`, no `Date.now()`, no iteration over unordered
 *   collections, and every `sort` must be total. The bot backs
 *   `generate:default-highscore` and a replayable balancing campaign, so a
 *   decision sequence has to be reproducible from the same inputs. (A deathmatch
 *   opponent wants the opposite, which is why the non-determinism belongs in the
 *   *caller* above `decide()`, not in here.)
 * - Inputs are exactly the shapes the engine's own test hooks already return
 *   (`getBotPlayerState`, `getEnemiesSnapshot`, `getMinesSnapshot`,
 *   `getProjectilesSnapshot`), so the `src/` version needs no adapter layer.
 *
 * ## The intent object
 *
 * `decide()` returns what the bot *wants*, not what it did:
 *
 *   holds        Map of key code -> how many ms that key stays held
 *   durationMs   how long the whole decision lasts; `undefined` means "the
 *                caller's full step"
 *   fire         pull the trigger this decision
 *   useMelee     the trigger is a melee swing (Space) rather than ranged
 *   weaponSwitchIndex  weapon to tap-switch to first, or null
 *   firedSemiAuto      caller should advance its semi-auto fire cooldown
 *   branch, trace      diagnostics for `#recordTrace`
 *
 * `holds` being per-key is the whole point of the shape, but note that **today
 * every key in a given intent carries the same duration**. That is deliberate:
 * this extraction is meant to be exactly behaviour-neutral, so the dispatch it
 * produces is byte-identical to the single-`turnBurst` call it replaced. Letting
 * keys carry *different* durations is the next change, and it is what fixes the
 * bot standing still while shooting — see `segmentsFor`.
 */

// Mirrors src/engine/weapons.ts's WEAPONS array indices — plain literals
// rather than importing that TS module (this is a plain Node script, not
// bundled like the map/parser layer in loadEngineModules.mjs).
export const PISTOL_WEAPON_INDEX = 0;
export const SHOTGUN_WEAPON_INDEX = 1;
export const KNIFE_WEAPON_INDEX = 2;
export const GDB_WEAPON_INDEX = 3;
export const GHIDRA_WEAPON_INDEX = 4;
export const FRIDAY_HOTFIX_WEAPON_INDEX = 5;
export const TOOLCHAIN_WEAPON_INDEX = 6;
export const STARTING_WEAPONS = [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, KNIFE_WEAPON_INDEX];

/**
 * Weapon indices reachable by number key, in slot order — mirrors
 * `NUMBER_KEY_WEAPONS` in `src/engine/weapons.ts`, which is `WEAPONS` filtered
 * to entries with no `meleeRange` (both the knife and the Toolchain are melee
 * and are switched to by other means).
 *
 * The engine reads a digit as an index *into this list*, not into `WEAPONS`.
 * Dispatching `Digit${weaponIndex + 1}` — which is what the bot did until
 * 2026-07-29 — therefore asked for the wrong gun for every index past the
 * knife: gdb(3) equipped ghidra, ghidra(4) equipped Friday Hotfix, and
 * Friday(5) pressed a digit with no weapon behind it at all, silently leaving
 * whatever was already in hand.
 */
export const NUMBER_KEY_WEAPONS = [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX];

/** The `Digit<n>` code that actually equips `weaponIndex`, or `null` if that
 * weapon has no number-key slot (i.e. it is melee). */
export function numberKeyCodeFor(weaponIndex) {
  const slot = NUMBER_KEY_WEAPONS.indexOf(weaponIndex);
  return slot === -1 ? null : `Digit${slot + 1}`;
}
// The two ranged weapons WEAPONS.auto=true (mirrors weapons.ts) — fired via
// isFireHeld(), so one *held* key produces shot after shot at their own
// fireIntervalSec no matter how the key is dispatched. That held-vs-pressed
// distinction is the whole membership rule, and it is not about *having* a
// cooldown: every ranged weapon has a fireIntervalSec now. The shotgun in
// particular has the longest interval of any bullet weapon (0.85s) and still
// does not belong here — it is semi-auto, needing a fresh keydown per shot,
// so the bot must keep dispatching, just far less often (see the fire gate in
// `decide`, which takes the max of that interval and the profile's own
// dispatch cooldown). See `profile.fireCooldownMs`'s doc comment.
export const AUTO_RANGED_WEAPON_INDICES = new Set([GDB_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX]);
export const HAZARD_TILE = 2; // src/map/types.ts's Tile enum
export const SPIKE_TRAP_TILE = 5; // src/map/types.ts's Tile enum

// Floor for `forwardScanTiles` — the fixed look-ahead the forward hazard/
// spike checks used before sprinting made one decision's travel variable.
// Kept as the minimum so short decision windows behave exactly as before.
const FORWARD_SCAN_MIN_TILES = 0.6;
// Spacing for `segmentBlocked`'s samples along a movement segment. Comfortably
// under one tile, so no single-tile acid strip or spike can fall between two
// samples.
const SEGMENT_SAMPLE_TILES = 0.25;

/**
 * Movement/combat tuning defaults — mirrors of various src/engine/*.ts
 * constants (this is a plain Node script, can't import the bundled TS
 * modules for these particular runtime values) plus a large set of
 * empirically-tuned thresholds, each with its own hard-won bug-fix history
 * (see the functions that read them below). Overridable per-`Bot` instance
 * via the constructor's `opts.tuning` (deep-merged over this object) — a
 * future consumer (e.g. a different harness or a multiplayer bot) can tune
 * without forking this file.
 */
export const DEFAULT_TUNING = {
  VIRTUAL_STEP_MS: 50,
  WATCH_STEP_MS: 130,
  MAX_TICKS_PER_WAYPOINT: 600,
  // How far past `MAX_TICKS_PER_WAYPOINT` a waypoint drive may run when the
  // extra decisions are spent in combat rather than on navigation — see
  // `Bot#driveToward`. Bounds the relaxation so an unwinnable fight still ends
  // the attempt instead of looping forever.
  COMBAT_TICK_BUDGET_MULTIPLIER: 4,
  // How many times `Bot#driveTowardWithReplan` re-plans after a drive reports
  // `stuck`. Each retry re-reads the bot's real position, so a bot shoved
  // around geometry mid-drive gets a fresh BFS from where it actually is.
  WAYPOINT_REPLAN_ATTEMPTS: 3,
  // Abandon a loot detour whose waypoint exhausted its re-plans, instead of
  // driving the rest of a path planned from a tile the bot never reached. Off
  // here so single-player keeps its measured behaviour; `MultiplayerBot` turns
  // it on, where each wasted waypoint costs real seconds rather than virtual
  // ones. See `Bot#maybeDetourForLoot`.
  BOT_LOOT_ABANDON_ON_STUCK: false,
  // Consecutive decisions a `driveToward` may spend inside
  // `BOT_NAV_STALL_RADIUS_TILES` of where the run started before it gives up
  // early and lets `driveTowardWithReplan` route around. 0 disables it
  // entirely, which is the single-player default: the balancing corpus was
  // measured without it. See `Bot#driveToward`.
  BOT_NAV_STALL_BAIL_TICKS: 0,
  BOT_NAV_STALL_RADIUS_TILES: 0.5,
  // How far from the exit `Bot#driveToExit` will BFS back to it before its
  // *first* straight-line nudge, rather than only between rounds. 0 disables
  // it, which is the single-player default — there the caller's legs have
  // always just ended on the exit, so round 0 has nothing to path around.
  BOT_EXIT_BACKTRACK_TILES: 0,
  TURN_MOVE_EPS: 0.2,
  ARRIVE_EPS: 0.15,
  TIGHT_ARRIVE_EPS: 0.05,
  // Any single-tick position jump larger than this is physically impossible
  // via normal movement (max sprint is ~0.32 tiles/tick at VIRTUAL_STEP_MS)
  // and can only mean a teleporter pad fired — see `driveToward`'s doc
  // comment on the jump-detection check that uses this.
  TELEPORT_JUMP_DETECT_TILES: 1.0,
  // See `maybeDetourForLoot`'s doc comment — caps how far (straight-line)
  // the bot will detour for a single uncollected pickup.
  MAX_LOOT_DETOUR_TILES: 20,
  // Per-level ceiling on loot detouring, as a multiple of the level's planned
  // route length. 1.0 means "walk at most as far collecting as travelling".
  //
  // Exists because the detour had no termination condition at all.
  // `maybeDetourForLoot` is called once per *waypoint* (`driveLegs` calls it
  // before each leg and again inside the waypoint loop), re-picks from scratch
  // every time, and will walk `MAX_LOOT_DETOUR_TILES` for whatever is nearest
  // — while kills keep creating fresh drops. Measured on serilog level 9:
  // 88,791 decisions and 14,268 tiles walked on a 72x72 map, of which **87%**
  // was loot detouring against 12% on the route. Every one of that repo's 60
  // capture runs wedged, with zero deaths.
  //
  // A fraction rather than a fixed tile count so it scales with the level: the
  // same number cannot be right for a 15-tile route and a 300-tile one.
  //
  // Urgent health detours deliberately ignore this — see `maybeDetourForLoot`.
  LOOT_BUDGET_FRACTION: 1.0,
  // Give up on one drop after this many approaches that fail to collect it.
  //
  // Same shape as `MINE_TARGET_GIVEUP_TICKS`, for the same reason: without it a
  // target the bot cannot actually reach is re-selected forever. That was not
  // hypothetical — the bot walks to a drop's *tile centre* while the engine
  // collects within `AMMO_PICKUP_RADIUS` (0.5) of the drop itself, and
  // centre-to-corner is 0.707, so ~21.5% of a tile was unreachable. Dynamic
  // drops are never added to `visitedPickups` either, so such a drop was both
  // uncollectable and permanently re-picked. Walking to the drop coordinate
  // fixes the geometry; this bounds whatever the geometry does not.
  LOOT_TARGET_GIVEUP_ATTEMPTS: 3,
  // How far (in tiles) the bot's actual position may be from an upcoming
  // waypoint before it's considered "displaced" and worth a fresh BFS
  // re-plan — see `driveTowardWithReplan`'s doc comment.
  LEG_REPLAN_DRIFT_TILES: 2.5,
  // Mirrors src/engine/engine.ts's ROT_SPEED (rad/sec).
  ENGINE_ROT_SPEED: 2.6,
  // Mirrors src/engine/engine.ts's MOVE_SPEED/SPRINT_MULTIPLIER.
  ENGINE_MOVE_SPEED: 3.2,
  ENGINE_SPRINT_MULTIPLIER: 2.0,
  // How much more rotation than `turnBurstMs`'s own math predicts still
  // counts as "plausible" before `#checkRotationAnomaly` flags it — see that
  // method's doc comment.
  ROTATION_ANOMALY_SLACK: 4,
  // --- ranged weapon selection (see `scoreRangedWeapon`) ---------------------
  // Distance at which a `SPREAD_REFERENCE_PX`-wide cone is assumed to put only
  // one pellet on a single target; wider cones reach that point sooner.
  // Mirrors src/engine: SCENE_HEIGHT 400, sprites.ts ENEMY_SIZE 0.7 /
  // ELITE_SCALE 1.5 / EDGE_CASE_SCALE 0.55, raycaster.ts FOG_FAR 14, and
  // engine.ts MAX_CONE_DEVIATION_PX 38. Together these are what let the bot
  // judge whether a shot can actually reach and connect.
  SCENE_HEIGHT_PX: 400,
  ENEMY_SPRITE_SIZE: 0.7,
  ELITE_SPRITE_SCALE: 1.5,
  EDGE_CASE_SPRITE_SCALE: 0.55,
  FOG_FAR_TILES: 14,
  MAX_CONE_DEVIATION_PX: 38,
  // Seconds-equivalent of burning an entire ammo reserve on one target, before
  // the profile's own `ammoThrift` multiplier. Sets the exchange rate between
  // "kill it faster" and "still have ammo later".
  AMMO_BURN_PENALTY_SEC: 12,
  // Used when the target's HP is unknown (e.g. aiming at a mine).
  ASSUMED_TARGET_HP: 60,
  DEFAULT_AMMO_THRIFT: 1,
  // Two weapons scoring within this many seconds of each other are treated as
  // equivalent, so `weaponPriority` (profile personality) breaks the tie.
  WEAPON_SCORE_TIEBREAK_EPS: 0.15,
  DOOR_OPEN_TICKS: 10,
  // Same total push duration as DOOR_OPEN_TICKS * VIRTUAL_STEP_MS (500ms),
  // just in much finer steps — see `holdForwardFine`'s doc comment.
  DOOR_OPEN_FINE_STEP_MS: 5,
  MINE_BLAST_RADIUS: 2.4,
  // Proactive-disarm search radius — see `findDisarmableMine`'s doc comment.
  MINE_DISARM_RANGE: 4.2,
  // Give up on a proactive mine-disarm shot after this many consecutive
  // ticks targeting the *same* mine with no hit — see `decide`'s mine-handling
  // doc comment.
  MINE_TARGET_GIVEUP_TICKS: 40,
  // How much of a straight back-up actually increases distance from a mine,
  // as |cos(angle to the mine)|. At 0.5 the mine is within 60 degrees of dead
  // ahead (or dead behind) and reversing along the view axis recovers at least
  // half the step; nearer to abeam it recovers almost nothing, so the bot
  // turns instead. See the `mineRetreat` branch.
  MINE_BACKPEDAL_MIN_COS: 0.5,
  // Whether plain navigation keeps moving (strafing/reversing toward the
  // target) while a large heading correction is under way, instead of
  // standing still until the turn finishes. Exists as a switch so the change
  // is A/B-able as a single variable against the same binary:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"NAV_FULL_WASD":false}'
  // restores the stop-to-turn behaviour exactly.
  NAV_FULL_WASD: true,
  // Whether a critical-health retreat backs away along the escape vector
  // without turning, instead of spinning to face away first. Same
  // single-variable switch shape as `NAV_FULL_WASD`:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"NAV_BACKPEDAL_RETREAT":false}'
  NAV_BACKPEDAL_RETREAT: true,
  // Whether the bot re-reads the engine's wall grid when `gridVersion` moves,
  // instead of planning forever against the copy taken at level start. Same
  // single-variable switch shape as the two above:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"BOT_LIVE_GRID":false}'
  BOT_LIVE_GRID: true,
  // Whether `driveToExit` ranks exit-room blockers by walking distance rather
  // than straight-line. Single-variable switch, as above:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"BOT_WALKING_DISTANCE_BLOCKERS":false}'
  BOT_WALKING_DISTANCE_BLOCKERS: true,
  // Whether `#walkPathTo` retries without the spike/acid avoid-set when no
  // hazard-free route exists. Single-variable switch, as above:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"BOT_HAZARD_ROUTE_FALLBACK":false}'
  BOT_HAZARD_ROUTE_FALLBACK: true,
  // Once stuck realigning on the same mine this many ticks, force a shot at
  // the current best-effort alignment instead of freezing until the much
  // later full give-up — see `decide`'s mine-realignment comment.
  MINE_REALIGN_STALL_TICKS: 15,
  CRITICAL_HEALTH_FRACTION: 0.2,
  MELEE_RANGE: 1.5,
  // Refuse to trade swings with a target holding more than this much HP, as
  // long as a gun still has ammo. `Infinity` is the shipped behaviour and
  // makes this inert — it exists to be turned on for one measurement:
  //
  //   CODEENSTEIN_TELEMETRY_TUNING='{"MELEE_MAX_TARGET_HP":500}'
  //
  // Why it exists. The 2026-08-04 capture found 83% of Elite engagements
  // happening inside 2 tiles at a median of 0.5, and levels 15/17 (the only
  // two multi-Elite levels) killing 46% and 98% of the runs that reached them.
  // An Elite carries 3,000-3,500 HP on hard and deals double melee damage, so
  // a 40-damage knife needs ~83 swings to fell one — a trade nothing about the
  // bot's policy currently declines, because `shouldCloseToMelee` only ever
  // asks how far away the target is, never how big it is.
  //
  // The open question that measurement cannot currently answer is whether
  // those two levels are genuinely brutal or whether the bot simply fights
  // them badly, and no amount of re-tuning enemy HP settles it. Running the
  // same six cells with this set turns it into an A/B against the same binary.
  //
  // Scope, deliberately narrow: this stops the bot *closing* on a big target.
  // It does not add kiting — there is no behaviour here that restores distance
  // once an enemy has walked into contact, and adding one is a much larger
  // change than a diagnostic warrants. Read a null result as "closing is not
  // the mechanism", not as "the bot fights these levels fine".
  //
  // The `hasAnyRangedAmmo` guard in `shouldCloseToMelee` keeps the last-resort
  // case intact: dry is still dry, and standing in front of a threat pulling a
  // dead trigger is worse than any trade.
  MELEE_MAX_TARGET_HP: Infinity,
  // Break contact with a target too big to burst down, the way the bot already
  // breaks contact at critical health. **On** since 2026-08-06; set to
  // `Infinity` to restore the old stand-and-trade behaviour:
  //
  //   CODEENSTEIN_TELEMETRY_TUNING='{"STANDOFF_MIN_TARGET_HP":1e999}'
  //
  // Measured before enabling, on the same staged wolf3d campaign, 20 runs per
  // profile: engagement distance against a 3,000 HP Elite went **0.54t ->
  // 5.10t**, knife swings into it **305 -> 0**, ghidra shots **2 -> 21** (0.5%
  // -> 22.3% of the damage dealt to it). Level-8 lethality did *not* move —
  // 100% -> 89%, Fisher p = 0.24 — because the constraint there is arithmetic:
  // ghidra deals ~93 damage a shot and the bot carries a median of 4 rockets,
  // so 372 damage against 3,000 HP.
  //
  // Enabled anyway, because the point is instrument quality rather than
  // lethality. A bot that knife-trades a 3,000 HP Elite 305 times is not a
  // usable measuring device for level difficulty, and every Elite death rate
  // recorded before this was an upper bound produced by the worst available
  // tactic. Known cost: `selfRocket` damage appeared at 3% of damage taken on
  // that level, having been 0% before.
  //
  // Why it exists. `MELEE_MAX_TARGET_HP` was run as an A/B on the wolf3d
  // capture and came back null: it removed the knife trade completely (305
  // swings against a 3,000 HP Elite -> 0) and moved level-8 lethality not at
  // all (100% -> 89%, Fisher p=0.24). Its own comment predicted why — it stops
  // the bot *closing*, and nothing there stops the Elite closing. Engagement
  // settled at 1.25 tiles, still inside `ROCKET_SAFE_DISTANCE`, so ghidra
  // stayed unusable and the Elite was never killed in either arm.
  //
  // This is the missing half: once something big is inside
  // `STANDOFF_DISTANCE`, retreat along the escape vector instead of standing
  // in it. The retreat itself is the existing critical-health behaviour,
  // reused verbatim — sprinting backwards along the away-vector while staying
  // aimed at the threat — only the gate is new.
  //
  // Feasibility, since a standoff nothing can hold is worthless: the player
  // sprints at `ENGINE_MOVE_SPEED * ENGINE_SPRINT_MULTIPLIER` = 6.4 t/s and a
  // regular-archetype Elite chases at `ENEMY_CHASE_SPEED` 1.7, so opening
  // range is not in question. Edge Cases chase at 3.74 — still under a sprint.
  //
  // Self-limiting by construction, so there is no runaway-retreat mode: the
  // gate stops firing the moment the target is beyond `STANDOFF_DISTANCE`, and
  // normal ranged selection resumes. That is the whole point — 5 tiles is
  // outside `ROCKET_SAFE_DISTANCE` (4) far enough that
  // `rocketDetonationDistanceAfterClosing` still clears it against a 1.7 t/s
  // chaser (5 - 1.7*(5/18) = 4.53), so ghidra becomes legal exactly when the
  // bot stops backing up.
  //
  // Gated on `hasAnyRangedAmmo` for the same reason `shouldCloseToMelee` is:
  // backing away from something you have no ammo to shoot is worse than any
  // trade. And it reads `threat.hp`, not `maxHp`, so a half-killed Elite stops
  // being worth avoiding once it drops under the threshold.
  STANDOFF_MIN_TARGET_HP: 500,
  // How far to hold off a `STANDOFF_MIN_TARGET_HP` target. Inert while that is
  // `Infinity`. See above for why 5 and not 4.
  STANDOFF_DISTANCE: 5,
  // Below this distance, stop trying to close the last bit of distance
  // during an in-progress melee engagement — see `decide`'s melee branch,
  // which actually gates on `max(this, ENGINE_MOVE_SPEED * stepMs/1000)`,
  // not this raw value alone — see that branch's own doc comment for why.
  MELEE_CLOSE_MIN_DISTANCE: 0.4,
  // How far the bot will walk to trade a swing for a bullet against a target a
  // single swing kills (Edge Cases are 10-15 HP). Short on purpose: closing is
  // only free when the target dies on arrival.
  // Below this distance, stop advancing while turning to line up a ranged
  // shot — see `decide`'s ranged-aim branch.
  MIN_RANGED_APPROACH_DISTANCE: 3,
  // Above this angular error, walking forward while still turning toward a
  // route waypoint would move the bot away from where it actually needs to
  // go — see `decide`'s plain-navigation branch.
  MAX_WALK_WHILE_TURNING_RAD: 0.35,
  // Combat can deadlock against wall geometry — once a threat engagement has
  // produced no actual attack for this many consecutive ticks with position
  // frozen, nudge sideways instead of just re-aiming in place.
  COMBAT_STALL_TICKS_THRESHOLD: 40,
  COMBAT_STALL_STRAFE_FLIP_TICKS: 20,
  CRITICAL_STALL_TICKS_THRESHOLD: 15,
  CRITICAL_STALL_STRAFE_FLIP_TICKS: 10,
  // How close two aggroed enemies have to be to each other to count as
  // "clustered" — see `pickRangedWeapon`.
  CLUSTER_RADIUS: 3,
  // Rockets splash the shooter too — never select ghidra within this
  // distance regardless of profile. See `rocketAimUnsafe`.
  ROCKET_SAFE_DISTANCE: 4,
  // Mirrors src/engine/rockets.ts's ROCKET_ENEMY_TRIGGER_RADIUS.
  ROCKET_ENEMY_TRIGGER_RADIUS: 0.4,
  // Matches Friday Hotfix's real maxRange (weapons.ts).
  FRIDAY_HOTFIX_MAX_RANGE: 3.5,
  // How far a clustered threat needs to be before rocket splash is worth
  // preferring — see `pickRangedWeapon`.
  ROCKET_CLUSTER_MIN_DIST: 5, // ROCKET_SAFE_DISTANCE + 1
  // Enemy chase speeds, mirroring `src/engine/enemyAi.ts` (MOVEMENT_SPEED 1.7,
  // EDGE_CASE_SPEED_MULTIPLIER 2.2). Needed to work out how much of a rocket's
  // flight time a target spends closing the gap.
  ENEMY_CHASE_SPEED: 1.7,
  EDGE_CASE_CHASE_SPEED: 3.74,
  // Mirrors `src/engine/combatConstants.ts`'s ROCKET_SPEED — a rocket is not
  // instantaneous, and everything below turns on that.
  //
  // Was 5 until 2026-08-04, mirroring `PROJECTILE_SPEED` instead: that is the
  // *enemy bolt's* speed, not the player's own ghidra rocket. The comment even
  // said so, which is how it survived review. The bot therefore modelled its
  // own rocket as 3.6x slower than it is, so
  // `rocketDetonationDistanceAfterClosing` believed a chasing enemy would
  // close 3.6x further during the flight and refused shots that were in fact
  // safe. Pinned against the engine by `constantMirrors.test.mjs`.
  ROCKET_TRAVEL_SPEED: 18,
  // Seconds-equivalent of firing a rocket with no safety margin at all, before
  // the profile's `selfHarmAversion` multiplier.
  SELF_HARM_PENALTY_SEC: 25,
  DEFAULT_SELF_HARM_AVERSION: 1,
  // MINE_REALIGN_EPS assumes precise per-tick rotation, only exact under a
  // virtual clock — see `decide`'s mine-realignment comment for why this
  // matters more in headless mode.
  MINE_REALIGN_EPS: 0.01,
  // A mine has to be somewhere in the forward hemisphere (90° either side of
  // the intended heading) to be worth a proactive detour — see
  // `findDisarmableMine`.
  MINE_DISARM_MAX_ANGLE_FROM_PATH: Math.PI / 2,
  // How many consecutive engaged decisions the combat strafe runs before
  // reversing. This is also what bounds the manoeuvre: at walking speed a
  // half-period covers `ENGINE_MOVE_SPEED * FLIP_TICKS * stepMs/1000` tiles
  // (~1.3 at the headless step), so the bot oscillates around its position
  // instead of drifting off the route — no separate displacement cap needed.
  COMBAT_STRAFE_FLIP_TICKS: 8,
  // Don't dance inside melee range: at knife distance the useful move is to
  // close and swing, and sidestepping there just walks circles around a target
  // the bot is trying to hit.
  COMBAT_STRAFE_MIN_DISTANCE: 1.5,
  // How far ahead the strafe safety check looks, regardless of how little
  // ground one decision actually covers. A single lateral step is only
  // ~0.16 tiles at the headless window — far less than the half-tile to the
  // near edge of the neighbouring tile — so a check scoped to the step alone
  // would never see acid until the bot was already standing in it, and would
  // never see a wall at all. Blocking on a wall this early is deliberate too:
  // a strafe into geometry is rejected wholesale by collision, so it buys no
  // dodge and shows up as a `heldKeyNoMovement` anomaly for free.
  COMBAT_STRAFE_LOOKAHEAD_TILES: 0.6,
  // Mirrors src/engine/projectiles.ts's PROJECTILE_SPEED (tiles/sec).
  PROJECTILE_SPEED: 5,
  // Player radius (0.2) + PROJECTILE_RADIUS (0.15). `updateProjectiles` hit-
  // tests an axis-aligned box of this half-width, so clearing it by any margin
  // is a clean miss.
  PROJECTILE_HIT_HALF_WIDTH: 0.35,
  // Perpendicular distance from a bolt's flight line beyond which it is already
  // going to miss and is not worth reacting to. Circumscribes the square hit
  // box (0.35 * sqrt2 ~ 0.495) so a diagonal near-miss still counts as safe.
  DODGE_MISS_MARGIN: 0.5,
  // How many decisions ahead a bolt has to be arriving before the bot reacts.
  // Too short and there is no time left to move; too long and the bot dodges
  // shots that will be blocked by a wall or aimed at where it no longer is.
  DODGE_LOOKAHEAD_DECISIONS: 3,
  // Floor for that lookahead in seconds, so a very short decision window still
  // reacts far enough out to matter.
  //
  // Sized against how the bot actually moves, not the theoretical best case.
  // Clearing the 0.35-tile hit box takes ~110ms of *walking* (the strafe never
  // sprints), and only the fire branch strafes — roughly 43% of combat
  // decisions — so the usable reaction time is well under half the window.
  // 0.6s is ~12 decisions, of which ~5 actually move: about 0.8 tiles of
  // displacement, comfortably clear. A 0.35s window looked sufficient on
  // sprint-speed arithmetic and was not.
  DODGE_MIN_LOOKAHEAD_SEC: 0.6,
  // Whether a directed dodge is also available while the bot is still
  // re-aiming, rather than only once it has a firing solution. Single-variable
  // switch, as elsewhere:
  //   CODEENSTEIN_TELEMETRY_TUNING='{"DODGE_WHILE_REAIMING":false}'
  DODGE_WHILE_REAIMING: true,
};

/** Tiles a lateral step must never cross. Mirrors `pathfind.mjs`'s own
 * `BLOCKED_TILES` (wall / locked door / unopened secret / lore / branch door) —
 * deliberately wider than `isWallTile`'s `{1,6,7}`, since a closed door is not
 * something to strafe into even though a bullet ignores it. */
const STRAFE_BLOCKED_TILES = new Set([1, 3, 6, 7, 8]);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function angleDelta(current, target) {
  const d = target - current;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * The strafe key ("KeyD"/right or "KeyA"/left) that moves the player toward
 * a target requiring `delta` radians of turn to face — lets the bot move
 * diagonally instead of straight-ahead-only while turning.
 *
 * **Confirmed regression if used more widely.** An A/B test found
 * Casual/normal's level-2 death rate jumped from 0% to 72% once diagonal
 * movement was added to every turn-and-move branch. Reverted from every other
 * branch and kept only in plain navigation. The likely mechanism is
 * `engine.ts`'s `diagonalScale = Math.SQRT1_2`: holding a strafe key next to
 * a forward key keeps total speed constant but cuts the *forward* component by
 * 29%, and in the hazard-crossing and critical-health branches the forward
 * axis is the survival axis.
 */
export function diagonalStrafeKey(delta) {
  return delta > 0 ? "KeyD" : "KeyA";
}

export function isHazardAt(map, x, y) {
  return map.grid[Math.floor(y)]?.[Math.floor(x)] === HAZARD_TILE;
}

/**
 * Centre of the nearest tile that is walkable and does not damage you, or
 * `null` if there is none within `maxRadius`.
 *
 * The hazard branch below used to march toward whatever the bot was already
 * headed for. That is not an escape: if the nav target lies across the acid,
 * beyond it, or nowhere at all, "keep marching" leaves the bot standing in
 * damage. Measured across four repositories and two bot versions, the
 * signature was identical — a median ~7s of continuous acid and ~125 damage
 * ticks, which is a full health bar, with **no combat at all** in 20 of 20
 * serilog cases. It accounted for 85% of serilog's deaths, 90% of ripgrep's,
 * and 38-58% of wolf3d's. Those are not the game killing the player.
 *
 * Breadth-first so the first hit is genuinely the closest, and traversal is
 * allowed *through* hazard and spike tiles — they are walkable, and a bot
 * standing in the middle of an acid pool has to cross some of it to get out.
 * Only the destination has to be safe.
 *
 * `maxRadius` bounds the work: this runs on every decision tick while the bot
 * is burning, and an unbounded flood of a 123x123 grid is not free. A pool
 * wider than 24 tiles in every direction is not something stepping aside
 * solves anyway.
 */
export function nearestSafeTile(map, x, y, maxRadius = 24) {
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  const seen = new Set([`${sx},${sy}`]);
  let frontier = [[sx, sy]];
  for (let depth = 0; depth < maxRadius && frontier.length > 0; depth++) {
    const next = [];
    for (const [cx, cy] of frontier) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tile = map.grid[ny]?.[nx];
        if (tile === undefined || STRAFE_BLOCKED_TILES.has(tile)) continue;
        // Spike tiles are `5` in the grid, so a periodically-damaging tile is
        // rejected as a destination without consulting the trap cycle — a tile
        // that is safe now but spikes on arrival is not an escape.
        if (tile !== HAZARD_TILE && tile !== SPIKE_TRAP_TILE) return { x: nx + 0.5, y: ny + 0.5 };
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

/** Mirrors src/engine/traps.ts's isSpikeActive — whether the spike trap (if
 * any) at (x,y) is in its damaging half of the cycle at `levelTime`. */
export function activeSpikeAt(map, x, y, levelTime) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const trap = map.spikeTraps.find((t) => t.x === cx && t.y === cy);
  if (!trap) return false;
  const cyclePos = (levelTime + trap.phase) % trap.period;
  return cyclePos >= trap.period / 2;
}

/** Mirrors the engine's own hasLineOfSight (src/engine/enemyAi.ts): samples
 * every ~0.1 tiles along the line and fails if any sample lands on a
 * wall/unopened-secret/lore tile. */
export function hasLineOfSight(map, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.1);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallTile(map, x0 + dx * t, y0 + dy * t)) return false;
  }
  return true;
}

export function isWallTile(map, x, y) {
  const tile = map.grid[Math.floor(y)]?.[Math.floor(x)];
  return tile === undefined || tile === 1 || tile === 6 || tile === 7;
}

// ---------------------------------------------------------------------------
// Burst timing
// ---------------------------------------------------------------------------

/**
 * How long to hold a turn key for a *pure* turn so it lands as close as
 * possible to `deltaAngle` without overshooting past it — see the original
 * module's doc comment for the oscillation bug this fixes.
 *
 * Records `pendingTurnCheck` on `memory` for `Bot#checkRotationAnomaly` to
 * compare against on the next call. That side effect has to survive the move
 * out of the `Bot` class: the anomaly detector goes silently blind without it.
 */
export function turnBurstMs(deltaAngle, rotSpeedMultiplier, currentAngle, { tuning, stepMs, memory }) {
  const rate = tuning.ENGINE_ROT_SPEED * rotSpeedMultiplier; // rad/sec
  const neededMs = (Math.abs(deltaAngle) / rate) * 1000;
  if (memory) {
    memory.pendingTurnCheck = { beforeDir: currentAngle, turnBurstMs: Math.min(stepMs, neededMs), rotSpeedMultiplier };
  }
  return Math.max(1, Math.min(stepMs, neededMs));
}

/**
 * The 8-way key combination that moves closest to `delta` radians off the
 * facing direction — `KeyW` straight ahead, `KeyD` hard right, `KeyS` straight
 * back, and the diagonals between.
 *
 * The bot can move in any of these eight directions **at full speed without
 * turning at all**. `moveForward` translates along `(dirX, dirY)` and `strafe`
 * along `(-dirY, dirX)` (player.ts), both scaled by the same `step`, and
 * `diagonalScale` (1/sqrt(2)) is applied to each axis when both are held — two
 * perpendicular components of `step/sqrt(2)` have magnitude exactly `step`. So
 * a diagonal is the same speed as a straight, and sprint applies to both.
 *
 * Worst-case direction error is half an octant, 22.5 degrees, i.e. `cos(22.5)`
 * = 92% of the step lands along the direction actually wanted. Compare
 * standing still to turn first, which lands 0%.
 */
export function movementKeysFor(delta) {
  const octant = ((Math.round(delta / (Math.PI / 4)) % 8) + 8) % 8;
  switch (octant) {
    case 0:
      return ["KeyW"];
    case 1:
      return ["KeyW", "KeyD"];
    case 2:
      return ["KeyD"];
    case 3:
      return ["KeyS", "KeyD"];
    case 4:
      return ["KeyS"];
    case 5:
      return ["KeyS", "KeyA"];
    case 6:
      return ["KeyA"];
    /* v8 ignore next -- @preserve the modulo above admits only 0..7 */
    default:
      return ["KeyW", "KeyA"];
  }
}

/**
 * World-space unit vector a set of movement keys produces for `player`.
 *
 * Needed because every safety check in the navigation branch scanned along
 * `(dirX, dirY)` — correct only while the bot exclusively walked forwards.
 * Once it can strafe or reverse, "ahead" and "where I am going" are different
 * directions, and scanning the wrong one is how a bot walks sideways into acid
 * it never looked at.
 */
export function movementVectorFor(keys, player) {
  let x = 0;
  let y = 0;
  if (keys.includes("KeyW")) {
    x += player.dirX;
    y += player.dirY;
  }
  if (keys.includes("KeyS")) {
    x -= player.dirX;
    y -= player.dirY;
  }
  if (keys.includes("KeyD")) {
    x += -player.dirY;
    y += player.dirX;
  }
  if (keys.includes("KeyA")) {
    x -= -player.dirY;
    y -= player.dirX;
  }
  const len = Math.hypot(x, y);
  return len > 0 ? { x: x / len, y: y / len } : null;
}

/** Straight-line-movement counterpart to `turnBurstMs` — caps how long a
 * movement key is held so it doesn't overshoot past a small arrival
 * tolerance (see the original module's doc comment for the hazard-tile
 * oscillation bug this fixes). */
export function moveBurstMs(dist, sprinting, { tuning, stepMs }) {
  const speed = tuning.ENGINE_MOVE_SPEED * (sprinting ? tuning.ENGINE_SPRINT_MULTIPLIER : 1); // tiles/sec
  const neededMs = (dist / speed) * 1000;
  return Math.max(1, Math.min(stepMs, neededMs));
}

/**
 * How far ahead a forward-safety check has to look, in tiles: one whole
 * decision's worth of real travel, floored at the historical fixed 0.6.
 *
 * The fixed value was safe only while the bot walked. Sprinting doubles the
 * distance a single decision covers, and the decision window itself varies by
 * an order of magnitude — ~0.32 tiles of sprint at `VIRTUAL_STEP_MS` (50ms, so
 * the floor still governs), 0.83 headed at `WATCH_STEP_MS`, and 2.56 at
 * `MultiplayerBot`'s 400ms window. Past the floor, a fixed 0.6-tile probe would
 * clear a spike the bot then sprints straight onto within the same decision.
 */
export function forwardScanTiles(sprinting, { tuning, stepMs }) {
  const speed = tuning.ENGINE_MOVE_SPEED * (sprinting ? tuning.ENGINE_SPRINT_MULTIPLIER : 1);
  return Math.max(FORWARD_SCAN_MIN_TILES, speed * (stepMs / 1000));
}

/**
 * Whether the straight segment from `from` along unit vector `dir` for `dist`
 * tiles crosses anything the bot must not walk into.
 *
 * Samples the whole segment rather than only its endpoint. A 1-tile acid strip
 * or a single spike tile is narrower than a sprint step, so an endpoint-only
 * check happily steps *through* it and takes the damage anyway.
 *
 * Spikes are tested at both `levelTime` and the time the bot would arrive: a
 * trap's damaging half is a timed cycle, so "safe right now" and "safe when I
 * get there" are different questions and only the second one matters.
 *
 * `hazard` is opt-out because acid is not categorically a thing to avoid.
 * `planRoute` already prices a hazard tile at 25x a floor tile, so a route that
 * crosses acid crosses it because every alternative was worse — and once you
 * are committed to crossing, moving *faster* is strictly better, which is why
 * the hazard-crossing branch sprints. Callers making an optional move (a dodge,
 * a loot detour) treat acid as blocking; callers following a committed route
 * pass `hazard: false`.
 */
export function segmentBlocked(map, from, dir, dist, levelTime, { tuning, hazard = true }) {
  if (!map || dist <= 0) return false;
  const arriveSec = dist / (tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER);
  const steps = Math.max(1, Math.ceil(dist / SEGMENT_SAMPLE_TILES));
  for (let i = 1; i <= steps; i++) {
    const t = (dist * i) / steps;
    const sx = from.x + dir.x * t;
    const sy = from.y + dir.y * t;
    if (hazard && isHazardAt(map, sx, sy)) return true;
    if (activeSpikeAt(map, sx, sy, levelTime)) return true;
    if (activeSpikeAt(map, sx, sy, levelTime + arriveSec)) return true;
  }
  return false;
}

/**
 * Whether a lateral step of `travelDist` tiles in `key`'s direction is safe to
 * take.
 *
 * A strafe is optional movement — unlike a committed route leg, there is never
 * a reason to accept damage for one — so this treats acid as blocking, the
 * opposite of the sprint gate's `hazard: false`.
 *
 * Checks the whole segment rather than the endpoint (a one-tile acid strip is
 * narrower than a step), and spikes at both now and arrival time, exactly as
 * `segmentBlocked` does. Walls are checked separately against
 * `STRAFE_BLOCKED_TILES`, which `segmentBlocked` doesn't cover because the
 * callers it was written for could never walk into one.
 *
 * With no map (the shape `faceAngle` decides with) there is nothing to test
 * against, so this reports unsafe rather than guessing — an unchecked strafe is
 * exactly the kind of thing that walks into acid.
 */
export function strafeIsSafe(map, player, key, travelDist, levelTime, { tuning }) {
  if (!map || travelDist <= 0) return false;
  // Right vector, mirroring `Player.strafe`: KeyD is +right, KeyA is -right.
  const sign = key === "KeyD" ? 1 : -1;
  const dir = { x: -player.dirY * sign, y: player.dirX * sign };
  if (segmentBlocked(map, player, dir, travelDist, levelTime, { tuning })) return false;
  const steps = Math.max(1, Math.ceil(travelDist / SEGMENT_SAMPLE_TILES));
  for (let i = 1; i <= steps; i++) {
    const t = (travelDist * i) / steps;
    const tile = map.grid[Math.floor(player.y + dir.y * t)]?.[Math.floor(player.x + dir.x * t)];
    if (tile === undefined || STRAFE_BLOCKED_TILES.has(tile)) return false;
  }
  return true;
}

/**
 * Whether an in-flight bolt is actually going to hit, and if so how long there
 * is to react.
 *
 * Bolts fly a fixed straight line from wherever they were fired and never
 * re-aim (`projectiles.ts`), which makes a static-player model *exact* here
 * rather than an approximation — the only unknown is what the player does next,
 * which is the thing being decided.
 *
 * Returns `null` for a bolt that is receding, already going to miss, or still
 * too far out to be worth reacting to.
 */
export function boltThreat(bolt, player, lookaheadSec, tuning) {
  const rx = player.x - bolt.x;
  const ry = player.y - bolt.y;
  const s2 = bolt.vx * bolt.vx + bolt.vy * bolt.vy;
  if (s2 <= 0) return null;
  // Positive only while the bolt is still closing on the player.
  const closing = bolt.vx * rx + bolt.vy * ry;
  if (closing <= 0) return null;
  const tti = closing / s2;
  if (tti > lookaheadSec) return null;
  // Signed perpendicular offset of the player from the bolt's flight line —
  // magnitude says whether it connects, sign says which side it passes.
  const perp = (rx * bolt.vy - ry * bolt.vx) / Math.sqrt(s2);
  if (Math.abs(perp) > tuning.DODGE_MISS_MARGIN) return null;
  return { tti, perp };
}

/**
 * The most urgent bolt worth dodging, or `null`.
 *
 * `selfId` filters to bolts actually aimed at this player: a bolt is locked to
 * one target for its whole life (`projectiles.ts`), so in multiplayer the bot
 * must ignore shots addressed to a team-mate rather than dodging things that
 * were never going to touch it. Single-player has one player and passes
 * nothing.
 *
 * Ties break on `tti` then on the array order the engine hands back, so the
 * choice stays deterministic with no reliance on sort stability.
 */
export function pickIncomingBolt(projectiles, player, lookaheadSec, tuning, selfId = null) {
  let best = null;
  for (let i = 0; i < (projectiles?.length ?? 0); i++) {
    const bolt = projectiles[i];
    if (selfId !== null && bolt.targetId !== undefined && bolt.targetId !== selfId) continue;
    const threat = boltThreat(bolt, player, lookaheadSec, tuning);
    if (!threat) continue;
    if (!best || threat.tti < best.tti) best = { ...threat, i };
  }
  return best;
}

/**
 * Which way to step to make an incoming bolt miss.
 *
 * Moving sideways changes the player's perpendicular offset from the bolt's
 * flight line at a rate of `(m x v) / |v|`; the useful direction is whichever
 * pushes that offset *away* from zero. A dead-on bolt (`perp` ~ 0) has no
 * better side — and that is every bolt on Hard, where `enemyAimSpreadDeg` is 0
 * — so it breaks toward `KeyD` and lets the safety gate pick the other if that
 * one is blocked.
 */
export function dodgeStrafeKey(bolt, threat, player) {
  const rightX = -player.dirY;
  const rightY = player.dirX;
  const rate = rightX * bolt.vy - rightY * bolt.vx;
  if (Math.abs(threat.perp) < 1e-3 || rate === 0) return "KeyD";
  return threat.perp * rate > 0 ? "KeyD" : "KeyA";
}

/**
 * Which way to sidestep while shooting, or `null` to stand still.
 *
 * Enemy bolts are aimed at wherever the target stood when the trigger was
 * pulled and never re-aim (`projectiles.ts`), so *any* sustained lateral motion
 * converts a hit into a miss — the bot doesn't need to see the bolt to benefit,
 * which is why this is worth doing before real projectile-aware dodging.
 *
 * The direction comes from a tick counter rather than a random draw, both
 * because this module must stay deterministic and because a coin flip would
 * average out to standing still. Flipping on a fixed period also bounds the
 * excursion by construction — see `COMBAT_STRAFE_FLIP_TICKS`.
 *
 * Tries the preferred side, then the other, then gives up: a bot pressed
 * against a wall should shoot rather than grind into it.
 */
export function combatStrafeKey(ticks, map, player, travelDist, levelTime, { tuning }) {
  const preferred = Math.floor(ticks / tuning.COMBAT_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA";
  const other = preferred === "KeyD" ? "KeyA" : "KeyD";
  if (strafeIsSafe(map, player, preferred, travelDist, levelTime, { tuning })) return preferred;
  if (strafeIsSafe(map, player, other, travelDist, levelTime, { tuning })) return other;
  return null;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Aggressive targeting: prioritize whichever aggroed enemy can be finished
 * off fastest (already in melee range, or an Edge Case) over strictly
 * whoever's nearest — thins numerous, individually weak attackers first
 * rather than spending 3-6s locked onto one tankier enemy while a swarm
 * lands free chip damage. Falls back to nearest-first among equally "quick"
 * (or equally "not quick") candidates, with a visible-enemy tiebreak
 * (occluded ones can't be engaged immediately regardless of distance).
 *
 * `map` is optional (some callers don't have one on hand) — when omitted,
 * every candidate is treated as visible, i.e. the original distance/quick-
 * kill-only ranking, unchanged.
 *
 * The final `a.i - b.i` tiebreak makes the ordering *total* rather than
 * relying on `Array.prototype.sort` stability. Determinism here is a hard
 * requirement (see this module's doc comment), and leaning on an
 * implementation's stability guarantee for it is the kind of thing that
 * silently stops being true.
 */
export function pickThreat(enemies, player, profile, map, tuning = DEFAULT_TUNING) {
  // `i` is the enemy's index in the engine's own `this.enemies` array
  // (stable for a whole level) — used by `decide` to recognize "same
  // enemy as last tick" for the last-visible-position freeze.
  const candidates = enemies
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.alive && e.aggroed)
    .map((e) => ({
      ...e,
      dist: Math.hypot(e.x - player.x, e.y - player.y),
      visible: !map || hasLineOfSight(map, player.x, player.y, e.x, e.y),
    }))
    .filter((e) => e.dist < profile.engageRadius);
  candidates.sort((a, b) => {
    const aQuick = a.dist <= tuning.MELEE_RANGE || a.edgeCase;
    const bQuick = b.dist <= tuning.MELEE_RANGE || b.edgeCase;
    if (aQuick !== bQuick) return aQuick ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.i - b.i;
  });
  return candidates[0];
}

/**
 * A mine only counts as "disarmable from here" if there's a clear shot —
 * `visible` only means the mine has been spotted, not that it's actually
 * hittable from the player's current position. Also excludes mines well off
 * to the side of or behind `navTarget`'s direction (see
 * MINE_DISARM_MAX_ANGLE_FROM_PATH) — a mine this far off-path isn't a real
 * threat to the route.
 *
 * `reactionBufferTiles` (default 0) shifts *both* ends of the eligible
 * distance window outward by the same amount as `findDangerousMine`'s own
 * buffer, rather than just raising the lower bound alone — the designed
 * "disarm zone" width (`MINE_DISARM_RANGE - MINE_BLAST_RADIUS`) stays the
 * same, just moved farther out. Widening only the lower bound would shrink
 * that zone every time the buffer grows, and at a real decision window long
 * enough (`MultiplayerBot`'s own `DEFAULT_STEP_MS`), it can collapse to
 * nothing — confirmed directly: `findDangerousMine`'s own widened-but-
 * unshifted-here buffer first fix made every mine reachable from a real
 * multiplayer decision window count as "dangerous," so the bot never
 * disarmed one again and got stuck retreating from a mine the route
 * genuinely needed it to clear.
 */
export function findDisarmableMine(mines, player, abandoned, map, navTarget, reactionBufferTiles = 0, tuning = DEFAULT_TUNING) {
  const navAngle = navTarget ? Math.atan2(navTarget.y - player.y, navTarget.x - player.x) : null;
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist > tuning.MINE_BLAST_RADIUS + reactionBufferTiles && m.dist <= tuning.MINE_DISARM_RANGE + reactionBufferTiles)
    .filter((m) => hasLineOfSight(map, player.x, player.y, m.x, m.y))
    .filter((m) => {
      if (navAngle === null) return true;
      const mineAngle = Math.atan2(m.y - player.y, m.x - player.x);
      return Math.abs(angleDelta(navAngle, mineAngle)) <= tuning.MINE_DISARM_MAX_ANGLE_FROM_PATH;
    })
    .sort((a, b) => a.dist - b.dist)[0];
}

/**
 * A visible mine close enough to be actively dangerous (inside its own blast
 * radius, plus `reactionBufferTiles`) rather than just a target to line up a
 * shot on — "stop, back up" comes before "shoot" (see `decide`'s
 * mine-handling doc comment).
 *
 * `reactionBufferTiles` (default 0, i.e. exactly `MINE_BLAST_RADIUS`) exists
 * because a mine's own fuse (`MINE_FUSE_SECONDS`, `traps.ts`) ticks in real
 * time regardless of how often this function gets called — a decision-window
 * long enough to cover more real ground than the gap between "just outside
 * blast radius" and "already caught in it" leaves the bot with no chance to
 * react between one decision seeing "safe" and a mine detonating mid-window.
 * Confirmed directly against `MultiplayerBot`'s much longer real decision
 * window (`DEFAULT_STEP_MS`, 400ms vs. single-player's own realtime
 * `WATCH_STEP_MS`, 130ms): a bot standing 3-4 tiles from its own *disarm*
 * target (correctly beyond `MINE_BLAST_RADIUS` from that one) still took real
 * splash damage from a *different*, closer mine in the same cluster that had
 * already been armed and went off entirely within one held decision, with no
 * chance to retreat from it first. Callers pass their own real
 * `ENGINE_MOVE_SPEED * ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000)` — at
 * single-player's own short decision windows this rounds to well under a
 * tile, a harmless no-op widening; only a caller with a long real decision
 * window (multiplayer) gets a buffer that actually matters.
 */
export function findDangerousMine(mines, player, abandoned, reactionBufferTiles = 0, tuning = DEFAULT_TUNING) {
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist <= tuning.MINE_BLAST_RADIUS + reactionBufferTiles)
    .sort((a, b) => a.dist - b.dist)[0];
}

/**
 * Whether a *spotted* live mine sits close enough to `(x, y)` to catch the
 * player if they step there. Visible-only on purpose, matching
 * `findDangerousMine`: an unspotted mine is information the player does not
 * have either, and the bot must not route around what it cannot see.
 */
export function visibleMineNear(mines, x, y, tuning = DEFAULT_TUNING) {
  return (mines ?? []).some((m) => m.alive && m.visible && Math.hypot(m.x - x, m.y - y) <= tuning.MINE_BLAST_RADIUS);
}

// ---------------------------------------------------------------------------
// Weapon selection
// ---------------------------------------------------------------------------

/**
 * Per-weapon economics, mirroring `src/engine/weapons.ts`'s `WEAPONS` entries —
 * plain literals rather than importing that TS module, the same convention the
 * tile/speed constants above use (this is a plain Node script, not bundled).
 *
 * `fireIntervalSec` is now melee-only in its `null` form: **every ranged weapon
 * carries an engine-side rate cap**, semi-auto ones included (the pistol at
 * 0.15s and the shotgun at 0.85s were the last two without one, and gained
 * theirs together with the shotgun's 18 -> 25 damage bump — see `weapons.ts`).
 * `profile.fireCooldownMs` did not become redundant: it is an *additional*
 * human-hand dispatch limit stacked on top, and the two compose via `max` —
 * whichever is slower is what actually paces the bot (see `scoreRangedWeapon`
 * and the fire gate in `decide`). Melee weapons (knife, Toolchain) are
 * deliberately absent — `pickRangedWeapon` only ever chooses among ranged ones.
 */
export const WEAPON_STATS = {
  [PISTOL_WEAPON_INDEX]: { pellets: 1, damagePerPellet: 22, ammoPerShot: 1, ammoType: "bullets", spreadPx: 0, fireIntervalSec: 0.15 },
  // 25, not 18: the pump cap below would otherwise have left the shotgun at
  // 7x18/0.85s = 148 DPS against the pistol's 22/0.15s = 147, i.e. identical
  // output for 4x the ammo out of the same "bullets" pool. At 25 it lands
  // 7x25/0.85s = 206 DPS. Mirrors weapons.ts, where the two numbers are
  // explicitly tuned against each other.
  [SHOTGUN_WEAPON_INDEX]: { pellets: 7, damagePerPellet: 25, ammoPerShot: 4, ammoType: "bullets", spreadPx: 70, fireIntervalSec: 0.85 },
  // gdb tightens the shared cone deliberately, so it stays usable at range
  // despite low per-shot damage (`maxConeDeviationPx` in weapons.ts).
  [GDB_WEAPON_INDEX]: { pellets: 1, damagePerPellet: 12, ammoPerShot: 1, ammoType: "smg", spreadPx: 0, fireIntervalSec: 0.09, maxConeDeviationPx: 20 },
  [GHIDRA_WEAPON_INDEX]: { pellets: 1, damagePerPellet: 150, ammoPerShot: 1, ammoType: "rockets", spreadPx: 0, fireIntervalSec: 1.1 },
  // `maxRange` mirrors `src/engine/weapons.ts` — Friday Hotfix is the only
  // weapon with a hard cutoff (a flame jet, not a falloff curve). Past it the
  // shot simply does not reach, so it must not be scored as a candidate.
  [FRIDAY_HOTFIX_WEAPON_INDEX]: { pellets: 6, damagePerPellet: 8, ammoPerShot: 2.5, ammoType: "gas", spreadPx: 45, fireIntervalSec: 0.1, maxRange: 3.5 },
};

/**
 * Melee weapons, same shape as `WEAPON_STATS` but kept separate because
 * `pickRangedWeapon` must never return one. `Space` swings whatever melee
 * weapon is owned (the Toolchain *replaces* the knife on pickup rather than
 * occupying its own slot), so there is nothing to switch to — this table
 * exists to reason about whether closing to melee is worth it.
 */
export const MELEE_WEAPON_STATS = {
  [KNIFE_WEAPON_INDEX]: { damagePerPellet: 40, fireIntervalSec: null },
  [TOOLCHAIN_WEAPON_INDEX]: { damagePerPellet: 80, fireIntervalSec: 0.35 },
};

/** Damage one melee swing lands, given whichever melee weapon is owned. */
export function meleeDamage(player) {
  return player.ownedWeapons?.includes(TOOLCHAIN_WEAPON_INDEX)
    ? MELEE_WEAPON_STATS[TOOLCHAIN_WEAPON_INDEX].damagePerPellet
    : MELEE_WEAPON_STATS[KNIFE_WEAPON_INDEX].damagePerPellet;
}

/** Whether any ranged weapon the player owns still has ammo. */
export function hasAnyRangedAmmo(player) {
  return Object.keys(WEAPON_STATS).some((i) => player.ownedWeapons?.includes(Number(i)) && hasAmmoFor(player, Number(i)));
}

/**
 * Whether to close the remaining distance and swing instead of shooting.
 *
 * Two cases, both about ammo economy rather than damage:
 *
 * - **Last resort.** Every ranged weapon is dry. Firing an empty gun does
 *   nothing at all, so without this the bot stands in front of a threat
 *   pulling a trigger that no longer works.
 * - **Edge cases.** An Edge Case enemy has 10-15 HP and dies to a single swing
 *   (knife 40, Toolchain 80). Spending bullets on one is pure waste, and melee
 *   also returns lifesteal, which is the biggest survivability lever the bot
 *   has. Only worth crossing a short gap for, hence the radius.
 *
 * Deliberately not "melee whenever it out-scores the gun": closing on a
 * healthy ranged enemy trades a safe distance for damage taken, which is the
 * trade `MELEE_RANGE` already declines everywhere else.
 */
export function shouldCloseToMelee(threat, player, profile, tuning = DEFAULT_TUNING) {
  if (!threat) return false;
  // Melee is never *sought out*: the bot does not walk a single tile to set one
  // up, at any range, for any target. But it does swing at something already in
  // its face rather than firing a gun at contact range.
  //
  // That last clause is not a preference, it is a measured requirement.
  // "Always shoot, melee only when dry" was implemented and measured, and it is
  // *worse*: level-1 deaths per 60 attempts, all `fatal=trapMine`,
  //
  //   melee when already in reach (this)        0 / 60
  //   never melee while any ammo remains        3 / 60
  //   walk 2.0t to a one-swing kill             4 / 60
  //   walk 3.5t to a one-swing kill             2 / 60
  //
  // The strict version dies with the knife never drawn, because `destroyMine`
  // (engine.ts) says it plainly: a mine hit by gunfire detonates, and
  // "shooting one at point-blank still hurts whoever's close" — the shooter
  // eats `mineDamageAt` its own position. Firing at contact range in a level
  // holding mines detonates them onto the bot. A swing spends no bullet and
  // starts no explosion.
  //
  // And any rule that makes the bot *approach* is worse still: 27 of level 1's
  // 32 enemies are <=15 HP Edge Cases, so it fires constantly, and the mines
  // that kill are unspotted — the bot must not route around what it has not
  // seen, so no guard can save it.
  // Off by default (`MELEE_MAX_TARGET_HP` is Infinity) — see its own comment
  // in DEFAULT_TUNING for what this is for and what it deliberately is not.
  // Checked before the range test so it also suppresses the "keep closing the
  // last bit of distance" step in `decide`'s melee branch, which is the part
  // that actually produces the 0.5-tile median against Elites.
  if (hasAnyRangedAmmo(player) && threat.hp > tuning.MELEE_MAX_TARGET_HP) return false;
  return threat.dist <= tuning.MELEE_RANGE || !hasAnyRangedAmmo(player);
}



/** Ammo currently held for `weaponIndex`, or `Infinity` for a weapon that
 * costs none. */
export function ammoHeldFor(player, weaponIndex) {
  const type = WEAPON_STATS[weaponIndex]?.ammoType;
  return type ? (player.ammo?.[type] ?? 0) : Infinity;
}

/**
 * Damage one trigger pull of `weaponIndex` is expected to land on a single
 * target at `dist` tiles.
 *
 * Multi-pellet weapons only put their whole spread on one target up close;
 * past that the cone is wider than the target and the extra pellets are spent
 * on air. Modelled as a linear falloff from all pellets at point blank to one
 * pellet at `SPREAD_FALLOFF_TILES`, scaled by how wide the weapon's cone is.
 * This is an approximation of the engine's real per-pellet raycast, not a
 * derivation of it — its job is to rank weapons against each other, and the
 * A/B is what validates the ranking.
 */
export function expectedDamagePerShot(weaponIndex, dist, tuning = DEFAULT_TUNING, target = null) {
  const w = WEAPON_STATS[weaponIndex];
  if (!w) return 0;
  if (w.maxRange !== undefined && (dist ?? 0) > w.maxRange) return 0;
  const d = Math.max(0.1, dist ?? 0);

  // How wide the target actually is on screen, from `projectEnemy`:
  // `size = |SCENE_HEIGHT / depth| * ENEMY_SIZE * scale`, so half-width in
  // pixels is that over two. Elites project larger and Edge Cases smaller,
  // which is a real part of how hard each is to hit.
  const scale = target?.elite ? tuning.ELITE_SPRITE_SCALE : target?.edgeCase ? tuning.EDGE_CASE_SPRITE_SCALE : 1;
  const halfWidthPx = (tuning.SCENE_HEIGHT_PX * tuning.ENEMY_SPRITE_SIZE * scale) / (2 * d);

  // Cone of Fire, exactly as the engine computes it: deviation grows with
  // `(range / FOG_FAR)³` up to the weapon's own maximum. Cubic, so medium
  // range stays reliable and only the last stretch before the fog line
  // really opens up.
  const rangeFraction = Math.min(1, d / tuning.FOG_FAR_TILES);
  const coneDeviationPx = rangeFraction ** 3 * (w.maxConeDeviationPx ?? tuning.MAX_CONE_DEVIATION_PX);

  // Multi-pellet weapons additionally scatter across their own spread.
  const spreadHalfPx = (w.spreadPx ?? 0) / 2;
  const scatterPx = spreadHalfPx + coneDeviationPx;

  // Fraction of pellets expected to land: the target's angular width against
  // the total scatter. An approximation of the engine's per-pellet raycast,
  // not a derivation of it — its job is to rank weapons against each other.
  const hitFraction = scatterPx <= 0 ? 1 : Math.max(0, Math.min(1, halfWidthPx / scatterPx));
  return w.pellets * w.damagePerPellet * hitFraction;
}

/**
 * Rank a ranged weapon for killing a specific target: how long it takes, and
 * how much of a finite reserve it burns doing so.
 *
 * Returns seconds — a *cost*, lower is better — where the ammo term is
 * converted into seconds-equivalent so the two axes are comparable. A profile
 * dials the exchange rate via `ammoThrift`: a thrifty profile pays real time to
 * conserve, a spendthrift one burns the reserve to end the fight sooner.
 *
 * The two axes genuinely conflict, which is why a fixed priority list cannot
 * express this: the shotgun is both faster *and* more damage-per-bullet than
 * the pistol up close, while ghidra is the most ammo-efficient weapon in the
 * game (150/rocket) but slow, and Friday Hotfix is the fastest killer and the
 * most wasteful.
 */
export function scoreRangedWeapon(weaponIndex, { targetHp, dist, player, profile, threat = null, tuning = DEFAULT_TUNING }) {
  const w = WEAPON_STATS[weaponIndex];
  if (!w) return Infinity;
  // A hard `maxRange` is not a falloff — the shot doesn't arrive at all.
  // Without this the flamethrower's huge close-range DPS made it the top pick
  // at any distance: measured on demo-campaign level 12 as 74 shots, 16 hits
  // and *zero* kills, burning gas on a target it could not reach.
  if (w.maxRange !== undefined && (dist ?? 0) > w.maxRange) return Infinity;
  const dmg = expectedDamagePerShot(weaponIndex, dist, tuning, threat);
  if (dmg <= 0) return Infinity;
  const shots = Math.max(1, Math.ceil((targetHp ?? tuning.ASSUMED_TARGET_HP) / dmg));
  // A shot's real cadence is whichever of the two limits binds. The engine's
  // own `fireIntervalSec` caps every ranged weapon now (it used to cap only
  // the autos and ghidra, which is why this was a `??` — "engine cap, else the
  // bot's trigger finger"). On top of that sits `profile.fireCooldownMs`, the
  // bot's dispatch rate, which only applies to semi-autos: an auto weapon is
  // fired by *holding* the key, so there is no per-shot dispatch to throttle
  // and the engine rate is the whole story. The old `??` reached that same
  // answer for autos by accident; this states it.
  //
  // Concretely, per shot: pistol 0.220s Casual / 0.160s Gamer (their trigger
  // is slower than the engine's 0.15s), 0.150s Pro (the engine now binds,
  // where 0.120s used to). Shotgun 0.850s for every profile. Ghidra 1.1s,
  // unchanged — it was always slower than any cooldown.
  const engineSec = w.fireIntervalSec ?? 0;
  const dispatchSec = AUTO_RANGED_WEAPON_INDICES.has(weaponIndex) ? 0 : (profile.fireCooldownMs ?? tuning.VIRTUAL_STEP_MS) / 1000;
  const secPerShot = Math.max(engineSec, dispatchSec);
  const killSec = shots * secPerShot;

  // Self-inflicted damage is a cost like any other: a weapon that takes 84 HP
  // off you is not "efficient", however few rockets it spends. Graded rather
  // than a hard gate, so a thin safety margin makes ghidra unattractive
  // *before* it becomes outright unsafe.
  let selfHarmSec = 0;
  if (weaponIndex === GHIDRA_WEAPON_INDEX) {
    const effective = rocketDetonationDistanceAfterClosing(dist ?? 0, threat, tuning);
    const margin = (effective - tuning.ROCKET_SAFE_DISTANCE) / Math.max(1e-6, tuning.ROCKET_SAFE_DISTANCE);
    const risk = Math.max(0, Math.min(1, 1 - margin));
    selfHarmSec = (profile.selfHarmAversion ?? tuning.DEFAULT_SELF_HARM_AVERSION) * risk * tuning.SELF_HARM_PENALTY_SEC;
  }

  const held = ammoHeldFor(player, weaponIndex);
  if (!Number.isFinite(held)) return killSec + selfHarmSec; // free to fire
  const cost = shots * w.ammoPerShot;
  // Fraction of what's actually in reserve, so "expensive" is relative to
  // supply rather than an absolute number — 19 rockets is scarce, 700 smg is
  // not, and the same shot count means very different things against each.
  const burn = cost / Math.max(1, held);
  const thrift = profile.ammoThrift ?? tuning.DEFAULT_AMMO_THRIFT;
  return killSec + thrift * burn * tuning.AMMO_BURN_PENALTY_SEC + selfHarmSec;
}

export function hasAmmoFor(player, weaponIndex) {
  if (weaponIndex === 0 || weaponIndex === 1) return player.ammo.bullets > 0;
  if (weaponIndex === GDB_WEAPON_INDEX) return player.ammo.smg > 0;
  if (weaponIndex === GHIDRA_WEAPON_INDEX) return player.ammo.rockets > 0;
  if (weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX) return player.ammo.gas > 0;
  return true;
}

/**
 * Distance along the player's current firing ray to the nearest point where
 * an in-flight rocket would actually detonate against a living enemy — not
 * just the intended target's own distance (a rocket explodes on the FIRST
 * living enemy it comes within ROCKET_ENEMY_TRIGGER_RADIUS of, tracked or
 * not). Deliberately doesn't account for walls between the player and an
 * in-path enemy — a rare enough edge case not worth the added complexity.
 */
export function nearestRocketDetonationDistance(player, enemies, tuning = DEFAULT_TUNING) {
  let nearest = Infinity;
  const dirX = player.dirX;
  const dirY = player.dirY;
  const triggerSq = tuning.ROCKET_ENEMY_TRIGGER_RADIUS * tuning.ROCKET_ENEMY_TRIGGER_RADIUS;
  for (const e of enemies) {
    if (!e.alive) continue;
    const ex = e.x - player.x;
    const ey = e.y - player.y;
    const t = ex * dirX + ey * dirY; // distance along the firing ray to closest approach
    if (t < 0 || t >= nearest) continue; // behind the player, or already not the closest
    const perpSq = ex * ex + ey * ey - t * t;
    if (perpSq <= triggerSq) nearest = t;
  }
  return nearest;
}

/**
 * True if firing a rocket right now is unsafe: (1) a rocket has zero
 * interaction with mines — never fire one at a mine target, at any
 * distance; (2) the intended target or some other untracked living enemy
 * sits close enough to the flight path to trigger an earlier, closer
 * detonation than expected.
 */
/**
 * How close the rocket's own target will have got by the time it lands.
 *
 * A rocket is not instantaneous: it covers `aimDist` at
 * `ROCKET_TRAVEL_SPEED`, and a chasing enemy spends that whole flight walking
 * *toward* the shooter. An Edge Case closes 3.74 tiles/sec, so a shot taken at
 * a "safe" 5 tiles detonates barely a tile away.
 *
 * This is why a single static `ROCKET_SAFE_DISTANCE` was not enough once
 * `pickRangedWeapon` started choosing ghidra on its merits: measured directly,
 * `selfRocket` damage went from 0 across an entire campaign to 84 and 99 in
 * consecutive runs, one of them the fatal blow.
 */
export function rocketDetonationDistanceAfterClosing(aimDist, threat, tuning = DEFAULT_TUNING) {
  if (aimDist === null || aimDist === undefined) return aimDist;
  const flightSec = aimDist / tuning.ROCKET_TRAVEL_SPEED;
  const closingSpeed = threat?.aggroed === false ? 0 : threat?.edgeCase ? tuning.EDGE_CASE_CHASE_SPEED : tuning.ENEMY_CHASE_SPEED;
  return aimDist - closingSpeed * flightSec;
}

export function rocketAimUnsafe(player, enemies, aimDist, isMineTarget, tuning = DEFAULT_TUNING, threat = null) {
  if (isMineTarget) return true;
  if (aimDist !== null && aimDist < tuning.ROCKET_SAFE_DISTANCE) return true;
  // The target is not where it will be when the rocket arrives.
  if (aimDist !== null && rocketDetonationDistanceAfterClosing(aimDist, threat, tuning) < tuning.ROCKET_SAFE_DISTANCE) return true;
  return nearestRocketDetonationDistance(player, enemies, tuning) < tuning.ROCKET_SAFE_DISTANCE;
}

/**
 * Best ranged weapon for the current situation, not just a fixed
 * per-profile preference order. Once 2+ aggroed enemies are clustered near
 * the current threat, picks a weapon suited to the cluster's distance:
 * close → Friday Hotfix (falling back to shotgun), distant (and only for
 * profiles confident enough to use rockets this way) → Ghidra, everything
 * else → shotgun. Falls back to `profile.weaponPriority` otherwise. Never
 * selects ghidra within ROCKET_SAFE_DISTANCE regardless of source. Never
 * returns a melee index.
 */
export function pickRangedWeapon(player, profile, enemies, threat, mineTarget, tuning = DEFAULT_TUNING) {
  if (threat) {
    const clusterCount = enemies.filter((e) => e.alive && e.aggroed && Math.hypot(e.x - threat.x, e.y - threat.y) <= tuning.CLUSTER_RADIUS).length;
    if (clusterCount >= 2) {
      if (threat.dist <= tuning.FRIDAY_HOTFIX_MAX_RANGE) {
        if (player.ownedWeapons.includes(FRIDAY_HOTFIX_WEAPON_INDEX) && hasAmmoFor(player, FRIDAY_HOTFIX_WEAPON_INDEX)) {
          return player.weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX ? null : FRIDAY_HOTFIX_WEAPON_INDEX;
        }
      } else if (
        threat.dist >= tuning.ROCKET_CLUSTER_MIN_DIST &&
        profile.rocketForDistantClusters &&
        !threat.edgeCase && // see the Edge Case note in the scoring loop below
        player.ownedWeapons.includes(GHIDRA_WEAPON_INDEX) &&
        hasAmmoFor(player, GHIDRA_WEAPON_INDEX) &&
        !rocketAimUnsafe(player, enemies, threat.dist, false, tuning, threat)
      ) {
        return player.weaponIndex === GHIDRA_WEAPON_INDEX ? null : GHIDRA_WEAPON_INDEX;
      }
      if (player.ownedWeapons.includes(1) && hasAmmoFor(player, 1)) {
        return player.weaponIndex === 1 ? null : 1; // Regex Shotgun
      }
    }
  }
  // Ghidra is excluded outright whenever the aim source is a mine, not just
  // when it's judged "too close" (a rocket flies straight through a mine to
  // an unaccounted-for wall — see `rocketAimUnsafe`'s doc comment).
  const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
  // Rank by what the shot actually costs to make, not by a fixed list.
  //
  // A static `weaponPriority` cannot express the real trade: the shotgun is
  // both faster and more damage-per-bullet than the pistol up close, ghidra is
  // the most ammo-efficient weapon in the game but slow, and Friday Hotfix is
  // the fastest killer and the most wasteful. Which of those is *right*
  // depends on the target's HP and on how much of the relevant reserve the
  // kill would burn — measured directly on demo-campaign level 12, where the
  // bot spent 44s of pistol on a 4400 HP Elite while holding 609 gas that
  // would have ended it in 9s.
  //
  // `weaponPriority` is kept as the tiebreak, so a profile's personality still
  // decides between options the economics rate as equivalent.
  const targetHp = threat?.hp ?? (mineTarget ? tuning.ASSUMED_TARGET_HP : tuning.ASSUMED_TARGET_HP);
  let best = null;
  let bestScore = Infinity;
  for (const idx of profile.weaponPriority) {
    // An Edge Case never warrants a rocket: they are 10-15 HP "tiny
    // annoyances" by design, so a 150-damage round is pure waste — it spends
    // the scarcest ammo in the game and buys splash risk for a target a single
    // melee swing already kills.
    if (idx === GHIDRA_WEAPON_INDEX && threat?.edgeCase) continue;
    if (idx === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget), tuning, threat)) continue;
    if (!player.ownedWeapons.includes(idx)) continue;
    if (!hasAmmoFor(player, idx)) continue;
    const score = scoreRangedWeapon(idx, { targetHp, dist: aimDist ?? 0, player, profile, threat, tuning });
    // Strictly-less keeps `weaponPriority` order as the tiebreak, since the
    // list is walked in order.
    if (score < bestScore - tuning.WEAPON_SCORE_TIEBREAK_EPS) {
      bestScore = score;
      best = idx;
    }
  }
  if (best === null) return null;
  return player.weaponIndex === best ? null : best;
}

// ---------------------------------------------------------------------------
// Intent construction and segmentation
// ---------------------------------------------------------------------------

/**
 * Build an intent from a key set that all shares one duration — the shape every
 * branch produces today, and the reason this extraction is behaviour-neutral.
 *
 * `durationMs === undefined` means "hold for the caller's whole step", which is
 * distinct from any specific number: several branches leave the burst unset
 * while still holding keys (the ranged approach with no turn key, for one), and
 * those hold for the entire window.
 */
export function uniformIntent(keys, durationMs, stepMs, rest) {
  const hold = durationMs ?? stepMs;
  const holds = new Map();
  for (const key of keys) holds.set(key, hold);
  return { holds, durationMs, fire: false, useMelee: false, weaponSwitchIndex: null, firedSemiAuto: false, ...rest };
}

/**
 * Split an intent's per-key holds into the sequence of dispatch phases that
 * realises them, given the decision's total duration.
 *
 * A key whose hold is shorter than the decision simply stops appearing in later
 * phases; the caller's held-key diff then releases it for free. This is what
 * lets a turn key finish early while a movement key keeps going — the thing that
 * makes "turn and move at once" expressible at all.
 *
 * **Today this always returns exactly one phase**, because every branch still
 * gives all its keys the same duration. That is the point: the mechanism lands
 * without changing a single dispatch, so a later behaviour change is measured
 * on its own.
 *
 * `minPhaseMs` is a floor, not a nicety. In multiplayer a phase shorter than the
 * lockstep input delay never lands before the next one is issued — the
 * documented "spin in place, compounding stale turns" failure. Rather than
 * risk it, a decision that would produce any phase under the floor collapses
 * back to a single phase holding every key for the *shortest* hold, which is
 * exactly the pre-existing behaviour. So multiplayer can never be made worse
 * than it already is by this mechanism, only left alone.
 */
export function segmentsFor(holds, durationMs, minPhaseMs = 0) {
  if (!holds || holds.size === 0) return [{ keys: [], ms: durationMs }];
  const allKeys = [...holds.keys()];
  const cuts = [...new Set([...holds.values()].filter((v) => v > 0 && v < durationMs))].sort((a, b) => a - b);
  if (cuts.length === 0) return [{ keys: allKeys, ms: durationMs }];

  const phases = [];
  let prev = 0;
  for (const cut of [...cuts, durationMs]) {
    const ms = cut - prev;
    if (ms <= 0) continue;
    phases.push({ keys: [...holds.entries()].filter(([, v]) => v > prev).map(([k]) => k), ms });
    prev = cut;
  }
  if (minPhaseMs > 0 && phases.some((p) => p.ms < minPhaseMs)) {
    return [{ keys: allKeys, ms: Math.min(durationMs, ...holds.values()) }];
  }
  return phases;
}

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

/**
 * One decision: combat (or proactive mine-disarm) always preempts navigation.
 * Hazard-crossing suppresses combat entirely rather than detouring to a "safe
 * tile" (the nearest safe edge tile is often not on the way to the real
 * destination).
 *
 * `world.map` may be absent: `Bot#faceAngle` deliberately decides with no map
 * when a threat is present, so the hazard/spike-avoidance branches (which need
 * a real map) are skipped during a bare "face this angle" maneuver.
 *
 * `memory` is the caller's per-level scratch object, mutated in place — mine
 * give-up bookkeeping, the last-visible-threat freeze, the stall counters, and
 * `turnBurstMs`'s rotation-anomaly handoff all live there.
 */
export function decide(world, memory, config) {
  const { player, enemies, mines, navTarget, map, projectiles = [] } = world;

  // Bearing error and distance to `navTarget`, computed *before* the early
  // returns below so the hazard/criticalHealth/mineRetreat branches record
  // them too. They did not at first, and the resulting `n/a` was actively
  // misleading — it reads as "no nav target" when it actually meant "this
  // branch returned before the fields were filled in", which sent one
  // diagnosis chasing the wrong call path entirely.
  const navDelta = navTarget ? angleDelta(Math.atan2(player.dirY, player.dirX), Math.atan2(navTarget.y - player.y, navTarget.x - player.x)) : null;
  const navDist = navTarget ? Math.hypot(navTarget.x - player.x, navTarget.y - player.y) : null;
  const { profile, tuning, stepMs, ignoreThreats, simTimeMs, lastFireSimTimeMs, minDecisionMs = 0, logger, selfId = null } = config;
  const burstCtx = { tuning, stepMs, memory };
  const moveCtx = { tuning, stepMs };

  // Currently standing on a damaging ground tile: don't stop to fight — get
  // off it.
  //
  // This used to march toward `navTarget`, i.e. wherever the bot happened to
  // be headed, and only ran when a nav target existed. Both were wrong, and
  // the cost was large: see `nearestSafeTile` for the measurements. Marching
  // at the goal is not an escape when the goal is across or beyond the acid,
  // and with no nav target there was no hazard handling at all — the bot
  // simply stood and burned. Head for the nearest safe tile instead, and fall
  // back to the old nav-target behaviour only when the map offers nothing
  // better.
  const standingInDamage = map && (isHazardAt(map, player.x, player.y) || activeSpikeAt(map, player.x, player.y, player.levelTime));
  const escapeTarget = standingInDamage ? (nearestSafeTile(map, player.x, player.y) ?? navTarget) : null;
  if (escapeTarget) {
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const targetAngle = Math.atan2(escapeTarget.y - player.y, escapeTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const dist = Math.hypot(escapeTarget.x - player.x, escapeTarget.y - player.y);
    const moveKeys = new Set(["KeyW", "ShiftLeft"]);
    let turnBurst;
    if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      // Deliberately no `diagonalStrafeKey` here — see its doc comment's
      // "confirmed regression" note. Reverted from every branch except
      // plain navigation.
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
    } else {
      turnBurst = moveBurstMs(dist, true, moveCtx);
    }
    return uniformIntent(moveKeys, turnBurst, stepMs, {
      branch: "hazard",
      trace: { branch: "hazard", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: null, delta: navDelta, navDist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
    });
  }

  const threat = ignoreThreats ? null : pickThreat(enemies, player, profile, map, tuning);

  // Break contact instead of trading hits — for two independent reasons that
  // want the identical movement, so they share one branch body and differ only
  // in the label they report.
  //
  //   criticalHealth — almost dead, disengage from anything.
  //   standoff       — healthy, but this target is too big to burst down and
  //                    is inside the range where the rocket is unusable.
  //
  // `standoff` is inert unless `STANDOFF_MIN_TARGET_HP` is set; see its comment
  // in DEFAULT_TUNING for why it exists and why the distance is 5.
  const criticalHealth = !!threat && player.healthFraction < tuning.CRITICAL_HEALTH_FRACTION;
  const standoff = !!threat
    && !criticalHealth
    && hasAnyRangedAmmo(player)
    && threat.hp > tuning.STANDOFF_MIN_TARGET_HP
    && threat.dist < tuning.STANDOFF_DISTANCE;
  if (threat && (criticalHealth || standoff)) {
    const breakContactBranch = criticalHealth ? "criticalHealth" : "standoff";
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const awayAngle = Math.atan2(player.y - threat.y, player.x - threat.x);
    const delta = angleDelta(currentAngle, awayAngle);
    const moveKeys = new Set(["ShiftLeft"]);
    if (tuning.NAV_BACKPEDAL_RETREAT) {
      // Run along the escape vector immediately, without turning to face it.
      //
      // Turning first is backwards in both senses: the bot spends decisions
      // rotating while something is closing on it, and — because `KeyW` was
      // held throughout — it *ran toward the threat* for the first half of a
      // large turn, exactly the defect measured in the mine retreat.
      // Reversing and strafing are the same speed as running forward
      // (`forwardSign` is signed and `diagonalScale` splits a diagonal across
      // two perpendicular axes for magnitude `step`, engine.ts), so there is
      // nothing to gain by facing the way you flee.
      //
      // Keeping the threat in view is the second half of the point: the bot
      // stays aimed at what it is escaping, which is what makes shooting
      // while retreating possible at all. (Firing here is deliberately *not*
      // part of this change — one variable at a time.)
      //
      // On `diagonalScale`: the recorded 72% level-2 death regression came
      // from bolting a lateral key onto a forward move, so the resultant sat
      // 45 degrees off the escape line and only 71% of the step went the
      // right way. Here the octant is *chosen* to point along the escape
      // vector, so the worst case is half an octant — 22.5 degrees, 92% —
      // and the total speed is unchanged either way.
      for (const key of movementKeysFor(delta)) moveKeys.add(key);
    } else {
      moveKeys.add("KeyW");
      if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      }
    }
    // A blocked "away" vector (cornered retreat) still won't move the
    // player — this branch returns before the shared end-of-decision
    // combatStallTicks bookkeeping ever runs, so it needs its own
    // same-position tracking.
    if (memory) {
      const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
      if (memory.criticalStallPos === posKey) {
        memory.criticalStallTicks = (memory.criticalStallTicks ?? 0) + 1;
      } else {
        memory.criticalStallPos = posKey;
        memory.criticalStallTicks = 0;
      }
      if (memory.criticalStallTicks >= tuning.CRITICAL_STALL_TICKS_THRESHOLD) {
        moveKeys.delete("KeyD");
        moveKeys.delete("KeyA");
        moveKeys.add(Math.floor(memory.criticalStallTicks / tuning.CRITICAL_STALL_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA");
      }
    }
    // Deliberately not `turnBurstMs` here — fleeing has no narrow
    // hit-window to protect against overshoot; a full sprint step every
    // tick converges toward genuinely-away without stalling.
    const turnBurst = moveBurstMs(10, true, moveCtx);
    return uniformIntent(moveKeys, turnBurst, stepMs, {
      branch: breakContactBranch,
      trace: { branch: breakContactBranch, x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: threat.dist, mineDist: null, delta: navDelta, navDist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
    });
  }

  // See `findDangerousMine`'s own doc comment for why this buffer exists —
  // a real, decision-window-scaled reaction margin, not a fixed tile count.
  // Shared by both mine checks below so the same shift applies to each end
  // of `findDisarmableMine`'s own eligible-distance window too (see its own
  // doc comment on why only widening one side of that window is wrong).
  const mineReactionBufferTiles = tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000);

  // Proper mine handling: stop, back up out of blast range, shoot it, then
  // continue. Backing away takes priority over shooting (below) since you
  // can't line up a safe shot from inside your own target's blast radius.
  if (!threat && profile.proactiveMineDisarm) {
    const dangerMine = findDangerousMine(mines, player, memory?.abandoned, mineReactionBufferTiles, tuning);
    if (dangerMine) {
      const key = `${dangerMine.x},${dangerMine.y}`;
      let gaveUp = false;
      if (memory) {
        memory.retreatTicks = memory.retreatKey === key ? memory.retreatTicks + 1 : 1;
        memory.retreatKey = key;
        gaveUp = memory.retreatTicks > tuning.MINE_TARGET_GIVEUP_TICKS;
        if (gaveUp) memory.abandoned.add(key); // e.g. wedged against a wall — stop trying, in either mode, for the rest of the level
      }
      if (!gaveUp) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const awayAngle = Math.atan2(player.y - dangerMine.y, player.x - dangerMine.x);
        const delta = angleDelta(currentAngle, awayAngle);
        const moveKeys = new Set();
        let turnBurst;
        // Where the mine sits relative to where the bot is looking. Reversing
        // straight back recovers `|cos|` of each step's distance from it.
        const towardMine = angleDelta(currentAngle, Math.atan2(dangerMine.y - player.y, dangerMine.x - player.x));
        const axialGain = Math.cos(towardMine);
        if (Math.abs(axialGain) >= tuning.MINE_BACKPEDAL_MIN_COS) {
          // Back off along the view axis without turning at all — `KeyS` if the
          // mine is ahead, `KeyW` if it is already behind.
          //
          // Turning was never necessary here, and it was actively harmful:
          // `moveForward` takes a signed step (`forwardSign -= 1` for `KeyS`,
          // engine.ts) so reversing is the same speed as advancing, sprint
          // included. Spinning 180 degrees first bought nothing and cost the
          // 3-6 decisions that let a retreat run out its
          // `MINE_TARGET_GIVEUP_TICKS` budget before ever clearing the blast
          // radius — the stage03 wedge.
          //
          // It is also what makes the disarm reachable at all: the bot stays
          // *facing* the mine, so the instant it crosses out of
          // `MINE_BLAST_RADIUS + reactionBuffer` it is already aimed and
          // `findDisarmableMine` can take the shot, instead of having to turn
          // back around to do it.
          moveKeys.add(axialGain > 0 ? "KeyS" : "KeyW");
          turnBurst = moveBurstMs(10, false, moveCtx);
        } else if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
          // Only walk once roughly facing away, the same gate plain navigation
          // uses. `KeyW` used to be held unconditionally here, so a retreat
          // that began facing the mine — the normal case, since you walk into
          // one before noticing it — spent its turn *advancing on the mine*.
          //
          // Captured on `stage03_legacy_api.php`: the bot moved 7.86 -> 7.41
          // (0.45 tiles closer, mine 2.5 -> 2.2) over five decisions while
          // turning around. That cost is what makes the retreat unable to
          // finish: `findDangerousMine` fires at `MINE_BLAST_RADIUS +
          // reactionBuffer` (2.72) and `findDisarmableMine` only starts
          // *above* it, but the bot never got past 2.6 before burning all
          // `MINE_TARGET_GIVEUP_TICKS` (40, exactly the count observed) and
          // abandoning the mine — so it could neither pass nor shoot it, and
          // stalled ~3.6s at a corridor whose only route runs past that mine.
          //
          // Deliberately *removing* forward motion rather than adding a
          // lateral key: `diagonalScale` (1/sqrt(2)) makes any strafe here cut
          // the escape axis by 29%, which is the documented 72% level-2 death
          // regression. This branch stays strictly turn-then-run.
          if (Math.abs(delta) < tuning.MAX_WALK_WHILE_TURNING_RAD) moveKeys.add("KeyW");
        } else {
          moveKeys.add("KeyW");
          turnBurst = moveBurstMs(10, false, moveCtx);
        }
        return uniformIntent(moveKeys, turnBurst, stepMs, {
          branch: "mineRetreat",
          trace: { branch: "mineRetreat", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: dangerMine.dist, delta: navDelta, navDist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
        });
      }
      // else: gave up retreating — fall through to normal navigation below.
    }
  }

  let mineTarget =
    !threat && profile.proactiveMineDisarm && map
      ? findDisarmableMine(mines, player, memory?.abandoned, map, navTarget, mineReactionBufferTiles, tuning)
      : null;
  if (mineTarget && memory) {
    const key = `${mineTarget.x},${mineTarget.y}`;
    memory.shootTicks = memory.shootKey === key ? memory.shootTicks + 1 : 1;
    memory.shootKey = key;
    if (memory.shootTicks > tuning.MINE_TARGET_GIVEUP_TICKS) {
      memory.abandoned.add(key); // e.g. a wall blocks line of fire — stop trying, in either mode, for the rest of the level
      mineTarget = null;
    }
  }
  // A threat's aggro is sticky, but `threat.x/y` is live even while
  // occluded — freeze the aim at wherever the threat was last actually
  // seen while occluded, only resuming live tracking once visible again.
  let threatAim = threat;
  if (threat && memory) {
    if (threat.visible) {
      memory.lastVisibleThreat = { i: threat.i, x: threat.x, y: threat.y };
    } else if (memory.lastVisibleThreat?.i === threat.i) {
      threatAim = memory.lastVisibleThreat;
    }
    // else: aggroed without this specific enemy ever having been seen yet
    // — no memory to fall back on, aim at the live position.
  }
  const aimTarget = threatAim ?? mineTarget;
  // Read the stall counter as last decision left it (updated at the bottom of
  // this function, after `fire` is known).
  const stallStrafeKey =
    threat && memory && (memory.combatStallTicks ?? 0) >= tuning.COMBAT_STALL_TICKS_THRESHOLD
      ? Math.floor(memory.combatStallTicks / tuning.COMBAT_STALL_STRAFE_FLIP_TICKS) % 2 === 0
        ? "KeyD"
        : "KeyA"
      : null;

  // Read as last decision left it, same as `stallStrafeKey` above — the
  // counter is advanced at the bottom of this function.
  const combatStrafeTicks = memory?.combatStrafeTicks ?? 0;

  const currentAngle = Math.atan2(player.dirY, player.dirX);
  const moveKeys = new Set();
  let turnBurst;
  let fire = false;
  // True when the bot was aimed, aligned, and otherwise ready to fire, but
  // held back purely by cadence — either `profile.fireCooldownMs` or the
  // weapon's own engine-side `fireIntervalSec`, whichever binds — a
  // legitimate reason to sit still, distinct from being stuck (see
  // `detectAnomalies`'s `mostlyFiring`/`mostlyEngaged` exclusion, which needs
  // this since a human-paced fire rate now means most ticks in a real
  // firefight don't actually pull the trigger).
  let fireOnCooldown = false;
  let weaponSwitch = null;
  let firedSemiAuto = false;
  logger?.debugNav?.(
    `[nav] pos=(${player.x.toFixed(2)},${player.y.toFixed(2)}) dir=${currentAngle.toFixed(2)} hpFrac=${player.healthFraction.toFixed(2)} ` +
      `threat=${threat ? `(${threat.x.toFixed(1)},${threat.y.toFixed(1)},dist=${threat.dist.toFixed(1)})` : "none"} ` +
      `mineTarget=${mineTarget ? `(${mineTarget.x},${mineTarget.y})` : "none"} navTarget=${navTarget ? `(${navTarget.x.toFixed(2)},${navTarget.y.toFixed(2)})` : "none"} ` +
      `weaponIndex=${player.weaponIndex} ammo=${JSON.stringify(player.ammo)} owned=${JSON.stringify(player.ownedWeapons)}`,
  );
  let useMelee = false;
  let waitingOnSpike = false;
  // Whether this decision's strafe was aimed at a specific inbound bolt rather
  // than the blind oscillation — the number that says whether the projectile
  // hook is earning its keep.
  let dodgedBolt = false;

  if (aimTarget) {
    const targetAngle = Math.atan2(aimTarget.y - player.y, aimTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    // Melee-in-range is a universal tactical choice for every profile:
    // free, and lifesteal is the single biggest survivability lever there
    // is. Gated on `player.meleeWouldHit` (the engine's own hit test)
    // rather than a fixed angle tolerance, since a melee swing's on-screen
    // hit window shrinks with distance/enemy size.
    if (shouldCloseToMelee(threat, player, profile, tuning)) {
      if (!player.meleeWouldHit) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
        // Also keep closing the last bit of distance, not just re-aiming
        // in place — the enemy's own chase AI is still walking between
        // MELEE_CLOSE_MIN_DISTANCE and MELEE_RANGE. Never closer than one
        // decision's own real forward-movement distance, though — holding
        // "keep closing" *and* a turn command together for a whole decision
        // that's long enough to cover that much ground traces a real arc
        // around the target instead of settling on it (confirmed directly
        // against a caller using a much longer real decision window than
        // this project's own single-player defaults —
        // `scripts/lib/multiplayerBot.mjs` — which spun in place
        // indefinitely at melee range with the tuning-only default alone).
        // `MELEE_CLOSE_MIN_DISTANCE` on its own already works out to almost
        // exactly this same distance at single-player's own realtime
        // `WATCH_STEP_MS` (0.4 tiles vs. 3.2 tiles/sec × 0.13s ≈ 0.42) —
        // this is a no-op there; it only widens the gate for a caller
        // using a longer decision window than that.
        const closeMinDistance = Math.max(tuning.MELEE_CLOSE_MIN_DISTANCE, tuning.ENGINE_MOVE_SPEED * (stepMs / 1000));
        if (map && threat.dist > closeMinDistance) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          // Mines belong in this gate for exactly the same reason hazard and
          // spike tiles do — and their absence was measured, not theorised:
          // making the bot walk out for a swing sent it
          // on ~27 blind walks per level-1 visit (27 of its 32 enemies are
          // <=15 HP Edge Cases) across a level holding 6 mines, and it died
          // `fatal=trapMine` with 111-116 mine damage in 2 of 60 attempts
          // where the 1.5-tile baseline died in 0 of 60.
          if (
            !isHazardAt(map, aheadX, aheadY) &&
            !activeSpikeAt(map, aheadX, aheadY, player.levelTime) &&
            !visibleMineNear(mines, aheadX, aheadY, tuning)
          ) {
            moveKeys.add("KeyW");
          }
        }
        if (stallStrafeKey) {
          moveKeys.add(stallStrafeKey);
          // NOTE: this also widens the *turn* key's hold, because
          // `uniformIntent` applies one scalar to every key. When a turn key is
          // present a small correction executes as a full decision's rotation —
          // measured at 8.3x (0.055rad needed, 0.455rad performed), and it is
          // the origin of the "[nav-warn] implausible rotation" log line:
          // 0.45rad is exactly one 50ms decision at Gamer's 9.1rad/s, 0.65rad
          // likewise at Pro's 13rad/s. Casual's 0.26rad falls under the
          // detector's 0.3 floor, which is why Casual never warns.
          //
          // Gating this on "no turn key held" was tried and **reverted**
          // (2026-07-29) after a matched-scale A/B: it removed the overshoot
          // completely (8.3x -> 1.0x, nav-warns 15 -> 0) but `enemyAccuracy`
          // rose on all three combos (+1.6/+0.6/+4.9%) and Gamer/normal
          // `qualifyRate` fell 15pp, breaching the pre-registered guard. The
          // widening is load-bearing for *dodging*, not aiming: without it the
          // stall-strafe key is held for a turn-sized burst and moves the bot
          // ~0.02 tiles, so it stops strafing and gets hit more. Don't "fix"
          // this without re-running that A/B.
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false, moveCtx));
        }
      } else {
        fire = true;
        useMelee = true;
      }
    } else {
      // Don't fire at an aggroed-but-currently-occluded threat — aggro is
      // sticky, so an aligned angle doesn't guarantee a clear shot.
      const hasLos = !threat || !map || hasLineOfSight(map, player.x, player.y, threat.x, threat.y);
      // A stationary mine's on-screen width at typical disarm range is
      // narrower than any fixed fireAngleEps tolerance — gate on the
      // engine's own conservative `player.wouldMineHit` test instead,
      // unless realignment has stalled long enough to just take the shot.
      const mineRealignStalled = Boolean(memory) && memory.shootTicks > tuning.MINE_REALIGN_STALL_TICKS;
      const mineNotReady = !threat && !player.wouldMineHit && !mineRealignStalled;
      if (Math.abs(delta) > profile.fireAngleEps || !hasLos || mineNotReady) {
        if (Math.abs(delta) > (mineNotReady ? tuning.MINE_REALIGN_EPS : profile.fireAngleEps)) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
        }
        // Keep closing distance while lining up a ranged shot (threat-only,
        // not while aiming at a mine, and only outside melee range).
        if (threat && (threat.dist > tuning.MIN_RANGED_APPROACH_DISTANCE || !hasLos) && map) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
            moveKeys.add("KeyW");
          }
        }
        if (stallStrafeKey) {
          moveKeys.delete("KeyD");
          moveKeys.delete("KeyA");
          moveKeys.add(stallStrafeKey);
          // NOTE: this also widens the *turn* key's hold, because
          // `uniformIntent` applies one scalar to every key. When a turn key is
          // present a small correction executes as a full decision's rotation —
          // measured at 8.3x (0.055rad needed, 0.455rad performed), and it is
          // the origin of the "[nav-warn] implausible rotation" log line:
          // 0.45rad is exactly one 50ms decision at Gamer's 9.1rad/s, 0.65rad
          // likewise at Pro's 13rad/s. Casual's 0.26rad falls under the
          // detector's 0.3 floor, which is why Casual never warns.
          //
          // Gating this on "no turn key held" was tried and **reverted**
          // (2026-07-29) after a matched-scale A/B: it removed the overshoot
          // completely (8.3x -> 1.0x, nav-warns 15 -> 0) but `enemyAccuracy`
          // rose on all three combos (+1.6/+0.6/+4.9%) and Gamer/normal
          // `qualifyRate` fell 15pp, breaching the pre-registered guard. The
          // widening is load-bearing for *dodging*, not aiming: without it the
          // stall-strafe key is held for a turn-sized burst and moves the bot
          // ~0.02 tiles, so it stops strafing and gets hit more. Don't "fix"
          // this without re-running that A/B.
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false, moveCtx));
        }
        // Step off an incoming bolt even while still lining the shot up.
        //
        // Dodging used to live *only* in the fire branch below, which meant
        // the bot could evade a bolt only once it already had a firing
        // solution — `|delta| <= fireAngleEps` and line of sight. This branch
        // is the other ~57% of combat decisions (the module's own note puts
        // the fire branch at "roughly 43%"), and for all of it the bot was a
        // stationary target with no evasion available at all. Tuning dodge
        // *quality* per skill tier therefore had almost nothing to act on: a
        // 2026-08-01 sweep of the dodge constants moved the damage axes
        // barely, and the reason was availability, not quality.
        //
        // This is NOT the reverted "strafe while re-aiming" experiment. That
        // one added *blind* `combatStrafeKey` oscillation here, perturbing the
        // very heading it was trying to converge on every single decision, and
        // cost Gamer 30pp of qualify rate. A directed dodge fires only when a
        // bolt is genuinely inbound and on course — rare, and precisely when
        // being hit is otherwise certain.
        //
        // `KeyW` is dropped for the duration: holding forward *and* a lateral
        // key engages `engine.ts`'s `diagonalScale` (1/sqrt2), cutting the
        // forward axis 29% — the mechanism behind the 0%->72% level-2 death
        // regression. A human sidestepping a shot stops advancing too.
        if (tuning.DODGE_WHILE_REAIMING && threat && map && projectiles.length > 0) {
          const lookaheadSec = Math.max(tuning.DODGE_MIN_LOOKAHEAD_SEC, tuning.DODGE_LOOKAHEAD_DECISIONS * (stepMs / 1000));
          const inbound = pickIncomingBolt(projectiles, player, lookaheadSec, tuning, selfId);
          if (inbound) {
            const dodgeDist = Math.max(
              tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000),
              tuning.COMBAT_STRAFE_LOOKAHEAD_TILES,
            );
            const wanted = dodgeStrafeKey(projectiles[inbound.i], inbound, player);
            const other = wanted === "KeyD" ? "KeyA" : "KeyD";
            let key = null;
            if (strafeIsSafe(map, player, wanted, dodgeDist, player.levelTime, { tuning })) key = wanted;
            else if (strafeIsSafe(map, player, other, dodgeDist, player.levelTime, { tuning })) key = other;
            if (key) {
              moveKeys.delete("KeyW");
              moveKeys.delete("KeyA");
              moveKeys.delete("KeyD");
              moveKeys.add(key);
              moveKeys.add("ShiftLeft");
              dodgedBolt = true;
              // Same widening the stall-strafe needs, and for the same reason:
              // one scalar covers every key, so without it a turn-sized burst
              // moves the bot ~0.02 tiles and the dodge does nothing.
              turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false, moveCtx));
            }
          }
        }
      } else {
        weaponSwitch = pickRangedWeapon(player, profile, enemies, threat, mineTarget, tuning);
        // Re-check the *effective* weapon (the switch target, or whatever's
        // already equipped) against the same rocket-safety check right
        // before actually firing, not just at selection time — an already-
        // equipped Ghidra with nothing better in inventory would otherwise
        // still fire unsafely.
        const effectiveWeapon = weaponSwitch ?? player.weaponIndex;
        const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
        const rocketUnsafe = effectiveWeapon === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget), tuning);
        // Semi-auto ranged weapons (pistol/shotgun/ghidra) fire exactly once
        // per `Backquote` keydown, so a fresh keydown dispatched every single
        // decision tick used to fire as fast as the tick loop allowed
        // (~20/sec headless), far beyond any human trigger-pull rate — that
        // is what `profile.fireCooldownMs` exists to stop. Auto weapons
        // (gdb/Friday Hotfix) are exempt: they are fired by *holding* the
        // key, so throttling the bot's dispatch here would only starve them
        // of frames to hold it down.
        //
        // The engine's own `fireIntervalSec` is the second limit, and since
        // it now covers every ranged weapon it can be the *slower* of the
        // two. The gap the bot has to respect is therefore the max: firing
        // into a live engine cooldown does nothing at all, but every such
        // decision is still recorded into the replay input stream as a
        // `fireQueued` frame. Without this the bot burned ~5 of every 6
        // shotgun decisions that way (0.85s pump vs a 0.12-0.22s trigger).
        //
        // This deliberately *widens* `fireOnCooldown`. That counter means
        // "aimed, willing, held back only by cadence", and it feeds
        // `detectAnomalies`' `mostlyFiring` stall exclusion so a bot that is
        // legitimately waiting out a cooldown isn't reported as stuck — a
        // bot standing still through an 0.85s pump is the textbook case.
        // Narrowing this counter once cost a 473-anomaly regression (see
        // `doc/dev/history.md`); widening it is the safe direction.
        const isAutoRanged = AUTO_RANGED_WEAPON_INDICES.has(effectiveWeapon);
        const engineIntervalMs = (WEAPON_STATS[effectiveWeapon]?.fireIntervalSec ?? 0) * 1000;
        const requiredGapMs = Math.max(profile.fireCooldownMs, engineIntervalMs);
        const fireReady = isAutoRanged || simTimeMs - lastFireSimTimeMs >= requiredGapMs;
        fire = !rocketUnsafe && fireReady;
        fireOnCooldown = !rocketUnsafe && !fireReady;
        firedSemiAuto = fire && !isAutoRanged;
        // Keep moving while shooting. This branch used to hold no keys at all
        // for a whole decision, which is why `enemyAccuracy` — nominally an
        // "are enemies too dangerous" stat — was really measuring how easy it
        // is to hit a target that stands perfectly still while returning fire.
        //
        // Lateral only, deliberately: adding `KeyW` here would engage
        // `engine.ts`'s `diagonalScale` and cut the forward component by 29%,
        // which is the mechanism behind the recorded 0%->72% diagonal-strafe
        // regression. No sprint either — one variable at a time, and a walking
        // step already displaces far more than a bolt's 0.35-tile hit box over
        // a bolt's flight time.
        //
        // Note this changes *which* keys are held, not how long the decision
        // runs: the branch already ran a full-length step. That matters
        // because committing to longer decisions is exactly what made the
        // per-key-duration attempt fail.
        if (threat && threat.dist > tuning.COMBAT_STRAFE_MIN_DISTANCE && map) {
          const strafeDist = Math.max(tuning.ENGINE_MOVE_SPEED * (stepMs / 1000), tuning.COMBAT_STRAFE_LOOKAHEAD_TILES);
          // Prefer a *directed* dodge when a bolt is genuinely inbound: step
          // away from its flight line rather than continuing the blind
          // oscillation, which is right only on average. Falls back to the
          // oscillation when nothing is incoming, so the bot is never a
          // stationary target either way.
          const lookaheadSec = Math.max(tuning.DODGE_MIN_LOOKAHEAD_SEC, tuning.DODGE_LOOKAHEAD_DECISIONS * (stepMs / 1000));
          const inbound = pickIncomingBolt(projectiles, player, lookaheadSec, tuning, selfId);
          let strafeKey = null;
          if (inbound) {
            // Sprint the dodge. This is the one moment the bot *knows* it is
            // about to be hit, and doubling lateral speed halves the time
            // needed to clear the 0.35-tile hit box — which matters because
            // only the fire branch strafes, so the usable reaction window is a
            // fraction of the bolt's flight. It stays off for the blind
            // oscillation, so it can't turn a standing dance into drift.
            //
            // Safe to combine with a strafe key specifically because no forward
            // key is held here: `engine.ts`'s `diagonalScale` only applies when
            // both a forward and a strafe axis are active, so this is pure
            // lateral speed rather than the 29%-forward-penalty case.
            const dodgeDist = Math.max(
              tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000),
              tuning.COMBAT_STRAFE_LOOKAHEAD_TILES,
            );
            const wanted = dodgeStrafeKey(projectiles[inbound.i], inbound, player);
            const other = wanted === "KeyD" ? "KeyA" : "KeyD";
            if (strafeIsSafe(map, player, wanted, dodgeDist, player.levelTime, { tuning })) strafeKey = wanted;
            else if (strafeIsSafe(map, player, other, dodgeDist, player.levelTime, { tuning })) strafeKey = other;
            if (strafeKey) {
              dodgedBolt = true;
              moveKeys.add("ShiftLeft");
            }
          }
          if (!strafeKey) strafeKey = combatStrafeKey(combatStrafeTicks, map, player, strafeDist, player.levelTime, { tuning });
          if (strafeKey) moveKeys.add(strafeKey);
        }
      }
    }
  } else if (navTarget) {
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const aheadX = player.x + player.dirX * 0.6;
    const aheadY = player.y + player.dirY * 0.6;
    const blockedAhead = map && activeSpikeAt(map, aheadX, aheadY, player.levelTime);
    waitingOnSpike = Boolean(blockedAhead);
    if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
      // Walk while still correcting heading, capped to angular errors
      // under MAX_WALK_WHILE_TURNING_RAD so a sharp corridor doubling-back
      // doesn't send the bot walking the wrong way while it turns around.
      if (Math.abs(delta) < tuning.MAX_WALK_WHILE_TURNING_RAD && !blockedAhead) {
        moveKeys.add("KeyW");
        moveKeys.add(diagonalStrafeKey(delta));
      } else if (!blockedAhead && tuning.NAV_FULL_WASD) {
        // Big heading error: keep moving *sideways or backwards* toward the
        // target instead of standing still until the turn finishes.
        //
        // The bot has full WASD and had never used it. Measured cost of
        // standing still: 385 route corners across the eight demo levels
        // exceed `MAX_WALK_WHILE_TURNING_RAD`, costing 1585 frozen decisions
        // = 79.3s, about 13.4% of total level time — `planRoute` emits one
        // waypoint per tile, so a winding corridor presents a 1.5-2.7 rad
        // bearing change every single tile.
        //
        // This is not the `diagonalStrafeKey` corner-cut behind the 72%
        // level-2 death regression. That added a *lateral* component to a
        // forward move in survival branches, where `diagonalScale` cut the
        // escape axis by 29%. Here the eight-way combination is chosen to
        // point at the target, total speed is unchanged (see
        // `movementKeysFor`), and this is plain navigation with no threat.
        const stepKeys = movementKeysFor(delta);
        const moveVec = movementVectorFor(stepKeys, player);
        const scan = forwardScanTiles(false, moveCtx);
        // Scanned along the *movement* vector, not the facing one — see
        // `movementVectorFor`. `hazard: false` for the same reason the
        // straight-leg sprint uses it: this heads along a committed route leg.
        const laterallyBlocked =
          !moveVec ||
          (map &&
            (segmentBlocked(map, player, moveVec, scan, player.levelTime, { tuning, hazard: false }) ||
              activeSpikeAt(map, player.x + moveVec.x * 0.6, player.y + moveVec.y * 0.6, player.levelTime)));
        if (!laterallyBlocked) for (const key of stepKeys) moveKeys.add(key);
      }
    } else if (!blockedAhead) {
      // Don't step onto an active spike trap — wait out its cycle instead.
      moveKeys.add("KeyW");
      // Sprint the straight legs. The engine's SPRINT_MULTIPLIER (2.0) is
      // free and unconditional, and the bot had simply never used it
      // outside the two emergency branches — it walked whole campaigns at
      // half speed, which inflates time-on-level, exposure, damage taken
      // and ammo spent, and is what pushed one demo-campaign level past
      // MAX_REPLAY_FRAMES_PER_LEVEL.
      //
      // Scoped to this sub-branch on purpose: here the heading is already
      // converged (|delta| <= TURN_MOVE_EPS), so there is no turn key and
      // therefore no interaction with the turn/move burst coupling — the
      // single variable being changed is speed.
      //
      // The burst must flip to `sprinting = true` in the same breath: it is
      // what caps the hold so the bot stops at the waypoint, and leaving it
      // at the walking speed would overshoot by exactly 2x.
      const dist = Math.hypot(navTarget.x - player.x, navTarget.y - player.y);
      // Sprinting halves how long the hold needs to be, and the hold *is*
      // the decision window — so on a short leg, sprinting can shrink the
      // window below what the transport can carry. Walking the same leg
      // gives twice the window, so falling back to a walk is what keeps the
      // window safe, not stopping. Always true under the virtual clock
      // (`minDecisionMs` 0), so single-player behaviour is unaffected.
      const windowSafe = moveBurstMs(dist, true, moveCtx) >= minDecisionMs;
      const sprintDist = forwardScanTiles(true, moveCtx);
      // Gate the sprint, not the movement. Stopping dead for a spike two
      // and a half tiles away would cost more level time than the damage it
      // avoids; walking simply shortens the look-ahead until the existing
      // `blockedAhead` check can make the call at close range.
      // `hazard: false` — this is a committed route leg, and sprinting
      // across acid the planner already decided was worth crossing spends
      // less time in it, not more.
      const sprinting =
        windowSafe && !segmentBlocked(map, player, { x: player.dirX, y: player.dirY }, sprintDist, player.levelTime, { tuning, hazard: false });
      if (sprinting) moveKeys.add("ShiftLeft");
      turnBurst = moveBurstMs(dist, sprinting, moveCtx);
    }
  }

  logger?.debugNav?.(
    `      -> moveKeys=[${[...moveKeys].join(",")}] fire=${fire} useMelee=${useMelee} weaponSwitch=${weaponSwitch} ` +
      `turnBurst=${turnBurst?.toFixed(0)} dodge=${dodgedBolt}`,
  );


  // A real attack attempt counts as progress even if position doesn't
  // change, so only an unchanging position with no attack counts toward
  // the stall.
  if (threat && memory) {
    const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
    if (!fire && memory.combatStallPos === posKey) {
      memory.combatStallTicks = (memory.combatStallTicks ?? 0) + 1;
    } else {
      memory.combatStallPos = posKey;
      memory.combatStallTicks = 0;
    }
    // Advances whenever a threat is engaged, so the flip period is measured in
    // decisions spent in combat rather than wall-clock — a slower profile
    // dances at the same spatial amplitude, not a wider one.
    memory.combatStrafeTicks = (memory.combatStrafeTicks ?? 0) + 1;
  } else if (memory) {
    memory.combatStallTicks = 0;
    memory.combatStallPos = null;
    memory.combatStrafeTicks = 0;
  }

  return uniformIntent(moveKeys, turnBurst, stepMs, {
    fire,
    useMelee,
    weaponSwitchIndex: weaponSwitch,
    firedSemiAuto,
    branch: "main",
    trace: {
      branch: "main",
      x: player.x,
      y: player.y,
      hpFrac: player.healthFraction,
      threatDist: threat?.dist ?? null,
      mineDist: mineTarget?.dist ?? null,
      waitingOnSpike,
      moveKeys: [...moveKeys],
      turnBurst,
      fire: fire || useMelee,
      fireOnCooldown,
      dodgedBolt,
      delta: navDelta,
      navDist,
    },
  });
}
