// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIndexDom, stubResizeObserver } from "../test/mocks/mainDom";
import { stubCanvasGetContext } from "../test/mocks/canvas";
import { FakeFileSystemFileHandle } from "../test/mocks/fsAccess";
import type { TreeNode } from "./fs/workspace";

/**
 * main.ts is not a class — importing it runs its whole module body
 * (document.title, DOM lookups, event-listener wiring) immediately. Every
 * test needs a fresh DOM *and* a fresh module instance (module-level `let`
 * state like `activeEngine`/`workspaceTree` persists across imports
 * otherwise), so this helper rebuilds both and returns the freshly imported
 * module's exports.
 */
async function importMain(): Promise<typeof import("./main")> {
  vi.resetModules();
  buildIndexDom();
  stubCanvasGetContext(document.createElement("canvas"));
  stubResizeObserver();
  return import("./main");
}

function fileNode(path: string, content = ""): TreeNode {
  const name = path.split("/").pop()!;
  return {
    name,
    path,
    kind: "file",
    handle: new FakeFileSystemFileHandle(name, content) as unknown as FileSystemFileHandle,
  };
}

function dirNode(path: string, children: TreeNode[]): TreeNode {
  const name = path.split("/").pop() ?? path;
  return { name, path, kind: "directory", handle: {} as FileSystemDirectoryHandle, children };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("main.ts — module import / initial DOM wiring", () => {
  it("stamps the build time onto the tab title", async () => {
    await importMain();
    expect(document.title).toContain("Codeenstein 3D");
    expect(document.title).toContain("test-build");
  });

  it("removes the extreme gore option (EXTREME_GORE_ENABLED is false)", async () => {
    await importMain();
    expect(document.querySelector('#gore-select option[value="extreme"]')).toBeNull();
  });

  it("switches launch tabs on click, toggling aria-selected and panel hidden state", async () => {
    await importMain();
    const tabGithub = document.querySelector<HTMLButtonElement>("#tab-github")!;
    const panelGithub = document.querySelector<HTMLElement>("#tab-panel-github")!;
    const tabLocal = document.querySelector<HTMLButtonElement>("#tab-local")!;
    const panelLocal = document.querySelector<HTMLElement>("#tab-panel-local")!;

    expect(tabLocal.getAttribute("aria-selected")).toBe("true");
    expect(panelGithub.hidden).toBe(true);

    tabGithub.click();

    expect(tabGithub.getAttribute("aria-selected")).toBe("true");
    expect(panelGithub.hidden).toBe(false);
    expect(tabLocal.getAttribute("aria-selected")).toBe("false");
    expect(panelLocal.hidden).toBe(true);
  });

  it("initializes gore/difficulty selects from defaults and persists a change", async () => {
    await importMain();
    const goreSelect = document.querySelector<HTMLSelectElement>("#gore-select")!;
    const difficultySelect = document.querySelector<HTMLSelectElement>("#difficulty-select")!;
    expect(goreSelect.value).toBe("normal");
    expect(difficultySelect.value).toBe("normal");

    goreSelect.value = "more";
    goreSelect.dispatchEvent(new Event("change"));
    difficultySelect.value = "hard";
    difficultySelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("codeenstein-gore-level")).toBe("more");
    expect(localStorage.getItem("codeenstein-difficulty")).toBe("hard");
  });

  it("restores a previously-saved gore/difficulty preference on the next import", async () => {
    localStorage.setItem("codeenstein-gore-level", "none");
    localStorage.setItem("codeenstein-difficulty", "easy");
    await importMain();
    expect(document.querySelector<HTMLSelectElement>("#gore-select")!.value).toBe("none");
    expect(document.querySelector<HTMLSelectElement>("#difficulty-select")!.value).toBe("easy");
  });

  it("falls back to defaults for a corrupt saved gore/difficulty value", async () => {
    localStorage.setItem("codeenstein-gore-level", "not-a-real-level");
    localStorage.setItem("codeenstein-difficulty", "not-a-real-difficulty");
    await importMain();
    expect(document.querySelector<HTMLSelectElement>("#gore-select")!.value).toBe("normal");
    expect(document.querySelector<HTMLSelectElement>("#difficulty-select")!.value).toBe("normal");
  });

  it("downgrades a saved 'extreme' gore preference to 'more' while extreme is disabled", async () => {
    localStorage.setItem("codeenstein-gore-level", "extreme");
    await importMain();
    expect(document.querySelector<HTMLSelectElement>("#gore-select")!.value).toBe("more");
  });

  it("initializes volume sliders from defaults and persists a change", async () => {
    await importMain();
    const master = document.querySelector<HTMLInputElement>("#master-vol")!;
    const sfx = document.querySelector<HTMLInputElement>("#sfx-vol")!;
    const bgmVol = document.querySelector<HTMLInputElement>("#bgm-vol")!;
    expect(master.value).toBe("50");
    expect(sfx.value).toBe("100");
    expect(bgmVol.value).toBe("50");

    master.value = "75";
    master.dispatchEvent(new Event("input"));
    expect(localStorage.getItem("codeenstein-master-volume")).toBe("0.75");
  });

  it("restores a previously-saved volume and ignores an out-of-range saved value", async () => {
    localStorage.setItem("codeenstein-sfx-volume", "0.3");
    localStorage.setItem("codeenstein-bgm-volume", "5"); // out of [0,1] — ignored, falls back to default
    await importMain();
    expect(document.querySelector<HTMLInputElement>("#sfx-vol")!.value).toBe("30");
    expect(document.querySelector<HTMLInputElement>("#bgm-vol")!.value).toBe("50");
  });

  it("shows the Continue tab when a campaign save already exists", async () => {
    localStorage.setItem(
      "codeenstein-campaign-save",
      JSON.stringify({
        workspaceName: "ws",
        filePath: "a.c",
        health: 100,
        swap: 0,
        bullets: 10,
        rockets: 0,
        score: 0,
        weaponIndex: 0,
        ownedWeapons: [0, 1, 2],
      }),
    );
    await importMain();
    expect(document.querySelector<HTMLButtonElement>("#tab-continue")!.style.display).toBe("");
  });

  it("leaves the Continue tab hidden when no campaign save exists", async () => {
    await importMain();
    expect(document.querySelector<HTMLButtonElement>("#tab-continue")!.style.display).toBe("none");
  });
});

describe("main.ts — campaign persistence (loadCampaignSave/saveCampaign/clearCampaignSave)", () => {
  it("round-trips a save through save/load", async () => {
    const { saveCampaign, loadCampaignSave } = await importMain();
    saveCampaign({
      workspaceName: "ws",
      filePath: "a.c",
      health: 80,
      swap: 5,
      bullets: 12,
      rockets: 1,
      smg: 3,
      gas: 4,
      score: 500,
      weaponIndex: 1,
      ownedWeapons: [0, 1, 2],
      levelIndex: 2,
    });
    expect(loadCampaignSave()).toEqual({
      workspaceName: "ws",
      filePath: "a.c",
      health: 80,
      swap: 5,
      bullets: 12,
      rockets: 1,
      smg: 3,
      gas: 4,
      score: 500,
      weaponIndex: 1,
      ownedWeapons: [0, 1, 2],
      levelIndex: 2,
    });
  });

  it("returns null when nothing is saved", async () => {
    const { loadCampaignSave } = await importMain();
    expect(loadCampaignSave()).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const { loadCampaignSave } = await importMain();
    localStorage.setItem("codeenstein-campaign-save", "{not json");
    expect(loadCampaignSave()).toBeNull();
  });

  it("returns null when a required field is missing", async () => {
    const { loadCampaignSave } = await importMain();
    localStorage.setItem("codeenstein-campaign-save", JSON.stringify({ workspaceName: "ws" }));
    expect(loadCampaignSave()).toBeNull();
  });

  it("falls back to the legacy 'armor' field name for swap", async () => {
    const { loadCampaignSave } = await importMain();
    localStorage.setItem(
      "codeenstein-campaign-save",
      JSON.stringify({
        workspaceName: "ws",
        filePath: "a.c",
        health: 100,
        armor: 7,
        bullets: 0,
        rockets: 0,
        score: 0,
        weaponIndex: 0,
        ownedWeapons: [],
      }),
    );
    const save = loadCampaignSave();
    expect(save?.swap).toBe(7);
  });

  it("defaults smg/gas/levelIndex for a save written before those fields existed", async () => {
    const { loadCampaignSave } = await importMain();
    localStorage.setItem(
      "codeenstein-campaign-save",
      JSON.stringify({
        workspaceName: "ws",
        filePath: "a.c",
        health: 100,
        swap: 0,
        bullets: 0,
        rockets: 0,
        score: 0,
        weaponIndex: 0,
        ownedWeapons: [],
      }),
    );
    const save = loadCampaignSave();
    expect(save?.smg).toBe(0);
    expect(save?.gas).toBe(0);
    expect(save?.levelIndex).toBe(1);
  });

  it("clearCampaignSave removes the save and hides the Continue tab", async () => {
    const { saveCampaign, clearCampaignSave, loadCampaignSave } = await importMain();
    saveCampaign({
      workspaceName: "ws",
      filePath: "a.c",
      health: 100,
      swap: 0,
      bullets: 0,
      rockets: 0,
      smg: 0,
      gas: 0,
      score: 0,
      weaponIndex: 0,
      ownedWeapons: [],
      levelIndex: 1,
    });
    const tabContinue = document.querySelector<HTMLButtonElement>("#tab-continue")!;
    tabContinue.style.display = "";
    tabContinue.setAttribute("aria-selected", "true");

    clearCampaignSave();

    expect(loadCampaignSave()).toBeNull();
    expect(tabContinue.style.display).toBe("none");
    // The Continue tab can't stay active once hidden — falls back to Local.
    expect(document.querySelector<HTMLButtonElement>("#tab-local")!.getAttribute("aria-selected")).toBe("true");
  });

  it("clearCampaignSave leaves an already-inactive Continue tab's active state untouched", async () => {
    const { clearCampaignSave } = await importMain();
    const tabLocal = document.querySelector<HTMLButtonElement>("#tab-local")!;
    expect(tabLocal.getAttribute("aria-selected")).toBe("true");
    expect(() => clearCampaignSave()).not.toThrow();
    expect(tabLocal.getAttribute("aria-selected")).toBe("true");
  });
});

describe("main.ts — applyForcedUnlocks", () => {
  it("adds nothing below level 4", async () => {
    const { applyForcedUnlocks } = await importMain();
    expect(applyForcedUnlocks([0, 1, 2], 3).sort()).toEqual([0, 1, 2]);
  });

  it("force-unlocks gdb at level 4, ghidra at 8, Friday Hotfix at 12", async () => {
    const { applyForcedUnlocks } = await importMain();
    expect(applyForcedUnlocks([0, 1, 2], 4).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(applyForcedUnlocks([0, 1, 2], 8).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(applyForcedUnlocks([0, 1, 2], 12).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never removes an already-owned weapon", async () => {
    const { applyForcedUnlocks } = await importMain();
    expect(applyForcedUnlocks([0, 1, 2, 6], 1).sort((a, b) => a - b)).toEqual([0, 1, 2, 6]);
  });

  it("doesn't duplicate a weapon already owned before its forced-unlock level", async () => {
    const { applyForcedUnlocks } = await importMain();
    const result = applyForcedUnlocks([0, 1, 2, 3], 4);
    expect(result.filter((i) => i === 3)).toHaveLength(1);
  });
});

describe("main.ts — flattenParsableFiles", () => {
  it("flattens a nested tree to just its parsable files, directories-first depth order", async () => {
    const { flattenParsableFiles } = await importMain();
    const tree = dirNode("root", [
      dirNode("root/src", [fileNode("root/src/a.c", "int main(){}")]),
      fileNode("root/readme.md"), // no registered adapter for .md
      fileNode("root/b.c", "int f(){}"),
    ]);
    const files = await flattenParsableFiles(tree);
    expect(files.map((f) => f.path)).toEqual(["root/src/a.c", "root/b.c"]);
  });

  it("sniffs an extensionless file's content for a shebang before giving up on it", async () => {
    const { flattenParsableFiles } = await importMain();
    const tree = dirNode("root", [fileNode("root/script", "#!/usr/bin/env python\nprint(1)")]);
    const files = await flattenParsableFiles(tree);
    expect(files.map((f) => f.path)).toEqual(["root/script"]);
  });

  it("fires onFileChecked once per file visited, parsable or not", async () => {
    const { flattenParsableFiles } = await importMain();
    const tree = dirNode("root", [fileNode("root/a.c", "x"), fileNode("root/readme.md")]);
    const seen: string[] = [];
    await flattenParsableFiles(tree, () => seen.push("checked"));
    expect(seen).toHaveLength(2);
  });

  it("memoizes the no-callback call for the same root node", async () => {
    const { flattenParsableFiles } = await importMain();
    const tree = dirNode("root", [fileNode("root/a.c", "x")]);
    const first = await flattenParsableFiles(tree);
    const second = await flattenParsableFiles(tree);
    expect(first).toBe(second); // literally the same array instance — cached
  });
});

const VALID_MAIN_C = "int main() {\n  return 0;\n}\n";
const VALID_HELPER_C = "int add(int a, int b) {\n  return a + b;\n}\n";
// Deliberately higher complexity (more decision points) than VALID_HELPER_C,
// so the "best overall" scan-fallback tests can tell them apart.
const VALID_COMPLEX_C =
  "int classify(int x) {\n  if (x < 0) return -1;\n  if (x == 0) return 0;\n  if (x > 100) return 2;\n  return 1;\n}\n";

describe("main.ts — findEntrypoint", () => {
  it("matches a conventional entrypoint filename in real source", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [
      fileNode("root/other.c", VALID_HELPER_C),
      fileNode("root/main.c", VALID_MAIN_C),
    ]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/main.c");
    expect(match?.parsed.language).toBe("c");
  });

  it("falls back to a test/spec-directory filename match when none exists in real source", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [
      fileNode("root/other.c", VALID_HELPER_C),
      fileNode("root/tests/main.c", VALID_MAIN_C),
    ]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/tests/main.c");
  });

  it("falls through to the scored scan when a filename match fails to parse", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [
      // A NUL byte makes isSafeToParse's binary sniff reject it outright —
      // matches by name but parseFile deterministically returns null.
      fileNode("root/main.c", "int main() {\0garbage}"),
      fileNode("root/real.c", VALID_MAIN_C),
    ]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/real.c");
  });

  it("scored scan prefers the highest-complexity file that defines main()", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [
      fileNode("root/complex_no_main.c", VALID_COMPLEX_C),
      fileNode("root/entry.c", VALID_MAIN_C),
    ]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/entry.c");
  });

  it("scored scan falls back to the highest-complexity file overall when nothing defines main()", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [
      fileNode("root/simple.c", VALID_HELPER_C),
      fileNode("root/complex.c", VALID_COMPLEX_C),
    ]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/complex.c");
  });

  it("returns null when nothing in the tree parses at all", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [fileNode("root/readme.md", "just text")]);
    const match = await findEntrypoint(tree);
    expect(match).toBeNull();
  });

  it("stops the scan early once the given signal is already aborted", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [fileNode("root/entry.c", VALID_MAIN_C)]);
    const match = await findEntrypoint(tree, AbortSignal.abort());
    expect(match).toBeNull();
  });
});
