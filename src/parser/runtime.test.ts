import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTreeSitter } from "./runtime";

vi.mock("web-tree-sitter", () => {
  return {
    Parser: {
      init: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("web-tree-sitter/web-tree-sitter.wasm?url", () => {
  return {
    default: "mock-wasm-url",
  };
});

describe("runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize tree sitter once", async () => {
    const { Parser } = await import("web-tree-sitter");
    const p1 = initTreeSitter();
    const p2 = initTreeSitter();
    
    expect(p1).toBe(p2); // Returns the same promise
    await p1;
    expect(Parser.init).toHaveBeenCalledTimes(1);

    // check locateFile
    const initCall = vi.mocked(Parser.init).mock.calls[0][0] as { locateFile: () => string };
    expect(initCall.locateFile()).toBe("mock-wasm-url");
  });
});
