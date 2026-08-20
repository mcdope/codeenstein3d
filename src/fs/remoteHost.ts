// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The parts of "load a public repo over HTTP" that are the same whichever
 * forge it came from.
 *
 * Extracted from `github.ts` when GitLab and Codeberg were added — the tree
 * assembly, the streaming progress reader, the lazy per-file cache and the
 * rate-limit wording were all host-agnostic already, and duplicating them
 * three times is how three copies drift into three different behaviours.
 * What is genuinely per-host lives in the adapters: the URL shapes, the JSON
 * shape of a tree entry, and how the tree is paginated.
 *
 * **Everything downstream stays unaware.** `TreeNode` is the contract
 * (`workspace.ts`), and the file tree UI, `flattenParsableFiles`, entrypoint
 * detection, level launching and replay only ever read
 * `kind`/`name`/`path`/`children` and call `handle.getFile()`.
 */

import {
  compareNodes,
  isIgnoredDirectoryName,
  isIgnoredFileName,
  type RemoteFileHandle,
  type TreeNode,
} from "./workspace";

/**
 * Which forge a workspace came from.
 *
 * Persisted — `highscores.ts` stores it on a run so "Continue" can re-fetch
 * the same repo rather than prompting for a local folder. `"github"` predates
 * the others and must keep resolving to GitHub, because saved runs carry it.
 */
export type RemoteHostId = "github" | "gitlab" | "codeberg";

/** A repo identified the way its host identifies one. GitHub and Codeberg use
 * `owner` + `repo`; GitLab allows arbitrarily nested groups, so its adapter
 * keeps the full namespace path in `owner`. */
export interface RemoteRepoRef {
  owner: string;
  repo: string;
}

/** `owner/repo`, which is what the workspace is named and what a saved run
 * records — see `parseRemoteRepoPath` for the way back. */
export function formatRepoRef(ref: RemoteRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Splits a stored `owner/repo` back apart, taking everything before the last
 * separator as the owner so GitLab's nested groups survive a round trip
 * (`a/b/c` is the project `c` in group `a/b`, not the project `b/c`).
 */
export function parseRemoteRepoPath(path: string): RemoteRepoRef | null {
  const trimmed = path.trim();
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0 || cut === trimmed.length - 1) return null;
  const owner = trimmed.slice(0, cut);
  const repo = trimmed.slice(cut + 1);
  if (/\s/.test(trimmed)) return null;
  return { owner, repo };
}

/**
 * How many 100-entry tree pages to fetch before giving up and marking the
 * tree truncated.
 *
 * GitHub returns a whole recursive tree in one request. **GitLab and Codeberg
 * both paginate at 100**, which is the single biggest structural difference
 * between the adapters and the reason this cap exists: `gitlab-org/gitlab-foss`
 * is 86,540 entries, i.e. **866 pages**, against an unauthenticated budget of
 * 500 requests per hour. Fetching it whole would spend the hour on one repo
 * and still be waiting.
 *
 * 40 pages is ~4,000 entries for 40 requests, leaving room for a dozen repo
 * loads an hour. Far more source files than a campaign needs, and the overflow
 * is not silent: it sets the same `tree.truncated` flag GitHub's own truncation
 * uses, which `renderFileTree` already draws a persistent marker from.
 */
export const MAX_TREE_PAGES = 40;

/** What every host adapter provides. */
export interface RemoteHost {
  readonly id: RemoteHostId;
  /** Shown to the player — in status messages and error text. */
  readonly label: string;
  /** Parses a URL or shorthand for this host; `null` when it is not one. */
  parseInput(input: string): RemoteRepoRef | null;
  fetchTree(ref: RemoteRepoRef, onTreeBytes?: (bytes: number) => void, signal?: AbortSignal): Promise<TreeNode>;
}

/**
 * A directory node's `handle` is never actually called — only `kind` is
 * checked before deciding to recurse — so this stub exists solely to satisfy
 * `TreeNode.handle`'s type.
 */
export const DIRECTORY_STUB: RemoteFileHandle = {
  getFile: () => Promise.reject(new Error("Not a file")),
};

/** Lazily fetches one file's raw text, then caches it, so a file is never
 * fetched twice however often it is re-read. */
export class CachedRemoteFileHandle implements RemoteFileHandle {
  private cached: string | null = null;

  constructor(
    private readonly rawUrl: string,
    private readonly onFailure: (res: Response, url: string) => string,
  ) {}

  async getFile(): Promise<{ text(): Promise<string> }> {
    if (this.cached === null) {
      const res = await fetch(this.rawUrl);
      if (!res.ok) throw new Error(this.onFailure(res, this.rawUrl));
      this.cached = await res.text();
    }
    const text = this.cached;
    return { text: async () => text };
  }
}

/**
 * Builds a `TreeNode` from a flat list of file paths, synthesizing the
 * directory nodes along the way — the same shape `readDirectoryTree` produces
 * for a local folder, so nothing downstream can tell the difference.
 *
 * `paths` must already be filtered to files; directory entries are ignored
 * because every directory that matters is implied by a path that runs through
 * it, and a host that lists empty directories should not produce empty nodes.
 */
export function buildRemoteTree(
  rootName: string,
  paths: readonly string[],
  makeHandle: (path: string) => RemoteFileHandle,
): TreeNode {
  const root: TreeNode = { name: rootName, path: rootName, kind: "directory", handle: DIRECTORY_STUB, children: [] };
  const dirsByPath = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string, name: string, parent: TreeNode): TreeNode => {
    let dir = dirsByPath.get(path);
    if (!dir) {
      dir = { name, path: `${rootName}/${path}`, kind: "directory", handle: DIRECTORY_STUB, children: [] };
      parent.children!.push(dir);
      dirsByPath.set(path, dir);
    }
    return dir;
  };

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const segments = path.split("/");
    if (segments.some((seg) => isIgnoredDirectoryName(seg))) continue;

    const fileName = segments[segments.length - 1];
    if (isIgnoredFileName(fileName)) continue;

    let parent = root;
    let accPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      accPath = accPath ? `${accPath}/${segments[i]}` : segments[i];
      parent = ensureDir(accPath, segments[i], parent);
    }

    parent.children!.push({
      name: fileName,
      path: `${rootName}/${path}`,
      kind: "file",
      handle: makeHandle(path),
    });
  }

  sortRecursively(root);
  return root;
}

function sortRecursively(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort(compareNodes);
  for (const child of node.children) sortRecursively(child);
}

/**
 * Reads `res`'s body and JSON-parses it, calling `onBytes` with the cumulative
 * byte count as each chunk arrives. Falls back to a plain `res.json()` when no
 * callback was given or the runtime does not expose a streamable body (some
 * test environments) — same end result, without the incremental callback.
 */
export async function readJsonWithProgress<T>(res: Response, onBytes?: (bytesReceived: number) => void): Promise<T> {
  if (!onBytes || !res.body) return (await res.json()) as T;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8").decode(merged)) as T;
}

/** " — it resets in about 7 minutes", when the response says when, as a Unix
 * timestamp in seconds. */
export function formatRateLimitReset(res: Response, header: string): string {
  const reset = Number(res.headers?.get(header));
  if (!Number.isFinite(reset) || reset <= 0) return "";
  const minutes = Math.ceil((reset * 1000 - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  return ` — it resets in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The rate-limit sentence, in one place so three hosts cannot word the same
 * situation three ways. */
export function rateLimitMessage(hostLabel: string, resetClause: string): string {
  return `${hostLabel}'s public rate limit reached${resetClause}. ` +
    "Requests from this app are unauthenticated, so a lot of browsing runs the limit down. " +
    "Waiting is the fix — or load a local folder from the Local tab in the meantime.";
}
