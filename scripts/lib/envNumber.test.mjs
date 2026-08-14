// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it } from "vitest";
import { envNumber } from "./envNumber.mjs";

const NAME = "CODEENSTEIN_TEST_KNOB";
/** Collects the message instead of exiting, so a bad value cannot take the
 * test runner down with it. */
const capture = () => {
  const seen = [];
  return {
    seen,
    onError: (m) => {
      seen.push(m);
      return NaN;
    },
  };
};

afterEach(() => {
  delete process.env[NAME];
});

describe("envNumber", () => {
  it("returns the fallback when unset or empty, without validating it", () => {
    const { seen, onError } = capture();
    expect(envNumber(NAME, 42, { onError })).toBe(42);
    process.env[NAME] = "";
    expect(envNumber(NAME, 42, { onError })).toBe(42);
    // Whitespace is an empty variable as far as a shell is concerned; treating
    // it as 0 (which `Number(" ")` would) is the silent-wrong-number class this
    // module exists to remove.
    process.env[NAME] = "   ";
    expect(envNumber(NAME, 42, { onError })).toBe(42);
    // `null` is how the "unset means no limit" knobs spell absence.
    delete process.env[NAME];
    expect(envNumber(NAME, null, { onError })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("parses a valid value, including forms a shell makes easy to produce", () => {
    const { onError } = capture();
    for (const [raw, want] of [
      ["60", 60],
      ["0", 0],
      ["-5", -5],
      ["1.5", 1.5],
      ["1e3", 1000],
      [" 60 ", 60],
    ]) {
      process.env[NAME] = raw;
      expect(envNumber(NAME, 1, { onError }), `${raw} should parse`).toBe(want);
    }
  });

  it("rejects the typo that motivated this — a letter that looks like a digit", () => {
    const { seen, onError } = capture();
    // `6o` is the o/0 slip, and `Number("6o")` is NaN. Before this, a capture
    // would run to completion with a NaN denominator and every rate NaN.
    process.env[NAME] = "6o";
    envNumber(NAME, 20, { onError });
    process.env[NAME] = "abc";
    envNumber(NAME, 20, { onError });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain(NAME);
    expect(seen[0]).toContain('"6o"');
  });

  it("rejects Infinity and NaN spelled out, which Number() accepts", () => {
    const { seen, onError } = capture();
    // `Number("Infinity")` is Infinity and `Number("NaN")` is NaN — both would
    // sail through a bare `Number.isNaN` check, so the guard is `isFinite`.
    for (const raw of ["Infinity", "-Infinity", "NaN"]) {
      process.env[NAME] = raw;
      envNumber(NAME, 1, { onError });
    }
    expect(seen).toHaveLength(3);
  });

  it("enforces integer, min and max when asked, and names the bound it broke", () => {
    const { seen, onError } = capture();
    process.env[NAME] = "1.5";
    envNumber(NAME, 1, { integer: true, onError });
    expect(seen.at(-1)).toContain("must be an integer");

    process.env[NAME] = "0";
    envNumber(NAME, 1, { min: 1, onError });
    expect(seen.at(-1)).toContain("must be >= 1");

    process.env[NAME] = "70000";
    envNumber(NAME, 1, { max: 65535, onError });
    expect(seen.at(-1)).toContain("must be <= 65535");

    // A value inside the bounds passes all three without complaint.
    process.env[NAME] = "8787";
    expect(envNumber(NAME, 1, { integer: true, min: 1, max: 65535, onError })).toBe(8787);
    expect(seen).toHaveLength(3);
  });

  it("validates an explicitly-set value even when it equals the fallback", () => {
    // Otherwise `X=abc` next to `fallback = NaN` would look fine, and more
    // practically: a caller must never be able to silence validation by
    // choosing a convenient default.
    const { seen, onError } = capture();
    process.env[NAME] = "not-a-number";
    envNumber(NAME, 20, { onError });
    expect(seen).toHaveLength(1);
  });
});
