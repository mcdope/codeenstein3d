import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extensionOf, getParserForFilename, isParsable, parseFile } from "./registry";
import * as security from "./security";

describe("registry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("extensionOf", () => {
    it("should return the extension in lower case", () => {
      expect(extensionOf("file.TXT")).toBe("txt");
      expect(extensionOf("file.test.js")).toBe("js");
    });
    it("should return empty string if no extension", () => {
      expect(extensionOf("Dockerfile")).toBe("");
    });
  });

  describe("getParserForFilename / isParsable", () => {
    it("should return a parser for known extensions", () => {
      expect(getParserForFilename("file.php")).not.toBeNull();
      expect(isParsable("file.php")).toBe(true);

      expect(getParserForFilename("file.c")).not.toBeNull();
      expect(isParsable("file.c")).toBe(true);

      expect(getParserForFilename("file.js")).not.toBeNull();
      expect(isParsable("file.js")).toBe(true);
    });

    it("should return null for unknown extensions", () => {
      expect(getParserForFilename("file.unknown")).toBeNull();
      expect(isParsable("file.unknown")).toBe(false);
    });

    it("should return null for extensionless file without sourceText", () => {
      expect(getParserForFilename("myscript")).toBeNull();
      expect(isParsable("myscript")).toBe(false);
    });

    it("should detect parser from shebang", () => {
      expect(getParserForFilename("myscript", "#!/usr/bin/env python3\n")).not.toBeNull();
      expect(getParserForFilename("myscript", "#!/bin/bash\n")).not.toBeNull();
      expect(getParserForFilename("myscript", "#!/usr/bin/node\n")).not.toBeNull();
      
      expect(isParsable("myscript", "#!/usr/bin/env python3\n")).toBe(true);
    });

    it("should detect parser from shebang where interpreter is missing env", () => {
      expect(getParserForFilename("myscript", "#!/usr/bin/python\n")).not.toBeNull();
    });

    it("should handle shebangs without newlines", () => {
      expect(getParserForFilename("myscript", "#!/bin/bash")).not.toBeNull();
    });

    it("should handle shebangs with env but no argument", () => {
      expect(getParserForFilename("myscript", "#!/usr/bin/env\n")).toBeNull();
    });

    it("should ignore invalid shebangs", () => {
      expect(getParserForFilename("myscript", "#!/usr/bin/env unknown\n")).toBeNull();
      expect(getParserForFilename("myscript", "just some text\n")).toBeNull();
      expect(getParserForFilename("myscript", "#! \n")).toBeNull();
      expect(getParserForFilename("myscript", "#!\n")).toBeNull();
    });
  });

  describe("parseFile", () => {
    it("should return null if no parser handles the file", async () => {
      const result = await parseFile("file.unknown", "text");
      expect(result).toBeNull();
    });

    it("should return null and warn if file is unsafe to parse", async () => {
      vi.spyOn(security, "isSafeToParse").mockReturnValue({ ok: false, reason: "too large" });
      const result = await parseFile("file.php", "text");
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping \"file.php\": too large"));
    });

    it("should return parsed file if successful", async () => {
      vi.spyOn(security, "isSafeToParse").mockReturnValue({ ok: true });
      const parser = getParserForFilename("file.php");
      if (parser) {
        vi.spyOn(parser, "parse").mockResolvedValue({ language: "php" } as any);
      }
      const result = await parseFile("file.php", "<?php echo 1;");
      expect(result).toEqual({ language: "php" });
    });

    it("should return null and warn if parser throws", async () => {
      vi.spyOn(security, "isSafeToParse").mockReturnValue({ ok: true });
      const parser = getParserForFilename("file.php");
      if (parser) {
        vi.spyOn(parser, "parse").mockRejectedValue(new Error("parse error"));
      }
      const result = await parseFile("file.php", "<?php error");
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping "file.php": parse failed'),
        expect.any(Error)
      );
    });
  });
});
