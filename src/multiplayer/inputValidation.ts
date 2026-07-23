// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Runtime shape-check for a wire-received `InputSnapshot`, in the same style
 * as `signalingClient.ts`'s `isSessionCreateResponse`/`isLobbyEntry` guards —
 * a peer's `TickInput.input` reaches `InputDelayBuffer.record()` straight off
 * `JSON.parse`, and `onJsonMessage()`'s own validation only checks the
 * envelope (object-ness, an optional `type` field) — it never inspects a
 * `TickInput`'s `input` sub-object, since `TickInput` carries no `type` field
 * at all. Without this, a malformed `input` (e.g. `{}`, missing `keys`) gets
 * accepted as real input, promoted into `InputDelayBuffer`'s held-fallback,
 * and later crashes `NetworkInputSource.isDown()` — a single guest's bad
 * packet can freeze every peer's simulation permanently. See `record()`'s own
 * doc comment: this is the boundary check that call site relies on.
 *
 * Every numeric field is *value*-checked, not merely typed — a peer controls
 * these completely, and `typeof x === "number"` accepts `NaN`/`Infinity`,
 * both of which are load-bearing attack vectors here, not theoretical:
 *  - A non-finite `mouseDX`/`gpForward`/`gpStrafe`/`gpTurn` reaches
 *    `player.rotate()`/`move()` on *every* peer (the host re-broadcasts the
 *    finalized bundle), where `Math.cos(NaN)`/`posX + NaN` poison the shared
 *    floating-point state irrecoverably — one packet corrupts the whole
 *    session. `Number.isFinite` rejects both `NaN` and `Infinity` (and, since
 *    it never coerces, also non-number types — so it subsumes the old
 *    `typeof` check).
 *  - `wheelSteps` drives an `abs(wheelSteps)`-iteration weapon-cycle loop in
 *    the engine; a non-integer/huge/non-finite value is a direct freeze. Held
 *    to a real integer within `MAX_WHEEL_STEPS_PER_TICK`.
 *  - An oversized `keys` array is a per-tick CPU + re-broadcast-bandwidth
 *    amplification vector (see `MAX_INPUT_KEYS`).
 */
import type { InputSnapshot } from "../engine/input";
import { MAX_INPUT_KEYS, MAX_WHEEL_STEPS_PER_TICK } from "./netcodeConstants";

export function isValidInputSnapshot(x: unknown): x is InputSnapshot {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    Array.isArray(s.keys) &&
    s.keys.length <= MAX_INPUT_KEYS &&
    s.keys.every((k) => typeof k === "string") &&
    Number.isFinite(s.mouseDX) &&
    typeof s.fireQueued === "boolean" &&
    typeof s.fireHeld === "boolean" &&
    (s.weaponRequest === null || (typeof s.weaponRequest === "number" && Number.isInteger(s.weaponRequest))) &&
    typeof s.mapToggle === "boolean" &&
    typeof s.interact === "boolean" &&
    typeof s.melee === "boolean" &&
    typeof s.meleeHeld === "boolean" &&
    Number.isInteger(s.wheelSteps) &&
    Math.abs(s.wheelSteps as number) <= MAX_WHEEL_STEPS_PER_TICK &&
    typeof s.fpsToggle === "boolean" &&
    typeof s.escape === "boolean" &&
    typeof s.blur === "boolean" &&
    typeof s.pointerUnlock === "boolean" &&
    typeof s.click === "boolean" &&
    Number.isFinite(s.gpForward) &&
    Number.isFinite(s.gpStrafe) &&
    Number.isFinite(s.gpTurn)
  );
}

/** A wire `tick` value is only trustworthy once it's confirmed to be a real,
 * finite integer — `InputDelayBuffer.record()`'s own `MAX_TICK_DRIFT_TICKS`
 * bound (see its doc comment) compares it via subtraction, and a non-numeric
 * value (a string, an object) makes that comparison evaluate to `NaN`, always
 * failing the `>` check and silently defeating the bound — the entry is then
 * buffered under a Map key `finalize()` can never match and sweep, leaking
 * one entry per malformed packet. */
export function isValidWireTick(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && Number.isInteger(x);
}
