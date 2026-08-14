// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Numeric environment knobs that fail loudly instead of becoming `NaN`.
 *
 * ## Why
 *
 * Every tuning knob in `scripts/` was read as a bare
 * `Number(process.env.X ?? default)`. `Number("abc")` is `NaN`, and `NaN`
 * propagates silently: `CODEENSTEIN_MULTIPLAYER_PORT=abc` does not fail, it
 * listens somewhere unpredictable; `CODEENSTEIN_CAPTURE_ATTEMPTS=6o` (letter o)
 * does not fail, it produces a capture whose denominator is `NaN` and whose
 * every rate is therefore `NaN` — discovered hours later, if at all. Two knobs
 * out of 53 validated: `CODEENSTEIN_TELEMETRY_SEED` and
 * `CODEENSTEIN_TELEMETRY_TUNING`, both of which guard a value whose corruption
 * would be *invisible*. That is exactly the argument for validating the rest.
 *
 * The server's `--help` says "all optional, sane defaults otherwise". True for
 * *unset*; it says nothing about *invalid*, and this closes that gap.
 *
 * ## The deliberate blast radius
 *
 * A deployment already running with a typo'd value starts failing at its next
 * restart rather than continuing with a silently wrong number. That is the
 * point, not a regression — but it is why this exits with a message naming the
 * variable and what it got, rather than throwing an anonymous stack.
 *
 * ## Not used by `scripts/multiplayer-server.mjs`
 *
 * That file is deliberately a **single dependency-free file** — `docker/
 * signaling/Dockerfile` copies it alone, with no `node_modules` and no build
 * step, and says so. It carries its own copy of this check. If you are here to
 * DRY that up: importing this module would break the deployed image at
 * runtime, so don't.
 */

/**
 * Read `name` as a number, or exit non-zero explaining why it could not.
 *
 * `fallback` is returned when the variable is unset or empty — including when
 * it is `null`, which is how the "unset means no limit" knobs spell their
 * absence. An explicitly-set value is always validated, even if it parses to
 * the same thing as the fallback.
 *
 * @param {string} name              e.g. "CODEENSTEIN_CAPTURE_ATTEMPTS"
 * @param {number|null} fallback     value when unset
 * @param {object} [opts]
 * @param {boolean} [opts.integer]   reject non-integers
 * @param {number} [opts.min]        inclusive lower bound
 * @param {number} [opts.max]        inclusive upper bound
 * @param {(msg: string) => never} [opts.onError]  injected for tests; defaults
 *   to printing and `process.exit(1)`. Tests must not take down the runner.
 */
export function envNumber(name, fallback, opts = {}) {
  const { integer = false, min, max, onError = defaultOnError } = opts;
  const raw = process.env[name];
  // Trimmed before the emptiness test, because `Number("")` and `Number("   ")`
  // are both **0**, not NaN — so a variable a shell left blank would otherwise
  // sail past every check below and silently mean zero. That is the same
  // silent-wrong-number class this module exists to remove, and it is the one
  // case a bare `Number()` gets wrong *without* producing a NaN to notice.
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return onError(`${name} must be a number, got: ${JSON.stringify(trimmed)}`);
  }
  if (integer && !Number.isInteger(value)) {
    return onError(`${name} must be an integer, got: ${JSON.stringify(trimmed)}`);
  }
  if (min !== undefined && value < min) {
    return onError(`${name} must be >= ${min}, got: ${value}`);
  }
  if (max !== undefined && value > max) {
    return onError(`${name} must be <= ${max}, got: ${value}`);
  }
  return value;
}

/** @returns {never} */
function defaultOnError(message) {
  // Same shape as the two knobs that already validated: name the variable and
  // the offending value, then exit non-zero. A warning would leave the run
  // going with a wrong number, which is the failure being fixed.
  console.error(message);
  process.exit(1);
  // Unreachable; `process.exit` does not return, but this keeps the function
  // honest for a caller that stubs `onError` and forgets to throw.
  throw new Error(message);
}
