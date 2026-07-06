// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Renders the top-10 leaderboard into the Highscores `<dialog>` (see main.ts). */
import { truncateHash, type HighscoreEntry } from "../engine/highscores";

export function renderHighscoreTable(container: HTMLElement, entries: HighscoreEntry[]): void {
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
    "<tr><th>#</th><th>Score</th><th>Campaign</th><th>Levels</th><th>Ended On</th><th>Hash</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries.forEach((entry, i) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(i + 1);

    const score = document.createElement("td");
    score.textContent = entry.score.toLocaleString();

    const campaign = document.createElement("td");
    campaign.textContent = entry.campaignName;

    const levels = document.createElement("td");
    levels.textContent = String(entry.levelsCleared);

    const level = document.createElement("td");
    level.textContent = entry.levelName;

    const hash = document.createElement("td");
    hash.className = "hash";
    hash.textContent = truncateHash(entry.hash);
    hash.title = entry.hash;

    row.append(rank, score, campaign, levels, level, hash);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  container.appendChild(table);
}
