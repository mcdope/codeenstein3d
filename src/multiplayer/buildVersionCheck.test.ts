// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { checkBuildVersionMatch } from "./buildVersionCheck";

describe("checkBuildVersionMatch", () => {
  it("matches when ref and time are both identical", () => {
    expect(checkBuildVersionMatch({ ref: "abc123", time: "2026-07-19 12:00" }, { ref: "abc123", time: "2026-07-19 12:00" })).toBe(
      true,
    );
  });

  it("mismatches on a different ref alone", () => {
    expect(checkBuildVersionMatch({ ref: "abc123", time: "2026-07-19 12:00" }, { ref: "def456", time: "2026-07-19 12:00" })).toBe(
      false,
    );
  });

  it("mismatches on a different time alone", () => {
    expect(checkBuildVersionMatch({ ref: "abc123", time: "2026-07-19 12:00" }, { ref: "abc123", time: "2026-07-19 13:00" })).toBe(
      false,
    );
  });

  it("mismatches when both ref and time differ", () => {
    expect(checkBuildVersionMatch({ ref: "abc123", time: "2026-07-19 12:00" }, { ref: "def456", time: "2026-07-19 13:00" })).toBe(
      false,
    );
  });
});
