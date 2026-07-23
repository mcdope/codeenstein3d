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

export interface StopMessage {
  type: "stop";
}

const FIXED_DT_MS = FIXED_DT * 1000;

// Guards against a *second* clock ever running concurrently. A `start` message
// is not necessarily one-shot: a reconnect or a double-init can post it again
// on the same still-alive Worker. Without this guard each repeat would build a
// fresh `TickAccumulator` + `setInterval` while the previous one keeps firing,
// so two independent clocks would race and interleave `tick` messages —
// duplicated/out-of-order ticks are precisely the deterministic-lockstep
// corruption this module's header comment is built to avoid. `started` makes a
// redundant `start` a no-op; `intervalId` is retained so `stop()` can actually
// tear the running clock down (the id was previously discarded, leaving no way
// to ever clear the interval).
let started = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

function start(): void {
  if (started) return;
  started = true;
  const accumulator = new TickAccumulator(FIXED_DT_MS, performance.now());
  intervalId = setInterval(() => {
    for (const tick of accumulator.advance(performance.now())) {
      const message: TickDueMessage = { type: "tick", tick };
      self.postMessage(message);
    }
  }, FIXED_DT_MS);
}

// Clears the running interval and resets `started`, so a *legitimate* later
// restart (e.g. after a reconnect that first tears the old clock down) can
// spin a fresh clock up again from a clean slate.
function stop(): void {
  if (intervalId !== undefined) clearInterval(intervalId);
  intervalId = undefined;
  started = false;
}

self.addEventListener("message", (event: MessageEvent) => {
  // A message can in principle be `null` or a non-object primitive; reading
  // `.type` off such a value would throw and take the whole Worker down, so
  // ignore anything that isn't an object before inspecting its `type`.
  const message = event.data as StartMessage | StopMessage | null;
  if (typeof message !== "object" || message === null) return;
  if (message.type === "start") start();
  else if (message.type === "stop") stop();
});
