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
import { RaycasterEngine, type EngineHandlers, type EngineStats, type PlayerId } from "../engine/engine";
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
 * `"campaign-complete"`: `onWin` fired with no next level to transition to
 * (`multiplayer-research.md` step 8's level-transition work) — today (before
 * that work lands) every `onWin` is this case by construction, since nothing
 * yet attempts a transition first. */
export type SessionEndReason = "team-eliminated" | "host-disconnected" | "campaign-complete";

export interface SessionEngineOptions {
  result: SessionSetupResult;
  role: MultiplayerRole;
  canvas: HTMLCanvasElement;
  /** Fired exactly once, whichever of `onGameOver`/`onWin` the shared
   * simulation reaches first — deterministically the same tick on every
   * peer, since the simulation itself is lockstep. This module has already
   * torn down the local input sampler by the time this fires. */
  onSessionEnded?: (stats: EngineStats, reason: SessionEndReason) => void;
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
    options.onSessionEnded?.(stats, reason);
  };
  const handlers: EngineHandlers = {
    onGameOver: (stats) => endSession(stats, "team-eliminated"),
    // Every current call site reaches this with no next level to transition
    // to (level transitions are `multiplayer-research.md` step 8's own
    // still-unbuilt work) — see `SessionEndReason`'s doc comment.
    onWin: (stats) => endSession(stats, "campaign-complete"),
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
    undefined,
    DEFAULT_GORE_LEVEL,
    result.difficulty,
    result.gameplaySeed,
    myInput,
    undefined,
    myRosterId,
    spawnFor(result, myRosterId),
  );
  engine.addPlayer(otherRosterId, otherInput, undefined, spawnFor(result, otherRosterId));
  engine.startExternallyDriven();
  localSampler.attach();

  return { engine, myInput, otherInput, localSampler };
}
