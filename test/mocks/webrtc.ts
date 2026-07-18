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
  constructor(readonly label: string) {
    super();
  }
  simulateOpen(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
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
    return { type: "offer", sdp: `offer-sdp:${this.createdDataChannels.map((c) => c.label).join(",")}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    // No-op: nothing in this fake models `connectionState`/`iceConnectionState`
    // transitions after close, since nothing under test reads them.
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
