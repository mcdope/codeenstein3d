// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shared types for the multiplayer client connect flow: the wire contract
 * with `scripts/multiplayer-server.mjs` (see `doc/dev/multiplayer-server-spec.md`),
 * and local connection state used by `signalingClient.ts`/`webrtcConnection.ts`/
 * `main.ts`. Only the fields step 2 (the connect flow) actually touches —
 * the session-setup payload (`multiplayer-netcode-spec.md`'s "Session setup"
 * section) is later work.
 */

/** Every error code `scripts/multiplayer-server.mjs` can return in a
 * `{"error": "<code>"}` body, across all four endpoints — enumerated
 * directly from its `sendError()` call sites, not just the spec's
 * illustrative examples. */
export type SignalingErrorCode =
  | "rate_limited"
  | "payload_too_large"
  | "invalid_json"
  | "missing_offer"
  | "offer_too_large"
  | "missing_campaign_name"
  | "campaign_name_too_long"
  | "invalid_player_count"
  | "invalid_display_name"
  | "display_name_too_long"
  | "invalid_public"
  | "invalid_code"
  | "session_not_found"
  | "host_token_mismatch"
  | "max_sessions_reached"
  | "missing_answer"
  | "answer_too_large"
  | "already_answered"
  | "not_found"
  | "invalid_url"
  | "internal_error";

/** Thrown by every `signalingClient.ts` function on a non-2xx response.
 * `retryAfterMs` is only ever set for `"rate_limited"`. */
export class SignalingError extends Error {
  constructor(
    public readonly code: SignalingErrorCode,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`signaling server error: ${code} (HTTP ${status})`);
    this.name = "SignalingError";
  }
}

export interface SessionCreateRequest {
  code?: string;
  hostToken?: string;
  offer: string;
  public?: boolean;
  displayName?: string;
  playerCount: number;
  campaignName: string;
}

export interface SessionCreateResponse {
  code: string;
  hostToken: string;
  expiresAt: number;
}

export interface SessionGetResponse {
  code: string;
  offer: string;
  answer: string | null;
  campaignName: string;
  displayName: string | null;
  playerCount: number;
}

export interface LobbyEntry {
  code: string;
  displayName: string | null;
  campaignName: string;
  playerCount: number;
}

export interface LobbyResponse {
  sessions: LobbyEntry[];
}

/** Local connection lifecycle, driven by `main.ts`'s Host/Join handlers and
 * surfaced (read-only) via `window.__codeensteinTestHooks` under
 * `?testHooks=1` — see `webrtcConnection.ts`'s doc comment. */
export type ConnectionState =
  | "idle"
  | "creating-session"
  | "awaiting-answer"
  | "fetching-session"
  | "connecting"
  | "connected"
  | "error";

export type MultiplayerRole = "host" | "guest";

/** The two data channels this step opens, per `multiplayer-netcode-spec.md`'s
 * "Roles and terminology" section — both left at WebRTC's default
 * reliable/ordered config. Not used for anything but proving they're open
 * until step 6 (netcode core). */
export interface MultiplayerChannels {
  input: RTCDataChannel;
  reconciliation: RTCDataChannel;
}

export interface MultiplayerConnection {
  role: MultiplayerRole;
  code: string;
  peerConnection: RTCPeerConnection;
  channels: MultiplayerChannels;
}
