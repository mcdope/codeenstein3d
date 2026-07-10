// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Bundled "Demo level" workspace: the in-repo `/demo-campaign` showcase
 * campaign (one hand-authored level per supported parser language, ramping
 * up to a multi-elite finale — see `doc/dev/*`), built into the same
 * `TreeNode` shape `readDirectoryTree`/`fetchGithubTree` produce so every
 * downstream consumer (the file tree UI, `flattenParsableFiles`, entrypoint
 * detection, level launching, replay) works unmodified. Every file's raw
 * text is inlined into the app's own bundle at build time via
 * `import.meta.glob` — launching it needs no native file-picker prompt, no
 * network request, and works offline.
 */
import { compareNodes, type RemoteFileHandle, type TreeNode } from "./workspace";

export const DEMO_CAMPAIGN_NAME = "demo-campaign";

/** Raw source text of every demo-campaign file, keyed by its glob-resolved
 * module path — eagerly inlined at build time, not fetched at runtime. */
const demoFileContents = import.meta.glob("../../demo-campaign/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** A directory node's `handle` is never actually called (only `kind` is
 * checked before deciding to recurse) — same reasoning as `DIRECTORY_STUB` in
 * `src/fs/github.ts`. */
const DIRECTORY_STUB: RemoteFileHandle = {
  getFile: () => Promise.reject(new Error("Not a file")),
};

/** Builds the synthetic workspace tree for the bundled demo campaign. Pure
 * and synchronous — every file's content is already in memory from the
 * eager glob import above, so there's no "loading" step to await. */
export function loadDemoCampaignTree(): TreeNode {
  const children: TreeNode[] = Object.entries(demoFileContents).map(([modulePath, text]) => {
    const name = modulePath.split("/").pop() ?? modulePath;
    const handle: RemoteFileHandle = { getFile: () => Promise.resolve({ text: () => Promise.resolve(text) }) };
    return { name, path: `${DEMO_CAMPAIGN_NAME}/${name}`, kind: "file", handle };
  });
  children.sort(compareNodes);

  return { name: DEMO_CAMPAIGN_NAME, path: DEMO_CAMPAIGN_NAME, kind: "directory", handle: DIRECTORY_STUB, children };
}
