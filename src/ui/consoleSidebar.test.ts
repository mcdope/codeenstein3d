// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initConsoleSidebar } from "./consoleSidebar";

const HINT_MAX_DELAY_MS = 40000;

let trueConsoleLog: typeof console.log;

function setFullscreenElement(el: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
}

function setup() {
  const canvas = document.createElement("canvas");
  const sidebarEl = document.createElement("div");
  const logEl = document.createElement("div");
  return { canvas, sidebarEl, logEl };
}

function lineTexts(logEl: HTMLElement): string[] {
  return Array.from(logEl.querySelectorAll(".console-line")).map((el) => el.textContent ?? "");
}

beforeEach(() => {
  trueConsoleLog = console.log;
  setFullscreenElement(null);
});

afterEach(() => {
  console.log = trueConsoleLog;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("initConsoleSidebar — console.log mirroring", () => {
  it("still calls through to the real console.log", () => {
    const spy = vi.fn();
    console.log = spy;
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("hello");
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("mirrors a plain string message into the sidebar", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("plain message");
    expect(lineTexts(logEl)).toEqual(["plain message"]);
  });

  it("drops a non-string first argument entirely", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log({ some: "object" });
    expect(lineTexts(logEl)).toEqual([]);
  });

  it("applies the %c color convention and strips the %c marker", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("%chello", "color:#f2d64b");
    const line = logEl.querySelector(".console-line") as HTMLDivElement;
    expect(line.textContent).toBe("hello");
    expect(line.style.color).toBe("rgb(242, 214, 75)"); // jsdom normalizes hex to rgb()
  });

  it("leaves color unset when the %c style arg isn't a string", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("%chello", 42);
    const line = logEl.querySelector(".console-line") as HTMLDivElement;
    expect(line.textContent).toBe("hello");
    expect(line.style.color).toBe("");
  });

  it("leaves color unset when the style string has no color: rule", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("%chello", "font-weight:bold");
    const line = logEl.querySelector(".console-line") as HTMLDivElement;
    expect(line.style.color).toBe("");
  });

  it("truncates a very long message", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    console.log("x".repeat(500));
    const line = logEl.querySelector(".console-line") as HTMLDivElement;
    expect(line.textContent!.length).toBe(301); // 300 chars + the "…" marker
    expect(line.textContent!.endsWith("…")).toBe(true);
  });

  it("caps the sidebar at MAX_LINES, dropping the oldest entries first", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    for (let i = 0; i < 205; i++) console.log(`line ${i}`);
    expect(logEl.children.length).toBe(200);
    expect(logEl.firstElementChild!.textContent).toBe("line 5"); // first 5 dropped
    expect(logEl.lastElementChild!.textContent).toBe("line 204");
  });
});

describe("initConsoleSidebar — fullscreen visibility", () => {
  it("hides the sidebar while the canvas is the fullscreen element", () => {
    const { canvas, sidebarEl, logEl } = setup();
    setFullscreenElement(canvas);
    initConsoleSidebar(canvas, sidebarEl, logEl);
    expect(sidebarEl.classList.contains("hidden")).toBe(true);
  });

  it("shows the sidebar when nothing (or something else) is fullscreen", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    expect(sidebarEl.classList.contains("hidden")).toBe(false);
  });

  it("re-evaluates visibility on fullscreenchange", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    expect(sidebarEl.classList.contains("hidden")).toBe(false);

    setFullscreenElement(canvas);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(sidebarEl.classList.contains("hidden")).toBe(true);

    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(sidebarEl.classList.contains("hidden")).toBe(false);
  });
});

describe("initConsoleSidebar — random hints", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("never fires a hint while inactive", () => {
    const { canvas, sidebarEl, logEl } = setup();
    initConsoleSidebar(canvas, sidebarEl, logEl);
    vi.advanceTimersByTime(HINT_MAX_DELAY_MS * 2);
    expect(lineTexts(logEl).some((t) => t.includes("[hint]"))).toBe(false);
  });

  it("fires a hint once active and not paused", () => {
    const { canvas, sidebarEl, logEl } = setup();
    const handle = initConsoleSidebar(canvas, sidebarEl, logEl);
    handle.setHintsActive(true);
    vi.advanceTimersByTime(HINT_MAX_DELAY_MS);
    expect(lineTexts(logEl).some((t) => t.includes("[hint]"))).toBe(true);
  });

  it("suppresses hints while paused, even when active", () => {
    const { canvas, sidebarEl, logEl } = setup();
    const handle = initConsoleSidebar(canvas, sidebarEl, logEl);
    handle.setHintsActive(true);
    handle.setPaused(true);
    vi.advanceTimersByTime(HINT_MAX_DELAY_MS);
    expect(lineTexts(logEl).some((t) => t.includes("[hint]"))).toBe(false);
  });

  it("avoids repeating the same hint back-to-back", () => {
    // A fixed fallback value (e.g. always 0.5) would deadlock the source's
    // own anti-repeat retry loop the instant its index happens to match
    // lastHintIndex — cycle between two different fallback values so the
    // mock itself can never produce that live-lock, matching how the real
    // Math.random() naturally varies from call to call.
    const queue = [0.1, 0, 0.1, 0, 0.5];
    const fallback = [0.5, 0.6];
    let fallbackIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() =>
      queue.length ? queue.shift()! : fallback[fallbackIndex++ % fallback.length],
    );

    const { canvas, sidebarEl, logEl } = setup();
    const handle = initConsoleSidebar(canvas, sidebarEl, logEl);
    handle.setHintsActive(true);

    // runOnlyPendingTimers fires exactly the currently-queued timer(s),
    // without cascading into whatever the fired timer just rescheduled —
    // the correct way to step through a self-rescheduling setTimeout chain
    // one tick at a time.
    vi.runOnlyPendingTimers();
    vi.runOnlyPendingTimers();

    const hints = lineTexts(logEl).filter((t) => t.includes("[hint]"));
    expect(hints).toHaveLength(2);
    expect(hints[0]).not.toBe(hints[1]);
  });

  it("bails out without throwing or rescheduling if window is gone when a pending hint fires", () => {
    // Simulates a test harness tearing down its jsdom environment out from
    // under a still-pending timer from an earlier test (see the source's own
    // doc comment on this guard) — a real production browser never hits
    // this, since a page's own timers are torn down for free on navigation.
    const { canvas, sidebarEl, logEl } = setup();
    const handle = initConsoleSidebar(canvas, sidebarEl, logEl);
    handle.setHintsActive(true);

    vi.stubGlobal("window", undefined);
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    vi.unstubAllGlobals();

    expect(lineTexts(logEl).some((t) => t.includes("[hint]"))).toBe(false);
    // No reschedule happened either — advancing well past another full
    // interval fires nothing further from this now-dead chain.
    vi.advanceTimersByTime(HINT_MAX_DELAY_MS * 2);
    expect(lineTexts(logEl).some((t) => t.includes("[hint]"))).toBe(false);
  });
});
