// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { onJsonMessage, sendJson } from "./dataChannelMessaging";

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
