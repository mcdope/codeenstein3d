// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TREE_PAGES } from "./remoteHost";
import { fetchGitlabTree, parseGitlabRepoInput } from "./gitlab";
import type { RemoteFileHandle, TreeNode } from "./workspace";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(headers), json: async () => body, body: null } as unknown as Response;
}
function errorResponse(status: number, statusText: string): Response {
  return { ok: false, status, statusText, headers: new Headers(), json: async () => null, body: null } as unknown as Response;
}
function textResponse(text: string): Response {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => text, body: null } as unknown as Response;
}
/** One page of `count` blob entries, named so their order is checkable. */
function page(count: number, prefix: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(
    Array.from({ length: count }, (_, i) => ({ path: `${prefix}${i}.ts`, type: "blob" })),
    headers,
  );
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

describe("parseGitlabRepoInput", () => {
  it("parses a shorthand and a URL", () => {
    expect(parseGitlabRepoInput("group/project")).toEqual({ owner: "group", repo: "project" });
    expect(parseGitlabRepoInput("https://gitlab.com/group/project")).toEqual({ owner: "group", repo: "project" });
  });

  it("keeps nested groups, which GitHub has no equivalent of", () => {
    expect(parseGitlabRepoInput("https://gitlab.com/a/b/c/project")).toEqual({ owner: "a/b/c", repo: "project" });
    expect(parseGitlabRepoInput("a/b/project")).toEqual({ owner: "a/b", repo: "project" });
  });

  it("drops a /-/ suffix, since the project path ends there", () => {
    expect(parseGitlabRepoInput("https://gitlab.com/g/p/-/tree/main/src")).toEqual({ owner: "g", repo: "p" });
    expect(parseGitlabRepoInput("https://gitlab.com/g/p/-/blob/main/README.md")).toEqual({ owner: "g", repo: "p" });
  });

  it("strips .git, trailing slashes and surrounding whitespace", () => {
    expect(parseGitlabRepoInput("  https://gitlab.com/g/p.git  ")).toEqual({ owner: "g", repo: "p" });
    expect(parseGitlabRepoInput("https://gitlab.com/g/p/")).toEqual({ owner: "g", repo: "p" });
  });

  it("refuses another forge's URL instead of reading the host as a group", () => {
    // Nested-group support makes the shorthand branch accept any number of
    // segments, which is exactly what let this parser claim a Codeberg URL.
    for (const other of ["https://codeberg.org/o/r", "codeberg.org/o/r", "https://github.com/o/r", "https://example.com/a/b"]) {
      expect(parseGitlabRepoInput(other), other).toBeNull();
    }
  });

  it("returns null for input that is not a repo at all", () => {
    for (const bad of ["", "   ", "project", "has space/project"]) {
      expect(parseGitlabRepoInput(bad), bad).toBeNull();
    }
  });
});

describe("fetchGitlabTree", () => {
  const ref = { owner: "group", repo: "project" };

  it("addresses the project by its %2F-encoded full path", () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(page(1, "a"));
    return fetchGitlabTree({ owner: "a/b", repo: "c" }).then(() => {
      expect(fetchMock.mock.calls[0][0]).toContain("/projects/a%2Fb%2Fc");
    });
  });

  it("walks pages until a short one, and concatenates them", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(page(100, "p1_", { "x-next-page": "2" }))
      .mockResolvedValueOnce(page(3, "p2_", { "x-next-page": "" }));
    const tree = await fetchGitlabTree(ref);
    expect(fileNames(tree)).toHaveLength(103);
    expect(fetchMock).toHaveBeenCalledTimes(3); // project + 2 pages
    expect(tree.truncated).toBeUndefined();
  });

  it("stops at a full page with no next-page header", async () => {
    // A short page is the usual terminator, but a repo whose file count is an
    // exact multiple of 100 ends on a full one — without the header check that
    // would fetch a 101st empty page forever, or here, MAX_TREE_PAGES of them.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(page(100, "p1_", { "x-next-page": "" }));
    const tree = await fetchGitlabTree(ref);
    expect(fileNames(tree)).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a huge repo and marks the tree truncated rather than spending the hourly budget", async () => {
    // gitlab-org/gitlab-foss is 866 pages against a 500/hour unauthenticated
    // budget, so "keep going until the pages run out" is not an option.
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" }));
    for (let i = 0; i < MAX_TREE_PAGES; i++) {
      fetchMock.mockResolvedValueOnce(page(100, `p${i}_`, { "x-next-page": String(i + 2) }));
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tree = await fetchGitlabTree(ref);
    expect(tree.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TREE_PAGES + 1);
    expect(logSpy.mock.calls[0][0]).toContain("truncated");
  });

  it("skips tree-type entries, keeping only blobs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(
      jsonResponse([
        { path: "src", type: "tree" },
        { path: "src/a.ts", type: "blob" },
      ]),
    );
    expect(fileNames(await fetchGitlabTree(ref))).toEqual(["a.ts"]);
  });

  it("fetches file text from a %2F-encoded path, because an unencoded one 404s", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse([{ path: "src/deep/a.ts", type: "blob" }]))
      .mockResolvedValueOnce(textResponse("contents"));
    const tree = await fetchGitlabTree(ref);
    const file = tree.children![0].children![0].children![0];
    expect(await (await (file.handle as RemoteFileHandle).getFile()).text()).toBe("contents");
    expect(fetchMock.mock.calls[2][0]).toContain("/files/src%2Fdeep%2Fa.ts/raw");
    expect(fetchMock.mock.calls[2][0]).toContain("ref=main");
  });

  it("caches a file's text rather than re-fetching it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse([{ path: "a.ts", type: "blob" }]))
      .mockResolvedValueOnce(textResponse("once"));
    const file = (await fetchGitlabTree(ref)).children![0];
    expect(await (await (file.handle as RemoteFileHandle).getFile()).text()).toBe("once");
    expect(await (await (file.handle as RemoteFileHandle).getFile()).text()).toBe("once");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("names the rate limit on a 429, without needing headers it cannot read", async () => {
    // gitlab.com's Access-Control-Expose-Headers omits the ratelimit-* set, so
    // a header-gated check here would never fire from a page.
    fetchMock.mockResolvedValueOnce(errorResponse(429, "Too Many Requests"));
    await expect(fetchGitlabTree(ref)).rejects.toThrow(/GitLab's public rate limit reached/);
  });

  it("reports a missing project plainly", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
    await expect(fetchGitlabTree(ref)).rejects.toThrow(/not found or inaccessible \(404 Not Found\)/);
  });

  it("reports a failed tree page plainly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(errorResponse(500, "Server Error"));
    await expect(fetchGitlabTree(ref)).rejects.toThrow(/Failed to fetch repository tree \(500 Server Error\)/);
  });

  it("threads the abort signal through every request", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(page(1, "a"));
    await fetchGitlabTree(ref, undefined, controller.signal);
    for (const call of fetchMock.mock.calls) expect(call[1]).toEqual({ signal: controller.signal });
  });
});

describe("fetchGitlabTree — progress and mid-session failures", () => {
  const ref = { owner: "group", repo: "project" };

  it("reports byte counts that keep climbing across pages instead of restarting", async () => {
    // The property the cumulative accumulator exists for: a per-response
    // callback would reset to zero on every page, so a player watching a
    // large repo download would see the counter fall back repeatedly.
    const p1 = Array.from({ length: 100 }, (_, i) => ({ path: `a${i}.ts`, type: "blob" }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(streamedPage(p1, { "x-next-page": "2" }))
      .mockResolvedValueOnce(streamedPage([{ path: "b.ts", type: "blob" }], { "x-next-page": "" }));
    const seen: number[] = [];
    await fetchGitlabTree(ref, (n) => seen.push(n));
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("names its own cause when a file fetch fails mid-session", async () => {
    // Fires long after the tree loaded fine — the next level's source is only
    // fetched when it is about to be played — so it cannot lean on the load
    // screen to explain itself.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse([{ path: "a.ts", type: "blob" }]))
      .mockResolvedValueOnce(errorResponse(500, "Server Error"));
    const handle = (await fetchGitlabTree(ref)).children![0].handle as RemoteFileHandle;
    await expect(handle.getFile()).rejects.toThrow(/Failed to fetch ".*a\.ts\/raw.*" \(500 Server Error\)/);
  });

  it("reports a rate limit rather than a file error when the budget runs out mid-session", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse([{ path: "a.ts", type: "blob" }]))
      .mockResolvedValueOnce(errorResponse(429, "Too Many Requests"));
    const handle = (await fetchGitlabTree(ref)).children![0].handle as RemoteFileHandle;
    await expect(handle.getFile()).rejects.toThrow(/GitLab's public rate limit reached/);
  });
});
