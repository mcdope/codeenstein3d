// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteFileHandle } from "./workspace";
import { fetchGithubTree, parseGithubRepoInput } from "./github";

function jsonResponse(body: unknown, ok = true, status = 200, statusText = "OK"): Response {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    body: null,
  } as unknown as Response;
}

/** A fake streaming Response whose body yields `chunks` one at a time via
 * ReadableStreamDefaultReader-shaped `.read()` calls. */
function streamResponse(chunks: Uint8Array[]): Response {
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      if (i < chunks.length) return { done: false, value: chunks[i++] };
      return { done: true, value: undefined };
    }),
  };
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: { getReader: () => reader },
    json: async () => {
      throw new Error("json() should not be called on the streaming path");
    },
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

describe("parseGithubRepoInput", () => {
  it("parses a bare owner/repo shorthand", () => {
    expect(parseGithubRepoInput("torvalds/linux")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("parses a full https URL", () => {
    expect(parseGithubRepoInput("https://github.com/torvalds/linux")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("parses a URL without a protocol and with www.", () => {
    expect(parseGithubRepoInput("www.github.com/torvalds/linux")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("parses a URL with a trailing slash", () => {
    expect(parseGithubRepoInput("https://github.com/torvalds/linux/")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("strips a trailing .git suffix", () => {
    expect(parseGithubRepoInput("torvalds/linux.git")).toEqual({ owner: "torvalds", repo: "linux" });
    expect(parseGithubRepoInput("https://github.com/torvalds/linux.git")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGithubRepoInput("  torvalds/linux  ")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("returns null for input matching neither shape", () => {
    expect(parseGithubRepoInput("not a repo at all")).toBeNull();
    expect(parseGithubRepoInput("")).toBeNull();
    expect(parseGithubRepoInput("just-one-segment")).toBeNull();
  });
});

describe("fetchGithubTree", () => {
  const ref = { owner: "acme", repo: "widgets" };

  it("throws when the repo can't be resolved", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 404, "Not Found"));
    await expect(fetchGithubTree(ref)).rejects.toThrow("not found or inaccessible");
  });

  it("throws when the recursive tree fetch fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse(null, false, 500, "Server Error"));
    await expect(fetchGithubTree(ref)).rejects.toThrow("Failed to fetch repository tree");
  });

  it("builds a tree rooted at the repo name from blob entries, ignoring tree-type entries", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [
            { path: "src", type: "tree" },
            { path: "src/main.c", type: "blob" },
            { path: "README.md", type: "blob" },
          ],
        }),
      );
    const tree = await fetchGithubTree(ref);
    expect(tree.name).toBe("widgets");
    expect(tree.path).toBe("widgets");
    expect(tree.kind).toBe("directory");
    // README.md (file) and src (synthesized directory) — sorted dirs-first.
    expect(tree.children!.map((c) => c.name)).toEqual(["src", "README.md"]);
  });

  it("drops any file whose path passes through an ignored directory", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [
            { path: "node_modules/pkg/index.js", type: "blob" },
            { path: "src/main.c", type: "blob" },
          ],
        }),
      );
    const tree = await fetchGithubTree(ref);
    expect(tree.children!.map((c) => c.name)).toEqual(["src"]);
  });

  it("reuses one directory node for multiple files under the same path", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [
            { path: "src/a.c", type: "blob" },
            { path: "src/b.c", type: "blob" },
          ],
        }),
      );
    const tree = await fetchGithubTree(ref);
    expect(tree.children).toHaveLength(1); // one "src" dir, not two
    const src = tree.children![0];
    expect(src.children!.map((c) => c.name)).toEqual(["a.c", "b.c"]);
    expect(src.path).toBe("widgets/src");
    expect(src.children![0].path).toBe("widgets/src/a.c");
  });

  it("builds correctly nested paths two or more directories deep", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "src/lib/util.c", type: "blob" }] }));
    const tree = await fetchGithubTree(ref);
    const src = tree.children![0];
    expect(src.name).toBe("src");
    expect(src.path).toBe("widgets/src");
    const lib = src.children![0];
    expect(lib.name).toBe("lib");
    expect(lib.path).toBe("widgets/src/lib");
    expect(lib.children![0].path).toBe("widgets/src/lib/util.c");
  });

  it("warns when the API reports the tree was truncated, and stays silent otherwise", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [], truncated: true }));
    await fetchGithubTree(ref);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("truncated");

    warnSpy.mockClear();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [] })); // truncated omitted
    await fetchGithubTree(ref);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("threads the abort signal through both underlying fetch calls", async () => {
    const controller = new AbortController();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [] }));
    await fetchGithubTree(ref, undefined, controller.signal);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ signal: controller.signal });
  });

  it("streams the tree response, reporting cumulative bytes and merging chunks into valid JSON", async () => {
    const payload = { tree: [{ path: "main.c", type: "blob" }] };
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const mid = Math.floor(encoded.length / 2);
    const chunks = [encoded.slice(0, mid), encoded.slice(mid)];

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(streamResponse(chunks));

    const onBytes = vi.fn();
    const tree = await fetchGithubTree(ref, onBytes);

    expect(tree.children!.map((c) => c.name)).toEqual(["main.c"]);
    expect(onBytes).toHaveBeenCalledTimes(2);
    expect(onBytes).toHaveBeenNthCalledWith(1, chunks[0].byteLength);
    expect(onBytes).toHaveBeenNthCalledWith(2, encoded.byteLength);
  });

  it("falls back to a plain res.json() when a callback is given but the response has no body stream", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] })); // .body is null
    const onBytes = vi.fn();
    const tree = await fetchGithubTree(ref, onBytes);
    expect(tree.children!.map((c) => c.name)).toEqual(["main.c"]);
    expect(onBytes).not.toHaveBeenCalled();
  });
});

describe("GithubFileHandle (via a fetched tree's file node)", () => {
  const ref = { owner: "acme", repo: "widgets" };

  it("fetches from the raw.githubusercontent.com URL and caches on repeat reads", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] }));
    const tree = await fetchGithubTree(ref);
    const fileNode = tree.children![0];

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => "int main(){}" } as unknown as Response);
    const handle = fileNode.handle as RemoteFileHandle;
    const file1 = await handle.getFile();
    expect(await file1.text()).toBe("int main(){}");
    expect(fetchMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/acme/widgets/main/main.c");

    const callsAfterFirstRead = fetchMock.mock.calls.length;
    const file2 = await handle.getFile();
    expect(await file2.text()).toBe("int main(){}");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstRead); // no second network fetch
  });

  it("throws when the raw file fetch fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] }));
    const tree = await fetchGithubTree(ref);
    const handle = tree.children![0].handle as RemoteFileHandle;

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" } as unknown as Response);
    await expect(handle.getFile()).rejects.toThrow("404 Not Found");
  });

  it("the synthesized root/directory nodes' handle always rejects getFile()", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "src/main.c", type: "blob" }] }));
    const tree = await fetchGithubTree(ref);
    await expect((tree.handle as RemoteFileHandle).getFile()).rejects.toThrow("Not a file");
    const srcDir = tree.children![0];
    await expect((srcDir.handle as RemoteFileHandle).getFile()).rejects.toThrow("Not a file");
  });
});
