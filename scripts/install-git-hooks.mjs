#!/usr/bin/env node
// Points git at the tracked .githooks/ directory. Run automatically by npm's
// `prepare` lifecycle (i.e. on every `npm install`/`npm ci`), so a fresh clone
// is protected without anyone remembering a setup step.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) process.exit(0); // tarball / submodule checkout — nothing to configure
try {
  const current = (() => {
    try { return execFileSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); }
    catch { return ""; }
  })();
  if (current !== ".githooks") {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
    console.log("git hooks: core.hooksPath -> .githooks (secret scan active)");
  }
} catch (err) {
  // Never fail an install over this; the CI scan is the backstop.
  console.warn(`git hooks: could not set core.hooksPath (${err.message})`);
}
