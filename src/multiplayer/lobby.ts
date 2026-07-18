// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Data-fetch seam for the lobby browser dialog, kept separate from
 * `signalingClient.ts` so `main.ts`'s dialog-rendering code (and its tests)
 * have one narrow function to call/mock instead of reaching into the
 * generic signaling client directly.
 */
import { fetchLobby } from "./signalingClient";
import type { LobbyEntry } from "./types";

export function fetchLobbyEntries(signal: AbortSignal): Promise<LobbyEntry[]> {
  return fetchLobby(signal).then((response) => response.sessions);
}
