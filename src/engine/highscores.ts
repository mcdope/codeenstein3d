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

import type { DifficultyLevel } from "../difficulty";
import type { ReplayPayload } from "./replay";
import { isBinaryBoard, packBoardForStorage, unpackBoardFromStorage } from "./replayCodec";
import { decompressFromStorage } from "./storageCompression";

const HIGHSCORE_KEY = "codeenstein-highscores";
/** Only the best `MAX_ENTRIES` runs are kept — a top-10 board, not a full log. */
const MAX_ENTRIES = 10;
/** How many hex characters of the full digest the Highscore UI shows —
 * plenty to eyeball-compare two runs without a wall of hex. */
const DISPLAY_HASH_LENGTH = 12;

export interface HighscoreEntry {
  score: number;
  campaignName: string;
  /** Who set this run, as typed in the Player name setting — absent when the
   * player never set one, and absent on every entry recorded before the
   * setting existed. Both render the same way (see `renderHighscoreTable`),
   * so the fallback lives at the display end rather than being baked into
   * stored data: a player who names themselves later shouldn't find their
   * older runs permanently stamped "Player".
   *
   * The shipped default board (`./defaultHighscore.ts`) uses this to say
   * which *bot profile* set each entry — "Casual"/"Gamer"/"Pro" — since those
   * runs have no human behind them. */
  playerName?: string;
  /** The file the run ended on — died on, or the last one cleared before the
   * campaign ran out of files. */
  levelName: string;
  /** The difficulty this run was played on, so two rows can actually be
   * compared. Absent on every entry recorded before this field existed —
   * including the shipped default board — but `difficultyOf()` recovers those
   * from the attached replay rather than giving up, since every level segment
   * records the difficulty it was played at.
   *
   * Read at record time, the same as `playerName` above. That used to carry
   * a real caveat — a run could change difficulty partway and be labelled by
   * wherever it finished — which is exactly why `setDifficultyLocked` now
   * fixes the setting for the lifetime of a run. Record time and run start
   * are therefore the same answer, and the per-segment values in the replay
   * agree with this one. The disagreement case survives only for entries
   * recorded before that lock existed, which `difficultyOf` declines to
   * label rather than guess at. */
  difficulty?: DifficultyLevel;
  /** How many rollbacks this run spent restarting a level it died on, when
   * it spent any. Absent on a clean run *and* on every entry recorded before
   * rollbacks existed, deliberately the same case: a stored `0` would claim
   * to know something about a run that predates the question. The board has
   * never carried a difficulty either, so this marks a run rather than making
   * two rows comparable — see the display note in `renderHighscoreTable`. */
  rollbacksUsed?: number;
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
   * GitHub/demo loading existed, which is the correct default.
   *
   * For a remote workspace this doubles as **which forge to re-fetch from**,
   * which is why the forge ids are values here rather than a second field:
   * one of them has to be stored, and a `source` that says "github" for a
   * GitLab run would be a name that lies. `"github"` predates the other two
   * and every entry carrying it really did come from GitHub, so old saves
   * resume against the right host without a migration. */
  source?: "github" | "gitlab" | "codeberg" | "demo";
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

/**
 * Decode a stored board, whichever of the three forms it's in: the current
 * `bin1:` binary frame packing (`replayCodec.ts`), the older `gz1:`
 * gzip+base64 JSON, or bare JSON from before either existed. Read-side
 * compatibility is the whole point — a player who opens a new build must not
 * lose the board they already had, and nothing rewrites it until their next
 * qualifying run saves in the newer form.
 */
async function readBoard(raw: string): Promise<unknown[]> {
  if (isBinaryBoard(raw)) return unpackBoardFromStorage(raw);
  return decompressFromStorage<unknown[]>(raw);
}

/** The current top-10 board, best score first; `[]` on any missing/corrupt
 * storage or if it's unavailable (e.g. private browsing) — a broken/absent
 * board should never crash the app, same philosophy as the campaign save. */
export async function loadHighscores(): Promise<HighscoreEntry[]> {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY);
    if (!raw) return [];
    const parsed = await readBoard(raw);
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
 * shipped entries embed full replay frame data that only ever needs to be
 * fetched once someone actually opens this dialog with an empty board — not
 * on every page load. The module itself is a single prefixed, compressed
 * string (`bin1:`, decoded by the same `readBoard` a stored board goes
 * through), not a plain array literal — a qualifying bot run's replay
 * compresses ~350x, and just as importantly, parsing one big string literal
 * is trivial compared to parsing tens of thousands of array-literal objects
 * (the latter measurably slowed dev-server/build transforms and blew up
 * test-runner memory once bot runs started surviving deep into the
 * campaign). */
export async function loadHighscoresForDisplay(): Promise<HighscoreEntry[]> {
  const real = await loadHighscores();
  if (real.length > 0) return real;
  const { DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED } = await import("./defaultHighscore");
  // Sorted here rather than in the shipped file, which stays in bot-profile
  // order on purpose: `generate-default-highscore.mjs` writes one entry per
  // profile in `PROFILES` order, and both its `--backfill-*` modes and
  // `verify:replay`'s entry indices rely on that mapping. A real board is
  // already sorted at record time (`recordHighscore`), so this only ever
  // reorders the shipped fallback — which was being rendered in whatever
  // order the profiles happen to sit in, making the rank column disagree
  // with the scores beside it for every first-time visitor.
  const shipped = (await readBoard(DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED)) as HighscoreEntry[];
  return [...shipped].sort((a, b) => b.score - a.score);
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
    localStorage.setItem(HIGHSCORE_KEY, await packBoardForStorage(board));
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
    (v.codebaseComplexity === undefined || typeof v.codebaseComplexity === "number") &&
    (v.rollbacksUsed === undefined || typeof v.rollbacksUsed === "number") &&
    (v.difficulty === undefined || v.difficulty === "easy" || v.difficulty === "normal" || v.difficulty === "hard")
  );
}

/**
 * The difficulty an entry was played on, or `undefined` when it genuinely
 * cannot be known.
 *
 * Falls back to the attached replay because the information is already in
 * there — every `ReplayLevelSegment` records the difficulty its level was
 * played at — so entries written before `difficulty` existed, the shipped
 * default board included, still show a real value instead of a dash. Only
 * regenerating that board would have fixed it otherwise, and regenerating it
 * to backfill a display column is a poor trade.
 *
 * The replay is only trusted when **every** recorded segment agrees. A run
 * whose difficulty was changed partway has no single honest label, and
 * quietly reporting the first level's would turn "I switched to Easy at
 * level 9" into a Hard entry on the board.
 */
export function difficultyOf(entry: HighscoreEntry): DifficultyLevel | undefined {
  if (entry.difficulty) return entry.difficulty;
  const levels = entry.replay?.levels;
  if (!levels || levels.length === 0) return undefined;
  const first = levels[0].difficulty;
  return levels.every((level) => level.difficulty === first) ? first : undefined;
}
