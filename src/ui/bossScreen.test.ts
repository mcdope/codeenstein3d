// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createBossScreen, type BossScreen, type BossScreenContent } from "./bossScreen";

const SOURCE = 'function greet() {\n  return "hi"; // note\n}\n';

let canvas: HTMLCanvasElement;
let bgm: { pause: Mock<() => void>; resume: Mock<() => void> };
let content: BossScreenContent;

/** Every instance a test creates, so `afterEach` can close any left open.
 *
 * This matters more than it looks: an open overlay owns a **window-scoped,
 * capture-phase** keydown listener, and clearing `document.body` does not
 * remove it. A test that opened one and never closed it went on swallowing
 * Escape inside every later test in the file — which is exactly how the
 * "stops swallowing once closed" case first failed. */
const created: BossScreen[] = [];

function make(): BossScreen {
  const boss = createBossScreen({ canvas, bgm, getContent: () => content });
  created.push(boss);
  return boss;
}

/** jsdom implements none of the Fullscreen API — every part of it has to be
 * stood up by hand, which is also why the real round-trip is a manual check
 * rather than something this file can claim to have proven. */
function stubFullscreen(element: Element | null): { exit: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } {
  const exit = vi.fn(() => Promise.resolve());
  const request = vi.fn(() => Promise.resolve());
  Object.defineProperty(document, "fullscreenElement", { value: element, configurable: true });
  Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
  Object.defineProperty(canvas, "requestFullscreen", { value: request, configurable: true });
  return { exit, request };
}

const screen = () => document.querySelector<HTMLElement>(".boss-screen");

beforeEach(() => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple.png">';
  document.body.innerHTML = "";
  canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  document.body.append(canvas);
  bgm = { pause: vi.fn(), resume: vi.fn() };
  content = { path: "demo-campaign/main.c", source: SOURCE };
  document.title = "Codeenstein 3D (Build: test)";
});

afterEach(() => {
  for (const boss of created) if (boss.isOpen()) boss.toggle();
  created.length = 0;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("bossScreen — showing", () => {
  it("covers the page with the level's own source, highlighted", () => {
    make().toggle();

    const el = screen()!;
    expect(el).not.toBeNull();
    expect(el.parentElement).toBe(document.body);
    expect(el.querySelector(".boss-screen-tab")?.textContent).toBe("main.c");
    expect(el.querySelector(".boss-screen-crumb")?.textContent).toBe("demo-campaign/main.c");
    expect(el.querySelectorAll(".boss-line")).toHaveLength(4);
    expect(el.querySelector(".boss-tok--comment")?.textContent).toBe("// note");
    expect(el.querySelector(".boss-screen-status")?.textContent).toContain("C");
  });

  it("takes focus, which is what pauses the game", () => {
    // The canvas losing focus is the entire pause mechanism — `InputController`
    // turns that blur into `isPaused = true`. If focus stopped landing here,
    // the game would keep running behind the disguise.
    canvas.focus();
    expect(document.activeElement).toBe(canvas);

    make().toggle();

    expect(document.activeElement).toBe(screen());
  });

  it("swaps the tab title and every icon link", () => {
    make().toggle();

    expect(document.title).toBe("main.c");
    const hrefs = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((l) => l.href);
    expect(hrefs).toHaveLength(1); // apple-touch-icon is a different rel and is left alone
    expect(hrefs[0]).toContain("data:image/svg+xml");
  });

  it("labels an unrecognised extension as plain text", () => {
    content = { path: "notes/TODO", source: "buy milk\n" };
    make().toggle();
    expect(screen()?.querySelector(".boss-screen-status")?.textContent).toContain("Plain Text");
  });

  it("silences the music", () => {
    make().toggle();
    expect(bgm.pause).toHaveBeenCalledTimes(1);
  });

  it("does not stack a second overlay if opened twice", () => {
    const boss = make();
    boss.toggle();
    const el = screen();
    // Reaching `show()` twice is only possible by calling it directly; via
    // `toggle()` the second press closes. Asserted through the public surface
    // anyway, since the guard is what keeps the saved title recoverable.
    boss.toggle();
    boss.toggle();

    expect(document.querySelectorAll(".boss-screen")).toHaveLength(1);
    expect(screen()).not.toBe(el); // a fresh overlay, not the original re-shown
  });

  it("reports whether it is open", () => {
    const boss = make();
    expect(boss.isOpen()).toBe(false);
    boss.toggle();
    expect(boss.isOpen()).toBe(true);
    boss.toggle();
    expect(boss.isOpen()).toBe(false);
  });

  it("reads its content fresh on every press", () => {
    const boss = make();
    boss.toggle();
    boss.toggle();
    content = { path: "src/other.py", source: "x = 1\n" };
    boss.toggle();

    expect(screen()?.querySelector(".boss-screen-crumb")?.textContent).toBe("src/other.py");
    expect(document.title).toBe("other.py");
  });
});

describe("bossScreen — hiding", () => {
  it("removes the overlay and puts the title, icons and music back", () => {
    const originalTitle = document.title;
    const boss = make();

    boss.toggle();
    boss.toggle();

    expect(screen()).toBeNull();
    expect(document.title).toBe(originalTitle);
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!.getAttribute("href")).toBe("/favicon.ico");
    expect(bgm.resume).toHaveBeenCalledTimes(1);
  });

  it("hands focus back to whatever had it", () => {
    canvas.focus();
    const boss = make();

    boss.toggle();
    boss.toggle();

    expect(document.activeElement).toBe(canvas);
  });

  it("falls back to focusing the canvas when nothing had focus", () => {
    vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    const focusSpy = vi.spyOn(canvas, "focus");
    const boss = make();

    boss.toggle();
    boss.toggle();

    expect(focusSpy).toHaveBeenCalled();
  });
});

describe("bossScreen — fullscreen", () => {
  it("leaves fullscreen on the way in and restores it on the way out", () => {
    const { exit, request } = stubFullscreen(canvas);
    const boss = make();

    boss.toggle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();

    boss.toggle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter fullscreen the player never had", () => {
    const { exit, request } = stubFullscreen(null);
    const boss = make();

    boss.toggle();
    boss.toggle();

    expect(exit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("survives a rejected fullscreen request", async () => {
    stubFullscreen(canvas);
    Object.defineProperty(canvas, "requestFullscreen", { value: () => Promise.reject(new Error("denied")), configurable: true });
    Object.defineProperty(document, "exitFullscreen", { value: () => Promise.reject(new Error("denied")), configurable: true });
    const boss = make();

    expect(() => {
      boss.toggle();
      boss.toggle();
    }).not.toThrow();
    await Promise.resolve();
  });
});

describe("bossScreen — key swallowing", () => {
  /** A listener standing in for the ones `InputController` and `GameHud` keep
   * armed on `window` underneath the overlay. */
  function windowKeys(): string[] {
    const seen: string[] = [];
    window.addEventListener("keydown", (e) => seen.push(e.code));
    return seen;
  }

  it("stops Escape, Enter and Space from reaching the game underneath", () => {
    const seen = windowKeys();
    make().toggle();

    for (const code of ["Escape", "Enter", "Space"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
    }

    expect(seen).toEqual([]);
  });

  it("lets scrolling keys through so the code can be read", () => {
    const seen = windowKeys();
    make().toggle();

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "PageDown", bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowDown", bubbles: true, cancelable: true }));

    expect(seen).toEqual(["PageDown", "ArrowDown"]);
  });

  it("stops swallowing once closed", () => {
    const seen = windowKeys();
    const boss = make();

    boss.toggle();
    boss.toggle();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true }));

    expect(seen).toEqual(["Escape"]);
  });
});
