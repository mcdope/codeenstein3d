// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Renders the top-10 leaderboard into the Highscores `<dialog>` (see main.ts). */
import { truncateHash, type HighscoreEntry } from "../engine/highscores";

export interface HighscoreTableOptions {
  /** Called with an entry's own `replay` payload when its "Watch Replay"
   * button is clicked — only rendered for entries that actually have one
   * (see `HighscoreEntry.replay`'s doc comment for why some don't). */
  onWatchReplay?: (entry: HighscoreEntry) => void;
  /** Called with an entry's own `replay` payload when its "Export" button
   * is clicked — same gating as `onWatchReplay` (both buttons only render
   * when a real replay payload exists); starts the same viewing but with
   * recording auto-started (see `startReplay`'s `autoRecord` option). */
  onExportReplay?: (entry: HighscoreEntry) => void;
}

export function renderHighscoreTable(
  container: HTMLElement,
  entries: HighscoreEntry[],
  options: HighscoreTableOptions = {},
): void {
  container.textContent = "";

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No runs recorded yet — die or finish a campaign to set the first score.";
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "highscore-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    '<tr><th>#</th><th>Score</th><th class="wrap">Campaign</th><th>Lines</th><th>Complexity</th><th>Levels</th><th class="wrap">Ended On</th><th>Hash</th><th>Replay</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries.forEach((entry, i) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(i + 1);

    const score = document.createElement("td");
    score.textContent = entry.score.toLocaleString();

    const campaign = document.createElement("td");
    campaign.className = "wrap";
    campaign.textContent = entry.campaignName;

    const loc = document.createElement("td");
    if (typeof entry.codebaseLinesOfCode === "number") {
      loc.textContent = entry.codebaseLinesOfCode.toLocaleString();
    } else {
      loc.className = "muted";
      loc.textContent = "—";
    }

    const complexity = document.createElement("td");
    if (typeof entry.codebaseComplexity === "number") {
      complexity.textContent = entry.codebaseComplexity.toLocaleString();
    } else {
      complexity.className = "muted";
      complexity.textContent = "—";
    }

    const levels = document.createElement("td");
    levels.textContent = String(entry.levelsCleared);

    const level = document.createElement("td");
    level.className = "wrap";
    level.textContent = entry.levelName;

    const hash = document.createElement("td");
    hash.className = "hash";
    hash.textContent = truncateHash(entry.hash);
    hash.title = entry.hash;

    const replay = document.createElement("td");
    // `version === 2` is guaranteed by the type, but this value round-tripped
    // through localStorage/JSON — an entry saved before the replay system
    // became campaign-scoped could still be sitting there with the old
    // single-level shape (no `levels` array) despite what the type claims, so
    // this checks the actual runtime shape rather than trusting it blindly.
    const hasReplay = entry.replay?.version === 2 && entry.replay.levels?.length > 0;
    if (hasReplay && options.onWatchReplay) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "replay-btn";
      button.textContent = "Watch";
      button.addEventListener("click", () => options.onWatchReplay?.(entry));
      replay.appendChild(button);
    }
    if (hasReplay && options.onExportReplay) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "replay-btn";
      button.textContent = "Export";
      button.addEventListener("click", () => options.onExportReplay?.(entry));
      replay.appendChild(button);
    }
    if (!hasReplay) {
      replay.className = "muted";
      replay.textContent = "—";
    }

    row.append(rank, score, campaign, loc, complexity, levels, level, hash, replay);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  container.appendChild(table);
}
