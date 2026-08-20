// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Renders a `TreeNode` into a collapsible <ul> file tree in the sidebar.
 * Directories toggle open/closed on click; files invoke `onSelectFile`.
 */
import type { TreeNode } from "../fs/workspace";

export interface FileTreeCallbacks {
  onSelectFile: (node: TreeNode) => void;
}

export function renderFileTree(
  container: HTMLElement,
  root: TreeNode,
  callbacks: FileTreeCallbacks,
): void {
  container.textContent = "";

  // A partial listing is a property of the tree, so it stays on screen for
  // as long as the tree does — a one-off message at load time is exactly
  // what the player misses. Only `fetchGithubTree` ever sets this.
  if (root.truncated) container.appendChild(buildTruncatedNotice());

  // The root's children are the top-level entries of the workspace.
  const list = buildList(root.children ?? [], callbacks);
  container.appendChild(list);
}

/** The wording deliberately matches `doc/user/troubleshooting.md`'s
 * "A big GitHub repo loaded, but it seems incomplete" entry, down to the
 * advice — cloning and using the **Local** tab is the only real fix, since
 * the truncation happens inside GitHub's API before anything here sees it. */
function buildTruncatedNotice(): HTMLElement {
  const notice = document.createElement("p");
  notice.className = "tree-notice";
  notice.textContent =
    // Host-neutral on purpose: this marker is shown for GitHub's own API-side
    // truncation *and* for GitLab/Codeberg trees that stopped at the page cap,
    // and naming one forge in a message the other two can trigger is how a
    // GitLab user gets told GitHub did something.
    "⚠ Partial listing — the file list for this repo came back incomplete, so some " +
    "files are missing. Clone it and use the Local tab for the whole thing.";
  return notice;
}

function buildList(nodes: TreeNode[], callbacks: FileTreeCallbacks): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "tree-list";
  for (const node of nodes) {
    ul.appendChild(buildItem(node, callbacks));
  }
  return ul;
}

function buildItem(node: TreeNode, callbacks: FileTreeCallbacks): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "tree-item";

  const row = document.createElement("button");
  row.type = "button";
  row.className = `tree-row tree-row--${node.kind}`;
  row.title = node.path;

  if (node.kind === "directory") {
    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    twisty.textContent = "▸";

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `📁 ${node.name}`;

    row.append(twisty, label);
    li.appendChild(row);

    const childList = buildList(node.children ?? [], callbacks);
    childList.hidden = true;
    li.appendChild(childList);

    row.addEventListener("click", () => {
      const open = childList.hidden;
      childList.hidden = !open;
      twisty.classList.toggle("tree-twisty--open", Boolean(open));
    });
  } else {
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `📄 ${node.name}`;

    row.appendChild(label);
    li.appendChild(row);

    row.addEventListener("click", () => callbacks.onSelectFile(node));
  }

  return li;
}
