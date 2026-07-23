#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * WebRTC signaling + lobby server — the one piece of backend infrastructure
 * `multiplayer-research.md` concluded was unavoidable (a short, human-typable
 * Host/Join code can't be self-contained SDP; something has to hold the real
 * offer/answer blobs for the handshake). Implements
 * `doc/dev/multiplayer-server-spec.md` exactly, plus the `--install`/
 * `--uninstall` systemd flags from `multiplayer-research.md`'s "Self-hosting"
 * section (deliberately scoped *out* of the server spec, but into this script).
 *
 * Dependency-free by design: only `node:http`/`node:crypto`/`node:url`/
 * `node:fs`/`node:child_process` (the last two only for --install/--uninstall)
 * — no `npm install`, no `node_modules` at runtime. The shebang above is a
 * deliberate exception to this repo's usual no-shebang script convention:
 * `--install`'s generated systemd unit points `ExecStart=` straight at this
 * file's own absolute path, which only works if it's directly executable
 * (`chmod +x`).
 *
 * In-memory only — the `sessions` Map below *is* the entire persistence layer.
 * State here is only ever meant to live minutes (bridging one WebRTC
 * handshake), so a process restart dropping in-flight sessions is an accepted
 * trade against running/backing up a real datastore for data this short-lived.
 */

import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — every tunable overridable via CODEENSTEIN_MULTIPLAYER_<NAME>,
// matching this repo's house env-var convention (see scripts/run-perf-
// benchmark.mjs's CODEENSTEIN_PERF_PORT for the same shape). Defaults below
// are the spec's own numbers except PORT/ALLOWED_ORIGIN, which the spec never
// pinned — see this script's own doc comment history / the PR description for
// why 8787 and the production game origin were chosen as defaults.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.CODEENSTEIN_MULTIPLAYER_PORT ?? 8787);
const ALLOWED_ORIGIN =
  process.env.CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN ?? "https://codeenstein3d.mcdope.org";
/** Interface to bind. Defaults to `127.0.0.1` — the topology the spec assumes
 * (§1: loopback-only, TLS reverse proxy in front) and what the systemd install
 * gets. Containerized deployments (`docker/`) must set `0.0.0.0`, because the
 * proxy then reaches the process across the container's network namespace
 * rather than over the host's loopback; that deployment pairs it with
 * `TRUSTED_PROXY_IPS` below, which is what keeps `X-Forwarded-For` honest once
 * the peer is no longer structurally guaranteed to be loopback. */
const BIND_HOST = process.env.CODEENSTEIN_MULTIPLAYER_BIND_HOST ?? "127.0.0.1";

const SESSION_TTL_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_SESSION_TTL_MS ?? 5 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_SWEEP_INTERVAL_MS ?? 30_000);
const MAX_CONCURRENT_SESSIONS = Number(process.env.CODEENSTEIN_MULTIPLAYER_MAX_CONCURRENT_SESSIONS ?? 500);

const RATE_LIMIT_WINDOW_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_MAX_REQUESTS ?? 20);
const HOST_TOKEN_MAX_REQUESTS = Number(process.env.CODEENSTEIN_MULTIPLAYER_HOST_TOKEN_MAX_REQUESTS ?? 120);
const LOBBY_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_LOBBY_RATE_LIMIT_MAX_REQUESTS ?? 60,
);
/** The spec's `PUT /session` error list documents a `429` and references "its
 * own... separate, lighter protection" (§4), but — unlike `GET /lobby`, which
 * gets a fully-specified subsection — never actually specifies that
 * protection's mechanism or ceiling. Resolved the same way as the code-
 * alphabet gap above: implemented as its own dedicated, non-guess-sensitive
 * budget (own map, own env override) rather than silently left unimplemented
 * or folded into an unrelated budget. 30/min is deliberately more
 * conservative than `GET /lobby`'s 60/min — this is a state-mutating
 * operation (creates/updates a session), not a read. */
const PUT_SESSION_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_PUT_SESSION_RATE_LIMIT_MAX_REQUESTS ?? 30,
);
/** `POST /session/<code>/answer`'s existing `guessLimits` budget is keyed by
 * IP — sized to slow down one caller guessing at codes it doesn't hold. It
 * does nothing against a *lobby-derived* code (any public session's code is
 * handed out for free by `GET /lobby`): many distinct attacker IPs, each
 * individually well under that per-IP budget, can still collectively flood
 * one session's answer slot with garbage POSTs, racing the real joiner (see
 * `already_answered`'s own doc comment). This is a second, independent
 * budget on the same endpoint, keyed by `code` instead of IP — it caps how
 * many answer attempts *one session* can absorb in a window, regardless of
 * how many different IPs make them. Same `checkRateLimit` machinery, just a
 * different key space. Lower than `RATE_LIMIT_MAX_REQUESTS`: a real joiner
 * only ever needs to post once. */
const ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS ?? 10,
);
const BASE_COOLDOWN_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_BASE_COOLDOWN_MS ?? 5_000);

/** Caps how many distinct keys each of the rate-limit maps below will ever
 * track at once — without this, an attacker (real, or via a spoofed
 * `X-Forwarded-For` — see `getClientIp`) can grow these maps unboundedly
 * until the next sweep (`SWEEP_INTERVAL_MS`, up to tens of seconds later), a
 * straightforward memory-exhaustion DoS. 10,000 distinct concurrently-tracked
 * keys per limiter is generously above any realistic legitimate concurrency
 * for this server while still bounding worst-case memory to a small, fixed
 * multiple of `IpLimitState`'s size. Same cap applies to `answerAttemptsByCode`
 * even though its keys are session codes, not IPs — the name predates that
 * limiter, but the bounding logic (`checkRateLimit`) is identical either way.
 * See `checkRateLimit`'s own comment for what happens once a map is actually
 * at this cap. */
const MAX_TRACKED_IPS_PER_LIMITER = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_MAX_TRACKED_IPS_PER_LIMITER ?? 10_000,
);

/** Peers — beyond loopback, which is always trusted — whose `X-Forwarded-For`
 * this server will believe (see `getClientIp`). Comma-separated IP literals
 * and/or IPv4 CIDRs, e.g. `172.28.5.0/24`. Empty by default, so a bare
 * `node multiplayer-server.mjs` behaves exactly as before.
 *
 * This exists for the containerized deployment: there the reverse proxy on the
 * host connects through the bridge network, so the TCP peer this process sees
 * is the docker gateway, not `127.0.0.1`. Without trusting it, `getClientIp`
 * falls back to that one gateway address for *every* request and all clients
 * share a single rate-limit bucket — the exact failure the spec's §1 note
 * warns about for a proxy that doesn't forward the header. Trusting the
 * gateway is no weaker than today's loopback trust *provided* the published
 * port stays host-local (`127.0.0.1:8787:8787` in `docker/docker-compose.yml`),
 * since only host-local clients can reach it either way. Widening it to a
 * public interface would let anyone forge the header — hence the startup
 * warning in `main()`. */
const TRUSTED_PROXY_IPS = parseTrustedProxies(
  process.env.CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS ?? "",
);

/** `GET /stats` (and the `--stats` CLI mode that queries it) is entirely
 * opt-in: unset, the endpoint doesn't exist as far as any caller can tell —
 * an unauthenticated or unconfigured request gets the same plain 404 as any
 * other unknown route, never a distinguishable "this feature exists, you're
 * just not authorized" response. Deliberately not gated by IP/proxy topology
 * (see getClientIp's own doc comment on why `remoteAddress` can't
 * distinguish "via the public proxy" from "a local operator" once behind a
 * reverse proxy) — a shared secret is the one mechanism that works
 * regardless of network path. */
const STATS_TOKEN = process.env.CODEENSTEIN_MULTIPLAYER_STATS_TOKEN;
const MAX_COOLDOWN_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_MAX_COOLDOWN_MS ?? 60 * 60_000);

const MAX_BODY_BYTES = Number(process.env.CODEENSTEIN_MULTIPLAYER_MAX_BODY_BYTES ?? 8192);

/** Explicit `http.Server` timeouts, rather than relying entirely on Node's
 * own built-in defaults — mild Slowloris-style exposure otherwise (many
 * slow/idle connections tying up memory/file descriptors for minutes). Both
 * conservative for this server's actual traffic shape: every request here is
 * a small JSON body (capped at `MAX_BODY_BYTES`) from a same-origin browser
 * client or the trusted local proxy, never a large/streamed upload, so there
 * is no legitimate reason for headers or a full request to take anywhere
 * near this long. `HEADERS_TIMEOUT_MS` bounds how long a connection may take
 * to finish sending its request headers; `REQUEST_TIMEOUT_MS` bounds the
 * entire request (headers + body) and must be `>= HEADERS_TIMEOUT_MS`, since
 * headers are part of the request it's timing. */
const HEADERS_TIMEOUT_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_HEADERS_TIMEOUT_MS ?? 20_000);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEENSTEIN_MULTIPLAYER_REQUEST_TIMEOUT_MS ?? 30_000);

const MAX_OFFER_ANSWER_BYTES = 4096;
const MAX_DISPLAY_NAME_CHARS = 100;
const MAX_CAMPAIGN_NAME_CHARS = 100;

// ---------------------------------------------------------------------------
// TURN relay (optional) — server-minted ephemeral coturn credentials.
//
// Entirely opt-in and default-off: with TURN_SECRET or TURN_URLS unset, the
// `GET /session/<code>/turn-credentials` route 404s indistinguishably from any
// unknown route (same design as STATS_TOKEN above) and clients fall back to
// STUN-only, exactly as before this feature existed.
//
// When enabled, this process never relays a byte — it only mints short-lived
// credentials that a *separate* coturn daemon (configured with the same
// `static-auth-secret`) validates itself. Scheme is coturn's `use-auth-secret`
// / "TURN REST API": username = "<unix-expiry>", credential =
// base64(HMAC-SHA1(secret, username)). See doc/dev/multiplayer-server-spec.md's
// "TURN relay" section for the MANDATORY coturn hardening (denied-peer-ip for
// loopback/RFC1918, quotas, non-root): a session `code` can be public (GET
// /lobby), so the issuance gating below is necessary but the relay lockdown is
// what actually protects a shared host from a leaked credential.
// ---------------------------------------------------------------------------
const TURN_SECRET = process.env.CODEENSTEIN_MULTIPLAYER_TURN_SECRET;
const TURN_URLS = (process.env.CODEENSTEIN_MULTIPLAYER_TURN_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const TURN_TTL_SECONDS = Number(process.env.CODEENSTEIN_MULTIPLAYER_TURN_TTL_SECONDS ?? 3600);
/** The feature is live only when both a secret and at least one advertised URL
 * are configured — either missing means "off" and the route 404s. */
const TURN_ENABLED = typeof TURN_SECRET === "string" && TURN_SECRET.length > 0 && TURN_URLS.length > 0;
/** Per-IP budget on credential minting — a browser needs only one mint per
 * connection attempt, so this is generous but bounded. */
const TURN_CREDENTIALS_MAX_REQUESTS = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_MAX_REQUESTS ?? 30,
);
/** Independent per-*code* budget, mirroring ANSWER_PER_CODE_...: a public
 * lobby code is handed to anyone browsing, so a per-IP budget alone can't stop
 * many distinct IPs each minting creds against one session. One host plus a few
 * guests need only a handful of mints per code. */
const TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS = Number(
  process.env.CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS ?? 20,
);

/**
 * Session code alphabet. **Corrects an arithmetic slip in the spec docs**:
 * they describe excluding `{0, O, 1, I, L}` from the 36-character uppercase-
 * alphanumeric set for a "32-symbol alphabet" — but 36 - 5 = 31, not 32, so
 * the "low 5 bits of a random byte map uniformly, no rejection sampling
 * needed" property (which genuinely does require an *exact* power-of-two
 * alphabet size) wouldn't actually hold against the literal 5-exclusion set
 * as documented. Resolved here by adopting Crockford's Base32 alphabet
 * verbatim (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) instead of inventing a
 * different one-off 32-character set: it's a real, proven standard designed
 * for exactly this "short, human-typable, unambiguous code" purpose, and it
 * is exactly 32 symbols (10 digits + 22 letters, excluding only I/L/O/U).
 * Confirmed correct: 256 / 32 = 8 exactly, so `byte & 0x1f` is still perfectly
 * uniform over this alphabet with zero rejection sampling.
 */
const SESSION_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const SESSION_UNIT_NAME = "codeenstein-multiplayer.service";
const SESSION_UNIT_PATH = `/etc/systemd/system/${SESSION_UNIT_NAME}`;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

/** @typedef {{
 *   code: string, hostToken: string, offer: string, answer: string | null,
 *   createdAt: number, lastActivityAt: number, expiresAt: number,
 *   public: boolean, displayName: string | null, playerCount: number,
 *   campaignName: string,
 * }} SessionRecord */

/** The entire persistence layer — see this file's own doc comment. */
const sessions = new Map();

/** @typedef {{ windowStart: number, windowCount: number, violationCount: number, cooldownUntil: number }} IpLimitState */

// Three separate maps, not one shared map with different thresholds per call
// site — the host-token-exempt budget and the guess-sensitive budget are
// genuinely different ceilings for the same IP at the same time, which a
// single map keyed only by IP can't represent (see doc/dev/multiplayer-
// server-spec.md §4's host exemption: a wrong/missing token still counts
// against the *strict* budget even for an IP that also holds a valid token
// for some other, unrelated request).
/** @type {Map<string, IpLimitState>} */
const guessLimits = new Map();
/** @type {Map<string, IpLimitState>} */
const hostTokenLimits = new Map();
/** @type {Map<string, IpLimitState>} */
const lobbyLimits = new Map();
/** @type {Map<string, IpLimitState>} */
const putSessionLimits = new Map();
/** Keyed by session `code`, not IP — see `ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS`'s
 * own doc comment for why a per-IP budget alone can't catch many distinct
 * IPs each individually flooding one session's answer slot. */
/** @type {Map<string, IpLimitState>} */
const answerAttemptsByCode = new Map();
/** Per-IP budget for GET /session/<code>/turn-credentials — see
 * TURN_CREDENTIALS_MAX_REQUESTS. */
/** @type {Map<string, IpLimitState>} */
const turnCredentialLimits = new Map();
/** Keyed by session `code`, not IP — the per-code companion to the budget
 * above, see TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS. */
/** @type {Map<string, IpLimitState>} */
const turnCredentialLimitsByCode = new Map();

// Cumulative, process-lifetime counters for /stats — deliberately separate
// from the live Map sizes above, which only ever show a snapshot ("how many
// right now"), not throughput ("how many total since this process started").
let serverStartedAt = 0;
let totalSessionsCreated = 0;
let totalRateLimitRejections = 0;

// ---------------------------------------------------------------------------
// Code / token generation
// ---------------------------------------------------------------------------

function generateCode() {
  const bytes = randomBytes(6);
  let code = "";
  for (const b of bytes) code += SESSION_CODE_ALPHABET[b & 0x1f];
  return code;
}

/** A guaranteed-unique code, not just a probabilistically-unique one — see
 * doc/dev/multiplayer-server-spec.md §3: astronomically unlikely to ever
 * actually loop, at negligible cost when it does. */
function generateUniqueCode() {
  let code = generateCode();
  while (sessions.has(code)) code = generateCode();
  return code;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function touchSession(record, now) {
  record.lastActivityAt = now;
  record.expiresAt = now + SESSION_TTL_MS;
}

/** Looks up a session by code, treating an already-expired-but-not-yet-swept
 * entry as absent (and lazily removing it) — makes TTL behavior deterministic
 * for callers regardless of exactly when the sweep last ran, rather than
 * depending on sweep timing for correctness. */
function getLiveSession(code, now) {
  const record = sessions.get(code);
  if (!record) return undefined;
  if (record.expiresAt <= now) {
    sessions.delete(code);
    return undefined;
  }
  return record;
}

function sweep() {
  const now = Date.now();
  for (const [code, record] of sessions) {
    if (now > record.expiresAt) sessions.delete(code);
  }
  for (const map of [
    guessLimits,
    hostTokenLimits,
    lobbyLimits,
    putSessionLimits,
    answerAttemptsByCode,
    turnCredentialLimits,
    turnCredentialLimitsByCode,
  ]) {
    for (const [ip, state] of map) {
      const windowLive = now - state.windowStart < RATE_LIMIT_WINDOW_MS;
      const cooldownLive = now < state.cooldownUntil;
      if (!windowLive && !cooldownLive) map.delete(ip);
    }
  }
}

// Intentionally not `.unref()`'d — this is a persistent daemon meant to keep
// running, not a short-lived script that should be allowed to exit while the
// timer is pending.
let sweepTimer;
function startSweeping() {
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Loopback addresses `req.socket.remoteAddress` can take when the actual
 * TCP peer is the local reverse proxy this process is meant to sit behind
 * (see `getClientIp`'s own comment) — plain `127.0.0.1`/`::1`, plus the
 * IPv4-mapped-IPv6 form Node reports for some dual-stack listen
 * configurations. */
function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** `1.2.3.4` → its 32-bit integer, or `null` for anything that isn't a plain
 * dotted-quad IPv4 literal (including IPv6, hostnames and malformed input). */
function ipv4ToInt(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    // Reject "01", "+1", " 1", "1e2" and friends: only canonical decimal
    // octets, so a typo'd entry can never silently widen the trusted range.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

/** Node reports an IPv4 peer as `::ffff:1.2.3.4` on a dual-stack listener, so
 * both forms must compare equal against the same configured entry. */
function normalizeAddress(address) {
  const lowered = address.toLowerCase();
  return lowered.startsWith("::ffff:") && ipv4ToInt(lowered.slice("::ffff:".length)) !== null
    ? lowered.slice("::ffff:".length)
    : lowered;
}

/** Parses `CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS` into matcher entries.
 * Unparseable entries are warned about and dropped rather than throwing: the
 * failure mode of dropping one is fail-safe (that peer's `X-Forwarded-For`
 * stops being trusted, so requests get rate-limited by socket address — noisy,
 * never permissive), whereas refusing to boot on a typo would take the whole
 * lobby down. */
function parseTrustedProxies(spec) {
  const entries = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash === -1) {
      entries.push({ kind: "exact", address: normalizeAddress(entry) });
      continue;
    }
    const base = ipv4ToInt(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      console.warn(
        `[multiplayer-server] ignoring unparseable CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS entry: ${entry}` +
          " (expected an IP literal or an IPv4 CIDR like 172.28.5.0/24)",
      );
      continue;
    }
    // `>>> 0` keeps the mask unsigned; a /0 shift of 32 is a no-op in JS, so
    // that case is spelled out rather than computed.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    entries.push({ kind: "cidr4", base: (base & mask) >>> 0, mask });
  }
  return entries;
}

/** Whether a TCP peer address is a configured trusted proxy. */
function isTrustedProxy(address, entries) {
  if (entries.length === 0) return false;
  const normalized = normalizeAddress(address);
  const asInt = ipv4ToInt(normalized);
  for (const entry of entries) {
    if (entry.kind === "exact") {
      if (entry.address === normalized) return true;
    } else if (asInt !== null && ((asInt & entry.mask) >>> 0) === entry.base) {
      return true;
    }
  }
  return false;
}

/** Client IP for rate-limiting: the *rightmost* entry of `X-Forwarded-For`
 * — but **only** when the request's actual TCP peer (`req.socket.
 * remoteAddress`) is itself loopback, i.e. only when it's structurally
 * possible for that peer to be the trusted local reverse proxy this process
 * is meant to sit behind — *or* an address explicitly listed in
 * `CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS`, which is how the containerized
 * deployment names its bridge gateway (the proxy there is still host-local,
 * it just isn't loopback from inside the container's netns). With the default
 * `BIND_HOST` of `127.0.0.1` and no trusted proxies configured, `remoteAddress`
 * is *always* loopback and this check always passes — that shape is
 * defense-in-depth against a rebind to a public interface, not a currently-live
 * exploit, where anything could connect directly and forge whatever
 * `X-Forwarded-For` it likes. Falls back to the raw socket address whenever the
 * header is absent *or* the peer isn't trusted (see
 * doc/dev/multiplayer-server-spec.md §1's deployment note for why trusting the
 * proxy's own header is safe once that precondition holds). */
function getClientIp(req) {
  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  if (!isLoopbackAddress(remoteAddress) && !isTrustedProxy(remoteAddress, TRUSTED_PROXY_IPS)) {
    return remoteAddress;
  }

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff.split(",");
    const rightmost = parts[parts.length - 1].trim();
    if (rightmost) return rightmost;
  }
  return remoteAddress;
}

/** Returns `{ allowed, retryAfterMs }`. A request currently under
 * `cooldownUntil` is rejected immediately without even touching the window
 * counter (matches the spec's exponential-backoff description exactly) — an
 * IP that keeps hammering after tripping the limit gets a strictly *longer*
 * cooldown on each subsequent violation, not a flat repeated penalty. */
function checkRateLimit(map, ip, maxRequests, now) {
  let state = map.get(ip);
  if (!state) {
    // Map is already at MAX_TRACKED_IPS_PER_LIMITER and this is a genuinely
    // new IP: refuse to allocate a new tracking entry rather than growing
    // the map further (bounding memory is the entire point of the cap) or
    // evicting some other, possibly mid-cooldown, entry to make room for it.
    // This IP's request is simply let through unmetered this one time — a
    // deliberate fail-*open* choice, not fail-closed: a full map must never
    // itself become a denial-of-service against every *new* legitimate
    // caller. Once any of this IP's requests lands while the map has spare
    // capacity, it gets tracked normally from then on.
    if (map.size >= MAX_TRACKED_IPS_PER_LIMITER) {
      return { allowed: true, retryAfterMs: 0 };
    }
    state = { windowStart: now, windowCount: 0, violationCount: 0, cooldownUntil: 0 };
    map.set(ip, state);
  }

  if (now < state.cooldownUntil) {
    totalRateLimitRejections += 1;
    return { allowed: false, retryAfterMs: state.cooldownUntil - now };
  }

  if (now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    state.windowStart = now;
    state.windowCount = 0;
  }

  state.windowCount += 1;

  if (state.windowCount > maxRequests) {
    state.violationCount += 1;
    const cooldownMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** state.violationCount);
    state.cooldownUntil = now + cooldownMs;
    totalRateLimitRejections += 1;
    return { allowed: false, retryAfterMs: cooldownMs };
  }

  return { allowed: true, retryAfterMs: 0 };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  // Only ever echoed back when it matches exactly — never a wildcard, never
  // the caller's own (possibly attacker-controlled) Origin verbatim. A
  // mismatched/absent Origin simply gets no CORS header at all, which is what
  // makes the browser refuse to let cross-origin JS read the response.
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Host-Token");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, status, body, { closeConnection } = {}) {
  const payload = JSON.stringify(body);
  if (closeConnection) res.setHeader("Connection", "close");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res, status, code, extra, opts) {
  sendJson(res, status, { error: code, ...extra }, opts);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

/** Reads and JSON-parses a request body, enforcing `MAX_BODY_BYTES`
 * *incrementally* as chunks arrive — not only after fully buffering — so a
 * slow-trickled oversized body can't be used to hold memory open
 * indefinitely. Rejects with `{ tooLarge: true }` (caller responds 413) or
 * `{ invalidJson: true }` (caller responds 400) rather than throwing, since
 * both are routine client-input cases, not exceptional ones.
 *
 * Deliberately does **not** call `req.destroy()` on overflow — that destroys
 * the whole underlying socket (confirmed directly: it did, breaking the 413
 * response entirely — the client saw a bare connection reset instead of any
 * HTTP response). Instead it just stops buffering further chunks and lets the
 * connection stay alive long enough for the caller to actually send the 413;
 * the caller closes the connection itself afterward (`Connection: close` on
 * that response) rather than reusing it, since the unread remainder of this
 * oversized body would otherwise corrupt whatever request comes next on a
 * reused keep-alive connection. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    let overflowed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (overflowed) return; // draining silently post-overflow; already resolved
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflowed = true;
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });

    req.on("aborted", () => finish({ invalidJson: true }));
    req.on("error", () => finish({ invalidJson: true }));

    req.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text.length > 0 ? JSON.parse(text) : {};
        finish({ body });
      } catch {
        finish({ invalidJson: true });
      }
    });
  });
}

function byteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

/** Constant-time secret comparison for `hostToken`/`X-Stats-Token` checks.
 * Plain `!==`/`===` on strings short-circuits at the first mismatched
 * character — the wrong pattern for comparing secrets, even though real-
 * network jitter likely swamps the timing signal in practice here.
 * `crypto.timingSafeEqual` requires equal-length buffers (it *throws* on a
 * length mismatch), so a length check comes first and a mismatch there is
 * simply treated as "not equal" without ever calling it — a length
 * difference is not itself sensitive (both tokens are fixed-format:
 * `hostToken` is a `randomUUID()`, `STATS_TOKEN` a fixed operator-configured
 * value), only the *content* comparison needs to be constant-time. */
function timingSafeStringEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Codepoints rejected in `displayName`/`campaignName`: these two fields are
 * relayed verbatim to *other players'* lobby UI (`GET /lobby`), so beyond
 * the existing type/length checks they need content filtering too — `.length`
 * is UTF-16 code units, so a "short" string can still smuggle many
 * control/formatting codepoints past a length check alone. Rejects:
 *  - C0 controls (below U+0020) and DEL/C1 controls (U+007F-U+009F) —
 *    terminal/renderer-disruptive (e.g. could rewrite the visible line via
 *    escape sequences in a naive console/log renderer).
 *  - U+061C (Arabic Letter Mark) and every zero-width/bidi-override/bidi-
 *    isolate formatting codepoint (U+200B-U+200F, U+202A-U+202E,
 *    U+2060-U+2069, U+FEFF) — the classic "invisible characters"/RTL-
 *    override-or-isolate spoofing vector (the exact Trojan-Source/CVE-2021-
 *    42574 character class) for making a displayed name read as something
 *    other than its actual content (e.g. impersonating another player, or
 *    hiding characters from a casual read of the lobby). The isolates
 *    (U+2066-U+2069: LRI/RLI/FSI/PDI) are a distinct, newer bidi-control
 *    family from the override characters above — same spoofing class, easy
 *    to omit if only the overrides are considered. U+2065 (inside that
 *    range) is unassigned in Unicode; excluding it is harmless. */
const FORBIDDEN_NAME_CHARS_RE = new RegExp(
  "[\\u0000-\\u001F\\u061C\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]",
);

function hasForbiddenNameChars(str) {
  return FORBIDDEN_NAME_CHARS_RE.test(str);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePutSession(req, res) {
  const now = Date.now();
  const ip = getClientIp(req);

  // Not guess-sensitive (nothing here reveals whether some *other* code
  // exists), so this uses its own separate, lighter budget — see
  // PUT_SESSION_RATE_LIMIT_MAX_REQUESTS's doc comment. Checked before reading
  // the body, same reasoning as the other handlers: don't do request-parsing
  // work for a call that's going to be rejected anyway.
  const limit = checkRateLimit(putSessionLimits, ip, PUT_SESSION_RATE_LIMIT_MAX_REQUESTS, now);
  if (!limit.allowed) {
    res.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: limit.retryAfterMs });
  }

  const result = await readJsonBody(req);
  if (result.tooLarge) return sendError(res, 413, "payload_too_large", undefined, { closeConnection: true });
  if (result.invalidJson) return sendError(res, 400, "invalid_json");
  const body = result.body;

  if (typeof body.offer !== "string" || body.offer.length === 0) {
    return sendError(res, 400, "missing_offer");
  }
  if (byteLength(body.offer) > MAX_OFFER_ANSWER_BYTES) {
    return sendError(res, 400, "offer_too_large");
  }
  if (typeof body.campaignName !== "string" || body.campaignName.length === 0) {
    return sendError(res, 400, "missing_campaign_name");
  }
  if (body.campaignName.length > MAX_CAMPAIGN_NAME_CHARS) {
    return sendError(res, 400, "campaign_name_too_long");
  }
  if (hasForbiddenNameChars(body.campaignName)) {
    return sendError(res, 400, "campaign_name_invalid_chars");
  }
  if (
    !Number.isInteger(body.playerCount) ||
    body.playerCount < 1 ||
    body.playerCount > 16
  ) {
    return sendError(res, 400, "invalid_player_count");
  }
  if (body.displayName !== undefined && body.displayName !== null) {
    if (typeof body.displayName !== "string") return sendError(res, 400, "invalid_display_name");
    if (body.displayName.length > MAX_DISPLAY_NAME_CHARS) {
      return sendError(res, 400, "display_name_too_long");
    }
    if (hasForbiddenNameChars(body.displayName)) {
      return sendError(res, 400, "display_name_invalid_chars");
    }
  }
  if (body.public !== undefined && typeof body.public !== "boolean") {
    return sendError(res, 400, "invalid_public");
  }

  const isUpdate = body.code !== undefined && body.code !== null;

  if (isUpdate) {
    if (typeof body.code !== "string") return sendError(res, 400, "invalid_code");
    const record = getLiveSession(body.code, now);
    if (!record) return sendError(res, 404, "session_not_found");
    if (!timingSafeStringEqual(body.hostToken, record.hostToken)) {
      return sendError(res, 403, "host_token_mismatch");
    }

    record.offer = body.offer;
    record.answer = null; // a fresh offer starts a new handshake round
    record.answerClaimed = false; // same reset, see handlePostAnswer's own doc comment
    record.public = body.public ?? false;
    record.displayName = body.displayName ?? null;
    record.playerCount = body.playerCount;
    record.campaignName = body.campaignName;
    touchSession(record, now);

    return sendJson(res, 200, { code: record.code, hostToken: record.hostToken, expiresAt: record.expiresAt });
  }

  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    return sendError(res, 503, "max_sessions_reached");
  }

  const code = generateUniqueCode();
  const record = {
    code,
    hostToken: randomUUID(),
    offer: body.offer,
    answer: null,
    answerClaimed: false, // see handlePostAnswer's own doc comment
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now, // set for real by touchSession below
    public: body.public ?? false,
    displayName: body.displayName ?? null,
    playerCount: body.playerCount,
    campaignName: body.campaignName,
  };
  touchSession(record, now);
  sessions.set(code, record);
  totalSessionsCreated += 1;

  return sendJson(res, 201, { code: record.code, hostToken: record.hostToken, expiresAt: record.expiresAt });
}

function handleGetSession(req, res, code) {
  const now = Date.now();
  const ip = getClientIp(req);
  const record = getLiveSession(code, now);

  const providedToken = req.headers["x-host-token"];
  const isHostAuthenticated = !!record && timingSafeStringEqual(providedToken, record.hostToken);

  const limit = isHostAuthenticated
    ? checkRateLimit(hostTokenLimits, ip, HOST_TOKEN_MAX_REQUESTS, now)
    : checkRateLimit(guessLimits, ip, RATE_LIMIT_MAX_REQUESTS, now);

  if (!limit.allowed) {
    res.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: limit.retryAfterMs });
  }

  if (!record) return sendError(res, 404, "session_not_found");

  return sendJson(res, 200, {
    code: record.code,
    offer: record.offer,
    answer: record.answer,
    campaignName: record.campaignName,
    displayName: record.displayName,
    playerCount: record.playerCount,
  });
}

async function handlePostAnswer(req, res, code) {
  const now = Date.now();
  const ip = getClientIp(req);

  // No host-token exemption here, deliberately: the *joiner* posts an
  // answer, never the host — there's no scenario where a valid host token
  // would legitimately accompany this request, so every caller uses the
  // strict guess-sensitive budget, matching the spec's own endpoint
  // description (only GET /session/<code> documents a token exemption).
  const limit = checkRateLimit(guessLimits, ip, RATE_LIMIT_MAX_REQUESTS, now);
  if (!limit.allowed) {
    res.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: limit.retryAfterMs });
  }
  // Independent, per-*code* budget — see `ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS`'s
  // own doc comment: closes the gap the per-IP budget above leaves open when
  // many distinct IPs each flood one lobby-derived code's answer slot.
  const codeLimit = checkRateLimit(answerAttemptsByCode, code, ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS, now);
  if (!codeLimit.allowed) {
    res.setHeader("Retry-After", Math.ceil(codeLimit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: codeLimit.retryAfterMs });
  }

  const record = getLiveSession(code, now);
  if (!record) return sendError(res, 404, "session_not_found");

  // Claimed synchronously, *before* the `await` below — two concurrent
  // requests for the same code otherwise both read `record.answer === null`
  // and both pass, since neither actually sets it until after its own body
  // finishes reading. Claiming here (nothing async happens between the read
  // and the write) makes that race structurally impossible: whichever
  // request's synchronous code runs first wins the claim, and every other
  // concurrent request sees it immediately.
  if (record.answer !== null || record.answerClaimed) {
    return sendError(res, 409, "already_answered");
  }
  record.answerClaimed = true;

  const result = await readJsonBody(req);
  if (result.tooLarge) return sendError(res, 413, "payload_too_large", undefined, { closeConnection: true });
  if (result.invalidJson) {
    record.answerClaimed = false; // release — this request never actually landed a real answer
    return sendError(res, 400, "invalid_json");
  }
  const body = result.body;

  if (typeof body.answer !== "string" || body.answer.length === 0) {
    record.answerClaimed = false;
    return sendError(res, 400, "missing_answer");
  }
  if (byteLength(body.answer) > MAX_OFFER_ANSWER_BYTES) {
    record.answerClaimed = false;
    return sendError(res, 400, "answer_too_large");
  }

  record.answer = body.answer;
  touchSession(record, now); // a real join attempt in progress is real activity

  return sendNoContent(res);
}

function handleGetLobby(req, res) {
  const now = Date.now();
  const ip = getClientIp(req);

  const limit = checkRateLimit(lobbyLimits, ip, LOBBY_RATE_LIMIT_MAX_REQUESTS, now);
  if (!limit.allowed) {
    res.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: limit.retryAfterMs });
  }

  const list = [];
  for (const record of sessions.values()) {
    if (record.expiresAt <= now) continue; // defensive; sweep normally handles this
    if (!record.public) continue;
    list.push({
      code: record.code,
      displayName: record.displayName,
      campaignName: record.campaignName,
      playerCount: record.playerCount,
    });
  }

  return sendJson(res, 200, { sessions: list });
}

/** How many entries in a rate-limit map are *currently* in an active
 * cooldown — a live "is something hammering us right now" signal, distinct
 * from the map's total size (which also includes IPs that are merely being
 * tracked within a normal, unremarkable window). */
function countInCooldown(map, now) {
  let count = 0;
  for (const state of map.values()) if (now < state.cooldownUntil) count += 1;
  return count;
}

/** Aggregate, numbers-only monitoring snapshot — no session codes, no
 * hostTokens, no offer/answer contents, no IPs. See `STATS_TOKEN`'s doc
 * comment for why this whole endpoint is opt-in and 404s indistinguishably
 * from an unknown route unless explicitly configured and authenticated. */
function handleGetStats(req, res) {
  if (!STATS_TOKEN || !timingSafeStringEqual(req.headers["x-stats-token"], STATS_TOKEN)) {
    return sendError(res, 404, "not_found");
  }

  const now = Date.now();
  let publicCount = 0;
  let awaitingAnswer = 0;
  let answered = 0;
  for (const record of sessions.values()) {
    if (record.public) publicCount += 1;
    if (record.answer === null) awaitingAnswer += 1;
    else answered += 1;
  }

  return sendJson(res, 200, {
    pid: process.pid,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor((now - serverStartedAt) / 1000),
    sessions: {
      live: sessions.size,
      public: publicCount,
      awaitingAnswer,
      answered,
      maxConcurrent: MAX_CONCURRENT_SESSIONS,
      totalCreatedSinceStart: totalSessionsCreated,
    },
    rateLimiting: {
      totalRejectionsSinceStart: totalRateLimitRejections,
      trackedIps: {
        guess: guessLimits.size,
        hostToken: hostTokenLimits.size,
        lobby: lobbyLimits.size,
        putSession: putSessionLimits.size,
        // Tracked keys here are session codes, not IPs — named to match the
        // sibling fields above (all part of the same `trackedIps` bucket)
        // rather than carving out a separate top-level field for one limiter.
        answerPerCode: answerAttemptsByCode.size,
        turnCredentials: turnCredentialLimits.size,
        turnCredentialsPerCode: turnCredentialLimitsByCode.size,
      },
      ipsCurrentlyInCooldown: {
        guess: countInCooldown(guessLimits, now),
        hostToken: countInCooldown(hostTokenLimits, now),
        lobby: countInCooldown(lobbyLimits, now),
        putSession: countInCooldown(putSessionLimits, now),
        answerPerCode: countInCooldown(answerAttemptsByCode, now),
        turnCredentials: countInCooldown(turnCredentialLimits, now),
        turnCredentialsPerCode: countInCooldown(turnCredentialLimitsByCode, now),
      },
    },
  });
}

/** Mints an ephemeral coturn credential for a caller who holds a *live*
 * session code — the host additionally proving ownership via `X-Host-Token`,
 * a guest authorized (as everywhere else in the join protocol) by knowing the
 * code. See TURN_SECRET's config comment for the scheme and why the strong
 * guarantees live in coturn's own config rather than here. 404s
 * indistinguishably from an unknown route when the feature is unconfigured. */
function handleTurnCredentials(req, res, code) {
  // Feature off → look exactly like an unknown route (same as /stats).
  if (!TURN_ENABLED) return sendError(res, 404, "not_found");

  const now = Date.now();
  const ip = getClientIp(req);

  // Per-IP budget, then an independent per-code budget — a lobby-public code is
  // knowable by anyone, so neither alone suffices (mirrors handlePostAnswer's
  // two-budget structure).
  const ipLimit = checkRateLimit(turnCredentialLimits, ip, TURN_CREDENTIALS_MAX_REQUESTS, now);
  if (!ipLimit.allowed) {
    res.setHeader("Retry-After", Math.ceil(ipLimit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: ipLimit.retryAfterMs });
  }
  const codeLimit = checkRateLimit(
    turnCredentialLimitsByCode,
    code,
    TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS,
    now,
  );
  if (!codeLimit.allowed) {
    res.setHeader("Retry-After", Math.ceil(codeLimit.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited", { retryAfterMs: codeLimit.retryAfterMs });
  }

  // Core gate: no credential without a live session behind the code.
  const record = getLiveSession(code, now);
  if (!record) return sendError(res, 404, "session_not_found");

  // A caller presenting `X-Host-Token` must present the *right* one (host
  // path); a present-but-wrong token is rejected rather than silently
  // downgraded to guest access, matching PUT /session's update path. A guest
  // presents no token and is authorized by the live code alone.
  const providedToken = req.headers["x-host-token"];
  if (providedToken !== undefined && !timingSafeStringEqual(providedToken, record.hostToken)) {
    return sendError(res, 403, "host_token_mismatch");
  }

  const expiry = Math.floor(now / 1000) + TURN_TTL_SECONDS;
  const username = String(expiry);
  const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");

  return sendJson(res, 200, {
    iceServers: [{ urls: TURN_URLS, username, credential }],
    ttl: TURN_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const SESSION_PATH_RE = /^\/session\/([^/]+)$/;
const ANSWER_PATH_RE = /^\/session\/([^/]+)\/answer$/;
const TURN_PATH_RE = /^\/session\/([^/]+)\/turn-credentials$/;

async function requestListener(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return sendError(res, 400, "invalid_url");
  }

  try {
    if (req.method === "PUT" && pathname === "/session") {
      return await handlePutSession(req, res);
    }
    const sessionMatch = pathname.match(SESSION_PATH_RE);
    if (req.method === "GET" && sessionMatch) {
      return handleGetSession(req, res, decodeURIComponent(sessionMatch[1]));
    }
    const answerMatch = pathname.match(ANSWER_PATH_RE);
    if (req.method === "POST" && answerMatch) {
      return await handlePostAnswer(req, res, decodeURIComponent(answerMatch[1]));
    }
    const turnMatch = pathname.match(TURN_PATH_RE);
    if (req.method === "GET" && turnMatch) {
      return handleTurnCredentials(req, res, decodeURIComponent(turnMatch[1]));
    }
    if (req.method === "GET" && pathname === "/lobby") {
      return handleGetLobby(req, res);
    }
    if (req.method === "GET" && pathname === "/stats") {
      return handleGetStats(req, res);
    }
    return sendError(res, 404, "not_found");
  } catch (err) {
    console.error("[multiplayer-server] unhandled error:", err);
    if (!res.headersSent) sendError(res, 500, "internal_error");
  }
}

// ---------------------------------------------------------------------------
// --install / --uninstall / --dry-run
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const flags = {
    install: false,
    uninstall: false,
    dryRun: false,
    stats: false,
    json: false,
    help: false,
    port: undefined,
    allowedOrigin: undefined,
  };
  for (const arg of argv) {
    if (arg === "--install") flags.install = true;
    else if (arg === "--uninstall") flags.uninstall = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--stats") flags.stats = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-?") flags.help = true;
    else if (arg.startsWith("--port=")) flags.port = arg.slice("--port=".length);
    else if (arg.startsWith("--allowed-origin=")) flags.allowedOrigin = arg.slice("--allowed-origin=".length);
  }
  return flags;
}

const HELP_TEXT = `Codeenstein 3D multiplayer signaling + lobby server

Usage:
  node multiplayer-server.mjs                Start the server (default)
  node multiplayer-server.mjs --install       Install as a systemd service (needs root)
  node multiplayer-server.mjs --uninstall     Remove the systemd service (needs root)
  node multiplayer-server.mjs --stats         Query a running instance's monitoring stats
  node multiplayer-server.mjs --help | -?     Show this help

Flags:
  --dry-run                Combine with --install/--uninstall: print what would happen,
                            touch nothing (no root required).
  --port=<n>                Combine with --install: port baked into the generated unit's
                            CODEENSTEIN_MULTIPLAYER_PORT. Combine with --stats: which port
                            to query. Defaults to this invocation's own effective port
                            (currently ${PORT}, from CODEENSTEIN_MULTIPLAYER_PORT or its built-in default).
  --allowed-origin=<url>    Combine with --install: origin baked into the generated unit's
                            CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN.
  --json                    Combine with --stats: print raw JSON instead of a formatted
                            summary (for monitoring tools / piping into jq).

Environment variables (all optional, sane defaults otherwise; values below are this
invocation's currently-effective ones):
  CODEENSTEIN_MULTIPLAYER_PORT                          Listen port (currently ${PORT}).
  CODEENSTEIN_MULTIPLAYER_BIND_HOST                      Interface to bind (currently ${BIND_HOST}).
                                                          Keep 127.0.0.1 behind a same-host proxy;
                                                          containers need 0.0.0.0 plus
                                                          TRUSTED_PROXY_IPS below.
  CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS              Peers besides loopback whose
                                                          X-Forwarded-For is trusted; comma-separated
                                                          IPs and/or IPv4 CIDRs (currently
                                                          ${TRUSTED_PROXY_IPS.length} configured).
  CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN                 CORS origin (currently ${ALLOWED_ORIGIN}).
  CODEENSTEIN_MULTIPLAYER_SESSION_TTL_MS                 Session lifetime (currently ${SESSION_TTL_MS}).
  CODEENSTEIN_MULTIPLAYER_SWEEP_INTERVAL_MS              Expiry sweep interval (currently ${SWEEP_INTERVAL_MS}).
  CODEENSTEIN_MULTIPLAYER_MAX_CONCURRENT_SESSIONS        Hard session cap (currently ${MAX_CONCURRENT_SESSIONS}).
  CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_WINDOW_MS           Rate-limit window (currently ${RATE_LIMIT_WINDOW_MS}).
  CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_MAX_REQUESTS        Guess-sensitive budget (currently ${RATE_LIMIT_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_HOST_TOKEN_MAX_REQUESTS        Host-token-exempt budget (currently ${HOST_TOKEN_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_LOBBY_RATE_LIMIT_MAX_REQUESTS  GET /lobby budget (currently ${LOBBY_RATE_LIMIT_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_PUT_SESSION_RATE_LIMIT_MAX_REQUESTS  PUT /session budget (currently ${PUT_SESSION_RATE_LIMIT_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS  Per-code answer-attempt budget (currently ${ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_MAX_TRACKED_IPS_PER_LIMITER    Per-limiter distinct-key cap (currently ${MAX_TRACKED_IPS_PER_LIMITER}).
  CODEENSTEIN_MULTIPLAYER_BASE_COOLDOWN_MS               Backoff base (currently ${BASE_COOLDOWN_MS}).
  CODEENSTEIN_MULTIPLAYER_MAX_COOLDOWN_MS                Backoff cap (currently ${MAX_COOLDOWN_MS}).
  CODEENSTEIN_MULTIPLAYER_MAX_BODY_BYTES                 Request body cap (currently ${MAX_BODY_BYTES}).
  CODEENSTEIN_MULTIPLAYER_HEADERS_TIMEOUT_MS              HTTP headers timeout (currently ${HEADERS_TIMEOUT_MS}).
  CODEENSTEIN_MULTIPLAYER_REQUEST_TIMEOUT_MS              HTTP full-request timeout (currently ${REQUEST_TIMEOUT_MS}).
  CODEENSTEIN_MULTIPLAYER_STATS_TOKEN                    Enables GET /stats and --stats;
                                                          unset means the endpoint doesn't
                                                          exist (plain 404), by design.
  CODEENSTEIN_MULTIPLAYER_TURN_SECRET                    coturn static-auth-secret. With
                                                          TURN_URLS set, enables
                                                          GET /session/<code>/turn-credentials;
                                                          unset means the route 404s and clients
                                                          use STUN only (by design).
  CODEENSTEIN_MULTIPLAYER_TURN_URLS                     Comma-separated TURN URLs advertised to
                                                          clients (e.g. turns:host:443,turn:host:3478).
  CODEENSTEIN_MULTIPLAYER_TURN_TTL_SECONDS              Minted-credential lifetime (currently ${TURN_TTL_SECONDS}).
  CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_MAX_REQUESTS  Per-IP mint budget (currently ${TURN_CREDENTIALS_MAX_REQUESTS}).
  CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS  Per-code mint budget (currently ${TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS}).

Docs: doc/dev/multiplayer-server-spec.md, multiplayer-research.md ("Self-hosting").
`;

/** Pure function — the one piece of the install flow that's safe to exercise
 * in an automated verify script (no filesystem/systemctl side effects). */
function buildUnitFileContents({ scriptPath, port, allowedOrigin }) {
  return `[Unit]
Description=Codeenstein 3D multiplayer signaling + lobby server
After=network.target

[Service]
Type=simple
ExecStart=${scriptPath}
Restart=on-failure
RestartSec=5
Environment=CODEENSTEIN_MULTIPLAYER_PORT=${port}
Environment=CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN=${allowedOrigin}

[Install]
WantedBy=multi-user.target
`;
}

function runInstall({ dryRun, port, allowedOrigin }) {
  const scriptPath = fileURLToPath(import.meta.url);
  const unitContents = buildUnitFileContents({ scriptPath, port, allowedOrigin });
  const commands = [
    "systemctl daemon-reload",
    `systemctl enable --now ${SESSION_UNIT_NAME}`,
  ];

  console.log(`Unit file: ${SESSION_UNIT_PATH}\n`);
  console.log(unitContents);
  console.log("Commands that will run:");
  for (const cmd of commands) console.log(`  ${cmd}`);

  if (dryRun) {
    console.log("\n[dry run] nothing written, no commands executed.");
    return;
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("\n--install must be run as root (needs to write /etc/systemd/system and call systemctl).");
    process.exitCode = 1;
    return;
  }

  writeFileSync(SESSION_UNIT_PATH, unitContents, "utf8");
  execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["enable", "--now", SESSION_UNIT_NAME], { stdio: "inherit" });
  console.log("\nInstalled and started.");
}

function runUninstall({ dryRun }) {
  const commands = [
    `systemctl disable --now ${SESSION_UNIT_NAME}`,
    `rm ${SESSION_UNIT_PATH}`,
    "systemctl daemon-reload",
  ];

  console.log(`Unit file: ${SESSION_UNIT_PATH}\n`);
  console.log("Commands that will run:");
  for (const cmd of commands) console.log(`  ${cmd}`);

  if (dryRun) {
    console.log("\n[dry run] nothing removed, no commands executed.");
    return;
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("\n--uninstall must be run as root.");
    process.exitCode = 1;
    return;
  }

  try {
    execFileSync("systemctl", ["disable", "--now", SESSION_UNIT_NAME], { stdio: "inherit" });
  } catch (err) {
    console.warn(`Could not stop/disable ${SESSION_UNIT_NAME} (may not have been running):`, err.message);
  }
  if (existsSync(SESSION_UNIT_PATH)) rmSync(SESSION_UNIT_PATH, { force: true });
  execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  console.log("\nUninstalled.");
}

// ---------------------------------------------------------------------------
// --stats — queries an already-running instance's GET /stats
// ---------------------------------------------------------------------------

function formatStatsSummary(stats) {
  const lines = [
    `pid ${stats.pid}  node ${stats.nodeVersion}  uptime ${stats.uptimeSeconds}s`,
    "",
    "Sessions:",
    `  live               ${stats.sessions.live} / ${stats.sessions.maxConcurrent} max`,
    `  public (in lobby)  ${stats.sessions.public}`,
    `  awaiting answer    ${stats.sessions.awaitingAnswer}`,
    `  answered           ${stats.sessions.answered}`,
    `  created since start ${stats.sessions.totalCreatedSinceStart}`,
    "",
    "Rate limiting:",
    `  rejections since start  ${stats.rateLimiting.totalRejectionsSinceStart}`,
    `  tracked IPs   guess=${stats.rateLimiting.trackedIps.guess} hostToken=${stats.rateLimiting.trackedIps.hostToken} lobby=${stats.rateLimiting.trackedIps.lobby} putSession=${stats.rateLimiting.trackedIps.putSession}`,
    `  in cooldown   guess=${stats.rateLimiting.ipsCurrentlyInCooldown.guess} hostToken=${stats.rateLimiting.ipsCurrentlyInCooldown.hostToken} lobby=${stats.rateLimiting.ipsCurrentlyInCooldown.lobby} putSession=${stats.rateLimiting.ipsCurrentlyInCooldown.putSession}`,
  ];
  return lines.join("\n");
}

async function runStats({ port, json }) {
  const token = process.env.CODEENSTEIN_MULTIPLAYER_STATS_TOKEN;
  if (!token) {
    console.error(
      "--stats needs CODEENSTEIN_MULTIPLAYER_STATS_TOKEN set to the same value the running " +
        "server was started with (GET /stats is opt-in and disabled without it).",
    );
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${port}/stats`;
  let res;
  try {
    res = await fetch(url, { headers: { "X-Stats-Token": token }, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.error(`Could not reach ${url}: ${err.message}`);
    console.error("Is the server running, and on this port?");
    process.exitCode = 1;
    return;
  }

  if (res.status === 404) {
    console.error(
      "Got 404 from /stats — either no server is listening on that port, or the token didn't " +
        "match what the running instance was started with.",
    );
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(`Unexpected response from /stats: ${res.status}`);
    process.exitCode = 1;
    return;
  }

  const stats = await res.json();
  console.log(json ? JSON.stringify(stats, null, 2) : formatStatsSummary(stats));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Builds the `http.Server` with `HEADERS_TIMEOUT_MS`/`REQUEST_TIMEOUT_MS`
 * explicitly applied, but does **not** call `.listen()` — kept as its own
 * function (rather than inlined in `main()`) specifically so an automated
 * test can import this module, call this function directly, and assert the
 * timeout values actually landed on the real `http.Server` object, without
 * needing to spawn a child process or bind a real port. */
function createConfiguredServer() {
  const server = createServer(requestListener);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (flags.install) {
    return runInstall({
      dryRun: flags.dryRun,
      port: flags.port ?? String(PORT),
      allowedOrigin: flags.allowedOrigin ?? ALLOWED_ORIGIN,
    });
  }
  if (flags.uninstall) {
    return runUninstall({ dryRun: flags.dryRun });
  }
  if (flags.stats) {
    return runStats({ port: flags.port ?? String(PORT), json: flags.json });
  }

  serverStartedAt = Date.now();
  startSweeping();
  const server = createConfiguredServer();
  if (!isLoopbackAddress(BIND_HOST) && TRUSTED_PROXY_IPS.length === 0) {
    // Non-loopback bind with nothing trusted is *safe* but usually a
    // misconfiguration: every request then rate-limits by socket address, so a
    // proxy in front collapses all clients into one bucket. Say so loudly
    // instead of letting it look like the limiter is simply too strict.
    console.warn(
      `[multiplayer-server] bound to ${BIND_HOST} with no CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS —` +
        " X-Forwarded-For will be ignored and every client behind a proxy shares one rate-limit bucket.",
    );
  }
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[multiplayer-server] listening on ${BIND_HOST}:${PORT} (allowed origin: ${ALLOWED_ORIGIN})`);
  });
}

// Only actually run the server (or a CLI flag's action) when this file is
// invoked directly (`node multiplayer-server.mjs ...`) — not when it's
// merely `import`ed, e.g. by verify-multiplayer-server.mjs's in-process unit
// checks (see `createConfiguredServer`'s own comment). Every real invocation
// in this repo (spawned child processes, systemd's `ExecStart=`) already
// passes this file's own absolute path as the entry point, so this changes
// nothing about how the server is actually run.
const isMainModule =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  createConfiguredServer,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  // Pure helpers, exported for scripts/multiplayer-server.test.mjs: the env
  // vars they back are read once at module load, so the parsing/matching rules
  // can only be exercised directly.
  parseTrustedProxies,
  isTrustedProxy,
};
