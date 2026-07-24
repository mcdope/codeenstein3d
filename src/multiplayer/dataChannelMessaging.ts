// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { BACKPRESSURE_HIGH_WATERMARK_BYTES, BACKPRESSURE_LOW_THRESHOLD_BYTES, BUFFER_DRAIN_TIMEOUT_MS, MAX_INBOUND_MESSAGE_BYTES } from "./netcodeConstants";

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
 * it completes and a later step (tick loop) takes over the channel.
 *
 * Validates before dispatch, rather than blindly casting whatever
 * `JSON.parse` produces: a malformed/non-JSON payload would otherwise throw
 * synchronously inside this `"message"` listener — an uncaught exception the
 * browser just swallows, with the message silently vanishing and no
 * diagnostic. Caught here instead: logged and skipped, `handler` never
 * invoked. A parsed-but-non-object payload (an array, string, number,
 * `null`, ...) is rejected the same way — no real message on any channel
 * this project uses is ever anything but a plain object.
 *
 * Deliberately does **not** require a `type` field, even though
 * `reconciliationTypes.ts`/`levelTransitionTypes.ts`/`sessionSetupTypes.ts`
 * all discriminate that way: `netcodeTypes.ts`'s `TickInput`/
 * `TickInputBundle` — the exact per-tick traffic this helper exists for (see
 * this module's own doc comment) — carry no `type` field at all, and both
 * are dispatched through this same generic function (see
 * `multiplayerSessionHost.ts`'s `onJsonMessage<TickInput>` and
 * `multiplayerSessionGuest.ts`'s `onJsonMessage<TickInputBundle>`). A `type`
 * field is only checked *if present*: a message that has one but where it
 * isn't a string is still a wrong-shaped payload worth rejecting, but a
 * message with no `type` field at all (every real `input`-channel message)
 * is not — requiring it unconditionally would silently drop all lockstep
 * input traffic.
 *
 * `options.rateLimiter`, when supplied, is consulted *before* the message is
 * even parsed — an over-rate message is dropped without spending a
 * `JSON.parse`. Used host-side on each guest's `input` channel to blunt a
 * message-flood DoS (see `multiplayerSessionHost.ts`); omitted on channels
 * carrying trusted, bursty traffic (the reconciliation/setup channels' chunked
 * map transfers, whose many rapid chunks are legitimate and must not be
 * throttled). Independently, every channel enforces `MAX_INBOUND_MESSAGE_BYTES`
 * on the raw payload before parsing, so no single peer message can force an
 * unbounded `JSON.parse`. */
export function onJsonMessage<T>(
  channel: RTCDataChannel,
  handler: (message: T) => void,
  options?: { rateLimiter?: { tryRemove(): boolean } },
): () => void {
  const listener = (event: MessageEvent): void => {
    if (options?.rateLimiter && !options.rateLimiter.tryRemove()) {
      // Rate-limited: dropped before parsing. Deliberately not logged per
      // message — a flood would itself flood the console; the drop is the
      // whole point.
      return;
    }
    if (typeof event.data === "string" && event.data.length > MAX_INBOUND_MESSAGE_BYTES) {
      console.warn(`[dataChannelMessaging] Discarding an oversized inbound "${channel.label}" message (${event.data.length} > ${MAX_INBOUND_MESSAGE_BYTES} bytes) before parsing.`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch (error) {
      console.warn(`[dataChannelMessaging] Discarding an inbound "${channel.label}" message that failed to parse as JSON:`, error);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[dataChannelMessaging] Discarding an inbound "${channel.label}" message that isn't a JSON object:`, parsed);
      return;
    }
    const type = (parsed as { type?: unknown }).type;
    if (type !== undefined && typeof type !== "string") {
      console.warn(`[dataChannelMessaging] Discarding an inbound "${channel.label}" message with a non-string "type" field:`, parsed);
      return;
    }
    handler(parsed as T);
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
