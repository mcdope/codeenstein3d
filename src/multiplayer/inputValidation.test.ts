// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { isValidInputSnapshot, isValidWireTick } from "./inputValidation";
import { MAX_INPUT_KEYS, MAX_WHEEL_STEPS_PER_TICK } from "./netcodeConstants";
import type { InputSnapshot } from "../engine/input";

const VALID_SNAPSHOT: InputSnapshot = {
  keys: ["KeyW", "KeyA"],
  mouseDX: 0,
  fireQueued: false,
  fireHeld: false,
  weaponRequest: null,
  mapToggle: false,
  interact: false,
  melee: false,
  meleeHeld: false,
  wheelSteps: 0,
  fpsToggle: false,
  escape: false,
  blur: false,
  pointerUnlock: false,
  click: false,
  gpForward: 0,
  gpStrafe: 0,
  gpTurn: 0,
};

describe("isValidInputSnapshot", () => {
  it("accepts a fully-shaped snapshot", () => {
    expect(isValidInputSnapshot(VALID_SNAPSHOT)).toBe(true);
  });

  it("accepts weaponRequest as a number", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, weaponRequest: 2 })).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isValidInputSnapshot(null)).toBe(false);
    expect(isValidInputSnapshot(undefined)).toBe(false);
    expect(isValidInputSnapshot("not an object")).toBe(false);
    expect(isValidInputSnapshot(42)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(isValidInputSnapshot({})).toBe(false);
  });

  it("rejects a non-array keys field", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, keys: "KeyW" })).toBe(false);
  });

  it("rejects a keys array containing a non-string element", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, keys: ["KeyW", 42] })).toBe(false);
  });

  it("rejects a non-number mouseDX", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mouseDX: "0" })).toBe(false);
  });

  it("rejects a non-boolean fireQueued", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, fireQueued: 1 })).toBe(false);
  });

  it("rejects a non-boolean fireHeld", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, fireHeld: 1 })).toBe(false);
  });

  it("rejects a weaponRequest that is neither null nor a number", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, weaponRequest: "1" })).toBe(false);
  });

  it("rejects a non-boolean mapToggle", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mapToggle: 1 })).toBe(false);
  });

  it("rejects a non-boolean interact", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, interact: 1 })).toBe(false);
  });

  it("rejects a non-boolean melee", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, melee: 1 })).toBe(false);
  });

  it("rejects a non-boolean meleeHeld", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, meleeHeld: 1 })).toBe(false);
  });

  it("rejects a non-number wheelSteps", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: "0" })).toBe(false);
  });

  it("rejects a non-boolean fpsToggle", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, fpsToggle: 1 })).toBe(false);
  });

  it("rejects a non-boolean escape", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, escape: 1 })).toBe(false);
  });

  it("rejects a non-boolean blur", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, blur: 1 })).toBe(false);
  });

  it("rejects a non-boolean pointerUnlock", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, pointerUnlock: 1 })).toBe(false);
  });

  it("rejects a non-boolean click", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, click: 1 })).toBe(false);
  });

  it("rejects a non-number gpForward", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpForward: "0" })).toBe(false);
  });

  it("rejects a non-number gpStrafe", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpStrafe: "0" })).toBe(false);
  });

  it("rejects a non-number gpTurn", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpTurn: "0" })).toBe(false);
  });

  // --- Value-level checks (finding C1/C2/H2): a peer controls these, and
  // `typeof === "number"` used to accept NaN/Infinity, the load-bearing
  // one-packet freeze / NaN-corruption vectors. ---

  it("rejects a non-finite mouseDX (NaN/Infinity)", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mouseDX: NaN })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mouseDX: Infinity })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mouseDX: -Infinity })).toBe(false);
  });

  it("rejects a non-finite gpForward/gpStrafe/gpTurn", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpForward: NaN })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpStrafe: Infinity })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, gpTurn: NaN })).toBe(false);
  });

  it("accepts finite non-zero analog values", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, mouseDX: -12.5, gpForward: 0.7, gpStrafe: -1, gpTurn: 0.3 })).toBe(true);
  });

  it("rejects a non-finite or non-integer wheelSteps", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: NaN })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: Infinity })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: 1.5 })).toBe(false);
  });

  it("rejects a wheelSteps beyond MAX_WHEEL_STEPS_PER_TICK (the freeze vector)", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: 1e12 })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: MAX_WHEEL_STEPS_PER_TICK + 1 })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: -(MAX_WHEEL_STEPS_PER_TICK + 1) })).toBe(false);
  });

  it("accepts a wheelSteps at the cap in both directions", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: MAX_WHEEL_STEPS_PER_TICK })).toBe(true);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, wheelSteps: -MAX_WHEEL_STEPS_PER_TICK })).toBe(true);
  });

  it("rejects a non-integer weaponRequest (NaN/Infinity/fractional)", () => {
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, weaponRequest: NaN })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, weaponRequest: Infinity })).toBe(false);
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, weaponRequest: 1.5 })).toBe(false);
  });

  it("rejects a keys array longer than MAX_INPUT_KEYS (bandwidth/CPU amplification)", () => {
    const tooMany = Array.from({ length: MAX_INPUT_KEYS + 1 }, () => "KeyW");
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, keys: tooMany })).toBe(false);
  });

  it("accepts a keys array exactly at MAX_INPUT_KEYS", () => {
    const atCap = Array.from({ length: MAX_INPUT_KEYS }, () => "KeyW");
    expect(isValidInputSnapshot({ ...VALID_SNAPSHOT, keys: atCap })).toBe(true);
  });
});

describe("isValidWireTick", () => {
  it("accepts a finite integer", () => {
    expect(isValidWireTick(42)).toBe(true);
    expect(isValidWireTick(0)).toBe(true);
  });

  it("rejects a non-integer number", () => {
    expect(isValidWireTick(1.5)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(isValidWireTick(NaN)).toBe(false);
    expect(isValidWireTick(Infinity)).toBe(false);
    expect(isValidWireTick(-Infinity)).toBe(false);
  });

  it("rejects non-number types", () => {
    expect(isValidWireTick("42")).toBe(false);
    expect(isValidWireTick(null)).toBe(false);
    expect(isValidWireTick(undefined)).toBe(false);
    expect(isValidWireTick({})).toBe(false);
  });
});
