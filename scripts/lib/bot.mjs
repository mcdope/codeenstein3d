// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Reusable automated-playtest bot: navigation, combat, hazard/mine handling,
 * and loot-collection decision-making, driving the real game exclusively
 * through a Playwright `page` + `window.__codeensteinTestHooks` + synthetic
 * `KeyboardEvent`s — the same engine-agnostic boundary the original
 * (`scripts/run-balancing-telemetry.mjs`) always used, kept intact here so a
 * future non-Playwright control surface (e.g. a multiplayer bot) stays
 * swappable without touching decision logic. Extracted verbatim from that
 * script (and, before it, `scripts/generate-default-highscore.mjs`'s smaller
 * bot) — every doc comment below still describes the original bug/fix it was
 * written for; only the parameter-passing mechanism changed (explicit
 * `page`/`profile`/`map`/`mineMemory` args became `this.*`).
 *
 * Per-run state (`page`, `profile`, harness mode) is fixed for the lifetime
 * of one `Bot` instance — construct a fresh one per campaign attempt, same as
 * the original script's per-attempt scope. Per-level state (`map`,
 * `mineMemory`, `visitedPickups`) resets via `startLevel(map)`.
 */
import { bfsPath, pathToWaypoints } from "./pathfind.mjs";
import {
  angleDelta,
  decide,
  DEFAULT_TUNING,
  hasLineOfSight,
  HAZARD_TILE,
  pickThreat,
  segmentsFor,
  SPIKE_TRAP_TILE,
  turnBurstMs,
  uniformIntent,
} from "./combatPolicy.mjs";

// The decision core moved to `combatPolicy.mjs` (see its doc comment for why:
// testability, and a shape that can be lifted into `src/engine/` for a real
// deathmatch opponent). Everything it owns is re-exported from here so no
// consumer had to change an import — `run-balancing-telemetry.mjs` takes the
// weapon indices, and the rest is surface that tests and future callers reach
// for. New code should prefer importing from `combatPolicy.mjs` directly.
export {
  activeSpikeAt,
  angleDelta,
  AUTO_RANGED_WEAPON_INDICES,
  decide,
  DEFAULT_TUNING,
  diagonalStrafeKey,
  findDangerousMine,
  findDisarmableMine,
  forwardScanTiles,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  hasAmmoFor,
  hasLineOfSight,
  HAZARD_TILE,
  isHazardAt,
  isWallTile,
  KNIFE_WEAPON_INDEX,
  moveBurstMs,
  nearestRocketDetonationDistance,
  pickRangedWeapon,
  pickThreat,
  PISTOL_WEAPON_INDEX,
  rocketAimUnsafe,
  segmentBlocked,
  segmentsFor,
  SHOTGUN_WEAPON_INDEX,
  SPIKE_TRAP_TILE,
  STARTING_WEAPONS,
  TOOLCHAIN_WEAPON_INDEX,
  turnBurstMs,
  uniformIntent,
} from "./combatPolicy.mjs";

/**
 * Tiles a *loot detour* refuses to route through. Mirrors `routePlanner.mjs`'s
 * own `SOFT_AVOID_TILES`, but applied as a hard avoid rather than a cost:
 * the main route sometimes genuinely has to cross a hazard to reach the exit,
 * whereas a pickup is by definition optional, so taking damage for one is
 * never the right trade. `bfsPath` still allows the *target* tile itself to be
 * a hazard, so a pickup sitting on acid stays collectable — it just won't be
 * approached through more of it. */
const LOOT_DETOUR_AVOID_TILES = new Set([HAZARD_TILE, SPIKE_TRAP_TILE]);

// Position-unchanged-for-this-many-consecutive-ticks threshold before
// `detectAnomalies` calls it a "stall".
const STALL_TICKS_THRESHOLD = 20;
// Any run of >=2 consecutive same-position ticks where health is also
// dropping is worth flagging immediately, regardless of the stall
// threshold above.
const HP_DRAIN_FROZEN_TICKS_THRESHOLD = 2;
const TRACE_POS_EPS = 0.05;
// Lower than STALL_TICKS_THRESHOLD (20) on purpose — `detectHeldKeyNoMovement`
// is a much more precise signal, so it doesn't need as long a run to be
// confident it's a real freeze rather than incidental noise.
const HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD = 10;
// Movement keys that actually translate the player — KeyQ/KeyE only rotate.
const TRANSLATING_KEYS = new Set(["KeyW", "KeyA", "KeyD"]);

/**
 * Scans one level's worth of per-decision trace records (see `Bot#tick`'s
 * `#recordTrace` calls) for two "erratic-looking" patterns:
 * - `stall`: position hasn't moved for STALL_TICKS_THRESHOLD+ consecutive
 *   ticks (excluding legitimate spike-wait/mostly-engaged runs).
 * - `healthDrainFrozen`: position unchanged while health is also dropping,
 *   for as few as 2 consecutive ticks.
 * Both exclude a run where a majority of its ticks have `fire: true` or
 * `fireOnCooldown: true` — a bot holding ground, aimed and ready, while a
 * threat closes distance is correct behavior, not a freeze. `fireOnCooldown`
 * matters here specifically because of `profile.fireCooldownMs` (semi-auto
 * ranged weapons are now human-paced, not "fire every tick") — most ticks in
 * a real, correctly-fought firefight don't actually pull the trigger anymore,
 * so `fire: true` alone would under-count how much of the run was genuinely
 * "locked on and engaged" rather than stuck.
 *
 * Returns `{type, startTick, endTick, ticks, detail}[]`.
 */
export function detectAnomalies(trace) {
  const findings = [];
  if (!trace || trace.length === 0) return findings;
  let runStart = 0;
  // Compared against the *anchor* (the run's own starting position), not the
  // immediately preceding tick — anchoring to the run's start correctly lets
  // slow-but-genuine drift eventually exceed the threshold and close the run
  // out as real movement instead of misreporting it as one giant stall.
  let anchor = trace[0];
  for (let i = 1; i <= trace.length; i++) {
    const cur = i < trace.length ? trace[i] : null;
    const samePos = cur && Math.abs(cur.x - anchor.x) < TRACE_POS_EPS && Math.abs(cur.y - anchor.y) < TRACE_POS_EPS;
    if (!samePos) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= 2) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const runSlice = trace.slice(runStart, runEnd);
        const allWaitingOnSpike = runSlice.every((r) => r.waitingOnSpike);
        const engagedTicks = runSlice.filter((r) => r.fire || r.fireOnCooldown).length;
        const mostlyFiring = engagedTicks / runLen > 0.5;
        if (runLen >= STALL_TICKS_THRESHOLD && !allWaitingOnSpike && !mostlyFiring) {
          findings.push({
            type: "stall",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)} threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"}`,
          });
        }
        if (runLen >= HP_DRAIN_FROZEN_TICKS_THRESHOLD && last.hpFrac < first.hpFrac - 0.001 && !mostlyFiring) {
          findings.push({
            type: "healthDrainFrozen",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
          });
        }
      }
      runStart = i;
      anchor = cur;
    }
  }
  return findings;
}

/**
 * A tick-by-tick pass over the same trace `detectAnomalies` uses, but
 * checking each tick against the *immediately preceding* one and
 * correlating it directly with which keys were actually held. Flags a run
 * where a translating key was held yet real displacement since the previous
 * tick was under TRACE_POS_EPS — i.e. the engine's own collision resolution
 * rejected the translation outright, every single tick, for the whole run.
 */
export function detectHeldKeyNoMovement(trace) {
  const findings = [];
  if (!trace || trace.length < 2) return findings;
  let runStart = null;
  for (let i = 1; i <= trace.length; i++) {
    const prev = trace[i - 1];
    const cur = i < trace.length ? trace[i] : null;
    const heldTranslatingKey = prev.moveKeys?.some((k) => TRANSLATING_KEYS.has(k));
    const noRealMovement = cur && Math.abs(cur.x - prev.x) < TRACE_POS_EPS && Math.abs(cur.y - prev.y) < TRACE_POS_EPS;
    if (heldTranslatingKey && noRealMovement) {
      if (runStart === null) runStart = i - 1;
      continue;
    }
    if (runStart !== null) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const heldKeys = new Set(trace.slice(runStart, runEnd).flatMap((r) => r.moveKeys ?? []));
        findings.push({
          type: "heldKeyNoMovement",
          startTick: runStart,
          endTick: runEnd - 1,
          ticks: runLen,
          detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} heldKeys=[${[...heldKeys].join(",")}] threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
        });
      }
      runStart = null;
    }
  }
  return findings;
}

/**
 * One automated-playtest bot instance, bound to a single Playwright `page`
 * and skill `profile` for its whole lifetime — construct a fresh `Bot` per
 * campaign attempt (fresh browser context), same scope as the original
 * script's per-attempt bot behavior. Per-level state (`map`, `mineMemory`,
 * `visitedPickups`) resets via `startLevel(map)`.
 */
export class Bot {
  /**
   * @param {import("playwright").Page} page
   * @param {object} profile one of PROFILES's shape (fireAngleEps,
   *   engageRadius, coverageMode, weaponPriority, healthDetourThreshold,
   *   proactiveMineDisarm, rocketForDistantClusters, rotSpeedMultiplier)
   * @param {object} [opts]
   * @param {boolean} [opts.realtime=false] false = virtual-clock pump
   *   (window.__pumpVirtualTime), true = real page.waitForTimeout.
   * @param {number} [opts.stepMs] standard per-decision step duration;
   *   defaults to WATCH_STEP_MS (realtime) or VIRTUAL_STEP_MS (virtual).
   * @param {number} [opts.recordStepMs] sub-step granularity passed as
   *   `window.__pumpVirtualTime`'s own `stepMs` (virtual-clock mode only) —
   *   defaults to `stepMs` itself, i.e. one `ReplayFrame` per bot decision,
   *   matching every existing caller's behavior. A caller that ships the
   *   resulting replay for real playback (unlike a telemetry-only run) needs
   *   this set to a real-frame-sized value (e.g. `1000/60`) instead: replay
   *   playback (`src/main.ts`'s `step()`) consumes exactly one recorded
   *   frame per real render tick regardless of that frame's own `dt`, so
   *   fewer-but-coarser frames covering the same virtual duration play back
   *   proportionally faster than real speed — see
   *   `scripts/generate-default-highscore.mjs`'s history of this exact bug.
   * @param {object} [opts.tuning] deep-merged over DEFAULT_TUNING.
   * @param {object} [opts.logger] {debugNav, wpDebug, driftDebug}: optional
   *   `(msg: string) => void` sinks, no-ops by default. {trace, navDiag}:
   *   booleans — `trace: true` enables per-decision trace collection +
   *   `reportAnomalies`' basic findings; `navDiag: true` (implies `trace`)
   *   additionally enables the finer held-key-no-movement pass.
   * @param {boolean} [opts.ignoreThreats=false] never engage, flee from, or
   *   even acknowledge an enemy as a threat — `tick()` goes straight to plain
   *   navigation regardless of what's nearby. For a bot driving a genuinely
   *   invulnerable player (e.g. `scripts/verify-multiplayer-transition.mjs`'s
   *   god-mode host): taking damage was never the actual risk once
   *   invulnerable, but stopping to fight still was — a tanky enemy can pin
   *   the bot in a long, slow melee grind (each successful hit resets the
   *   existing `combatStallTicks` anti-stall counter, since landing a hit
   *   counts as "progress," so that counter alone never fires) that eats
   *   real wall-clock time without the bot ever getting closer to its actual
   *   destination — confirmed directly via a real CI run's own anomaly trace
   *   (a 600+-tick stall pinned at `threatDist` well inside melee range,
   *   health never dropping). The engine's own collision only checks map
   *   geometry (`collidesWithWall`), never other entities, so a bot that
   *   simply never stops to fight can walk straight past/through an enemy
   *   with no risk of getting physically blocked by it either.
   */
  constructor(page, profile, opts = {}) {
    this.page = page;
    this.profile = profile;
    this.realtime = opts.realtime ?? false;
    this.ignoreThreats = opts.ignoreThreats ?? false;
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    this.stepMs = opts.stepMs ?? (this.realtime ? this.tuning.WATCH_STEP_MS : this.tuning.VIRTUAL_STEP_MS);
    this.recordStepMs = opts.recordStepMs ?? this.stepMs;
    this.logger = {
      debugNav: opts.logger?.debugNav,
      wpDebug: opts.logger?.wpDebug,
      driftDebug: opts.logger?.driftDebug,
      trace: opts.logger?.trace ?? false,
      navDiag: opts.logger?.navDiag ?? false,
    };
    this.map = null;
    this.mineMemory = null;
    this.visitedPickups = new Set();
    // Cumulative in-game (simulated) time this Bot instance has driven,
    // and the value it last held at the moment a semi-auto ranged shot was
    // fired — see `#applyAction`'s increment and `tick()`'s fire-cooldown
    // gate, `profile.fireCooldownMs`'s doc comment. Persists across levels
    // within one run/attempt (a human trigger finger doesn't reset at a
    // level transition), reset only by constructing a fresh `Bot`.
    this.simTimeMs = 0;
    this.lastFireSimTimeMs = -Infinity;
  }

  /**
   * Resets all per-level state — call once at the start of each campaign
   * level. `mineMemory` mirrors the original script's per-level object
   * exactly (see its doc comment there for why retreat/shoot tracking are
   * kept in separate slots, and why `abandoned` is scoped per-level).
   */
  startLevel(map) {
    this.map = map;
    this.mineMemory = {
      retreatKey: null,
      retreatTicks: 0,
      shootKey: null,
      shootTicks: 0,
      abandoned: new Set(),
      trace: this.logger.trace ? [] : undefined,
    };
    this.visitedPickups = new Set();
  }

  /**
   * Shortest decision this bot may issue, in ms. Zero here: under the virtual
   * clock there is no transport between deciding and the engine seeing it, so
   * a 5ms burst lands exactly as 5ms of movement, and short bursts are the
   * whole anti-overshoot mechanism.
   *
   * `MultiplayerBot` overrides it, and the reason is load-bearing rather than
   * defensive — see its own doc comment. Every input there is delayed
   * `INPUT_DELAY_TICKS` (~100ms) before it reaches the shared simulation, and
   * a bot whose decision window is not comfortably longer than that delay
   * re-issues a fresh command before the previous one has finished arriving.
   * That was confirmed directly, twice, and is why `DEFAULT_STEP_MS` is 400
   * rather than `WATCH_STEP_MS`'s 130.
   *
   * The trap this guards is that a *speed* change silently becomes a *timing*
   * change: `#moveBurstMs` caps the hold at however long the move needs, so
   * doubling the speed halves the decision window for the same distance. That
   * turned a single-player-only sprint into a multiplayer navigation failure
   * (`verify:multiplayer-transition`, the one CI-wired bot script, went from
   * pass to "host got stuck on the final approach") with no multiplayer code
   * changed at all.
   */
  get minDecisionMs() {
    return 0;
  }

  /**
   * Defensive net for an intermittent, not-fully-root-caused report: the
   * bot occasionally spinning far more than one decision's worth of turning
   * should ever produce. Doesn't try to prevent the underlying cause
   * (unknown) — only makes any recurrence immediately visible in the log.
   */
  #checkRotationAnomaly(player, currentAngle) {
    const pending = this.mineMemory?.pendingTurnCheck;
    if (!pending) return;
    this.mineMemory.pendingTurnCheck = null;
    const actual = Math.abs(angleDelta(pending.beforeDir, currentAngle));
    const expectedMax = this.tuning.ENGINE_ROT_SPEED * pending.rotSpeedMultiplier * (pending.turnBurstMs / 1000) * this.tuning.ROTATION_ANOMALY_SLACK;
    if (actual > Math.max(expectedMax, 0.3)) {
      console.log(
        `[nav-warn] implausible rotation: turned ${actual.toFixed(2)}rad in one decision ` +
          `(requested turnBurst=${pending.turnBurstMs.toFixed(0)}ms, expected <=${expectedMax.toFixed(2)}rad) ` +
          `at (${player.x.toFixed(2)},${player.y.toFixed(2)}) — not a stuck state, self-corrects next tick, logged for diagnosis.`,
      );
    }
  }

  /** No-op unless trace collection is enabled (see `startLevel`). Appends
   * one lightweight per-decision record to `this.mineMemory.trace`. */
  #recordTrace(entry) {
    if (!this.mineMemory?.trace) return;
    this.mineMemory.trace.push(entry);
  }

  /** No-op unless trace collection is enabled. Runs `detectAnomalies` (and,
   * if `this.logger.navDiag` is also on, `detectHeldKeyNoMovement`) against
   * this level's accumulated trace and logs any findings, tagged with
   * `label` and the 1-based level number. */
  reportAnomalies(label, levelIndex) {
    if (!this.mineMemory?.trace) return;
    if (this.logger.navDiag) {
      for (const f of detectHeldKeyNoMovement(this.mineMemory.trace)) {
        console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
      }
    }
    for (const f of detectAnomalies(this.mineMemory.trace)) {
      console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
    }
  }

  /**
   * Detour to collect an uncollected static AmmoPickup — any kind, not just
   * health. Below `profile.healthDetourThreshold`, prioritizes the nearest
   * *health* pickup specifically even if farther away; otherwise grabs
   * whichever uncollected pickup is nearest, of any kind. Ranks by actual
   * walking distance (a real BFS path), not straight-line. Capped at
   * `this.tuning.MAX_LOOT_DETOUR_TILES` — a pickup beyond the cap is left
   * uncollected for a later check to pick up once the route naturally
   * passes closer.
   */
  async maybeDetourForLoot(openedDoors) {
    const player = await this.readState();
    if (player.state !== "playing") return { state: player.state };

    // Static, pre-placed pickups need our own "already visited" bookkeeping
    // — `map.ammoPickups` never shrinks. Dynamic kill-drop loot and keys
    // need a live query — neither exists in the static map data.
    const staticUncollected = this.map.ammoPickups.filter((p) => !this.visitedPickups.has(`${p.x},${p.y}`));
    const dynamicDrops = await this.page.evaluate(() => window.__codeensteinTestHooks.getDrops());
    const dynamicKeys = (await this.page.evaluate(() => window.__codeensteinTestHooks.getKeys())).map((k) => ({ ...k, kind: "key" }));
    const uncollected = [...staticUncollected, ...dynamicDrops, ...dynamicKeys];
    if (uncollected.length === 0) return { state: "playing" };

    const urgent = player.healthFraction < this.profile.healthDetourThreshold;
    const healthOnly = uncollected.filter((p) => p.kind === "health");
    const pool = urgent && healthOnly.length > 0 ? healthOnly : uncollected;

    let best = null;
    let bestPath = null;
    for (const p of pool) {
      if (Math.hypot(p.x - player.x, p.y - player.y) > this.tuning.MAX_LOOT_DETOUR_TILES) continue;
      const path = bfsPath(
        this.map,
        { x: Math.floor(player.x), y: Math.floor(player.y) },
        { x: Math.floor(p.x), y: Math.floor(p.y) },
        LOOT_DETOUR_AVOID_TILES,
        openedDoors,
      );
      if (!path || path.length - 1 > this.tuning.MAX_LOOT_DETOUR_TILES) continue;
      if (!bestPath || path.length < bestPath.length) {
        best = p;
        bestPath = path;
      }
    }
    // Leave it uncollected rather than mark it visited — a later check, once
    // the route naturally passes closer, can still pick it up.
    if (!best) return { state: "playing" };
    if (staticUncollected.includes(best)) this.visitedPickups.add(`${best.x},${best.y}`);

    const path = bestPath;
    this.logger.wpDebug?.(`[wpdebug] loot-detour from (${player.x.toFixed(1)},${player.y.toFixed(1)}) to best=(${best.x},${best.y}) kind=${best.kind} pathLen=${path.length}`);
    for (const wp of pathToWaypoints(path)) {
      this.logger.wpDebug?.(`[wpdebug]   loot wp=(${wp.x},${wp.y})`);
      const result = await this.driveToward(wp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
      this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
      if (result.state !== "playing") return result;
      // See `driveLegs`'s own doc comment on its identical check — every
      // waypoint after a mid-route teleport was planned from a position this
      // bot is no longer at.
      if (result.reason === "teleported") return result;
    }
    return { state: "playing" };
  }

  /**
   * Drive toward a single planned waypoint, but re-BFS a detour-safe path
   * to it first if the bot has drifted `this.tuning.LEG_REPLAN_DRIFT_TILES`
   * or more away from where it's expected to be — *or* the straight line to
   * it is blocked by a wall regardless of distance (a short straight-line
   * gap can still have a wall in it if the true walkable path bends around
   * a corner).
   */
  async driveTowardWithReplan(wp, openedDoors, eps = this.tuning.ARRIVE_EPS) {
    const player = await this.readState();
    const displaced =
      Math.hypot(player.x - wp.x, player.y - wp.y) > this.tuning.LEG_REPLAN_DRIFT_TILES ||
      (this.map && !hasLineOfSight(this.map, player.x, player.y, wp.x, wp.y));
    if (displaced) {
      const path = bfsPath(
        this.map,
        { x: Math.floor(player.x), y: Math.floor(player.y) },
        { x: Math.floor(wp.x), y: Math.floor(wp.y) },
        new Set(),
        openedDoors,
      );
      this.logger.driftDebug?.(
        `[driftdebug] drift from (${player.x.toFixed(2)},${player.y.toFixed(2)}) wp=(${wp.x},${wp.y}) openedDoors=${JSON.stringify([...openedDoors])} path=${path ? `${path.length} tiles` : "NULL"}`,
      );
      if (path) {
        for (const rwp of pathToWaypoints(path)) {
          this.logger.wpDebug?.(`[wpdebug] replan-walk wp=(${rwp.x},${rwp.y})`);
          const result = await this.driveToward(rwp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
          this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
          // See `driveLegs`'s own doc comment on its identical check — a
          // mid-route teleport invalidates every remaining replanned
          // waypoint too, same as it would the original plan.
          if (result.state !== "playing" || result.reason === "stuck" || result.reason === "teleported") return result;
        }
        return { state: "playing", reason: "arrived" };
      }
    }
    return this.driveToward(wp, eps, this.tuning.MAX_TICKS_PER_WAYPOINT);
  }

  /** Walks a full route-leg list (walk/openDoor legs), threading a
   * per-call `openedDoors` set so a BFS re-plan mid-run knows which doors
   * this run has already opened.
   *
   * A `reason: "teleported"` result from any waypoint stops this walk
   * immediately and propagates that result as-is, the same way `"stuck"`
   * already does — every waypoint after a teleport was planned against
   * wherever the bot *used to be*, not where it landed. `routePlanner.mjs`
   * hard-blocks real map teleporters from ever being planned as a waypoint
   * (`HARD_BLOCK_TILES`), so in practice this only ever fires from an
   * incidental touch, or — multiplayer-only — a teammate reaching the exit
   * mid-route: `checkExit()`'s own `.some()` semantics mean any single alive
   * player touching the exit carries the *whole* roster to the next level
   * once the countdown elapses ("exit touch is a shared simulation event"),
   * repositioning a still-driving bot without warning. Confirmed directly:
   * without this check, the leg-walk loop kept walking the old, now-
   * meaningless waypoint list against a live position that had moved to an
   * entirely different level, producing a real ~600-tick stall (the bot
   * grinding against `MAX_TICKS_PER_WAYPOINT` trying to reach a target its
   * own stale `this.map` can no longer even BFS a path to). */
  async driveLegs(legs) {
    const openedDoors = new Set();

    for (const leg of legs) {
      const detour = await this.maybeDetourForLoot(openedDoors);
      if (detour.state !== "playing") return detour;
      if (detour.reason === "teleported") return detour;

      if (leg.kind === "walk") {
        // Re-check for loot before every waypoint, not just once per leg —
        // a leg can be dozens of waypoints long.
        for (const wp of leg.waypoints) {
          const wpDetour = await this.maybeDetourForLoot(openedDoors);
          if (wpDetour.state !== "playing") return wpDetour;
          if (wpDetour.reason === "teleported") return wpDetour;
          this.logger.wpDebug?.(`[wpdebug] leg-walk wp=(${wp.x},${wp.y})`);
          const result = await this.driveTowardWithReplan(wp, openedDoors);
          this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
          if (result.state !== "playing") return result;
          if (result.reason === "stuck") return { state: "stuck" };
          if (result.reason === "teleported") return result;
        }
      } else if (leg.kind === "openDoor") {
        // `openDoorAhead()` (engine.ts) only detects the door tile within a
        // short reach straight ahead of the player's *exact* position — walk
        // to a staging point centered on the door tile's cross-axis first,
        // with a tight arrival tolerance, before facing/pushing.
        const stagingPoint = {
          x: leg.doorTile.x + 0.5 - leg.approachDir.dx,
          y: leg.doorTile.y + 0.5 - leg.approachDir.dy,
        };
        const staged = await this.driveTowardWithReplan(stagingPoint, openedDoors, this.tuning.TIGHT_ARRIVE_EPS);
        if (staged.state !== "playing") return staged;
        if (staged.reason === "teleported") return staged;
        const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
        const faced = await this.faceAngle(targetAngle, this.tuning.MAX_TICKS_PER_WAYPOINT);
        if (faced.state !== "playing") return faced;
        const held = await this.holdForwardFine(this.tuning.DOOR_OPEN_TICKS * this.tuning.VIRTUAL_STEP_MS, this.tuning.DOOR_OPEN_FINE_STEP_MS);
        if (held.state !== "playing") return held;
        openedDoors.add(`${leg.doorTile.x},${leg.doorTile.y}`);
      }
    }
    return { state: "playing" };
  }

  /**
   * One decision, dispatched. The decision itself lives in
   * `combatPolicy.mjs`'s `decide()` — this method is the I/O half: read the
   * rotation-anomaly check, hand the world to the policy, record the trace it
   * produces, and dispatch the intent it returns.
   *
   * `map` is an explicit parameter, not always `this.map`: `faceAngle`
   * deliberately calls `tick(..., undefined)` when a threat is present, so
   * the hazard/spike-avoidance branches (which need a real `map`) are
   * skipped during a bare "face this angle" maneuver — preserved exactly
   * from the original script's call site rather than folded into `this.map`
   * implicitly.
   */
  async tick(player, enemies, mines, navTarget, map, projectiles = []) {
    this.#checkRotationAnomaly(player, Math.atan2(player.dirY, player.dirX));
    const intent = decide(
      { player, enemies, mines, navTarget, map, projectiles },
      this.mineMemory,
      {
        profile: this.profile,
        tuning: this.tuning,
        stepMs: this.stepMs,
        ignoreThreats: this.ignoreThreats,
        simTimeMs: this.simTimeMs,
        lastFireSimTimeMs: this.lastFireSimTimeMs,
        minDecisionMs: this.minDecisionMs,
        logger: this.logger,
        // Only `MultiplayerBot` has a roster id. A bolt is locked to one
        // target for its whole life, so multiplayer must ignore shots aimed at
        // a team-mate; single-player has one player and passes null.
        selfId: this.playerId ?? null,
      },
    );
    // The semi-auto fire clock is per-`Bot`, not per-decision, so the policy
    // reports that it pulled the trigger and the bot owns the timestamp — see
    // `profile.fireCooldownMs`. It must be stamped before `applyAction`
    // advances `simTimeMs`, so the cooldown measures from the decision that
    // fired, exactly as it did when this was all one method.
    if (intent.firedSemiAuto) this.lastFireSimTimeMs = this.simTimeMs;
    this.#recordTrace(intent.trace);
    return this.applyAction(intent);
  }

  async driveToward(point, eps, maxTicks) {
    let { player, enemies, mines, projectiles } = await this.readFull();
    for (let t = 0; t < maxTicks; t++) {
      if (player.state !== "playing") {
        await this.applyAction(this.#releaseIntent());
        return { state: player.state, reason: player.state };
      }
      if (Math.hypot(point.x - player.x, point.y - player.y) < eps) {
        // Deliberately no stop-and-release here — this fires at every
        // waypoint arrival (BFS waypoints are only 1 tile apart), and
        // releasing every held key here turned ordinary corridor walking
        // into a visible stutter. The next call recomputes its own fresh
        // key set regardless.
        return { state: "playing", reason: "arrived" };
      }
      const prevX = player.x;
      const prevY = player.y;
      ({ player, enemies, mines, projectiles } = await this.tick(player, enemies, mines, point, this.map, projectiles));
      // A BFS-derived waypoint can end up targeting a teleporter pad's exact
      // tile-center; stepping onto it always warps the player away before
      // this loop's own arrival check is satisfied. Detect a jump far
      // larger than any legitimate single tick of movement and treat it the
      // same as arriving.
      if (Math.hypot(player.x - prevX, player.y - prevY) > this.tuning.TELEPORT_JUMP_DETECT_TILES) {
        await this.applyAction(this.#releaseIntent());
        return { state: "playing", reason: "teleported" };
      }
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing", reason: "stuck" };
  }

  async faceAngle(targetAngle, maxTicks) {
    let { player, enemies, mines, projectiles } = await this.readFull();
    for (let t = 0; t < maxTicks; t++) {
      if (player.state !== "playing") return { state: player.state };
      const threat = pickThreat(enemies, player, this.profile, this.map);
      if (!threat) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const delta = angleDelta(currentAngle, targetAngle);
        if (Math.abs(delta) < this.tuning.TURN_MOVE_EPS) {
          await this.applyAction(this.#releaseIntent());
          return { state: "playing" };
        }
        // `tick()` only ever turns the player toward a threat, a mine, or
        // navTarget — none of which apply here (a bare "face this angle"
        // request, used only to square up to a door) — issue the turn
        // directly instead of routing through tick().
        //
        // Pin the turn direction once whenever the needed turn is very
        // close to exactly 180° — tiny floating-point noise in the
        // recomputed angle can otherwise land the result on either side of
        // atan2's branch cut, flipping delta's sign tick to tick and never
        // converging.
        const NEAR_PI_TURN_EPS = 0.05;
        const turnPositive = Math.abs(Math.abs(delta) - Math.PI) < NEAR_PI_TURN_EPS ? true : delta > 0;
        const moveKeys = new Set([turnPositive ? "KeyE" : "KeyQ"]);
        const turnBurst = turnBurstMs(delta, this.profile.rotSpeedMultiplier, currentAngle, {
          tuning: this.tuning,
          stepMs: this.stepMs,
          memory: this.mineMemory,
        });
        ({ player, enemies, mines } = await this.applyAction(uniformIntent(moveKeys, turnBurst, this.stepMs, {})));
        continue;
      }
      // `map` explicitly omitted here — see `tick`'s doc comment.
      ({ player, enemies, mines, projectiles } = await this.tick(player, enemies, mines, null, undefined, projectiles));
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing" };
  }

  /**
   * Holds KeyW in much smaller steps than the bot's normal movement grain —
   * for the final push against a door. Wall collision rejects an entire
   * tick's movement outright if its destination would overlap the still-
   * solid door (no clamp/slide), so at the bot's normal step size the
   * player can get rejected while still short of the door's reach threshold
   * and never take a smaller partial step to close that last bit of
   * distance. Much finer steps let the player converge tile-by-tile closer
   * to the true collision boundary before a step gets rejected.
   */
  async holdForwardFine(totalMs, stepMs) {
    const steps = Math.ceil(totalMs / stepMs);
    for (let t = 0; t < steps; t++) {
      const { player } = await this.applyAction(uniformIntent(["KeyW"], stepMs, this.stepMs, {}));
      if (player.state !== "playing") return { state: player.state };
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing" };
  }

  async readFull() {
    return this.page.evaluate(() => {
      const hooks = window.__codeensteinTestHooks;
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines(), projectiles: hooks.getProjectiles?.() ?? [] };
    });
  }

  async readState() {
    return this.page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
  }
  /**
   * Dispatch one decision's intent.
   *
   * Split in two on purpose. This half is pure bookkeeping — resolve the
   * decision's duration, advance the simulated clock, and turn the intent's
   * per-key holds into the sequence of dispatch phases that realises them.
   * `dispatchSegment` below is the only part that touches the page, and it is
   * the single method `MultiplayerBot` overrides: keeping the segmentation
   * here rather than duplicating it is what stops the two bots' timing from
   * drifting apart again.
   *
   * `intent.durationMs` of `undefined` means "the caller's whole step", which
   * is distinct from any particular number — several branches hold keys without
   * setting a burst at all, and those run for the full window.
   *
   * Today `segmentsFor` always yields exactly one phase, because every branch
   * gives all of its keys the same hold. The plumbing is here so that stops
   * being true without another change to this method.
   */
  async applyAction(intent, { maxDurationMs = this.stepMs } = {}) {
    const durationMs = intent.durationMs ?? maxDurationMs;
    this.simTimeMs += durationMs;
    const phases = segmentsFor(intent.holds, durationMs, this.minPhaseMs);
    let result;
    for (let i = 0; i < phases.length; i++) {
      result = await this.dispatchSegment(phases[i].keys, phases[i].ms, {
        fire: intent.fire,
        useMelee: intent.useMelee,
        weaponSwitchIndex: intent.weaponSwitchIndex,
        isFirst: i === 0,
        isLast: i === phases.length - 1,
      });
    }
    return result;
  }

  /**
   * "Let go of everything and stand still for one full step." An empty holds
   * map releases every key through `dispatchSegment`'s diff, which is how the
   * drive loops stop cleanly at a waypoint or on level end.
   */
  #releaseIntent() {
    return uniformIntent([], undefined, this.stepMs, {});
  }

  /**
   * Shortest phase this bot will dispatch as its own step. Zero here: under the
   * virtual clock a phase boundary costs nothing and lands exactly.
   * `MultiplayerBot` raises it, for the same reason it raises
   * `minDecisionMs` — a phase shorter than the lockstep input delay never
   * arrives before the next one is issued.
   */
  get minPhaseMs() {
    return 0;
  }

  /**
   * The sole Node↔browser control boundary: dispatches real synthetic
   * KeyboardEvents on the canvas element (never the mouse — see the
   * original `generate-default-highscore.mjs` module doc comment for why),
   * with an edge-triggered weapon-switch (`Digit{n+1}`) and a melee-vs-
   * ranged fire key choice (`Space` for quick-melee, `Backquote`
   * otherwise). In realtime mode, skips the virtual-clock pump and instead
   * waits `ms` of *real* time so a human watching a visible browser
   * window can actually follow the action.
   *
   * Movement keys are a *diff* against `window.__botHeldKeys`, so a key that
   * appears in consecutive phases is never released and re-pressed — the
   * engine sees one continuous hold. That is what makes a key simply dropping
   * out of a later phase the correct way to end its hold.
   *
   * The weapon switch fires on the first phase and the fire key is held from
   * the first phase to the last, so a multi-phase decision still reads as one
   * trigger pull rather than several.
   */
  async dispatchSegment(keys, ms, { fire, useMelee, weaponSwitchIndex, isFirst, isLast }) {
    const headed = this.realtime;
    // Capped at `ms` itself: a short precision burst (e.g. `turnBurstMs`
    // rounding a near-complete turn down to a few ms to avoid overshoot)
    // must still land in exactly one sub-step of its own requested size, not
    // get rounded up to a full `recordStepMs` — `__pumpVirtualTime` always
    // advances by at least one whole sub-step, so a sub-step larger than the
    // requested burst would overshoot the very precision these bursts exist
    // to protect. Only a full-length decision (the common case) actually
    // gets subdivided into multiple `recordStepMs`-sized replay frames.
    const subStepMs = Math.min(this.recordStepMs, ms);
    const dispatched = await this.page.evaluate(
      ({ desiredKeys, fire, weaponSwitchIndex, useMelee, stepMs, subStepMs, headed, isFirst, isLast }) => {
        const canvas = document.querySelector("canvas");
        const hooks = window.__codeensteinTestHooks;
        const desired = new Set(desiredKeys);
        const held = (window.__botHeldKeys ??= new Set());
        for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        window.__botHeldKeys = desired;
        if (isFirst && weaponSwitchIndex !== null && weaponSwitchIndex !== undefined) {
          const code = `Digit${weaponSwitchIndex + 1}`;
          canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
          canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        }
        // Fire is held for the *whole* tick, not pressed-and-released before
        // any frame runs — an `auto: true` weapon checks isFireHeld() every
        // frame, so releasing before the pump even starts meant it never
        // fired at all. Fixed by moving the keyup to the end of the tick.
        const fireCode = fire ? (useMelee ? "Space" : "Backquote") : null;
        if (fireCode && isFirst) canvas.dispatchEvent(new KeyboardEvent("keydown", { code: fireCode }));
        if (headed) return { fireCode: isLast ? fireCode : null };
        window.__pumpVirtualTime(stepMs, subStepMs);
        if (fireCode && isLast) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
        return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines(), projectiles: hooks.getProjectiles?.() ?? [] };
      },
      { desiredKeys: [...keys], fire, weaponSwitchIndex, useMelee, stepMs: ms, subStepMs, headed, isFirst, isLast },
    );
    if (!headed) return dispatched;
    await this.page.waitForTimeout(ms);
    return this.page.evaluate((fireCode) => {
      const canvas = document.querySelector("canvas");
      if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
      const hooks = window.__codeensteinTestHooks;
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines(), projectiles: hooks.getProjectiles?.() ?? [] };
    }, dispatched.fireCode);
  }
}
