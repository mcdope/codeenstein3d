# Controls

[← Back to index](README.md)

## Movement

| Input | Action |
|---|---|
| `W` / `S` | Move forward / backward |
| `A` / `D` | Strafe left / right |
| `Q` / `E` | Turn left / right |
| `Shift` | Sprint (2× move speed) |
| Mouse | Look around (click the canvas to lock the pointer first) |

## Combat & Weapons

| Input | Action |
|---|---|
| Mouse click | Fire the active weapon (mouse/gamepad only — keyboard-only play was never a supported control scheme). Every weapon has its own fire rate, so clicking faster than it cycles doesn't shoot faster — the Regex Shotgun's 0.85s pump is the one you'll notice |
| `1`–`5` | Switch directly to a weapon slot — pistol, shotgun, gdb, ghidra, Friday Hotfix. The melee weapon isn't on the number row (it's always `Space`), so there's no hole in the run and no key above `5` does anything |
| Mousewheel | Cycle through owned weapons |
| `Space` | Quick-melee — swings the SIGKILL Knife instantly regardless of what's equipped; once you find the Toolchain chainsaw it permanently takes over this key instead, revving continuously while held |

## Interaction & Navigation

| Input | Action |
|---|---|
| `R` | Reload the equipped weapon |
| `F` | Read a nearby lore terminal, or open a fake wall to reveal a secret room |
| `W` / `S` (while reading) | Scroll a lore terminal's text if it overflows the box |
| `Tab` | Toggle the automap (does not pause — you can keep moving and fighting while it's open) |
| `Alt`+`Enter` | Toggle fullscreen |
| `Escape` | Pause / unpause |
| `Right Ctrl` | Toggle the FPS / frame-time readout |
| `F9` | Boss key — hide the game behind a code editor, press again to bring it back |

Losing window focus (alt-tab, clicking outside the browser) pauses the game automatically.

### Reloading

Every gun except the flamethrower now holds a magazine: **9** rounds for the echo pistol, **2** shells for the Regex Shotgun, **45** for gdb and a single rocket for ghidra. Fire it dry and it reloads itself; press `R` to top it up early, before a fight rather than during one. The HUD shows `loaded / in reserve`, and says **RELOADING** while the trigger is doing nothing.

A reload only moves ammo, it never costs you any — and switching weapons cancels one in progress, so you can always swap to something loaded instead of waiting. The knife and chainsaw are unaffected: quick-melee still works mid-reload, which is the point of having it.

### The boss key

`F9` covers the whole page with a plain editor showing the source file the current level was built from, leaves fullscreen if you were in it, silences the music and changes the tab title and icon. The game pauses while it is up.

Press `F9` again to go back. The game is revealed **still paused** — deliberately, so you are not dropped straight back into a fight — and resumes on your next click, the same as any other pause. `Escape` does nothing while the editor is up; only `F9` dismisses it.

Two things it does not do, both because a web page is not allowed to: it cannot minimise or close the browser window, and in a co-op session it cannot pause anything, so the session keeps running while you are hidden — the same as alt-tabbing out of co-op today.

## Gamepad

Standard Xbox-style layout:

| Input | Action |
|---|---|
| Left stick | Move / strafe |
| Right stick | Turn |
| RT | Fire (held for automatic weapons; semi-auto ones still need a fresh pull per shot, and every weapon is capped at its own fire rate) |
| LB / RB | Previous / next weapon |
| R3 (right stick click) or B | Quick-melee |
| X | Reload the equipped weapon |
| A | Read a nearby lore terminal, or open a fake wall to reveal a secret room |
| L3 (left stick click) | Sprint, held — the same 2× move speed as `Shift` |
| Any button | Dismiss level-start/commit-summary/end overlays (after the 1.2s lock) |

Gamepad and keyboard/mouse input both work at the same time — nothing needs to be switched.

## Cheats

Classic Doom-style cheat codes work — just type the letters while playing, no menu required:

| Code | Effect |
|---|---|
| `IDDQD` | Toggles god mode (you take no damage) |
| `IDCLIP` | Toggles no-clip (walk through walls) |
| `IDKFA` | One-time grant: unlocks every weapon, maxes every ammo pool, fills your swap buffer |

A small toast confirms activation. **Using any cheat disables highscore recording for the rest of that campaign** — a cheated run never gets a leaderboard entry, even if you turn the cheat back off afterward.
