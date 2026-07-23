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
import { createConfiguredServer, isTrustedProxy, parseTrustedProxies } from "./multiplayer-server.mjs";

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

describe("POST /session/<code>/answer — per-code rate limit and answer-race (re-review finding: public-lobby join-griefing)", () => {
  async function createSession() {
    const res = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody()),
    });
    return res.json();
  }

  it("trips a per-code answer-attempt limit even when every request comes from a distinct (spoofed) IP", async () => {
    const { code } = await createSession();

    // Each request claims a different X-Forwarded-For — trusted here since
    // the real TCP peer is loopback (127.0.0.1) — so no single apparent IP
    // ever approaches its own per-IP guessLimits budget; only the per-code
    // budget can explain a 429 here.
    const responses = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/session/${code}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.0.${i + 1}` },
        body: JSON.stringify({ answer: `garbage-answer-${i}` }),
      });
      responses.push(res);
    }

    const statuses = responses.map((r) => r.status);
    expect(statuses).toContain(429);
    const rateLimitedResponse = responses[statuses.indexOf(429)];
    const body = await rateLimitedResponse.json();
    expect(body.error).toBe("rate_limited");
  });

  it("allows exactly one of two concurrently-racing answers to land on the same code, the other gets already_answered (not both accepted)", async () => {
    const { code } = await createSession();

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/session/${code}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "answer-from-A" }),
      }),
      fetch(`${baseUrl}/session/${code}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "answer-from-B" }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([204, 409]);

    // The session's own GET confirms exactly one answer actually landed.
    const sessionRes = await fetch(`${baseUrl}/session/${code}`);
    const session = await sessionRes.json();
    expect(["answer-from-A", "answer-from-B"]).toContain(session.answer);
  });

  it("releases the claim on a malformed answer body, so a real answer can still land afterward", async () => {
    const { code } = await createSession();

    const badRes = await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "" }), // empty string fails validation
    });
    expect(badRes.status).toBe(400);

    const goodRes = await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "real-answer" }),
    });
    expect(goodRes.status).toBe(204);
  });

  it("still returns already_answered for a genuinely sequential second answer (unchanged behavior)", async () => {
    const { code } = await createSession();

    const first = await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "first-answer" }),
    });
    expect(first.status).toBe(204);

    const second = await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "second-answer" }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("already_answered");
  });

  it("resets the claim on a fresh re-offer (updateSession), so the new handshake round can still be answered", async () => {
    const { code, hostToken } = await createSession();

    await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "stale-answer" }),
    });

    const reoffer = await fetch(`${baseUrl}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSessionBody({ code, hostToken })),
    });
    expect(reoffer.status).toBe(200);

    const fresh = await fetch(`${baseUrl}/session/${code}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "fresh-answer" }),
    });
    expect(fresh.status).toBe(204);
  });
});

describe("CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS parsing/matching", () => {
  // The env var itself is read once at module load, so these drive the pure
  // helpers directly. What they guard: a parser that is too permissive would
  // silently widen who may forge X-Forwarded-For (see getClientIp).
  it("treats an empty/whitespace-only spec as 'nothing extra is trusted'", () => {
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies("  ,  , ")).toEqual([]);
    expect(isTrustedProxy("172.28.5.1", parseTrustedProxies(""))).toBe(false);
  });

  it("matches an exact IPv4 entry, and nothing else", () => {
    const entries = parseTrustedProxies("172.28.5.1");
    expect(isTrustedProxy("172.28.5.1", entries)).toBe(true);
    expect(isTrustedProxy("172.28.5.2", entries)).toBe(false);
    expect(isTrustedProxy("172.28.5.10", entries)).toBe(false);
  });

  it("matches the IPv4-mapped-IPv6 form Node reports on a dual-stack listener", () => {
    const entries = parseTrustedProxies("172.28.5.1");
    expect(isTrustedProxy("::ffff:172.28.5.1", entries)).toBe(true);
    expect(isTrustedProxy("::ffff:172.28.5.2", entries)).toBe(false);
  });

  it("matches IPv6 entries case-insensitively", () => {
    const entries = parseTrustedProxies("FD00::1");
    expect(isTrustedProxy("fd00::1", entries)).toBe(true);
    expect(isTrustedProxy("fd00::2", entries)).toBe(false);
  });

  it("matches an IPv4 CIDR range on its boundaries", () => {
    const entries = parseTrustedProxies("172.28.5.0/24");
    expect(isTrustedProxy("172.28.5.0", entries)).toBe(true);
    expect(isTrustedProxy("172.28.5.255", entries)).toBe(true);
    expect(isTrustedProxy("172.28.4.255", entries)).toBe(false);
    expect(isTrustedProxy("172.28.6.0", entries)).toBe(false);
  });

  it("handles the degenerate /32 and /0 prefixes", () => {
    expect(isTrustedProxy("10.0.0.1", parseTrustedProxies("10.0.0.1/32"))).toBe(true);
    expect(isTrustedProxy("10.0.0.2", parseTrustedProxies("10.0.0.1/32"))).toBe(false);
    // /0 trusts every IPv4 peer — a foot-gun, but an explicitly requested one.
    expect(isTrustedProxy("198.51.100.7", parseTrustedProxies("0.0.0.0/0"))).toBe(true);
  });

  it("normalizes a CIDR whose host bits are set, rather than mismatching everything", () => {
    const entries = parseTrustedProxies("172.28.5.99/24");
    expect(isTrustedProxy("172.28.5.1", entries)).toBe(true);
  });

  it("drops malformed entries instead of throwing, keeping valid ones alongside", () => {
    const entries = parseTrustedProxies("not-an-ip/99, 999.1.1.1/24, 10.0.0.0/33, 172.28.5.1");
    expect(isTrustedProxy("172.28.5.1", entries)).toBe(true);
    expect(isTrustedProxy("10.0.0.5", entries)).toBe(false);
  });

  it("rejects non-canonical octets so a typo cannot widen a range", () => {
    // "010" as octal-looking input and out-of-range octets must not parse.
    expect(isTrustedProxy("10.0.0.8", parseTrustedProxies("10.0.0.010"))).toBe(false);
    expect(isTrustedProxy("10.0.0.1", parseTrustedProxies("10.0.0.256/24"))).toBe(false);
  });

  it("does not treat a trusted-proxy entry as matching an arbitrary hostname string", () => {
    const entries = parseTrustedProxies("172.28.5.0/24");
    expect(isTrustedProxy("unknown", entries)).toBe(false);
    expect(isTrustedProxy("proxy.internal", entries)).toBe(false);
  });
});
