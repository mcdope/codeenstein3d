import { describe, it, expect } from "vitest";
import { isSafeToParse, MAX_PARSE_BYTES } from "./security";

describe("security", () => {
  describe("isSafeToParse", () => {
    it("should allow normal source text", () => {
      const result = isSafeToParse("const x = 1;\nconsole.log(x);");
      expect(result.ok).toBe(true);
    });

    it("should reject files exceeding MAX_PARSE_BYTES", () => {
      const largeText = "a".repeat(MAX_PARSE_BYTES + 1);
      const result = isSafeToParse(largeText);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/exceeds/);
    });

    it("should reject files with NUL byte", () => {
      const result = isSafeToParse("const x = 1;\0");
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/binary/);
    });

    it("should reject files with high ratio of non-printable characters", () => {
      // 20% non-printable characters
      const text = "\x01\x02\x03\x04\x05".padEnd(20, "a");
      const result = isSafeToParse(text);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/binary/);
    });

    it("should allow files with some control characters if under threshold", () => {
      // 10% non-printable characters
      const text = "\x01".padEnd(10, "a");
      const result = isSafeToParse(text);
      expect(result.ok).toBe(true);
    });

    it("should allow common whitespace characters", () => {
      const text = "\t\n\r".padEnd(100, " ");
      const result = isSafeToParse(text);
      expect(result.ok).toBe(true);
    });

    it("should reject files containing unicode replacement character if ratio is high", () => {
      const text = "\ufffd\ufffd".padEnd(10, "a");
      const result = isSafeToParse(text);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/binary/);
    });

    it("should return true for empty string", () => {
      const result = isSafeToParse("");
      expect(result.ok).toBe(true);
    });
  });
});
