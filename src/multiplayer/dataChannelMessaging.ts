// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { BACKPRESSURE_HIGH_WATERMARK_BYTES, BACKPRESSURE_LOW_THRESHOLD_BYTES, BUFFER_DRAIN_TIMEOUT_MS } from "./netcodeConstants";

/**
 * Small JSON-over-`RTCDataChannel` helper — no existing code in this project
 * sends or receives structured messages over a data channel yet (step 2's
 * connect flow only ever proves the channels reach `readyState: "open"`).
 * Factored out here, rather than inlined into the session-setup handshake
 * alone, because the per-tick lockstep traffic (`TickInput`/`TickInputBundle`
 * over the `input` channel) needs the exact same send/receive shape.
 *
 * Deliberately does no `readyState`/backpressure handling of its own — every
 * caller that sends more than a single small, fixed-cadence message (a
 * chunked transfer) must use `sendJsonWithBackpressure`/`sendJsonSequence`
 * below instead; a caller sending one small message at a low, fixed rate
 * (the per-tick input/reconciliation broadcasts) guards `readyState` inline
 * at the call site instead (see `multiplayerSessionHost.ts`/
 * `multiplayerSessionGuest.ts`), since backpressure genuinely can't build up
 * at that volume.
 */
export function sendJson(channel: RTCDataChannel, message: unknown): void {
  channel.send(JSON.stringify(message));
}

/**
 * Sends one JSON message, safely: rejects instead of throwing synchronously
 * if `channel.readyState` isn't `"open"`, and — the real bug this exists to
 * fix — waits for the channel's send buffer to drain before sending if it's
 * currently backed up past `BACKPRESSURE_HIGH_WATERMARK_BYTES`. Real
 * `RTCDataChannel.send()` has no built-in flow control: firing many
 * messages synchronously with nothing watching `bufferedAmount` can overflow
 * the channel's internal buffer and throw — confirmed directly as the real
 * cause of a reproducible CI failure (a chunked `GameMap` transfer's
 * `chunks.forEach(...)` firing every chunk in one synchronous burst).
 *
 * Any throw from `channel.send()` itself (a non-open channel, an overflowing
 * buffer, or any other transport failure) becomes a rejected `Promise`
 * automatically, by virtue of this being an `async` function — no explicit
 * try/catch needed for that part. A caller that doesn't await/catch this
 * (there are none left after this fix — see the call sites this was written
 * for) would previously have seen an uncaught exception escape a
 * synchronous message-event-handler callback instead, silently aborting the
 * rest of that handler.
 */
export async function sendJsonWithBackpressure(channel: RTCDataChannel, message: unknown): Promise<void> {
  if (channel.readyState !== "open") {
    throw new Error(`Cannot send on RTCDataChannel "${channel.label}": readyState is "${channel.readyState}", not "open"`);
  }
  if (channel.bufferedAmount > BACKPRESSURE_HIGH_WATERMARK_BYTES) {
    await waitForBufferedAmountLow(channel);
  }
  channel.send(JSON.stringify(message));
}

/** Sends every message in `messages`, in order, each via
 * `sendJsonWithBackpressure` — the shared shape both chunked-transfer call
 * sites (session setup's initial `GameMap`, a level transition's next one)
 * need: an init message, every chunk, then an end message, all backpressure-
 * aware and all stopping (rejecting) the instant any one of them fails,
 * rather than plowing ahead and leaving the receiver with a transfer it can
 * never actually complete. */
export async function sendJsonSequence(channel: RTCDataChannel, messages: readonly unknown[]): Promise<void> {
  for (const message of messages) await sendJsonWithBackpressure(channel, message);
}

/** Resolves once `channel`'s `bufferedAmount` has drained back down to
 * `BACKPRESSURE_LOW_THRESHOLD_BYTES` (signaled by the real
 * `"bufferedamountlow"` event, which only fires once `bufferedAmount` drops
 * at or below whatever `bufferedAmountLowThreshold` is currently set to —
 * set here, not assumed to already be configured), or rejects after
 * `BUFFER_DRAIN_TIMEOUT_MS` — a buffer that never drains that long means a
 * genuinely broken channel, not ordinary flow control; never wait forever
 * on something that might not happen, same discipline
 * `waitForChannelsOpen`/`TRANSITION_ACK_TIMEOUT_MS` already apply elsewhere
 * in this codebase. */
function waitForBufferedAmountLow(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_THRESHOLD_BYTES;
    const finish = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      clearTimeout(timer);
    };
    const onLow = () => {
      finish();
      resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow);
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`RTCDataChannel "${channel.label}" send buffer did not drain within ${BUFFER_DRAIN_TIMEOUT_MS}ms.`));
    }, BUFFER_DRAIN_TIMEOUT_MS);
  });
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
