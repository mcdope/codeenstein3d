// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * What each gate colour is *called*. The pixels are not here.
 *
 * The map layer carries only a `colorIndex` (`Gate.colorIndex`), exactly as it
 * carries a `StyleSetId` without knowing what a wall looks like. Each renderer
 * then keeps its own table of tones by value — the convention stated in
 * `raycaster.ts` and `automap.ts` ("by value, not by shared import"), because a
 * minimap marker, a wall wash and a HUD pip want the same *hue* at different
 * saturations, not the same literal.
 *
 * The names, unlike the tones, genuinely are one thing: the locked-door toast,
 * the console line and the key pickup all have to say the same word, or the
 * legibility this whole mechanic exists for is gone.
 *
 * **No yellow, deliberately.** Doom's third key is yellow; ours is violet,
 * because amber already means "switchboard branch door — keyless, just push
 * it" (`BRANCH_DOOR_OVERLAY`), and `textures.ts` records keeping those two door
 * kinds tellable apart as a standing constraint.
 */
import type { GameMap } from "../map/types";

/** Indexed by `Gate.colorIndex`. Length must match `GATE_COLOR_COUNT`. */
export const GATE_COLOR_NAMES = ["red", "blue", "green", "violet"] as const;

/**
 * The colour name for `gateId` on `map` — "red", "blue", … — for player-facing
 * text. Falls back to a neutral word for a gate id that is not on this map,
 * which nothing in the engine produces but which keeps a log line from reading
 * `undefined`.
 */
export function gateColorName(map: GameMap, gateId: number): string {
  const gate = map.gates[gateId];
  return gate ? GATE_COLOR_NAMES[gate.colorIndex] : "dependency";
}
