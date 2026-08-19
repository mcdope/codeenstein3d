// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Asserts that every named Playwright browser is already installed where this
 * `playwright` package expects it — i.e. that the CI container image carries
 * the browser *builds* this version resolves to.
 *
 * CI runs the browser jobs inside `mcr.microsoft.com/playwright:<version>`
 * rather than installing browsers and their OS libraries per run. That removed
 * `playwright install-deps`, an apt-get against Azure's mirrors run seven times
 * per workflow. Its *mean* was never the problem and the swap does not improve
 * it — 206-210s of apt became 196-240s of image pull. Its **tail** was: three
 * pre-container master runs cost 210s, **5903s** and 206s, the middle one
 * spending 2358s/2119s/865s/493s in four separate apt steps. A deliberate
 * trade of ~30s of mean for the removal of that. See `doc/dev/history.md`.
 *
 * The cost of that is a coupling: the image tag and the npm package must move
 * together, because the image bakes in specific browser builds. Left
 * unchecked, a bump to one and not the other surfaces as a launch failure deep
 * inside some unrelated test. This checks the real invariant — does the
 * resolved executable exist — rather than comparing version strings, which
 * would only test that two literals in the workflow agree with each other.
 *
 * Usage: `node scripts/assert-browsers-present.mjs chromium [firefox] [webkit]`
 */
import fs from "node:fs";
import * as playwright from "playwright";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: assert-browsers-present.mjs <browser>...");
  process.exit(2);
}

let missing = false;
for (const name of names) {
  const browserType = playwright[name];
  if (!browserType) {
    console.error(`::error::unknown browser "${name}"`);
    missing = true;
    continue;
  }
  const executable = browserType.executablePath();
  const present = fs.existsSync(executable);
  console.log(`${name}: ${present ? "ok" : "MISSING"} ${executable}`);
  if (!present) missing = true;
}

if (missing) {
  console.error(
    "::error::the container image does not carry the browser build this playwright " +
      "version expects — bump the image tag in .github/workflows/verify.yml and the " +
      "npm package together",
  );
  process.exit(1);
}
