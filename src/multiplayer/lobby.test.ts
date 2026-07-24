// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLobbyEntries } from "./lobby";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_MULTIPLAYER_SERVER_URL", "https://mp.example.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchLobbyEntries", () => {
  it("unwraps the sessions array from the lobby response", async () => {
    const sessions = [{ code: "R4KJ9X", displayName: "Run", campaignName: "demo-campaign", playerCount: 2 }];
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessions }) } as unknown as Response);
    await expect(fetchLobbyEntries(new AbortController().signal)).resolves.toEqual(sessions);
  });
});
