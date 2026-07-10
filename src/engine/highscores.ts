// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Persisted top-10 leaderboard. An entry is recorded once per *run*, not per
 * level — either on death, or on finishing the whole campaign (running out
 * of parsable files) — see main.ts's `onGameOver`/`advanceToNextLevel`. Each
 * entry is stamped with a SHA-256 hash of every parsable file's parsed AST
 * across the *whole workspace*, combined, plus the campaign (workspace) name
 * (see `computeCodebaseStats` in main.ts) — two runs over the exact same
 * workspace, under the same campaign name, hash identically regardless of
 * which level either run happened to end on, which is what lets a player
 * compare "did I really beat my own code, or a since-edited version of it"
 * at a glance in the Highscore UI.
 */

import type { ReplayPayload } from "./replay";
import { compressForStorage, decompressFromStorage } from "./storageCompression";

const HIGHSCORE_KEY = "codeenstein-highscores";
/** Only the best `MAX_ENTRIES` runs are kept — a top-10 board, not a full log. */
const MAX_ENTRIES = 10;
/** How many hex characters of the full digest the Highscore UI shows —
 * plenty to eyeball-compare two runs without a wall of hex. */
const DISPLAY_HASH_LENGTH = 12;

export interface HighscoreEntry {
  score: number;
  campaignName: string;
  /** The file the run ended on — died on, or the last one cleared before the
   * campaign ran out of files. */
  levelName: string;
  /** How many levels were actually cleared before the run ended. Never `0` —
   * dying on the very first level (0 cleared) isn't recorded at all, see
   * `recordRunHighscore` in `main.ts`. */
  levelsCleared: number;
  /** Full SHA-256 hex digest of the whole workspace's combined parsed ASTs
   * plus `campaignName` (see `hashRun` and `computeCodebaseStats` in
   * main.ts) — scoped to the whole workspace, not just `levelName`, so runs
   * that end on different levels within the same unedited codebase still
   * compare equal. */
  hash: string;
  /** `Date.now()` when this run was recorded. */
  achievedAt: number;
  /** Deterministic recording of the whole run's input, level by level, if one
   * was captured (see `src/engine/replay.ts`) — lets the Highscore UI offer a
   * "Watch Replay" button for this entry. Undefined for any entry recorded
   * before the replay system existed, one recorded before it became
   * campaign-scoped (`replay.version` was `1`, a single level — deliberately
   * left unsupported rather than migrated), or one whose recording overflowed
   * a cap and was discarded (see `CampaignReplayRecorder.finish`). */
  replay?: ReplayPayload;
  /** Set when this run's workspace was loaded from a GitHub repo (see
   * `src/fs/github.ts`) or the bundled demo campaign (see
   * `src/fs/demoCampaign.ts`) rather than picked off local disk —
   * `startReplay` needs this to know whether to re-fetch `campaignName` as an
   * `owner/repo`, rebuild the bundled demo tree, or fall back to
   * `pickWorkspace()`. Undefined (i.e. local) for every entry recorded before
   * GitHub/demo loading existed, which is the correct default. */
  source?: "github" | "demo";
  /** Total `linesOfCode` summed across every parsable file in the whole
   * workspace/repo tree this run was played against — not just the levels
   * the run actually reached (see `computeCodebaseStats` in main.ts).
   * Undefined for any entry recorded before this field existed, or if the
   * background aggregation hadn't finished within `recordRunHighscore`'s
   * bounded wait when the run ended. */
  codebaseLinesOfCode?: number;
  /** Total `complexityScore` summed across every entity in every parsable
   * file of the whole codebase — a sum, not an average. See
   * `codebaseLinesOfCode` for when this is absent. */
  codebaseComplexity?: number;
}

/**
 * SHA-256 hex digest of parsed-AST JSON (a single file's, or several files'
 * combined) plus the campaign name. Folding the campaign name in means the
 * *same* source under a *different* workspace name still hashes differently
 * — the comparison is "this exact code, in this exact campaign", not source
 * alone.
 */
export async function hashRun(astJson: string, campaignName: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${campaignName} ${astJson}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash, truncated for compact display — see `DISPLAY_HASH_LENGTH`. */
export function truncateHash(hash: string): string {
  return hash.slice(0, DISPLAY_HASH_LENGTH);
}

/** The current top-10 board, best score first; `[]` on any missing/corrupt
 * storage or if it's unavailable (e.g. private browsing) — a broken/absent
 * board should never crash the app, same philosophy as the campaign save. */
export async function loadHighscores(): Promise<HighscoreEntry[]> {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY);
    if (!raw) return [];
    const parsed = await decompressFromStorage<unknown[]>(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHighscoreEntry);
  } catch {
    return [];
  }
}

/** Same as `loadHighscores()`, except an empty real board falls back to the
 * shipped `DEFAULT_HIGHSCORE_ENTRIES` (`./defaultHighscore.ts`) — so a
 * first-time player still sees a populated Highscores dialog with watchable
 * replays instead of the "No runs recorded yet" empty state. Display-only:
 * `recordHighscore` must keep calling the real `loadHighscores()` directly,
 * never this — merging the shipped entries in there would let a real run's
 * read-modify-write cycle persist them into the player's actual localStorage
 * board (could evict a real entry via a shipped score, duplicate it, or make
 * it permanently "sticky"). Imported dynamically, not statically, since the
 * shipped entries embed full replay frame data (several MB) that only ever
 * needs to be fetched once someone actually opens this dialog with an empty
 * board — not on every page load. */
export async function loadHighscoresForDisplay(): Promise<HighscoreEntry[]> {
  const real = await loadHighscores();
  if (real.length > 0) return real;
  const { DEFAULT_HIGHSCORE_ENTRIES } = await import("./defaultHighscore");
  return DEFAULT_HIGHSCORE_ENTRIES;
}

/** Insert `entry` into the board, keep it sorted best-first, truncate to the
 * top `MAX_ENTRIES`, persist, and return the resulting list (so the caller
 * can render it immediately without a second `loadHighscores` round-trip).
 *
 * A replay payload (one recorded frame per rendered tick, across every level
 * a run spans) can run into the megabytes for a long multi-level run — easily
 * enough to blow through a browser's `localStorage` quota, which throws on
 * `setItem` rather than partially writing. Every save attempt below is first
 * gzip-compressed (see `storageCompression.ts`), which on its own shrinks a
 * replay's highly repetitive JSON enough to avoid most quota failures; the
 * drop-replay steps that follow are a last-resort fallback for whatever still
 * doesn't fit even compressed. Losing the *replay* for a run that long is a
 * reasonable tradeoff; silently losing the *entire score* because its replay
 * didn't fit is not, so a quota failure retries with progressively less
 * replay data attached before giving up on saving anything. */
export async function recordHighscore(entry: HighscoreEntry): Promise<HighscoreEntry[]> {
  const board = [...(await loadHighscores()), entry].sort((a, b) => b.score - a.score).slice(0, MAX_ENTRIES);
  if (await trySave(board)) return board;

  console.warn("[highscores] Board didn't fit in localStorage with this run's replay attached — retrying without it.");
  const withoutThisReplay = board.map((e) => (e === entry ? { ...e, replay: undefined } : e));
  if (await trySave(withoutThisReplay)) return withoutThisReplay;

  console.warn("[highscores] Still didn't fit — dropping every entry's replay to at least keep the scoreboard itself.");
  const withoutAnyReplay = board.map((e) => ({ ...e, replay: undefined }));
  if (await trySave(withoutAnyReplay)) return withoutAnyReplay;
  console.warn("[highscores] Failed to save the leaderboard even with every replay dropped.");
  return board;
}

async function trySave(board: HighscoreEntry[]): Promise<boolean> {
  try {
    localStorage.setItem(HIGHSCORE_KEY, await compressForStorage(board));
    return true;
  } catch {
    return false;
  }
}

function isHighscoreEntry(value: unknown): value is HighscoreEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<HighscoreEntry>;
  return (
    typeof v.score === "number" &&
    typeof v.campaignName === "string" &&
    typeof v.levelName === "string" &&
    typeof v.levelsCleared === "number" &&
    typeof v.hash === "string" &&
    typeof v.achievedAt === "number" &&
    (v.codebaseLinesOfCode === undefined || typeof v.codebaseLinesOfCode === "number") &&
    (v.codebaseComplexity === undefined || typeof v.codebaseComplexity === "number")
  );
}
