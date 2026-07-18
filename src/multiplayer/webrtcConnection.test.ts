// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel, FakeRTCPeerConnection } from "../../test/mocks/webrtc";
import {
  createGuestAnswer,
  createHostOffer,
  waitForChannelsOpen,
  waitForIceGatheringComplete,
} from "./webrtcConnection";
import type { MultiplayerChannels } from "./types";

beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  FakeRTCPeerConnection.instances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("waitForIceGatheringComplete", () => {
  it("resolves immediately if gathering is already complete", async () => {
    const pc = new FakeRTCPeerConnection();
    pc.iceGatheringState = "complete";
    await expect(waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 1000)).resolves.toBeUndefined();
  });

  it("resolves once the icegatheringstatechange event reports complete", async () => {
    const pc = new FakeRTCPeerConnection();
    const promise = waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 5000);
    pc.simulateIceGatheringComplete();
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves after the bound even if gathering never completes (not treated as failure)", async () => {
    vi.useFakeTimers();
    const pc = new FakeRTCPeerConnection();
    const promise = waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 10_000);
    let resolved = false;
    void promise.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});

describe("waitForChannelsOpen", () => {
  function channels(): { channels: MultiplayerChannels; input: FakeRTCDataChannel; reconciliation: FakeRTCDataChannel } {
    const input = new FakeRTCDataChannel("input");
    const reconciliation = new FakeRTCDataChannel("reconciliation");
    return { channels: { input, reconciliation } as unknown as MultiplayerChannels, input, reconciliation };
  }

  it("resolves once every channel is already open", async () => {
    const { channels: c, input, reconciliation } = channels();
    input.simulateOpen();
    reconciliation.simulateOpen();
    await expect(waitForChannelsOpen(c, 1000)).resolves.toBeUndefined();
  });

  it("resolves only once BOTH channels report open, not just one", async () => {
    const { channels: c, input, reconciliation } = channels();
    const promise = waitForChannelsOpen(c, 5000);
    let resolved = false;
    void promise.then(() => (resolved = true));
    input.simulateOpen();
    await Promise.resolve();
    expect(resolved).toBe(false);
    reconciliation.simulateOpen();
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects after the timeout if channels never open", async () => {
    vi.useFakeTimers();
    const { channels: c } = channels();
    const promise = waitForChannelsOpen(c, 1000);
    const assertion = expect(promise).rejects.toThrow("did not open within 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("createHostOffer", () => {
  it("creates both channels before the offer and waits for ICE gathering", async () => {
    const promise = createHostOffer(5000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    expect(pc.createdDataChannels.map((c) => c.label)).toEqual(["input", "reconciliation"]);
    pc.simulateIceGatheringComplete();
    const result = await promise;
    expect(result.channels.input.label).toBe("input");
    expect(result.channels.reconciliation.label).toBe("reconciliation");
    expect(result.offerSdp).toContain("input,reconciliation");
  });

  it("uses the default public STUN server when VITE_MULTIPLAYER_STUN_URLS is unset", async () => {
    const promise = createHostOffer(5000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    pc.simulateIceGatheringComplete();
    await promise;
    expect(pc.config?.iceServers).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
  });

  it("uses configured STUN servers from VITE_MULTIPLAYER_STUN_URLS when set", async () => {
    vi.stubEnv("VITE_MULTIPLAYER_STUN_URLS", "stun:a.example.test:1234, stun:b.example.test:5678");
    const promise = createHostOffer(5000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    pc.simulateIceGatheringComplete();
    await promise;
    expect(pc.config?.iceServers).toEqual([{ urls: ["stun:a.example.test:1234", "stun:b.example.test:5678"] }]);
  });
});

describe("createGuestAnswer", () => {
  it("does not wait for data channels before resolving — only for the answer SDP", async () => {
    // Regression test: a guest's `ondatachannel` only fires once the
    // underlying transport is up, which requires the answer to have already
    // round-tripped back to the host — awaiting the channels here (before
    // returning `answerSdp` for the caller to submit) would deadlock. Found
    // by manually driving the real connect flow in two live browsers.
    const promise = createGuestAnswer("offer-sdp", 5000, 5000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    pc.simulateIceGatheringComplete();
    const result = await promise;
    expect(result.answerSdp).toBe("answer-sdp");
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "offer-sdp" });

    // channelsPromise is still pending — nothing has delivered channels yet.
    let channelsResolved = false;
    void result.channelsPromise.then(() => (channelsResolved = true));
    await Promise.resolve();
    expect(channelsResolved).toBe(false);

    const input = new FakeRTCDataChannel("input");
    const reconciliation = new FakeRTCDataChannel("reconciliation");
    pc.simulateIncomingDataChannel(input);
    pc.simulateIncomingDataChannel(reconciliation);
    await expect(result.channelsPromise).resolves.toEqual({ input, reconciliation });
  });

  it("rejects channelsPromise if the channels never arrive within the bound", async () => {
    vi.useFakeTimers();
    const promise = createGuestAnswer("offer-sdp", 5000, 1000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    pc.simulateIceGatheringComplete();
    const result = await promise;
    const assertion = expect(result.channelsPromise).rejects.toThrow("not received within 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("ignores a datachannel event with an unrecognized label", async () => {
    const promise = createGuestAnswer("offer-sdp", 5000, 5000);
    const pc = FakeRTCPeerConnection.instances.at(-1)!;
    pc.simulateIceGatheringComplete();
    const result = await promise;

    const bogus = new FakeRTCDataChannel("bogus");
    pc.simulateIncomingDataChannel(bogus);
    const input = new FakeRTCDataChannel("input");
    const reconciliation = new FakeRTCDataChannel("reconciliation");
    pc.simulateIncomingDataChannel(input);
    pc.simulateIncomingDataChannel(reconciliation);
    await expect(result.channelsPromise).resolves.toEqual({ input, reconciliation });
  });
});
