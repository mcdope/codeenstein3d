// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Slot 1 has to be the level the *browser* will open.
 *
 * `findEntrypointByScanning` returns `bestWithMain ?? bestOverall ??
 * firstParsed` — the cheapest file **containing a `main`/`Main`**, falling
 * back to cheapest-overall only when none has one. Staging modelled the
 * fallback alone, so any repo where some staged file declares a `main` while a
 * cheaper one does not desynced on every run: the bot routes one map with
 * another's plan.
 *
 * Measured 2026-08-07 — ripgrep and curl banked **zero** runs, every
 * invocation exiting on the plan/engine gate at level 1 until the invocation
 * cap. Rust's `fn main` and C's `int main` make this the norm, not an edge
 * case, which is why it is pinned here.
 */
import { describe, expect, it } from "vitest";
import { order } from "./stage-campaign.mjs";

const lvl = (filename, elite = 0) => ({ filename, enemies: { byArchetype: { elite: { count: elite } } } });
const cx = (entries) => new Map(entries);

describe("stage-campaign slot ordering", () => {
  it("puts the cheapest file WITH a main at slot 1, not the cheapest overall", () => {
    const levels = [lvl("a.rs"), lvl("b.rs"), lvl("c.rs")];
    const complexity = cx([["a.rs", 2], ["b.rs", 15], ["c.rs", 40]]);
    // b and c declare a main; a is cheaper but the game would never open it.
    const picked = order(levels, complexity, new Set(["b.rs", "c.rs"]));
    expect(picked[0].filename).toBe("b.rs");
  });

  it("falls back to the cheapest overall when nothing declares a main", () => {
    const levels = [lvl("a.rs"), lvl("b.rs")];
    const complexity = cx([["a.rs", 2], ["b.rs", 15]]);
    expect(order(levels, complexity, new Set())[0].filename).toBe("a.rs");
  });

  it("keeps every selected level exactly once when slot 1 moves", () => {
    // The reordering must not drop or duplicate a level — the campaign is the
    // whole measurement.
    const levels = [lvl("a.rs"), lvl("b.rs"), lvl("c.rs"), lvl("d.rs")];
    const complexity = cx([["a.rs", 2], ["b.rs", 15], ["c.rs", 40], ["d.rs", 7]]);
    const picked = order(levels, complexity, new Set(["c.rs"]));
    expect(picked[0].filename).toBe("c.rs");
    expect(picked.map((l) => l.filename).sort()).toEqual(["a.rs", "b.rs", "c.rs", "d.rs"]);
  });
});
