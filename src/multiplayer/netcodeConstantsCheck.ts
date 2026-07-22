// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The netcode-constants handshake check — same spirit as
 * `buildVersionCheck.ts`'s own build-version check, right alongside it in
 * the same initial `"build-version"` message (see `sessionSetupTypes.ts`'s
 * `BuildVersionMessage`): `TICK_RATE_HZ`/`FIXED_DT`/`INPUT_DELAY_TICKS` are
 * compiled-in constants (`netcodeConstants.ts`), not something either peer
 * ever measures — two peers whose builds disagree on them would otherwise
 * silently desync (each peer ticks/delays input against its own value,
 * never the other's) instead of hard-failing at setup, the same "different
 * simulation code" concern `buildVersionCheck.ts`'s own doc comment already
 * describes for build ref/time. Centralized as one pure comparison so both
 * peers' setup modules share one implementation, rather than each
 * duplicating the equality check.
 */
export interface NetcodeConstants {
  tickRateHz: number;
  fixedDt: number;
  inputDelayTicks: number;
}

export function checkNetcodeConstantsMatch(local: NetcodeConstants, remote: NetcodeConstants): boolean {
  return local.tickRateHz === remote.tickRateHz && local.fixedDt === remote.fixedDt && local.inputDelayTicks === remote.inputDelayTicks;
}
