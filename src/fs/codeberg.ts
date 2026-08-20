// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Codeberg (Forgejo) repository loading.
 *
 * Forgejo's API is close enough to GitHub's that the tree entries have the
 * same `{ path, type: "blob" | "tree" }` shape and the response carries its
 * own `truncated` flag — but **it paginates at 100 entries**, which GitHub's
 * does not, so the tree is assembled across pages (see `MAX_TREE_PAGES`).
 *
 * Everything host-agnostic lives in `remoteHost.ts`.
 *
 * **This adapter targets codeberg.org specifically, not "Forgejo".** Any
 * self-hosted instance runs the same API, but whether a *browser* may call it
 * is a per-deployment CORS setting, so "Forgejo works" would be a claim about
 * one instance rather than about the software. codeberg.org sends
 * `Access-Control-Allow-Origin: *` on both the tree and raw endpoints
 * (verified 2026-08-20).
 */

import type { TreeNode } from "./workspace";
import {
  CachedRemoteFileHandle,
  MAX_TREE_PAGES,
  buildRemoteTree,
  rateLimitMessage,
  readJsonWithProgress,
  type RemoteHost,
  type RemoteRepoRef,
} from "./remoteHost";

const CODEBERG_API = "https://codeberg.org/api/v1";

interface ForgejoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

/** Parses `owner/repo` or a codeberg.org URL. Returns `null` rather than
 * throwing, so the caller can show it as plain input validation. */
export function parseCodebergRepoInput(input: string): RemoteRepoRef | null {
  const trimmed = input.trim().replace(/\.git$/i, "");
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?codeberg\.org\/([^/\s]+)\/([^/\s]+)\/?$/i);
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  const m = urlMatch ?? shortMatch;
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Codeberg answers a spent budget with a `429`, and unlike GitHub does not
 * expose a remaining-budget header a page could read — so status is the only
 * signal available and a `429` is taken at face value.
 */
function describeHttpFailure(res: Response, whatFailed: string): string {
  if (res.status === 429) return rateLimitMessage("Codeberg", "");
  return `${whatFailed} (${res.status} ${res.statusText})`;
}

async function resolveDefaultBranch(ref: RemoteRepoRef, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${CODEBERG_API}/repos/${ref.owner}/${ref.repo}`, { signal });
  if (!res.ok) {
    throw new Error(describeHttpFailure(res, `Repository "${ref.owner}/${ref.repo}" not found or inaccessible`));
  }
  return ((await res.json()) as { default_branch: string }).default_branch;
}

export async function fetchCodebergTree(
  ref: RemoteRepoRef,
  onTreeBytes?: (bytesReceived: number) => void,
  signal?: AbortSignal,
): Promise<TreeNode> {
  const branch = await resolveDefaultBranch(ref, signal);

  const paths: string[] = [];
  let truncated = false;
  let received = 0;

  for (let page = 1; page <= MAX_TREE_PAGES; page++) {
    const res = await fetch(
      `${CODEBERG_API}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}` +
        `?recursive=true&per_page=100&page=${page}`,
      { signal },
    );
    if (!res.ok) throw new Error(describeHttpFailure(res, "Failed to fetch repository tree"));

    const json = await readJsonWithProgress<{ tree?: ForgejoTreeEntry[]; truncated?: boolean }>(
      res,
      // Bytes accumulate *across* pages, so the counter keeps climbing rather
      // than resetting to zero on every page the way a per-response callback
      // would.
      onTreeBytes && ((bytes) => onTreeBytes(received + bytes)),
    );
    const entries = json.tree ?? [];
    for (const entry of entries) if (entry.type === "blob") paths.push(entry.path);
    received += entries.length * 128; // rough, and only ever used for a progress readout

    // Forgejo reports its own truncation, and a short page means the listing
    // ran out — either way there is nothing further to ask for.
    if (json.truncated) truncated = true;
    if (entries.length < 100) break;
    if (page === MAX_TREE_PAGES) truncated = true;
  }

  const tree = buildRemoteTree(
    ref.repo,
    paths,
    (path) =>
      new CachedRemoteFileHandle(
        `${CODEBERG_API}/repos/${ref.owner}/${ref.repo}/raw/${path}?ref=${encodeURIComponent(branch)}`,
        (res, url) => describeHttpFailure(res, `Failed to fetch "${url}"`),
      ),
  );

  if (truncated) {
    tree.truncated = true;
    // `console.log`, not `console.warn`: the in-game console sidebar mirrors
    // `console.log` only (`consoleSidebar.ts`), and this is a line the player
    // needs rather than one for devtools.
    console.log(
      `[codeberg] The tree for "${ref.owner}/${ref.repo}" was truncated — this repo is large enough ` +
        `that some files are missing. The campaign still plays, built from what was returned; clone ` +
        `the repo and use the Local tab to get all of it.`,
    );
  }

  return tree;
}

export const CODEBERG_HOST: RemoteHost = {
  id: "codeberg",
  label: "Codeberg",
  parseInput: parseCodebergRepoInput,
  fetchTree: fetchCodebergTree,
};
