// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { initTreeSitter } from "./runtime";

describe("initTreeSitter", () => {
  it("resolves once the core wasm loads under Node (via the ?url-as-path plugin)", async () => {
    await expect(initTreeSitter()).resolves.toBeUndefined();
  });

  it("memoizes the init promise across repeated calls", async () => {
    const first = initTreeSitter();
    const second = initTreeSitter();
    expect(second).toBe(first);
    await first;
  });
});
