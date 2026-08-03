// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { clamp, clamp01 } from "./mathUtil";

describe("clamp", () => {
  it("returns the value unchanged when it is already inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to the lower bound", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamps to the upper bound", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("treats both bounds as inclusive", () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe("clamp01", () => {
  it("returns a value already inside [0, 1] unchanged", () => {
    expect(clamp01(0.42)).toBe(0.42);
  });

  it("clamps below 0 and above 1", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
  });

  it("treats both bounds as inclusive", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});
