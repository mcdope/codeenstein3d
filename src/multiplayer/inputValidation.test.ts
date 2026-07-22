// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { isValidInputSnapshot, isValidWireTick } from "./inputValidation";
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
