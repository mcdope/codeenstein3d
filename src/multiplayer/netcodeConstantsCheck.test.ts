// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { checkNetcodeConstantsMatch } from "./netcodeConstantsCheck";

describe("checkNetcodeConstantsMatch", () => {
  it("matches when tickRateHz/fixedDt/inputDelayTicks are all identical", () => {
    expect(
      checkNetcodeConstantsMatch({ tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }, { tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }),
    ).toBe(true);
  });

  it("mismatches on a different tickRateHz alone", () => {
    expect(
      checkNetcodeConstantsMatch({ tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }, { tickRateHz: 60, fixedDt: 1 / 30, inputDelayTicks: 3 }),
    ).toBe(false);
  });

  it("mismatches on a different fixedDt alone", () => {
    expect(
      checkNetcodeConstantsMatch({ tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }, { tickRateHz: 30, fixedDt: 1 / 60, inputDelayTicks: 3 }),
    ).toBe(false);
  });

  it("mismatches on a different inputDelayTicks alone", () => {
    expect(
      checkNetcodeConstantsMatch({ tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }, { tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 5 }),
    ).toBe(false);
  });

  it("mismatches when all three differ", () => {
    expect(
      checkNetcodeConstantsMatch({ tickRateHz: 30, fixedDt: 1 / 30, inputDelayTicks: 3 }, { tickRateHz: 60, fixedDt: 1 / 60, inputDelayTicks: 5 }),
    ).toBe(false);
  });
});
