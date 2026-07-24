// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Thin `fetch()` wrappers over `scripts/multiplayer-server.mjs`'s four
 * endpoints (see `doc/dev/multiplayer-server-spec.md`). Every function takes
 * an `AbortSignal` — same cancel-in-flight discipline as `main.ts`'s
 * `beginWorkspaceLoad`/`activeGithubLoadAbort` pattern for GitHub loads — and
 * throws a typed `SignalingError` on any non-2xx response, mapping the
 * server's `{"error": "<code>"}` body rather than making callers sniff
 * status codes or strings themselves.
 *
 * Every 2xx response body is also runtime-shape-checked before being trusted
 * as `T` (`requestJson`'s optional `isValid` guard) — the server is a
 * separate deployable (`scripts/multiplayer-server.mjs`) and a malformed
 * field (e.g. `offer`/`answer` not a string) must not flow straight into raw
 * WebRTC calls like `peerConnection.setRemoteDescription()` elsewhere, which
 * would throw an untyped browser-level error instead of the typed
 * `SignalingError` the rest of the UI's error-messaging is built around. A
 * shape mismatch reuses the `"internal_error"` code — the same bucket
 * `parseErrorBody` already falls back to for a non-JSON error body — since
 * `SignalingErrorCode` is a closed union of the server's own documented error
 * codes, not a place to invent a new one for a client-side shape check.
 */
import { SignalingError, type SignalingErrorCode } from "./types";
import type {
  IceConfigResponse,
  IceServerConfig,
  LobbyEntry,
  LobbyResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionGetResponse,
} from "./types";

function isSessionCreateResponse(body: unknown): body is SessionCreateResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.code === "string" && typeof b.hostToken === "string" && typeof b.expiresAt === "number";
}

function isSessionGetResponse(body: unknown): body is SessionGetResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.code === "string" &&
    typeof b.offer === "string" &&
    (b.answer === null || typeof b.answer === "string") &&
    typeof b.campaignName === "string" &&
    (b.displayName === null || typeof b.displayName === "string") &&
    typeof b.playerCount === "number"
  );
}

function isLobbyEntry(entry: unknown): entry is LobbyEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    (e.displayName === null || typeof e.displayName === "string") &&
    typeof e.campaignName === "string" &&
    typeof e.playerCount === "number"
  );
}

function isLobbyResponse(body: unknown): body is LobbyResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.sessions) && b.sessions.every(isLobbyEntry);
}

function isIceServerConfig(entry: unknown): entry is IceServerConfig {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  const urlsOk =
    typeof e.urls === "string" || (Array.isArray(e.urls) && e.urls.every((u) => typeof u === "string"));
  const usernameOk = e.username === undefined || typeof e.username === "string";
  const credentialOk = e.credential === undefined || typeof e.credential === "string";
  return urlsOk && usernameOk && credentialOk;
}

function isIceConfigResponse(body: unknown): body is IceConfigResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.iceServers) && b.iceServers.every(isIceServerConfig) && typeof b.ttl === "number";
}

/** Resolved lazily (not at module load) so importing this module never
 * throws — only actually trying to talk to the signaling server does, which
 * only happens once a user with an eligible workspace opens the Multiplayer
 * tab and clicks Host/Join. A missing `VITE_MULTIPLAYER_SERVER_URL` at that
 * point is a real deployment misconfiguration, surfaced as a normal
 * `SignalingError`-shaped failure the existing status-paragraph UI already
 * knows how to show. */
function getServerBaseUrl(): string {
  const url = import.meta.env.VITE_MULTIPLAYER_SERVER_URL;
  if (!url) {
    throw new Error(
      "Multiplayer is not configured: VITE_MULTIPLAYER_SERVER_URL is unset for this build.",
    );
  }
  return url.replace(/\/+$/, "");
}

async function parseErrorBody(response: Response): Promise<SignalingError> {
  let code: SignalingErrorCode = "internal_error";
  let retryAfterMs: number | undefined;
  try {
    const body = (await response.json()) as { error?: SignalingErrorCode; retryAfterMs?: number };
    if (body.error) code = body.error;
    if (typeof body.retryAfterMs === "number") retryAfterMs = body.retryAfterMs;
  } catch {
    // Non-JSON error body (e.g. a proxy-generated 502) — fall back to internal_error.
  }
  return new SignalingError(code, response.status, retryAfterMs);
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  isValid?: (body: unknown) => body is T,
): Promise<T> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, { ...init, signal });
  if (!response.ok) throw await parseErrorBody(response);
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (isValid && !isValid(body)) {
    throw new SignalingError("internal_error", response.status);
  }
  return body as T;
}

/** Creates a new session (host flow), publishing the offer under a
 * freshly-generated code. */
export function createSession(
  request: Omit<SessionCreateRequest, "code" | "hostToken">,
  signal: AbortSignal,
): Promise<SessionCreateResponse> {
  return requestJson<SessionCreateResponse>(
    "/session",
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    signal,
    isSessionCreateResponse,
  );
}

/** Republishes a fresh offer under an existing code/hostToken — clears any
 * previously-stored answer server-side. Not used by step 2's flow directly
 * (there's no re-offer UI yet) but part of the documented contract. */
export function updateSession(
  code: string,
  hostToken: string,
  request: Omit<SessionCreateRequest, "code" | "hostToken">,
  signal: AbortSignal,
): Promise<SessionCreateResponse> {
  return requestJson<SessionCreateResponse>(
    "/session",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, code, hostToken }),
    },
    signal,
    isSessionCreateResponse,
  );
}

/** Guest read: fetches the offer for a code. No `hostToken` — subject to the
 * normal guess-sensitive rate budget. */
export function fetchSession(code: string, signal: AbortSignal): Promise<SessionGetResponse> {
  return requestJson<SessionGetResponse>(`/session/${encodeURIComponent(code)}`, {}, signal, isSessionGetResponse);
}

/** Host poll: fetches the same mailbox, but with `X-Host-Token` set — exempt
 * from the guess-sensitive budget (see server spec §4's host exemption). */
export function fetchSessionAsHost(
  code: string,
  hostToken: string,
  signal: AbortSignal,
): Promise<SessionGetResponse> {
  return requestJson<SessionGetResponse>(
    `/session/${encodeURIComponent(code)}`,
    { headers: { "X-Host-Token": hostToken } },
    signal,
    isSessionGetResponse,
  );
}

/** Guest write: submits the answer SDP for a pending offer. */
export function postAnswer(code: string, answer: string, signal: AbortSignal): Promise<void> {
  return requestJson<void>(
    `/session/${encodeURIComponent(code)}/answer`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) },
    signal,
  );
}

/** Lists public sessions for the lobby browser dialog. */
export function fetchLobby(signal: AbortSignal): Promise<LobbyResponse> {
  return requestJson<LobbyResponse>("/lobby", {}, signal, isLobbyResponse);
}

/** Fetches short-lived TURN credentials for a *live* session so a peer behind
 * strict NAT can relay. The host passes its `hostToken` (proving ownership); a
 * guest passes none and is authorized by the live code, exactly as the rest of
 * the join flow treats codes. `X-Host-Token` is only sent when a token is
 * given, so a guest never sends an empty one. The endpoint 404s when the
 * operator runs no relay (or the session is gone) — callers treat *any* failure
 * as "STUN only" and never let it block the connection (see `main.ts`). */
export function fetchIceServers(
  code: string,
  signal: AbortSignal,
  hostToken?: string,
): Promise<IceConfigResponse> {
  return requestJson<IceConfigResponse>(
    `/session/${encodeURIComponent(code)}/turn-credentials`,
    hostToken ? { headers: { "X-Host-Token": hostToken } } : {},
    signal,
    isIceConfigResponse,
  );
}
