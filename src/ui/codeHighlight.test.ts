// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it } from "vitest";
import { initialScanState, MAX_RENDERED_LINES, renderHighlighted, syntaxForPath, tokenizeLine } from "./codeHighlight";

/** Tokenize one line in isolation, as `path`'s language. */
function tokens(line: string, path = "a.ts"): { text: string; kind: string }[] {
  return tokenizeLine(line, syntaxForPath(path), initialScanState()).map((t) => ({ text: t.text, kind: t.kind }));
}

/** The concatenation of every token must always reproduce the input exactly —
 * a highlighter that drops or duplicates a character would show mangled code,
 * which is worse than showing it uncoloured. Asserted on every case below. */
function roundTrips(line: string, path = "a.ts"): boolean {
  return tokens(line, path)
    .map((t) => t.text)
    .join("") === line;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("codeHighlight — tokenizeLine", () => {
  it("colours a line comment to end of line", () => {
    expect(tokens("x = 1; // trailing note")).toEqual([
      { text: "x = ", kind: "plain" },
      { text: "1", kind: "number" },
      { text: "; ", kind: "plain" },
      { text: "// trailing note", kind: "comment" },
    ]);
    expect(roundTrips("x = 1; // trailing note")).toBe(true);
  });

  it("treats # as a comment in hash-family languages and not in C-family ones", () => {
    expect(tokens("value = 2 # note", "a.py").at(-1)).toEqual({ text: "# note", kind: "comment" });
    expect(tokens("a # b", "a.c").some((t) => t.kind === "comment")).toBe(false);
  });

  it("accepts both comment forms in PHP", () => {
    expect(tokens("$a = 1; # note", "a.php").at(-1)).toEqual({ text: "# note", kind: "comment" });
    expect(tokens("$a = 1; // note", "a.php").at(-1)).toEqual({ text: "// note", kind: "comment" });
  });

  it("carries a block comment across lines and closes it mid-line", () => {
    const state = initialScanState();
    const syntax = syntaxForPath("a.c");

    expect(tokenizeLine("/* opening", syntax, state)).toEqual([{ text: "/* opening", kind: "comment" }]);
    expect(state.inBlockComment).toBe(true);

    expect(tokenizeLine(" still inside", syntax, state)).toEqual([{ text: " still inside", kind: "comment" }]);
    expect(state.inBlockComment).toBe(true);

    expect(tokenizeLine("done */ x = 1;", syntax, state)).toEqual([
      { text: "done */", kind: "comment" },
      { text: " x = ", kind: "plain" },
      { text: "1", kind: "number" },
      { text: ";", kind: "plain" },
    ]);
    expect(state.inBlockComment).toBe(false);
  });

  it("opens and closes a block comment on one line", () => {
    expect(tokens("a /* mid */ b")).toEqual([
      { text: "a ", kind: "plain" },
      { text: "/* mid */", kind: "comment" },
      { text: " b", kind: "plain" },
    ]);
  });

  it("never opens a block comment in a language that has none", () => {
    // Python has no /* */ — the slash-star must stay ordinary text rather
    // than swallowing the rest of the file.
    const state = initialScanState();
    tokenizeLine("a /* b", syntaxForPath("a.py"), state);
    expect(state.inBlockComment).toBe(false);
  });

  it("colours strings, honours escapes, and stops an unterminated one at end of line", () => {
    expect(tokens('greet("hello")').at(1)).toEqual({ text: '"hello"', kind: "string" });
    expect(tokens('x = "a\\"b" + c').at(1)).toEqual({ text: '"a\\"b"', kind: "string" });
    // A stray apostrophe (English prose inside a shell script, say) runs to
    // end of line and stops — no state carries, so it cannot eat the file.
    expect(tokens("echo don't", "a.sh").at(-1)).toEqual({ text: "'t", kind: "string" });
    expect(roundTrips("echo don't", "a.sh")).toBe(true);
  });

  it("colours a backslash at end of line without running past it", () => {
    expect(roundTrips('x = "abc\\')).toBe(true);
  });

  it("colours numbers, including hex and decimals, but not digits inside identifiers", () => {
    expect(tokens("n = 0xFF").at(-1)).toEqual({ text: "0xFF", kind: "number" });
    expect(tokens("n = 1.5").at(-1)).toEqual({ text: "1.5", kind: "number" });
    // `utf8Decode` must not have its `8` coloured as a number.
    expect(tokens("utf8Decode(x)").every((t) => t.kind !== "number")).toBe(true);
  });

  it("colours keywords case-insensitively and leaves identifiers alone", () => {
    expect(tokens("return value")).toEqual([
      { text: "return", kind: "keyword" },
      // Coalesced: everything after the keyword is one plain run.
      { text: " value", kind: "plain" },
    ]);
    expect(tokens("Function Foo()", "a.php").at(0)).toEqual({ text: "Function", kind: "keyword" });
    expect(tokens("returnValue = 1").at(0)).toEqual({ text: "returnValue = ", kind: "plain" });
  });

  it("coalesces runs of plain text into single tokens", () => {
    expect(tokens("a + b - c")).toEqual([{ text: "a + b - c", kind: "plain" }]);
  });

  it("handles an empty line", () => {
    expect(tokens("")).toEqual([]);
  });

  it("never drops or duplicates a character, whatever the line", () => {
    // The invariant that matters most, and the one the first version of this
    // module broke: it swallowed a block comment's opening `/*`, so the
    // rendered file was missing characters the real file has. Colouring can
    // be wrong; the text cannot.
    const lines = [
      "/* opening only",
      "a /* mid */ b",
      "/*/ not a close",
      "*/ dangling close",
      "s = 'it\\'s' + `tpl ${x}` // done",
      "0x1F + 3.14 - utf8Decode(9)",
      "\t  indented\t\tby tabs  ",
      "émoji ☃ and unicode identifiers",
      "#include <stdio.h>",
      "",
    ];
    for (const line of lines) expect(roundTrips(line)).toBe(true);

    // Across a carried block-comment state too, where the scanner takes a
    // different path through the same lines.
    const state = initialScanState();
    const syntax = syntaxForPath("a.c");
    for (const line of lines) {
      expect(
        tokenizeLine(line, syntax, state)
          .map((t) => t.text)
          .join(""),
      ).toBe(line);
    }
  });

  it("falls back to the C family for an unknown or missing extension", () => {
    expect(tokens("a // b", "Makefile").at(-1)).toEqual({ text: "// b", kind: "comment" });
    expect(tokens("a // b", "weird.qqq").at(-1)).toEqual({ text: "// b", kind: "comment" });
  });
});

describe("codeHighlight — renderHighlighted", () => {
  it("renders one numbered row per line", () => {
    const el = document.createElement("div");
    renderHighlighted(el, "const a = 1;\n// two\n", "x.ts");

    const rows = el.querySelectorAll(".boss-line");
    expect(rows).toHaveLength(3); // trailing newline yields a final empty line
    expect(rows[0].querySelector(".boss-line-no")?.textContent).toBe("1");
    expect(rows[1].querySelector(".boss-line-code")?.textContent).toBe("// two");
    expect(rows[2].querySelector(".boss-line-no")?.textContent).toBe("3");
  });

  it("assigns a kind class per token", () => {
    const el = document.createElement("div");
    renderHighlighted(el, 'if (x) { s = "hi"; n = 2; } // done', "x.js");

    const kinds = [...el.querySelectorAll(".boss-tok")].map((t) => t.className);
    expect(kinds).toContain("boss-tok boss-tok--keyword");
    expect(kinds).toContain("boss-tok boss-tok--string");
    expect(kinds).toContain("boss-tok boss-tok--number");
    expect(kinds).toContain("boss-tok boss-tok--comment");
  });

  it("renders source as text, never as markup", () => {
    const el = document.createElement("div");
    renderHighlighted(el, '<script>alert("x")</script>', "x.html");

    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>");
  });

  it("caps very long files and replaces previous content", () => {
    const el = document.createElement("div");
    renderHighlighted(el, "first\n", "x.ts");
    renderHighlighted(el, Array.from({ length: MAX_RENDERED_LINES + 500 }, (_, i) => `line ${i}`).join("\n"), "x.ts");

    expect(el.querySelectorAll(".boss-line")).toHaveLength(MAX_RENDERED_LINES);
    expect(el.textContent).not.toContain("first");
  });
});
