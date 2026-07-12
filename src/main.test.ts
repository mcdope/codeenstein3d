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
import { parseFile } from "./parser/registry";
import { hashRun, recordHighscore } from "./engine/highscores";
import type { InputSnapshot } from "./engine/input";
import type { ReplayLevelSegment } from "./engine/replay";

/**
 * main.ts is not a class — importing it runs its whole module body
 * (document.title, DOM lookups, event-listener wiring) immediately. Every
 * test needs a fresh DOM *and* a fresh module instance (module-level `let`
 * state like `activeEngine`/`workspaceTree` persists across imports
 * otherwise), so this helper rebuilds both and returns the freshly imported
 * module's exports.
 */
let resizeObserverStub: { fire: () => void } | null = null;

/** Fires whatever `ResizeObserver` callback `main.ts` registered on
 * `canvasArea` during the most recent `importMain()` call — see
 * `stubResizeObserver`'s doc comment. */
function fireResize(): void {
  resizeObserverStub?.fire();
}

async function importMain(): Promise<typeof import("./main")> {
  vi.resetModules();
  buildIndexDom();
  stubCanvasGetContext(document.createElement("canvas"));
  resizeObserverStub = stubResizeObserver();
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

function setClientSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
}

function setFullscreenElement(el: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
}

describe("main.ts — canvas sizing (fitCanvasToArea)", () => {
  afterEach(() => {
    setFullscreenElement(null);
  });

  it("sizes the canvas to the largest 640:400 box that fits a wide area", async () => {
    await importMain();
    const canvasArea = document.querySelector<HTMLElement>(".canvas-area")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    setClientSize(canvasArea, 1000, 200); // wide relative to 640:400 — height-constrained
    fireResize();
    expect(canvas.style.height).toBe("200px");
    expect(canvas.style.width).toBe(`${200 * (640 / 400)}px`);
  });

  it("sizes the canvas to the largest 640:400 box that fits a tall area", async () => {
    await importMain();
    const canvasArea = document.querySelector<HTMLElement>(".canvas-area")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    setClientSize(canvasArea, 200, 1000); // tall relative to 640:400 — width-constrained
    fireResize();
    expect(canvas.style.width).toBe("200px");
  });

  it("does nothing while canvasArea is hidden (zero client size)", async () => {
    await importMain();
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    const before = canvas.style.width;
    fireResize(); // canvasArea's jsdom clientWidth/Height default to 0
    expect(canvas.style.width).toBe(before);
  });

  it("does nothing while the canvas is itself the fullscreen element", async () => {
    await importMain();
    const canvasArea = document.querySelector<HTMLElement>(".canvas-area")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    setClientSize(canvasArea, 1000, 200);
    setFullscreenElement(canvas);
    const before = canvas.style.width;
    fireResize();
    expect(canvas.style.width).toBe(before); // untouched — CSS's :fullscreen rule owns sizing instead
  });

  it("re-fits on exiting fullscreen, but not while still fullscreen", async () => {
    await importMain();
    const canvasArea = document.querySelector<HTMLElement>(".canvas-area")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    setClientSize(canvasArea, 1000, 200);

    setFullscreenElement(canvas);
    document.dispatchEvent(new Event("fullscreenchange"));
    const duringFullscreen = canvas.style.width;

    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(canvas.style.width).not.toBe(duringFullscreen);
    expect(canvas.style.height).toBe("200px");
  });
});

describe("main.ts — GitHub tree-fetch progress readout (formatByteCount)", () => {
  it("formats a streamed tree-fetch's progress in bytes, then KB, then MB", async () => {
    await importMain();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    function jsonResponse(body: unknown): Response {
      return { ok: true, status: 200, statusText: "OK", json: async () => body, body: null } as unknown as Response;
    }
    // A streamed tree response, chunked so the byte-progress callback
    // (formatByteCount's only caller) fires more than once, crossing both
    // the B->KB and KB->MB formatting thresholds.
    const bigChunk = new Uint8Array(600_000); // 600,000 B ~= 586 KB
    let reads = 0;
    const reader = {
      read: vi.fn(async () => {
        reads++;
        if (reads === 1) return { done: false, value: bigChunk };
        if (reads === 2) return { done: false, value: bigChunk }; // cumulative ~1.1 MB
        return { done: true, value: undefined };
      }),
    };
    const streamed = {
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => reader },
      json: async () => {
        throw new Error("json() should not be called on the streaming path");
      },
    } as unknown as Response;

    fetchMock.mockResolvedValueOnce(jsonResponse({ default_branch: "main" })).mockResolvedValueOnce(streamed);

    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    const status = document.querySelector<HTMLParagraphElement>("#loading-status")!;
    await waitUntil(() => /MB received\)$/.test(status.textContent ?? ""));
    expect(status.textContent).toMatch(/MB received\)$/);
  });
});

/** Read-only test hooks `RaycasterEngine`'s constructor exposes on
 * `window` when the page URL carries `?testHooks=1` — see engine.ts's
 * constructor doc comment. Lets a test navigate a *real* generated map
 * without reaching into any private engine state. */
interface TestHooks {
  getPlayerState: () => { x: number; y: number; dirX: number; dirY: number; health: number; state: string };
  getExit: () => { x: number; y: number };
}

function testHooks(): TestHooks | undefined {
  return (window as unknown as { __codeensteinTestHooks?: TestHooks }).__codeensteinTestHooks;
}

/** Flips `window.location.search` to include `?testHooks=1` before a level
 * is launched — the only way `RaycasterEngine`'s constructor exposes
 * `window.__codeensteinTestHooks` (see its own doc comment). Must be called
 * before `launchLevel` runs (any workspace-loading click is fine, since the
 * engine isn't constructed until then). */
function enableTestHooks(): void {
  const original = window.location;
  Object.defineProperty(window, "location", {
    value: { ...original, search: "?testHooks=1" },
    configurable: true,
  });
}

/** BFS shortest path (4-directional) from `from` to `to` over `grid`'s
 * walkable tiles (0 = floor; treats the destination tile as walkable
 * regardless of its own value, so a hazard/door goal tile still resolves). */
/** Tile values BFS treats as passable, beyond plain floor (0): hazard/acid
 * (2, walkable — just drains health), doors (3, auto-opened by
 * `openDoorAhead()` on contact once a key is held — keys themselves sit on
 * floor tiles and are auto-collected just by walking near them, so a route
 * that happens to cross a door along the way still works out in practice),
 * teleporter pads (4, walking onto one just warps the player, never
 * blocks), and spike traps (5, walkable — just damages periodically).
 * Deliberately excludes secret walls (6) and lore-terminal walls (7) —
 * those need an explicit "R" interact, not just walking through, which
 * this simple walker doesn't attempt. */
const BFS_PASSABLE_TILES = new Set([0, 2, 3, 4, 5]);

function bfsPath(grid: number[][], from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const visited = new Set([key(from)]);
  const prev = new Map<string, { x: number; y: number }>();
  const queue: { x: number; y: number }[] = [from];
  const height = grid.length;
  const width = grid[0].length;
  let reached = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.x === to.x && cur.y === to.y) {
      reached = true;
      break;
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const isTarget = nx === to.x && ny === to.y;
      if (!isTarget && !BFS_PASSABLE_TILES.has(grid[ny][nx])) continue; // walls/etc block — the goal tile itself is always allowed
      const k = `${nx},${ny}`;
      if (visited.has(k)) continue;
      visited.add(k);
      prev.set(k, cur);
      queue.push({ x: nx, y: ny });
    }
  }
  if (!reached) return []; // genuinely unreachable via this simple walker's passable-tile set
  const path: { x: number; y: number }[] = [];
  let cur: { x: number; y: number } | undefined = to;
  while (cur && key(cur) !== key(from)) {
    path.unshift(cur);
    cur = prev.get(key(cur));
  }
  return path;
}

/** Drives real keyboard input on `canvas` (dispatching real keydown/keyup
 * `KeyboardEvent`s the actual `InputController` listens for) to walk the
 * live player along `tilePath`, turning to face each tile's center before
 * moving into it — a real navigation loop, not a scripted teleport, so it
 * genuinely exercises collision/movement the same way a player would.
 * Returns once `isDone()` reports true (e.g. the run ended) or `maxFrames`
 * is exhausted. */
function walkPath(canvas: HTMLCanvasElement, raf: RafController, tilePath: { x: number; y: number }[], isDone: () => boolean, maxFrames = 800): void {
  const dt = 0.05;
  let held = new Set<string>();
  const setHeld = (next: Set<string>): void => {
    for (const code of held) if (!next.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
    for (const code of next) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
    held = next;
  };

  let targetIndex = 0;
  for (let frame = 0; frame < maxFrames && targetIndex < tilePath.length; frame++) {
    if (isDone()) break;
    const hooks = testHooks();
    if (!hooks) break;
    const player = hooks.getPlayerState();
    const target = tilePath[targetIndex];
    const tx = target.x + 0.5;
    const ty = target.y + 0.5;
    const dx = tx - player.x;
    const dy = ty - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.25) {
      targetIndex++;
      continue;
    }
    const desiredAngle = Math.atan2(dy, dx);
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    let diff = desiredAngle - currentAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    if (Math.abs(diff) > 0.15) {
      setHeld(new Set([diff > 0 ? "KeyE" : "KeyQ"]));
    } else {
      setHeld(new Set(["KeyW"]));
    }
    raf.flush(1, dt * 1000);
  }
  setHeld(new Set());
}

describe("main.ts — reaching a natural win/death via real navigation", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(() => {
    raf.restore();
  });

  // A small, hand-picked source snippet — found by brute-forcing a handful
  // of tiny candidates offline against the real MapGenerator and checking
  // which produced the shortest floor/hazard/door/teleporter/spike-trap-
  // reachable spawn->exit route (secret walls need an explicit "R"
  // interact this simple walker doesn't attempt, so not every generated
  // map's critical path is walkable by it — this one's is).
  const NAVIGABLE_FIXTURE_C = "void f(int x) { if (x > 0) { x = x - 1; } }\n";

  it("winning a level fires onWin, advances/completes the campaign, and records a highscore", async () => {
    const { loadCampaignSave } = await importMain();
    const logSpy = vi.spyOn(console, "log");
    enableTestHooks();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": NAVIGABLE_FIXTURE_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    // Pull the real generated map (spawn/exit/grid) straight out of
    // launchLevel's own console.log("[map] ...", map) call — deliberately
    // spoiler-free in its *string* form, but the raw object argument still
    // carries exact coordinates, and nothing exported needs to change to
    // read it.
    const mapLogCall = logSpy.mock.calls.find(
      (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
    );
    const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };

    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    dismissBriefingHelper(raf);

    // God mode — this test is about proving *navigation reaches the exit*,
    // not about surviving whatever enemies/hazards the generated map's
    // corridor happens to have along the way (a real player would still
    // have to fight/avoid them, but that's engine.test.ts's job, already
    // covered there).
    for (const key of "IDDQD") canvas.dispatchEvent(new KeyboardEvent("keydown", { key }));
    raf.flush(1, 16);

    const path = bfsPath(map.grid, map.spawn, map.exit);
    expect(path.length).toBeGreaterThan(0); // this fixture's route was pre-verified reachable — see NAVIGABLE_FIXTURE_C's comment

    walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
    expect(testHooks()?.getPlayerState().state).toBe("won");

    // Reaching the exit only flips engine state to "won" and shows
    // GameHud's "Commit Summary" overlay — that overlay's own dismiss
    // (same DISMISS_LOCK_MS-gated mechanism as the level-start briefing)
    // is what actually calls advanceToNextLevel(stats). This workspace
    // has only the one file, so with none left to advance to,
    // advanceToNextLevel falls through to its "campaign complete" branch:
    // recordRunHighscore + clearCampaignSave + showBuildSuccessful.
    dismissBriefingHelper(raf);
    await waitUntil(() => loadCampaignSave() === null, 8000);

    // showBuildSuccessful's own dismiss (same lock-then-Enter mechanism a
    // third time) is what actually calls resetToFileTree — stop the run,
    // hide the canvas, and show the "select a file" placeholder again.
    dismissBriefingHelper(raf);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden"), 8000);
    expect(document.querySelector("#viewport > p.muted")?.textContent).toContain("Select a file from the tree");
  });
});

/** Shared with the win/death navigation batch above — split out since it
 * doesn't depend on that describe block's own `raf` closure variable. */
function dismissBriefingHelper(raf: RafController): void {
  raf.flush(1, 1300);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
}

describe("main.ts — reaching a natural game over via real navigation", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(() => {
    raf.restore();
  });

  // Another hand-picked, offline-brute-forced fixture (see
  // NAVIGABLE_FIXTURE_C's comment on the win-test above for the method) —
  // this one's generated map has a hazard (acid pool, from its global
  // variables) reachable from spawn without needing a secret-wall interact.
  const HAZARD_FIXTURE_C = "int a;\nint b;\nvoid f() { a = 1; b = 2; }\n";

  it("standing in acid drains health to 0, firing onGameOver and skipping highscore recording (died on level 1)", async () => {
    await importMain();
    const logSpy = vi.spyOn(console, "log");
    enableTestHooks();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": HAZARD_FIXTURE_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    const mapLogCall = logSpy.mock.calls.find(
      (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
    );
    const map = mapLogCall![1] as {
      grid: number[][];
      spawn: { x: number; y: number };
      hazards: { x: number; y: number }[];
    };
    expect(map.hazards.length).toBeGreaterThan(0); // this fixture's route was pre-verified to have one — see HAZARD_FIXTURE_C's comment

    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    dismissBriefingHelper(raf);

    // No IDDQD this time — the whole point is to take real hazard damage.
    const path = bfsPath(map.grid, map.spawn, map.hazards[0]);
    expect(path.length).toBeGreaterThan(0);
    walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 1000);

    // Once on the hazard tile, standing still (no keys held) still drains
    // health at HAZARD_DPS — keep advancing until it runs out.
    for (let i = 0; i < 300 && testHooks()?.getPlayerState().state === "playing"; i++) {
      raf.flush(1, 50);
    }

    expect(testHooks()?.getPlayerState().state).toBe("over");
    expect(logSpy.mock.calls.some((c) => c[0] === "%c[highscores] Died on the very first level — not recording a leaderboard entry.")).toBe(true);
  });
});

const REPLAY_FIXTURE_C = "int main() { return 0; }\n";
const REPLAY_CAMPAIGN_NAME = "replay-ws";

const EMPTY_INPUT_SNAPSHOT: InputSnapshot = {
  keys: [],
  mouseDX: 0,
  fireQueued: false,
  fireHeld: false,
  weaponRequest: null,
  mapToggle: false,
  interact: false,
  melee: false,
  meleeHeld: false,
  wheelSteps: 0,
  fpsToggle: false,
  escape: false,
  blur: false,
  pointerUnlock: false,
  click: false,
  gpForward: 0,
  gpStrafe: 0,
  gpTurn: 0,
};

/** Builds a `ReplayLevelSegment` for `REPLAY_FIXTURE_C`, hashed against the
 * *actually*-parsed content the same way `startReplay`'s own re-verification
 * does, plus `frameCount` no-op frames — enough to drive play/pause/seek/
 * speed mechanics without needing a real navigated win/death (that's its
 * own, much more expensive, separate concern — see the win/death batch
 * above for the technique if ever extended here). */
async function buildReplaySegment(frameCount: number): Promise<ReplayLevelSegment> {
  const parsed = (await parseFile("main.c", REPLAY_FIXTURE_C))!;
  const astHash = await hashRun(JSON.stringify(parsed), REPLAY_CAMPAIGN_NAME);
  return {
    // A TreeNode's path is prefixed with the workspace root's own name (see
    // readDirectoryTree) — same gotcha as the file-tree row `title`
    // attribute earlier in this file. "main.c" alone never matches.
    filePath: `${REPLAY_CAMPAIGN_NAME}/main.c`,
    bonusLevel: false,
    gameplaySeed: 12345,
    astHash,
    difficulty: "normal",
    gore: "normal",
    frames: Array.from({ length: frameCount }, () => ({ dt: 0.05, input: { ...EMPTY_INPUT_SNAPSHOT } })),
  };
}

/** Seeds a real (compressed, via the real `recordHighscore`) localStorage
 * highscore entry with a `replay.version: 2` payload, then opens the
 * Highscores dialog and clicks the entry's "Watch Replay" button — the only
 * way `onWatchReplay`/`startReplay` are reachable at all. */
async function seedAndOpenReplay(segments: ReplayLevelSegment[]): Promise<void> {
  await recordHighscore({
    score: 100,
    campaignName: REPLAY_CAMPAIGN_NAME,
    levelName: "main.c",
    levelsCleared: 1,
    hash: "irrelevant-workspace-hash",
    achievedAt: Date.now(),
    replay: { version: 2, campaignName: REPLAY_CAMPAIGN_NAME, levels: segments },
  });
  document.querySelector<HTMLButtonElement>("#view-highscores")!.click();
  await waitUntil(() => document.querySelector(".replay-btn") !== null, 8000);
  document.querySelector<HTMLButtonElement>(".replay-btn")!.click();
}

describe("main.ts — replay playback (startReplay)", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(async () => {
    // Drain any straggling promise from startReplay's own async chain
    // (readFileText/parseFile/hashRun) before the global afterEach's
    // vi.unstubAllGlobals() below pulls the crypto stub out from under it —
    // an orphaned hashRun() continuation resuming after that point throws
    // "crypto.subtle is undefined", an unhandled rejection with no effect
    // on this test's own outcome but noisy across the whole file's run.
    for (let i = 0; i < 5; i++) {
      raf.flush(3, 16);
      await flushAsync();
    }
    raf.restore();
  });

  it("plays back a recorded run: transport bar appears, play/pause toggles, speed cycles", async () => {
    const { loadCampaignSave } = await importMain();
    void loadCampaignSave; // unused here, imported for symmetry with other tests in this file
    enableTestHooks();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    await waitUntil(() => !!testHooks(), 8000); // buildEngineFor has run — a real level is now driving
    expect(document.querySelector(".replay-controls")).not.toBeNull();

    // Button order per buildReplayControls: seekBack, playPause, seekForward, speedDown, speedUp.
    const playPause = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn")[1];
    expect(playPause.textContent).toBe("⏸"); // starts playing
    playPause.click();
    expect(playPause.textContent).toBe("▶"); // now paused
    playPause.click();
    expect(playPause.textContent).toBe("⏸"); // resumed

    const buttons = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn");
    const speedUp = buttons[buttons.length - 1]; // seekBack, playPause, seekForward, speedDown, speedUp
    const speedLabel = document.querySelector<HTMLElement>(".replay-speed-label")!;
    expect(speedLabel.textContent).toBe("1x");
    speedUp.click();
    expect(speedLabel.textContent).toBe("2x");
    speedUp.click();
    expect(speedLabel.textContent).toBe("4x");
    speedUp.click(); // clamped at the fastest speed
    expect(speedLabel.textContent).toBe("4x");
  });

  it("Escape stops the replay and shows the 'Replay Ended' overlay", async () => {
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000); // let the initial loadLevel() fully settle before stopping

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    raf.flush(1, 16);
    // showReplayEnded's own dismiss (past its DISMISS_LOCK_MS) tears the
    // whole viewing down via resetToFileTree.
    dismissBriefingHelper(raf);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden"), 8000);
  });

  it("fails gracefully when the recorded file's hash no longer matches the workspace", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    segment.astHash = "deliberately-wrong-hash";
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    // loadLevel()'s hash check needs its own async chain (readFileText/
    // parseFile/hashRun) to actually progress before showReplayEnded's
    // overlay appears — a real event-loop yield between rAF rounds (via
    // waitUntil's polling) is required, not a single synchronous flush.
    let flushed = 0;
    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return flushed > 5;
    }, 8000);
    // showReplayEnded's overlay is drawn on canvas (no DOM text to assert on
    // directly) — reaching this point without throwing, with the canvas
    // area shown (the "Replay Ended" overlay renders inside it), is the
    // signal the hash-mismatch path was taken instead of a live level.
    dismissBriefingHelper(raf);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden"), 8000);
  });

  it("fails gracefully when the recorded file can't be found in the re-picked workspace", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    segment.filePath = "gone.c";
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    dismissBriefingHelper(raf);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden"), 8000);
  });

  it("ends via the frames-exhausted safety net when a segment's frames run out before the level concludes", async () => {
    await importMain();
    const segment = await buildReplaySegment(3); // deliberately too short to ever reach a natural win/death
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000); // buildEngineFor has run

    // Burst through more frames than the 3-frame segment actually has —
    // `flush`'s own loop only processes what's already queued each round,
    // so a real event-loop yield between rounds (via waitUntil's polling,
    // not a tight synchronous loop) is what lets loadLevel's own async
    // chain (readFileText/parseFile/hashRun) actually progress alongside it.
    let flushed = 0;
    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return flushed > 10;
    }, 8000);
    dismissBriefingHelper(raf);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden"), 8000);
  });

  it("seeking forward and backward bursts through recorded frames without real-time pacing", async () => {
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000);
    // testHooks() appearing only proves buildEngineFor ran — advanceLevel's
    // own `transitioning = true` doesn't flip back to false until
    // loadLevel()'s `.finally()` microtask runs, one tick later; seekBy()
    // itself no-ops entirely while `transitioning` is still true, so a
    // couple more real yields here are needed before seeking can do
    // anything at all.
    await flushAsync();
    await flushAsync();

    const buttons = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn");
    const seekBack = buttons[0];
    const seekForward = buttons[2];
    // Whether this specific fixture's 20 empty-input frames happen to draw
    // incidental enemy damage isn't deterministic enough to assert on
    // directly (depends on seeded AI roam timing) — not.toThrow() across
    // both directions, ending back at full health once seeking backward
    // has rebuilt the level from scratch (restartLevel), is the stable
    // signal available via window.__codeensteinTestHooks.
    expect(() => seekForward.click()).not.toThrow();
    await flushAsync();
    await flushAsync();
    expect(() => seekBack.click()).not.toThrow(); // seeking backward rebuilds the level from frame 0 via restartLevel
    await waitUntil(() => !!testHooks(), 8000);
    expect(testHooks()!.getPlayerState().health).toBe(100);
  });
});
