import "./style.css";
import {
  isFileSystemAccessSupported,
  pickWorkspace,
  readDirectoryTree,
  readFileText,
  type TreeNode,
} from "./fs/workspace";
import { renderFileTree } from "./ui/fileTree";

const selectButton = requireElement<HTMLButtonElement>("#select-workspace");
const workspaceName = requireElement<HTMLParagraphElement>("#workspace-name");
const fileTree = requireElement<HTMLElement>("#file-tree");

if (!isFileSystemAccessSupported()) {
  selectButton.disabled = true;
  workspaceName.textContent =
    "This browser does not support the File System Access API. Use Chrome, Edge, or Brave.";
  workspaceName.classList.add("error");
}

selectButton.addEventListener("click", async () => {
  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");

    const tree = await readDirectoryTree(handle);
    workspaceName.textContent = handle.name;

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[workspace] Loaded "${handle.name}"`, tree);
  } catch (err) {
    console.error("[workspace] Failed to read workspace:", err);
    workspaceName.textContent =
      err instanceof Error ? err.message : "Failed to read workspace.";
    workspaceName.classList.add("error");
  }
});

/** Task 1.4: log a clicked file's text content to the console. */
async function handleFileSelected(node: TreeNode): Promise<void> {
  if (node.kind !== "file") return;
  try {
    const text = await readFileText(node.handle as FileSystemFileHandle);
    console.group(`[file] ${node.path} (${text.length} chars)`);
    console.log(text);
    console.groupEnd();
  } catch (err) {
    console.error(`[file] Failed to read "${node.path}":`, err);
  }
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
