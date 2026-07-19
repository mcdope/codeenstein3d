// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Small JSON-over-`RTCDataChannel` helper — no existing code in this project
 * sends or receives structured messages over a data channel yet (step 2's
 * connect flow only ever proves the channels reach `readyState: "open"`).
 * Factored out here, rather than inlined into the session-setup handshake
 * alone, because the per-tick lockstep traffic (`TickInput`/`TickInputBundle`
 * over the `input` channel) needs the exact same send/receive shape.
 */
export function sendJson(channel: RTCDataChannel, message: unknown): void {
  channel.send(JSON.stringify(message));
}

/** Subscribes to every JSON message arriving on `channel`, parsed and cast to
 * `T` (callers own the discriminated-union narrowing from there — this
 * helper is deliberately type-blind about message shape). Returns an
 * unsubscribe function, since a session-setup handshake stops listening once
 * it completes and a later step (tick loop) takes over the channel. */
export function onJsonMessage<T>(channel: RTCDataChannel, handler: (message: T) => void): () => void {
  const listener = (event: MessageEvent): void => handler(JSON.parse(event.data as string) as T);
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
