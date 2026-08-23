// Regression tests for the secret scanner.
//
// These reconstruct the 2026-08-23 incident end to end: a value out of a
// gitignored file reaching (a) a tracked file, (b) a commit message, and
// (c) a PR description. All three channels leaked that day; all three are
// asserted here. No real secret appears in this file — the exact layer is
// exercised through SECRET_SCAN_DENYLIST with a synthetic value.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCANNER = "scripts/check-secrets.mjs";
const FAKE = "svcacct@lane-seven.example-internal.test"; // synthetic; not a real host
const tmp = mkdtempSync(join(tmpdir(), "secret-scan-"));

/** Run the scanner; returns {code, out} with stdout+stderr merged. */
function scan(args, { denylist } = {}) {
  const r = spawnSync("node", [SCANNER, ...args], {
    encoding: "utf8",
    env: { ...process.env, SECRET_SCAN_DENYLIST: denylist ?? "" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function fileWith(name, text) {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

describe("secret scanner — the three channels that leaked", () => {
  it("flags a denylisted value in arbitrary text (the PR-description channel)", () => {
    const p = fileWith("pr-body.md", `## Summary\n\nScrubbed the lanes, e.g. ${FAKE}.\n`);
    const { code, out } = scan(["--text", p], { denylist: FAKE });
    expect(code).toBe(1);
    expect(out).toContain("[exact]");
  });

  it("flags a denylisted value in a commit message", () => {
    const p = fileWith("COMMIT_EDITMSG", `fix: drop ${FAKE} from the docs\n\n# comment line\n`);
    const { code, out } = scan(["--message", p], { denylist: FAKE });
    expect(code).toBe(1);
    expect(out).toContain("[exact]");
  });

  it("ignores git's own comment lines in a commit message", () => {
    const p = fileWith("COMMIT_EDITMSG_ok", `docs: tidy\n\n# On branch x\n# ${FAKE}\n`);
    expect(scan(["--message", p], { denylist: FAKE }).code).toBe(0);
  });

  // The invariant that keeps the scanner from becoming the next leak: CI logs
  // are public, so a failure report must locate the hit without reproducing it.
  it("never prints the matched value", () => {
    const p = fileWith("leak.md", `see ${FAKE} here\n`);
    const { code, out } = scan(["--text", p], { denylist: FAKE });
    expect(code).toBe(1);
    expect(out).not.toContain(FAKE);
    expect(out).not.toContain("lane-seven");
  });
});

describe("secret scanner — structural rules need no prior knowledge", () => {
  it("flags an unknown login target with no denylist at all", () => {
    const p = fileWith("notes.md", "ran the capture on svc@box-nine.lan overnight\n");
    const { code, out } = scan(["--text", p]);
    expect(code).toBe(1);
    expect(out).toContain("[ssh-target]");
  });

  it("flags a routable IP but not a private or loopback one", () => {
    expect(scan(["--text", fileWith("pub.md", "host 51.15.207.9 replied\n")]).code).toBe(1);
    expect(scan(["--text", fileWith("priv.md", "bound 192.168.1.10 and 127.0.0.1 and 10.0.0.5\n")]).code).toBe(0);
  });

  it("does not fire on version numbers or the public homepage", () => {
    const p = fileWith("ok.md", "bumped to 1.62.1 — see https://codeenstein3d.mcdope.org/ and git@github.com:x/y.git\n");
    expect(scan(["--text", p]).code).toBe(0);
  });
});

describe("secret scanner — findings are locatable", () => {
  it("reports the correct line number in a multi-line file", () => {
    const p = fileWith("multi.md", `line one\nline two\nsvc@box-nine.lan\nline four\n`);
    const { out } = scan(["--text", p]);
    expect(out).toMatch(/multi\.md:3\b/);
  });

  // Regression: staged mode reported every hit as line 1 because it fed the
  // diff to the scanner one line at a time without tracking the hunk offset.
  it("reports the correct line number for a staged addition", () => {
    const repo = mkdtempSync(join(tmpdir(), "secret-scan-repo-"));
    const g = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(join(repo, "doc.md"), "a\nb\nc\nd\ne\n");
    g("add", "doc.md");
    g("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
    writeFileSync(join(repo, "doc.md"), "a\nb\nc\nd\nsvc@box-nine.lan\n");
    g("add", "doc.md");
    const r = spawnSync("node", [join(process.cwd(), SCANNER), "--staged"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, SECRET_SCAN_DENYLIST: "" },
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/doc\.md:5\b/);
  });
});

describe("secret scanner — repository state", () => {
  // Guards the allowlists against rot: if someone widens ALLOW_PATHS or lands a
  // real host, this fails on master rather than in a review.
  it("reports the tracked tree as clean", () => {
    const { code, out } = scan(["--tree"]);
    expect(out).toContain("clean");
    expect(code).toBe(0);
  });
});
