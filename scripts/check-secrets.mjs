#!/usr/bin/env node
// Secret scanner: stops values that live in gitignored files from reaching a
// tracked file, a commit message, or a PR body.
//
// Written after 2026-08-23, when four `user@host` SSH lane targets were copied
// out of the gitignored `ssh-hosts.env` into `notes` and `doc/dev/history.md`
// (public repo, three weeks), and then *re-published in the PR body of the PR
// that removed them*. Intent was not sufficient twice, so this is mechanical.
//
// Two independent layers, because each covers the other's blind spot:
//
//   exact      — hashes nothing, compares against the real values, zero false
//                positives. Available locally (reads the gitignored env files)
//                and in CI (reads $SECRET_SCAN_DENYLIST, a repo secret).
//   structural — shape-based rules that need no knowledge of the values, so
//                they still fire in a fresh clone or a fork PR. Tuned against
//                this tree; false positives go in ALLOW below.
//
// HARD RULE: this script never prints a matched value. It reports location and
// rule name only. A scanner that echoes what it found turns every public CI log
// into the leak it was meant to prevent.
//
// Usage:
//   --staged            scan staged additions (pre-commit hook)
//   --message <file>    scan a commit message (commit-msg hook)
//   --tree              scan every tracked file (CI)
//   --text <file>       scan an arbitrary file (PR bodies, release notes)
//   --stdin             scan stdin
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });

// ---------------------------------------------------------------- exact layer

// Any gitignored env-ish file is a source of secrets by definition: it was put
// out of the repo on purpose. Discover them rather than hardcoding a list, so a
// new one is covered the day it appears.
function ignoredEnvFiles() {
  const candidates = ["ssh-hosts.env", "docker/.env", ".env", ".env.local"];
  try {
    // Pathspecs, not a bare listing: `--others --ignored` over this repo emits
    // ~1 MB of .verify-tmp/ artefacts and blows execFileSync's buffer.
    const found = git(
      "ls-files", "--others", "--ignored", "--exclude-standard",
      "--", "*.env", ".env*", "*-hosts.env", "docker/.env",
    ).split("\n").filter(Boolean);
    candidates.push(...found);
  } catch {
    /* not a git repo (CI tarball) — fall back to the fixed list */
  }
  return [...new Set(candidates)].filter((f) => existsSync(f));
}

const PLACEHOLDER = /^(|changeme|xxx+|your[-_ ]?\w*|<.*>|example|placeholder|todo|none|null|true|false|\d{1,4})$/i;

function exactValues() {
  const out = new Set();
  const add = (raw) => {
    let v = String(raw).trim().replace(/^["']|["']$/g, "");
    if (v.length < 6 || PLACEHOLDER.test(v)) return; // too short/generic to match on safely
    out.add(v);
    // Deliberately NOT split into user/host parts. One lane's host is the
    // project's own public homepage domain, which appears legitimately in
    // package.json, README.md, index.html and the sitemap — indexing on it
    // produced 20 false positives. A host that is genuinely private is caught
    // by the `private-hostname` / `public-ipv4` structural rules instead.
  };

  for (const f of ignoredEnvFiles()) {
    for (let line of readFileSync(f, "utf8").split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      const isKeyed = eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq));
      // Vite inlines every VITE_-prefixed var into the client bundle, so those
      // values are published on purpose — the deploy workflow, index.html and
      // the sitemap all carry them legitimately. Only non-VITE keys are secret.
      if (isKeyed && /^VITE_/.test(line.slice(0, eq))) continue;
      // `KEY=value` files and bare-value files (ssh-hosts.env) both appear here.
      add(isKeyed ? line.slice(eq + 1) : line);
    }
  }
  // CI has no gitignored files. Repo secret SECRET_SCAN_DENYLIST carries the
  // same values (newline- or comma-separated); Actions masks it in logs.
  for (const v of (process.env.SECRET_SCAN_DENYLIST || "").split(/[\n,]/)) if (v.trim()) add(v);

  return [...out].sort((a, b) => b.length - a.length);
}

// ----------------------------------------------------------- structural layer

const RULES = [
  {
    name: "ssh-target",
    why: "looks like a `user@host` login target",
    re: /\b[a-z_][a-z0-9_-]{0,31}@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})\b/gi,
  },
  {
    name: "private-hostname",
    why: "looks like an internal hostname",
    // Requires a host-position delimiter before it, so `enemy.patrol.home`
    // (a property chain) does not match while `ssh box.lan` does.
    re: /(?:^|[\s"'`=@:/([])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:lan|internal|intranet|corp))(?=[\s"'`:/,)\]]|$)/gim,
  },
  {
    name: "public-ipv4",
    why: "looks like a routable IP address",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    // Only routable addresses are interesting; loopback/private/link-local and
    // version-number-shaped noise are not.
    filter: (m) => {
      const o = m.split(".").map(Number);
      if (o.some((n) => n > 255)) return false;
      const [a, b] = o;
      if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
      return true;
    },
  },
];

// Known-good matches. Keep this list short and justified — every entry is a
// hole. Values here are already public by intent (docs, package metadata).
const ALLOW = [
  /\bnoreply@anthropic\.com\b/i,
  /\btobiasbaeumer@gmail\.com\b/i, // the repo author's own published git identity
  /\bcodeenstein3d\.mcdope\.org\b/i, // the public homepage (package.json)
  /\bgit@github\.com\b/i, // the SSH remote URL; public and in every clone
  /^(alice|bob|user|username|you|someone|example)@/i, // documentation placeholders
  /^(?:8\.8\.(?:8\.8|4\.4)|1\.1\.1\.1|9\.9\.9\.9)$/, // well-known public resolvers, cited in docs
];
const allowed = (m) => ALLOW.some((re) => re.test(m));

// Files whose whole purpose is to carry host-shaped *examples*. Structural
// (shape-only) rules are suppressed here; the exact layer still applies, so a
// real value pasted into one of these is still caught. Keep this list to files
// that would otherwise fire on every run — a doc or note must never be on it,
// because docs are where the 2026-08-23 leak actually happened.
const ALLOW_PATHS = [
  "ssh-hosts.env.dist", // the template: its examples are deliberately host-shaped
  "docker/coturn/turnserver.conf.base", // denied-peer-ip ACL ranges
  "scripts/multiplayer-server.mjs", // IPv4 parsing, example addresses in doc comments
  "scripts/multiplayer-server.test.mjs", // trusted-proxy CIDR fixtures
  "scripts/verify-multiplayer-server.mjs", // RFC 5737 documentation-range fixtures
  "scripts/check-secrets.mjs", // this file: the rules themselves are host-shaped
  "scripts/check-secrets.test.mjs", // synthetic fixtures, asserted to be caught
];

// --------------------------------------------------------------- scan engine

function scanText(text, label, exact, findings) {
  scanTextAt(text, label, 1, exact, findings);
}

/** As scanText, but the first line of `text` is line `first` of `label`. */
function scanTextAt(text, label, first, exact, findings) {
  const structural = !ALLOW_PATHS.includes(label);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = `${label}:${first + i}`;
    for (const v of exact) {
      if (line.includes(v)) {
        findings.push({ at, rule: "exact", why: "matches a value from a gitignored file" });
        return; // one finding per line is enough; never narrow down in output
      }
    }
    if (!structural) return;
    for (const r of RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line))) {
        const hit = m[1] ?? m[0];
        if (allowed(hit)) continue;
        if (r.filter && !r.filter(hit)) continue;
        findings.push({ at, rule: r.name, why: r.why });
        return;
      }
    }
  });
}

// ---------------------------------------------------------------------- modes

const argv = process.argv.slice(2);
const mode = argv[0];
const arg = argv[1];
const exact = exactValues();
const findings = [];
let scope;

if (mode === "--staged") {
  scope = "staged changes";
  // Added lines only: the tree still carries pre-existing history, and a hook
  // that fails on someone else's old line gets bypassed with --no-verify.
  const diff = git("diff", "--cached", "--unified=0", "--no-color");
  let file = "?";
  let lineNo = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
    } else if (line.startsWith("@@")) {
      // `@@ -a,b +c,d @@` — c is where this hunk's added lines start in the new
      // file. Without this every finding was reported as line 1, which defeats
      // the "open the location and look" instruction the report ends with.
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? Number(m[1]) : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      scanTextAt(line.slice(1), file, lineNo, exact, findings);
      lineNo += 1;
    }
  }
  // A gitignored secret file being staged outright is its own failure.
  for (const f of git("diff", "--cached", "--name-only").split("\n").filter(Boolean)) {
    if (ignoredEnvFiles().includes(f)) findings.push({ at: f, rule: "secret-file-staged", why: "this file is gitignored and must never be committed" });
  }
} else if (mode === "--message") {
  scope = "commit message";
  // Strip comment lines git will drop anyway (they carry the status/diff).
  const body = readFileSync(arg, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n");
  scanText(body, "commit message", exact, findings);
} else if (mode === "--tree") {
  scope = "tracked files";
  for (const f of git("ls-files").split("\n").filter(Boolean)) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue; // binary
    scanText(text, f, exact, findings);
  }
} else if (mode === "--text" || mode === "--stdin") {
  scope = mode === "--stdin" ? "stdin" : arg;
  const text = mode === "--stdin" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  scanText(text, scope, exact, findings);
} else {
  console.error("usage: check-secrets.mjs --staged | --message <file> | --tree | --text <file> | --stdin");
  process.exit(2);
}

if (findings.length === 0) {
  console.log(`secret scan: clean (${scope}; ${exact.length} exact value(s), ${RULES.length} structural rules)`);
  process.exit(0);
}

console.error(`\nSECRET SCAN FAILED — ${findings.length} suspect location(s) in ${scope}:\n`);
for (const f of findings) console.error(`  ${f.at}  [${f.rule}] ${f.why}`);
console.error(`
The matched text is deliberately not shown; printing it here would leak it into
this log. Open the location above and look.

If it is a real secret: remove it, and describe it by KIND ("four user@host SSH
targets"), never by value — including in the commit message and the PR body.
If it is a false positive: add a narrow pattern to ALLOW in scripts/check-secrets.mjs
with a comment saying why it is public by intent.
`);
process.exit(1);
