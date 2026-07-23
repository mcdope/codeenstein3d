// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Real per-peer network-quality reads via `RTCPeerConnection.getStats()` —
 * step 11 Phase 2b (`doc/dev/multiplayer-balancing-telemetry-spec.md` §6).
 * Zero existing `getStats()` usage anywhere in `src/` before this — genuinely
 * new. Shared between `multiplayerSessionHost.ts` (one call per connected
 * guest's own link) and `multiplayerSessionGuest.ts` (its one link toward
 * the host) rather than duplicated: the read itself doesn't differ by role,
 * only which peer connection it's called against.
 *
 * `getStats()` can report several `"candidate-pair"` entries — every
 * abandoned ICE-negotiation attempt gets its own, alongside the pair
 * actually carrying traffic. `nominated`/`state === "succeeded"` are exactly
 * the fields the WebRTC stats spec defines for telling those apart
 * (https://www.w3.org/TR/webrtc-stats/#dom-rtcstatstype-candidate-pair) —
 * there is at most one such pair at a time.
 */

/** Round-trip time in milliseconds, from the active candidate pair's own
 * `currentRoundTripTime` — `null` if no succeeded/nominated pair is reported
 * yet (e.g. read immediately after connect, before the first STUN consent
 * round completes), the browser never populated the field, or the
 * underlying `getStats()` call itself failed (a connection that's already
 * closing/closed rejects it) — every case collapses to the same "not known
 * right now" value rather than a caller having to distinguish them. */
export interface ConnectionStats {
  rttMs: number | null;
}

/** Narrower than `RTCPeerConnection` — just the one member this module
 * needs, so it also accepts `ConnectionStateSource`
 * (`multiplayerSessionHost.ts`) without a cast; a real `RTCPeerConnection`
 * already structurally satisfies this. */
export interface StatsSource {
  getStats(): Promise<RTCStatsReport>;
}

export async function readConnectionStats(peerConnection: StatsSource): Promise<ConnectionStats> {
  try {
    const report = await peerConnection.getStats();
    for (const stat of report.values()) {
      if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
        return { rttMs: typeof stat.currentRoundTripTime === "number" ? stat.currentRoundTripTime * 1000 : null };
      }
    }
    return { rttMs: null };
  } catch {
    return { rttMs: null };
  }
}
