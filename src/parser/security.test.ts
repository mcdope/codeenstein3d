// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { isSafeToParse, MAX_PARSE_BYTES } from "./security";

describe("isSafeToParse", () => {
  it("accepts ordinary source text", () => {
    expect(isSafeToParse("function foo() { return 1; }\n")).toEqual({ ok: true });
  });

  it("accepts an empty string", () => {
    expect(isSafeToParse("")).toEqual({ ok: true });
  });

  it("rejects text over the size limit", () => {
    const huge = "a".repeat(MAX_PARSE_BYTES + 1);
    const result = isSafeToParse(huge);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  it("accepts text exactly at the size limit", () => {
    const exact = "a".repeat(MAX_PARSE_BYTES);
    expect(isSafeToParse(exact).ok).toBe(true);
  });

  it("rejects text containing a NUL byte", () => {
    const result = isSafeToParse("some text\0with a nul");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/binary/);
  });

  it("rejects text with a high ratio of non-printable control characters", () => {
    const binaryish = Array.from({ length: 100 }, (_, i) => String.fromCharCode(i % 2 === 0 ? 1 : 65)).join("");
    expect(isSafeToParse(binaryish).ok).toBe(false);
  });

  it("accepts text with common whitespace (tab/LF/CR) without flagging it as binary", () => {
    const withWhitespace = "line one\r\n\tline two\r\nline three\n".repeat(50);
    expect(isSafeToParse(withWhitespace).ok).toBe(true);
  });

  it("rejects text containing the Unicode replacement character above the threshold", () => {
    const replacementHeavy = "�".repeat(2000) + "a".repeat(100);
    expect(isSafeToParse(replacementHeavy).ok).toBe(false);
  });

  it("only sniffs the leading window, so binary content past it doesn't matter", () => {
    // 8192 clean bytes, then a NUL far beyond the sniff window.
    const mostlyClean = "a".repeat(8192) + "\0" + "b".repeat(100);
    expect(isSafeToParse(mostlyClean).ok).toBe(true);
  });
});
