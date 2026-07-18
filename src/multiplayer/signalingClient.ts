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
 */
import { SignalingError, type SignalingErrorCode } from "./types";
import type {
  LobbyResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionGetResponse,
} from "./types";

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
): Promise<T> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, { ...init, signal });
  if (!response.ok) throw await parseErrorBody(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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
  );
}

/** Guest read: fetches the offer for a code. No `hostToken` — subject to the
 * normal guess-sensitive rate budget. */
export function fetchSession(code: string, signal: AbortSignal): Promise<SessionGetResponse> {
  return requestJson<SessionGetResponse>(`/session/${encodeURIComponent(code)}`, {}, signal);
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
  return requestJson<LobbyResponse>("/lobby", {}, signal);
}
