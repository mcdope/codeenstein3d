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
 * Message protocol: worker -> main thread only, one `TickDueMessage` per due
 * tick (possibly several in one turn if real time jumped, e.g. after the
 * main thread stalls). Nothing ever flows main -> worker after construction
 * — the tick rate is a fixed, bundled-in constant (`FIXED_DT`), not
 * something a caller configures per instance.
 */
import { FIXED_DT } from "./netcodeConstants";
import { TickAccumulator } from "./tickAccumulator";

export interface TickDueMessage {
  type: "tick";
  tick: number;
}

const FIXED_DT_MS = FIXED_DT * 1000;
const accumulator = new TickAccumulator(FIXED_DT_MS, performance.now());

setInterval(() => {
  for (const tick of accumulator.advance(performance.now())) {
    const message: TickDueMessage = { type: "tick", tick };
    self.postMessage(message);
  }
}, FIXED_DT_MS);
