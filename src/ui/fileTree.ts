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

  // The root's children are the top-level entries of the workspace.
  const list = buildList(root.children ?? [], callbacks);
  container.appendChild(list);
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
      twisty.classList.toggle("tree-twisty--open", open);
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
