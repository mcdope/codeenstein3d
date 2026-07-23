// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { onJsonMessage, sendJson, sendJsonSequence, sendJsonWithBackpressure } from "./dataChannelMessaging";
import { BACKPRESSURE_HIGH_WATERMARK_BYTES, BACKPRESSURE_LOW_THRESHOLD_BYTES, BUFFER_DRAIN_TIMEOUT_MS, MAX_INBOUND_MESSAGE_BYTES } from "./netcodeConstants";

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

  it("delivers a message with no `type` field at all — e.g. a real TickInput/TickInputBundle, which never carry one", () => {
    // Regression guard for the inbound-validation fix below: it would be an
    // easy mistake to require a `type` field unconditionally (every *other*
    // wire shape in this codebase — session-setup/reconciliation/level-
    // transition messages — does discriminate that way), but netcodeTypes.ts's
    // TickInput/TickInputBundle (the exact per-tick traffic this helper
    // exists for) never do, and are dispatched through this same function.
    const a = new FakeRTCDataChannel("a");
    const b = new FakeRTCDataChannel("b");
    a.link(b);

    const handler = vi.fn();
    onJsonMessage(b as unknown as RTCDataChannel, handler);
    sendJson(a as unknown as RTCDataChannel, { tick: 5, playerId: "host", input: { forward: true } });

    expect(handler).toHaveBeenCalledWith({ tick: 5, playerId: "host", input: { forward: true } });
  });

  it("does not throw and never invokes the handler for a non-JSON message payload", () => {
    const channel = new FakeRTCDataChannel("test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);

    expect(() => channel.dispatchEvent(new MessageEvent("message", { data: "not json at all {" }))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("never invokes the handler for valid JSON that isn't a plain object (array/string/number/null)", () => {
    const channel = new FakeRTCDataChannel("test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);

    for (const payload of [JSON.stringify([1, 2, 3]), JSON.stringify("hello"), JSON.stringify(42), JSON.stringify(null)]) {
      channel.dispatchEvent(new MessageEvent("message", { data: payload }));
    }

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(4);
    warnSpy.mockRestore();
  });

  it("never invokes the handler when `type` is present but not a string", () => {
    const channel = new FakeRTCDataChannel("test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);

    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: 42, value: "whatever" }) }));

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("still invokes the handler with the parsed object for a normal, validly-shaped message, unaffected by the new checks", () => {
    const channel = new FakeRTCDataChannel("test");
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);

    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "example", value: 42 }) }));

    expect(handler).toHaveBeenCalledWith({ type: "example", value: 42 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // --- Finding M4: bound the CPU a single peer message can force. ---

  it("discards an oversized message before parsing it", () => {
    const channel = new FakeRTCDataChannel("test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parseSpy = vi.spyOn(JSON, "parse");
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);

    // A payload one byte over the cap — must be dropped without ever hitting
    // JSON.parse (the whole point: no unbounded parse from one peer message).
    const oversized = "x".repeat(MAX_INBOUND_MESSAGE_BYTES + 1);
    channel.dispatchEvent(new MessageEvent("message", { data: oversized }));

    expect(handler).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    parseSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // --- Finding M4: an optional per-channel rate limiter, consulted before
  // parsing, for flood resistance on the host's input channel. ---

  it("drops messages before parsing once the rate limiter is exhausted", () => {
    const channel = new FakeRTCDataChannel("test");
    const parseSpy = vi.spyOn(JSON, "parse");
    const handler = vi.fn();
    // A limiter that allows exactly two messages, then blocks.
    let remaining = 2;
    const rateLimiter = { tryRemove: () => (remaining-- > 0) };
    onJsonMessage(channel as unknown as RTCDataChannel, handler, { rateLimiter });

    for (let i = 0; i < 5; i++) {
      channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ tick: i }) }));
    }

    // Only the first two passed; the rest were dropped before parsing.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    parseSpy.mockRestore();
  });

  it("without a rate limiter, delivers every message (unchanged default behavior)", () => {
    const channel = new FakeRTCDataChannel("test");
    const handler = vi.fn();
    onJsonMessage(channel as unknown as RTCDataChannel, handler);
    for (let i = 0; i < 5; i++) {
      channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ tick: i }) }));
    }
    expect(handler).toHaveBeenCalledTimes(5);
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
