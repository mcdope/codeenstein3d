// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Pure-logic verification of `scripts/lib/zipReader.mjs` against synthetic
 * fixtures (`fixtures/buildTestZip.mjs`) — no real-world ZIP needed. Covers
 * a STORED entry, a DEFLATE entry, an entry that isn't first in the central
 * directory, a missing entry, and a corrupt/missing EOCD record.
 */
import { buildTestZip } from "./fixtures/buildTestZip.mjs";
import { extractFileFromZip } from "./lib/zipReader.mjs";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function main() {
  console.log("STORED entry:");
  {
    const data = Buffer.from("hello stored world");
    const zip = buildTestZip([{ name: "stored.txt", data, method: "stored" }]);
    const out = extractFileFromZip(zip, "stored.txt");
    check("round-trips exactly", out.equals(data), `got ${out.length} bytes`);
  }

  console.log("\nDEFLATE entry:");
  {
    const data = Buffer.from("hello deflate world".repeat(50));
    const zip = buildTestZip([{ name: "deflated.txt", data, method: "deflate" }]);
    const out = extractFileFromZip(zip, "deflated.txt");
    check("round-trips exactly", out.equals(data), `got ${out.length} bytes`);
  }

  console.log("\nMulti-entry archive, target not first:");
  {
    const a = Buffer.from("first entry");
    const b = Buffer.from("second entry, this is the one we want".repeat(20));
    const c = Buffer.from("third entry");
    const zip = buildTestZip([
      { name: "a.txt", data: a, method: "stored" },
      { name: "b.txt", data: b, method: "deflate" },
      { name: "c.txt", data: c, method: "stored" },
    ]);
    check("finds and extracts the middle entry", extractFileFromZip(zip, "b.txt").equals(b));
    check("finds and extracts the last entry", extractFileFromZip(zip, "c.txt").equals(c));
  }

  console.log("\nMissing entry:");
  {
    const zip = buildTestZip([{ name: "only.txt", data: Buffer.from("x"), method: "stored" }]);
    let threw = false;
    try {
      extractFileFromZip(zip, "nope.txt");
    } catch {
      threw = true;
    }
    check("throws for a name not present", threw);
  }

  console.log("\nCorrupt/missing EOCD:");
  {
    const zip = buildTestZip([{ name: "a.txt", data: Buffer.from("x"), method: "stored" }], { corruptEocd: true });
    let threw = false;
    try {
      extractFileFromZip(zip, "a.txt");
    } catch {
      threw = true;
    }
    check("throws instead of silently misparsing", threw);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
