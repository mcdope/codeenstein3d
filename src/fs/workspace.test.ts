// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDirectoryHandle } from "../../test/mocks/fsAccess";
import {
  compareNodes,
  IGNORED_DIRECTORIES,
  isFileSystemAccessSupported,
  isIgnoredDirectoryName,
  isIgnoredFileName,
  pickDirectory,
  pickWorkspace,
  readDirectoryTree,
  readFileText,
  type TreeNode,
} from "./workspace";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe("IGNORED_DIRECTORIES", () => {
  it("includes the documented common noise directories", () => {
    expect(IGNORED_DIRECTORIES.has("node_modules")).toBe(true);
    expect(IGNORED_DIRECTORIES.has(".git")).toBe(true);
    expect(IGNORED_DIRECTORIES.has("test")).toBe(true);
    expect(IGNORED_DIRECTORIES.has("tests")).toBe(true);
    expect(IGNORED_DIRECTORIES.has("__tests__")).toBe(true);
    expect(IGNORED_DIRECTORIES.has("src")).toBe(false);
  });
});

describe("isIgnoredDirectoryName", () => {
  it("matches regardless of case", () => {
    expect(isIgnoredDirectoryName("node_modules")).toBe(true);
    expect(isIgnoredDirectoryName("Test")).toBe(true);
    expect(isIgnoredDirectoryName("TESTS")).toBe(true);
    expect(isIgnoredDirectoryName("__Tests__")).toBe(true);
    expect(isIgnoredDirectoryName("src")).toBe(false);
  });
});

describe("isIgnoredFileName", () => {
  it("matches colocated test files across common conventions", () => {
    expect(isIgnoredFileName("workspace.test.ts")).toBe(true);
    expect(isIgnoredFileName("foo.spec.js")).toBe(true);
    expect(isIgnoredFileName("test_utils.py")).toBe(true);
    expect(isIgnoredFileName("main_test.go")).toBe(true);
    expect(isIgnoredFileName("foo_spec.rb")).toBe(true);
    expect(isIgnoredFileName("WidgetTest.java")).toBe(true);
    expect(isIgnoredFileName("WidgetTests.cs")).toBe(true);
  });

  it("does not flag real source files, including ones containing 'test' as a substring", () => {
    expect(isIgnoredFileName("workspace.ts")).toBe(false);
    expect(isIgnoredFileName("main.c")).toBe(false);
    expect(isIgnoredFileName("Contest.java")).toBe(false);
    expect(isIgnoredFileName("Latest.php")).toBe(false);
    expect(isIgnoredFileName("manifest.ts")).toBe(false);
  });
});

describe("isFileSystemAccessSupported", () => {
  it("is false when the browser has no showDirectoryPicker", () => {
    expect(isFileSystemAccessSupported()).toBe(false);
  });

  it("is true when the browser exposes showDirectoryPicker", () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn();
    expect(isFileSystemAccessSupported()).toBe(true);
  });
});

describe("pickDirectory / pickWorkspace", () => {
  it("throws a descriptive error when the API is unavailable", async () => {
    await expect(pickDirectory("test-id")).rejects.toThrow("The File System Access API is not available");
  });

  it("returns the granted handle on success, passing the id and read mode", async () => {
    const handle = fakeDirectoryHandle("root", {});
    const showDirectoryPicker = vi.fn().mockResolvedValue(handle);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = showDirectoryPicker;
    const result = await pickDirectory("my-id");
    expect(result).toBe(handle);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ id: "my-id", mode: "read" });
  });

  it("returns null when the user cancels the picker (AbortError)", async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    const result = await pickDirectory("test-id");
    expect(result).toBeNull();
  });

  it("rethrows any other error", async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new Error("boom"));
    await expect(pickDirectory("test-id")).rejects.toThrow("boom");
  });

  it("pickWorkspace() uses the workspace-specific picker id", async () => {
    const handle = fakeDirectoryHandle("root", {});
    const showDirectoryPicker = vi.fn().mockResolvedValue(handle);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = showDirectoryPicker;
    await pickWorkspace();
    expect(showDirectoryPicker).toHaveBeenCalledWith({ id: "codeenstein-workspace", mode: "read" });
  });
});

describe("readDirectoryTree", () => {
  it("builds a tree of files and nested directories", async () => {
    const handle = fakeDirectoryHandle("proj", {
      "main.c": "int main(){}",
      src: {
        "util.c": "void f(){}",
      },
    });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    expect(tree.name).toBe("proj");
    expect(tree.path).toBe("proj");
    expect(tree.kind).toBe("directory");
    expect(tree.children).toHaveLength(2); // "src" dir + "main.c" file
  });

  it("skips ignored directories entirely", async () => {
    const handle = fakeDirectoryHandle("proj", {
      "main.c": "int main(){}",
      node_modules: { "pkg.js": "module.exports = {};" },
    });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    expect(tree.children!.some((c) => c.name === "node_modules")).toBe(false);
    expect(tree.children).toHaveLength(1);
  });

  it("skips test directories regardless of casing/pluralization", async () => {
    const handle = fakeDirectoryHandle("proj", {
      "main.c": "int main(){}",
      test: { "a.c": "" },
      Test: { "b.c": "" },
      Tests: { "c.c": "" },
      __tests__: { "d.c": "" },
    });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    expect(tree.children!.map((c) => c.name)).toEqual(["main.c"]);
  });

  it("skips colocated test files without needing a dedicated test directory", async () => {
    const handle = fakeDirectoryHandle("proj", {
      "main.c": "int main(){}",
      "main.test.c": "",
      "helper_test.go": "",
      "HelperTest.java": "",
    });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    expect(tree.children!.map((c) => c.name)).toEqual(["main.c"]);
  });

  it("sorts directories before files, then alphabetically case-insensitively", async () => {
    const handle = fakeDirectoryHandle("proj", {
      "zebra.c": "",
      "Apple.c": "",
      lib: {},
      Config: {},
    });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    expect(tree.children!.map((c) => c.name)).toEqual(["Config", "lib", "Apple.c", "zebra.c"]);
  });

  it("nests child paths under the parent path", async () => {
    const handle = fakeDirectoryHandle("proj", { src: { "util.c": "" } });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    const srcDir = tree.children!.find((c) => c.name === "src")!;
    expect(srcDir.path).toBe("proj/src");
    expect(srcDir.children![0].path).toBe("proj/src/util.c");
  });

  it("produces file handles that read back their real content", async () => {
    const handle = fakeDirectoryHandle("proj", { "main.c": "int main(){}" });
    const tree = await readDirectoryTree(handle as unknown as FileSystemDirectoryHandle);
    const fileNode = tree.children![0];
    const text = await readFileText(fileNode.handle as FileSystemFileHandle);
    expect(text).toBe("int main(){}");
  });
});

describe("compareNodes", () => {
  it("sorts a directory before a file regardless of name", () => {
    const dir: TreeNode = { name: "zzz", path: "zzz", kind: "directory", handle: {} as never };
    const file: TreeNode = { name: "aaa", path: "aaa", kind: "file", handle: {} as never };
    expect(compareNodes(dir, file)).toBeLessThan(0);
    expect(compareNodes(file, dir)).toBeGreaterThan(0);
  });

  it("sorts same-kind nodes alphabetically, case-insensitively", () => {
    const a: TreeNode = { name: "apple.c", path: "apple.c", kind: "file", handle: {} as never };
    const b: TreeNode = { name: "Banana.c", path: "Banana.c", kind: "file", handle: {} as never };
    expect(compareNodes(a, b)).toBeLessThan(0);
  });
});

describe("readFileText", () => {
  it("reads a handle's file content as text", async () => {
    const dir = fakeDirectoryHandle("root", { "a.c": "hello" });
    const tree = await readDirectoryTree(dir as unknown as FileSystemDirectoryHandle);
    const text = await readFileText(tree.children![0].handle as FileSystemFileHandle);
    expect(text).toBe("hello");
  });
});
