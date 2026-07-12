// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import type { HighscoreEntry } from "../engine/highscores";
import type { ReplayPayload } from "../engine/replay";
import { renderHighscoreTable } from "./highscorePanel";

function entry(overrides: Partial<HighscoreEntry> = {}): HighscoreEntry {
  return {
    score: 1234,
    campaignName: "demo",
    levelName: "main.c",
    levelsCleared: 3,
    hash: "0123456789abcdef",
    achievedAt: 1000,
    ...overrides,
  };
}

function replay(overrides: Partial<ReplayPayload> = {}): ReplayPayload {
  return { version: 2, campaignName: "demo", levels: [{ filePath: "a.c" } as never], ...overrides };
}

describe("renderHighscoreTable — empty state", () => {
  it("shows a placeholder message and no table for an empty board", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, []);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("No runs recorded yet");
  });

  it("clears any stale existing content first", () => {
    const container = document.createElement("div");
    container.textContent = "stale";
    renderHighscoreTable(container, []);
    expect(container.textContent).not.toContain("stale");
  });
});

describe("renderHighscoreTable — populated board", () => {
  it("renders one row per entry, ranked from 1", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry(), entry()]);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("td")!.textContent).toBe("1");
    expect(rows[1].querySelector("td")!.textContent).toBe("2");
  });

  it("formats the score with locale grouping", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ score: 1234567 })]);
    const cells = container.querySelectorAll("tbody td");
    expect(cells[1].textContent).toBe((1234567).toLocaleString());
  });

  it("shows the campaign name, levels cleared, and level name", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ campaignName: "acme/widgets", levelsCleared: 5, levelName: "stage05.py" })]);
    const cells = container.querySelectorAll("tbody td");
    expect(cells[2].textContent).toBe("acme/widgets");
    expect(cells[5].textContent).toBe("5");
    expect(cells[6].textContent).toBe("stage05.py");
  });

  it("shows the truncated hash with the full hash as a tooltip", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ hash: "abcdef0123456789fullhash" })]);
    const hashCell = container.querySelectorAll("tbody td")[7] as HTMLTableCellElement;
    expect(hashCell.textContent).toBe("abcdef0123456789fullhash".slice(0, 12));
    expect(hashCell.title).toBe("abcdef0123456789fullhash");
  });

  it("formats codebase lines-of-code and complexity when present", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ codebaseLinesOfCode: 50000, codebaseComplexity: 1234 })]);
    const cells = container.querySelectorAll("tbody td");
    expect(cells[3].textContent).toBe((50000).toLocaleString());
    expect(cells[4].textContent).toBe((1234).toLocaleString());
    expect(cells[3].className).not.toBe("muted");
  });

  it("shows a muted em-dash for absent lines-of-code and complexity", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry()]);
    const cells = container.querySelectorAll("tbody td");
    expect(cells[3].textContent).toBe("—");
    expect(cells[3].className).toBe("muted");
    expect(cells[4].textContent).toBe("—");
    expect(cells[4].className).toBe("muted");
  });
});

describe("renderHighscoreTable — Watch Replay button", () => {
  function replayCell(container: HTMLElement): HTMLTableCellElement {
    return container.querySelectorAll("tbody td")[8] as HTMLTableCellElement;
  }

  it("renders no button when the entry has no replay at all", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry()], { onWatchReplay: vi.fn() });
    expect(replayCell(container).querySelector("button")).toBeNull();
    expect(replayCell(container).textContent).toBe("—");
  });

  it("renders no button for a legacy (non-v2) replay shape", () => {
    const container = document.createElement("div");
    const legacyReplay = { ...replay(), version: 1 } as unknown as ReplayPayload;
    renderHighscoreTable(container, [entry({ replay: legacyReplay })], { onWatchReplay: vi.fn() });
    expect(replayCell(container).querySelector("button")).toBeNull();
  });

  it("renders no button when the replay's levels array is empty", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ replay: replay({ levels: [] }) })], { onWatchReplay: vi.fn() });
    expect(replayCell(container).querySelector("button")).toBeNull();
  });

  it("renders no button when no onWatchReplay callback was given, even with a valid replay", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ replay: replay() })]);
    expect(replayCell(container).querySelector("button")).toBeNull();
  });

  it("renders a Watch button for a valid v2 replay, and invokes the callback with the entry on click", () => {
    const container = document.createElement("div");
    const onWatchReplay = vi.fn();
    const e = entry({ replay: replay() });
    renderHighscoreTable(container, [e], { onWatchReplay });
    const button = replayCell(container).querySelector("button.replay-btn") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("Watch");
    button.click();
    expect(onWatchReplay).toHaveBeenCalledWith(e);
  });
});
