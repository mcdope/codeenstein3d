// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { ChunkReassembler, chunkJson } from "./chunkedTransfer";

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
});
