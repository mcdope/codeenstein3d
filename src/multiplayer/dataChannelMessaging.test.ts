// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { onJsonMessage, sendJson, sendJsonSequence, sendJsonWithBackpressure } from "./dataChannelMessaging";
import { BACKPRESSURE_HIGH_WATERMARK_BYTES, BACKPRESSURE_LOW_THRESHOLD_BYTES, BUFFER_DRAIN_TIMEOUT_MS } from "./netcodeConstants";

describe("sendJson", () => {
  it("writes JSON.stringify(message) to the channel", () => {
    const channel = new FakeRTCDataChannel("test");
    const sendSpy = vi.spyOn(channel, "send");
    sendJson(channel as unknown as RTCDataChannel, { type: "example", value: 42 });
    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ type: "example", value: 42 }));
  });
});

describe("onJsonMessage", () => {
  it("parses incoming JSON and invokes the handler", () => {
    const a = new FakeRTCDataChannel("a");
    const b = new FakeRTCDataChannel("b");
    a.link(b);

    const handler = vi.fn();
    onJsonMessage(b as unknown as RTCDataChannel, handler);
    sendJson(a as unknown as RTCDataChannel, { type: "example", value: 42 });

    expect(handler).toHaveBeenCalledWith({ type: "example", value: 42 });
  });

  it("returns an unsubscribe function that stops delivering further messages", () => {
    const a = new FakeRTCDataChannel("a");
    const b = new FakeRTCDataChannel("b");
    a.link(b);

    const handler = vi.fn();
    const unsubscribe = onJsonMessage(b as unknown as RTCDataChannel, handler);
    sendJson(a as unknown as RTCDataChannel, { first: true });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    sendJson(a as unknown as RTCDataChannel, { second: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("sendJsonWithBackpressure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends immediately when the channel is open and under the high watermark", async () => {
    const channel = new FakeRTCDataChannel("test");
    channel.simulateOpen();
    const sendSpy = vi.spyOn(channel, "send");
    await sendJsonWithBackpressure(channel as unknown as RTCDataChannel, { value: 1 });
    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ value: 1 }));
  });

  it("rejects without ever calling send() when the channel isn't open", async () => {
    const channel = new FakeRTCDataChannel("test"); // never simulateOpen() — stays "connecting"
    const sendSpy = vi.spyOn(channel, "send");
    await expect(sendJsonWithBackpressure(channel as unknown as RTCDataChannel, { value: 1 })).rejects.toThrow(/readyState is "connecting"/);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("waits for bufferedamountlow before sending once over the high watermark, and sets bufferedAmountLowThreshold", async () => {
    const channel = new FakeRTCDataChannel("test");
    channel.simulateOpen();
    channel.bufferedAmount = BACKPRESSURE_HIGH_WATERMARK_BYTES + 1;
    const sendSpy = vi.spyOn(channel, "send");

    const promise = sendJsonWithBackpressure(channel as unknown as RTCDataChannel, { value: 1 });
    await Promise.resolve(); // let the pending-promise microtask settle before asserting the "not yet sent" state
    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.bufferedAmountLowThreshold).toBe(BACKPRESSURE_LOW_THRESHOLD_BYTES);

    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await promise;
    expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ value: 1 }));
  });

  it("rejects if the buffer never drains within BUFFER_DRAIN_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const channel = new FakeRTCDataChannel("test");
    channel.simulateOpen();
    channel.bufferedAmount = BACKPRESSURE_HIGH_WATERMARK_BYTES + 1;

    const promise = sendJsonWithBackpressure(channel as unknown as RTCDataChannel, { value: 1 });
    const assertion = expect(promise).rejects.toThrow(/did not drain within/);
    await vi.advanceTimersByTimeAsync(BUFFER_DRAIN_TIMEOUT_MS);
    await assertion;
  });
});

describe("sendJsonSequence", () => {
  it("sends every message in order", async () => {
    const channel = new FakeRTCDataChannel("test");
    channel.simulateOpen();
    const sendSpy = vi.spyOn(channel, "send");
    await sendJsonSequence(channel as unknown as RTCDataChannel, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(sendSpy.mock.calls.map((call) => JSON.parse(call[0] as string))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("stops at the first failure and never sends the remaining messages", async () => {
    const channel = new FakeRTCDataChannel("test"); // never opened
    const sendSpy = vi.spyOn(channel, "send");
    await expect(sendJsonSequence(channel as unknown as RTCDataChannel, [{ n: 1 }, { n: 2 }])).rejects.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
