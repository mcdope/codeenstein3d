// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { buildControlsLegend } from "./controlsLegend";

describe("buildControlsLegend", () => {
  it("builds the mouse chip, the virtual keyboard, and the gamepad chip in order", () => {
    const legend = buildControlsLegend();
    expect(legend.className).toBe("controls-legend");
    const parts = Array.from(legend.children);
    expect(parts).toHaveLength(3);
    expect(parts[0].textContent).toContain("click canvas to capture");
    expect(parts[1].className).toBe("vkeyboard");
    expect(parts[2].textContent).toContain("sticks move/turn");
  });

  it("renders one virtual-keyboard row per ROWS entry, each populated with chips", () => {
    const legend = buildControlsLegend();
    const keyboard = legend.querySelector(".vkeyboard")!;
    const rows = keyboard.querySelectorAll(".vkeyboard-row");
    expect(rows).toHaveLength(4); // weapon-slot row, Q/W/E/R row, A/S/D/F row, modifier row
    for (const row of rows) {
      expect(row.querySelectorAll(".controls-chip").length).toBeGreaterThan(0);
    }
  });

  it("renders each chip with its key label and its function label", () => {
    const legend = buildControlsLegend();
    const chips = legend.querySelectorAll(".vkeyboard .controls-chip");
    const pistolChip = Array.from(chips).find((c) => c.textContent?.includes("pistol"))!;
    expect(pistolChip.querySelector(".key")!.textContent).toBe("1");
    expect(pistolChip.querySelector(".controls-chip-label")!.textContent).toBe("pistol");
  });

  it("applies the gap-before modifier only to chips that request it", () => {
    const legend = buildControlsLegend();
    const chips = Array.from(legend.querySelectorAll(".vkeyboard .controls-chip"));
    const readChip = chips.find((c) => c.textContent?.includes("read / open"))!;
    const moveChip = chips.find((c) => c.textContent?.includes("move") && c.querySelector(".key")?.textContent === "W")!;
    expect(readChip.classList.contains("controls-chip--gap")).toBe(true);
    expect(moveChip.classList.contains("controls-chip--gap")).toBe(false);
  });

  it("builds a fresh, independent element on every call", () => {
    const a = buildControlsLegend();
    const b = buildControlsLegend();
    expect(a).not.toBe(b);
    expect(a.outerHTML).toBe(b.outerHTML);
  });
});
