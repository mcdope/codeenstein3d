// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Web Worker entry point for the host's fixed-tick clock — the first Worker
 * in this project. A main-thread `setInterval`/`requestAnimationFrame`-driven
 * clock stops firing (or is throttled to ~1Hz) in a hidden/backgrounded tab;
 * a dedicated Worker's timers are not subject to that throttling, which is
 * the standard fix for exactly this problem in browser game/audio scheduling
 * (see `doc/dev/multiplayer-netcode-spec.md`'s "Tick pacing must survive
 * background tabs"). Deliberately thin glue around `TickAccumulator`, which
 * holds the actual scheduling logic and is unit-tested independently,
 * without needing a real Worker runtime.
 *
 * Message protocol: mostly worker -> main thread, one `TickDueMessage` per
 * due tick (possibly several in one turn if real time jumped, e.g. after the
 * main thread stalls). The one exception is the inbound `{type: "start"}`
 * message below — the `setInterval`/`TickAccumulator` construction that used
 * to run at module-eval time is instead gated behind receiving it. A
 * `Worker`'s message events are ordinary `EventTarget` dispatches: a message
 * delivered before any handler is attached is simply lost, so starting the
 * interval unconditionally at module load risked the very first tick(s)
 * firing (and being silently dropped) before `main.ts` had assigned its real
 * `worker.onmessage` handler — on a fast device with a warm module cache,
 * this could corrupt the session's tick count from the start. Waiting for an
 * explicit start message that `main.ts` only sends *after* `onmessage` is
 * assigned makes that race structurally impossible instead of just unlikely
 * — nothing can be missed before the interval itself even exists yet.
 */
import { FIXED_DT } from "./netcodeConstants";
import { TickAccumulator } from "./tickAccumulator";

export interface TickDueMessage {
  type: "tick";
  tick: number;
}

export interface StartMessage {
  type: "start";
}

const FIXED_DT_MS = FIXED_DT * 1000;

function start(): void {
  const accumulator = new TickAccumulator(FIXED_DT_MS, performance.now());
  setInterval(() => {
    for (const tick of accumulator.advance(performance.now())) {
      const message: TickDueMessage = { type: "tick", tick };
      self.postMessage(message);
    }
  }, FIXED_DT_MS);
}

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as StartMessage;
  if (message.type === "start") start();
});
