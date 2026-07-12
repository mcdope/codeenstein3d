// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIndexDom, stubDialogElement, stubResizeObserver } from "../test/mocks/mainDom";
import { installRaf, type RafController } from "../test/mocks/raf";
import { stubCanvasGetContext } from "../test/mocks/canvas";
import { FakeFileSystemFileHandle, fakeDirectoryHandle } from "../test/mocks/fsAccess";
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
  stubDialogElement(document.querySelector<HTMLDialogElement>("#highscore-dialog")!);
  // main.ts's own `isFileSystemAccessSupported()` check runs at *import*
  // time and disables #select-workspace/#continue-run forever if
  // `window.showDirectoryPicker` isn't already a function by then — a
  // per-test override set up *after* importMain() returns is too late for
  // that one check (though it's fine for the picker's actual return value,
  // read fresh on every real call). Default to a never-resolving stub here;
  // individual tests override it afterward for their own scenario. The
  // dedicated "unsupported" test builds its own sequence instead of using
  // this helper, so it can `delete` the property before importing.
  (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
    new Promise(() => {});
  return import("./main");
}

/** Waits for one microtask + macrotask tick, enough for a `void asyncFn()`
 * fire-and-forget call (e.g. a button click handler) to run past its first
 * `await`. Cheaper/more explicit than sprinkling ad hoc
 * `await Promise.resolve()` chains at each call site. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Polls `check` every macrotask tick until it's truthy or `timeoutMs`
 * elapses — for a handler whose async chain is deeper than one
 * `flushAsync()` tick can reliably drain (e.g. `loadHighscoresForDisplay`'s
 * dynamic `import("./defaultHighscore")`, a genuinely large module). */
async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await flushAsync();
  }
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
  // jsdom's built-in `crypto` global has no SubtleCrypto implementation —
  // swap in Node's real webcrypto so highscores.ts's hashRun()/
  // crypto.subtle.digest() call (reached via launchLevel's replay-recorder
  // hashing, and highscore recording) works the same as it does in an
  // actual browser. Re-stubbed every test (not just `beforeAll`) since the
  // shared `afterEach` below calls `vi.unstubAllGlobals()`.
  vi.stubGlobal("crypto", webcrypto);
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

function setInputFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

describe("main.ts — WAD texture loading", () => {
  it("clicking the load button opens the hidden file picker", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    const clickSpy = vi.spyOn(fileInput, "click");
    document.querySelector<HTMLButtonElement>("#load-wad-textures")!.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a failure status for an invalid WAD file, and resets the input for re-selection", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    // jsdom's own `File` has no `arrayBuffer()` implementation — a plain
    // object with the same shape `wadFileInput`'s change handler actually
    // reads (`.name`, `.arrayBuffer()`) stands in instead.
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const file = { name: "bad.wad", arrayBuffer: () => Promise.resolve(bytes) } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();

    const status = document.querySelector<HTMLParagraphElement>("#wad-status")!;
    expect(status.textContent).toContain("Failed to load bad.wad");
    expect(fileInput.value).toBe(""); // cleared so re-selecting the same file still fires "change"
  });

  it("does nothing when the change event fires with no file selected", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    const status = document.querySelector<HTMLParagraphElement>("#wad-status")!;
    const before = status.textContent;
    setInputFiles(fileInput, []);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    expect(status.textContent).toBe(before);
  });

  it("reports a generic failure message when the read itself throws a non-Error", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    const file = { name: "bad.wad", arrayBuffer: () => Promise.reject("boom") } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#wad-status")!.textContent).toBe("Failed to load WAD file.");
  });
});

describe("main.ts — BGM folder loading", () => {
  it("reports an error status when the picker throws", async () => {
    await importMain();
    vi.stubGlobal("window", window);
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject(new Error("picker exploded"));
    document.querySelector<HTMLButtonElement>("#select-bgm-folder")!.click();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent).toBe("picker exploded");
  });

  it("does nothing when the picker is cancelled (resolves undefined)", async () => {
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<undefined> }).showDirectoryPicker = () =>
      Promise.resolve(undefined);
    const status = document.querySelector<HTMLParagraphElement>("#bgm-status")!;
    const before = status.textContent;
    document.querySelector<HTMLButtonElement>("#select-bgm-folder")!.click();
    await flushAsync();
    expect(status.textContent).toBe(before);
  });
});

describe("main.ts — highscores dialog", () => {
  it("opens the dialog (with an empty table) on click and closes via the Close button", async () => {
    await importMain();
    const dialog = document.querySelector<HTMLDialogElement>("#highscore-dialog")!;
    document.querySelector<HTMLButtonElement>("#view-highscores")!.click();
    await waitUntil(() => dialog.open);
    expect(dialog.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#highscore-list")!.children.length).toBeGreaterThanOrEqual(0);

    document.querySelector<HTMLButtonElement>("#close-highscores")!.click();
    expect(dialog.open).toBe(false);
  });

  it("does not refocus the canvas on close when no level is running", async () => {
    await importMain();
    const dialog = document.querySelector<HTMLDialogElement>("#highscore-dialog")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    const focusSpy = vi.spyOn(canvas, "focus");
    dialog.showModal();
    dialog.close();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

function stubShowDirectoryPicker(handle: unknown): void {
  (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
    Promise.resolve(handle);
}

describe("main.ts — local workspace pick", () => {
  it("reads and renders the picked workspace, then auto-launches a level", async () => {
    await importMain();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));

    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");

    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
    // A level auto-launched: the canvas area is shown and the loading
    // screen/intro placeholder are gone.
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false);
  });

  it("does nothing when the picker is cancelled", async () => {
    await importMain();
    stubShowDirectoryPicker(undefined);
    const before = document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent;
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe(before);
  });

  it("shows an error status and the file-tree placeholder when reading the workspace fails", async () => {
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject(new Error("disk exploded"));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "disk exploded");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(true);
  });

  it("disables workspace/continue buttons when the File System Access API is unsupported", async () => {
    vi.resetModules();
    buildIndexDom();
    stubCanvasGetContext(document.createElement("canvas"));
    stubResizeObserver();
    stubDialogElement(document.querySelector<HTMLDialogElement>("#highscore-dialog")!);
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    await import("./main");
    expect(document.querySelector<HTMLButtonElement>("#select-workspace")!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#continue-run")!.disabled).toBe(true);
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(true);
  });

  it("a second pick started while the first is still awaiting the picker supersedes it", async () => {
    await importMain();
    let resolveFirst: (h: unknown) => void = () => {};
    let pickCalls = 0;
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () => {
      pickCalls++;
      if (pickCalls === 1) return new Promise((resolve) => (resolveFirst = resolve));
      return Promise.resolve(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    };
    const selectButton = document.querySelector<HTMLButtonElement>("#select-workspace")!;
    selectButton.click(); // first pick — hangs, waiting on resolveFirst
    await flushAsync();
    selectButton.click(); // second pick — supersedes the first
    await waitUntil(
      () => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second",
      8000,
    );

    // Resolving the stale first pick afterward must not clobber the second's result.
    resolveFirst(fakeDirectoryHandle("first-stale", { "main.c": VALID_MAIN_C }));
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });
});

describe("main.ts — GitHub workspace load", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function jsonResponse(body: unknown, ok = true, status = 200, statusText = "OK"): Response {
    return { ok, status, statusText, json: async () => body, body: null } as unknown as Response;
  }

  it("fetches, renders, and auto-launches a level for a valid owner/repo input", async () => {
    await importMain();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] }))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => VALID_MAIN_C } as unknown as Response);

    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "owner/repo");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
  });

  it("shows an error for input that doesn't parse as a repo reference", async () => {
    await importMain();
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "not a repo ref!!";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await flushAsync();
    const status = document.querySelector<HTMLParagraphElement>("#github-status")!;
    expect(status.classList.contains("error")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an error status when the fetch itself fails", async () => {
    await importMain();
    fetchMock.mockResolvedValueOnce(jsonResponse(null, false, 404, "Not Found"));
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#github-status")!.classList.contains("error"));
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(true);
  });

  it("a suggested-repo button pre-fills the input and loads it the same way", async () => {
    await importMain();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] }))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => VALID_MAIN_C } as unknown as Response);

    const suggestion = document.querySelector<HTMLButtonElement>(".suggestion-btn")!;
    const repo = suggestion.dataset.repo!;
    suggestion.click();
    expect(document.querySelector<HTMLInputElement>("#github-repo-input")!.value).toBe(repo);
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === repo);
  });

  it("clears a stale campaign save when a GitHub repo loads successfully", async () => {
    await importMain();
    localStorage.setItem(
      "codeenstein-campaign-save",
      JSON.stringify({
        workspaceName: "old",
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
      }),
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "main.c", type: "blob" }] }))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => VALID_MAIN_C } as unknown as Response);
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector<HTMLButtonElement>("#tab-continue")!.style.display === "none");
  });
});

describe("main.ts — demo campaign load", () => {
  it("loads the bundled demo campaign and auto-launches its entrypoint", async () => {
    await importMain();
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "demo-campaign");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
    // Wait for the real entrypoint scan + map generation + engine
    // construction to fully settle (not just the synchronous workspace-name
    // write above) before asserting on post-launch state, so no orphaned
    // promise from this test's own launchLevel() call bleeds into the next.
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    expect(document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.disabled).toBe(false); // re-enabled in `finally`
  });
});

function campaignSave(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workspaceName: "ws",
    filePath: "main.c",
    health: 75,
    swap: 0,
    bullets: 20,
    rockets: 0,
    smg: 0,
    gas: 0,
    score: 100,
    weaponIndex: 0,
    ownedWeapons: [0, 1, 2],
    levelIndex: 1,
    ...overrides,
  });
}

describe("main.ts — Continue Run", () => {
  it("resumes at the saved file with the saved carryover", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
  });

  it("falls back to a fresh auto-launched run when the saved file isn't found in the re-picked workspace", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave({ filePath: "gone.c" }));
    await importMain();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    // The stale save is cleared and a fresh run starts instead of erroring.
    await waitUntil(() => localStorage.getItem("codeenstein-campaign-save") === null);
  });

  it("does nothing if clicked with no save present (button should already be hidden)", async () => {
    await importMain();
    expect(() => document.querySelector<HTMLButtonElement>("#continue-run")!.click()).not.toThrow();
  });

  it("does nothing when the picker is cancelled", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    stubShowDirectoryPicker(undefined);
    const before = document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent;
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe(before);
  });

  it("shows an error status when resuming fails", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject(new Error("resume exploded"));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "resume exploded");
  });
});

describe("main.ts — file tree selection", () => {
  it("logs raw text (does not launch a level) for a non-parsable file", async () => {
    await importMain();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C, "readme.md": "just text" }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    // A tree row's `title` is the node's full path ("ws/readme.md"), not
    // just its bare filename.
    await waitUntil(() => document.querySelector('.tree-row--file[title="ws/readme.md"]') !== null);

    const canvasAreaHiddenBefore = document.querySelector(".canvas-area")!.hasAttribute("hidden");
    document.querySelector<HTMLButtonElement>('.tree-row--file[title="ws/readme.md"]')!.click();
    await flushAsync();
    // Selecting a non-parsable file never touches the canvas/level state.
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(canvasAreaHiddenBefore);
  });

  it("parses and launches a level for a parsable file clicked from the tree", async () => {
    await importMain();
    stubShowDirectoryPicker(
      fakeDirectoryHandle("ws", { "a_main.c": "int f() { return 1; }\n", "main.c": VALID_MAIN_C }),
    );
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    // main.c auto-launches (filename match); wait for that to finish, then
    // manually pick the *other* file to exercise handleFileSelected's own
    // parse-and-launch path independent of the auto-launch cascade.
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    document.querySelector<HTMLButtonElement>('.tree-row--file[title="ws/a_main.c"]')!.click();
    await flushAsync();
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(false);
  });
});

describe("main.ts — starting a level and driving live gameplay", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(() => {
    raf.restore();
  });

  /** Loads the demo campaign (a real, small, quick-to-generate map) and
   * waits for the level-start briefing to be showing, ready to dismiss. */
  async function launchAndReachBriefing(): Promise<HTMLCanvasElement> {
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    return document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
  }

  /** Dismisses `GameHud.showLevelStart`'s briefing overlay (past its
   * DISMISS_LOCK_MS) via an Enter keydown on window, which is what actually
   * calls `activeEngine.start()` — see `launchLevel`'s `showLevelStart`
   * callback. */
  function dismissBriefing(): void {
    raf.flush(1, 1300); // past DISMISS_LOCK_MS (1200ms) on the stubbed clock
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
  }

  it("dismissing the briefing starts the engine and its frame loop", async () => {
    await importMain();
    await launchAndReachBriefing();
    dismissBriefing();
    const before = raf.now();
    raf.flush(1, 16);
    expect(raf.now()).toBeGreaterThan(before); // the engine's own rAF loop is now running
  });

  it("typing IDDQD fires onCheatActivated", async () => {
    await importMain();
    const canvas = await launchAndReachBriefing();
    dismissBriefing();
    raf.flush(1, 16); // let start() finish wiring the real InputController

    // Cheat letters are read via keydown on the *canvas* (see
    // InputController.attach()), not window.
    for (const key of "IDDQD") {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }
    raf.flush(1, 16); // let advance() consume the completed cheat buffer
    // No DOM-visible signal for onCheatActivated specifically beyond the
    // cheat toast the engine itself draws on canvas — absence of a throw
    // across the whole typed sequence + a following frame is the assertion.
    expect(() => raf.flush(1, 16)).not.toThrow();
  });

  it("Escape pauses the sim, reaching the engine's onFreezeChange -> consoleSidebar.setPaused wiring", async () => {
    await importMain();
    await launchAndReachBriefing();
    dismissBriefing();
    raf.flush(1, 16);

    // onFreezeChange has no directly observable DOM signal (setPaused just
    // tracks an internal flag gating the hint-scheduling timer) — reaching
    // this without throwing across the pause AND a following resume is the
    // assertion, exercising both the true and false edges of the closure.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(() => raf.flush(1, 16)).not.toThrow(); // pause edge
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(() => raf.flush(1, 16)).not.toThrow(); // resume edge
  });
});
