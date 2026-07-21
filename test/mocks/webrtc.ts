// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Minimal `RTCPeerConnection`/`RTCDataChannel` test doubles — jsdom has
 * neither. Covers only the surface `src/multiplayer/webrtcConnection.ts`
 * actually touches: data channel creation/labels, offer/answer creation,
 * local/remote description assignment, ICE gathering state plus its change
 * event, and data channel `readyState` plus its `open` event. Built on the
 * real `EventTarget` (jsdom provides one) rather than hand-rolled listener
 * bookkeeping, so `addEventListener`/`removeEventListener`/dispatch
 * semantics are genuine.
 *
 * Deliberately does **not** fire `datachannel` automatically from
 * `setRemoteDescription` — a real browser only fires it once the underlying
 * transport is actually connected (confirmed by manually driving the real
 * connect flow in two live browsers while building this feature: awaiting
 * that event before the answer had even been sent back to the host was a
 * genuine deadlock). Call `simulateIncomingDataChannel()` explicitly instead
 * — see `webrtcConnection.ts`'s `GuestAnswerResult.channelsPromise` doc
 * comment for the ordering this is standing in for.
 */

export class FakeRTCDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  /** Plain fields, matching the real `RTCDataChannel` API shape
   * `dataChannelMessaging.ts`'s backpressure helpers read/write — tests
   * drive `"bufferedamountlow"` by dispatching the real event directly
   * (this class already extends a real `EventTarget`), no extra simulate*
   * method needed. */
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private linkedPeer: FakeRTCDataChannel | null = null;
  constructor(readonly label: string) {
    super();
  }
  simulateOpen(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  /** Test-only: pairs this channel with the one on "the other side" of a
   * simulated connection, so `send()` on either dispatches a `"message"`
   * event on the other. Bidirectional — one `link()` call wires both
   * directions. */
  link(other: FakeRTCDataChannel): void {
    this.linkedPeer = other;
    other.linkedPeer = this;
  }

  /** Synchronous dispatch, deliberately — real `RTCDataChannel` delivery is
   * asynchronous, but this mock's whole point is deterministic unit tests;
   * genuine async-ordering bugs are a Playwright verify script's job to
   * catch, not this mock's (see this module's own doc comment for the same
   * division of labor already established for `datachannel`/ICE events). */
  send(data: string): void {
    this.linkedPeer?.dispatchEvent(new MessageEvent("message", { data }));
  }
}

class FakeRTCDataChannelEvent extends Event {
  constructor(readonly channel: FakeRTCDataChannel) {
    super("datachannel");
  }
}

export class FakeRTCPeerConnection extends EventTarget {
  /** Every instance ever constructed, in creation order — tests read
   * `.at(-1)` right after calling the function under test (its `new
   * RTCPeerConnection()` runs synchronously before any `await`), since
   * there's no other way to get a handle to an instance created deep inside
   * `webrtcConnection.ts`. */
  static instances: FakeRTCPeerConnection[] = [];

  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly createdDataChannels: FakeRTCDataChannel[] = [];
  /** Test-only: how many times `close()` was called — regression coverage
   * for "does the caller close a partially-set-up connection on failure"
   * (see `webrtcConnection.test.ts`'s "closes the peer connection" tests)
   * reads this rather than adding a whole `connectionState` model nothing
   * else under test needs. */
  closeCallCount = 0;

  /** Test-only rejection-injection hooks — set any of these to an `Error`
   * before calling the function under test to make that specific awaited
   * method reject instead of resolving, without touching any other method.
   * Unset (`undefined`, the default) means "resolve as normal" — existing
   * tests that never touch these are completely unaffected. */
  createOfferError?: Error;
  createAnswerError?: Error;
  setLocalDescriptionError?: Error;
  setRemoteDescriptionError?: Error;

  constructor(readonly config?: RTCConfiguration) {
    super();
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeRTCDataChannel {
    const channel = new FakeRTCDataChannel(label);
    this.createdDataChannels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.createOfferError) throw this.createOfferError;
    return { type: "offer", sdp: `offer-sdp:${this.createdDataChannels.map((c) => c.label).join(",")}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.createAnswerError) throw this.createAnswerError;
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.setLocalDescriptionError) throw this.setLocalDescriptionError;
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.setRemoteDescriptionError) throw this.setRemoteDescriptionError;
    this.remoteDescription = description;
  }

  close(): void {
    // Nothing in this fake models `connectionState`/`iceConnectionState`
    // transitions after close, since nothing under test reads them — but
    // whether `close()` was ever called at all is itself load-bearing (see
    // `closeCallCount`'s doc comment above).
    this.closeCallCount++;
  }

  /** Test-only: flips `iceGatheringState` to `"complete"` and dispatches the
   * change event `waitForIceGatheringComplete` listens for. */
  simulateIceGatheringComplete(): void {
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  /** Test-only: simulates the host's `ondatachannel` delivering one of the
   * channels the host side created — see this module's doc comment for why
   * this is never automatic. */
  simulateIncomingDataChannel(channel: FakeRTCDataChannel): void {
    this.dispatchEvent(new FakeRTCDataChannelEvent(channel) as unknown as Event);
  }
}
