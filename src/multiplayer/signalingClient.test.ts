// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  fetchLobby,
  fetchSession,
  fetchSessionAsHost,
  postAnswer,
  updateSession,
} from "./signalingClient";
import { SignalingError } from "./types";

const SERVER_URL = "https://mp.example.test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_MULTIPLAYER_SERVER_URL", SERVER_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createSession", () => {
  it("PUTs to /session and returns the parsed response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "R4KJ9X", hostToken: "tok", expiresAt: 123 }),
    );
    const result = await createSession(
      { offer: "sdp", playerCount: 1, campaignName: "demo-campaign" },
      new AbortController().signal,
    );
    expect(result).toEqual({ code: "R4KJ9X", hostToken: "tok", expiresAt: 123 });
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER_URL}/session`,
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("throws a typed SignalingError on a documented error code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "missing_offer" }, false, 400));
    const promise = createSession(
      { offer: "", playerCount: 1, campaignName: "demo" },
      new AbortController().signal,
    );
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "missing_offer", status: 400 });
  });

  it("surfaces retryAfterMs on a rate_limited error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "rate_limited", retryAfterMs: 4200 }, false, 429),
    );
    await expect(
      createSession({ offer: "sdp", playerCount: 1, campaignName: "demo" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 4200 });
  });

  it("falls back to internal_error for a non-JSON error body", async () => {
    const response = {
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not JSON");
      },
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      createSession({ offer: "sdp", playerCount: 1, campaignName: "demo" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "internal_error", status: 502 });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (wrong field type)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "R4KJ9X", hostToken: 12345, expiresAt: 123 }));
    const promise = createSession(
      { offer: "sdp", playerCount: 1, campaignName: "demo" },
      new AbortController().signal,
    );
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (missing field)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "R4KJ9X", expiresAt: 123 }));
    const promise = createSession(
      { offer: "sdp", playerCount: 1, campaignName: "demo" },
      new AbortController().signal,
    );
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });
});

describe("updateSession", () => {
  it("PUTs with code + hostToken merged into the body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "R4KJ9X", hostToken: "tok", expiresAt: 456 }));
    await updateSession(
      "R4KJ9X",
      "tok",
      { offer: "sdp2", playerCount: 2, campaignName: "demo-campaign" },
      new AbortController().signal,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ code: "R4KJ9X", hostToken: "tok", offer: "sdp2", playerCount: 2 });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "R4KJ9X", hostToken: "tok", expiresAt: "not-a-number" }));
    const promise = updateSession(
      "R4KJ9X",
      "tok",
      { offer: "sdp2", playerCount: 2, campaignName: "demo-campaign" },
      new AbortController().signal,
    );
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });
});

describe("fetchSession", () => {
  it("GETs /session/<code> without a host token header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: "R4KJ9X",
        offer: "sdp",
        answer: null,
        campaignName: "demo-campaign",
        displayName: null,
        playerCount: 1,
      }),
    );
    const result = await fetchSession("R4KJ9X", new AbortController().signal);
    expect(result.answer).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVER_URL}/session/R4KJ9X`);
    expect((init.headers ?? {})["X-Host-Token"]).toBeUndefined();
  });

  it("throws session_not_found on a 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "session_not_found" }, false, 404));
    await expect(fetchSession("NOPE99", new AbortController().signal)).rejects.toMatchObject({
      code: "session_not_found",
      status: 404,
    });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (offer not a string)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: "R4KJ9X",
        offer: 42,
        answer: null,
        campaignName: "demo-campaign",
        displayName: null,
        playerCount: 1,
      }),
    );
    const promise = fetchSession("R4KJ9X", new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (missing offer)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: "R4KJ9X",
        answer: null,
        campaignName: "demo-campaign",
        displayName: null,
        playerCount: 1,
      }),
    );
    const promise = fetchSession("R4KJ9X", new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });
});

describe("fetchSessionAsHost", () => {
  it("sends X-Host-Token, exempting it from the guess-sensitive budget", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: "R4KJ9X",
        offer: "sdp",
        answer: "answer-sdp",
        campaignName: "demo-campaign",
        displayName: null,
        playerCount: 1,
      }),
    );
    const result = await fetchSessionAsHost("R4KJ9X", "the-host-token", new AbortController().signal);
    expect(result.answer).toBe("answer-sdp");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ "X-Host-Token": "the-host-token" });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (answer not a string)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: "R4KJ9X",
        offer: "sdp",
        answer: 12345,
        campaignName: "demo-campaign",
        displayName: null,
        playerCount: 1,
      }),
    );
    const promise = fetchSessionAsHost("R4KJ9X", "the-host-token", new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });
});

describe("postAnswer", () => {
  it("POSTs the answer and resolves with no body on 204", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 } as unknown as Response);
    await expect(postAnswer("R4KJ9X", "answer-sdp", new AbortController().signal)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVER_URL}/session/R4KJ9X/answer`);
    expect(JSON.parse(init.body)).toEqual({ answer: "answer-sdp" });
  });

  it("throws already_answered on a 409", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "already_answered" }, false, 409));
    await expect(postAnswer("R4KJ9X", "answer-sdp", new AbortController().signal)).rejects.toMatchObject({
      code: "already_answered",
      status: 409,
    });
  });
});

describe("fetchLobby", () => {
  it("GETs /lobby and returns the sessions array", async () => {
    const sessions = [{ code: "R4KJ9X", displayName: "Run", campaignName: "demo-campaign", playerCount: 2 }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions }));
    const result = await fetchLobby(new AbortController().signal);
    expect(result).toEqual({ sessions });
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER_URL}/lobby`, expect.anything());
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (sessions not an array)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: "not-an-array" }));
    const promise = fetchLobby(new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });

  it("throws a typed SignalingError instead of returning a malformed 2xx body (a session entry missing a field)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ code: "R4KJ9X", displayName: null }] }));
    const promise = fetchLobby(new AbortController().signal);
    await expect(promise).rejects.toBeInstanceOf(SignalingError);
    await expect(promise).rejects.toMatchObject({ code: "internal_error", status: 200 });
  });
});

describe("getServerBaseUrl (via any request)", () => {
  it("throws a clear error when VITE_MULTIPLAYER_SERVER_URL is unset", async () => {
    vi.unstubAllEnvs();
    await expect(fetchLobby(new AbortController().signal)).rejects.toThrow(
      "VITE_MULTIPLAYER_SERVER_URL is unset",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from a configured base URL", async () => {
    vi.stubEnv("VITE_MULTIPLAYER_SERVER_URL", `${SERVER_URL}/`);
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    await fetchLobby(new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER_URL}/lobby`, expect.anything());
  });
});
