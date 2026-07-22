# Multiplayer signaling + lobby server specification

**Status: specification only — no server script exists yet.** This document
specifies the one piece of backend `multiplayer-research.md` concluded was
genuinely unavoidable: a minimal WebRTC signaling mailbox, with the lobby feature
folded in since the same always-running process already makes it nearly free. It
does not modify anything under `src/` and does not itself contain the server
implementation — that's deliberately a separate, later step.

Cross-references: [`multiplayer-research.md`](../../multiplayer-research.md)'s
"Direct connect via a short code," "Lobby folds into the same service," and
"Self-hosting" sections made the governing decisions this spec implements exactly:
single dependency-free Node script, in-memory only, 6-character codes from a
32-symbol unambiguous alphabet, system-wide systemd unit on an existing VPS behind
a TLS-terminating reverse proxy, `localhost`-only binding.

## 1. Dependency-free, single-script requirement

**The entire server is one `.mjs` file, using only Node built-in modules — no
`npm install`, no `node_modules` at runtime.**

| Built-in | Used for |
|---|---|
| `node:http` | The whole HTTP server — `http.createServer((req, res) => ...)`, manual path/method routing (no framework: a `switch` on `` `${req.method} ${pathname}` ``-shaped matching is entirely sufficient for four routes). |
| `node:crypto` | `crypto.randomBytes()` for cryptographically-secure code and host-token generation (never `Math.random()` — predictable code generation would undermine the guess-resistance the code length itself is supposed to provide) and `crypto.randomUUID()` for host tokens. |
| `node:url` | Parsing `req.url` into pathname/segments (`new URL(req.url, "http://localhost")`) — no manual string-splitting edge cases. |

A `#!/usr/bin/env node` shebang plus `chmod +x` makes the file directly executable —
this is also what lets `--install`'s generated systemd unit point `ExecStart=`
straight at the script's own path (see `multiplayer-research.md`'s "Self-hosting"
section; `--install`/`--uninstall` themselves are out of scope for *this* document,
which only specifies the HTTP surface and storage/security mechanics).

**Deployment topology this spec assumes** (per the research doc): the process binds
`127.0.0.1` only; a reverse proxy (nginx/Caddy) on the same VPS terminates TLS on a
dedicated subdomain and is the only thing actually exposed to the internet. Two
things that follow directly from this and matter to the rest of this spec:

- **CORS.** The game itself is served from a *different* origin
  (`https://codeenstein3d.mcdope.org`) than the signaling subdomain, so every
  browser request here is cross-origin. The server must answer `OPTIONS` preflight
  requests and set `Access-Control-Allow-Origin` on every response — to a specific
  **configured** origin (an `ALLOWED_ORIGIN` constant/env var), not a wildcard `*`.
  A wildcard would let *any* website script against this service, not just the game
  itself; that's a strictly worse default for no benefit here.
- **Client IP extraction for rate-limiting (§4) must read `X-Forwarded-For`, not
  `req.socket.remoteAddress`.** Behind the proxy, `remoteAddress` is always the
  proxy's own loopback address for every request — rate-limiting by that would
  rate-limit "the proxy" as a single client, not real distinct requesters, which
  would silently defeat the entire mechanism. Trusting the proxy's `X-Forwarded-For`
  header is safe specifically *because* of the `localhost`-only bind above: nothing
  else can ever connect to this process directly, so there's no way for an external
  attacker to forge the header past the proxy.

## 2. Endpoints

Every session is identified by its 6-character code (from a 32-symbol unambiguous
alphabet — see §3 for the exact alphabet, and a correction to how
`multiplayer-research.md` originally described it, made during implementation).

A `code` alone lets anyone read the pending offer/answer for it — that's the whole
point of the mailbox — but it must **not** let anyone overwrite or hijack a session
they didn't create. `PUT /session` therefore returns a second, separate,
**high-entropy `hostToken`** (never shown to joiners) that every subsequent update
to that same session must present. This wasn't named in the original ask but falls
directly out of specifying `PUT /session` precisely: without it, the first person to
learn a code (which is *supposed* to be shareable) could also silently overwrite the
host's pending offer.

**One code = one in-flight offer/answer round at a time.** A lobby with more than
two players is supported by the host publishing a *fresh* offer under the *same*
code (a new `PUT /session` with `code`/`hostToken` set) once it's ready for its next
joiner — sequential, not concurrent, joining per code. This is a deliberate v1
simplification, not an oversight: WebRTC connections are inherently pairwise (each
guest needs its own `RTCPeerConnection` and thus its own offer/answer exchange with
the host), and a hobby-scale lobby has no real need for multiple *simultaneous*
strangers racing to join the exact same code within the same second.

### `PUT /session`

**Create** (no `code` in the body) or **update** (`code` + matching `hostToken`
present) the one session a host owns.

Request:
```jsonc
{
  "code": "R4KJ9X",       // omit to create a new session
  "hostToken": "…",       // required (and must match) when "code" is present
  "offer": "<SDP offer blob>",   // required, max 4096 bytes
  "public": false,               // default false
  "displayName": "Tobi's Demo Run", // optional, max 100 chars
  "playerCount": 1,              // integer, 1..16
  "campaignName": "demo-campaign" // required, max 100 chars
}
```

Response `201 Created` (new session) or `200 OK` (update):
```jsonc
{
  "code": "R4KJ9X",
  "hostToken": "5b7e6c0a-...-uuid", // only ever returned here, never on GET
  "expiresAt": 1737300000000
}
```

An update **clears any previously-stored `answer`** — publishing a new offer starts
a new handshake round, and a stale answer from the *previous* round must not be
handed to the *next* joiner.

Errors: `400` (missing/oversized `offer`, invalid `playerCount`, missing
`campaignName`, or a `displayName`/`campaignName` containing control
characters or zero-width/bidi-override codepoints — both are relayed
verbatim to other players' lobby UI via `GET /lobby`, so content is filtered
at intake, not just type/length), `403` (`code` present but `hostToken` doesn't match),
`404` (`code` present but no such live session — most likely already expired),
`429` (rate-limited, §4), `503` (`MAX_CONCURRENT_SESSIONS` reached, §3 — a cheap
backstop against unbounded session creation outrunning TTL cleanup).

### `GET /session/<code>`

Fetch the current mailbox contents for a code — used by a joiner (reads `offer`)
and polled by the host itself (reads `answer` once set; `null` until then). Both
hit the same endpoint; the one distinction that matters is rate-limiting: the
host's poll loop **must** send its `hostToken` in an `X-Host-Token` header, which
exempts it from the guess-sensitive rate budget (see §4's host exemption — without
this, the host's own polling would rate-limit it out of its own session). A
joiner sends no token and is subject to the normal budget.

Response `200 OK`:
```jsonc
{
  "code": "R4KJ9X",
  "offer": "<SDP offer blob>",
  "answer": null, // or "<SDP answer blob>" once a joiner has submitted one
  "campaignName": "demo-campaign",
  "displayName": "Tobi's Demo Run", // or null
  "playerCount": 1
}
```
`hostToken` is never included in this response under any circumstance.

Errors: `404` (no such live session), `429` (rate-limited, §4 — this is one of the
two *guess-sensitive* endpoints).

**Known v1 simplification, stated plainly rather than glossed over**: once an
answer is submitted, it's visible to *any* subsequent `GET` on that code, not just
the host's own poll — there's no per-caller auth distinguishing "the host" from
"some other request." Given the answer blob's contents (an ICE/DTLS handshake
fragment — the same category of data the offer already exposes to anyone with the
code by design) and that a new joiner has no real reason to be polling a code
that's already mid-handshake in normal use, this is judged an acceptable v1 gap, not
a silent one.

### `POST /session/<code>/answer`

Submit a joiner's SDP answer for the currently-pending offer.

Request:
```jsonc
{ "answer": "<SDP answer blob>" } // max 4096 bytes
```

Response `204 No Content` on success. This also refreshes the session's TTL (§3) —
a real join attempt in progress is exactly the kind of activity that should keep a
session alive.

Errors: `400` (missing/oversized `answer`), `404` (no such live session),
`409` (`{"error": "already_answered"}` — this round's slot is already claimed by an
earlier joiner; the caller should ask the host for a fresh code/offer rather than
retry), `429` (rate-limited, §4 — either the shared guess-sensitive budget or this
endpoint's own additional per-code budget, see §4's "Per-code answer-attempt limit"
subsection).

The `answer !== null` check above is only half the story: the claim on a session's
answer slot is taken *synchronously*, immediately after the session record is
looked up and before the request body is even read — see §4 for why the naive
"check `answer === null`, read the body, then set `answer`" ordering has a real
same-instant race between two concurrent requests for the same code.

### `GET /lobby`

List public sessions for a browsable lobby screen.

Response `200 OK`:
```jsonc
{
  "sessions": [
    { "code": "R4KJ9X", "displayName": "Tobi's Demo Run", "campaignName": "demo-campaign", "playerCount": 2 },
    { "code": "8MZQ2P", "displayName": null, "campaignName": "torvalds/linux", "playerCount": 1 }
  ]
}
```
Only non-expired sessions with `public: true` are included; `offer`/`answer`/
`hostToken` are never present here — a client that wants to actually join still
calls `GET /session/<code>` separately, keeping each endpoint's responsibility
singular (list vs. mailbox-read). Rate-limited too (§4), on a separate, more
generous budget than the guess-sensitive endpoints — this isn't a code-guessing
vector (it only ever reveals sessions their own hosts chose to publish), just needs
basic scrape/DoS protection like any public endpoint.

### `GET /stats`

An operator-only monitoring endpoint, added for ops visibility (session volume,
rate-limit pressure) without exposing anything player-identifying. **Entirely
opt-in**: unset the `CODEENSTEIN_MULTIPLAYER_STATS_TOKEN` env var and this route
doesn't exist as far as any caller can tell — a request to it gets the exact same
`404 not_found` as any unknown path, whether or not the caller supplied a token.
When configured, every request must carry a matching `X-Stats-Token` header; a
missing or wrong token gets the same indistinguishable `404` (never a `401`/`403`
that would confirm the feature exists to an unauthenticated prober). Not
IP/proxy-gated — see §1's `X-Forwarded-For` note for why network position alone
can't distinguish "the operator" from "a public request via the proxy" once behind
a reverse proxy; a shared secret is the one mechanism that works regardless of
network path.

Response `200 OK` — every value a plain number except `nodeVersion`, by design:
no session codes, hostTokens, IPs, offers, or answers anywhere in this payload:

```jsonc
{
  "pid": 12345,
  "nodeVersion": "v20.11.0",
  "uptimeSeconds": 3600,
  "sessions": {
    "live": 4,
    "public": 1,
    "awaitingAnswer": 2,
    "answered": 2,
    "maxConcurrent": 500,
    "totalCreatedSinceStart": 187
  },
  "rateLimiting": {
    "totalRejectionsSinceStart": 12,
    "trackedIps": { "guess": 3, "hostToken": 1, "lobby": 2, "putSession": 1 },
    "ipsCurrentlyInCooldown": { "guess": 1, "hostToken": 0, "lobby": 0, "putSession": 0 }
  }
}
```

`sessions.live`/`.public`/`.awaitingAnswer`/`.answered` are current snapshots (derived
from the live `sessions` Map at request time); `.totalCreatedSinceStart` and
`rateLimiting.totalRejectionsSinceStart` are cumulative, process-lifetime counters —
deliberately both kinds, since a snapshot alone can't answer "how much traffic has
this process actually seen." `trackedIps`/`ipsCurrentlyInCooldown` are per-rate-
limit-bucket *counts* (how many distinct IPs, not which ones) — enough to notice
"something is hammering the guess-sensitive budget right now" without the endpoint
ever holding, let alone returning, an actual IP address.

Not rate-limited itself (unlike every other endpoint): the token requirement is
already a stronger gate than any per-IP budget, and an operator querying their own
monitoring endpoint has no reason to be throttled against it.

Companion CLI mode: `node multiplayer-server.mjs --stats` (optionally
`--port=<n>`, `--json` for machine-readable output) queries a running instance's
`/stats` the same way, reading `CODEENSTEIN_MULTIPLAYER_STATS_TOKEN` from its own
environment — a client for this endpoint, not a separate mechanism. `--help`/`-?`
prints full usage, including every env var and its currently-effective value.

## 3. In-memory storage mechanics

### The session `Map`

```ts
interface SessionRecord {
  code: string;
  hostToken: string;
  offer: string;
  answer: string | null;
  createdAt: number;      // epoch ms
  lastActivityAt: number; // epoch ms — see TTL semantics below
  expiresAt: number;      // lastActivityAt + SESSION_TTL_MS
  public: boolean;
  displayName: string | null;
  playerCount: number;
  campaignName: string;
}

const sessions = new Map<string, SessionRecord>(); // the entire persistence layer
```

That single module-level `Map` **is** the storage layer — no database, no file
writes, nothing that survives a process restart (a deliberate choice already made
in `multiplayer-research.md`: state here is only ever meant to live minutes, so a
restart dropping in-flight handshakes is an acceptable trade against needing to
run/back up/migrate a real datastore for data this short-lived).

### Code generation

`SESSION_CODE_ALPHABET` — **corrected during implementation**: the research doc's
"uppercase letters and digits minus `0`, `O`, `1`, `I`, `L`" description is an
arithmetic slip, not a valid 32-symbol alphabet — 36 alphanumeric characters minus
those 5 specific ones leaves 31, not 32, which would have silently broken the "no
rejection sampling needed" property below (that property only holds for an
*exact* power-of-two alphabet size). Resolved by adopting
[Crockford's Base32](https://www.crockford.com/base32.html) alphabet verbatim —
`0123456789ABCDEFGHJKMNPQRSTVWXYZ` (10 digits + 22 letters, excluding only
`I`/`L`/`O`/`U`) — instead of inventing a different one-off 32-character set: it's
a real, proven standard designed for exactly this "short, human-typable,
unambiguous code" purpose, and it genuinely is 32 symbols. Since the alphabet is
exactly 32 symbols and `256 / 32 = 8` exactly, mapping random bytes onto it needs
no rejection sampling to avoid modulo bias — the low 5 bits of a uniformly-random
byte are themselves uniform over `[0, 32)`:

```js
function generateCode() {
  const bytes = crypto.randomBytes(6); // 6 chars needed
  let code = "";
  for (const b of bytes) code += SESSION_CODE_ALPHABET[b & 0x1f];
  return code;
}
```

On creation, generate a code and check `sessions.has(code)`; on the (astronomically
rare, per the research doc's own entropy analysis) collision, regenerate — this
makes codes *actually* unique, not just probabilistically so, at negligible cost
since it's one extra `Map` lookup in the vanishingly unlikely case it's ever needed.

`hostToken` generation: `crypto.randomUUID()` (122 bits) — deliberately far higher
entropy than the 30-bit join code. Guessing a `hostToken` would let an attacker
hijack an arbitrary *host's* session outright (strictly worse than guessing a join
code, which only lets someone join), so it gets no such length trade-off at all.

### TTL semantics

`SESSION_TTL_MS = 5 * 60 * 1000` (5 minutes — "a few minutes is plenty," per the
research doc; this only needs to bridge a handshake, not a whole play session).

**Sliding, but only on state-changing requests, not reads**: `lastActivityAt` (and
therefore `expiresAt = lastActivityAt + SESSION_TTL_MS`) is refreshed on `PUT
/session` (create or update) and on a successful `POST /session/<code>/answer` —
real signs the session is actively being used. It is **not** refreshed by `GET
/session/<code>` or `GET /lobby` — a joiner (or an idle browser tab) merely reading
a session's state should never be able to keep an abandoned session alive
indefinitely just by polling it.

### The sweep

A single `setInterval`, checked every `SWEEP_INTERVAL_MS = 30_000` (30s):

```js
setInterval(() => {
  const now = Date.now();
  for (const [code, record] of sessions) {
    if (now > record.expiresAt) sessions.delete(code);
  }
}, SWEEP_INTERVAL_MS);
```

Deleting the current key while iterating a `Map` is well-defined and safe in
JavaScript (it neither skips nor re-visits entries), so this needs no snapshot-then-
delete indirection. The interval is intentionally *not* `.unref()`'d — this is a
persistent daemon meant to keep running, not a short-lived script that should be
allowed to exit while the timer is pending.

**Defensive cap, independent of TTL**: `MAX_CONCURRENT_SESSIONS = 500`. `PUT
/session` creation (not update) checks `sessions.size` first and responds `503` if
at or over the cap. This isn't expected to ever actually trigger at any realistic
hobby-project scale — it exists purely as a hard backstop against a pathological
flood of session-creation requests outrunning the TTL sweep's reclaim rate, cheap
insurance rather than a tuned capacity limit.

## 4. Security: protecting the code space

The 6-character/~30-bit code (`multiplayer-research.md`'s own math: ~1.07 billion
combinations) was explicitly designed as *one half of a pair* with rate-limiting —
short enough to type, but only safely so alongside a real limit on how many guesses
an attacker can actually make during a code's short life. This section is that
other half.

### What's actually being protected against

Brute-force *guessing* — an attacker trying many different codes rapidly, hoping to
land on someone else's live session — not a legitimate holder of a valid code
reading its contents (that's the intended, designed behavior of a shareable code).
The two **guess-sensitive** endpoints are `GET /session/<code>` and `POST
/session/<code>/answer`, both of which let a caller learn "does this code currently
exist" from the response (200/204 vs. 404) — the exact signal a guessing attack
needs. `PUT /session` and `GET /lobby` aren't guessing vectors in this sense (see
their own endpoint sections above for their separate, lighter protections).

A **second, distinct threat** the per-IP guessing budget above does *not* cover:
griefing a code the attacker didn't have to guess at all, because `GET /lobby`
handed it out for free. Many different IPs, each individually well under the
per-IP guess budget, can still collectively flood one public session's answer
slot with garbage `POST /session/<code>/answer` calls, racing the real joiner for
that one-shot slot (see `already_answered`, above) — this is the "Per-code
answer-attempt limit" subsection below, added after an initial review round
correctly flagged that the original threat model here only ever considered
guessing, never lobby-derived griefing.

### Rate limiter design

A second in-memory `Map`, keyed by client IP (extracted via `X-Forwarded-For` per
§1's deployment note), tracking request activity against the guess-sensitive
endpoints only:

```ts
interface IpLimitState {
  windowStart: number;   // epoch ms
  windowCount: number;
  violationCount: number;
  cooldownUntil: number; // epoch ms; 0 if not in cooldown
}
const ipLimits = new Map<string, IpLimitState>();
```

- `RATE_LIMIT_WINDOW_MS = 60_000` (1 minute), `RATE_LIMIT_MAX_REQUESTS = 20` per IP
  per window, combined across both guess-sensitive endpoints. A normal join (fetch
  the offer, submit an answer, maybe one retry) is 2–3 requests — 20/minute is
  generous for real use and still a hard ceiling on a brute-force rate.
- **Host exemption — a flaw caught in review, not in the first pass**: the host
  itself *polls* `GET /session/<code>` waiting for a joiner's answer (see §2's
  endpoint flow). At any reasonable poll rate (once per 1–2s), the host burns
  through 20 requests within the first minute of waiting — while the friend is
  still typing the code — and then trips its own escalating backoff, locking the
  host out of its own session. Fix: a request to a guess-sensitive endpoint may
  carry the session's `hostToken` in an `X-Host-Token` header; if it matches the
  live session record for that code, the request **bypasses the guess-sensitive
  budget entirely** (it is, by definition, not a guess — presenting a valid
  122-bit token proves ownership more strongly than any rate limit could). Safe by
  construction: the token never appears in any response except the host's own
  `PUT /session` creation response, so only the host can present it. Two
  boundaries keep this from weakening anything else: a request with an *invalid*
  or non-matching token counts against the normal budget like any other request
  (a wrong token is itself guessing behavior, never a free pass), and
  token-bearing requests still fall under a separate, generous DoS backstop
  ceiling (e.g. 120/min per IP — far above any sane poll rate, purely so
  "valid token" can never mean "unlimited requests" to a buggy or hostile client
  that happens to hold one).
- **On exceeding the window's cap**: don't just reset next window — increment
  `violationCount` and set `cooldownUntil = now + BASE_COOLDOWN_MS * 2 ** violationCount`
  (`BASE_COOLDOWN_MS = 5_000`, capped at `MAX_COOLDOWN_MS = 60 * 60_000` — 1 hour).
  Every request from an IP currently under `cooldownUntil` is rejected `429`
  immediately, without even checking the window counter — classic exponential
  backoff, cheap to implement, and it means a repeat offender's *next* attempt
  costs them meaningfully more wait time than the last one, not a flat penalty.
- **Concrete effect, tied back to the research doc's own entropy math**: a single
  IP's realistic guess budget before backoff bites hard is on the order of the
  baseline 20/minute × a session's 5-minute TTL ≈ 100 guesses, then escalating
  lockout — several orders of magnitude below the "tens of thousands of guesses"
  scenario the research doc's own math already showed was safe against the ~1.07
  billion code space. This is deliberate defense-in-depth, not redundancy: the
  research doc was explicit that "rate-limiting and code length are a pair, not
  substitutes for each other," and this is that pairing made concrete.
- This limiter deliberately does **not** distinguish "many attempts against many
  different codes" from "a few retries against the same code" — it's a flat
  per-IP request count. That's an intentional simplification: legitimate retry
  behavior (a flaky connection, a typo'd code re-entered) is nowhere near the
  20/minute threshold, while an attacker needs to blow well past it to have any
  realistic chance at 1-in-a-billion odds, so the distinction isn't worth the
  added complexity of tracking per-(IP, code) pairs separately.
- **This tracking `Map` needs its own cleanup too**, or it grows for every IP that
  has ever made a request. Swept on the same interval as session TTL (§3): remove
  any entry whose `cooldownUntil` has passed *and* whose `windowStart` is older
  than `RATE_LIMIT_WINDOW_MS` — i.e., nothing about that IP is currently live.
- **Each of the five rate-limit maps (guess, host-token, lobby, PUT /session,
  the per-code answer limit below) also has a hard size cap**,
  `MAX_TRACKED_IPS_PER_LIMITER` (10,000 by default) — the
  sweep above only runs periodically, so without a cap a burst of requests from
  many distinct IPs (real or, prior to the loopback-gating fix above, spoofed via
  `X-Forwarded-For`) could grow a map unboundedly in between sweeps: a memory-
  exhaustion DoS. Once a map is at this cap, a genuinely new IP simply isn't
  allocated a tracking entry — its request is let through unmetered rather than
  evicting some other (possibly mid-cooldown) entry to make room, or refusing the
  request outright. This is a deliberate fail-*open* choice: a full map must never
  itself become a denial-of-service against every new legitimate caller. `GET
  /stats` (above) reports each map's live size under `rateLimiting.trackedIps`.
- **Not a timing-attack concern**: checking whether a guessed code exists is a
  `Map.get()` — a hash lookup, not a sequential/prefix string comparison — so
  there's no incremental "how many characters matched" signal to leak the way a
  naive character-by-character secret comparison could. Worth noting as
  considered-and-ruled-out rather than silently absent.

### `GET /lobby`'s separate, lighter limit

Not guess-sensitive (it only ever reveals sessions their hosts opted to publish),
so it gets its own, more permissive budget — e.g. `LOBBY_RATE_LIMIT_MAX_REQUESTS = 60`
per minute per IP, same window/backoff mechanics, just a higher ceiling, tracked
separately from the guess-sensitive counter so a legitimate lobby-browsing UI
polling every few seconds never competes with the much stricter join-flow budget.

### Per-code answer-attempt limit

A third `Map`, `answerAttemptsByCode`, using the exact same `checkRateLimit`
machinery as every other limiter above but keyed by **session code**, not IP:

```ts
const answerAttemptsByCode = new Map<string, IpLimitState>(); // same IpLimitState shape
```

`ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS = 10` per minute per code (lower than the
per-IP guess budget — a real joiner only ever needs to post once), checked on
`POST /session/<code>/answer` in addition to (not instead of) the per-IP guess
budget. This directly targets the griefing threat described above: many distinct
IPs each posting once can't be caught by any per-IP counter, but they all still
increment the *same* per-code counter, tripping it regardless of how the requests
are distributed across source IPs. Swept and size-capped identically to the other
four maps.

This closes only the *volume* half of the griefing threat. The other half — the
same-instant race between two concurrent requests for one code, both reading
`answer === null` before either sets it — is closed separately, in the handler
itself: the answer slot is claimed (`record.answerClaimed = true`) synchronously,
immediately after the session record is looked up and strictly before the request
body is ever read. Node's single-threaded event loop means only one concurrent
request's synchronous handler code can be executing at any instant, so whichever
request's claim-check runs first wins it outright — the second concurrently-racing
request's own claim-check (whenever its turn on the event loop comes) always sees
the first request's claim already in place. A request that claims the slot but then
fails body validation (`missing_answer`/`answer_too_large`/malformed JSON) releases
the claim before returning its error, so a griefer sending a malformed body can't
itself permanently lock out a real answer — only a request that actually sets
`record.answer` does that. The claim resets to `false` on a fresh re-offer
(`PUT /session` with an existing `code`/`hostToken`, §2) alongside `answer` itself,
since that starts a brand new handshake round.

### Payload size caps (defense against a different abuse shape)

Every request body is capped — checked incrementally as chunks arrive on
`req.on("data", ...)`, not only after fully buffering, so a slow-trickled oversized
body can't be used to hold memory open indefinitely. `MAX_BODY_BYTES = 8192` (8KB) —
generous headroom over the "several hundred bytes to a couple KB" real-world SDP
size the research doc estimated, while still refusing to let this mailbox become a
general-purpose paste bin. Exceeding the cap destroys the request stream and
responds `413 Payload Too Large` immediately, rather than continuing to read.

### HTTP server timeouts (defense against slow-connection abuse)

The underlying `http.Server` sets explicit, conservative timeouts rather than
relying on Node's own built-in defaults — `HEADERS_TIMEOUT_MS = 20_000` (how long a
connection may take to finish sending its request headers) and
`REQUEST_TIMEOUT_MS = 30_000` (how long the entire request — headers plus body —
may take). Every real request here is a small, capped JSON body from a
same-origin browser client or the trusted local proxy, so there's no legitimate
reason either should take anywhere near this long; explicit values close off the
mild Slowloris-style exposure of leaving both at Node's much longer defaults
(many slow/idle connections tying up memory/file descriptors for minutes).

## Testing & verification

`verify:multiplayer-server` (pure Node, no browser) spawns a real instance of
this script as a child process and drives its full endpoint surface directly —
every documented error case, all four rate-limit budgets and their independence
from each other, exponential backoff, TTL sliding/sweep semantics, and
`--install`/`--uninstall --dry-run` output. This is also the spec's own proof
that §2's "a lobby with more than two players is supported by the host
publishing a fresh offer under the same code" mechanism (`updateSession()`/
`PUT /session` with an existing `code`/`hostToken`) works as documented — the
client-side consumer of that mechanism (sequential guest-arming, once per open
slot up to a host-chosen `maxPlayers`) is exercised end-to-end by
`verify:multiplayer-multiguest` instead, since that requires real client-side
WebRTC connect flow this server-only script doesn't touch. See
`doc/dev/testing.md`'s "Cross-browser verification" section for the browser-side
scripts' shared caveats.
