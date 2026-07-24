# Docker stack for the multiplayer backend

Two containers: the **signaling/lobby server** (always on) and the **TURN
relay** (opt-in, behind a compose profile). This file covers the container
specifics; the deployment runbook it plugs into — DNS, TLS, firewall, client
build, end-to-end verification — is
[`doc/dev/multiplayer-deployment.md`](../doc/dev/multiplayer-deployment.md).

```
cp .env.example .env && $EDITOR .env       # at minimum: ALLOWED_ORIGIN
docker compose up -d --build               # signaling only
docker compose --profile turn up -d --build   # + TURN relay
```

Everything is built from this repo on the host — no registry, no published
image. `docker compose logs -f` for what happened; `docker compose down` to
stop.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | Both services, their hardening, and the pinned bridge subnet. |
| `.env.example` | Every knob, with the rationale for each. Copy to `.env` (gitignored — it holds the TURN secret). |
| `signaling/Dockerfile` | Node runtime + the one server script. No `npm install`: the server is built-ins only. |
| `coturn/turnserver.conf.base` | The static, placeholder-free coturn hardening — read this before changing relay behaviour. |
| `coturn/entrypoint.sh` | Appends deployment values (realm, secret, ports, certs) to the base config and execs `turnserver`. |

## Three things that are easy to get wrong

**1. The published port must stay `127.0.0.1`-bound.** The signaling server is
published as `127.0.0.1:8787:8787` and expects your existing host reverse proxy
to terminate TLS in front of it. Publishing it on `0.0.0.0` doesn't just expose
it — it makes `CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS` forgeable, because
that setting tells the server to believe `X-Forwarded-For` from the bridge
network. Host-local publication is what keeps "reaches the gateway" equivalent
to "is on this host".

**2. That trusted-proxy setting is not optional.** Behind a proxy the server
only ever sees one TCP peer, so it rate-limits by the forwarded client IP. In a
container the proxy is no longer on loopback, so without naming the bridge
subnet as trusted, *every player on the internet shares a single rate-limit
bucket* and the lobby starts 429-ing under trivial load. `SIGNALING_SUBNET`
feeds both the network definition and the trusted list so they can't drift.

**3. The relay needs to be able to read your TLS private key.** coturn runs as
uid 65534, and a Let's Encrypt `privkey.pem` is root-only by default — set
`TURN_CERT_GID` to a group that can read it (see `.env.example` for the
`chgrp`/`chmod` recipe). Mount `/etc/letsencrypt` itself, not
`live/<domain>`: that directory is symlinks into `../../archive`, which dangle
if only the leaf is mounted. A misconfigured cert path is a startup error by
design, never a silently plaintext relay.

## Notes on the hardening

Both services run unprivileged with a read-only root filesystem, all
capabilities dropped and `no-new-privileges`. Two deliberate exceptions:

- coturn keeps `NET_BIND_SERVICE`. Not a preference — its binary carries that
  as a *file* capability, and `execve()` fails with `EPERM` if it isn't in the
  bounding set, so a bare `cap_drop: [ALL]` container dies before reading any
  config. It also permits TURNS on 443.
- coturn uses `network_mode: host`. A relay allocates a wide UDP port range and
  must advertise addresses peers can reach; NATing that through docker-proxy is
  slow and lossy about source addresses. Its isolation therefore comes from
  `turnserver.conf.base`'s `denied-peer-ip` block — which denies loopback, all
  RFC1918 (including every docker bridge), link-local and ULA — not from the
  network namespace. That block is what stops a leaked credential relaying
  *into* other services on the host. Don't weaken it without reading
  [`multiplayer-server-spec.md` → TURN relay](../doc/dev/multiplayer-server-spec.md#turn-relay-coturn-optional-for-strict-nat-connectivity).

The shared secret is never passed on coturn's command line (a container's argv
is readable from the host) and never written to disk: `entrypoint.sh` renders
the config onto a tmpfs and redacts that line from the config it echoes at
startup.
