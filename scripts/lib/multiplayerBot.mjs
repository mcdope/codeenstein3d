// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A multiplayer-driving `Bot` — reuses every bit of `bot.mjs`'s decision
 * logic (`tick`/`driveLegs`/`driveToward`/`driveTowardWithReplan`/
 * `faceAngle`/`holdForwardFine`) unchanged, overriding only the three
 * methods `bot.mjs`'s own doc comment already calls out as the intended
 * swap point for "a future non-Playwright control surface (e.g. a
 * multiplayer bot)": `readFull`/`readState`/`applyAction`. Those three (plus
 * `maybeDetourForLoot`, overridden separately below) are the *only* places
 * `Bot` touches `window.__codeensteinTestHooks` directly — everything else
 * operates on the plain `{x,y,...}` data those three hand it, so it works
 * identically here against `window.__codeensteinMultiplayerTestHooks`
 * instead, for an explicit roster `playerId` instead of an implicit local
 * player.
 *
 * Two real differences from single-player, both load-bearing:
 *  - No virtual clock exists in multiplayer (the sim is paced by a real Web
 *    Worker on a real timer, not `window.__pumpVirtualTime`) — this class's
 *    `applyAction` always behaves like `Bot`'s own realtime/headed branch
 *    (real `page.waitForTimeout`), regardless of `opts.realtime`.
 *  - `maybeDetourForLoot` is overridden below to read the multiplayer-
 *    specific `getDropsSnapshot`/`getKeysSnapshot` hooks instead of
 *    `window.__codeensteinTestHooks`' own `getDrops`/`getKeys` — otherwise
 *    identical to `Bot.maybeDetourForLoot`. Static `map.ammoPickups` needs
 *    no equivalent swap: it's already part of the full `GameMap`
 *    `getMap()` hands back, unlike the dynamic, runtime-only drops/keys.
 *  - Every input is delayed `INPUT_DELAY_TICKS` (3 ticks, ~100ms at 30Hz —
 *    `netcodeConstants.ts`) before it's actually applied to the shared sim,
 *    a real, deliberate part of the lockstep protocol single-player has no
 *    equivalent of. `Bot`'s default decision window (`WATCH_STEP_MS`,
 *    130ms) is barely longer than that delay — confirmed directly: a bot
 *    built on it span in place, endlessly re-issuing a fresh multi-tick turn
 *    command before the *previous* one had even finished arriving, so each
 *    decision's turn compounded on top of however much of the last one was
 *    still in flight instead of correcting from where the player actually
 *    was. `DEFAULT_STEP_MS` below is long enough that the fixed ~100ms
 *    delay is a minority of each decision window, so the read at the end of
 *    one decision reflects a settled state the next decision can actually
 *    correct from.
 *  - `TELEPORT_JUMP_DETECT_TILES` (a `driveToward` safety net, unrelated to
 *    this module — see `bot.mjs`'s own doc comment on it) is tuned against
 *    single-player's much shorter decision windows (max ~0.8 tiles/decision
 *    at realtime `WATCH_STEP_MS`); at this module's longer `DEFAULT_STEP_MS`,
 *    ordinary movement (even unsprinted) can legitimately cover well over a
 *    tile in one decision, which the single-player-tuned default threshold
 *    misreads as a real teleporter warp — confirmed directly (false
 *    positives triggered a `driveTowardWithReplan` re-BFS back toward
 *    triggering the same "jump" again, an infinite ping-pong). Widened by
 *    default below, unless a caller explicitly overrides it again.
 *  - `MELEE_CLOSE_MIN_DISTANCE` needed no override here at all in the end —
 *    a bot at melee range was found to spin in place indefinitely (turning
 *    forever, `meleeWouldHit` never once true, taking continuous
 *    undefended damage) whenever this module's own longer decision window
 *    was combined with `tick()`'s melee branch holding a turn *and* a
 *    forward-movement command together for the whole window. Root-caused
 *    to (and fixed directly in) `bot.mjs`'s own melee branch instead: that
 *    gate now scales with the real distance one decision's own forward
 *    movement can cover, not a single-player-only fixed tiling — see its
 *    own doc comment there for the fix and why it's a no-op for
 *    single-player's own shorter decision windows.
 *  - `maybeDetourForLoot` (overridden below) is cooldown-gated
 *    (`DETOUR_RECHECK_MS`), unlike `Bot.maybeDetourForLoot`'s unthrottled
 *    once-per-waypoint calls. Root-caused directly: `bot.mjs`'s own
 *    `driveLegs` calls `maybeDetourForLoot` before *every* waypoint, and
 *    each call is a bare state read — unlike `applyAction`, it dispatches no
 *    input at all while it awaits. At single-player's virtual-time pace this
 *    is free (the sim doesn't advance while un-pumped); at multiplayer's
 *    real, un-virtualized pace, a slow `page.evaluate()` round trip (proven
 *    directly: repeatable via `Emulation.setCPUThrottlingRate` — the tick-
 *    pacing Worker keeps posting real-time ticks regardless of how well the
 *    main thread keeps up, so a loaded/contended real machine, CI's shared
 *    runners included, can back that queue up until every `page.evaluate()`
 *    — mine and the bot's own — waits multiple real seconds behind it) is a
 *    multi-second window of zero player input, real enemies still landing
 *    real hits the whole time. Confirmed directly: a host stood frozen at
 *    its exact spawn tile, health draining from ~75 to 0 without a single
 *    movement key ever issued, entirely inside back-to-back
 *    `maybeDetourForLoot` reads before its first real decision ever ran.
 *    Fixed here, not in `bot.mjs`: single-player has no equivalent exposure
 *    (its virtual clock makes evaluate() latency free), so this is a real,
 *    `MultiplayerBot`-only gap, not a shared one.
 */
import { Bot } from "./bot.mjs";
import { bfsPath, pathToWaypoints } from "./pathfind.mjs";

/** See this module's own doc comment's last bullet for the full reasoning —
 * long enough that `INPUT_DELAY_TICKS`' fixed ~100ms delay is a minority of
 * the window, not the majority of it. */
const DEFAULT_STEP_MS = 400;

/** See this module's own doc comment for the full reasoning — comfortably
 * above the max realistic per-decision travel distance at `DEFAULT_STEP_MS`
 * (sprint speed × step duration), so only a real teleporter-scale warp
 * still trips it. */
const DEFAULT_TELEPORT_JUMP_DETECT_TILES = 4;

/** See this module's own doc comment's last bullet — bounds how often
 * `maybeDetourForLoot`'s real, input-free `page.evaluate()` round trip can
 * run, roughly "once per leg" rather than once per waypoint, so a real
 * multi-waypoint leg can't chain several of these back to back with zero
 * player input the whole time. Well under `DEFAULT_STEP_MS` in spirit but
 * measured in real seconds, not ticks: loot detour is a convenience, not a
 * combat-critical read, so a few real seconds of staleness is an acceptable
 * trade for never leaving the player fully passive for long. */
const DETOUR_RECHECK_MS = 3000;

/** Synthesized in place of a null `getBotPlayerState(id)` result (the
 * multiplayer session has fully ended — team-eliminated, host-disconnected,
 * etc. — see this module's own doc comment's last bullet is about a
 * *different* thing; this one is about `activeMultiplayerSession` itself
 * going away). `bot.mjs`'s own decision/drive loops all assume a `player`
 * object is always returned, even game-over — single-player's own engine
 * never fully disappears the way a multiplayer session does — so a literal
 * `null` here would throw deep inside `bot.mjs` instead of a clean "stop,
 * we're done" `state !== "playing"` exit. Every field beyond `state` is
 * inert filler: nothing reads it once `state` reports not-playing. */
const SESSION_ENDED_PLAYER_STATE = {
  x: 0,
  y: 0,
  dirX: 1,
  dirY: 0,
  health: 0,
  healthFraction: 0,
  swap: 0,
  state: "over",
  ammo: { bullets: 0, rockets: 0, smg: 0, gas: 0 },
  weaponIndex: 0,
  meleeWouldHit: false,
  wouldMineHit: false,
  ownedWeapons: [],
  levelTime: 0,
  distanceTraveled: 0,
};

export class MultiplayerBot extends Bot {
  /**
   * @param {import("playwright").Page} page
   * @param {object} profile see `Bot`'s own constructor doc comment.
   * @param {string} playerId the roster id this bot drives ("host" or
   *   "guest") — every hook call below is scoped to it explicitly, unlike
   *   single-player's implicit "the local player".
   * @param {object} [opts] see `Bot`'s own constructor doc comment.
   */
  constructor(page, profile, playerId, opts = {}) {
    super(page, profile, {
      stepMs: DEFAULT_STEP_MS,
      ...opts,
      tuning: { TELEPORT_JUMP_DETECT_TILES: DEFAULT_TELEPORT_JUMP_DETECT_TILES, ...opts.tuning },
      realtime: true,
    });
    this.playerId = playerId;
    /** Real `Date.now()` timestamp of the last `maybeDetourForLoot` round
     * trip — see `DETOUR_RECHECK_MS`. Starts at 0 so the very first call
     * (leg start) always runs for real. */
    this.lastDetourCheckAt = 0;
  }

  async readFull() {
    const r = await this.page.evaluate(
      (id) => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { player: hooks.getBotPlayerState(id), enemies: hooks.getEnemiesSnapshot(), mines: hooks.getMinesSnapshot() };
      },
      this.playerId,
    );
    return { ...r, player: r.player ?? SESSION_ENDED_PLAYER_STATE };
  }

  async readState() {
    const player = await this.page.evaluate((id) => window.__codeensteinMultiplayerTestHooks.getBotPlayerState(id), this.playerId);
    return player ?? SESSION_ENDED_PLAYER_STATE;
  }

  /** Like `Bot.maybeDetourForLoot` (dynamic drops/keys come from the
   * multiplayer hooks), plus the real-time cooldown gate and single merged
   * `page.evaluate()` round trip — see this module's own doc comment's last
   * bullet for why both are needed here and not in `bot.mjs` itself. */
  async maybeDetourForLoot(openedDoors) {
    const now = Date.now();
    if (now - this.lastDetourCheckAt < DETOUR_RECHECK_MS) return { state: "playing" };
    this.lastDetourCheckAt = now;

    const id = this.playerId;
    const { player: rawPlayer, dynamicDrops, dynamicKeys } = await this.page.evaluate((id) => {
      const hooks = window.__codeensteinMultiplayerTestHooks;
      return {
        player: hooks.getBotPlayerState(id),
        dynamicDrops: hooks.getDropsSnapshot(),
        dynamicKeys: hooks.getKeysSnapshot().map((k) => ({ ...k, kind: "key" })),
      };
    }, id);
    const player = rawPlayer ?? SESSION_ENDED_PLAYER_STATE;
    if (player.state !== "playing") return { state: player.state };

    const staticUncollected = this.map.ammoPickups.filter((p) => !this.visitedPickups.has(`${p.x},${p.y}`));
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
        new Set(),
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
    this.logger.wpDebug?.(
      `[wpdebug] loot-detour from (${player.x.toFixed(1)},${player.y.toFixed(1)}) to best=(${best.x},${best.y}) kind=${best.kind} pathLen=${path.length}`,
    );
    for (const wp of pathToWaypoints(path)) {
      this.logger.wpDebug?.(`[wpdebug]   loot wp=(${wp.x},${wp.y})`);
      const result = await this.driveToward(wp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
      this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
      if (result.state !== "playing") return result;
    }
    return { state: "playing" };
  }

  /**
   * Same real Node<->browser control boundary as `Bot.applyAction` (real
   * synthetic `KeyboardEvent`s on the canvas, an edge-triggered weapon-
   * switch, melee-vs-ranged fire key choice) but always the realtime/headed
   * shape — see this module's own doc comment for why multiplayer can never
   * use the virtual-clock branch.
   */
  async applyAction(desiredMoveKeys, fire, weaponSwitchIndex, useMelee, stepMsOverride) {
    const stepMs = stepMsOverride ?? this.stepMs;
    this.simTimeMs += stepMs;
    const id = this.playerId;
    const fireCode = await this.page.evaluate(
      ({ desiredKeys, fire, weaponSwitchIndex, useMelee }) => {
        const canvas = document.querySelector("canvas.scene-canvas");
        const desired = new Set(desiredKeys);
        const held = (window.__botHeldKeys ??= new Set());
        for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        window.__botHeldKeys = desired;
        if (weaponSwitchIndex !== null && weaponSwitchIndex !== undefined) {
          const code = `Digit${weaponSwitchIndex + 1}`;
          canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
          canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        }
        const fc = fire ? (useMelee ? "Space" : "Backquote") : null;
        if (fc) canvas.dispatchEvent(new KeyboardEvent("keydown", { code: fc }));
        return fc;
      },
      { desiredKeys: [...desiredMoveKeys], fire, weaponSwitchIndex, useMelee },
    );
    await this.page.waitForTimeout(stepMs);
    const r = await this.page.evaluate(
      ({ fireCode, id }) => {
        const canvas = document.querySelector("canvas.scene-canvas");
        if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { player: hooks.getBotPlayerState(id), enemies: hooks.getEnemiesSnapshot(), mines: hooks.getMinesSnapshot() };
      },
      { fireCode, id },
    );
    return { ...r, player: r.player ?? SESSION_ENDED_PLAYER_STATE };
  }
}
