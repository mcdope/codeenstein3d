# Multiplayer server deployment

[← Back to dev docs](README.md)

A step-by-step runbook for standing up the multiplayer backend. There are up to
three pieces:

1. **Signaling/lobby server** (required) — the dependency-free Node script
   `scripts/multiplayer-server.mjs`. Introduces two browsers to each other; holds
   nothing else. Reference: [`multiplayer-server-spec.md`](multiplayer-server-spec.md).
2. **The client build** (required) — the static `dist/` bundle, built with the
   signaling server's URL baked in.
3. **TURN relay — coturn** (optional) — only needed so players behind strict
   NAT/CGNAT/UDP-blocking firewalls can connect. Skip it and everything still
   works for the common case; those players just can't connect.

This guide uses placeholder hostnames: `game.example.org` (where the game is
served), `mp.example.org` (the signaling server), `turn.example.org` (the relay).
Substitute your own.

## Prerequisites

- A VPS you control (the signaling server is the project's first non-static
  piece of infrastructure — see [`multiplayer-research.md`](../../multiplayer-research.md)'s
  "Self-hosting" section for why).
- **Node 20+** on the VPS for the signaling server.
- A reverse proxy that terminates TLS (nginx or Caddy). The game is served over
  HTTPS, and a browser blocks a plain-`http://` call from an HTTPS page as mixed
  content, so the signaling server **must** be reachable over TLS — the Node
  script itself stays plain HTTP on `localhost`, and the proxy is the only thing
  exposed.
- DNS records for the subdomains you use, and TLS certs (e.g. Let's Encrypt).
- `root` on the VPS for the systemd install and (if used) coturn.

---

## 1. Signaling server

**1.1 Copy the script to the VPS.** It's a single file, Node built-ins only — no
`npm install`:

```
scp scripts/multiplayer-server.mjs you@vps:/opt/codeenstein/multiplayer-server.mjs
```

**1.2 Install it as a systemd service.** The script writes its own unit
(`codeenstein-multiplayer.service`), baking in the port and the allowed CORS
origin (the exact origin the game is served from):

```
sudo node /opt/codeenstein/multiplayer-server.mjs --install \
  --port=8787 \
  --allowed-origin=https://game.example.org
```

The unit makes the process listen on `127.0.0.1:8787` (localhost only). Preview
what it would write first with `--dry-run`. See `--help` for every env var and
its effective value.

> **Secrets go in a drop-in, not the unit.** The generated unit deliberately
> bakes in only `PORT` and `ALLOWED_ORIGIN`. Anything sensitive
> (`CODEENSTEIN_MULTIPLAYER_STATS_TOKEN`, and the TURN vars in §3) is added out of
> band so it never lands in a world-readable unit file:
> ```
> sudo systemctl edit codeenstein-multiplayer.service
> # [Service]
> # Environment=CODEENSTEIN_MULTIPLAYER_STATS_TOKEN=…
> ```

**1.3 Put a TLS reverse proxy in front.** Terminate TLS on `mp.example.org` and
proxy to the localhost port. **nginx:**

```nginx
server {
    listen 443 ssl;
    server_name mp.example.org;
    ssl_certificate     /etc/letsencrypt/live/mp.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mp.example.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        # The server reads the *rightmost* X-Forwarded-For entry, and only trusts
        # it when the TCP peer is loopback (i.e. this proxy) — so rate limiting
        # keys on the real client IP. Use proxy_add_x_forwarded_for so a
        # client-forged header can't shift the rightmost entry.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**Caddy** (automatic Let's Encrypt) is a two-liner:

```
mp.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

**1.4 Verify.** From anywhere:

```
curl https://mp.example.org/lobby      # → {"sessions":[]}
```

An empty lobby JSON means the server is up, TLS works, and CORS is wired. If you
set a stats token: `curl -H "X-Stats-Token: <token>" https://mp.example.org/stats`.

---

## 2. Client build pointed at the signaling server

The client learns the server URL at **build time** (Vite `VITE_*`), so this is set
when you build `dist/`, not at runtime:

```
VITE_MULTIPLAYER_SERVER_URL=https://mp.example.org npm run build
```

- `VITE_MULTIPLAYER_SERVER_URL` (**required** for multiplayer) — the base URL from
  §1. Unset ⇒ Host/Join throws "Multiplayer is not configured".
- `VITE_MULTIPLAYER_STUN_URLS` (optional) — comma-separated STUN URLs; defaults to
  Google's public STUN.

Deploy the resulting `dist/` the same way you deploy the game today (the existing
static host / FTP pipeline). **Verify:** open the game, load a GitHub repo or the
Demos campaign, and confirm the **Multiplayer** tab enables and **Create Session**
returns a code.

At this point multiplayer is fully working for everyone whose network allows a
direct peer-to-peer path. If that's enough, stop here.

---

## 3. TURN relay (coturn) — optional, for strict-NAT connectivity

Only needed if players report the connection hanging on "Establishing
connection…" (symmetric NAT, CGNAT, UDP-blocking networks). Read the **security
model and mandatory hardening** in
[`multiplayer-server-spec.md` → "TURN relay (coturn)"](multiplayer-server-spec.md#turn-relay-coturn-optional-for-strict-nat-connectivity)
before exposing a relay — an unlocked relay is an open proxy and an SSRF pivot
into whatever the VPS can reach. This section is the concrete how-to for that
hardening.

**3.1 Install coturn:**

```
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

**3.2 Generate the shared secret** (the one value the signaling server and coturn
both hold — this is what ties minted credentials to the relay):

```
openssl rand -hex 32     # keep this; it becomes both values in §3.5 and §4
```

**3.3 Write `/etc/turnserver.conf`** — hardened per the spec:

```ini
realm=turn.example.org
server-name=turn.example.org

# Ephemeral credentials: coturn validates the HMAC the signaling server signs.
use-auth-secret
static-auth-secret=PASTE_THE_SECRET_FROM_3.2

# --- Isolation from this host (the load-bearing control) ---
# A leaked credential must never be able to relay INTO internal services/LAN.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# --- Quotas: bound bandwidth/abuse ---
user-quota=12
total-quota=1200
# max-bps=0            # optional per-session cap
stale-nonce
fingerprint

# --- Ports / TLS ---
listening-port=3478
tls-listening-port=5349
# Narrow relay range — open ONLY these in the firewall (3.4).
min-port=49160
max-port=49200
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
# no-tcp-relay        # uncomment if you only need UDP relay (smaller surface)

# --- Process hardening ---
proc-user=turnserver
proc-group=turnserver
no-cli
```

> **TLS on 443 vs 5349.** TURN-over-TLS on **443** is what traverses networks that
> block everything but HTTPS — but you can't bind 443 for TURN on the same IP your
> HTTPS reverse proxy already uses. Options: give coturn a **second IP** and set
> `tls-listening-port=443` on it, or accept `5349` (standard TURNS) knowing a few
> 443-only-egress networks won't get through. Advertise whatever you chose in §4.

**3.4 Firewall** — open only the relay ports:

```
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
```

**3.5 Start it:**

```
sudo systemctl enable --now coturn
```

**3.6 Verify coturn independently** (before wiring the app), using a credential
you compute by hand from the secret:

```
# username = a future unix timestamp; password = base64(HMAC-SHA1(secret, username))
u=$(( $(date +%s) + 3600 ))
p=$(printf '%s' "$u" | openssl dgst -sha1 -hmac "PASTE_SECRET" -binary | base64)
turnutils_uclient -T -u "$u" -w "$p" -p 5349 -e turn.example.org turn.example.org
```

A successful relay allocation confirms coturn + TLS + firewall are correct.

---

## 4. Wire the signaling server to coturn

Enable the `GET /session/<code>/turn-credentials` route by giving the signaling
server the **same secret** and the advertised URLs — via the systemd drop-in from
§1.2 (mode-`600`, never the baked unit):

```
sudo systemctl edit codeenstein-multiplayer.service
```
```ini
[Service]
Environment=CODEENSTEIN_MULTIPLAYER_TURN_SECRET=PASTE_THE_SAME_SECRET
Environment=CODEENSTEIN_MULTIPLAYER_TURN_URLS=turns:turn.example.org:5349,turn:turn.example.org:3478
# Environment=CODEENSTEIN_MULTIPLAYER_TURN_TTL_SECONDS=3600
```
```
sudo systemctl daemon-reload
sudo systemctl restart codeenstein-multiplayer.service
```

The client needs **no rebuild** for this — it fetches the relay config at connect
time. With the vars unset the route stays a `404` and clients are STUN-only, so
you can enable/disable the relay purely from the server side.

**Verify the route is live:** with no live session it should now answer
`session_not_found` (proving the feature is *on*) rather than the plain
`not_found` it gives when disabled:

```
curl -o /dev/null -w '%{http_code} %{json}\n' https://mp.example.org/session/ZZZZ/turn-credentials
# feature ON  → 404 {"error":"session_not_found"}
# feature OFF → 404 {"error":"not_found"}
```

---

## 5. End-to-end verification

1. Host a session from one browser, join from another.
2. Open `chrome://webrtc-internals` (or `about:webrtc` in Firefox) on the guest
   and confirm, in the ICE candidate list, a candidate of type **`relay`** when a
   direct path isn't available — that's the guest using the TURN relay.
3. The real test is two devices on networks that previously failed (e.g. a phone
   on cellular joining a host behind home CGNAT). In this project's star topology
   only the **guest** fetches relay credentials; the guest's relay candidate
   covers a host behind strict NAT too, so a working guest relay is sufficient.

## Troubleshooting

- **Mixed-content / connection refused to the signaling server** — it must be
  HTTPS (§1.3); a plain-HTTP URL from the HTTPS game is blocked by the browser.
- **CORS errors in the console** — `--allowed-origin` must be the game's exact
  origin (scheme + host, no trailing slash), matching where `dist/` is served.
- **One IP hits rate limits for everyone** — the proxy isn't passing
  `X-Forwarded-For`; without it every request looks like it comes from the proxy's
  loopback address. See §1.3.
- **Still can't connect with a relay configured** — check
  `curl …/session/<code>/turn-credentials` returns `200` for a *live* session;
  confirm coturn is reachable on the advertised port (443/5349) and the firewall
  opened the `min-port`–`max-port` UDP range; check the secret matches on both
  sides exactly.
- **Relay never used even though it works** — that's fine: TURN is only used when
  a direct path can't be formed. Force it for testing with
  `iceTransportPolicy: "relay"` in a throwaway local build.
