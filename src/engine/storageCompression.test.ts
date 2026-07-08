// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressForStorage, decompressFromStorage } from "./storageCompression";

describe("storageCompression", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const { CompressionStream, DecompressionStream } = await import("node:stream/web");
    const { Blob: NodeBlob } = await import("node:buffer");
    vi.stubGlobal("CompressionStream", CompressionStream);
    vi.stubGlobal("DecompressionStream", DecompressionStream);
    vi.stubGlobal("Blob", NodeBlob);
  });

  it("returns plain JSON if CompressionStream is undefined", async () => {
    const originalCompressionStream = globalThis.CompressionStream;
    // @ts-ignore
    delete globalThis.CompressionStream;

    const data = { a: 1 };
    const result = await compressForStorage(data);
    expect(result).toBe(JSON.stringify(data));

    // @ts-ignore
    globalThis.CompressionStream = originalCompressionStream;
  });

  it("returns plain JSON if compression throws", async () => {
    // @ts-ignore
    const mockCompressionStream = vi.fn().mockImplementation(() => {
      throw new Error("compression failed");
    });
    vi.stubGlobal("CompressionStream", mockCompressionStream);

    const data = { a: 1 };
    const result = await compressForStorage(data);
    expect(result).toBe(JSON.stringify(data));
    
    vi.unstubAllGlobals();
  });

  it("returns plain JSON if compressed data is larger than plain JSON", async () => {
    const data = { a: 1 }; 
    const result = await compressForStorage(data);
    expect(result).toBe(JSON.stringify(data));
  });

  it("returns compressed base64 if compressed data is smaller than plain JSON", async () => {
    const data = { a: "a".repeat(1000) }; 
    const result = await compressForStorage(data);
    expect(result.startsWith("gz1:")).toBe(true);
    expect(result.length).toBeLessThan(JSON.stringify(data).length);
  });

  it("decompresses plain JSON correctly", async () => {
    const data = { a: 1 };
    const result = await decompressFromStorage(JSON.stringify(data));
    expect(result).toEqual(data);
  });

  it("decompresses compressed base64 correctly", async () => {
    const data = { a: "a".repeat(1000) };
    const compressed = await compressForStorage(data);
    const result = await decompressFromStorage(compressed);
    expect(result).toEqual(data);
  });

  it("handles chunking correctly for large byte arrays", async () => {
    const data = { a: "a".repeat(40000) }; 
    const compressed = await compressForStorage(data);
    const result = await decompressFromStorage(compressed);
    expect(result).toEqual(data);
  });
});