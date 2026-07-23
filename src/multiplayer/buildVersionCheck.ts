// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The build-version handshake `doc/dev/multiplayer-netcode-spec.md`'s
 * "Session setup" section describes as the very first thing exchanged
 * between two peers, before any tick traffic: two peers on different cached
 * bundles run *different simulation code*, a desync source no amount of
 * reconciliation can paper over. Centralized as one pure comparison so both
 * the host's accept/reject decision and a guest's own reporting share one
 * implementation, rather than each peer duplicating the equality check.
 */
export interface BuildVersion {
  ref: string;
  time: string;
}

export function checkBuildVersionMatch(local: BuildVersion, remote: BuildVersion): boolean {
  return local.ref === remote.ref && local.time === remote.time;
}
