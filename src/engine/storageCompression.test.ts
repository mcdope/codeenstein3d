// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { compressForStorage, decompressFromStorage } from "./storageCompression";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compressForStorage / decompressFromStorage", () => {
  it("compresses a large repetitive value and round-trips it back exactly", async () => {
    const value = { frames: Array.from({ length: 2000 }, () => ({ dt: 0.016, key: "KeyW" })) };
    const plain = JSON.stringify(value);
    const stored = await compressForStorage(value);
    expect(stored.startsWith("gz1:")).toBe(true);
    expect(stored.length).toBeLessThan(plain.length);
    expect(await decompressFromStorage(stored)).toEqual(value);
  });

  it("falls back to plain JSON when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const value = { a: 1, b: "test" };
    const stored = await compressForStorage(value);
    expect(stored).toBe(JSON.stringify(value));
    expect(stored.startsWith("gz1:")).toBe(false);
  });

  it("falls back to plain JSON when compression wouldn't actually shrink the value", async () => {
    const stored = await compressForStorage(1);
    expect(stored).toBe(JSON.stringify(1));
    expect(stored.startsWith("gz1:")).toBe(false);
  });

  it("falls back to plain JSON when compression throws", async () => {
    vi.stubGlobal(
      "CompressionStream",
      class {
        constructor() {
          throw new Error("boom");
        }
      },
    );
    const value = { frames: Array.from({ length: 2000 }, () => ({ dt: 0.016 })) };
    const stored = await compressForStorage(value);
    expect(stored).toBe(JSON.stringify(value));
  });

  it("parses a legacy (uncompressed) stored value directly", async () => {
    const value = { legacy: true };
    expect(await decompressFromStorage(JSON.stringify(value))).toEqual(value);
  });

  it("rejects on corrupt gz1:-prefixed data", async () => {
    await expect(decompressFromStorage("gz1:not-valid-gzip-base64")).rejects.toThrow();
  });
});
