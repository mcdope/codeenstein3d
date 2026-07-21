// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * WebRTC connection mechanics for the client connect flow — see
 * `multiplayer-research.md`'s "Direct connect via a short code" section and
 * `doc/dev/multiplayer-netcode-spec.md`'s "Roles and terminology" section
 * (two data channels, `input`/`reconciliation`, both left at WebRTC's
 * default reliable/ordered config).
 *
 * Non-trickle ICE, deliberately: the signaling mailbox
 * (`scripts/multiplayer-server.mjs`) is a single offer/answer round-trip,
 * not a channel for incremental candidate exchange, so both sides wait for
 * `RTCPeerConnection.iceGatheringState` to reach `"complete"` before reading
 * `localDescription.sdp` — every discovered candidate ends up embedded in
 * that one SDP blob (a.k.a. "vanilla ICE").
 *
 * Data channels are created by the host **before** `createOffer()` — this
 * design has no renegotiation path, so a channel that doesn't exist at offer
 * time never will.
 */
import type { MultiplayerChannels } from "./types";

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

function resolveIceServers(): RTCIceServer[] {
  const configured = import.meta.env.VITE_MULTIPLAYER_STUN_URLS;
  const urls = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : DEFAULT_STUN_URLS;
  return [{ urls }];
}

/** Resolves once `pc`'s ICE gathering reaches `"complete"`, or after
 * `timeoutMs` — whichever comes first. A timeout is not treated as failure:
 * whatever local candidates were gathered so far are used as-is (mirrors how
 * production WebRTC libraries handle a STUN-unreachable network; a genuine
 * connection failure only surfaces later, from `waitForChannelsOpen`). */
export function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    // No "already settled" guard needed: `onChange` only calls `finish()`
    // once `iceGatheringState` reaches `"complete"`, a one-way transition
    // that real `RTCPeerConnection`s never revisit — and `finish()` itself
    // removes the listener and clears the timer as its first action, so
    // neither path can run twice. A stray extra `resolve()` call would be a
    // silent no-op anyway (`Promise` settles once), but the guarantee above
    // means it never happens.
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Resolves once every channel's `readyState` is `"open"`, or rejects after
 * `timeoutMs`. This is the actual "two browsers hold an open data channel"
 * success condition step 2 exists to prove. */
export function waitForChannelsOpen(channels: MultiplayerChannels, timeoutMs: number): Promise<void> {
  const entries = Object.values(channels);
  return new Promise((resolve, reject) => {
    // Declared before the initial `checkAllOpen()` call below (`let`, no
    // initializer, so no TDZ) since every channel can already be open by the
    // time this runs — `finish()` calling `clearTimeout(timer)` before
    // `timer` is assigned is fine (`clearTimeout(undefined)` is a no-op);
    // the real assignment below then holds a timer that, if it still fires
    // afterward, calls `reject()` on an already-resolved `Promise` — an
    // observable no-op, since a `Promise` only ever settles once.
    let timer: ReturnType<typeof setTimeout>;
    const cleanups: Array<() => void> = [];
    const cleanup = () => cleanups.forEach((fn) => fn());
    const finish = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const checkAllOpen = () => {
      if (entries.every((channel) => channel.readyState === "open")) finish();
    };
    for (const channel of entries) {
      const onOpen = () => checkAllOpen();
      channel.addEventListener("open", onOpen);
      cleanups.push(() => channel.removeEventListener("open", onOpen));
    }
    checkAllOpen();
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Data channels did not open within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

export interface HostOfferResult {
  peerConnection: RTCPeerConnection;
  channels: MultiplayerChannels;
  offerSdp: string;
}

/** Host side: creates the peer connection and both data channels, and
 * produces the offer SDP to publish via `signalingClient.createSession()`.
 * The returned channels are not yet open — call `waitForChannelsOpen()`
 * after the answer has been applied via `peerConnection.setRemoteDescription()`.
 *
 * Closes the peer connection and rethrows on any failure between
 * construction and return — otherwise a caller never receives a handle to
 * close (its own cleanup variable is only ever assigned from this function's
 * *return value*), leaking the connection. */
export async function createHostOffer(iceGatheringTimeoutMs: number): Promise<HostOfferResult> {
  const peerConnection = new RTCPeerConnection({ iceServers: resolveIceServers() });
  try {
    const channels: MultiplayerChannels = {
      input: peerConnection.createDataChannel("input"),
      reconciliation: peerConnection.createDataChannel("reconciliation"),
    };
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection, iceGatheringTimeoutMs);
    // `localDescription` is guaranteed non-null once `setLocalDescription()`
    // has resolved (WebRTC spec) — read from it rather than `offer` directly
    // since gathering may have appended candidates to it by now.
    const offerSdp = peerConnection.localDescription!.sdp;
    return { peerConnection, channels, offerSdp };
  } catch (err) {
    peerConnection.close();
    throw err;
  }
}

export interface GuestAnswerResult {
  peerConnection: RTCPeerConnection;
  /** Resolves once both of the host's data channels have arrived via
   * `ondatachannel` — which, in practice, only fires once the underlying
   * DTLS/SCTP transport is actually up. That means it cannot resolve until
   * *after* this answer has round-tripped back to the host and the host has
   * applied it (`peerConnection.setRemoteDescription()` there) — do not
   * `await` this before calling `signalingClient.postAnswer()`, or the
   * handshake this promise is waiting on can never complete. */
  channelsPromise: Promise<MultiplayerChannels>;
  answerSdp: string;
}

/** Guest side: applies the host's offer and produces the answer SDP to
 * submit via `signalingClient.postAnswer()`. Deliberately does **not** wait
 * for the data channels here — see `GuestAnswerResult.channelsPromise`'s doc
 * comment for why that would deadlock.
 *
 * Closes the peer connection and rethrows on any failure between
 * construction and return — same leak-prevention reasoning as
 * `createHostOffer`. `channelsPromise`'s own timer/listener is still armed at
 * that point (nothing has settled it) — its eventual timeout rejection is
 * explicitly swallowed here so it can't surface as an unhandled rejection
 * with no caller left to receive the thrown error from this function. */
export async function createGuestAnswer(
  offerSdp: string,
  iceGatheringTimeoutMs: number,
  channelsTimeoutMs: number,
): Promise<GuestAnswerResult> {
  const peerConnection = new RTCPeerConnection({ iceServers: resolveIceServers() });
  // Start listening before `setRemoteDescription` so no `datachannel` event
  // can be missed — but the promise itself only settles later, once the
  // caller has sent the answer back (see `channelsPromise`'s doc comment).
  const channelsPromise = captureDataChannels(peerConnection, channelsTimeoutMs);
  try {
    await peerConnection.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await waitForIceGatheringComplete(peerConnection, iceGatheringTimeoutMs);
    // Same "read back from localDescription, guaranteed non-null" reasoning as
    // `createHostOffer`'s `offerSdp`.
    const answerSdp = peerConnection.localDescription!.sdp;
    return { peerConnection, channelsPromise, answerSdp };
  } catch (err) {
    peerConnection.close();
    channelsPromise.catch(() => {
      // Nothing left to hand this to — swallow so its later timeout
      // rejection (the timer is still armed) can't become an unhandled
      // rejection with no caller ever having received `channelsPromise`.
    });
    throw err;
  }
}

/** Waits for both `ondatachannel` events (one per channel the host created,
 * labeled `"input"`/`"reconciliation"`) and returns them keyed by label, or
 * rejects after `timeoutMs` — these events only fire once the underlying
 * transport is actually connected, so an unreachable peer needs its own
 * bound here rather than relying on a later step's timeout to catch it. */
function captureDataChannels(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<MultiplayerChannels> {
  return new Promise((resolve, reject) => {
    const found: Partial<Record<"input" | "reconciliation", RTCDataChannel>> = {};
    const onDataChannel = (event: RTCDataChannelEvent) => {
      const label = event.channel.label;
      if (label !== "input" && label !== "reconciliation") return;
      found[label] = event.channel;
      if (found.input && found.reconciliation) {
        clearTimeout(timer);
        peerConnection.removeEventListener("datachannel", onDataChannel);
        resolve({ input: found.input, reconciliation: found.reconciliation });
      }
    };
    peerConnection.addEventListener("datachannel", onDataChannel);
    const timer = setTimeout(() => {
      peerConnection.removeEventListener("datachannel", onDataChannel);
      reject(new Error(`Data channels were not received within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}
