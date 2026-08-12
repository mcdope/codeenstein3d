// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isFirstRun,
  LEGACY_SCHEMA_VERSION,
  migrateStorage,
  ownedKeys,
  readSchemaState,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_PREFIX,
  STORAGE_SCHEMA_VERSION,
} from "./storageSchema";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("storageSchema", () => {
  it("reports a genuine first run only when nothing at all is stored", () => {
    expect(readSchemaState()).toEqual({ kind: "first-run" });
    expect(isFirstRun()).toBe(true);
  });

  it("treats existing unstamped data as legacy, not as a first run", () => {
    // The distinction that matters: an existing player has keys and no stamp.
    // Reading that as a first run would re-show the intro to someone with a
    // campaign already in progress.
    localStorage.setItem(`${STORAGE_KEY_PREFIX}campaign-save`, "{}");
    expect(readSchemaState()).toEqual({ kind: "legacy", version: LEGACY_SCHEMA_VERSION });
    expect(isFirstRun()).toBe(false);
  });

  it("ignores keys belonging to other apps on the same origin", () => {
    localStorage.setItem("some-other-app", "1");
    expect(ownedKeys()).toEqual([]);
    expect(isFirstRun()).toBe(true);
  });

  it("stamps the current version and reports what it found beforehand", () => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}difficulty`, "hard");
    const before = migrateStorage();
    expect(before.kind).toBe("legacy");
    expect(localStorage.getItem(SCHEMA_VERSION_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    // Returning the *prior* state is the point: stamping would otherwise erase
    // the very fact a caller needs to branch on.
    expect(readSchemaState()).toEqual({ kind: "current", version: STORAGE_SCHEMA_VERSION });
  });

  it("stamps a first run too, so the second launch is not a first run", () => {
    expect(migrateStorage().kind).toBe("first-run");
    expect(isFirstRun()).toBe(false);
  });

  it("never migrates downward from storage stamped by a newer build", () => {
    // Same origin, two tabs, one on a newer deploy. Rewriting to this build's
    // shape would corrupt data the other tab is still using.
    localStorage.setItem(SCHEMA_VERSION_KEY, String(STORAGE_SCHEMA_VERSION + 5));
    const before = migrateStorage();
    expect(before).toEqual({ kind: "future", version: STORAGE_SCHEMA_VERSION + 5 });
    expect(localStorage.getItem(SCHEMA_VERSION_KEY)).toBe(String(STORAGE_SCHEMA_VERSION + 5));
  });

  it("treats a corrupt stamp as future, so migrations are skipped rather than re-run", () => {
    localStorage.setItem(SCHEMA_VERSION_KEY, "not-a-number");
    const state = readSchemaState();
    expect(state.kind).toBe("future");
    // And it is left alone rather than rewritten.
    migrateStorage();
    expect(localStorage.getItem(SCHEMA_VERSION_KEY)).toBe("not-a-number");
  });

  it("survives storage that throws on access", () => {
    // Safari private mode and policy-disabled storage both throw on the very
    // first property read. Module initialization must not die for it.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => readSchemaState()).not.toThrow();
    spy.mockRestore();
  });

  it("survives a setItem that throws, without claiming success", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => migrateStorage()).not.toThrow();
    spy.mockRestore();
    // The stamp is an optimization for the next launch, never a correctness
    // requirement for this one — so nothing was written and nothing broke.
    expect(localStorage.getItem(SCHEMA_VERSION_KEY)).toBeNull();
  });

  it("reports no data when the storage global does not exist at all", () => {
    // Not the same as storage that throws: some embedded/hardened browsers
    // simply have no `localStorage` binding, and `typeof` is the only safe way
    // to ask. Reading it as absence keeps module initialization alive.
    vi.stubGlobal("localStorage", undefined);
    try {
      expect(readSchemaState()).toEqual({ kind: "first-run" });
      expect(ownedKeys()).toEqual([]);
      expect(() => migrateStorage()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts the version stamp itself as an owned key", () => {
    migrateStorage();
    expect(ownedKeys()).toEqual([SCHEMA_VERSION_KEY]);
  });
});
