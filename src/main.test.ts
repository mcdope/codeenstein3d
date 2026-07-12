// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestWad } from "../scripts/fixtures/buildTestWad.mjs";
import { buildIndexDom, stubDialogElement, stubResizeObserver } from "../test/mocks/mainDom";
import { installRaf, type RafController } from "../test/mocks/raf";
import { stubCanvasGetContext } from "../test/mocks/canvas";
import { FakeFileSystemFileHandle, fakeDirectoryHandle } from "../test/mocks/fsAccess";
import type { TreeNode } from "./fs/workspace";
import { parseFile } from "./parser/registry";
import { hashRun, loadHighscores, recordHighscore } from "./engine/highscores";
import type { InputSnapshot } from "./engine/input";
import type { ReplayLevelSegment } from "./engine/replay";
import type { EngineCarryover } from "./engine/engine";
import { GHIDRA_WEAPON_INDEX } from "./engine/weapons";

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

/** A file handle whose `getFile()` always rejects — for exercising the catch
 * blocks around `readFileText` (a real disk/network read failing partway
 * through, as opposed to a file that reads fine but fails to *parse*). */
function throwingFileHandle(name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: () => Promise.reject(new Error("disk read failed")),
  } as unknown as FileSystemFileHandle;
}

function throwingFileNode(path: string): TreeNode {
  const name = path.split("/").pop()!;
  return { name, path, kind: "file", handle: throwingFileHandle(name) };
}

/** A directory handle yielding exactly `entries`, in order — like
 * `fakeDirectoryHandle`, but lets a caller mix in a `throwingFileHandle`
 * alongside ordinary working files, which `fakeDirectoryHandle`'s
 * string-content-only tree shape can't express. */
function directoryHandleWithEntries(
  name: string,
  entries: (FakeFileSystemFileHandle | FileSystemFileHandle)[],
): FileSystemDirectoryHandle {
  return {
    name,
    kind: "directory",
    values: async function* () {
      for (const entry of entries) yield entry;
    },
  } as unknown as FileSystemDirectoryHandle;
}

/** A directory handle whose `.values()` hangs until `gate.resolve()` is
 * called, then either yields `entries` (a normal, if late, read) or throws
 * (a read that fails only after being superseded) — for exercising the
 * `gen !== workspaceLoadGeneration` supersession guards scattered through
 * every workspace-loading entry point: park a load mid-read with this,
 * trigger a second load to bump the generation counter, then release the
 * gate and observe the first load's own stale-generation checkpoint fire. */
function gatedDirectoryHandle(
  name: string,
  gate: { resolve?: () => void },
  behavior: { entries: (FakeFileSystemFileHandle | FileSystemFileHandle)[] } | { throws: Error },
): FileSystemDirectoryHandle {
  return {
    name,
    kind: "directory",
    values: async function* () {
      await new Promise<void>((resolve) => {
        gate.resolve = resolve;
      });
      if ("throws" in behavior) throw behavior.throws;
      for (const entry of behavior.entries) yield entry;
    },
  } as unknown as FileSystemDirectoryHandle;
}

/** A file handle whose `getFile()` hangs until `gate.resolve()` is called —
 * same "park mid-await, supersede, then release" technique as
 * `gatedDirectoryHandle`, but for a single file read (e.g. Continue Run's
 * own saved-file parse step) instead of a whole directory listing. */
function gatedFileHandle(name: string, content: string, gate: { resolve?: () => void }): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => {
      await new Promise<void>((resolve) => {
        gate.resolve = resolve;
      });
      return { text: async () => content };
    },
  } as unknown as FileSystemFileHandle;
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
  // `RaycasterEngine`'s constructor sets this directly on `window` (not via
  // `vi.stubGlobal`, so `vi.unstubAllGlobals()` below doesn't touch it) —
  // `window` itself persists across every test in this file, unlike the
  // rebuilt DOM/reset module. Left uncleared, `!!testHooks()` can be
  // trivially satisfied by a completely unrelated earlier test's own
  // long-gone engine, making a "has *this* test's engine loaded yet" wait
  // pass instantly for the wrong reason. Clearing it here guarantees
  // `!!testHooks()` can only become true again once *this* test's own
  // engine has actually been constructed.
  delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
});

afterEach(async () => {
  // Give any straggling promise from a test's own async chain (e.g.
  // loadLevel's readFileText/parseFile/hashRun, kicked off by a click and
  // never explicitly awaited to completion) a few real event-loop ticks to
  // settle before pulling the crypto/fetch stubs out from under it below —
  // an orphaned continuation resuming after that point throws "crypto.subtle
  // is undefined", an unhandled rejection with no effect on any test's own
  // outcome but noisy across the whole file's run.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("logs a warning instead of throwing when saving the gore/difficulty/volume preferences fails", async () => {
    await importMain();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const warnSpy = vi.spyOn(console, "warn");

    const goreSelect = document.querySelector<HTMLSelectElement>("#gore-select")!;
    goreSelect.value = "more";
    expect(() => goreSelect.dispatchEvent(new Event("change"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("[settings] Failed to save gore level:", expect.any(Error));

    const difficultySelect = document.querySelector<HTMLSelectElement>("#difficulty-select")!;
    difficultySelect.value = "hard";
    expect(() => difficultySelect.dispatchEvent(new Event("change"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("[settings] Failed to save difficulty:", expect.any(Error));

    const masterVolumeInput = document.querySelector<HTMLInputElement>("#master-vol")!;
    masterVolumeInput.value = "10";
    expect(() => masterVolumeInput.dispatchEvent(new Event("input"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("[settings] Failed to save volume:", expect.any(Error));

    setItemSpy.mockRestore();
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

    sfx.value = "40";
    sfx.dispatchEvent(new Event("input"));
    expect(localStorage.getItem("codeenstein-sfx-volume")).toBe("0.4");

    bgmVol.value = "20";
    bgmVol.dispatchEvent(new Event("input"));
    expect(localStorage.getItem("codeenstein-bgm-volume")).toBe("0.2");
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

  it("falls back to defaults for gore/difficulty/volume when localStorage.getItem itself throws", async () => {
    // loadGoreLevel/loadDifficulty/loadVolume all run synchronously at
    // module-import time (their module-level `let` initializers) — the stub
    // must already be in place *before* importMain()'s own `import("./main")`
    // call, not set up afterward like the save-side (setItem) failure tests.
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    await importMain();
    getItemSpy.mockRestore();
    expect(document.querySelector<HTMLSelectElement>("#gore-select")!.value).toBe("normal");
    expect(document.querySelector<HTMLSelectElement>("#difficulty-select")!.value).toBe("normal");
    expect(document.querySelector<HTMLInputElement>("#master-vol")!.value).toBe("50");
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

  it("saveCampaign logs a warning instead of throwing when localStorage.setItem fails", async () => {
    const { saveCampaign } = await importMain();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const warnSpy = vi.spyOn(console, "warn");
    expect(() =>
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
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("[continue] Failed to save campaign progress:", expect.any(Error));
    setItemSpy.mockRestore();
  });

  it("clearCampaignSave swallows a localStorage.removeItem failure", async () => {
    const { clearCampaignSave } = await importMain();
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() => clearCampaignSave()).not.toThrow();
    removeItemSpy.mockRestore();
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

  it("treats a directory node with no children array as empty", async () => {
    const { flattenParsableFiles } = await importMain();
    // Every real tree-building call site (readDirectoryTree, fetchGithubTree,
    // loadDemoCampaignTree) always populates `children`, even for an empty
    // directory — but TreeNode's own type marks it optional, and this
    // function's `node.children ?? []` fallback exists for that case
    // regardless of whether a real constructor currently exercises it.
    const tree: TreeNode = { name: "root", path: "root", kind: "directory", handle: {} as FileSystemDirectoryHandle };
    const files = await flattenParsableFiles(tree);
    expect(files).toEqual([]);
  });

  it("memoizes the no-callback call for the same root node", async () => {
    const { flattenParsableFiles } = await importMain();
    const tree = dirNode("root", [fileNode("root/a.c", "x")]);
    const first = await flattenParsableFiles(tree);
    const second = await flattenParsableFiles(tree);
    expect(first).toBe(second); // literally the same array instance — cached
  });

  it("treats an extensionless file that fails to read as not parsable", async () => {
    const { flattenParsableFiles } = await importMain();
    // Extensionless — isParsableNode has to actually read it (to sniff for a
    // shebang) rather than deciding from the name alone, so a read failure
    // here exercises its own catch, not readFileText's caller's.
    const tree = dirNode("root", [throwingFileNode("root/script"), fileNode("root/a.c", "x")]);
    const files = await flattenParsableFiles(tree);
    expect(files.map((f) => f.path)).toEqual(["root/a.c"]);
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

  it("falls through to the scored scan when a filename match's file itself fails to read", async () => {
    const { findEntrypoint } = await importMain();
    const tree = dirNode("root", [throwingFileNode("root/main.c"), fileNode("root/real.c", VALID_MAIN_C)]);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/real.c");
  });

  it("skips an unreadable file mid-scan and still finds the best of the rest, yielding partway through a large scan", async () => {
    const { findEntrypoint } = await importMain();
    // None of these names match ENTRYPOINT_FILENAMES, forcing the scored
    // scan; 25 files (> ENTRYPOINT_SCAN_CHUNK_SIZE's 20) so the scan's
    // periodic yieldToMainThread() actually fires mid-walk, and one of them
    // fails to read so the scan's own per-file catch runs too.
    const files: TreeNode[] = [];
    for (let i = 0; i < 25; i++) {
      files.push(i === 10 ? throwingFileNode(`root/f${i}.c`) : fileNode(`root/f${i}.c`, VALID_HELPER_C));
    }
    const tree = dirNode("root", files);
    const match = await findEntrypoint(tree);
    expect(match?.file.path).toBe("root/f0.c"); // every working file parses identically — first one wins ties
  });

  it("treats a directory node with no children array as having nothing to check by name", async () => {
    const { findEntrypoint } = await importMain();
    // Same "real constructors always populate children, but the type marks
    // it optional" reasoning as flattenParsableFiles's equivalent test.
    const tree: TreeNode = { name: "root", path: "root", kind: "directory", handle: {} as FileSystemDirectoryHandle };
    const match = await findEntrypoint(tree);
    expect(match).toBeNull();
  });

  it("scores a file with a non-function/method entity (a global variable) alongside a real, not-yet-fired scan signal", async () => {
    const { findEntrypoint } = await importMain();
    // "globals.c" doesn't match ENTRYPOINT_FILENAMES, forcing the scored
    // scan. Its global-variable entities have kind "global" — neither
    // "function" nor "method" — short-circuiting scoreEntrypointCandidate's
    // `(e.kind === "function" || e.kind === "method") && ...` before ever
    // reaching the name check, a combination the other scan tests (all
    // function-only fixtures) never exercise.
    const tree = dirNode("root", [fileNode("root/globals.c", HAZARD_FIXTURE_C)]);
    const match = await findEntrypoint(tree, AbortSignal.timeout(60_000));
    expect(match?.file.path).toBe("root/globals.c");
  });

  it("stops the scored scan mid-walk once its signal becomes aborted partway through", async () => {
    const { findEntrypoint } = await importMain();
    // `findEntrypoint`'s OWN `if (signal?.aborted) return null;` guard (run
    // once, before the scan even starts) is what an *already*-aborted signal
    // hits — this test targets a DIFFERENT check, inside
    // findEntrypointByScanning's own per-file loop, which only sees a signal
    // that *becomes* aborted mid-scan. 25 files (> ENTRYPOINT_SCAN_CHUNK_SIZE's
    // 20) so the scan's own periodic yieldToMainThread() (a real
    // setTimeout(0)) actually yields to the event loop at least once;
    // aborting via a setTimeout(0) registered *before* that first yield
    // fires first once the event loop's macrotask queue is finally
    // processed, so `signal.aborted` is already true by the time the scan
    // resumes for its next file.
    const files: TreeNode[] = [];
    for (let i = 0; i < 25; i++) files.push(fileNode(`root/f${i}.c`, VALID_HELPER_C));
    const tree = dirNode("root", files);
    const controller = new AbortController();
    const matchPromise = findEntrypoint(tree, controller.signal);
    setTimeout(() => controller.abort(), 0);
    const match = await matchPromise;
    expect(match?.file.path).toBe("root/f0.c"); // still finds the best of whatever was scanned before aborting
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

  it("reports the thrown Error's own message when the read itself throws a real Error", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    const file = { name: "bad.wad", arrayBuffer: () => Promise.reject(new Error("disk read failed")) } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#wad-status")!.textContent).toBe("disk read failed");
  });

  it("lists every matched texture role for a WAD that resolves most slots", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    // buildTestWad()'s default fixture resolves wall/door/loreWall (composite)
    // plus floor/hazardFloor/teleporterFloor/spikeSafeFloor/spikeActiveFloor
    // (flats) — 8 of the 10 slots (everything but bonusWall/bonusFloor, which
    // no fixture lump is named for) — enough to exercise every `matched.push`
    // branch plus the "remaining slots using defaults" partial-match branch.
    const bytes = buildTestWad();
    const file = { name: "test.wad", arrayBuffer: () => Promise.resolve(bytes) } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    const status = document.querySelector<HTMLParagraphElement>("#wad-status")!.textContent!;
    expect(status).toContain("Using WAD textures:");
    expect(status).toContain("walls (STARTAN3)");
    expect(status).toContain("doors (BIGDOOR2)");
    expect(status).toContain("floors (FLOOR4_8)");
    expect(status).toContain("lore terminals (COMPUTE2)");
    expect(status).toContain("hazard floors (NUKAGE3)");
    expect(status).toContain("teleporter floors (GATE1)");
    expect(status).toContain("spike traps, safe (FLOOR7_1)");
    expect(status).toContain("spike traps, active (BLOOD1)");
    expect(status).toContain("remaining slots using defaults");
  });

  it("lists the bonus wall/floor roles too and drops the defaults caveat when every slot resolves", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    // texture2Name adds a second composited texture (a real
    // BONUS_WALL_TEXTURE_ALLOWLIST entry) via a TEXTURE2 lump; bonusFloorName
    // adds a real BONUS_FLOOR_TEXTURE_ALLOWLIST-named flat — together with
    // buildTestWad()'s other 8 defaults, all 10 slots resolve.
    const bytes = buildTestWad({ texture2Name: "COMPBLUE", bonusFloorName: "CEIL5_1" });
    const file = { name: "full.wad", arrayBuffer: () => Promise.resolve(bytes) } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    const status = document.querySelector<HTMLParagraphElement>("#wad-status")!.textContent!;
    expect(status).toContain("bonus walls (COMPBLUE)");
    expect(status).toContain("bonus floors (CEIL5_1)");
    expect(status).not.toContain("remaining slots using defaults");
  });

  it("reports the built-in-defaults fallback message when nothing in the WAD matches any allowlisted name", async () => {
    await importMain();
    const fileInput = document.querySelector<HTMLInputElement>("#wad-file-input")!;
    const bytes = buildTestWad({ includeTextures: false, includePlaypal: true, includeFlats: false });
    const file = { name: "empty.wad", arrayBuffer: () => Promise.resolve(bytes) } as unknown as File;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change"));
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#wad-status")!.textContent).toBe(
      "No matching textures found in empty.wad — using built-in defaults",
    );
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

  it("reports a generic failure message when the picker throws a non-Error", async () => {
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject("boom");
    document.querySelector<HTMLButtonElement>("#select-bgm-folder")!.click();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent).toBe("Failed to load BGM folder.");
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

  it("reports the loaded track count on a successful folder load", async () => {
    await importMain();
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    stubShowDirectoryPicker(fakeDirectoryHandle("tracks", { "a.mp3": "A", "b.ogg": "B" }));
    document.querySelector<HTMLButtonElement>("#select-bgm-folder")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent !== "No custom music loaded");
    expect(document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent).toBe('Playing 2 track(s) from "tracks"');
    playSpy.mockRestore();
  });

  it("reports no tracks found for a folder with nothing playable", async () => {
    await importMain();
    stubShowDirectoryPicker(fakeDirectoryHandle("tracks", { "notes.txt": "x" }));
    document.querySelector<HTMLButtonElement>("#select-bgm-folder")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent !== "No custom music loaded");
    expect(document.querySelector<HTMLParagraphElement>("#bgm-status")!.textContent).toBe(
      'No .mp3/.ogg/.wav files found in "tracks"',
    );
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

  it("refocuses the canvas on close while a level is running", async () => {
    await importMain();
    // activeEngine is assigned synchronously inside launchLevel, before the
    // level-start briefing is even dismissed — reaching the canvas-visible
    // state alone is enough, no need to drive the briefing/engine further.
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    const dialog = document.querySelector<HTMLDialogElement>("#highscore-dialog")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    const focusSpy = vi.spyOn(canvas, "focus");
    dialog.showModal();
    dialog.close();
    expect(focusSpy).toHaveBeenCalled();
  });
});

function stubShowDirectoryPicker(handle: unknown): void {
  (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
    Promise.resolve(handle);
}

describe("main.ts — local workspace pick", () => {
  it("falls back to the file-tree-scan progress readout when nothing matches an entrypoint convention", async () => {
    await importMain();
    // No filename matches ENTRYPOINT_FILENAMES, and nothing here parses at
    // all — findEntrypoint's whole cascade returns null, so
    // autoLaunchInitialLevel falls to its own "Scanning file tree… (N/Total)"
    // branch (countTreeFiles + flattenParsableFiles), landing on the
    // "select a file" placeholder since nothing parsable was found either.
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "readme.md": "just some notes, not source" }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    await waitUntil(() => document.querySelector("#viewport > p.muted") !== null, 8000);
    expect(document.querySelector("#viewport > p.muted")?.textContent).toContain("Select a file from the tree");
  });

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

  it("reports a generic failure message when reading the workspace throws a non-Error", async () => {
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject("boom");
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(
      () => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "Failed to read workspace.",
    );
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

  it("throws immediately at import time if index.html is missing a required element", async () => {
    vi.resetModules();
    buildIndexDom();
    document.querySelector("#master-vol")!.remove(); // a required id every real index.html always has
    stubCanvasGetContext(document.createElement("canvas"));
    stubResizeObserver();
    stubDialogElement(document.querySelector<HTMLDialogElement>("#highscore-dialog")!);
    await expect(import("./main")).rejects.toThrow("Missing required element: #master-vol");
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

  it("a load superseded while reading the (already-picked) workspace tree doesn't clobber the newer one", async () => {
    await importMain();
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle("first-stale", gate, { entries: [new FakeFileSystemFileHandle("main.c", VALID_MAIN_C)] }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await flushAsync(); // let pickWorkspace resolve and readDirectoryTree start hanging on the gate
    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.(); // release the stale read — it now resolves, but too late
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("a load whose workspace read fails after being superseded doesn't clobber the newer one's status", async () => {
    await importMain();
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle("first-stale", gate, { throws: new Error("stale read failed") }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await flushAsync();
    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.(); // release the stale read — it now rejects, but too late to matter
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
  });
});

describe("main.ts — whole-codebase stats background aggregation (kickOffCodebaseStats)", () => {
  it("skips a file that fails to read during aggregation but still aggregates the rest", async () => {
    await importMain();
    const warnSpy = vi.spyOn(console, "warn");
    stubShowDirectoryPicker(
      directoryHandleWithEntries("ws", [
        new FakeFileSystemFileHandle("main.c", VALID_MAIN_C),
        throwingFileHandle("broken.c"),
      ]),
    );
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    await waitUntil(
      () => warnSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes('Failed to parse "ws/broken.c"')),
      8000,
    );
  });

  it("falls back to zeroed stats and logs a warning when the whole aggregation pass rejects", async () => {
    await importMain();
    const warnSpy = vi.spyOn(console, "warn");
    // No parsable files at all: computeCodebaseStats's file loop runs zero
    // iterations, so its own hashRun(...) call — the one thing that can
    // still reject with nothing else in flight to race against — is
    // cleanly isolated to exactly this aggregation pass.
    const digestSpy = vi.spyOn(webcrypto.subtle, "digest").mockRejectedValueOnce(new Error("digest exploded"));
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "readme.md": "just text" }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    await waitUntil(
      () => warnSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0] === "[codebase-stats] Aggregation failed:"),
      8000,
    );
    digestSpy.mockRestore();
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

  it("reports a generic failure message when the fetch throws a non-Error", async () => {
    await importMain();
    fetchMock.mockRejectedValueOnce("boom");
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#github-status")!.classList.contains("error"));
    expect(document.querySelector<HTMLParagraphElement>("#github-status")!.textContent).toBe("Failed to load repository.");
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

  it("does nothing when a suggested-repo button has no repo data (defensive — every real one is statically set)", async () => {
    await importMain();
    const suggestion = document.querySelector<HTMLButtonElement>(".suggestion-btn")!;
    delete suggestion.dataset.repo;
    expect(() => suggestion.click()).not.toThrow();
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("falls back to the first parsable file in tree order when nothing matches an entrypoint name (scoring is skipped for remote workspaces)", async () => {
    await importMain();
    const logSpy = vi.spyOn(console, "log");
    // "helper.c" matches no ENTRYPOINT_FILENAMES convention. findEntrypoint's
    // scored-scan fallback is skipped entirely for a remote, non-demo
    // workspace (see its own doc comment) — so autoLaunchInitialLevel's own
    // "no detected entrypoint" fallback (first parsable file in tree order)
    // is what launches this file, not the scoring cascade.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "helper.c", type: "blob" }] }))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => VALID_HELPER_C } as unknown as Response);
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    // A GitHub tree's individual file paths are prefixed with just the repo
    // name (per fs/github.ts's buildTree), not "owner/repo" the way
    // workspaceRootName itself is — a different prefix than the workspace
    // name shown elsewhere, easy to get wrong.
    expect(
      logSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("auto-starting at repo/helper.c (first file in tree order)"),
      ),
    ).toBe(true);
  });

  it("shows the file-tree placeholder when the scan-fallback's chosen file reads fine but fails to parse", async () => {
    await importMain();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "helper.c", type: "blob" }] }))
      // A NUL byte makes isSafeToParse's binary sniff reject it outright —
      // reads successfully, but parseFile deterministically returns null.
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => "int f() {\0garbage}" } as unknown as Response);
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector("#viewport > p.muted") !== null, 8000);
    expect(document.querySelector("#viewport > p.muted")?.textContent).toContain("Select a file from the tree");
  });

  it("shows the file-tree placeholder when the scan-fallback's chosen file fails to read entirely", async () => {
    await importMain();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "helper.c", type: "blob" }] }))
      .mockResolvedValueOnce(jsonResponse(null, false, 500, "Internal Server Error"));
    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await waitUntil(() => document.querySelector("#viewport > p.muted") !== null, 8000);
    expect(document.querySelector("#viewport > p.muted")?.textContent).toContain("Select a file from the tree");
  });

  it("a load superseded while fetching from GitHub doesn't clobber the newer one", async () => {
    await importMain();
    // The GitHub load/suggestion buttons disable themselves for the whole
    // fetch's duration, so a *second* GitHub load can't be the one that
    // supersedes it via the DOM — but beginWorkspaceLoad's generation
    // counter is shared across every loading entry point, so a demo
    // campaign load (its own, always-enabled button) supersedes it exactly
    // the same way a second GitHub/local load would.
    let releaseStale: ((res: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string) => {
      if (url === "https://api.github.com/repos/owner/stale") {
        return new Promise<Response>((resolve) => (releaseStale = resolve));
      }
      return Promise.resolve(jsonResponse({ tree: [] })); // never actually reached — gen check bails first
    });

    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/stale";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await flushAsync(); // let the stale load's default_branch fetch start hanging

    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "demo-campaign", 8000);

    releaseStale?.(jsonResponse({ default_branch: "main" })); // the stale fetch finally resolves, but too late
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("demo-campaign");
  });

  it("a load whose GitHub fetch fails after being superseded doesn't clobber the newer one's status", async () => {
    await importMain();
    let releaseStale: ((err: unknown) => void) | undefined;
    fetchMock.mockImplementation((url: string) => {
      if (url === "https://api.github.com/repos/owner/stale") {
        return new Promise<Response>((_resolve, reject) => (releaseStale = reject));
      }
      return Promise.resolve(jsonResponse({ tree: [] }));
    });

    document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/stale";
    document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
    await flushAsync();

    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "demo-campaign", 8000);

    releaseStale?.(new Error("stale fetch failed")); // rejects only after being superseded
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("demo-campaign");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
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

  it("shows an error status when building the bundled demo campaign's tree fails", async () => {
    vi.doMock("./fs/demoCampaign", async () => {
      const actual = await vi.importActual<typeof import("./fs/demoCampaign")>("./fs/demoCampaign");
      return {
        ...actual,
        loadDemoCampaignTree: () => {
          throw new Error("bundle exploded");
        },
      };
    });
    await importMain();
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "bundle exploded");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.disabled).toBe(false);
    vi.doUnmock("./fs/demoCampaign");
  });

  it("reports a generic failure message when building the demo campaign's tree throws a non-Error", async () => {
    vi.doMock("./fs/demoCampaign", async () => {
      const actual = await vi.importActual<typeof import("./fs/demoCampaign")>("./fs/demoCampaign");
      return {
        ...actual,
        loadDemoCampaignTree: () => {
          throw "boom";
        },
      };
    });
    await importMain();
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(
      () => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "Failed to load demo campaign.",
    );
    vi.doUnmock("./fs/demoCampaign");
  });
});

function campaignSave(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workspaceName: "ws",
    // A TreeNode's path is prefixed with the workspace root's own name (see
    // readDirectoryTree) — same gotcha noted throughout this file. A bare
    // "main.c" here would never match "ws/main.c" in the re-picked tree,
    // silently falling into the "saved file not found" branch instead.
    filePath: "ws/main.c",
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
    // levelIndex 4 with no owned weapons crosses both the gdb forced-unlock
    // threshold (applyForcedUnlocks) and the Toolchain secret-room-eligibility
    // threshold (computeMissingWeaponIndices) — reached only through a
    // carryover-bearing launchLevel() call, which a fresh pick never
    // provides, only Continue Run/advanceToNextLevel do.
    localStorage.setItem("codeenstein-campaign-save", campaignSave({ levelIndex: 4, ownedWeapons: [] }));
    await importMain();
    const logSpy = vi.spyOn(console, "log");
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    expect(
      logSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("campaign level 4: gdb unlocked as a safety net"),
      ),
    ).toBe(true);
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

  it("reports a generic failure message when resuming throws a non-Error", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject("boom");
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(
      () => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "Failed to resume campaign.",
    );
  });

  it("shows the file-tree placeholder when the saved file is found but no longer parses", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    // Matches campaignSave()'s "ws/main.c" path, so it gets past the
    // not-found check — but a NUL byte makes isSafeToParse's binary sniff
    // reject it outright.
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": "int main() {\0garbage}" }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws");
    await waitUntil(() => document.querySelector("#viewport > p.muted") !== null, 8000);
    expect(document.querySelector("#viewport > p.muted")?.textContent).toContain("Select a file from the tree");
  });

  it("a resume superseded while its own picker is still open doesn't clobber the newer load", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    let releasePicker: ((h: unknown) => void) | undefined;
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      new Promise((resolve) => (releasePicker = resolve));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await flushAsync();

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    releasePicker?.(fakeDirectoryHandle("stale", { "main.c": VALID_MAIN_C })); // resolves, but too late
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("a resume superseded while re-reading the workspace doesn't clobber the newer load", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle("stale", gate, { entries: [new FakeFileSystemFileHandle("main.c", VALID_MAIN_C)] }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await flushAsync();

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("a resume superseded while parsing the saved file doesn't clobber the newer load", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(directoryHandleWithEntries("ws", [gatedFileHandle("main.c", VALID_MAIN_C, gate)]));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws", 8000);

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("a resume whose workspace read fails after being superseded doesn't clobber the newer load's status", async () => {
    localStorage.setItem("codeenstein-campaign-save", campaignSave());
    await importMain();
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle("stale", gate, { throws: new Error("stale resume failed") }));
    document.querySelector<HTMLButtonElement>("#continue-run")!.click();
    await flushAsync();

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
    expect(document.querySelector<HTMLElement>("#workspace-name")!.classList.contains("error")).toBe(false);
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

  it("launches a .h file as a BONUS restock level", async () => {
    await importMain();
    const logSpy = vi.spyOn(console, "log");
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C, "helper.h": VALID_HELPER_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    document.querySelector<HTMLButtonElement>('.tree-row--file[title="ws/helper.h"]')!.click();
    await flushAsync();
    expect(logSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("BONUS restock level"))).toBe(true);
  });

  it("logs an error and leaves the level state untouched when a clicked file fails to read", async () => {
    await importMain();
    stubShowDirectoryPicker(
      directoryHandleWithEntries("ws", [
        new FakeFileSystemFileHandle("main.c", VALID_MAIN_C),
        throwingFileHandle("broken.c"),
      ]),
    );
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    const errorSpy = vi.spyOn(console, "error");
    document.querySelector<HTMLButtonElement>('.tree-row--file[title="ws/broken.c"]')!.click();
    await flushAsync();
    expect(errorSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes('Failed to read/parse "ws/broken.c"'))).toBe(
      true,
    );
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(false); // the already-running level is untouched
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
    // (formatByteCount's only caller) fires more than once, crossing all
    // three formatting thresholds: raw bytes, then KB, then MB.
    const tinyChunk = new Uint8Array(500); // under 1024 B — stays in the "B" range
    const bigChunk = new Uint8Array(600_000); // 600,000 B ~= 586 KB
    let reads = 0;
    const reader = {
      read: vi.fn(async () => {
        reads++;
        if (reads === 1) return { done: false, value: tinyChunk };
        if (reads === 2) return { done: false, value: bigChunk };
        if (reads === 3) return { done: false, value: bigChunk }; // cumulative ~1.1 MB
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

// A small, hand-picked source snippet — found by brute-forcing a handful of
// tiny candidates offline against the real MapGenerator and checking which
// produced the shortest floor/hazard/door/teleporter/spike-trap-reachable
// spawn->exit route (secret walls need an explicit "R" interact this simple
// walker doesn't attempt, so not every generated map's critical path is
// walkable by it — this one's is). Module-scoped since both the live-DOM win
// test and recordNavigatedWinSegment() (for the replay batch) reuse it.
const NAVIGABLE_FIXTURE_C = "void f(int x) { if (x > 0) { x = x - 1; } }\n";

// Another hand-picked, offline-brute-forced fixture (see
// NAVIGABLE_FIXTURE_C's comment above for the method) — this one's
// generated map has a hazard (acid pool, from its global variables)
// reachable from spawn without needing a secret-wall interact.
const HAZARD_FIXTURE_C = "int a;\nint b;\nvoid f() { a = 1; b = 2; }\n";

describe("main.ts — reaching a natural win/death via real navigation", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(() => {
    raf.restore();
  });

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

  it(
    "winning without any cheats used actually records a leaderboard entry (recordRunHighscore's real path)",
    // A stalled-in-combat retry attempt can burn through walkPath's full
    // 500-frame budget as real synchronous engine work — comfortably past
    // the 5s default test timeout even though a clean run only needs a
    // couple hundred ms — hence the longer per-attempt timeout, not just retries.
    { retry: 10, timeout: 15000 },
    async () => {
      // The other win test above uses IDDQD to guarantee it survives the walk
      // to the exit — but that sets cheatsUsed, which makes recordRunHighscore
      // bail out before its own try body (the codebase-stats wait, hashing,
      // and recordHighscore call) ever runs. This test skips the cheat
      // entirely to reach that real path — but without god mode, this
      // fixture's small pool of seeded-AI enemies can (occasionally) land
      // enough incidental hits to kill the player before the exit, since
      // enemy aggro/fire timing is seeded independently of the map layout
      // itself (see gameplaySeed's own doc comment in launchLevel) — retried
      // rather than chasing a fixture with zero enemies, which
      // MapGenerator's own minimum-enemy-count floor makes unreachable
      // regardless of source complexity (confirmed by brute-forcing several
      // tiny candidates offline, same technique as NAVIGABLE_FIXTURE_C's own
      // comment describes).
      const { loadCampaignSave } = await importMain();
      const logSpy = vi.spyOn(console, "log");
      enableTestHooks();
      stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": NAVIGABLE_FIXTURE_C }));
      document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
      await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

      const mapLogCall = logSpy.mock.calls.find(
        (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
      );
      const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
      dismissBriefingHelper(raf);

      const path = bfsPath(map.grid, map.spawn, map.exit);
      expect(path.length).toBeGreaterThan(0);
      walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
      expect(testHooks()?.getPlayerState().state).toBe("won");

      dismissBriefingHelper(raf); // -> advanceToNextLevel -> campaign complete -> recordRunHighscore
      await waitUntil(() => loadCampaignSave() === null, 8000);
      const start = Date.now();
      let entries: Awaited<ReturnType<typeof loadHighscores>> = [];
      while (entries.length === 0) {
        if (Date.now() - start > 8000) throw new Error("timed out waiting for a recorded highscore");
        entries = await loadHighscores();
        if (entries.length === 0) await flushAsync();
      }
      expect(entries[0].campaignName).toBe("ws");
      expect(entries[0].levelsCleared).toBe(1);
    },
  );

  it(
    "logs a warning instead of throwing when recordHighscore itself fails",
    // Same uncheated-navigation flakiness as the test above — see its own comment.
    { retry: 10, timeout: 15000 },
    async () => {
      // Mocking recordHighscore directly (rather than CampaignReplayRecorder's
      // finish(), tried first) — a prototype spy on finish() left the whole
      // async chain permanently stuck (recordRunHighscore's own promise never
      // settled, even though its logic provably can't hang on inspection);
      // root cause not isolated, so this sidesteps it with a module-level
      // mock of the one function whose failure this test actually needs.
      vi.doMock("./engine/highscores", async () => {
        const actual = await vi.importActual<typeof import("./engine/highscores")>("./engine/highscores");
        return { ...actual, recordHighscore: vi.fn().mockRejectedValue(new Error("record exploded")) };
      });
      const { loadCampaignSave } = await importMain();
      const logSpy = vi.spyOn(console, "log");
      const warnSpy = vi.spyOn(console, "warn");
      enableTestHooks();
      stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": NAVIGABLE_FIXTURE_C }));
      document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
      await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

      const mapLogCall = logSpy.mock.calls.find(
        (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
      );
      const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
      dismissBriefingHelper(raf);

      const path = bfsPath(map.grid, map.spawn, map.exit);
      expect(path.length).toBeGreaterThan(0);
      walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
      expect(testHooks()?.getPlayerState().state).toBe("won");

      dismissBriefingHelper(raf); // -> advanceToNextLevel -> campaign complete -> recordRunHighscore -> recordHighscore() throws
      await waitUntil(() => loadCampaignSave() === null, 8000);
      await waitUntil(
        () => warnSpy.mock.calls.some((c) => c[0] === "[highscores] Failed to record this level's score:"),
        8000,
      );
      vi.doUnmock("./engine/highscores");
    },
  );

  it(
    "winning a level on a remote (GitHub) workspace records a highscore via the no-codebase-stats hash fallback",
    // Same uncheated-navigation flakiness as the tests above.
    { retry: 10, timeout: 15000 },
    async () => {
      // kickOffCodebaseStats skips whole-codebase aggregation entirely for
      // any remote workspace, leaving codebaseStatsPromise permanently
      // null — the one real way recordRunHighscore's own
      // `withTimeout(codebaseStatsPromise, ...)` call sees a null promise
      // (short-circuiting to undefined immediately) instead of a real,
      // already-resolved one, and falls back to hashing just the
      // ended-on file's own AST instead of the whole-workspace hash.
      const { loadCampaignSave } = await importMain();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", json: async () => ({ default_branch: "main" }), body: null } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ tree: [{ path: "main.c", type: "blob" }] }),
          body: null,
        } as unknown as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => NAVIGABLE_FIXTURE_C } as unknown as Response);
      const logSpy = vi.spyOn(console, "log");
      enableTestHooks();
      document.querySelector<HTMLInputElement>("#github-repo-input")!.value = "owner/repo";
      document.querySelector<HTMLButtonElement>("#load-github-repo")!.click();
      await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

      const mapLogCall = logSpy.mock.calls.find(
        (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
      );
      const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
      dismissBriefingHelper(raf);

      const path = bfsPath(map.grid, map.spawn, map.exit);
      expect(path.length).toBeGreaterThan(0);
      walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
      expect(testHooks()?.getPlayerState().state).toBe("won");

      dismissBriefingHelper(raf);
      await waitUntil(() => loadCampaignSave() === null, 8000);
      const start = Date.now();
      let entries: Awaited<ReturnType<typeof loadHighscores>> = [];
      while (entries.length === 0) {
        if (Date.now() - start > 8000) throw new Error("timed out waiting for a recorded highscore");
        entries = await loadHighscores();
        if (entries.length === 0) await flushAsync();
      }
      expect(entries[0].campaignName).toBe("owner/repo");
      expect(entries[0].source).toBe("github");
    },
  );

  it(
    "winning a level on the bundled demo campaign records a highscore with source \"demo\"",
    // No IDDQD here (unlike the very first win test above) — cheatsUsed
    // makes recordRunHighscore bail out before it ever reaches the
    // recordHighscore call this test needs to observe, same reasoning as
    // "winning without any cheats used..." above. Retried for the same
    // uncheated-navigation combat variance that test documents.
    { retry: 10, timeout: 15000 },
    async () => {
      // workspaceIsDemo (checked *before* workspaceIsRemote in
      // recordRunHighscore's `source: workspaceIsDemo ? "demo" : ...`
      // ternary — both flags are true for a demo load, see loadDemoCampaign)
      // is only reachable via an actual demo-campaign win — every other win
      // test above uses a local or GitHub workspace instead. The *real*
      // bundled demo-campaign has 17 files/levels, so winning its actual
      // main.c would just advance to the next file, not complete the
      // campaign — mock a single-file demo tree instead, using the same
      // navigable fixture the other win tests already rely on.
      vi.doMock("./fs/demoCampaign", async () => {
        const actual = await vi.importActual<typeof import("./fs/demoCampaign")>("./fs/demoCampaign");
        return {
          ...actual,
          loadDemoCampaignTree: () => ({
            name: actual.DEMO_CAMPAIGN_NAME,
            path: actual.DEMO_CAMPAIGN_NAME,
            kind: "directory",
            handle: { getFile: () => Promise.reject(new Error("not a file")) },
            children: [
              {
                name: "main.c",
                path: `${actual.DEMO_CAMPAIGN_NAME}/main.c`,
                kind: "file",
                handle: { getFile: () => Promise.resolve({ text: () => Promise.resolve(NAVIGABLE_FIXTURE_C) }) },
              },
            ],
          }),
        };
      });
      const { loadCampaignSave } = await importMain();
      const logSpy = vi.spyOn(console, "log");
      enableTestHooks();
      document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
      await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

      const mapLogCall = logSpy.mock.calls.find(
        (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
      );
      const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
      dismissBriefingHelper(raf);

      const path = bfsPath(map.grid, map.spawn, map.exit);
      expect(path.length).toBeGreaterThan(0);
      walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
      expect(testHooks()?.getPlayerState().state).toBe("won");

      dismissBriefingHelper(raf);
      await waitUntil(() => loadCampaignSave() === null, 8000);
      const start = Date.now();
      let entries: Awaited<ReturnType<typeof loadHighscores>> = [];
      while (entries.length === 0) {
        if (Date.now() - start > 8000) throw new Error("timed out waiting for a recorded highscore");
        entries = await loadHighscores();
        if (entries.length === 0) await flushAsync();
      }
      expect(entries[0].campaignName).toBe("demo-campaign");
      expect(entries[0].source).toBe("demo");
      vi.doUnmock("./fs/demoCampaign");
    },
  );

  it("advances to the next parsable file after clearing a level, carrying stats over", async () => {
    const { loadCampaignSave } = await importMain();
    const logSpy = vi.spyOn(console, "log");
    enableTestHooks();
    // "main.c" (the navigable fixture) sorts before "zzz_next.c" alphabetically
    // (readDirectoryTree/fakeDirectoryHandle both sort directories-first, then
    // alphabetically) and matches ENTRYPOINT_FILENAMES, so it's both the
    // auto-launched level *and* the first one in tree order to advance past.
    stubShowDirectoryPicker(
      fakeDirectoryHandle("ws", { "main.c": NAVIGABLE_FIXTURE_C, "zzz_next.c": VALID_MAIN_C }),
    );
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    const mapLogCall = logSpy.mock.calls.find(
      (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
    );
    const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    dismissBriefingHelper(raf);
    for (const key of "IDDQD") canvas.dispatchEvent(new KeyboardEvent("keydown", { key }));
    raf.flush(1, 16);

    const path = bfsPath(map.grid, map.spawn, map.exit);
    expect(path.length).toBeGreaterThan(0);
    walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
    expect(testHooks()?.getPlayerState().state).toBe("won");

    dismissBriefingHelper(raf); // -> advanceToNextLevel -> finds zzz_next.c, reads/parses/launches it
    await waitUntil(
      () => logSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("cleared — advancing to ws/zzz_next.c")),
      8000,
    );
    // A fresh save was written for the new level, and the level index/canvas
    // both reflect the new level is now actually running.
    expect(loadCampaignSave()?.filePath).toBe("ws/zzz_next.c");
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(false);
  });

  it("skips a next-in-order file that fails to read, advancing to the one after it instead", async () => {
    const { loadCampaignSave } = await importMain();
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");
    enableTestHooks();
    // Tree order: main.c (auto-launched, win target) -> next_broken.c (fails
    // to read, skipped) -> zzz_final.c (the one actually advanced to).
    stubShowDirectoryPicker(
      directoryHandleWithEntries("ws", [
        new FakeFileSystemFileHandle("main.c", NAVIGABLE_FIXTURE_C),
        throwingFileHandle("next_broken.c"),
        new FakeFileSystemFileHandle("zzz_final.c", VALID_MAIN_C),
      ]),
    );
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    const mapLogCall = logSpy.mock.calls.find(
      (c) => c[1] !== null && typeof c[1] === "object" && "grid" in (c[1] as object),
    );
    const map = mapLogCall![1] as { grid: number[][]; spawn: { x: number; y: number }; exit: { x: number; y: number } };
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.scene-canvas")!;
    dismissBriefingHelper(raf);
    for (const key of "IDDQD") canvas.dispatchEvent(new KeyboardEvent("keydown", { key }));
    raf.flush(1, 16);

    const path = bfsPath(map.grid, map.spawn, map.exit);
    expect(path.length).toBeGreaterThan(0);
    walkPath(canvas, raf, path, () => testHooks()?.getPlayerState().state !== "playing", 500);
    expect(testHooks()?.getPlayerState().state).toBe("won");

    dismissBriefingHelper(raf);
    await waitUntil(
      () => logSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("cleared — advancing to ws/zzz_final.c")),
      8000,
    );
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes('Failed to load "ws/next_broken.c", skipping to the next file:'),
      ),
    ).toBe(true);
    expect(loadCampaignSave()?.filePath).toBe("ws/zzz_final.c");
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

/** Same shape as `buildReplaySegment`, but for an arbitrary campaign
 * name/file path — used to seed a GitHub- or demo-sourced replay, whose
 * `startReplay` re-fetch path needs `entry.campaignName` to actually parse as
 * a repo ref (GitHub) or resolve via the bundled tree (demo), unlike the
 * plain local-workspace name `REPLAY_CAMPAIGN_NAME` the other replay tests
 * use throughout this file. */
async function buildReplaySegmentFor(campaignName: string, filePath: string, sourceContent: string, frameCount: number): Promise<ReplayLevelSegment> {
  const fileName = filePath.split("/").pop()!;
  const parsed = (await parseFile(fileName, sourceContent))!;
  const astHash = await hashRun(JSON.stringify(parsed), campaignName);
  return {
    filePath,
    bonusLevel: false,
    gameplaySeed: 12345,
    astHash,
    difficulty: "normal",
    gore: "normal",
    frames: Array.from({ length: frameCount }, () => ({ dt: 0.05, input: { ...EMPTY_INPUT_SNAPSHOT } })),
  };
}

/** A minimal, mutable `InputSource` implementation for directly driving a
 * `RaycasterEngine` outside main.ts's DOM — same shape as `engine.test.ts`'s
 * `ScriptedInput`, trimmed to just what `recordNavigatedWinSegment`'s
 * turn-then-move walker needs (movement/turning; everything else is an
 * always-off no-op). */
class MinimalScriptedInput {
  keys = new Set<string>();
  attach = vi.fn();
  detach = vi.fn();
  pollGamepad = vi.fn();
  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  consumeMouseDX(): number {
    return 0;
  }
  consumeFire(): boolean {
    return false;
  }
  isFireHeld(): boolean {
    return false;
  }
  consumeWeaponRequest(): number | null {
    return null;
  }
  consumeMapToggle(): boolean {
    return false;
  }
  consumeInteract(): boolean {
    return false;
  }
  consumeMelee(): boolean {
    return false;
  }
  isMeleeHeld(): boolean {
    return false;
  }
  consumeWheelSteps(): number {
    return 0;
  }
  consumeFpsToggle(): boolean {
    return false;
  }
  consumeCheat(): string | null {
    return null;
  }
  consumeEscape(): boolean {
    return false;
  }
  consumeBlur(): boolean {
    return false;
  }
  consumePointerUnlock(): boolean {
    return false;
  }
  consumeClick(): boolean {
    return false;
  }
  gamepadForward(): number {
    return 0;
  }
  gamepadStrafe(): number {
    return 0;
  }
  gamepadTurn(): number {
    return 0;
  }
  captureSnapshot(): InputSnapshot {
    return {
      keys: [...this.keys],
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
  }
}

/**
 * Records a real navigated win or death as an actual `ReplayLevelSegment`,
 * by constructing a `RaycasterEngine` directly (bypassing main.ts's DOM
 * entirely) with a real `CampaignReplayRecorder` attached — the engine's own
 * `advance()` calls `replayRecorder.record()` automatically every frame, so
 * driving it via `walkPath`'s same turn-then-move BFS logic (against
 * `window.__codeensteinTestHooks`, still available since this is the exact
 * same engine constructor `?testHooks=1` gates) yields a genuine, replayable
 * recording — no hand-authored no-op frames.
 *
 * `godMode`, when true, is recorded into the segment's own `carryover` too
 * (not just used live) — replaying these exact frames must reconstruct an
 * engine with the *same* god-mode state, or the replay would take the same
 * damage over again and could reach a different outcome than the recording.
 */
async function recordNavigatedSegment(options: {
  sourceContent: string;
  target: (map: { spawn: { x: number; y: number }; exit: { x: number; y: number }; hazards: { x: number; y: number }[] }) => { x: number; y: number };
  godMode: boolean;
  extraStandingFrames?: number;
}): Promise<ReplayLevelSegment> {
  enableTestHooks();
  // engine.ts (via textures.ts) imports a real *value* — `export const
  // textures = new TextureManager()` — that calls `canvas.getContext("2d")`
  // at module-*import* time, before any of this function's own code runs.
  // Canvas must be stubbed before these dynamic imports, not after — same
  // pattern engine.test.ts established in Phase 10.
  stubCanvasGetContext(document.createElement("canvas"));
  const { MapGenerator } = await import("./map/mapGenerator");
  const { RaycasterEngine } = await import("./engine/engine");
  const { CampaignReplayRecorder } = await import("./engine/replay");

  const parsed = (await parseFile("main.c", options.sourceContent))!;
  const map = new MapGenerator().generate(parsed, false, true, []);
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  stubCanvasGetContext(canvas);
  const input = new MinimalScriptedInput();
  const recorder = new CampaignReplayRecorder("recorded-campaign");
  const gameplaySeed = 777;
  const carryover: EngineCarryover = {
    health: 100,
    swap: 0,
    bullets: 0,
    rockets: 0,
    smg: 0,
    gas: 0,
    // A real, non-empty ownedWeapons array (rather than omitting the field
    // entirely, as this project's other replay fixtures do) — needed so a
    // replay of this recording exercises buildEngineFor's own
    // `segment.carryover?.ownedWeapons?.includes(...)` truthy-array path,
    // not just the "carryover/ownedWeapons is undefined" side.
    ownedWeapons: [GHIDRA_WEAPON_INDEX],
    godMode: options.godMode,
  };
  recorder.startLevel(
    { filePath: "recorded.c", bonusLevel: false, gameplaySeed, difficulty: "normal", gore: "normal", carryover },
    Promise.resolve("placeholder-hash"),
  );

  const engine = new RaycasterEngine(
    canvas,
    map,
    {},
    carryover,
    "normal",
    "normal",
    gameplaySeed,
    input,
    recorder,
  );

  const targetTile = options.target(map);
  const path = bfsPath(map.grid, map.spawn, targetTile);
  expect(path.length).toBeGreaterThan(0);
  const dt = 0.05;
  let targetIndex = 0;
  for (let frame = 0; frame < 800 && targetIndex < path.length; frame++) {
    const state = testHooks()!.getPlayerState();
    if (state.state !== "playing") break;
    const target = path[targetIndex];
    const tx = target.x + 0.5;
    const ty = target.y + 0.5;
    const dx = tx - state.x;
    const dy = ty - state.y;
    if (Math.hypot(dx, dy) < 0.25) {
      targetIndex++;
      continue;
    }
    const desiredAngle = Math.atan2(dy, dx);
    const currentAngle = Math.atan2(state.dirY, state.dirX);
    let diff = desiredAngle - currentAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    input.keys.clear();
    input.keys.add(Math.abs(diff) > 0.15 ? (diff > 0 ? "KeyE" : "KeyQ") : "KeyW");
    engine.advance(dt);
  }

  // Standing still on the target tile a while longer (e.g. to let hazard
  // damage actually finish the player off) — no keys held.
  input.keys.clear();
  for (let i = 0; i < (options.extraStandingFrames ?? 0) && testHooks()!.getPlayerState().state === "playing"; i++) {
    engine.advance(dt);
  }

  const payload = await recorder.finish();
  const segment = payload?.levels[0];
  expect(segment).toBeDefined();
  return segment!;
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
  // Scoped to the dialog specifically — an already-active replay's own
  // transport controls (seek/play-pause/speed) share the same "replay-btn"
  // class (see gameHud.ts's buildReplayControls), so a bare ".replay-btn"
  // query can match one of *those* instead of the highscore table's own
  // "Watch Replay" button whenever a replay is already playing.
  await waitUntil(() => document.querySelector("#highscore-dialog .replay-btn") !== null, 8000);
  document.querySelector<HTMLButtonElement>("#highscore-dialog .replay-btn")!.click();
}

/** Same as `seedAndOpenReplay`, but for an arbitrary campaign name/source —
 * see `buildReplaySegmentFor`'s doc comment for why the GitHub/demo replay
 * tests need this instead. */
async function seedAndOpenReplayFor(campaignName: string, source: "github" | "demo", segments: ReplayLevelSegment[]): Promise<void> {
  await recordHighscore({
    score: 100,
    campaignName,
    levelName: "main.c",
    levelsCleared: 1,
    hash: "irrelevant-workspace-hash",
    achievedAt: Date.now(),
    source,
    replay: { version: 2, campaignName, levels: segments },
  });
  document.querySelector<HTMLButtonElement>("#view-highscores")!.click();
  // Scoped to the dialog specifically — an already-active replay's own
  // transport controls (seek/play-pause/speed) share the same "replay-btn"
  // class (see gameHud.ts's buildReplayControls), so a bare ".replay-btn"
  // query can match one of *those* instead of the highscore table's own
  // "Watch Replay" button whenever a replay is already playing.
  await waitUntil(() => document.querySelector("#highscore-dialog .replay-btn") !== null, 8000);
  document.querySelector<HTMLButtonElement>("#highscore-dialog .replay-btn")!.click();
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
    // step()'s own "not ready to advance yet" branch reschedules itself via
    // requestAnimationFrame rather than consuming any frames while paused —
    // a tick landing here must not throw or advance frameIndex.
    expect(() => raf.flush(1, 16)).not.toThrow();
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

  it("starting a real level while a replay is actively playing tears the replay down first", async () => {
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000); // the replay's own engine is now genuinely driving

    // Picking a fresh workspace while the replay is still playing (never
    // stopped via Escape) reaches launchLevel's own stopActiveReplay?.()
    // with a real, still-active teardown to call — not the usual null case
    // every other launchLevel-reaching test hits.
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "ws", 8000);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
  });

  it("starting a replay while a real level is running stops that level's engine first", async () => {
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    // A real, live level — startReplay's own activeEngine?.stop() has an
    // actual running engine to tear down here, not the usual null case.
    document.querySelector<HTMLButtonElement>("#launch-demo-campaign")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".replay-controls") !== null, 8000);
  });

  it("starting a replay while another replay is already playing stops the first one first", async () => {
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000);

    // Opening a second "Watch Replay" without ever stopping the first one —
    // startReplay's own stopActiveReplay?.() has a real, still-active
    // teardown to call this time.
    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".replay-controls") !== null, 8000);
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

  it("fails gracefully when the recorded file is found but no longer parses", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    // Matches segment.filePath ("replay-ws/main.c"), so it gets past the
    // not-found check — but a NUL byte makes isSafeToParse's binary sniff
    // reject it outright, distinct from the astHash-mismatch case (that one
    // parses fine but hashes differently).
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": "int main() {\0garbage}" }));

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

  it("seeking before the first level has finished loading is a no-op instead of throwing", async () => {
    // The controls exist as soon as the canvas area is shown, but
    // buildEngineFor (which sets transitioning back to false and populates
    // currentSegment) hasn't necessarily run yet — see the previous test's
    // own comment on this exact race. Clicking immediately, with none of
    // that test's extra flushAsync yields, exercises seekBy's own guard.
    await importMain();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn");
    expect(() => buttons[2].click()).not.toThrow();
  });

  it("replaying a recording of a real win reaches buildEngineFor's own onWin", async () => {
    // Record a genuine win first (outside main.ts's DOM entirely — see
    // recordNavigatedSegment's doc comment), then feed that real recording
    // through the same seedAndOpenReplay flow every other test in this
    // block uses, this time actually letting it run to completion instead
    // of just checking the transport bar/mechanics.
    const recordedSegment = await recordNavigatedSegment({
      sourceContent: NAVIGABLE_FIXTURE_C,
      target: (map) => map.exit,
      godMode: true, // prove navigation reaches the exit, not survive incidental combat
    });
    // recordNavigatedSegment's own recording engine already left
    // window.__codeensteinTestHooks pointing at itself (already "won") —
    // clear it so the waitUntil(!!testHooks()) below can only be satisfied
    // once the *replay's* own buildEngineFor constructs its own engine,
    // not by reading this stale reference.
    delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;

    await importMain();
    enableTestHooks();
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": NAVIGABLE_FIXTURE_C }));
    // recordNavigatedSegment records against its own standalone engine's
    // filePath ("recorded.c") and campaign name — rewrite both so this
    // replay's own re-verification (workspace pick + astHash check) matches
    // the *replayed* workspace instead.
    const parsed = (await parseFile("main.c", NAVIGABLE_FIXTURE_C))!;
    const astHash = await hashRun(JSON.stringify(parsed), REPLAY_CAMPAIGN_NAME);
    const segment: ReplayLevelSegment = { ...recordedSegment, filePath: `${REPLAY_CAMPAIGN_NAME}/main.c`, astHash };

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    await waitUntil(() => !!testHooks(), 8000);

    // Speed up so a single step() tick burns through several recorded
    // frames at once (see REPLAY_SPEEDS) — increases the odds the win lands
    // mid-burst rather than exactly on the loop's last iteration, exercising
    // the `if (levelEnded) break` guard that stops consuming further frames
    // once onWin has already fired this tick.
    const buttons = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn");
    buttons[buttons.length - 1].click(); // speedUp: 1x -> 2x
    buttons[buttons.length - 1].click(); // speedUp: 2x -> 4x

    // Burst through the recorded frames (real event-loop yields between
    // rounds, same reasoning as the frames-exhausted/hash-mismatch tests
    // above) until the replayed run reaches its own natural win.
    let flushed = 0;
    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return testHooks()!.getPlayerState().state === "won" || flushed > 400;
    }, 15000);
    expect(testHooks()!.getPlayerState().state).toBe("won");
  });

  it("winning a non-final level during replay advances to the next recorded level instead of ending the viewing", { timeout: 20000 }, async () => {
    // The single-level win test above always has levelIndex >= payload
    // .levels.length once loadLevel's own pre-increment runs, taking
    // onWin's `hud.showBuildSuccessful` branch — this needs a *second*
    // recorded level so the first win takes the other branch (advanceLevel)
    // instead. Both segments reuse the same navigable fixture — map
    // generation is deterministic per source content, so recording against
    // it twice (once per file name) is simpler than sourcing a second,
    // distinct winnable fixture.
    const firstLevelSegment = await recordNavigatedSegment({
      sourceContent: NAVIGABLE_FIXTURE_C,
      target: (map) => map.exit,
      godMode: true,
    });
    delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;
    const secondLevelSegment = await recordNavigatedSegment({
      sourceContent: NAVIGABLE_FIXTURE_C,
      target: (map) => map.exit,
      godMode: true,
    });
    delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;

    await importMain();
    enableTestHooks();
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": NAVIGABLE_FIXTURE_C, "zzz_next.c": NAVIGABLE_FIXTURE_C }));
    const parsed = (await parseFile("main.c", NAVIGABLE_FIXTURE_C))!;
    const astHash = await hashRun(JSON.stringify(parsed), REPLAY_CAMPAIGN_NAME);
    const segments: ReplayLevelSegment[] = [
      { ...firstLevelSegment, filePath: `${REPLAY_CAMPAIGN_NAME}/main.c`, astHash },
      { ...secondLevelSegment, filePath: `${REPLAY_CAMPAIGN_NAME}/zzz_next.c`, astHash },
    ];

    await seedAndOpenReplay(segments);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    await waitUntil(() => !!testHooks(), 8000);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".replay-controls .replay-btn");
    buttons[buttons.length - 1].click(); // speedUp: 1x -> 2x
    buttons[buttons.length - 1].click(); // speedUp: 2x -> 4x

    // Burst through the first level to its own win first — a single "won"
    // reading isn't enough on its own to prove advanceLevel specifically
    // ran (campaign-complete's hud.showBuildSuccessful wouldn't reset state
    // back to "playing" either), so this also waits for state to bounce
    // back to "playing" afterward — only a genuinely *new* engine
    // (buildEngineFor, called from advanceLevel) does that — before finally
    // waiting for the second level's own natural win.
    let flushed = 0;
    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return testHooks()!.getPlayerState().state === "won" || flushed > 800;
    }, 15000);
    expect(testHooks()!.getPlayerState().state).toBe("won");

    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return testHooks()!.getPlayerState().state === "playing" || flushed > 800;
    }, 15000);
    expect(testHooks()!.getPlayerState().state).toBe("playing"); // advanceLevel rebuilt a fresh engine for the second level

    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return testHooks()!.getPlayerState().state === "won" || flushed > 800;
    }, 15000);
    expect(testHooks()!.getPlayerState().state).toBe("won"); // the second level's own natural win
  });

  it("replaying a recording of a real death reaches buildEngineFor's own onGameOver", async () => {
    // Same technique as the win test above, but navigate to a hazard tile
    // without god mode and linger there until it kills — exercises
    // buildEngineFor's onGameOver instead of its onWin.
    const recordedSegment = await recordNavigatedSegment({
      sourceContent: HAZARD_FIXTURE_C,
      target: (map) => map.hazards[0],
      godMode: false,
      extraStandingFrames: 300, // HAZARD_DPS(18) * 0.05 * 300 = 270 — comfortably lethal from full health
    });
    // See the win test above's identical comment — clears the stale
    // recording engine's own testHooks reference.
    delete (window as unknown as { __codeensteinTestHooks?: unknown }).__codeensteinTestHooks;

    await importMain();
    enableTestHooks();
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": HAZARD_FIXTURE_C }));
    const parsed = (await parseFile("main.c", HAZARD_FIXTURE_C))!;
    const astHash = await hashRun(JSON.stringify(parsed), REPLAY_CAMPAIGN_NAME);
    const segment: ReplayLevelSegment = { ...recordedSegment, filePath: `${REPLAY_CAMPAIGN_NAME}/main.c`, astHash };

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    await waitUntil(() => !!testHooks(), 8000);

    let flushed = 0;
    await waitUntil(() => {
      flushed += raf.flush(1, 16);
      return testHooks()!.getPlayerState().state === "over" || flushed > 700;
    }, 15000);
    expect(testHooks()!.getPlayerState().state).toBe("over");
  });

  it("re-fetches a GitHub-sourced workspace when replaying a run recorded from a repo", async () => {
    await importMain();
    const segment = await buildReplaySegmentFor("owner/repo", "owner/repo/main.c", REPLAY_FIXTURE_C, 5);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ default_branch: "main" }),
        body: null,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ tree: [{ path: "main.c", type: "blob" }] }),
        body: null,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => REPLAY_FIXTURE_C,
      } as unknown as Response);

    await seedAndOpenReplayFor("owner/repo", "github", [segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
  });

  it("does nothing when a GitHub-sourced entry's own campaign name no longer parses as a repo ref", async () => {
    await importMain();
    const segment = await buildReplaySegmentFor("not a valid ref!!", "not a valid ref!!/main.c", REPLAY_FIXTURE_C, 5);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await seedAndOpenReplayFor("not a valid ref!!", "github", [segment]);
    await flushAsync();
    // Nothing to fetch, nothing to show — the canvas area never opens.
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled while re-picking a local workspace for a replay", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    stubShowDirectoryPicker(undefined);

    await seedAndOpenReplay([segment]);
    await flushAsync();
    expect(document.querySelector(".canvas-area")!.hasAttribute("hidden")).toBe(true);
  });

  it("a replay superseded while re-reading its own workspace doesn't clobber the newer load", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle(REPLAY_CAMPAIGN_NAME, gate, { entries: [new FakeFileSystemFileHandle("main.c", REPLAY_FIXTURE_C)] }));

    await seedAndOpenReplay([segment]);
    await flushAsync(); // let the replay's own readDirectoryTree start hanging on the gate

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.(); // the stale replay's tree read finally resolves, but too late
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("a replay superseded while scanning its own workspace for parsable files doesn't clobber the newer load", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    const gate: { resolve?: () => void } = {};
    // Extensionless — isParsableNode has to actually read it to sniff for a
    // shebang, which is the one place flattenParsableFiles does real I/O
    // (an ordinary ".c" file's parsability is decided from its name alone,
    // no read needed) — the hook this test needs to make the scan hang.
    stubShowDirectoryPicker(
      directoryHandleWithEntries(REPLAY_CAMPAIGN_NAME, [
        new FakeFileSystemFileHandle("main.c", REPLAY_FIXTURE_C),
        gatedFileHandle("script", "#!/usr/bin/env sh\necho hi", gate),
      ]),
    );

    await seedAndOpenReplay([segment]);
    await flushAsync();
    await flushAsync(); // let readDirectoryTree finish and flattenParsableFiles start hanging on "script"'s gate

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("logs an error instead of throwing when a replay's own workspace read fails after being superseded", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(gatedDirectoryHandle(REPLAY_CAMPAIGN_NAME, gate, { throws: new Error("stale replay read failed") }));
    const errorSpy = vi.spyOn(console, "error");

    await seedAndOpenReplay([segment]);
    await flushAsync();

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);

    gate.resolve?.();
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
    expect(errorSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("[replay] Failed to start replay:"))).toBe(
      false,
    ); // the newer load's own error handling owns the screen now — this one stays silent
  });

  it("a stale loadLevel failure landing after the replay itself was superseded doesn't clobber the newer load", async () => {
    // Distinct from the tree-read/scan supersession tests above — those
    // supersede before `isReplaying` is ever set true. This one lets the
    // replay fully start (isReplaying = true), then supersedes while
    // loadLevel's own readFileText for the first level is still pending —
    // exercising endReplay's own `if (!isReplaying) return` guard, which is
    // this system's supersession check in place of a `gen` counter.
    await importMain();
    const segment = await buildReplaySegment(5);
    const gate: { resolve?: () => void } = {};
    stubShowDirectoryPicker(directoryHandleWithEntries(REPLAY_CAMPAIGN_NAME, [gatedFileHandle("main.c", "int main() {\0garbage}", gate)]));

    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    stubShowDirectoryPicker(fakeDirectoryHandle("second", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent === "second", 8000);
    // workspace-name updates before launchLevel (and its stopActiveReplay()
    // call, which is what actually flips isReplaying false) — auto-launch's
    // own entrypoint detection + parse still needs real event-loop turns to
    // reach it, hence the extra yields before releasing the gate below.
    for (let i = 0; i < 10; i++) await flushAsync();

    gate.resolve?.(); // the stale replay's own readFileText resolves, but too late — parseFile then rejects the NUL-byte content
    await flushAsync();
    expect(document.querySelector<HTMLParagraphElement>("#workspace-name")!.textContent).toBe("second");
  });

  it("rebuilds the bundled demo campaign's tree when replaying a run recorded from it", async () => {
    await importMain();
    // The real bundled demo campaign's own entrypoint content — reused
    // wholesale (rather than a synthetic fixture) so its parsed AST hashes
    // against the tree `loadDemoCampaignTree()` itself actually returns, no
    // network/FS mocking required.
    const { loadDemoCampaignTree, DEMO_CAMPAIGN_NAME } = await import("./fs/demoCampaign");
    const demoTree = loadDemoCampaignTree();
    const entryPath = "demo-campaign/main.c";
    function findByPath(node: TreeNode, path: string): TreeNode | null {
      if (node.path === path) return node;
      for (const child of node.children ?? []) {
        const found = findByPath(child, path);
        if (found) return found;
      }
      return null;
    }
    const entryNode = findByPath(demoTree, entryPath)!;
    const entryText = await (await (entryNode.handle as FileSystemFileHandle).getFile()).text();
    const segment = await buildReplaySegmentFor(DEMO_CAMPAIGN_NAME, entryPath, entryText, 5);

    await seedAndOpenReplayFor(DEMO_CAMPAIGN_NAME, "demo", [segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
  });

  it("logs an error instead of throwing when re-picking a local workspace for a replay fails", async () => {
    await importMain();
    const segment = await buildReplaySegment(5);
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = () =>
      Promise.reject(new Error("picker exploded"));
    const errorSpy = vi.spyOn(console, "error");

    await seedAndOpenReplay([segment]);
    await waitUntil(
      () => errorSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("[replay] Failed to start replay:")),
      8000,
    );
  });
});

/**
 * `window.addEventListener("beforeunload", ...)` is a real, permanent
 * `window`-level listener — unlike everything else `importMain()` resets
 * (a fresh DOM tree, a fresh module instance), `window` itself persists for
 * the whole test *file*, so every previous test's own "beforeunload"
 * listener (closing over *that* test's now-stale `activeEngine`/
 * `lastStats`) is still registered too. A plain `window.dispatchEvent(new
 * Event("beforeunload"))` fires all of them at once, which — since
 * `persistProgress` writes to the shared, real `localStorage` — leaks a
 * previous test's save data into the current one despite `localStorage.clear()`
 * running first. Spying on `addEventListener` *before* `importMain()` and
 * invoking only the listener the current import just registered sidesteps
 * this entirely.
 */
async function importMainAndCaptureBeforeUnload(): Promise<() => void> {
  const addSpy = vi.spyOn(window, "addEventListener");
  await importMain();
  const call = addSpy.mock.calls.find((c) => c[0] === "beforeunload");
  addSpy.mockRestore();
  return call![1] as () => void;
}

describe("main.ts — beforeunload autosave", () => {
  let raf: RafController;

  beforeEach(() => {
    raf = installRaf({ stubClock: true });
  });

  afterEach(async () => {
    // See the replay-playback describe block's own afterEach for why this
    // drain (before raf.restore() pulls the stubbed rAF queue out from
    // under any still-pending loadLevel() continuation) is needed here too.
    for (let i = 0; i < 5; i++) {
      raf.flush(3, 16);
      await flushAsync();
    }
    raf.restore();
  });

  it("persists progress on unload while a level is active", async () => {
    const onBeforeUnload = await importMainAndCaptureBeforeUnload();
    stubShowDirectoryPicker(fakeDirectoryHandle("ws", { "main.c": VALID_MAIN_C }));
    document.querySelector<HTMLButtonElement>("#select-workspace")!.click();
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);
    dismissBriefingHelper(raf);
    raf.flush(1, 16); // onStats fires once per advance() — populates lastStats

    onBeforeUnload();
    const saved = JSON.parse(localStorage.getItem("codeenstein-campaign-save")!);
    expect(saved.filePath).toBe("ws/main.c");
  });

  it("does nothing on unload when no level is active", async () => {
    const onBeforeUnload = await importMainAndCaptureBeforeUnload();
    expect(() => onBeforeUnload()).not.toThrow();
    expect(localStorage.getItem("codeenstein-campaign-save")).toBeNull();
  });

  it("does not persist campaign progress on unload while watching a replay", async () => {
    const onBeforeUnload = await importMainAndCaptureBeforeUnload();
    const segment = await buildReplaySegment(20);
    stubShowDirectoryPicker(fakeDirectoryHandle(REPLAY_CAMPAIGN_NAME, { "main.c": REPLAY_FIXTURE_C }));
    await seedAndOpenReplay([segment]);
    await waitUntil(() => document.querySelector(".canvas-area")!.hasAttribute("hidden") === false, 8000);

    onBeforeUnload();
    // isReplaying guards persistProgress specifically — a replay viewing
    // must never be mistaken for real campaign progress.
    expect(localStorage.getItem("codeenstein-campaign-save")).toBeNull();

    // Let loadLevel's own async chain fully settle before this test ends —
    // see the replay-playback describe block's own afterEach for why.
    enableTestHooks();
    await waitUntil(() => !!testHooks(), 8000);
  });
});
