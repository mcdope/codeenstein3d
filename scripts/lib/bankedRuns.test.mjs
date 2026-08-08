// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBankedRunScanner } from "./bankedRuns.mjs";

let root;

/** Counts `readFileSync` calls so caching is asserted by reads, not by timing. */
function countingFs() {
  const calls = { reads: 0 };
  return {
    calls,
    fs: {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
      readFileSync: (...args) => {
        calls.reads += 1;
        return fs.readFileSync(...args);
      },
    },
  };
}

const write = (dir, name, lines) => {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "banked-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBankedRunScanner", () => {
  it("counts distinct rids across a combo's invocation directories", () => {
    write("Pro-hard-001", "Pro-hard.ndjson", [{ rid: "a" }, { rid: "a" }, { rid: "b" }]);
    write("Pro-hard-002", "Pro-hard.ndjson", [{ rid: "c" }]);
    write("Casual-hard-001", "Casual-hard.ndjson", [{ rid: "z" }]);
    const scan = createBankedRunScanner(root);
    expect(scan("Pro-hard-")).toEqual({ qualifying: 3, fileCount: 2 });
    expect(scan("Casual-hard-")).toEqual({ qualifying: 1, fileCount: 1 });
  });

  it("dedupes a run banked twice, which a retried invocation produces", () => {
    write("Pro-hard-001", "Pro-hard.ndjson", [{ rid: "dup" }]);
    write("Pro-hard-002", "Pro-hard.ndjson", [{ rid: "dup" }]);
    expect(createBankedRunScanner(root)("Pro-hard-").qualifying).toBe(1);
  });

  it("does not re-read a directory whose files have not changed", () => {
    write("Pro-hard-001", "Pro-hard.ndjson", [{ rid: "a" }]);
    const { fs: spy, calls } = countingFs();
    const scan = createBankedRunScanner(root, { fs: spy });
    expect(scan("Pro-hard-").qualifying).toBe(1);
    expect(calls.reads).toBe(1);
    scan("Pro-hard-");
    scan("Pro-hard-");
    expect(calls.reads).toBe(1); // still 1 — the finished directory is cached
  });

  it("re-reads a directory that an in-flight invocation appended to", () => {
    // The correctness risk of caching: a running invocation is still writing,
    // and a stale count would make the scheduler think a cell was short.
    write("Pro-hard-001", "Pro-hard.ndjson", [{ rid: "a" }]);
    const { fs: spy, calls } = countingFs();
    const scan = createBankedRunScanner(root, { fs: spy });
    expect(scan("Pro-hard-").qualifying).toBe(1);
    fs.appendFileSync(path.join(root, "Pro-hard-001", "Pro-hard.ndjson"), JSON.stringify({ rid: "b" }) + "\n");
    expect(scan("Pro-hard-").qualifying).toBe(2);
    expect(calls.reads).toBe(2);
  });

  it("picks up a whole new invocation directory without re-reading the old ones", () => {
    write("Pro-hard-001", "Pro-hard.ndjson", [{ rid: "a" }]);
    const { fs: spy, calls } = countingFs();
    const scan = createBankedRunScanner(root, { fs: spy });
    scan("Pro-hard-");
    write("Pro-hard-002", "Pro-hard.ndjson", [{ rid: "b" }]);
    expect(scan("Pro-hard-").qualifying).toBe(2);
    expect(calls.reads).toBe(2); // the new directory only
  });

  it("keeps everything before a truncated final line, which is the SIGKILL case", () => {
    fs.mkdirSync(path.join(root, "Pro-hard-001"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "Pro-hard-001", "Pro-hard.ndjson"),
      `${JSON.stringify({ rid: "a" })}\n${JSON.stringify({ rid: "b" })}\n{"rid":"c`,
    );
    expect(createBankedRunScanner(root)("Pro-hard-").qualifying).toBe(2);
  });

  it("returns zero for a capture that has not written anything yet", () => {
    expect(createBankedRunScanner(path.join(root, "nope"))("Pro-hard-")).toEqual({ qualifying: 0, fileCount: 0 });
  });
});
