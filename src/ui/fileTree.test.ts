// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../fs/workspace";
import { renderFileTree } from "./fileTree";

function fileNode(name: string, path = name): TreeNode {
  return { name, path, kind: "file", handle: {} as never };
}

function dirNode(name: string, children: TreeNode[] | undefined, path = name): TreeNode {
  return { name, path, kind: "directory", handle: {} as never, children };
}

describe("renderFileTree", () => {
  it("clears any existing container content before rendering", () => {
    const container = document.createElement("div");
    container.textContent = "stale content";
    renderFileTree(container, dirNode("root", []), { onSelectFile: vi.fn() });
    expect(container.textContent).not.toContain("stale content");
  });

  it("renders one row per top-level child", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [fileNode("a.c"), fileNode("b.c")]);
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    const rows = container.querySelectorAll(".tree-row");
    expect(rows).toHaveLength(2);
  });

  it("renders an empty list when the root has no children", () => {
    const container = document.createElement("div");
    renderFileTree(container, dirNode("root", undefined), { onSelectFile: vi.fn() });
    expect(container.querySelector("ul.tree-list")).not.toBeNull();
    expect(container.querySelectorAll(".tree-row")).toHaveLength(0);
  });

  it("renders a file row with a file icon and its own title tooltip", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [fileNode("main.c", "root/main.c")]);
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    const row = container.querySelector(".tree-row--file") as HTMLButtonElement;
    expect(row.title).toBe("root/main.c");
    expect(row.textContent).toBe("📄 main.c");
    expect(row.querySelector(".tree-twisty")).toBeNull();
  });

  it("invokes onSelectFile with the clicked file's node", () => {
    const container = document.createElement("div");
    const file = fileNode("main.c");
    const root = dirNode("root", [file]);
    const onSelectFile = vi.fn();
    renderFileTree(container, root, { onSelectFile });
    (container.querySelector(".tree-row--file") as HTMLButtonElement).click();
    expect(onSelectFile).toHaveBeenCalledWith(file);
  });

  it("renders a directory row with a folder icon, twisty, and a hidden nested list", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [dirNode("src", [fileNode("util.c")])]);
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    const dirRow = container.querySelector(".tree-row--directory") as HTMLButtonElement;
    expect(dirRow.textContent).toContain("📁 src");
    expect(dirRow.querySelector(".tree-twisty")).not.toBeNull();
    const nestedList = dirRow.closest("li")!.querySelector("ul.tree-list") as HTMLUListElement;
    expect(nestedList.hidden).toBe(true);
  });

  it("toggles the nested list and twisty state on click", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [dirNode("src", [fileNode("util.c")])]);
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    const dirRow = container.querySelector(".tree-row--directory") as HTMLButtonElement;
    const nestedList = dirRow.closest("li")!.querySelector("ul.tree-list") as HTMLUListElement;
    const twisty = dirRow.querySelector(".tree-twisty") as HTMLSpanElement;

    dirRow.click();
    expect(nestedList.hidden).toBe(false);
    expect(twisty.classList.contains("tree-twisty--open")).toBe(true);

    dirRow.click();
    expect(nestedList.hidden).toBe(true);
    expect(twisty.classList.contains("tree-twisty--open")).toBe(false);
  });

  it("renders an empty nested list for a directory with no children", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [dirNode("empty-dir", undefined)]);
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    const dirRow = container.querySelector(".tree-row--directory") as HTMLButtonElement;
    const nestedList = dirRow.closest("li")!.querySelector("ul.tree-list") as HTMLUListElement;
    expect(nestedList.children).toHaveLength(0);
  });

  it("does not fire onSelectFile when a directory row is clicked", () => {
    const container = document.createElement("div");
    const root = dirNode("root", [dirNode("src", [])]);
    const onSelectFile = vi.fn();
    renderFileTree(container, root, { onSelectFile });
    (container.querySelector(".tree-row--directory") as HTMLButtonElement).click();
    expect(onSelectFile).not.toHaveBeenCalled();
  });
});
