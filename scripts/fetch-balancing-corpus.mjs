// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Fetches a corpus of real repositories for the offline balance solver to run
 * against — because the whole problem the solver exists to solve is that
 * levels come from *someone else's* source, and `demo-campaign/` is a sample
 * of one that was written to show the generator off.
 *
 * ```sh
 * npm run balancing:corpus            # fetch anything missing
 * npm run balancing:corpus -- --list  # print the manifest, fetch nothing
 * ```
 *
 * Downloads each entry's GitHub source archive, keeps only files the parser
 * has an adapter for, and writes them under `balancing_corpus/<id>/`
 * (gitignored). Idempotent: an entry whose directory already exists is
 * skipped, so re-running costs one `existsSync` per entry.
 *
 * **It degrades instead of failing.** A dead entry, a moved tag or no network
 * leaves that one repo missing and the rest of the corpus usable, and the exit
 * code stays 0. This is deliberate and specific:
 * `scripts/fetch-online-wads.mjs` takes the opposite line and `process.exit(1)`s
 * on any failure, and because it runs as the `predev`/`prebuild` hook, one 404
 * upstream takes down `npm run dev` and `npm run build` (logged in `notes`).
 * Nothing here is load-bearing either, so there is no reason to repeat it.
 *
 * No new dependency: archives are read with the repo's own
 * `scripts/lib/zipReader.mjs`, the same hand-rolled reader the WAD fetcher
 * uses. See `doc/dev/decisions.md`'s "Dependency Minimalism".
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { extractAllFromZip } from "./lib/zipReader.mjs";

const CORPUS_DIR = path.join(REPO_ROOT, "balancing_corpus");

/**
 * Extensions the parser registry has an adapter for. Mirrored deliberately and
 * narrowly: the registry's own `extensionOf`/`BY_EXTENSION` needs the
 * tree-sitter wasm bundle loaded, which costs seconds and a browser-shaped
 * import graph, and this list is only used to decide what to *keep on disk*.
 * If it drifts, the cost is an unparsable file sitting unused in a corpus
 * directory — `report-level-budget.mjs` skips whatever fails to parse and says
 * so. Nothing silently misreports.
 */
const SOURCE_EXTENSIONS = new Set([
  "c", "h", "cpp", "cc", "hpp", "cs", "go", "java", "js", "jsx", "m", "php",
  "py", "rb", "rs", "scala", "sh", "ts", "tsx",
]);

/**
 * Directory names to drop, mirroring `src/fs/workspace.ts`'s
 * `IGNORED_DIRECTORIES` — same caveat as `SOURCE_EXTENSIONS`, and the same
 * harmless failure mode. Keeping vendored dependencies would let a repo's
 * `node_modules` dominate its own level count, which would measure npm rather
 * than the repo.
 */
const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".cache", ".idea", ".vscode",
  "vendor", "__pycache__", "test", "tests", "__tests__",
]);

/**
 * The corpus. `ref` is a tag or commit, never a branch — a branch would make
 * every fetch a different corpus and quietly break comparability between two
 * budget reports, which is the one property this has to have.
 *
 * Chosen to spread both axes the generator is sensitive to: raw size (how many
 * levels a repo becomes) and language (which adapter, and how much the
 * complexity metric actually finds). `bucket` is documentation, not behaviour.
 */
const CORPUS = [
  { id: "kilo", owner: "antirez", repo: "kilo", ref: "master", bucket: "tiny", language: "C", note: "~1k LOC single-file text editor" },
  { id: "cJSON", owner: "DaveGamble", repo: "cJSON", ref: "v1.7.18", bucket: "small", language: "C" },
  { id: "click", owner: "pallets", repo: "click", ref: "8.1.7", bucket: "small", language: "Python" },
  { id: "chi", owner: "go-chi", repo: "chi", ref: "v5.1.0", bucket: "small", language: "Go" },
  { id: "ms", owner: "vercel", repo: "ms", ref: "2.1.3", bucket: "tiny", language: "JavaScript" },
  { id: "flask", owner: "pallets", repo: "flask", ref: "3.0.3", bucket: "medium", language: "Python" },
  { id: "axios", owner: "axios", repo: "axios", ref: "v1.7.7", bucket: "medium", language: "JavaScript" },
  { id: "ripgrep", owner: "BurntSushi", repo: "ripgrep", ref: "14.1.1", bucket: "large", language: "Rust" },
  // Added 2026-08-05 for the five-repo balance run. Two of these have no tags
  // at all, which is what forced `archiveUrl` to learn commit shas below.
  { id: "wolf3d", owner: "id-Software", repo: "wolf3d", ref: "05167784ef00", bucket: "small", language: "C", note: "the original 1992 source; archived 2012, so the sha is stable by nature" },
  { id: "stb", owner: "nothings", repo: "stb", ref: "2c980bb59875", bucket: "small", language: "C", note: "single-header libs — almost every file is .h, which `planLevels` turns into a *bonus* level, so this generates an all-bonus campaign" },
  { id: "curl", owner: "curl", repo: "curl", ref: "curl-8_21_0", bucket: "large", language: "C", note: "its most-recently-created tag is a `tiny-curl-*` variant, not a release — pin the `curl-*` one deliberately" },
  { id: "laravel", owner: "laravel", repo: "framework", ref: "v13.24.0", bucket: "huge", language: "PHP", note: "~2.5k parsable files; the largest thing the solver has been pointed at" },
];

/** 7-40 hex characters and nothing else — GitHub's own abbreviation floor is 7,
 * so anything shorter is a tag that merely looks hex-ish. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

function archiveUrl(entry) {
  // codeload serves `/zip/<sha>` bare, but `/zip/refs/tags/<sha>` 404s — which
  // is what this used to build for anything that was not `master`/`main`. The
  // manifest's own doc promised commits were allowed and the URL builder could
  // not honour it; two of the repos above have no tags, so it has to now.
  const ref = COMMIT_SHA.test(entry.ref)
    ? entry.ref
    : entry.ref === "master" || entry.ref === "main"
      ? `refs/heads/${entry.ref}`
      : `refs/tags/${entry.ref}`;
  return `https://codeload.github.com/${entry.owner}/${entry.repo}/zip/${ref}`;
}

/** True for an archive path worth keeping: a parsable extension, no ignored
 * directory anywhere in its path. The leading component is GitHub's
 * `<repo>-<ref>/` wrapper and is dropped by the caller, not here. */
function wanted(entryPath) {
  const parts = entryPath.split("/");
  if (parts.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir.toLowerCase()))) return false;
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchEntry(entry) {
  const dest = path.join(CORPUS_DIR, entry.id);
  if (fs.existsSync(dest)) {
    console.log(`  ${entry.id}: already present — skipping`);
    return { ok: true, skipped: true };
  }

  const url = archiveUrl(entry);
  const zip = await download(url);
  const files = extractAllFromZip(zip, wanted);
  if (files.length === 0) throw new Error("archive contained no parsable source files");

  // Write to a temp directory and rename, so an interrupted fetch cannot leave
  // a half-populated directory that the `existsSync` check above would then
  // treat as complete on the next run.
  const staging = `${dest}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    // Strip GitHub's `<repo>-<ref>/` wrapper directory.
    const relative = file.name.split("/").slice(1).join("/");
    const target = path.join(staging, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  fs.renameSync(staging, dest);
  console.log(`  ${entry.id}: ${files.length} source files (${entry.language}, ${entry.bucket})`);
  return { ok: true, fileCount: files.length };
}

async function main() {
  if (process.argv.includes("--list")) {
    console.log("id          bucket   language     ref            source");
    for (const e of CORPUS) {
      console.log(`${e.id.padEnd(11)} ${e.bucket.padEnd(8)} ${e.language.padEnd(12)} ${e.ref.padEnd(14)} ${e.owner}/${e.repo}`);
    }
    return;
  }

  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  console.log(`Fetching balancing corpus into ${path.relative(REPO_ROOT, CORPUS_DIR)}/`);

  const failures = [];
  for (const entry of CORPUS) {
    try {
      await fetchEntry(entry);
    } catch (err) {
      // Degrade, never fail -- see this file's own doc comment.
      failures.push(entry.id);
      console.warn(`  ${entry.id}: SKIPPED — ${err.message}`);
    }
  }

  const present = fs.readdirSync(CORPUS_DIR).filter((d) => !d.endsWith(".partial"));
  console.log(`\n${present.length} of ${CORPUS.length} corpus entries available.`);
  if (failures.length > 0) {
    console.log(`Missing: ${failures.join(", ")} — the rest of the corpus is still usable.`);
  }
  console.log(`\nRun the solver over one with:\n  npm run balancing:budget -- --dir balancing_corpus/${present[0] ?? "<id>"}`);
}

main().catch((err) => {
  // Only reached for a programming error -- per-entry failures are caught above.
  console.error(err);
  process.exit(1);
});
