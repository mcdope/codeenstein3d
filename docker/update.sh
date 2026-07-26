#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)
#
# Updates an already-deployed docker/ install: git pull, rebuild/recreate
# the containers, preserving whether the TURN relay is in use. Encodes
# doc/dev/multiplayer-deployment.md §6.6 "Day-to-day"'s first line so the
# operator doesn't have to remember the profile flag or the pull nuance
# below.
#
# Run as the normal deploy user (not via sudo) — it shells out to `sudo`
# itself only for the docker compose calls; `git pull` running as root
# would leave the repo files root-owned.
set -euo pipefail

# The whole body is wrapped in main() and invoked as the very last line.
# This script lives inside the repo that `git pull` rewrites *while this
# process is running it* — bash reads a function's body into memory in
# full before executing any of it, so once main() starts, changes `git
# pull` makes to this file on disk can't corrupt the in-flight run. Without
# this, a pull that lands mid-script could have bash resume execution at
# the wrong byte offset of the new file.
main() {
  local script_dir repo_root
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"

  cd "$repo_root"

  if [ -n "$(git status --porcelain)" ]; then
    echo "==> Working tree has uncommitted changes — resolve these first:" >&2
    git status --short >&2
    exit 1
  fi

  local env_example="$repo_root/docker/.env.example"
  local old_hash
  old_hash="$(git hash-object "$env_example")"

  echo "==> git pull"
  git pull

  if [ "$(git hash-object "$env_example")" != "$old_hash" ]; then
    echo "==> docker/.env.example changed — check for new/changed variables" >&2
    echo "    and reconcile your docker/.env (see: git log -p -- docker/.env.example)" >&2
  fi

  cd "$repo_root/docker"

  # Whether the relay is deployed on this host is read from what's actually
  # running, not a flag the operator has to remember to pass — the relay's
  # container_name is fixed in docker-compose.yml regardless of profile.
  local profile_args=()
  if [ -n "$(docker ps -a --filter name='^codeenstein-coturn$' --format '{{.Names}}')" ]; then
    echo "==> TURN relay container detected — including --profile turn"
    profile_args=(--profile turn)
    # Only coturn has a real registry image (coturn/coturn:<tag>); signaling
    # is `image: codeenstein-multiplayer-signaling:local` with a build:
    # block and nothing to pull it from — a bare `docker compose pull`
    # would try and fail on that nonexistent tag, so pull coturn by name.
    echo "==> pulling coturn image"
    sudo docker compose "${profile_args[@]}" pull coturn
  fi

  echo "==> rebuilding and recreating containers"
  sudo docker compose "${profile_args[@]}" up -d --build

  echo "==> current status"
  sudo docker compose "${profile_args[@]}" ps
}

main "$@"
