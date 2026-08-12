// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntroTour, DEFAULT_TOUR_STEPS, placePopout, type TourStep } from "./introTour";

const STEPS: TourStep[] = [
  { targetId: "one", title: "First", body: "first body" },
  { targetId: "two", title: "Second", body: "second body" },
  { targetId: "three", title: "Third", body: "third body" },
];

function mount(ids: string[]): void {
  document.body.innerHTML = ids.map((id) => `<button id="${id}">${id}</button>`).join("");
}

/** jsdom reports every rect as zeroes, so anything that positions against a
 * real layout has to be told what the layout is. */
function stubRects(rect: Partial<DOMRect> = {}): void {
  const full = { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, x: 10, y: 20, ...rect };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(full as DOMRect);
}

const popout = () => document.querySelector<HTMLElement>(".intro-tour-popout");
const titleOf = () => document.querySelector(".intro-tour-title")?.textContent;
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".intro-tour-btn")).find((b) => b.textContent === label);

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("createIntroTour", () => {
  it("walks forward and back, and reports progress", () => {
    mount(["one", "two", "three"]);
    stubRects();
    createIntroTour(STEPS, () => {}).start();

    expect(titleOf()).toBe("First");
    expect(document.querySelector(".intro-tour-progress")?.textContent).toBe("1 of 3");
    expect(button("Back")?.disabled).toBe(true);

    button("Next")!.click();
    expect(titleOf()).toBe("Second");
    expect(button("Back")?.disabled).toBe(false);

    button("Back")!.click();
    expect(titleOf()).toBe("First");
  });

  it("labels the last step Done and finishes on it", () => {
    mount(["one", "two", "three"]);
    stubRects();
    const onFinish = vi.fn();
    createIntroTour(STEPS, onFinish).start();
    button("Next")!.click();
    button("Next")!.click();
    expect(titleOf()).toBe("Third");
    expect(button("Done")).toBeDefined();

    button("Done")!.click();
    expect(popout()).toBeNull();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("scrolls a target into view before measuring it", () => {
    // Found by driving a real browser, not by a unit test: the sidebar is
    // taller than a 900px viewport, so `#file-tree` and `#view-highscores` sat
    // below the fold and their highlights rendered off-screen while the popout
    // was clamped into view — the tour pointed at nothing. jsdom has no
    // `scrollIntoView` at all (it is `undefined` and calling it throws), which
    // is why the call is guarded and why this test has to supply one.
    mount(["one", "two", "three"]);
    stubRects();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    try {
      createIntroTour(STEPS, () => {}).start();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    } finally {
      // @ts-expect-error — put jsdom back the way it was for the other tests.
      delete Element.prototype.scrollIntoView;
    }
  });

  it("skips a step whose target is missing rather than throwing", () => {
    // `#continue-run` only exists once a save does. A tour that died on a
    // missing element would break the very first run it exists for.
    mount(["one", "three"]);
    stubRects();
    createIntroTour(STEPS, () => {}).start();
    expect(document.querySelector(".intro-tour-progress")?.textContent).toBe("1 of 2");
    button("Next")!.click();
    expect(titleOf()).toBe("Third");
  });

  it("skips a target that exists but is hidden", () => {
    mount(["one", "two", "three"]);
    document.getElementById("two")!.hidden = true;
    stubRects();
    createIntroTour(STEPS, () => {}).start();
    button("Next")!.click();
    expect(titleOf()).toBe("Third");
  });

  it("skips a target hidden with display:none, not just the hidden attribute", () => {
    // How this app actually hides optional controls: `#tab-continue` until a
    // save exists, `#tab-multiplayer` when no signaling server is configured.
    // A `hidden`-only check passes those and anchors the popout to a zero-size
    // rect — which is precisely what the first browser run of this tour did.
    mount(["one", "two", "three"]);
    document.getElementById("two")!.style.display = "none";
    stubRects();
    createIntroTour(STEPS, () => {}).start();
    expect(document.querySelector(".intro-tour-progress")?.textContent).toBe("1 of 2");
    button("Next")!.click();
    expect(titleOf()).toBe("Third");
  });

  it("finishes without rendering when nothing on the tour exists", () => {
    mount([]);
    const onFinish = vi.fn();
    createIntroTour(STEPS, onFinish).start();
    expect(popout()).toBeNull();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("Skip and Escape both end it", () => {
    mount(["one", "two", "three"]);
    stubRects();
    const onFinish = vi.fn();
    const tour = createIntroTour(STEPS, onFinish);
    tour.start();
    button("Skip")!.click();
    expect(popout()).toBeNull();

    tour.start();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popout()).toBeNull();
    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it("moves with the arrow keys, and left on the first step stays put", () => {
    mount(["one", "two", "three"]);
    stubRects();
    createIntroTour(STEPS, () => {}).start();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(titleOf()).toBe("Second");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(titleOf()).toBe("First");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(titleOf()).toBe("First");
    // An unrelated key is left alone for the rest of the app.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(titleOf()).toBe("First");
  });

  it("does not stack a second overlay when started twice", () => {
    mount(["one", "two", "three"]);
    stubRects();
    const tour = createIntroTour(STEPS, () => {});
    tour.start();
    tour.start();
    expect(document.querySelectorAll(".intro-tour")).toHaveLength(1);
  });

  it("restores focus to whatever had it before", () => {
    mount(["one", "two", "three"]);
    stubRects();
    const opener = document.getElementById("one")!;
    opener.focus();
    const tour = createIntroTour(STEPS, () => {});
    tour.start();
    expect(document.activeElement).toBe(popout());
    tour.stop();
    // A keyboard user must not be dumped at the top of the document.
    expect(document.activeElement).toBe(opener);
  });

  it("does not try to restore focus when nothing had it", () => {
    // `document.activeElement` is null in a document that never focused
    // anything — restoring to it would throw rather than being a no-op.
    mount(["one", "two", "three"]);
    stubRects();
    // Stubbed *before* start: `previouslyFocused` is captured there, so
    // nulling it afterwards would leave the captured value an HTMLElement and
    // exercise nothing.
    Object.defineProperty(document, "activeElement", { value: null, configurable: true });
    const tour = createIntroTour(STEPS, () => {});
    tour.start();
    expect(() => tour.stop()).not.toThrow();
    // @ts-expect-error — restore jsdom's own getter for the following tests.
    delete document.activeElement;
  });

  it("stop() is safe when not running", () => {
    const onFinish = vi.fn();
    expect(() => createIntroTour(STEPS, onFinish).stop()).not.toThrow();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("ends when every target disappears mid-tour", () => {
    // A workspace load re-renders the sidebar under the tour. There is nothing
    // left to point at, so ending is the only honest response.
    mount(["one", "two", "three"]);
    stubRects();
    const onFinish = vi.fn();
    createIntroTour(STEPS, onFinish).start();
    document.body.innerHTML = "";
    // The root went with it; re-append so the tour has somewhere to render.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onFinish).toHaveBeenCalled();
  });
});

describe("placePopout", () => {
  const viewport = { width: 1200, height: 800 };

  it("sits to the right of the target when there is room", () => {
    const placed = placePopout({ left: 10, top: 100, right: 300, bottom: 140, height: 40 }, viewport, 150);
    expect(placed.left).toBe(312); // right + 12px gap
    expect(placed.top).toBe(100); // aligned with the target
  });

  it("drops below the target when the right would overflow", () => {
    // The case a manual check is least likely to try: a narrow window.
    const placed = placePopout({ left: 10, top: 100, right: 300, bottom: 140, height: 40 }, { width: 420, height: 800 }, 150);
    expect(placed.left).toBe(10); // aligned with the target's left edge
    expect(placed.top).toBe(152); // bottom + 12px gap
  });

  it("clamps to the viewport rather than running off it", () => {
    const low = placePopout({ left: 10, top: 780, right: 300, bottom: 795, height: 15 }, viewport, 200);
    expect(low.top).toBe(800 - 200 - 8);
    const far = placePopout({ left: 1190, top: 10, right: 1195, bottom: 40, height: 30 }, viewport, 100);
    expect(far.left).toBe(1200 - 280 - 8);
    const negative = placePopout({ left: -50, top: -50, right: -10, bottom: -20, height: 30 }, { width: 300, height: 200 }, 100);
    expect(negative.left).toBeGreaterThanOrEqual(8);
    expect(negative.top).toBeGreaterThanOrEqual(8);
  });
});

describe("DEFAULT_TOUR_STEPS", () => {
  it("points only at ids that are always present, never at a panel behind a tab", () => {
    // The tour must not switch a launch tab to reveal a panel — that is
    // switch-and-revert on persistent UI state. Anchoring to the tabs
    // themselves is what keeps it honest, so pin that here.
    const ids = DEFAULT_TOUR_STEPS.map((s) => s.targetId);
    expect(ids).not.toContain("tab-panel-demo");
    expect(ids).not.toContain("tab-panel-multiplayer");
    expect(ids).toContain("tab-demo");
    expect(ids).toContain("tab-multiplayer");
  });

  it("explains what the player name is actually for", () => {
    // Both halves matter and neither is guessable from a text box labelled
    // "Player name": it floats above your character in co-op, and it labels
    // your highscore entries (doc/user/multiplayer.md, privacy.md).
    const name = DEFAULT_TOUR_STEPS.find((s) => s.targetId === "player-name-input");
    expect(name?.body).toMatch(/co-op|teammates/i);
    expect(name?.body).toMatch(/highscore/i);
  });

  it("teaches the texture pack, including that it is session-only", () => {
    // The one detail a player would otherwise be surprised by: gore and
    // difficulty persist, the WAD does not (doc/user/hud-and-ui.md). There is
    // an open backlog item to make it persist; when that lands, this wording
    // and this assertion both have to change, which is the point of pinning it.
    const wad = DEFAULT_TOUR_STEPS.find((s) => s.targetId === "wad-tabs");
    expect(wad?.body).toMatch(/\.wad/i);
    expect(wad?.body).toMatch(/session/i);
  });

  it("walks the sidebar top to bottom", () => {
    // Each step scrolls its target into view, so an order that jumped between
    // the top and bottom of a sidebar taller than the viewport would yank the
    // page around under the reader.
    const order = DEFAULT_TOUR_STEPS.map((s) => s.targetId);
    expect(order.indexOf("player-name-input")).toBeLessThan(order.indexOf("difficulty-select"));
    expect(order.indexOf("difficulty-select")).toBeLessThan(order.indexOf("wad-tabs"));
    expect(order.indexOf("wad-tabs")).toBeLessThan(order.indexOf("view-highscores"));
    expect(order.indexOf("view-highscores")).toBeLessThan(order.indexOf("file-tree"));
  });

  it("covers the two multiplayer facts a newcomer otherwise learns by failing", () => {
    // Both come from doc/user/multiplayer.md, and both were corrected against
    // main.ts after the first browser run: joining needs no workspace at all
    // (only the Host sub-tab is workspace-gated), and a locally-picked folder
    // cannot be hosted.
    const mp = DEFAULT_TOUR_STEPS.find((s) => s.targetId === "tab-multiplayer");
    expect(mp?.body).toMatch(/joining needs no workspace/i);
    expect(mp?.body).toMatch(/locally-picked folder can't be hosted/i);
  });
});
