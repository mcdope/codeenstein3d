// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Fast in-process HTTP tests for the signaling server — unlike
 * `scripts/verify-multiplayer-server.mjs` (which spawns a real child process
 * and drives it end-to-end), these start `createConfiguredServer()` directly
 * in this test process on an OS-assigned ephemeral port (`.listen(0, ...)`)
 * and hit it with real `fetch()` calls — genuinely fast, no child process or
 * browser needed. Not part of the `src/` 100%-coverage gate (`scripts/**` is
 * excluded there), but still runs under `vitest run`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredServer } from "./multiplayer-server.mjs";

let server;
let baseUrl;

beforeEach(async () => {
  server = createConfiguredServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function validSessionBody(overrides = {}) {
  return {
    offer: "fake-sdp-offer",
    campaignName: "demo-campaign",
    playerCount: 1,
    ...overrides,
  };
}

describe("PUT /session — display/campaign name filtering (re-review finding: bidi isolates)", () => {
  it("accepts an ordinary display name", async () => {
    const res = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody({ displayName: "Player One" })),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ["U+061C (Arabic Letter Mark)", "؜"],
    ["U+2066 (LRI)", "⁦"],
    ["U+2067 (RLI)", "⁧"],
    ["U+2068 (FSI)", "⁨"],
    ["U+2069 (PDI)", "⁩"],
  ])("rejects a display name containing %s", async (_label, char) => {
    const res = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody({ displayName: `Player${char}One` })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("display_name_invalid_chars");
  });

  it.each([
    ["U+061C (Arabic Letter Mark)", "؜"],
    ["U+2066 (LRI)", "⁦"],
    ["U+2069 (PDI)", "⁩"],
  ])("rejects a campaign name containing %s", async (_label, char) => {
    const res = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody({ campaignName: `demo${char}campaign` })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("campaign_name_invalid_chars");
  });

  it("still rejects the previously-covered bidi override characters (regression check)", async () => {
    const res = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody({ displayName: "Player‮name" })),
    });
    expect(res.status).toBe(400);
  });
});
