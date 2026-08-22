// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Renders the top-10 leaderboard into the Highscores `<dialog>` (see main.ts). */
import { difficultyOf, truncateHash, type HighscoreEntry } from "../engine/highscores";

/** Shown for an entry with no name of its own — greyed, so a board mixing
 * named and unnamed runs reads as "nobody set a name here" rather than as a
 * player who is actually called Player. */
const DEFAULT_PLAYER_LABEL = "Player";

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
  /**
   * Whether an entry's stored replay can still reproduce its own score under
   * the rules this build plays by — see `simulationHashMatches`.
   *
   * A run whose replay exists but no longer matches keeps its row (the score
   * was really scored) and loses its buttons, rather than offering a Watch
   * that ends in "recorded under different game balance". Defaults to
   * "everything playable" so a caller that doesn't care — and every existing
   * test — behaves exactly as before.
   */
  isReplayPlayable?: (entry: HighscoreEntry) => boolean;
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
    '<tr><th>#</th><th class="wrap">Player</th><th>Score</th><th class="wrap">Campaign</th><th>Lines</th><th>Complexity</th><th>Levels</th><th>Difficulty</th><th title="Rollbacks spent">RB</th><th class="wrap">Ended On</th><th>Hash</th><th>Replay</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries.forEach((entry, i) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(i + 1);

    // The fallback lives here rather than in stored data (see
    // `HighscoreEntry.playerName`), so an entry recorded before the setting
    // existed and one whose player never named themselves read identically.
    const player = document.createElement("td");
    player.className = "wrap";
    player.textContent = entry.playerName || DEFAULT_PLAYER_LABEL;
    if (!entry.playerName) player.classList.add("muted");

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

    // Spelled out rather than abbreviated: "Diff" would read as a git diff
    // in a game whose whole vocabulary is version control. Recovered from the
    // attached replay for entries written before the column existed — see
    // `difficultyOf` — so the shipped default board shows real values instead
    // of a column of dashes.
    const difficulty = document.createElement("td");
    const level_ = difficultyOf(entry);
    if (level_) {
      difficulty.textContent = level_[0].toUpperCase() + level_.slice(1);
      if (!entry.difficulty) difficulty.title = "Read back from this run's replay";
    } else {
      difficulty.className = "muted";
      difficulty.textContent = "—";
    }

    // Marks a continued run rather than ranking it. Together with the
    // difficulty beside it, a reader can now actually weigh two rows against
    // each other — which is the whole reason that column was added. Same
    // absent-vs-zero split as the two codebase columns above, and it matters
    // more here: "—" means recorded before rollbacks existed, "0" means the
    // run had them and spent none.
    const rollbacks = document.createElement("td");
    if (typeof entry.rollbacksUsed === "number") {
      rollbacks.textContent = String(entry.rollbacksUsed);
      if (entry.rollbacksUsed > 0) rollbacks.title = "Restarted a level from its entry state";
    } else {
      rollbacks.className = "muted";
      rollbacks.textContent = "—";
    }

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
    const playable = hasReplay && (options.isReplayPlayable?.(entry) ?? true);
    if (playable && options.onWatchReplay) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "replay-btn";
      button.textContent = "Watch";
      button.addEventListener("click", () => options.onWatchReplay?.(entry));
      replay.appendChild(button);
    }
    if (playable && options.onExportReplay) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "replay-btn";
      button.textContent = "Export";
      button.addEventListener("click", () => options.onExportReplay?.(entry));
      replay.appendChild(button);
    }
    if (!playable) {
      replay.className = "muted";
      // Two different absences, deliberately worded apart: a run that never
      // recorded one, and a run whose recording the current build's rules
      // have outlived. The second is the more confusing of the two if it just
      // showed a dash.
      replay.textContent = hasReplay ? "rules changed" : "—";
      if (hasReplay) replay.title = "Recorded before a gameplay change — it would no longer match this score.";
    }

    row.append(rank, player, score, campaign, loc, complexity, levels, difficulty, rollbacks, level, hash, replay);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  container.appendChild(table);
}
