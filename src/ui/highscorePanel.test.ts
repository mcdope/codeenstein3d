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

/** A row's cell for the column headed `header`, resolved through the table's
 * own `<thead>` rather than by a hard-coded index — adding the Player column
 * shifted every index in this file at once, which is exactly the failure this
 * avoids next time. */
function cell(container: HTMLElement, header: string, rowIndex = 0): HTMLTableCellElement {
  const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
  const column = headers.indexOf(header);
  if (column === -1) throw new Error(`No "${header}" column — headers are: ${headers.join(", ")}`);
  const row = container.querySelectorAll("tbody tr")[rowIndex];
  return row.querySelectorAll("td")[column] as HTMLTableCellElement;
}

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
    expect(cell(container, "Score").textContent).toBe((1234567).toLocaleString());
  });

  it("shows the campaign name, levels cleared, and level name", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ campaignName: "acme/widgets", levelsCleared: 5, levelName: "stage05.py" })]);
    expect(cell(container, "Campaign").textContent).toBe("acme/widgets");
    expect(cell(container, "Levels").textContent).toBe("5");
    expect(cell(container, "Ended On").textContent).toBe("stage05.py");
  });

  it("shows the truncated hash with the full hash as a tooltip", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ hash: "abcdef0123456789fullhash" })]);
    const hashCell = cell(container, "Hash");
    expect(hashCell.textContent).toBe("abcdef0123456789fullhash".slice(0, 12));
    expect(hashCell.title).toBe("abcdef0123456789fullhash");
  });

  it("formats codebase lines-of-code and complexity when present", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ codebaseLinesOfCode: 50000, codebaseComplexity: 1234 })]);
    expect(cell(container, "Lines").textContent).toBe((50000).toLocaleString());
    expect(cell(container, "Complexity").textContent).toBe((1234).toLocaleString());
    expect(cell(container, "Lines").className).not.toBe("muted");
  });

  it("shows a muted em-dash for absent lines-of-code and complexity", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry()]);
    expect(cell(container, "Lines").textContent).toBe("—");
    expect(cell(container, "Lines").className).toBe("muted");
    expect(cell(container, "Complexity").textContent).toBe("—");
    expect(cell(container, "Complexity").className).toBe("muted");
  });

  it("shows the player's own name when the entry has one", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ playerName: "Tobi" })]);
    expect(cell(container, "Player").textContent).toBe("Tobi");
    expect(cell(container, "Player").className).not.toContain("muted");
  });

  it("falls back to a muted 'Player' for an entry with no name", () => {
    // Both cases render identically on purpose: an entry recorded before the
    // setting existed, and one whose player never named themselves. The
    // fallback is display-only, so naming yourself later doesn't leave older
    // runs stamped with it.
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry(), entry({ playerName: "" })]);
    expect(cell(container, "Player").textContent).toBe("Player");
    expect(cell(container, "Player").className).toContain("muted");
    expect(cell(container, "Player", 1).textContent).toBe("Player");
  });
});

describe("renderHighscoreTable — Watch Replay button", () => {
  function replayCell(container: HTMLElement): HTMLTableCellElement {
    return cell(container, "Replay");
  }

  it("renders no button when the entry has no replay at all", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry()], { onWatchReplay: vi.fn() });
    expect(replayCell(container).querySelector("button")).toBeNull();
    expect(replayCell(container).textContent).toBe("—");
  });

  it("hides both buttons, with a reason, when the rules have moved on since the recording", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ replay: replay() })], {
      onWatchReplay: vi.fn(),
      onExportReplay: vi.fn(),
      isReplayPlayable: () => false,
    });

    expect(replayCell(container).querySelector("button")).toBeNull();
    // Deliberately not the same "—" a run with no replay at all shows: this
    // one *has* a recording, it just can no longer reproduce its own score.
    expect(replayCell(container).textContent).toBe("rules changed");
    expect(replayCell(container).title).toContain("gameplay change");
  });

  it("keeps both buttons when the recording still matches the current rules", () => {
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ replay: replay() })], {
      onWatchReplay: vi.fn(),
      onExportReplay: vi.fn(),
      isReplayPlayable: () => true,
    });
    expect(replayCell(container).querySelectorAll("button")).toHaveLength(2);
  });

  it("treats a caller that does not care about playability as before", () => {
    // The option is optional, and omitting it must not start hiding buttons.
    const container = document.createElement("div");
    renderHighscoreTable(container, [entry({ replay: replay() })], { onWatchReplay: vi.fn() });
    expect(replayCell(container).querySelector("button")).not.toBeNull();
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
