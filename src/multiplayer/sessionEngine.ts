// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shared engine-construction helper for both host and guest session drivers
 * (`multiplayerSessionHost.ts`/`multiplayerSessionGuest.ts`) — builds a
 * `RaycasterEngine` keyed by this peer's real roster id (never the default
 * `"local"`, per the `localPlayerId` fix — see `engine.ts`'s own doc
 * comment), assigns spread-out spawns from `GameMap.multiplayerSpawns` per
 * `multiplayer-game-state-spec.md` §2's rule, and owns `EngineHandlers`
 * construction (including session teardown on game-over/win) so neither
 * driver file has to duplicate it.
 */
import { DEFAULT_GORE_LEVEL } from "../engine/effects";
import {
  RaycasterEngine,
  type EngineCarryover,
  type EngineHandlers,
  type EngineStats,
  type PlayerId,
  type RosterSnapshotEntry,
} from "../engine/engine";
import { InputController } from "../engine/input";
import type { Point } from "../map/types";
import { LocalInputSampler } from "./localInputSampler";
import { NetworkInputSource } from "./networkInputSource";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, type SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerRole } from "./types";

/** Why a multiplayer session ended, threaded through to `main.ts` so it can
 * render distinct copy per path instead of one generic "session ended"
 * message — see `doc/dev/multiplayer-netcode-spec.md` §5/§7.
 * `"team-eliminated"`: every connected player is dead (`onGameOver`).
 * `"host-disconnected"`: the guest's own connection toward the host expired
 * its grace period — a *provisional* end, sourced from the guest's own local
 * (not host-authoritative) state, since there's no final snapshot coming.
 * `"campaign-complete"`: a win with no next level to transition to (the
 * workspace is out of parsable files) — see `SessionEngineOptions.onWin`'s
 * own doc comment for how a win reaches this instead of the more common
 * level-transition path. */
export type SessionEndReason = "team-eliminated" | "host-disconnected" | "campaign-complete";

export interface SessionEngineOptions {
  result: SessionSetupResult;
  role: MultiplayerRole;
  canvas: HTMLCanvasElement;
  /** Health/ammo/weapons/score to seed each player with, keyed by roster id
   * — `undefined` (the default) for a genuinely fresh session start, a real
   * per-player record for a level transition (`multiplayer-research.md`
   * step 8's own `startLevel()` re-invocation of this function). A roster id
   * with no entry falls back to a fresh start for that one player, same as
   * omitting the whole map. */
  carryovers?: Record<PlayerId, EngineCarryover>;
  /** Fired once the shared simulation reaches game-over — deterministically
   * the same tick on every peer, since the simulation itself is lockstep.
   * This module has already torn down the local input sampler by the time
   * this fires. Also fired for a win with nowhere to transition to (see
   * `onWin`'s own doc comment) — this is the *only* case a win still reaches
   * this callback. `comparison` is `engine.rosterSnapshot()` taken at the
   * same moment, for `main.ts`'s end-of-run comparison table (multiplayer
   * step 9) — every peer's `players` map already holds every connected
   * player's own state under lockstep, so this needs no new wire message. */
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason, comparison: ReadonlyMap<PlayerId, RosterSnapshotEntry>) => void;
  /** Fired the instant this peer's own simulation reaches a win — NOT an
   * end-of-session event by itself (unlike `onGameOver`, which always is): a
   * multiplayer win almost always means "generate and transition to the next
   * level," a decision only the session driver (not this generic
   * engine-construction helper) can make, since it needs `main.ts`-level
   * workspace access this module deliberately has no dependency on. The
   * local input sampler is deliberately **not** detached here — the sim
   * keeps running through the exit countdown either way (see
   * `RaycasterEngine.checkExit()`), and a transition swaps in a fresh
   * sampler of its own rather than needing this one to survive.
   * When omitted, falls back to the simplest possible behavior — ending the
   * session via `onSessionEnded(stats, "campaign-complete")`, treating every
   * win as if nothing could ever come after it. Both real session drivers
   * always provide a real one; this fallback exists for any caller (a unit
   * test, most likely) that doesn't care about transitions at all. */
  onWin?: (stats: EngineStats) => void;
}

export interface SessionEngineHandle {
  engine: RaycasterEngine;
  myInput: NetworkInputSource;
  otherInput: NetworkInputSource;
  localSampler: LocalInputSampler;
}

/** Per `multiplayer-game-state-spec.md` §2: players (sorted-roster order)
 * are assigned `multiplayerSpawns[i % multiplayerSpawns.length]`. Falls back
 * to `undefined` (⇒ the engine's own `map.spawn` default) when the map has
 * no spawns computed at all (single-player-shaped map) or none survived
 * generation — never divides by zero. */
function spawnFor(result: SessionSetupResult, id: PlayerId): Point | undefined {
  const spawns = result.map.multiplayerSpawns;
  if (!spawns || spawns.length === 0) return undefined;
  const index = result.roster.indexOf(id);
  return spawns[index % spawns.length];
}

export function buildSessionEngine(options: SessionEngineOptions): SessionEngineHandle {
  const { result, role, canvas } = options;
  const myRosterId = role === "host" ? HOST_PLAYER_ID : GUEST_PLAYER_ID;
  const otherRosterId = role === "host" ? GUEST_PLAYER_ID : HOST_PLAYER_ID;

  const myInput = new NetworkInputSource();
  const otherInput = new NetworkInputSource();
  const localSampler = new LocalInputSampler(new InputController(canvas));

  let ended = false;
  const endSession = (stats: EngineStats, reason: SessionEndReason): void => {
    if (ended) return;
    ended = true;
    localSampler.detach();
    options.onSessionEnded?.(stats, reason, engine.rosterSnapshot());
  };
  const handlers: EngineHandlers = {
    onGameOver: (stats) => endSession(stats, "team-eliminated"),
    // See `SessionEngineOptions.onWin`'s own doc comment for why a win
    // doesn't end the session directly here anymore.
    onWin: (stats) => (options.onWin ? options.onWin(stats) : endSession(stats, "campaign-complete")),
    // Cheats are already neutralized below the engine (NetworkInputSource's
    // consumeCheat() is a permanent no-op — this instance's own `local.input`
    // is always one, so `simulate()`'s `local.input.consumeCheat()` can never
    // return non-null here) — genuinely unreachable, not just unused.
    /* v8 ignore next */
    onCheatActivated: () => {},
    // Pause/blur are suppressed upstream, before they ever reach the shared
    // simulation — see `LocalInputSampler.sampleAndReset()`'s own doc
    // comment. This handler exists purely to satisfy `EngineHandlers`; it
    // cannot fire for a real multiplayer peer.
    /* v8 ignore next */
    onFreezeChange: () => {},
  };

  const engine = new RaycasterEngine(
    canvas,
    result.map,
    handlers,
    options.carryovers?.[myRosterId],
    DEFAULT_GORE_LEVEL,
    result.difficulty,
    result.gameplaySeed,
    myInput,
    undefined,
    myRosterId,
    spawnFor(result, myRosterId),
    result.roster.length,
  );
  engine.addPlayer(otherRosterId, otherInput, options.carryovers?.[otherRosterId], spawnFor(result, otherRosterId));
  engine.startExternallyDriven();
  localSampler.attach();

  return { engine, myInput, otherInput, localSampler };
}
