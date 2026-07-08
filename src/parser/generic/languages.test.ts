import { describe, it, expect } from "vitest";
import { GENERIC_ADAPTERS } from "./languages";

describe("languages", () => {
  it("should export an array of adapters", () => {
    expect(GENERIC_ADAPTERS).toBeInstanceOf(Array);
    expect(GENERIC_ADAPTERS.length).toBeGreaterThan(0);
  });

  it("should include known languages", () => {
    const languages = GENERIC_ADAPTERS.map(a => a.language);
    expect(languages).toContain("javascript");
    expect(languages).toContain("python");
    expect(languages).toContain("rust");
    expect(languages).toContain("go");
    expect(languages).toContain("bash");
  });

  it("should have unique extensions", () => {
    const extensions = new Set<string>();
    for (const adapter of GENERIC_ADAPTERS) {
      for (const ext of adapter.extensions) {
        // Just checking no overlap within GENERIC_ADAPTERS for sanity
        expect(extensions.has(ext)).toBe(false);
        extensions.add(ext);
      }
    }
  });
});
