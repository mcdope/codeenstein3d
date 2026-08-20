// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loads a public GitHub repository's file tree over the network, producing
 * the same `TreeNode` shape `readDirectoryTree` builds from a local
 * `FileSystemDirectoryHandle` — every downstream consumer (the file tree UI,
 * `flattenParsableFiles`, entrypoint detection, level launching, replay) only
 * ever reads `kind`/`name`/`path`/`children` and calls `handle.getFile()`, so
 * none of it needs to know or care that a node came from a repo instead of a
 * disk. File content is fetched lazily — not up front with the tree itself —
 * from raw.githubusercontent.com, which doesn't count against the REST API's
 * much stricter unauthenticated rate limit. The first fetch is usually the
 * file actually being parsed, though an extensionless file (see
 * `flattenParsableFiles`'s shebang sniff in `main.ts`) may trigger one
 * earlier just to check parsability; either way the result is cached, so a
 * given file is never fetched twice.
 */

import type { TreeNode } from "./workspace";
import {
  CachedRemoteFileHandle,
  buildRemoteTree,
  formatRateLimitReset,
  rateLimitMessage,
  readJsonWithProgress,
  type RemoteHost,
} from "./remoteHost";

const GITHUB_API = "https://api.github.com";

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Parses either a bare `owner/repo` shorthand or a full GitHub URL. Returns
 * `null` for anything that doesn't match one of those two shapes, rather
 * than throwing — the caller shows that as a plain input-validation message.
 */
export function parseGithubRepoInput(input: string): GithubRepoRef | null {
  const trimmed = input.trim().replace(/\.git$/i, "");
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i);
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  const m = urlMatch ?? shortMatch;
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

/**
 * Fetches a public repo's default branch, then its full recursive file tree,
 * and builds it into a `TreeNode` rooted at the repo name — same shape
 * `readDirectoryTree` produces for a local folder. The recursive tree call is
 * the one genuinely slow step for a large repo (tens of megabytes of JSON for
 * something like `torvalds/linux`), so `onTreeBytes`, when given, is called
 * with the cumulative bytes received as the response streams in — letting a
 * caller show a running counter instead of one static "Fetching…" message
 * for however many seconds that takes. `signal`, when given, aborts both
 * underlying requests — for a caller superseding this load with a different
 * one before it finishes.
 */
export async function fetchGithubTree(
  ref: GithubRepoRef,
  onTreeBytes?: (bytesReceived: number) => void,
  signal?: AbortSignal,
): Promise<TreeNode> {
  const branch = await resolveDefaultBranch(ref, signal);

  const treeRes = await fetch(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { signal },
  );
  if (!treeRes.ok) {
    throw new Error(describeHttpFailure(treeRes, "Failed to fetch repository tree"));
  }
  const treeJson = await readJsonWithProgress<{ tree: GithubTreeEntry[]; truncated?: boolean }>(treeRes, onTreeBytes);

  const tree = buildRemoteTree(
    ref.repo,
    treeJson.tree.filter((e) => e.type === "blob").map((e) => e.path),
    (path) =>
      new CachedRemoteFileHandle(
        `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${path}`,
        // `false`: raw.githubusercontent.com's rate-limit headers are not
        // CORS-exposed, so a 403 has to be read as a rate limit rather than
        // confirmed as one (see `isRateLimited`). This fires *mid-session*,
        // long after the tree loaded fine — the next level's source is fetched
        // only when it is about to be played — so it must name its own cause
        // just as much as the initial load does.
        (res, url) => describeHttpFailure(res, `Failed to fetch "${url}"`, false),
      ),
  );

  if (treeJson.truncated) {
    tree.truncated = true;
    // `console.log`, not `console.warn`, on purpose: the in-game console
    // sidebar mirrors `console.log` only (`consoleSidebar.ts`), and this is
    // a line the *player* needs — a warning that only reaches devtools is
    // how this stayed invisible. The persistent marker `renderFileTree`
    // draws from `tree.truncated` is the other half.
    console.log(
      `[github] The tree for "${ref.owner}/${ref.repo}" was truncated by the GitHub API — ` +
        "this repo is large enough that some files are missing. The campaign still plays, " +
        "built from whatever GitHub returned; clone the repo and use the Local tab to get all of it.",
    );
  }

  return tree;
}

/**
 * Turns a failed response into a message that names the actual cause when it
 * can. Requests here are unauthenticated, so a burst of browsing runs into
 * GitHub's public rate limit and every subsequent call fails — as a `403`
 * (the REST API's historical shape) or a `429`, in both cases with
 * `x-ratelimit-remaining: 0`. "Failed to fetch repository tree (403
 * Forbidden)" reads like a permissions problem the player can't fix;
 * "you've hit GitHub's rate limit, wait a few minutes" is something they
 * can act on. A 403 *without* the exhausted-budget header is left alone —
 * it really is an access problem then.
 */
function describeHttpFailure(res: Response, whatFailed: string, budgetHeadersReadable = true): string {
  if (isRateLimited(res, budgetHeadersReadable)) {
    // Deliberately replaces `whatFailed` rather than prefixing it: which
    // request failed is not the useful half here, and "Repository … not
    // found or inaccessible: you've hit the rate limit" reads as two
    // contradictory diagnoses of the same failure.
    return rateLimitMessage("GitHub", formatRateLimitReset(res, "x-ratelimit-reset"));
  }
  return `${whatFailed} (${res.status} ${res.statusText})`;
}

/**
 * `budgetHeadersReadable` is about CORS, not about GitHub. `api.github.com`
 * sends `Access-Control-Expose-Headers: … X-RateLimit-Remaining,
 * X-RateLimit-Reset …`, so the browser lets this code read them and the
 * check can be exact. `raw.githubusercontent.com` sends no
 * `Access-Control-Expose-Headers` at all (verified against both hosts), so
 * every rate-limit header it sends is invisible from a page however present
 * it is on the wire — a header-gated check there is not conservative, it is
 * dead. A `403` from that host is a rate limit in practice: a file in a
 * public repo answers `200` or `404`, and there is no permissions dimension
 * to get a `403` from.
 */
function isRateLimited(res: Response, budgetHeadersReadable: boolean): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  if (!budgetHeadersReadable) return true;
  return res.headers?.get("x-ratelimit-remaining") === "0";
}

async function resolveDefaultBranch(ref: GithubRepoRef, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${ref.owner}/${ref.repo}`, { signal });
  if (!res.ok) {
    throw new Error(
      describeHttpFailure(res, `Repository "${ref.owner}/${ref.repo}" not found or inaccessible`),
    );
  }
  const json = (await res.json()) as { default_branch: string };
  return json.default_branch;
}

/** The adapter, for the host registry in `remoteHosts.ts`. */
export const GITHUB_HOST: RemoteHost = {
  id: "github",
  label: "GitHub",
  parseInput: parseGithubRepoInput,
  fetchTree: fetchGithubTree,
};
