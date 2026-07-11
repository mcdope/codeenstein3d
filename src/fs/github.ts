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

import { compareNodes, IGNORED_DIRECTORIES, type RemoteFileHandle, type TreeNode } from "./workspace";

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

/** Lazily fetches (and caches) one file's raw text from a public repo. */
class GithubFileHandle implements RemoteFileHandle {
  private cached: string | null = null;

  constructor(private readonly rawUrl: string) {}

  async getFile(): Promise<{ text(): Promise<string> }> {
    if (this.cached === null) {
      const res = await fetch(this.rawUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch "${this.rawUrl}" (${res.status} ${res.statusText})`);
      }
      this.cached = await res.text();
    }
    const text = this.cached;
    return { text: async () => text };
  }
}

/** A directory node's `handle` is never actually called (only `kind` is
 * checked before deciding to recurse) — this stub only exists to satisfy
 * `TreeNode.handle`'s type. */
const DIRECTORY_STUB: RemoteFileHandle = {
  getFile: () => Promise.reject(new Error("Not a file")),
};

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
    throw new Error(`Failed to fetch repository tree (${treeRes.status} ${treeRes.statusText})`);
  }
  const treeJson = await readJsonWithProgress<{ tree: GithubTreeEntry[]; truncated?: boolean }>(treeRes, onTreeBytes);

  if (treeJson.truncated) {
    console.warn(
      `[github] The tree for "${ref.owner}/${ref.repo}" was truncated by the GitHub API — ` +
        "this repo is large enough that some files may be missing.",
    );
  }

  return buildTree(ref, branch, treeJson.tree);
}

/**
 * Reads `res`'s body and JSON-parses it, calling `onBytes` with the
 * cumulative byte count as each chunk of the stream arrives. Falls back to a
 * plain `res.json()` when no callback was given or the runtime doesn't
 * expose a streamable body (some test environments) — same end result,
 * just without the incremental callback.
 */
async function readJsonWithProgress<T>(res: Response, onBytes?: (bytesReceived: number) => void): Promise<T> {
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

async function resolveDefaultBranch(ref: GithubRepoRef, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${ref.owner}/${ref.repo}`, { signal });
  if (!res.ok) {
    throw new Error(
      `Repository "${ref.owner}/${ref.repo}" not found or inaccessible (${res.status} ${res.statusText}).`,
    );
  }
  const json = (await res.json()) as { default_branch: string };
  return json.default_branch;
}

function buildTree(ref: GithubRepoRef, branch: string, entries: GithubTreeEntry[]): TreeNode {
  const root: TreeNode = { name: ref.repo, path: ref.repo, kind: "directory", handle: DIRECTORY_STUB, children: [] };
  const dirsByPath = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string, name: string, parent: TreeNode): TreeNode => {
    let dir = dirsByPath.get(path);
    if (!dir) {
      dir = { name, path: `${ref.repo}/${path}`, kind: "directory", handle: DIRECTORY_STUB, children: [] };
      parent.children!.push(dir);
      dirsByPath.set(path, dir);
    }
    return dir;
  };

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (entry.type !== "blob") continue; // directories are synthesized from file paths below

    const segments = entry.path.split("/");
    if (segments.some((seg) => IGNORED_DIRECTORIES.has(seg))) continue;

    let parent = root;
    let accPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      accPath = accPath ? `${accPath}/${segments[i]}` : segments[i];
      parent = ensureDir(accPath, segments[i], parent);
    }

    const fileName = segments[segments.length - 1];
    parent.children!.push({
      name: fileName,
      path: `${ref.repo}/${entry.path}`,
      kind: "file",
      handle: new GithubFileHandle(
        `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${entry.path}`,
      ),
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
