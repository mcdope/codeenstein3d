// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TREE_PAGES } from "./remoteHost";
import { fetchCodebergTree, parseCodebergRepoInput } from "./codeberg";
import type { RemoteFileHandle, TreeNode } from "./workspace";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body, body: null } as unknown as Response;
}
function errorResponse(status: number, statusText: string): Response {
  return { ok: false, status, statusText, headers: new Headers(), json: async () => null, body: null } as unknown as Response;
}
function textResponse(text: string): Response {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => text, body: null } as unknown as Response;
}
function treePage(count: number, prefix: string, truncated = false): Response {
  return jsonResponse({
    tree: Array.from({ length: count }, (_, i) => ({ path: `${prefix}${i}.ts`, type: "blob" })),
    truncated,
  });
}
function fileNames(node: TreeNode): string[] {
  if (node.kind === "file") return [node.name];
  return (node.children ?? []).flatMap(fileNames);
}


/** A page response whose body streams in chunks, so the progress callback in
 * `readJsonWithProgress` is actually exercised. */
function streamedPage(body: unknown, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const half = Math.ceil(bytes.length / 2);
  const chunks = [bytes.slice(0, half), bytes.slice(half)];
  let i = 0;
  const reader = { read: vi.fn(async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined })) };
  return {
    ok: true, status: 200, statusText: "OK", headers: new Headers(headers),
    body: { getReader: () => reader },
    json: async () => { throw new Error("json() should not be called on the streaming path"); },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseCodebergRepoInput", () => {
  it("parses a shorthand and a codeberg.org URL", () => {
    expect(parseCodebergRepoInput("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseCodebergRepoInput("https://codeberg.org/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseCodebergRepoInput("codeberg.org/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("strips .git, a trailing slash and whitespace — matching github.ts exactly", () => {
    expect(parseCodebergRepoInput("  https://codeberg.org/o/r.git  ")).toEqual({ owner: "o", repo: "r" });
    expect(parseCodebergRepoInput("https://codeberg.org/o/r/")).toEqual({ owner: "o", repo: "r" });
    // A trailing slash *after* `.git` is not handled, because `.git$` is
    // stripped before the slash is. `github.ts` has the identical quirk and
    // the adapters are deliberately kept in step: a clone URL never carries
    // both, and two parsers disagreeing about an edge case is worse than one
    // shared limitation.
    expect(parseCodebergRepoInput("https://codeberg.org/o/r.git/")).toEqual({ owner: "o", repo: "r.git" });
  });

  it("returns null for another forge's URL and for junk", () => {
    for (const bad of ["https://github.com/o/r", "https://gitlab.com/o/r", "", "owner", "a/b/c"]) {
      expect(parseCodebergRepoInput(bad), bad).toBeNull();
    }
  });
});

describe("fetchCodebergTree", () => {
  const ref = { owner: "owner", repo: "repo" };

  it("resolves the default branch and asks for it by name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "forgejo" })).mockResolvedValueOnce(treePage(1, "a"));
    await fetchCodebergTree(ref);
    expect(fetchMock.mock.calls[0][0]).toBe("https://codeberg.org/api/v1/repos/owner/repo");
    expect(fetchMock.mock.calls[1][0]).toContain("/git/trees/forgejo?recursive=true");
  });

  it("walks pages until a short one and concatenates them", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(treePage(100, "p1_"))
      .mockResolvedValueOnce(treePage(7, "p2_"));
    const tree = await fetchCodebergTree(ref);
    expect(fileNames(tree)).toHaveLength(107);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tree.truncated).toBeUndefined();
  });

  it("honours Forgejo's own truncated flag even on a short page", async () => {
    // Forgejo reports truncation in the body, unlike GitLab which has no such
    // field — so this adapter has two independent reasons to mark a tree
    // incomplete and must respect the host's own answer.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(treePage(5, "a", true));
    const tree = await fetchCodebergTree(ref);
    expect(tree.truncated).toBe(true);
    expect(logSpy.mock.calls[0][0]).toContain("truncated");
  });

  it("caps at MAX_TREE_PAGES and marks the tree truncated", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" }));
    for (let i = 0; i < MAX_TREE_PAGES; i++) fetchMock.mockResolvedValueOnce(treePage(100, `p${i}_`));
    const tree = await fetchCodebergTree(ref);
    expect(tree.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TREE_PAGES + 1);
  });

  it("tolerates a page with no tree array at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(jsonResponse({}));
    expect(fileNames(await fetchCodebergTree(ref))).toEqual([]);
  });

  it("keeps only blob entries", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(
      jsonResponse({ tree: [{ path: "src", type: "tree" }, { path: "src/a.ts", type: "blob" }] }),
    );
    expect(fileNames(await fetchCodebergTree(ref))).toEqual(["a.ts"]);
  });

  it("fetches file text from the raw endpoint at the resolved branch, and caches it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "src/a.ts", type: "blob" }] }))
      .mockResolvedValueOnce(textResponse("contents"));
    const tree = await fetchCodebergTree(ref);
    const file = tree.children![0].children![0];
    expect(await (await (file.handle as RemoteFileHandle).getFile()).text()).toBe("contents");
    expect(await (await (file.handle as RemoteFileHandle).getFile()).text()).toBe("contents");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("https://codeberg.org/api/v1/repos/owner/repo/raw/src/a.ts?ref=main");
  });

  it("names the rate limit on a 429", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429, "Too Many Requests"));
    await expect(fetchCodebergTree(ref)).rejects.toThrow(/Codeberg's public rate limit reached/);
  });

  it("reports a missing repo and a failed page plainly", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
    await expect(fetchCodebergTree(ref)).rejects.toThrow(/not found or inaccessible \(404 Not Found\)/);

    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(errorResponse(500, "Server Error"));
    await expect(fetchCodebergTree(ref)).rejects.toThrow(/Failed to fetch repository tree \(500 Server Error\)/);
  });

  it("threads the abort signal through every request", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(treePage(1, "a"));
    await fetchCodebergTree(ref, undefined, controller.signal);
    for (const call of fetchMock.mock.calls) expect(call[1]).toEqual({ signal: controller.signal });
  });
});

describe("fetchCodebergTree — progress and mid-session failures", () => {
  const ref = { owner: "owner", repo: "repo" };

  it("reports byte counts that keep climbing across pages instead of restarting", async () => {
    const p1 = { tree: Array.from({ length: 100 }, (_, i) => ({ path: `a${i}.ts`, type: "blob" })) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(streamedPage(p1))
      .mockResolvedValueOnce(streamedPage({ tree: [{ path: "b.ts", type: "blob" }] }));
    const seen: number[] = [];
    await fetchCodebergTree(ref, (n) => seen.push(n));
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("names its own cause when a file fetch fails mid-session", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "a.ts", type: "blob" }] }))
      .mockResolvedValueOnce(errorResponse(404, "Not Found"));
    const handle = (await fetchCodebergTree(ref)).children![0].handle as RemoteFileHandle;
    await expect(handle.getFile()).rejects.toThrow(/Failed to fetch ".*a\.ts.*" \(404 Not Found\)/);
  });

  it("reports a rate limit rather than a file error when the budget runs out mid-session", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "a.ts", type: "blob" }] }))
      .mockResolvedValueOnce(errorResponse(429, "Too Many Requests"));
    const handle = (await fetchCodebergTree(ref)).children![0].handle as RemoteFileHandle;
    await expect(handle.getFile()).rejects.toThrow(/Codeberg's public rate limit reached/);
  });
});
