// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One resolver for "what do we call this player", shared by everything that
 * has to name one: the engine (`PlayerState.displayName`, which feeds both
 * the teammate billboards and `rosterSnapshot()`), the host's roster merge,
 * and `main.ts`'s end-of-run comparison table — which had the fallback
 * spelled out inline before this existed, and would otherwise have grown two
 * more copies of it.
 *
 * The fallback is the capitalized roster id (`"host"` → `"Host"`,
 * `"guest-1"` → `"Guest-1"`), which is exactly what that comparison table
 * already showed for every player, so a session where nobody types a name
 * looks precisely as it did before.
 *
 * **A chosen name is untrusted input**: it arrives over the data channel from
 * another peer, and nothing upstream constrains it (an `input maxlength` is a
 * UI courtesy, not a wire guarantee). It is therefore sanitized here, at the
 * point it enters the game, rather than at each of the places that draw it.
 * Rendering is via `fillText` and `textContent`, so this is about legibility
 * — a control character or a 4,000-character name is a broken HUD, not an
 * injection — but the boundary is the right place for both.
 */
import type { PlayerId } from "./engine";

/** Longest chosen name kept, in code units. Sized for the two places a name
 * is drawn: above a teammate's billboard (which is roughly `barWidth` wide,
 * capped at 80px ≈ 13 monospace characters at 10px, so anything past this is
 * unreadable long before it is truncated) and the end-of-run comparison
 * table's label column. Truncation is silent — a name is cosmetic, and
 * rejecting one outright would mean a peer that can't join. */
export const MAX_PLAYER_NAME_LENGTH = 24;

/** Control characters, including the bidi overrides that let a name reorder
 * the text drawn around it. Stripped rather than escaped: there is no
 * legitimate reason for one in a display name. */
const DISALLOWED_NAME_CHARS = /\p{C}/gu;

/**
 * The name to show for `id`: `chosen` when it survives sanitizing, otherwise
 * the capitalized roster id. Pass the raw value straight from the input field
 * or the wire — cleaning it is this function's job, and callers deliberately
 * have no sanitized-vs-raw distinction to get wrong.
 */
export function resolvePlayerDisplayName(id: PlayerId, chosen?: string): string {
  const cleaned = sanitizePlayerName(chosen);
  if (cleaned) return cleaned;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The cleaning half of `resolvePlayerDisplayName`, exported for the one
 * caller that needs to know whether a name survived at all rather than what
 * to fall back to: the guest's own outgoing `player-name` message, which
 * sends `""` for "I didn't pick one" so the host applies the *host's* idea of
 * the fallback rather than two peers each inventing their own. */
export function sanitizePlayerName(chosen?: string): string {
  if (!chosen) return "";
  return chosen.replace(DISALLOWED_NAME_CHARS, "").trim().slice(0, MAX_PLAYER_NAME_LENGTH).trim();
}
