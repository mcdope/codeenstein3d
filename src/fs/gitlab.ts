// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * GitLab repository loading.
 *
 * Three things differ from GitHub and each one is load-bearing:
 *
 * **Nested groups.** A GitLab project can live arbitrarily deep —
 * `group/subgroup/project` — so `owner` here holds the whole namespace path
 * rather than a single user. Everywhere a project is addressed, that full path
 * is `%2F`-encoded into one path segment, which is GitLab's documented way of
 * naming a project without knowing its numeric id.
 *
 * **The tree is paginated** at 100 entries, where GitHub returns the lot in one
 * call. See `MAX_TREE_PAGES` for why that needs a cap rather than a loop that
 * runs to completion.
 *
 * **The rate-limit headers are invisible to a page.** gitlab.com sends
 * `ratelimit-remaining`/`ratelimit-reset`, but its
 * `Access-Control-Expose-Headers` list does not include them (verified
 * 2026-08-20), so a browser cannot read them however present they are on the
 * wire. A header-gated check here would not be conservative, it would be dead
 * — the same trap `github.ts` documents for raw.githubusercontent.com. Status
 * alone is the signal.
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

const GITLAB_API = "https://gitlab.com/api/v4";

interface GitlabTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

/** The project's full namespace path as one `%2F`-encoded segment. */
function projectId(ref: RemoteRepoRef): string {
  return encodeURIComponent(`${ref.owner}/${ref.repo}`);
}

/**
 * Parses a gitlab.com URL or a `group/project` shorthand, keeping any nested
 * groups — everything before the last `/` is the namespace.
 *
 * GitLab URLs can carry a `/-/tree/branch` suffix and similar; anything from a
 * `/-/` segment onward is dropped, since the project path ends there.
 */
export function parseGitlabRepoInput(input: string): RemoteRepoRef | null {
  let trimmed = input.trim().replace(/\.git$/i, "");
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/(.+)$/i);
  if (urlMatch) {
    trimmed = urlMatch[1];
  } else if (/^https?:\/\//i.test(trimmed) || /^[^/\s]+\.[a-z]{2,}\//i.test(trimmed)) {
    // A URL, but not a gitlab.com one — reject it rather than reading the
    // host as the first nested group. Supporting arbitrarily deep namespaces
    // means the shorthand branch accepts any number of segments, which made
    // this parser claim `codeberg.org/owner/repo` as the project `repo` in
    // the group `codeberg.org/owner`. Every other adapter is anchored to two
    // segments and so was immune; this one has to say no explicitly.
    return null;
  }
  trimmed = trimmed.split("/-/")[0].replace(/\/+$/, "");
  if (!trimmed || /\s/.test(trimmed)) return null;

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments.slice(0, -1).join("/"), repo: segments[segments.length - 1] };
}

function describeHttpFailure(res: Response, whatFailed: string): string {
  // See the module note: the budget headers are not CORS-exposed, so a 429 is
  // taken at face value rather than confirmed against a remaining count.
  if (res.status === 429) return rateLimitMessage("GitLab", "");
  return `${whatFailed} (${res.status} ${res.statusText})`;
}

async function resolveDefaultBranch(ref: RemoteRepoRef, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${GITLAB_API}/projects/${projectId(ref)}`, { signal });
  if (!res.ok) {
    throw new Error(describeHttpFailure(res, `Repository "${ref.owner}/${ref.repo}" not found or inaccessible`));
  }
  return ((await res.json()) as { default_branch: string }).default_branch;
}

export async function fetchGitlabTree(
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
      `${GITLAB_API}/projects/${projectId(ref)}/repository/tree` +
        `?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`,
      { signal },
    );
    if (!res.ok) throw new Error(describeHttpFailure(res, "Failed to fetch repository tree"));

    const entries = await readJsonWithProgress<GitlabTreeEntry[]>(
      res,
      // Cumulative across pages, so the player's counter climbs instead of
      // restarting at zero on each page.
      onTreeBytes && ((bytes) => onTreeBytes(received + bytes)),
    );
    for (const entry of entries) if (entry.type === "blob") paths.push(entry.path);
    received += entries.length * 128; // rough, only ever a progress readout

    // `x-next-page` is empty on the last page. It is CORS-exposed (unlike the
    // rate-limit headers), but a short page answers the same question without
    // depending on a header at all, which is what the fallback is for.
    const next = res.headers?.get("x-next-page");
    if (entries.length < 100 || !next) break;
    if (page === MAX_TREE_PAGES) truncated = true;
  }

  const tree = buildRemoteTree(
    ref.repo,
    paths,
    (path) =>
      new CachedRemoteFileHandle(
        // The file path is a single `%2F`-encoded segment here too. An
        // unencoded nested path 404s — verified against gitlab.com rather than
        // assumed, because the failure looks like a missing file.
        `${GITLAB_API}/projects/${projectId(ref)}/repository/files/${encodeURIComponent(path)}/raw` +
          `?ref=${encodeURIComponent(branch)}`,
        (res, url) => describeHttpFailure(res, `Failed to fetch "${url}"`),
      ),
  );

  if (truncated) {
    tree.truncated = true;
    console.log(
      `[gitlab] The tree for "${ref.owner}/${ref.repo}" was truncated after ${MAX_TREE_PAGES} pages — ` +
        `this repo is large enough that some files are missing. The campaign still plays, built from ` +
        `what was returned; clone the repo and use the Local tab to get all of it.`,
    );
  }

  return tree;
}

export const GITLAB_HOST: RemoteHost = {
  id: "gitlab",
  label: "GitLab",
  parseInput: parseGitlabRepoInput,
  fetchTree: fetchGitlabTree,
};
