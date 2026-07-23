// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { ChunkReassembler, chunkJson, isValidMapDimensions, MAX_TOTAL_BYTES, MAX_TOTAL_CHUNKS } from "./chunkedTransfer";

describe("chunkJson / ChunkReassembler round trip", () => {
  it("round-trips a small payload that fits in a single chunk", () => {
    const payload = { hello: "world" };
    const chunks = chunkJson(payload, 1024);
    expect(chunks).toHaveLength(1);

    const reassembler = new ChunkReassembler();
    chunks.forEach((chunk, i) => reassembler.push(chunk, i));
    expect(reassembler.isComplete(chunks.length)).toBe(true);
    expect(reassembler.finish()).toEqual(payload);
  });

  it("round-trips a large payload spanning many chunks", () => {
    const payload = { grid: Array.from({ length: 500 }, (_, i) => [i, i * 2, i * 3]) };
    const chunkSize = 100;
    const chunks = chunkJson(payload, chunkSize);
    expect(chunks.length).toBeGreaterThan(1);

    const reassembler = new ChunkReassembler();
    chunks.forEach((chunk, i) => reassembler.push(chunk, i));
    expect(reassembler.isComplete(chunks.length)).toBe(true);
    expect(reassembler.finish()).toEqual(payload);
  });

  it("handles a payload whose JSON length is an exact multiple of the chunk size (no trailing empty chunk)", () => {
    const json = JSON.stringify({ a: "x".repeat(16) }); // known length
    const chunkSize = json.length / 2;
    expect(Number.isInteger(chunkSize)).toBe(true);
    const chunks = chunkJson({ a: "x".repeat(16) }, chunkSize);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(json);
  });

  it("handles a payload one character longer than an exact chunk-size multiple", () => {
    const chunks = chunkJson({ a: "x".repeat(17) }, 10);
    const json = JSON.stringify({ a: "x".repeat(17) });
    expect(chunks.join("")).toBe(json);
    expect(chunks[chunks.length - 1].length).toBeGreaterThan(0);
  });

  it("reassembles correctly even when chunks are pushed out of arrival order", () => {
    const payload = { list: [1, 2, 3, 4, 5] };
    const chunks = chunkJson(payload, 5);
    const reassembler = new ChunkReassembler();
    [...chunks.entries()].reverse().forEach(([i, chunk]) => reassembler.push(chunk, i));
    expect(reassembler.isComplete(chunks.length)).toBe(true);
    expect(reassembler.finish()).toEqual(payload);
  });

  it("isComplete is false while chunks are still missing", () => {
    const reassembler = new ChunkReassembler();
    reassembler.push("abc", 0);
    expect(reassembler.isComplete(2)).toBe(false);
    reassembler.push("def", 1);
    expect(reassembler.isComplete(2)).toBe(true);
  });

  it("isComplete is false if the wrong total is checked against", () => {
    const reassembler = new ChunkReassembler();
    reassembler.push("abc", 0);
    reassembler.push("def", 1);
    expect(reassembler.isComplete(3)).toBe(false);
  });

  it("isComplete is false when the right chunk count has arrived but with an index gap (not just a size mismatch)", () => {
    const reassembler = new ChunkReassembler();
    reassembler.push("abc", 0);
    reassembler.push("ghi", 2); // index 1 never arrived; size still equals totalChunks
    expect(reassembler.isComplete(2)).toBe(false);
  });

  it("stays unaffected by MAX_TOTAL_CHUNKS/MAX_TOTAL_BYTES for an ordinary transfer well under both caps", () => {
    const payload = { grid: Array.from({ length: 50 }, (_, i) => i) };
    const chunks = chunkJson(payload, 64);
    const reassembler = new ChunkReassembler();
    chunks.forEach((chunk, i) => reassembler.push(chunk, i));
    expect(reassembler.isComplete(chunks.length)).toBe(true);
    expect(reassembler.finish()).toEqual(payload);
  });

  it("throws once MAX_TOTAL_CHUNKS would be exceeded by a sustained flood of real (tiny) chunks", () => {
    const reassembler = new ChunkReassembler();
    for (let i = 0; i < MAX_TOTAL_CHUNKS; i++) reassembler.push("x", i);
    expect(() => reassembler.push("x", MAX_TOTAL_CHUNKS)).toThrow(new RegExp(`more than ${MAX_TOTAL_CHUNKS} chunks`));
  });

  it("throws once MAX_TOTAL_BYTES would be exceeded, even while comfortably under MAX_TOTAL_CHUNKS", () => {
    const reassembler = new ChunkReassembler();
    const chunkSize = 1024 * 1024; // 1 MiB per chunk
    const bigChunk = "x".repeat(chunkSize);
    const chunksNeeded = Math.ceil(MAX_TOTAL_BYTES / chunkSize) + 1;
    expect(chunksNeeded).toBeLessThan(MAX_TOTAL_CHUNKS); // sanity: the byte cap trips first, not the chunk-count cap

    expect(() => {
      for (let i = 0; i < chunksNeeded; i++) reassembler.push(bigChunk, i);
    }).toThrow(new RegExp(`more than ${MAX_TOTAL_BYTES} bytes`));
  });

  it("re-pushing an already-seen index adjusts the byte tally by the delta instead of double-counting", () => {
    const reassembler = new ChunkReassembler();
    reassembler.push("a".repeat(1000), 0);
    // Replacing the same index with a same-size chunk many times must never
    // trip MAX_TOTAL_BYTES purely from repetition — only the live, current
    // content counts.
    for (let i = 0; i < 1000; i++) reassembler.push("b".repeat(1000), 0);
    expect(() => reassembler.push("c".repeat(1000), 1)).not.toThrow();
  });

  // --- Finding H1: a peer-controlled non-string `chunk` used to NaN-poison
  // the byte tally, permanently disabling MAX_TOTAL_BYTES. `data`/`index`
  // arrive straight off JSON.parse, so push() must validate them. ---

  it("rejects a non-string chunk instead of NaN-poisoning the byte cap", () => {
    const reassembler = new ChunkReassembler();
    // The exact attack: `data: 0` makes `chunk.length` undefined → the tally
    // would go NaN and every future `> MAX_TOTAL_BYTES` check would be false.
    expect(() => reassembler.push(0 as unknown as string, 0)).toThrow(/non-string chunk/);
    expect(() => reassembler.push(false as unknown as string, 0)).toThrow(/non-string chunk/);
    expect(() => reassembler.push(undefined as unknown as string, 0)).toThrow(/non-string chunk/);
    expect(() => reassembler.push({} as unknown as string, 0)).toThrow(/non-string chunk/);
    // The byte cap must still be live afterward: a subsequent legitimate,
    // over-cap chunk still trips it (it wasn't poisoned to NaN).
    const chunkSize = 1024 * 1024;
    const bigChunk = "x".repeat(chunkSize);
    expect(() => {
      for (let i = 0; i < Math.ceil(MAX_TOTAL_BYTES / chunkSize) + 1; i++) reassembler.push(bigChunk, i);
    }).toThrow(new RegExp(`more than ${MAX_TOTAL_BYTES} bytes`));
  });

  it("rejects a non-integer or negative index", () => {
    const reassembler = new ChunkReassembler();
    expect(() => reassembler.push("x", -1)).toThrow(/non-integer or negative index/);
    expect(() => reassembler.push("x", 1.5)).toThrow(/non-integer or negative index/);
    expect(() => reassembler.push("x", NaN)).toThrow(/non-integer or negative index/);
    expect(() => reassembler.push("x", "0" as unknown as number)).toThrow(/non-integer or negative index/);
  });

  it("rejects a single chunk larger than MAX_TOTAL_BYTES outright", () => {
    const reassembler = new ChunkReassembler();
    const overCap = "x".repeat(MAX_TOTAL_BYTES + 1);
    expect(() => reassembler.push(overCap, 0)).toThrow(new RegExp(`single chunk larger than ${MAX_TOTAL_BYTES}`));
  });
});

describe("isValidMapDimensions (re-review finding: unvalidated declared width/height)", () => {
  const MAX = 2048;

  it("accepts real, in-bounds integer dimensions", () => {
    expect(isValidMapDimensions(160, 160, MAX)).toBe(true);
    expect(isValidMapDimensions(1, 1, MAX)).toBe(true);
    expect(isValidMapDimensions(MAX, MAX, MAX)).toBe(true);
  });

  it("rejects a declared dimension exceeding the cap — the exact allocation-DoS vector", () => {
    expect(isValidMapDimensions(1e9, 1e9, MAX)).toBe(false);
    expect(isValidMapDimensions(MAX + 1, 100, MAX)).toBe(false);
    expect(isValidMapDimensions(100, MAX + 1, MAX)).toBe(false);
  });

  it("rejects zero or negative dimensions", () => {
    expect(isValidMapDimensions(0, 100, MAX)).toBe(false);
    expect(isValidMapDimensions(100, 0, MAX)).toBe(false);
    expect(isValidMapDimensions(-5, 100, MAX)).toBe(false);
  });

  it("rejects non-integer (fractional) dimensions", () => {
    expect(isValidMapDimensions(100.5, 100, MAX)).toBe(false);
  });

  it("rejects non-numeric dimensions", () => {
    expect(isValidMapDimensions("100", 100, MAX)).toBe(false);
    expect(isValidMapDimensions(100, null, MAX)).toBe(false);
    expect(isValidMapDimensions(undefined, 100, MAX)).toBe(false);
    expect(isValidMapDimensions({}, 100, MAX)).toBe(false);
  });
});
