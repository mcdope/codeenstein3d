# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

# The signaling/lobby server is a single dependency-free file (node built-ins
# only — see doc/dev/multiplayer-server-spec.md §1), so this image is just a
# Node runtime plus that one script: no npm install, no node_modules, no build
# stage, nothing to go stale between the repo and the image.
FROM node:20-alpine

WORKDIR /app
COPY scripts/multiplayer-server.mjs ./multiplayer-server.mjs

# The `node` image ships an unprivileged `node` user (uid 1000); nothing here
# writes to disk, which is what lets docker-compose.yml mount the filesystem
# read-only.
USER node

# Informational only — docker-compose.yml is what actually publishes the port,
# and deliberately publishes it host-locally.
EXPOSE 8787

# `wget`/`curl` aren't in the alpine node image, and the runtime we already
# have speaks HTTP fine. GET /lobby is the cheapest route that proves routing,
# the session store and JSON serialization are all alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CODEENSTEIN_MULTIPLAYER_PORT||8787)+'/lobby').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/multiplayer-server.mjs"]
