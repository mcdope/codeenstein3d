# Player display names — implementation plan

## Context

Follow-up to the "players don't see each other" investigation. That turned
out to be working-as-designed (a dead player is deliberately excluded from
`collectOtherPlayerBillboards` — the user's guest was almost certainly dying
before ever being seen; confirmed fixed once both players were made
invulnerable for testing). While confirming the fix via a real screen
recording, the user found two real gaps:

1. No name is rendered above a teammate's billboard in the 3D view.
2. Players can't choose their own name at all — there's no per-player
   identity concept anywhere in this codebase today, only a per-*session*
   "Display name (optional)" field (Host tab only) that's actually the
   **public lobby listing name**, unrelated to in-game player identity
   (`SessionCreateRequest.displayName` → `LobbyEntry.displayName`,
   `src/multiplayer/types.ts`). Confirmed via full-codebase research: no
   `PlayerState`/`Player`/`RosterSnapshotEntry` field, no wire-protocol
   field, nothing for `sprites.ts`/`engine.ts`'s render path to read even if
   it wanted to.

Goal: let each player (host and guest) choose an in-game display name,
falling back to the capitalized roster id ("host" → "Host", "guest-1" →
"Guest-1" — the exact convention `main.ts`'s `multiplayerResultRows()`
already uses for the comparison table, lines ~1551-1564) when unset, and
render that name above their billboard in the 3D view.

## The one real design constraint (already discovered — don't relitigate)

`sessionSetupGuest.ts`'s own doc comment documents a genuine, already-fixed
race: a guest must **never** send anything eagerly on connect. The host only
starts listening (`runHostSessionSetup`, inside `onJsonMessage`) once its
user clicks "Start Session" — which can be an arbitrarily long time after
the data channels open — and `RTCDataChannel` does **not** replay a message
to a listener attached after it already fired. An eager guest send is
silently lost forever. The guest side is therefore purely **reply-driven**:
it only ever sends after the host sends first.

This directly kills the naive design ("guest sends its name the moment it
connects"). It also creates a real ordering problem: every guest's
`SessionInitMessage` must carry a **complete** `displayNames` map (host name
+ every guest's name), but `runHostSessionSetup` is fanned out concurrently
per guest (`Promise.all` in `main.ts`) — host can't know guest B's name yet
while building guest A's `session-init` if both handshakes are single-pass
and concurrent.

**Resolution: split the host-side handshake into two phases**, both still
guest-reply-driven (no protocol race reintroduced):

- **Phase A** (per guest, concurrent): host sends `build-version` (as
  today); guest replies with `build-version` **and** a new
  `{type: "player-name", name}` message (guest's own chosen name, or `""`).
  Host's phase-A promise resolves once both arrive, yielding that guest's
  name — it does **not** send `session-init` yet.
- Host `Promise.all`s every phase-A call, merges every guest's name +
  host's own local name into one `displayNames: Record<PlayerId, string>`.
- **Phase B** (per guest, concurrent): host sends `session-init` (now
  carrying the complete `displayNames`) + the chunked map, exactly like
  today's single-pass flow's second half.

This requires splitting `runHostSessionSetup` into two exported functions
and `startMultiplayerSessionAsHost()` (`main.ts` ~1612) into two sequential
`Promise.all` waves instead of one. `sessionSetupGuest.ts`'s state machine
changes minimally: on receiving `build-version`, reply with build-version +
player-name (still reply-only, same race avoided); on receiving
`session-init`, also unpack `displayNames` into `SessionSetupResult`.

## Files to touch

- `src/multiplayer/sessionSetupTypes.ts` — add `PlayerNameMessage`, add
  `displayNames: Record<PlayerId, string>` to `SessionInitMessage` and
  `SessionSetupResult`.
- `src/multiplayer/sessionSetupHost.ts` — split into phase A (name exchange)
  and phase B (session-init + map), per above.
- `src/multiplayer/sessionSetupGuest.ts` — reply with player-name alongside
  build-version; unpack `displayNames` from `session-init`.
- `src/main.ts` — restructure `startMultiplayerSessionAsHost()`'s single
  `Promise.all(... runHostSessionSetup ...)` into two sequential waves; add
  a new "Your name" input to **both** the Host tab and the Join tab
  (`index.html`, `#multiplayer-subtab-panel-host` /
  `-panel-join` — distinct from the existing session-listing
  `#multiplayer-display-name-input`, don't conflate the two); wire the
  guest's chosen name into its phase-A reply.
- `src/engine/engine.ts` — `PlayerState` gets a resolved `displayName:
  string` field (computed once, at `addPlayer` time, via a small shared
  fallback helper — chosen name or capitalized roster id); `addPlayer(id,
  inputSource, carryover, spawn, displayName?)` gets the new param;
  `collectOtherPlayerBillboards`/`OtherPlayerBillboard` (also
  `src/engine/sprites.ts`) carry `name` through.
- `src/engine/sprites.ts` — `collectPlayerBillboards` draws the name as text
  above the billboard box. Check `drawEnemyOverlay` (same file, ~line 252)
  for the existing text-rendering convention (font/align/stroke-for-
  legibility) to match rather than inventing a new style.
- `src/multiplayer/sessionEngine.ts` — `buildSessionEngine()` passes each
  roster id's resolved name from `SessionSetupResult.displayNames` into
  `addPlayer()`.
- A small shared helper for "chosen name or capitalized roster id" —
  currently duplicated logic would appear in `main.ts` (comparison table,
  already exists), `engine.ts` (PlayerState construction, new), and
  wherever host merges phase-A results (new) — worth consolidating into one
  function instead of three copies.
- `doc/dev/multiplayer-netcode-spec.md` — update the "Session setup"
  section for the new message type and two-phase handshake.

## Verification plan

- `npx tsc --noEmit`, full `npm test` (Vitest) — including updated/new
  tests for `sessionSetupHost.test.ts`/`sessionSetupGuest.test.ts` (new
  message ordering), `engine.test.ts`/`sprites.test.ts` (name rendering +
  fallback), `main.test.ts` (existing mocks already reference an unrelated
  `displayName: null` field on session/signaling responses — confirm no
  naming collision/confusion with the new per-player field).
- `scripts/verify-multiplayer-connect.mjs` / `verify-multiplayer-netcode.mjs`
  — handshake protocol changed, these are the real end-to-end race-timing
  checks that originally caught the eager-send bug this design avoids
  repeating.
- Live 2-browser smoke check (reuse `scripts/lib/multiplayerSessionBootstrap.mjs`
  infra) confirming both peers actually see each other's chosen names, and
  that leaving the field blank falls back to "Host"/"Guest-1".
- Manual real-browser check (this is UI + visual) — screenshot both peers'
  views showing the name label.

## Not yet decided / worth a quick check-in before implementing

- Exact visual style for the name label (font size, background pill vs.
  plain stroked text, always-on vs. only-when-close) — should look at
  `drawEnemyOverlay`'s HP-bar/name conventions first and probably just match
  it rather than asking, unless it looks wrong once tried.
