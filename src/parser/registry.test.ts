// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * registry.ts itself has no direct `web-tree-sitter` import, but its
 * ADAPTERS array is built from adapters that do (php/c/generic) — importing
 * this module transitively pulls those in. That's fine: constructing an
 * adapter is cheap/lazy (wasm only loads on the first real `.parse()` call),
 * and `extensionOf`/`getParserForFilename`/`isParsable` never call `.parse()`
 * so they stay wasm-free at runtime. `parseFile()`'s success/throw paths do
 * exercise real Tree-sitter parsing — already proven working under Vitest by
 * the Phase 0 `?url`-as-path plugin (see src/parser/runtime.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionOf, getParserForFilename, isParsable, parseFile } from "./registry";

describe("extensionOf", () => {
  it("returns the lower-cased extension without the dot", () => {
    expect(extensionOf("Main.PHP")).toBe("php");
    expect(extensionOf("script.js")).toBe("js");
  });

  it("uses the last dot for a multi-dot filename", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("returns an empty string for a filename with no dot", () => {
    expect(extensionOf("Makefile")).toBe("");
  });

  it("treats a leading-dot dotfile's name as the 'extension'", () => {
    expect(extensionOf(".gitignore")).toBe("gitignore");
  });
});

describe("getParserForFilename", () => {
  it("resolves a known extension regardless of case", () => {
    expect(getParserForFilename("main.PHP")?.language).toBe("php");
    expect(getParserForFilename("index.js")?.language).toBe("javascript");
  });

  it("returns null for an unrecognized extension", () => {
    expect(getParserForFilename("image.png")).toBeNull();
  });

  it("prefers the real extension over shebang sniffing when both are present", () => {
    expect(getParserForFilename("script.js", "#!/usr/bin/env python3\n")?.language).toBe("javascript");
  });

  it("returns null for an extensionless file when no sourceText is given", () => {
    expect(getParserForFilename("myscript")).toBeNull();
  });

  it("falls back to sniffing a #!/usr/bin/env shebang for an extensionless file", () => {
    expect(getParserForFilename("myscript", "#!/usr/bin/env python3\nprint(1)\n")?.language).toBe("python");
  });

  it("falls back to sniffing a direct-path shebang (no env)", () => {
    expect(getParserForFilename("myscript", "#!/bin/bash\necho hi\n")?.language).toBe("bash");
  });

  it("strips a version suffix from the interpreter name (python3.11 -> python)", () => {
    expect(getParserForFilename("myscript", "#!/usr/bin/env python3.11\n")?.language).toBe("python");
  });

  it("returns null when the shebang names an unrecognized interpreter", () => {
    expect(getParserForFilename("myscript", "#!/usr/bin/env somelangwehaventheardof\n")).toBeNull();
  });

  it("returns null when the first line isn't a shebang at all", () => {
    expect(getParserForFilename("myscript", "just some text\nmore text\n")).toBeNull();
  });

  it("returns null for a bare '#!' with no interpreter token", () => {
    expect(getParserForFilename("myscript", "#!\n")).toBeNull();
  });

  it("returns null for '#!/usr/bin/env' with no interpreter argument", () => {
    expect(getParserForFilename("myscript", "#!/usr/bin/env\n")).toBeNull();
  });

  it("handles a shebang with no trailing newline at all", () => {
    expect(getParserForFilename("myscript", "#!/usr/bin/env node")?.language).toBe("javascript");
  });
});

describe("isParsable", () => {
  it("mirrors getParserForFilename's true/false outcome", () => {
    expect(isParsable("main.js")).toBe(true);
    expect(isParsable("image.png")).toBe(false);
  });
});

describe("parseFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for an unsupported extension", () => {
    return parseFile("image.png", "binary junk").then((result) => expect(result).toBeNull());
  });

  it("returns null and warns when the content fails the safety check", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await parseFile("script.js", "some\0binary\0junk");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("returns a real ParsedFile for valid source text", async () => {
    const result = await parseFile("script.js", "function foo() { return 1; }\n");
    expect(result).not.toBeNull();
    expect(result?.language).toBe("javascript");
    expect(result?.entities.some((e) => e.name === "foo")).toBe(true);
  });

  it("returns null and warns when the adapter's parse() throws", async () => {
    const adapter = getParserForFilename("script.js")!;
    const parseSpy = vi.spyOn(adapter, "parse").mockRejectedValue(new Error("simulated adapter failure"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await parseFile("script.js", "function foo() {}\n");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    parseSpy.mockRestore();
  });
});
