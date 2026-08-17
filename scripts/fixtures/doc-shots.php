<?php
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

// ---------------------------------------------------------------------------
// Fixture for `scripts/capture-doc-screenshots.mjs`.
//
// EDITING THIS FILE REGENERATES EVERY PNG IN `doc/user/img/`.
//
// INCLUDING THE BLANK LINES AT THE END. They are load-bearing — do not let an
// editor or a formatter trim them. See the note that precedes them.
//
// Map layout is content-addressed from this file's own AST — the language
// name, its line count, and every entity's kind/name/complexity feed the
// layout seed. Adding, removing or renaming a single method reshuffles the
// entire level: rooms move, the styleset can change, and every screenshot has
// to be recaptured and re-checked. Treat it as frozen unless a shot needs
// something the level does not currently contain.
//
// What this file is built to produce, and why each part is here:
//
//   * Eight private/protected methods  -> lockable rooms. The generator locks
//     at most `MAX_GATE_ROOMS` (4) of them, ranked by size/loot/few-ways-in,
//     so the surplus is headroom: `placeKeys` un-gates any room whose key it
//     cannot place, and four gates must survive that for the map legend to
//     show all four door colours.
//   * A global                         -> an acid pool, for the hazard colour.
//   * A `goto`/label pair              -> a teleporter pad pair. PHP is one of
//     the five languages whose grammar is parsed for `goto` at all.
//   * A long comment block             -> a lore terminal.
//   * A `TODO:` comment                -> a second lore terminal plus a small
//     "technical debt" encounter, which is where a spike trap or a mine comes
//     from. It is a three-way roll, so the capture asserts what it actually
//     got rather than assuming.
//
// Equally deliberate is what it does NOT contain, since each of these would
// put something unwanted in frame:
//
//   * No `try`/`catch`      -> no Exception Handling Zone (acid + traps).
//   * No unreachable code after a `return`, no empty catch, no `@deprecated`,
//     no commented-out code, no hex/Base64 blob literals -> no secret rooms.
//   * Few imports           -> no Vendor Depot alcove crowding the spawn room,
//     which is where every item shot is framed.
// ---------------------------------------------------------------------------

namespace Docs\Capture;

/**
 * A deliberately dull service class. Nothing in here is meant to read as
 * interesting code — its whole job is to make the generator emit one room per
 * method, with enough private ones that four of them end up locked behind
 * coloured doors.
 *
 * This comment is long enough on its own to become a lore terminal, which is
 * the point: the map legend needs a lore-terminal tile to show, and a wall of
 * prose is the cheapest way to ask for one. It goes on for a few more lines
 * than it strictly needs to for exactly that reason, and says so, so nobody
 * later trims it as padding and quietly removes a tile from the screenshots.
 */
class CaptureFixture {

    public function run($mode) {
        if ($mode === 'quick') {
            return $this->stageOne($mode);
        }
        if ($mode === 'full') {
            return $this->stageTwo($mode);
        }
        return $this->stageThree($mode);
    }

    // TODO: fold the three stage helpers together once the shapes settle.
    public function dispatch($mode, $retries) {
        $attempt = 0;
        restart:
        $attempt++;
        if ($attempt < $retries && $mode !== 'quick') {
            goto restart;
        }
        return $attempt;
    }

    private function stageOne($mode) {
        $total = 0;
        for ($i = 0; $i < 8; $i++) {
            if ($i % 2 === 0) {
                $total += $i;
            } else {
                $total -= $i;
            }
        }
        return $total;
    }

    private function stageTwo($mode) {
        $total = 0;
        foreach (['a', 'b', 'c', 'd'] as $key) {
            if ($key === 'a' || $key === 'c') {
                $total += strlen($key);
            }
        }
        if ($mode === 'full') {
            $total *= 2;
        }
        return $total;
    }

    private function stageThree($mode) {
        if ($mode === null) {
            return 0;
        }
        $seen = [];
        foreach (str_split($mode) as $ch) {
            if (!in_array($ch, $seen, true)) {
                $seen[] = $ch;
            }
        }
        return count($seen);
    }

    private function normalize($value) {
        if (is_array($value)) {
            return implode(',', $value);
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        return (string) $value;
    }

    private function validate($value, $min, $max) {
        if ($value < $min) {
            return $min;
        }
        if ($value > $max) {
            return $max;
        }
        return $value;
    }

    protected function describe($mode, $count) {
        if ($count === 0) {
            return $mode . ': empty';
        }
        if ($count === 1) {
            return $mode . ': one';
        }
        return $mode . ': many';
    }

    protected function summarize($rows) {
        $out = [];
        foreach ($rows as $row) {
            if ($row !== null) {
                $out[] = $this->normalize($row);
            }
        }
        return implode('; ', $out);
    }

    protected function reset() {
        return 0;
    }
}

// The acid pool, and it has to live down here. `fillHazards` skips room index
// 0 outright — the spawn room is never flooded — and rooms follow the order
// entities are declared in, so a global at the top of the file becomes the
// spawn room and produces no acid at all. Declared last, it gets a room of its
// own well away from spawn, which is what puts a hazard tile on the map for
// the minimap and automap legends.
$captureSessionState = 0;

// ---------------------------------------------------------------------------
// The blank lines below this comment are not an accident. Deliberately no
// count is written here: this note is itself part of the file's line count, so
// naming the number would change the very thing it documents.
//
// The player always spawns in the *corner* of room 0 (`pickSafeSpawn` ->
// `farthestCorner`), and a corner can end up walled off from the rest of its
// room by the pillars the generator scatters through large rooms. That is what
// this file produced unpadded: a two-tile pocket with no room to line items up
// in front of the camera, and `capture-doc-screenshots.mjs` refusing to start.
//
// Layout is seeded from this file's own AST, and `linesOfCode` feeds that seed
// — so trailing blank lines re-roll the whole level while changing nothing
// about what it contains. The count was measured rather than guessed: every
// padding in a range was generated and scored on whether the spawn corner
// offers a clean plain wall at the preferred backdrop distance while still
// producing all four gates, the acid pool, both teleporter pads and the lore
// terminals.
//
// Remove them and the capture script stops with "no clean camera heading from
// spawn" rather than quietly producing a worse picture.
// ---------------------------------------------------------------------------







