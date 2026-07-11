// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Builds the keybinding legend shown under the canvas during a level (see
 * main.ts's launchLevel). Renders as a small virtual keyboard — each bound
 * key drawn as a keycap immediately followed by its function, grouped into
 * rows that roughly mirror where those keys actually sit on a real keyboard
 * (a weapon-slot row, the Q/W/E/R row, the A/S/D/F row, then the
 * Shift/Space/Tab/Esc/FPS-toggle row) — rather than one flat wrapped list of
 * chips or a separate small WASD/QE diagram plus a text legend for it. */

interface Chip {
  keys: string[];
  label: string;
  /** Extra left margin before this chip, to visually separate it from the
   * chip(s) before it in the same row (e.g. `R` sitting apart from `Q`/`W`/`E`,
   * mirroring the real gap between those keys on a physical keyboard). */
  gapBefore?: boolean;
}

function keyEl(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "key";
  el.textContent = text;
  return el;
}

function chipEl(chip: Chip): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "controls-chip";
  if (chip.gapBefore) el.classList.add("controls-chip--gap");
  chip.keys.forEach((k, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "controls-sep";
      sep.textContent = "/";
      el.appendChild(sep);
    }
    el.appendChild(keyEl(k));
  });
  const label = document.createElement("span");
  label.className = "controls-chip-label";
  label.textContent = chip.label;
  el.appendChild(label);
  return el;
}

function rowEl(chips: Chip[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "vkeyboard-row";
  for (const chip of chips) row.appendChild(chipEl(chip));
  return row;
}

/** Each inner array is one virtual-keyboard row, in on-screen top-to-bottom
 * order, loosely following a real keyboard's row layout (weapon-slot number
 * row; the Q/W/E/R row; the A/S/D/F row; a bottom row for the
 * modifier/utility keys that don't share a real row at all but read fine
 * grouped together here). */
const ROWS: Chip[][] = [
  [
    { keys: ["1"], label: "pistol" },
    { keys: ["2"], label: "shotgun" },
    { keys: ["3"], label: "gdb (auto, unlockable)" },
    { keys: ["4"], label: "ghidra (rocket, unlockable)" },
    { keys: ["5"], label: "Friday Hotfix (flame, unlockable)" },
  ],
  [
    { keys: ["Q"], label: "turn" },
    { keys: ["W"], label: "move" },
    { keys: ["E"], label: "turn" },
    { keys: ["R"], label: "read / open", gapBefore: true },
  ],
  [
    { keys: ["A"], label: "strafe" },
    { keys: ["S"], label: "move" },
    { keys: ["D"], label: "strafe" },
    { keys: ["F"], label: "fullscreen", gapBefore: true },
  ],
  [
    { keys: ["Shift"], label: "sprint" },
    { keys: ["Space"], label: "melee (infinite)" },
    { keys: ["Tab"], label: "map" },
    { keys: ["Esc"], label: "pause" },
    { keys: ["R-Ctrl"], label: "FPS counter", gapBefore: true },
  ],
];

/** Builds a fresh legend element — cheap enough to rebuild per level rather
 * than caching, and simpler than tracking a shared node across teardowns. */
export function buildControlsLegend(): HTMLElement {
  const legend = document.createElement("div");
  legend.className = "controls-legend";

  const mouse = document.createElement("span");
  mouse.className = "controls-chip controls-chip--freeform";
  mouse.textContent = "🖱 click canvas to capture · move to look · left-click fires · wheel cycles weapons";
  legend.appendChild(mouse);

  const keyboard = document.createElement("div");
  keyboard.className = "vkeyboard";
  for (const row of ROWS) keyboard.appendChild(rowEl(row));
  legend.appendChild(keyboard);

  const gamepad = document.createElement("span");
  gamepad.className = "controls-chip controls-chip--freeform";
  gamepad.textContent = "🎮 sticks move/turn · RT fire · bumpers cycle · R3/B melee";
  legend.appendChild(gamepad);

  return legend;
}
