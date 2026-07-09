// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Builds the keybinding legend shown under the canvas during a level (see
 * main.ts's launchLevel). Used to be one long run-on sentence mixing keys
 * and prose; this instead renders each binding as a keycap chip plus a
 * small WASD/QE cluster graphic, so the key itself is visually distinct
 * from what it does instead of just more undifferentiated text. */

interface Chip {
  keys: string[];
  label: string;
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

/** Small schematic of the WASD+QE cluster's physical keyboard layout — the
 * literal "graphic" half of the legend, not just more keycap chips. */
function clusterEl(): HTMLDivElement {
  const cluster = document.createElement("div");
  cluster.className = "key-cluster";

  const top = document.createElement("div");
  top.className = "key-cluster-row";
  top.append(keyEl("Q"), keyEl("W"), keyEl("E"));

  const bottom = document.createElement("div");
  bottom.className = "key-cluster-row key-cluster-row--offset";
  bottom.append(keyEl("A"), keyEl("S"), keyEl("D"));

  cluster.append(top, bottom);
  return cluster;
}

function clusterLegendEl(): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "cluster-legend";
  for (const line of ["W/S move", "A/D strafe", "Q/E or mouse turn"]) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  return list;
}

const CHIPS: Chip[] = [
  { keys: ["Space", "🖱L"], label: "fire" },
  { keys: ["1"], label: "pistol" },
  { keys: ["2"], label: "shotgun" },
  { keys: ["L-Ctrl"], label: "melee (infinite)" },
  { keys: ["R"], label: "read / open" },
  { keys: ["Shift"], label: "sprint" },
  { keys: ["Tab"], label: "map" },
  { keys: ["F"], label: "fullscreen" },
  { keys: ["Esc"], label: "pause" },
  { keys: ["R-Ctrl"], label: "FPS counter" },
];

/** Builds a fresh legend element — cheap enough to rebuild per level rather
 * than caching, and simpler than tracking a shared node across teardowns. */
export function buildControlsLegend(): HTMLElement {
  const legend = document.createElement("div");
  legend.className = "controls-legend";

  const clusterGroup = document.createElement("div");
  clusterGroup.className = "controls-cluster-group";
  clusterGroup.append(clusterEl(), clusterLegendEl());
  legend.appendChild(clusterGroup);

  const mouse = document.createElement("span");
  mouse.className = "controls-chip";
  mouse.textContent = "🖱 click canvas to capture · move to look · wheel cycles weapons";
  legend.appendChild(mouse);

  for (const chip of CHIPS) legend.appendChild(chipEl(chip));

  const gamepad = document.createElement("span");
  gamepad.className = "controls-chip";
  gamepad.textContent = "🎮 sticks move/turn · RT fire · bumpers cycle · R3/B melee";
  legend.appendChild(gamepad);

  return legend;
}
