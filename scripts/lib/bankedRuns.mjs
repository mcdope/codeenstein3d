// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Counts distinct runs banked on disk for one combo, incrementally.
 *
 * This number is the denominator of every rate a capture produces, and it is
 * read constantly: the scheduler consults *every* combo each time a lane frees
 * up, to decide where that lane goes. The naive version re-parses every NDJSON
 * the combo has ever written — tens of megabytes by the end of a cell — on
 * every one of those decisions.
 *
 * The saving is available for free because an invocation's log is
 * **append-only and then finished**: once its process exits, that directory's
 * contents never change again. So this caches per invocation directory, keyed
 * on a signature of the file sizes and mtimes in it. Any append changes the
 * size, so the cache invalidates itself on exactly the directories that are
 * still being written and holds for every directory that is done.
 *
 * Deduplication still happens across the whole combo — `rid`s are unioned from
 * the per-directory caches — because an invocation that is retried can bank the
 * same run twice, and counting it twice would overstate the denominator.
 *
 * `fs` is injectable so the cache's behaviour can be tested by counting reads
 * rather than by timing, the same injection style `levelSolver.mjs` uses.
 */
import nodeFs from "node:fs";
import path from "node:path";

/**
 * A signature that changes whenever any `.ndjson` in `dir` changes.
 *
 * Size alone would very nearly do — these files only ever grow — but mtime is
 * free here and covers a rewrite that happens to land on the same length.
 */
function directorySignature(fs, dir) {
  const files = [];
  let signature = "";
  let entries;
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return { files, signature: "<unreadable>" };
  }
  for (const file of entries) {
    if (!file.endsWith(".ndjson")) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, file));
    } catch {
      continue;
    }
    files.push(file);
    signature += `${file}:${stat.size}:${stat.mtimeMs};`;
  }
  return { files, signature };
}

function ridsInDirectory(fs, dir, cache) {
  const { files, signature } = directorySignature(fs, dir);
  const cached = cache.get(dir);
  if (cached && cached.signature === signature) return cached.rids;

  const rids = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue; // a half-fetched log counts as nothing, and gets re-run
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const rid = JSON.parse(line).rid;
        if (rid) rids.push(rid);
      } catch {
        // A truncated final line is the SIGKILL-mid-write case NDJSON exists
        // for — skip it, keep everything before it.
      }
    }
  }
  cache.set(dir, { signature, rids });
  return rids;
}

/**
 * Returns `scan(prefix) -> {qualifying, fileCount}` over `eventsDir`, where
 * `qualifying` is the number of distinct `rid`s banked by every invocation
 * directory whose name starts with `prefix`.
 *
 * `fileCount` counts matching entries, directory or not — it is a "how much has
 * this combo produced" signal for the logs, not a correctness input.
 */
export function createBankedRunScanner(eventsDir, { fs = nodeFs } = {}) {
  const cache = new Map();
  return function scanBanked(prefix) {
    if (!fs.existsSync(eventsDir)) return { qualifying: 0, fileCount: 0 };
    const rids = new Set();
    let fileCount = 0;
    for (const entry of fs.readdirSync(eventsDir)) {
      if (!entry.startsWith(prefix)) continue;
      fileCount += 1;
      const dir = path.join(eventsDir, entry);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const rid of ridsInDirectory(fs, dir, cache)) rids.add(rid);
    }
    return { qualifying: rids.size, fileCount };
  };
}
