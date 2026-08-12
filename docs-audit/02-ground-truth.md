# Phase 2 — Ground Truth Baseline

Derived from source, tests, and execution at commit `c0830bf` (master, clean
tree), 2026-08-12. Documentation was **not** consulted for any conclusion here;
where a doc surface is cited it is as a *subject* (an in-code comment being
checked), never as evidence.

Execution environment used: `node v24.18.0` (satisfies
`package.json:11` — `^22.22.2 || ^24.15.0 || >=26.0.0`).

> **Three items in the Phase 2 brief presuppose things that do not exist in
> this codebase.** They are answered as negative results, with the search that
> established them, rather than guessed at. See §3.4 (breadth/depth ratio),
> §5.4 (Champion tier), and §10.1 (density invariance).

---

## 1. CLI surface

There is no single binary and no argument-parsing framework. The CLI surface is
three distinct layers.

### 1.1 npm scripts — the primary documented entry points

`package.json:13-61` defines **48 scripts**. Verbatim, grouped by role:

| Script | Command | Notes |
|---|---|---|
| `predev` / `prebuild` | `node scripts/fetch-online-wads.mjs` | Auto-run hooks |
| `dev` | `vite` | |
| `build` | `tsc && vite build` | Typecheck is part of build |
| `preview` | `vite preview` | |
| `typecheck` | `tsc --noEmit` | **Verified: exits 0** |
| `test` | `vitest run` | **Verified — see §8.2** |
| `test:watch` | `vitest` | |
| `coverage` | `vitest run --coverage` | |
| `verify:wad-parser` | `node scripts/verify-wad-parser.mjs` | CI: `verify.yml:50` |
| `verify:wad-textures` | `node scripts/verify-wad-textures.mjs` | CI: `verify.yml:161` (browser) |
| `verify:zip-reader` | `node scripts/verify-zip-reader.mjs` | CI: `verify.yml:51` |
| `verify:campaign` | `node scripts/verify-demo-campaign.mjs` | CI: `verify.yml:52`. **Script name ≠ script key** |
| `verify:campaign:playthrough` | `node scripts/verify-campaign-playthrough.mjs` | CI: `verify.yml:165` |
| `verify:replay` | `node scripts/verify-replay.mjs` | CI: `verify.yml:300` |
| `verify:event-log` | `node scripts/verify-event-log.mjs` | Not in CI |
| `verify:multiplayer-server` | `node scripts/verify-multiplayer-server.mjs` | CI: `verify.yml:53` |
| `verify:multiplayer-connect` | … | CI: `verify.yml:181` |
| `verify:multiplayer-netcode` | … | CI: `verify.yml:188` |
| `verify:multiplayer-reconciliation` | … | CI: `verify.yml:195` |
| `verify:multiplayer-disconnect` | … | CI: `verify.yml:202` |
| `verify:multiplayer-transition` | … | CI: `verify.yml:357` (own job) |
| `verify:multiplayer-multiguest` | … | CI: `verify.yml:416` (own job) |
| `verify:multiplayer-determinism` | … | CI: `verify.yml:450` (own job) |
| `verify:multiplayer-campaign` | … | **Not in CI** |
| `report:wad-stylesets` | `node scripts/report-wad-styleset-coverage.mjs` | |
| `report:gate-budget` | `node scripts/report-gate-budget.mjs` | |
| `report:damage-model` | `node scripts/report-damage-model.mjs` | |
| `report:aim-error` | `node scripts/report-aim-error.mjs` | |
| `report:level-maps` | `node scripts/render-level-maps.mjs` | **Key says `level-maps`, script is `render-level-maps`** |
| `balancing:budget` | `node scripts/report-level-budget.mjs` | **Key is `budget`, script is `report-level-budget`** |
| `balancing:telemetry` | `node scripts/run-balancing-telemetry.mjs` | |
| `balancing:watch` | `node scripts/watch-bot-sessions.mjs` | |
| `balancing:scan` | telemetry + 5 pinned env vars (`package.json:35`) | Preset, not a distinct script |
| `balancing:campaign` | `node scripts/run-balancing-campaign.mjs` | |
| `balancing:capture` | `node scripts/run-balancing-capture.mjs` | |
| `balancing:corpus` | `node scripts/fetch-balancing-corpus.mjs` | |
| `balancing:events` | `node scripts/report-balancing-events.mjs` | |
| `balancing:telemetry-multiplayer` | … | |
| `balancing:scan-multiplayer` | telemetry-mp + 8 pinned env vars (`package.json:55`) | |
| `balancing:campaign-multiplayer` | … | |
| `perf:bench` | `node scripts/run-perf-benchmark.mjs` | |
| `perf:report` | `node scripts/build-perf-report.mjs` | |
| `poc:cross-browser-determinism` | `node scripts/poc-cross-browser-determinism.mjs` | |
| `fetch:online-wads` | `node scripts/fetch-online-wads.mjs` | |
| `generate:default-highscore` | `node scripts/generate-default-highscore.mjs` | |
| `setup:ssh-lane-host` | `node scripts/setup-ssh-lane-host.mjs` | |

### 1.2 Per-script flags (derived from arg-parsing code, then executed)

| Script | Flags / positionals | Parsing site | Confirmed by running |
|---|---|---|---|
| `multiplayer-server.mjs` | `--install`, `--uninstall`, `--dry-run`, `--stats`, `--json`, `--help`\|`-?`, `--port=<n>`, `--allowed-origin=<url>` | `scripts/multiplayer-server.mjs:1073-1080` | **Yes** — `--help` prints usage + flags + every env var with its *currently-effective* value |
| `report-level-budget.mjs` | `--dir <path>`, `--difficulty <d>`, `--all-difficulties`, `--json <path>`, `--max-levels <n>`, `--kill-rate <n>` | `scripts/report-level-budget.mjs:47-52` | **Yes — and it has no `--help`.** `node scripts/report-level-budget.mjs --help` exits with `unknown argument: --help` |
| `stage-campaign.mjs` | `--repo <dir>`, `--solved <file>`, `--slots <n>`, `--difficulty <d>`, `--exclude <p>` (repeatable), `--dry-run`, `--solved-out <path>`, `--allow-pick-drift`, `--preflight` | `scripts/stage-campaign.mjs:61-75` | **Yes** — bare invocation prints a 2-line usage |
| `run-perf-benchmark.mjs` | `--scenario <csv>`, `--runs <n>`, `--duration <s>`, `--warmup <s>`, `--browser <name>`, `--headless`, `--flag <name>`, `--calibrate`, `--resume <id>` | `scripts/run-perf-benchmark.mjs:763-771` | Not run (starts a browser) |
| `diagnose-level-wedge.mjs` | `--<name> <value>` generic pairs; booleans `--headed`, `--mp-shape`, `--ignore-threats`, `--god-mode`, `--all-attempts`, `--window-histogram` | `scripts/diagnose-level-wedge.mjs:56-105` | Not run |
| `build-perf-report.mjs` | `--findings <path>` + positional dirs | `scripts/build-perf-report.mjs:157` | Not run |
| `fetch-online-wads.mjs` | `--strict` | `scripts/fetch-online-wads.mjs:53` | Not run (network) |
| `fetch-balancing-corpus.mjs` | `--list` | `scripts/fetch-balancing-corpus.mjs:191` | Not run (network) |
| `generate-default-highscore.mjs` | `--backfill-rot-speed`, `--backfill-player-name` | `scripts/generate-default-highscore.mjs:422,426` | Not run (~35 min) |
| `report-balancing-ab.mjs` | positional `<baseline> <candidate>` | `scripts/report-balancing-ab.mjs:110-111` | **Yes** |
| `report-balancing-events.mjs` | positional `<log.ndjson\|dir>` | `scripts/report-balancing-events.mjs:243` | **Yes** |
| `verify-event-log.mjs` | positional `<log.ndjson\|dir>` | `scripts/verify-event-log.mjs:255` | **Yes** |
| `report-profile-separation.mjs` | positional `<dir-or-file> [difficulty]` | `scripts/report-profile-separation.mjs:39` | **Yes** |
| `report-gate-budget.mjs` | positional `[dir] [maxLevels]` | `scripts/report-gate-budget.mjs:77-78` | **Yes** — defaults to `demo-campaign`, prints without arguments |
| `report-wad-styleset-coverage.mjs` | positional WAD paths (+ `CODEENSTEIN_EXTRA_WADS`) | `scripts/report-wad-styleset-coverage.mjs:52-55` | Not run |
| `setup-ssh-lane-host.mjs` | positional hosts, else reads `ssh-hosts.env` | `scripts/setup-ssh-lane-host.mjs:120` | Not run |
| `watch-bot-sessions.mjs` | positional profile names | `scripts/watch-bot-sessions.mjs:37` | Not run |
| `report-damage-model.mjs` / `report-aim-error.mjs` | `process.argv.slice(2)` paths | `:105` / `:149` | **Yes** — both default to the committed capture set and print |

**Mutual exclusions**: only `multiplayer-server.mjs` has any. `--install` and
`--uninstall` are checked in sequence (`:1073-1074`) with no conflict error, so
passing both is not rejected; `--dry-run`, `--port=`, `--allowed-origin=` and
`--json` are documented as *combining* modifiers, not standalone modes
(confirmed in the executed `--help` text). No other script validates flag
combinations.

### 1.3 `--help` / `--version` discrepancies (code vs. execution)

- **Exactly one script implements `--help`**: `multiplayer-server.mjs`. Its help
  text is generated from the live config values at invocation time, so it cannot
  drift from its own defaults.
- **`report-level-budget.mjs` actively rejects `--help`** with
  `unknown argument: --help` (verified by execution). It is the script with the
  most flags after `run-perf-benchmark.mjs`.
- **The remaining 19 scripts that print usage do so only on missing/invalid
  arguments**, as a bare `usage: node scripts/… <args>` line.
- **No `--version` exists anywhere.** No script, no UI element, and no HTTP
  endpoint prints a version. See §9.

---

## 2. Config surface

### 2.1 Precedence

There is **no layered configuration system**. The brief's assumed
`CLI > env > file > built-in` chain does not exist. The actual precedence,
per-consumer:

| Consumer | Precedence, highest first |
|---|---|
| Node scripts | CLI flag (only where one exists) → `process.env.X` → literal default at the read site |
| Browser app | URL query parameter → `localStorage` → built-in default |
| Signaling server | CLI flag (`--port=`, `--allowed-origin=` — install-time only) → `process.env.X` → literal default |
| Docker stack | `docker/.env` → `docker/.env.example` values as template → container defaults |

There is no config *file* layer for the app or the scripts. `ssh-hosts.env` and
`docker/.env` are shell env files sourced into the environment, not parsed
config.

### 2.2 Environment variables — 115 distinct names

All read directly via `process.env.X` with an inline default. Full enumeration
of every read site was performed; the load-bearing ones with their exact
defaults:

**Signaling server** (`scripts/multiplayer-server.mjs`) — 25 vars, all with
defaults, all echoed by `--help`:

| Var | Type | Default | Site |
|---|---|---|---|
| `CODEENSTEIN_MULTIPLAYER_PORT` | int | `8787` | `:44` |
| `CODEENSTEIN_MULTIPLAYER_BIND_HOST` | string | `127.0.0.1` | `:54` |
| `CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN` | string | `https://codeenstein3d.mcdope.org` | `:46` |
| `CODEENSTEIN_MULTIPLAYER_SESSION_TTL_MS` | int | `300000` (5 min) | `:56` |
| `CODEENSTEIN_MULTIPLAYER_SWEEP_INTERVAL_MS` | int | `30000` | `:57` |
| `CODEENSTEIN_MULTIPLAYER_MAX_CONCURRENT_SESSIONS` | int | `500` | `:58` |
| `CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_WINDOW_MS` | int | `60000` | `:60` |
| `CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_MAX_REQUESTS` | int | `20` | `:61` |
| `CODEENSTEIN_MULTIPLAYER_HOST_TOKEN_MAX_REQUESTS` | int | `120` | `:62` |
| `CODEENSTEIN_MULTIPLAYER_LOBBY_RATE_LIMIT_MAX_REQUESTS` | int | `60` | `:64` |
| `CODEENSTEIN_MULTIPLAYER_PUT_SESSION_RATE_LIMIT_MAX_REQUESTS` | int | `30` | `:76` |
| `CODEENSTEIN_MULTIPLAYER_ANSWER_PER_CODE_RATE_LIMIT_MAX_REQUESTS` | int | `10` | `:91` |
| `CODEENSTEIN_MULTIPLAYER_BASE_COOLDOWN_MS` | int | `5000` | `:93` |
| `CODEENSTEIN_MULTIPLAYER_MAX_COOLDOWN_MS` | int | `3600000` | `:141` |
| `CODEENSTEIN_MULTIPLAYER_MAX_TRACKED_IPS_PER_LIMITER` | int | `10000` | `:108` |
| `CODEENSTEIN_MULTIPLAYER_MAX_BODY_BYTES` | int | `8192` | `:143` |
| `CODEENSTEIN_MULTIPLAYER_HEADERS_TIMEOUT_MS` | int | `20000` | `:156` |
| `CODEENSTEIN_MULTIPLAYER_REQUEST_TIMEOUT_MS` | int | `30000` | `:157` |
| `CODEENSTEIN_MULTIPLAYER_TRUSTED_PROXY_IPS` | csv IP/CIDR | `""` (loopback only) | `:128` |
| `CODEENSTEIN_MULTIPLAYER_STATS_TOKEN` | string | **unset — feature off** | `:140` |
| `CODEENSTEIN_MULTIPLAYER_TURN_SECRET` | string | **unset — TURN off** | `:181` |
| `CODEENSTEIN_MULTIPLAYER_TURN_URLS` | csv | `""` | `:182` |
| `CODEENSTEIN_MULTIPLAYER_TURN_TTL_SECONDS` | int | `3600` | `:186` |
| `CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_MAX_REQUESTS` | int | `30` | `:193` |
| `CODEENSTEIN_MULTIPLAYER_TURN_CREDENTIALS_PER_CODE_MAX_REQUESTS` | int | `20` | `:200` |

**Single-player balancing bot** (`scripts/run-balancing-telemetry.mjs`) — 17 vars:

| Var | Type | Default | Site |
|---|---|---|---|
| `CODEENSTEIN_TELEMETRY_DEV_PORT` | int | `5199` | `:58` |
| `CODEENSTEIN_TELEMETRY_OUTPUT_FILE` | path | built-in | `:76` |
| `CODEENSTEIN_TELEMETRY_LEVEL_LIMIT` | int | `Infinity` | `:82` |
| `CODEENSTEIN_TELEMETRY_ATTEMPT_CAP` | int | `Infinity` | `:86` |
| `CODEENSTEIN_TELEMETRY_PROFILE` | string | `null` (all) | `:87` |
| `CODEENSTEIN_TELEMETRY_DIFFICULTY` | string | `null` (all) | `:88` |
| `CODEENSTEIN_TELEMETRY_CONCURRENCY` | int | `12` | `:97` |
| `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` | int | built-in | `:161` |
| `CODEENSTEIN_TELEMETRY_EVENT_LOG` | path | unset (off) | `:176` |
| `CODEENSTEIN_TELEMETRY_SEED` | int 0..0xffffffff | `null` | `:199`; **validated, exits on bad value (`:204`)** |
| `CODEENSTEIN_TELEMETRY_VERBOSE` / `_DEBUG_NAV` / `_ANOMALY_SCAN` / `_NAV_DIAG` / `_TRACE_DUMP` / `_HEADED` | `"1"` flag | off | `:100,105,110,115,119,125` |
| `CODEENSTEIN_TELEMETRY_TUNING` | JSON | unset | `:141` |

**Capture orchestrator** (`scripts/run-balancing-capture.mjs`) — 12 vars:
`_OUT` (`balancing_capture`, `:69`), `_PROFILES` (`Casual,Gamer,Pro`, `:74`),
`_DIFFICULTIES` (`normal,hard`, `:75`), `_ATTEMPTS` (`60`, `:77`), `_CHUNK`
(`20`, `:81`), `_CONCURRENCY` (`10`, `:82`), `_WATCHDOG_MS` (`7 800 000`, `:87`),
`_LEVEL_LIMIT` (unset, `:89`), `_MAX_INVOCATIONS` (`8`, `:94`),
`_TARGET_CHUNK_MIN` (`45`, `:123`), `_MIN_CHUNK` (`5`, `:126`), `_LOCAL_ONLY`
(`"1"` flag, `:379`).

**Campaign orchestrators**: single-player (`run-balancing-campaign.mjs`) —
`_TARGET` `50` (`:53`), `_BATCH_SIZE` `5` (`:57`), `_ATTEMPT_CAP` `80` (`:64`),
`_CONCURRENCY` `8` (`:76`), `_LANES` `2` (`:78`), `_WATCHDOG_MS` `5 400 000`
(`:88`), `_MAX_INVOCATIONS` `6` (`:92`), `_PROFILE`/`_DIFFICULTY` unset
(`:174-175`). Multiplayer equivalents (`CODEENSTEIN_MP_CAMPAIGN_*`) use
different values: `_TARGET` `10`, `_BATCH_SIZE` `2`, `_ATTEMPT_CAP` `30`,
`_CONCURRENCY` `1`, `_LANES` `1`, `_WATCHDOG_MS` `14 400 000`,
`_MAX_INVOCATIONS` `3` (`run-balancing-campaign-multiplayer.mjs:54-79`).

**Cross-cutting**: `CODEENSTEIN_DEV_URL` is read by 10 sites. **Its default is
not uniform** — `http://localhost:5173` in `verify-multiplayer-connect.mjs:64`,
`-disconnect.mjs:33`, `-netcode.mjs:28`, `-reconciliation.mjs:35`,
`-transition.mjs:79`, `verify-wad-textures.mjs:70` and
`lib/multiplayerSessionBootstrap.mjs:223`, but `http://localhost:5183` in
`verify-campaign-playthrough.mjs:95` and `verify-replay.mjs:93`.

**Behaviour when absent**: every variable falls back to its literal default;
none are required. **Behaviour when invalid**: only
`CODEENSTEIN_TELEMETRY_SEED` validates (`run-balancing-telemetry.mjs:199-205`,
exits non-zero). Everywhere else `Number(bad)` yields `NaN` and propagates
silently — e.g. `CODEENSTEIN_MULTIPLAYER_PORT=abc` produces `NaN`, not an error.

### 2.3 Browser config — URL query parameters (5)

| Param | Accepted values | Default | Site | Validation |
|---|---|---|---|---|
| `seed` | decimal or `0x…` hex, finite integer `0 ≤ n ≤ 0xffffffff` | absent → fresh `Math.random()` seed per level | `src/prng.ts:107-114` | **Yes.** Anything else is *ignored*, never coerced to 0 (`:112`) |
| `testHooks` | `"1"` | off | `src/engine/engine.ts:225` | exact-match |
| `botRotSpeedMul` | number, clamped | — | `src/engine/engine.ts:251` | clamped by `clampRotSpeedMultiplier` |
| `eventLog` | `"1"` | off | `src/engine/engine.ts:269` | **requires `testHooks=1` as well** |
| `perfDebug` | `"1"` | off | `src/engine/engine.ts:1258` | exact-match |

### 2.4 Browser config — persisted keys (9)

All under the `codeenstein-` prefix (`src/storageSchema.ts:23`), which
`storageSchema.ts` declares as the ownership contract.

| Key | Written by | Type |
|---|---|---|
| `codeenstein-schema-version` | `storageSchema.ts:27` | int, currently `1` (`:36`) |
| `codeenstein-player-name` | `main.ts:129` | string |
| `codeenstein-gore-level` | `main.ts:135` | enum |
| `codeenstein-difficulty` | `main.ts:138` | `easy`\|`normal`\|`hard` |
| `codeenstein-master-volume` | `main.ts:141` | number |
| `codeenstein-sfx-volume` | `main.ts:142` | number |
| `codeenstein-bgm-volume` | `main.ts:143` | number |
| `codeenstein-campaign-save` | `main.ts:149` | JSON |
| `codeenstein-highscores` | `engine/highscores.ts:21` | packed JSON |

**Missing/invalid handling**: every access is wrapped in `withStorage`
(`storageSchema.ts:65-72`), which treats *any* throw — including a throw on
merely touching the global — as absence. Version handling
(`storageSchema.ts:95-110`): no stamp + no owned key ⇒ `first-run`; no stamp +
owned keys ⇒ `legacy` (v0); a non-numeric stamp is treated as `future`, not `0`,
so migrations are skipped rather than run over possibly-current data
(`:107`). **Downward migration never happens** (`:131`).

`storageSchema.ts:8-9` enumerates "eight keys" and lists eight; including the
version stamp the owned set is nine.

---

## 3. Metrics as implemented

### 3.1 `complexityScore`

Computed identically in all three adapter families:
`1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS) + smellBonus`
— `src/parser/c/cParser.ts:175`, `src/parser/php/phpParser.ts:176`,
`src/parser/generic/genericParser.ts:175`.

- **`countDecisionPoints`** (`src/parser/astUtils.ts:38-49`): count of *named*
  descendants matching `DECISION_NODE_TYPES`, **plus** one per
  `binary_expression` whose `operator` field is in `LOGICAL_OPERATORS`. The
  `isNamed` filter is load-bearing — `descendantsOfType` also matches anonymous
  keyword tokens, which would double-count across the shared cross-language
  table (`:30-36`).
- **`codeSmellBonus`** (`src/parser/astUtils.ts:108-117`):
  `(params − 5) × 2` when `params > 5`, plus `(nesting − 3) × 3` when
  `nesting > 3`; else 0. Thresholds `MAX_PARAMS_BEFORE_SMELL = 5`,
  `MAX_NESTING_BEFORE_SMELL = 3` (`:92-93`); weights
  `PARAM_SMELL_BONUS_PER_EXCESS = 2`, `NESTING_SMELL_BONUS_PER_EXCESS = 3`
  (`:97-98`).
- **Applied only to callables.** C gates on `kind === "function"`
  (`cParser.ts:165`); generic and PHP gate on `isCallable`
  (`genericParser.ts:165`, `phpParser.ts:166`). Non-callable entities get a
  literal `complexityScore: 1` (`cParser.ts:197`, `phpParser.ts:198`).
- **Units**: dimensionless count. **Normalization: none. Clamping: none.**
  Minimum is 1 by construction (the `1 +` term). There is no upper bound at the
  parser layer.
- **Consumer-side clamping**: `spawnEnemies` applies `Math.max(1, …)`
  (`enemies.ts:130`) — defensive, since the parser floor is already 1.
- **`countParameters`** (`astUtils.ts:85-88`) is explicitly a heuristic: it takes
  the **first** descendant matching `PARAMETER_LIST_NODE_TYPES` and counts its
  named children; returns 0 when none is found.

### 3.2 `nestingDepth`

`maxNestingDepth` (`src/parser/astUtils.ts:60-74`): longest root-to-leaf path
counting only nodes in `NESTING_NODE_TYPES`. Flat body ⇒ 0.
`for { if { while {} } }` ⇒ 3. **One special case**: an `if_statement` whose
parent is an `else_clause` contributes 0 (`:65-67`), so an else-if ladder does
not inflate depth. Units: levels. No clamp at the parser layer.

Consumers clamp: `carveLabyrinth` uses `Math.min(nestingDepth, 6)`
(`labyrinth.ts:28`); `MAZE_THRESHOLD = 2` (`labyrinth.ts:9`) gates whether a
labyrinth is carved at all (`mapGenerator.ts:490`).

### 3.3 `allocations` and allocation density

- `countAllocations` (`astUtils.ts:618-642`) returns a raw count, +1 for each of
  three shapes: an allocation node type; a call whose callee matches
  `ALLOCATOR_NAME_PATTERN`; a fixed-size array declarator whose literal size
  ≥ `LARGE_ARRAY_MIN_SIZE = 1024` (`vocabulary.ts:389`).
- `allocationDensity(entity) = (entity.allocations ?? 0) / max(1, endLine − startLine + 1)`
  (`acidOverflow.ts:52-55`). **Units: allocations per source line.**
- Gate is conjunctive (`acidOverflow.ts:62`): `allocations ≥ 3`
  (`ACID_MIN_ALLOCATIONS`, `:34`) **and** density ≥ `0.08`
  (`ACID_MIN_DENSITY`, `:37`).
- Derived timing: `ACID_BASE_INTERVAL_SECONDS (2) × (0.08 / density)`
  (`:123`), floored at `ACID_MIN_INTERVAL_SECONDS = 0.6` (`:47`). Per-level cap
  `MAX_ACID_OVERFLOWS = 3` (`:40`).

### 3.4 The breadth/depth ratio — **does not exist**

`grep -rni 'breadth' src scripts doc README.md` returns **four hits, none of
them a metric**: three describe breadth-first *traversals*
(`acidOverflow.ts:128`, `map/types.ts:320`, `vocabulary.ts:409`) and one is
prose in `decisions.md:47`. There is no ratio metric, no breadth metric, and
nothing computing one. The only depth-like quantity in the codebase is
`nestingDepth` (§3.2), and it is consumed as an absolute value, never as a
numerator or denominator.

### 3.5 Metrics feeding enemy tiering — the complete set

Only **one** metric feeds tiering: `complexityScore`. `nestingDepth` and
`allocations` affect room *geometry* and *room events*, never enemy tier or HP.

| Quantity | Formula | Site |
|---|---|---|
| Tier | `complexity ≥ 40` ⇒ Elite pack, else plain pack | `enemies.ts:131` |
| Plain pack count | `1 + floor(complexity / 10)` | `enemies.ts:143` |
| Plain member HP | `max(25, round(complexity × 25 / count))` | `enemies.ts:146` |
| Elite budget | `min(complexity × 25 × 2, 8 × 350) = min(50·c, 2800)` | `enemies.ts:137-140` |
| Elite member count | `ceil(eliteTotal / 350)` | `enemies.ts:142` |
| Elite member HP | `round(eliteTotal / count)` | `enemies.ts:145` |

Constants: `HP_PER_COMPLEXITY = 25` (`:11`),
`COMPLEXITY_PER_EXTRA_ENEMY = 10` (`:14`),
`ELITE_COMPLEXITY_THRESHOLD = 40` (`:28`), `ELITE_HP_MULTIPLIER = 2` (`:51`),
`ELITE_MEMBER_HP_CAP = 350` (`:68`), `ELITE_MAX_MEMBERS = 8` (`:75`).

**Edge cases:**
- *Empty repo / no parsable file*: `parseFile` returns `null` for every file
  (`registry.ts:123`); no level is produced.
- *File with no entities*: `roomArea` sums to 0, so `mapSize` = `round(2.0 × 0) + 10 = 10`,
  clamped up to `minSize = 48` (`mapGenerator.ts:462-468`, `:134`).
  `placeRooms` produces zero rooms, falls back to `centeredRoom`
  (`:498-502`), then tops up to 2 rooms with filler (`:509-513`).
- *Zero-depth (flat) entity*: `nestingDepth = 0 < MAZE_THRESHOLD`, so no
  labyrinth; room dimensions lose the `+ nestingDepth × 2` term.
- *Single file*: works — it is simply a one-level campaign.
- *Complexity ceiling*: an Elite room's total HP saturates at 2 800 base once
  `complexity ≥ 56`; beyond that, complexity changes nothing about the encounter.

---

## 4. Generation pipeline

### 4.1 Layer order

`fs → parser → map → engine`. Enforced by import direction; `map` never imports
`engine` (stated as the reason `difficulty.ts` and `prng.ts` live at `src/`
root — `difficulty.ts:6-13`, `prng.ts:6-8`).

### 4.2 Ingest → level

1. `readDirectoryTree` builds `TreeNode[]` (`fs/workspace.ts:135`), filtering
   `IGNORED_DIRECTORIES` (`:52`) and `isIgnoredFileName` (`:90`), sorted by
   `compareNodes` (`:164`, directories first).
2. `flattenParsableFiles(tree)` (`main.ts:3123`) returns parsable files
   depth-first in that same order — **this ordering is the campaign level
   order**. Result is memoized per root node (`main.ts:3093`).
3. Level 1 is chosen by `findEntrypoint`, falling back to
   `findEntrypointByScanning` (`main.ts:2419`), which prefers the **least**
   complex file defining a `main`/`Main` callable, else the least complex file
   overall with `complexity > 0`, else the first file that parsed
   (`main.ts:2450-2470`). Files scoring 0 are skipped.
4. `parseFile(name, text)` (`registry.ts:118`) → `ParsedFile | null`.
5. `MapGenerator.generate(parsed, options)` → `GameMap`.
6. `new RaycasterEngine(canvas, map, …, gameplaySeed = randomSeed(), …)`.

### 4.3 Data structures between stages

- `fs → parser`: `TreeNode` (`fs/workspace.ts:24`) + raw `string` text.
- `parser → map`: `ParsedFile` (`parser/types.ts:170-199`) — `language`,
  `linesOfCode`, `entities: CodeEntity[]` (ordered by `startLine`), `gotos`,
  `comments`, `secretTriggers`, `exceptionZones`, `importCount`. Declared as
  "plain, serializable JSON"; `parser/types.ts:12` states that nothing outside
  `src/parser/` may import `web-tree-sitter`.
- `map → engine`: `GameMap` (`map/types.ts`), constructed at
  `mapGenerator.ts:409-438` with 24 fields.

### 4.4 The ordered stages inside `generate()`

`mapGenerator.ts:204-439`. **This order is the RNG draw order** and
`mapGenerator.ts:16-19` states explicitly that reordering changes every existing
map and recorded replay.

| # | Stage | Site | Draws RNG? |
|---|---|---|---|
| 0 | `rng = mulberry32(seedFrom(parsed))` | `:209` | — |
| 1 | `mapSize(parsed)` | `:210` | No |
| 2 | grid filled solid (`1`) | `:213-215` | No |
| 3 | `placeRooms` (incl. `carveLabyrinth` when `nestingDepth ≥ 2`) | `:217` | Yes |
| 4 | `connectRooms` (the spine; guarantees reachability) | `:218` | Yes |
| 5 | `connectLoops` (adds shortcuts only) | `:224` | Yes |
| 6 | `dressCorridors` → `breakupRooms` | `:229` | Yes |
| 7 | `placeSwitchboards` | `:240` | Yes |
| 8 | `placeExceptionZones` | `:241-243` | Yes |
| 9 | `placeVendorDepots` | `:244-246` | Yes |
| 10 | `pickSafeSpawn` | `:254` | No |
| 11 | `pickExit` | `:257` | No |
| 12 | `pickMultiplayerSpawns` (only when `maxPlayers > 1`) | `:261` | No |
| 13 | `spawnEnemies` | `:262` | Yes |
| 14 | `spawnEdgeCaseEnemies` | `:265` | Yes |
| 15 | `placeSwitchboardEncounters` | `:271-273` | Yes |
| 16 | `fillHazards` | `:277` | — |
| 17 | `clearCriticalTiles` | `:282` | No |
| 18 | `placePillars` | `:299` | Yes |
| 19 | `placeDecorations` — **disabled**, `DECORATIONS_ENABLED` false | `:303` | — |
| 20 | `placeDoors` | `:316` | No |
| 21 | `placeKeys` (returns surviving gates) | `:317` | Yes |
| 22 | `placeLoreTerminals` (+ TODO encounters) | `:329` | Yes |
| 23 | `placeSecretRooms` | `:332` | Yes |
| 24 | `placeTeleporters` | `:351` | Yes |
| 25 | `placeTraps` | `:360` | Yes |
| 26 | `placeAmmoPickups` | `:373` | Yes |
| 27 | `planAcidOverflows` — **draws zero RNG**, appended last so it perturbs nothing | `:396` | **No** (`:380-385`) |
| 28 | `visited` fog grid | `:399-401` | No |
| 29 | `assertAllRoomsReachable` (safety net) | `:407` | No |

Feature flags observed: `ACID_OVERFLOW_ENABLED`, `EXCEPTION_ZONES_ENABLED`,
`SWITCHBOARDS_ENABLED`, `VENDOR_DEPOTS_ENABLED` all **on**;
`DECORATIONS_ENABLED` **off** (`:300-303`).

### 4.5 `mapSize` — the sizing formula

`mapGenerator.ts:462-468`:
```
cap      = min(18, maxSize − 2)                       // = 18
roomArea = Σ over entities of w × h from roomDimensions(entity, cap + 2)
raw      = round(2.0 × sqrt(roomArea)) + 10
size     = clamp(raw, 48, 160)
```
`ROOM_SPREAD = 2.0` (`:172`), `ROCK_RESERVE = 10` (`:175`),
`minSize = 48`, `maxSize = 160` (`:134-135`).

`roomDimensions` (`geometry.ts:21-27`):
`w = clamp(4 + complexityScore + nestingDepth × 2, 4, cap)`,
`h = clamp(4 + floor(span / 3) + nestingDepth × 2, 4, cap)`, where
`span = max(1, endLine − startLine + 1)` and `cap = min(18, size − 2)`.

Note the sizing pass calls `roomDimensions` with `cap + 2` (= 20) while actual
room placement calls it with `size` (`mapGenerator.ts:543`), giving a cap of 18.
The area estimate therefore uses a slightly larger cap than placement does.

---

## 5. Enemy tiers / entity taxonomy

### 5.1 `EntityKind` — 6 values

`parser/types.ts:20-26`: `function`, `method`, `class`, `interface`, `trait`,
`global`. Mapping (`:16-19`): `function`/`method` ⇒ enemies; `global` ⇒ hazard
room; the rest ⇒ plain rooms.

### 5.2 Enemy tiers — exactly 3, expressed as 2 booleans

`Enemy` carries `elite: boolean` and `edgeCase: boolean` (`map/types.ts:145` and
the object literals at `enemies.ts:173-174`, `:262-263`). There is no tier enum.
The three reachable states:

| Tier | Flags | Spawn condition | HP | Site |
|---|---|---|---|---|
| **Regular** | `elite:false, edgeCase:false` | entity `kind` is `function`\|`method` and `complexity < 40` | `max(25, round(c × 25 / (1 + floor(c/10))))` | `enemies.ts:128-146` |
| **Elite** | `elite:true` (anchor only) | same, `complexity ≥ 40` | `round(min(50c, 2800) / ceil(min(50c,2800)/350))`, ≤ 350 base | `enemies.ts:131-145` |
| **Edge Case** | `edgeCase:true` | one per breakup room, 1-3 per room | uniform int `[10, 15]` | `enemies.ts:229-265`, `:100-105` |

`elite:true, edgeCase:true` is unreachable — the two spawners are structurally
disjoint (`enemies.ts:219-221`), and `spawnEdgeCaseEnemies` hardcodes
`elite: false` (`:262`).

**Only the pack anchor carries the Elite flag** (`enemies.ts:173`:
`elite && index === 0`). `enemies.ts:165-173` gives the reason: `damageMultiplier`
applies `ELITE_DAMAGE_MULTIPLIER` **per enemy**, so flagging all eight would
multiply the room's incoming DPS by the pack size.

### 5.3 Runtime tier effects

| Constant | Value | Site | Applied |
|---|---|---|---|
| `ELITE_DAMAGE_MULTIPLIER` | `2` | `combatConstants.ts:62` | `enemyAi.ts:220` |
| `EDGE_CASE_DAMAGE_MULTIPLIER` | `0.4` | `combatConstants.ts:68` | `enemyAi.ts:220` |
| `EDGE_CASE_SPEED_MULTIPLIER` | `2.2` | `combatConstants.ts:65` | `enemyAi.ts:225` |
| `EDGE_CASE_RETARGET_RATE` | `2.0` | `combatConstants.ts:71` | `enemyAi.ts:256` |
| `EDGE_CASE_ROAM_JITTER_RAD` | `0.9` | `combatConstants.ts:75` | `enemyAi.ts:270` |

Difficulty rescales HP once at engine construction (`engine.ts:1191-1197`):
`easy 0.7 / normal 1 / hard 1.5` (`difficulty.ts:51-53`). So the maximum runtime
HP any generated enemy can have is `350 × 1.5 = 525`.

Multiplayer Elite scaling (`multiplayerScaling.ts:42-48`):
`hp = 1 + 0.5 × (playerCount − 1)`, `damage = 1 + 0.25 × (playerCount − 1)`.
Identity at `playerCount ≤ 1`. **Elite-only** — Edge Cases untouched (`:14`).

### 5.4 The Champion tier — **does not exist**

`grep -rni 'champion' src scripts doc README.md CHANGELOG.md index.html notes`
returns **zero matches across the entire repository**. There is no Champion
tier: not implemented, not gated, not partial, not disabled, and not documented
anywhere. It has no flag, no constant, no threshold, and no dead code.

The nearest concept is the **Elite anchor** (§5.2) — the single flagged enemy
leading an Elite pack — which is a per-enemy boolean, not a tier of its own.

### 5.5 Non-enemy entity taxonomy

`SecretTriggerKind` — 5 values (`parser/types.ts:153-158`): `deadCode`,
`emptyCatch`, `deprecated`, `commentedCode`, `magicBlob`.
Other trigger types: `ExceptionZoneTrigger` (`:109`), `GotoLink` (`:124`),
`CodeComment` (`:139`), `SwitchBranchSummary` (`:93`).

Synthetic entities exist in five places and all use `kind: "class"`
deliberately, so they fail every "real code" eligibility check and never spawn
an enemy or lock a door: `FILLER_ENTITY` (`mapGenerator.ts:183`), `centeredRoom`
placeholder (`geometry.ts:51`), Edge Case stand-in (`enemies.ts:235-242`),
switchboard (`switchboards.ts:218`), lore (`lore.ts:169`).

---

## 6. Adapter matrix

**Actual count: 15 adapters** — 2 bespoke + 13 generic
(`registry.ts:23-27` = `PhpParserAdapter` + `CParserAdapter` +
`GENERIC_ADAPTERS`, and `languages.ts:32-46` holds exactly 13 entries).

| # | Adapter | `language` id | Extensions | Kind | Refinement | Site |
|---|---|---|---|---|---|---|
| 1 | PHP | `php` | `php`, `php3`, `php4`, `php5`, `phtml` | bespoke | n/a | `php/phpParser.ts:137-138` |
| 2 | C | `c` | `c`, `h` | bespoke | n/a | `c/cParser.ts:128-129` |
| 3 | JavaScript | `javascript` | `js`, `mjs`, `cjs`, `jsx` | generic | `javascriptLike` | `languages.ts:33` |
| 4 | TypeScript | `typescript` | `ts`, `mts`, `cts` | generic | `javascriptLike` | `languages.ts:34` |
| 5 | TSX | `tsx` | `tsx` | generic | `javascriptLike` | `languages.ts:35` |
| 6 | Python | `python` | `py`, `pyw` | generic | `python` | `languages.ts:36` |
| 7 | Java | `java` | `java` | generic | `java` | `languages.ts:37` |
| 8 | C++ | `cpp` | `cpp`, `cc`, `cxx`, `hpp`, `hh`, `hxx` | generic | `cpp` | `languages.ts:38` |
| 9 | Go | `go` | `go` | generic | `go` | `languages.ts:39` |
| 10 | Rust | `rust` | `rs` | generic | `rust` | `languages.ts:40` |
| 11 | Ruby | `ruby` | `rb` | generic | `ruby` | `languages.ts:41` |
| 12 | C# | `csharp` | `cs` | generic | `csharp` | `languages.ts:42` |
| 13 | **Bash** | `bash` | `sh`, `bash` | generic | **none** | `languages.ts:43` |
| 14 | Scala | `scala` | `scala`, `sc` | generic | `scala` | `languages.ts:44` |
| 15 | Objective-C | `objc` | `m`, `mm` | generic | `objc` | `languages.ts:45` |

**37 distinct extensions** are claimed. Extension → adapter mapping is built at
module load (`registry.ts:30-35`), lower-cased.

**Shebang fallback** (`registry.ts:48-54`) — only for files with *no* extension,
and only onto extensions an adapter already claims: `sh`/`bash`/`dash`/`zsh`/`ksh`
→ `sh`; `python`/`python2`/`python3` → `py`; `ruby` → `rb`; `php` → `php`;
`node`/`nodejs` → `js`. A trailing version suffix is stripped (`:80`), so
`python3.11` matches.

### 6.1 Node kinds consumed

All generic adapters share one vocabulary table set (`generic/vocabulary.ts`),
23 exported tables: `ENTITY_NODE_TYPES` (`:39`), `DECISION_NODE_TYPES` (`:88`),
`LOGICAL_OPERATORS` (`:156`), `NESTING_NODE_TYPES` (`:170`), `GOTO_NODE_TYPE`
(`:201`), `LABEL_NODE_TYPE` (`:202`), `COMMENT_NODE_TYPES` (`:206`),
`BLOCK_NODE_TYPES` (`:213`), `RETURN_NODE_TYPES` (`:222`), `CATCH_NODE_TYPES`
(`:227`), `ANNOTATION_NODE_TYPES` (`:237`), `STRING_LITERAL_NODE_TYPES` (`:250`),
`NUMBER_LITERAL_NODE_TYPES` (`:264`), `CASE_BRANCH_NODE_TYPES` (`:284`),
`DEFAULT_BRANCH_NODE_TYPES` (`:304`), `NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES`
(`:310`), `TRY_NODE_TYPES` (`:318`), `FINALLY_NODE_TYPES` (`:327`),
`IMPORT_NODE_TYPES` (`:335`), `CALL_SHAPED_IMPORT_NODE_TYPES` (`:351`),
`CALL_IMPORT_PATTERN` (`:352`), `ALLOCATION_NODE_TYPES` (`:356`),
`CALL_NODE_TYPES` (`:368`), `ALLOCATOR_NAME_PATTERN` (`:380`),
`ARRAY_DECLARATOR_NODE_TYPES` (`:385`), `PARAMETER_LIST_NODE_TYPES` (`:396`).

A `Refinement` is `Pick<LanguageConfig, "extraEntityTypes" | "filter" | "refine">`
(`refinements.ts:19`) — three optional, additive hooks. `refinements.ts:12-13`
states a language with no entry in a hook gets the shared default.

### 6.2 Known gaps (structural, derived from code)

1. **Bash has no refinement** (`languages.ts:43` — the only generic adapter
   without a `...refine.*` spread). It gets shared-vocabulary behaviour only:
   no method/function distinction, no visibility extraction, no name assembly.
2. **`exceptionZones` is empty for Go, Bash, Rust and plain C** — stated at
   `parser/types.ts:186-188` and structurally true because those grammars have no
   construct in `TRY_NODE_TYPES`.
3. **`visibility` is undefined for non-methods** (`parser/types.ts:52-56`),
   treated as public. Only `private`/`protected` methods become key-locked rooms.
4. **`switchBranches` on a `class` entity covers its methods' switches too**
   (`parser/types.ts:89-91`) — harmless because `placeSwitchboards` only considers
   `function`/`method` rooms.
5. **Scala `catch { case … }` needs an exclusion** to avoid every try/catch
   becoming a Switchboard (`astUtils.ts:445-448` via
   `NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES`).
6. **Ruby's `else` fallback is not a branch node** and is found only by a
   sibling scan after a switch is already known to exist (`astUtils.ts:479-484`).

### 6.3 Language neutrality — as implemented

Neutrality holds at the *contract* level: `parser/types.ts:6-13` declares
`ParsedFile` the only shape the rest of the app knows, and the map/engine layers
contain **no language-specific branching** — confirmed by the absence of any
adapter id (`"php"`, `"c"`, `"python"`, …) outside `src/parser/`.

It does **not** hold at the *capability* level: adapters differ in refinement
coverage (gap 1), exception-zone support (gap 2), and the bespoke-vs-generic
split (`registry.ts:11-15`). Two languages therefore produce systematically
different level features from structurally identical code. This is a factual
statement about implemented behaviour, not a defect claim.

---

## 7. Determinism contract

### 7.1 PRNG implementation

One algorithm, `mulberry32`, in one file (`src/prng.ts:46-61`).
`mulberry32(seed)` (`:28-30`) is defined as `createResumablePrng(seed).next`, so
the two forms cannot drift. `next()` is safe to detach because it closes over
`a`, not `this` (`:42-44`).

### 7.2 Every instantiation site (complete — 4 in non-test `src/`)

| # | Site | Seed source | Scope |
|---|---|---|---|
| 1 | `mapGenerator.ts:209` — `mulberry32(seedFrom(parsed))` | content hash | one map generation |
| 2 | `map/generation/styleSet.ts:61` — `mulberry32((seedFrom(parsed) ^ STYLE_SEED_SALT) >>> 0)()` | salted content hash | single draw, styleset pick |
| 3 | `engine/engine.ts:1181` — `createResumablePrng(gameplaySeed)` | `randomSeed()` (`engine.ts:1116` default) | one playthrough |
| 4 | `prng.ts:94` — `pinnedStream ??= mulberry32(pinned)` | `?seed=` URL param | page lifetime |

### 7.3 Seeding paths

- **Map seed** (`generation/seed.ts:24-28`):
  `fnv1a("<language>:<linesOfCode>:" + entities.map(e => "<kind>/<name>/<complexityScore>").join(","))`.
  FNV-1a offset `0x811c9dc5`, prime `0x01000193` (`:14-21`).
  **Note what is *not* in the signature**: `nestingDepth`, `visibility`,
  `allocations`, `startLine`/`endLine`, `gotos`, `comments`, `secretTriggers`,
  `exceptionZones`, `importCount`. Two files differing only in those fields hash
  to the same map seed — though they still generate different maps, because
  `roomDimensions` reads `nestingDepth` and line span directly.
- **Gameplay seed** (`prng.ts:85-96`): `randomSeed()`. Without `?seed=`, a fresh
  `(Math.random() × 0xffffffff) >>> 0` per call. With `?seed=`, values are drawn
  from a `mulberry32` stream rooted at the pinned value, created lazily once per
  page load (`:94`, `:101`) — so successive levels get *different but
  reproducible* seeds. `prng.ts:88-93` states the reason: handing every level the
  same seed would make every level's first loot roll identical.
- **Multiplayer resync** (`prng.ts:32-45`): the host broadcasts `getState()`'s
  raw 32-bit counter; a guest `setState()`s to resume the *sequence*, not restart
  it.

### 7.4 What is guaranteed reproducible

| Guarantee | Holds because |
|---|---|
| Same `ParsedFile` ⇒ byte-identical `GameMap` | seed is content-addressed (§7.3) and `generate()` is the single ordering authority (`mapGenerator.ts:16-19`) |
| Same gameplay seed + same input sequence ⇒ exact run | all simulation randomness on one stream (`prng.ts:14-18`) |
| Host/guest lockstep | resumable PRNG state transfer (`prng.ts:32-45`) |

### 7.5 Draw-order-sensitive locations

- **The 29-stage order in `generate()`** (§4.4). `mapGenerator.ts:16-19` states
  this explicitly.
- **`planAcidOverflows` draws zero RNG** and is appended last precisely so it
  perturbs nothing (`mapGenerator.ts:380-385`) — a file with no
  allocation-dense function generates a byte-identical map either way.
- **`enemyPositions`** (`enemies.ts:317-323`) draws a *variable* number of times:
  the re-roll loop runs up to 8 times per enemy when blocked. Draw count depends
  on geometry.
- **`fireCooldown: rng() * 2`** (`enemies.ts:163`, `:260`) — one draw per enemy,
  inside the enemy loop.
- **`connectLoops` runs after `connectRooms`** and only adds edges, so it cannot
  break reachability (`mapGenerator.ts:219-224`).

### 7.6 Deliberate non-determinism (`Math.random()` — 5 modules)

`prng.ts:20-26` names these as intentional, on the grounds that none feeds back
into simulation state:

| Module | Sites | Use |
|---|---|---|
| `engine/effects.ts` | 15 | blood/particle scatter |
| `engine/audio.ts` | 6 | SFX pitch jitter, noise buffer |
| `engine/textures.ts` | 8 | procedural texture grain |
| `engine/bgm.ts` | 1 | shuffle order |
| `ui/consoleSidebar.ts` | 3 | hint selection + delay |
| `engine/engine.ts:4876` | 1 | `baseBloodCount` |
| `prng.ts:87` | 1 | the seed itself, when unpinned |

`engine.ts:4876` (`3 + floor(Math.random() * 3)` for blood count) is the only
`Math.random()` site inside `engine.ts` proper; `engine.ts:825` documents the
rule it is an exception to.

### 7.7 Verification harness

`npm run verify:multiplayer-determinism` (CI job `verify (cross-browser
determinism)`, `verify.yml:429-450`) runs across chromium + firefox + webkit.
`POC_SEED` default `0xc0ffee`, `POC_ITERATIONS` `500000`, `POC_SAMPLE_EVERY`
`500` (`verify-multiplayer-determinism.mjs:37-39`).

---

## 8. Build / run / test

### 8.1 Toolchain

| Requirement | Value | Source |
|---|---|---|
| Node (declared) | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | `package.json:11` |
| Node (CI) | `24` — all 7 jobs | `verify.yml:25,66,113,274,320,436`, `deploy.yml:35` |
| Node (verified locally) | `v24.18.0` | executed |
| TypeScript | `^7.0.2` | `package.json:82` |
| Vite | `^8.2.1` | `package.json:83` |
| Vitest | `4.1.10` (pinned) | `package.json:84` |
| Playwright | `^1.62.1` | `package.json:67` |

### 8.2 Commands verified by execution

| Command | Result |
|---|---|
| `npm run typecheck` | **Pass**, exit 0, no diagnostics |
| `npx vitest run --dir src` | **Pass** — 120 files, 2 926 tests, 37.65 s |
| `npx vitest run --dir scripts` | **Pass** — 17 files, 520 tests, 0.55 s |
| `node scripts/multiplayer-server.mjs --help` | **Pass** — prints usage |
| `node scripts/report-gate-budget.mjs` | **Pass** — 17 demo-campaign levels |
| `node scripts/report-damage-model.mjs` | **Pass** — 1 175 847 shots, 954 event files |
| `node scripts/report-aim-error.mjs` | **Pass** — 1 363 542 shots |
| `node scripts/report-level-budget.mjs --help` | **Fails** — `unknown argument: --help` |

**Full repo test surface: 137 test files, 3 446 tests.**

**One caveat on `npm test` (bare `vitest run`).** Vitest's default `include`
glob is repo-wide. In a *clean clone* that resolves to the 137 real test files.
In this working tree it additionally collects **135 foreign test files** from the
untracked, gitignored `balancing_corpus/` (fetched third-party repos —
`django/js_tests/*.test.js`, `quake/**/*.spec.sh`, and a vendored copy of this
project itself). `--dir src` / `--dir scripts` is what avoids them. `.gitignore`
excludes `balancing_corpus/` but vitest's collector does not read `.gitignore`.
CI never hits this because it runs `npm ci` on a clean checkout
(`verify.yml:68,76`).

### 8.3 Coverage gate — actual thresholds

`vitest.config.ts:104-109`: **`lines 99.9`, `statements 99.9`, `functions 99.5`,
`branches 99.5`** — not 100%. The comment at `:94-103` records why: the
vitest 4 / `@vitest/coverage-v8` 4.1.10 remapping has reproducible measurement
bugs, and the thresholds sit just below the honestly-measured
99.94/99.79/99.62/99.97%.

Coverage `include` is `src/**/*.ts` (`:61`) with 8 exclusions (`:79-93`), of
which `src/engine/defaultHighscore.ts` (a 115k-line generated data literal) and
five type-only modules are the substantive ones.

**The CI job that runs this is named `unit tests (Vitest, 100% coverage gate)`**
(`verify.yml:56`). That name does not match the configured thresholds.

### 8.4 CI job topology (`verify.yml`, 7 jobs)

| Job | Name | Runs |
|---|---|---|
| `verify` | `verify (no browser)` | `fetch:online-wads --strict`, `build`, `verify:wad-parser`, `verify:zip-reader`, `verify:campaign`, `verify:multiplayer-server` |
| `test` | `unit tests (Vitest, 100% coverage gate)` | `npm run coverage \|\| npm run coverage` (retry once, `:76`) |
| `verify-browser` | `verify (Playwright/${{ matrix.browser }})` | wad-textures, campaign:playthrough, multiplayer connect/netcode/reconciliation/disconnect |
| `verify-replay` | `verify (replay)` | `verify:replay` |
| `verify-multiplayer-transition` | own job | |
| `verify-multiplayer-multiguest` | own job | |
| `verify-determinism` | `verify (cross-browser determinism)` | chromium + firefox + webkit |

`verify:multiplayer-campaign` and `verify:event-log` are **not** wired into CI.

### 8.5 Dependencies

**Exactly one runtime dependency**: `web-tree-sitter@^0.26.10`
(`package.json:86-88`). All 14 tree-sitter grammars are **devDependencies**
(`:68-81`) — their `.wasm` files are pulled in through Vite `?url` imports
(`languages.ts:16-28`) and emitted as static assets at build time. The no-new-
runtime-dependencies invariant is therefore currently satisfied with a margin of
one package.

---

## 9. Version & release state

| Fact | Value | Source |
|---|---|---|
| `package.json` version | `0.0.0` | `package.json:4` |
| `package.json` private | `true` | `:3` |
| Latest git tag | `beta-6`, 2026-08-04, `6f045b0` | `git for-each-ref` |
| All tags | `beta-1` (07-07) … `beta-6` (08-04) | 6 tags, weekly-ish cadence |
| Latest CHANGELOG section | `## Unreleased` (line 3) | `CHANGELOG.md:3` |
| Latest *released* CHANGELOG section | `## beta-6` (line 34) | `CHANGELOG.md:34` |
| Commits since `beta-6` | 8 days of work; `## Unreleased` holds **21 entries** | |
| Runtime version display | **none exists** | §1.3 |

`vite.config.ts` defines `__BUILD_TIME__` and `__BUILD_REF__`
(mirrored in `vitest.config.ts:45-48` as fixed strings `"test-build"` /
`"test-ref"`), and `main.ts` reads them at module load. These are build-stamp
values, not a semantic version, and no UI surface was found that renders them as
a version to the user.

`package.json:4`'s `0.0.0` is therefore **not** the shipped version by any
meaning; the tag is the only release identity, and nothing in the running app
reports it.

---

## 10. Notes on the stated project invariants

### 10.1 Density invariance — **no such invariant exists in code**

There is no assertion, test, or check anywhere named for or enforcing "density
invariance", and no property of level output is verified to hold across repo
sizes. What actually exists:

1. **`mapSize` scales sub-linearly with content** — `round(2.0 × sqrt(roomArea)) + 10`,
   clamped to `[48, 160]` (`mapGenerator.ts:467-468`). Since room area grows
   with entity count and side length grows as its square root, *floor* density is
   bounded by construction rather than by a check.
2. **`ROOM_SPREAD = 2.0` is calibrated, not derived** — `mapGenerator.ts:451-461`
   states the packed cluster's bounding side measured 1.56–2.72× `sqrt(roomArea)`
   across the demo campaign, and the constant sits inside that band. The same
   comment records that an earlier version of itself argued for 2.6 and **was
   itself stale prose**, retracted in place.
3. **The 160-tile `maxSize` clamp breaks the scaling at the top end.** A
   sufficiently large file saturates it, after which additional entities increase
   room count without increasing map area — density is *not* invariant there.
4. **Measurement, not assertion, is the instrument** — `npm run report:level-maps`
   (`scripts/render-level-maps.mjs`) renders floor density against each level's
   own bounding box.

Any doc asserting density invariance as a guaranteed property is asserting
something the code does not check.

### 10.2 Determinism — holds, and is CI-verified (§7)

### 10.3 Replay & lockstep — the RNG draw order is the contract (§4.4, §7.5)

### 10.4 No new runtime dependencies — currently 1 runtime dep (§8.5)

### 10.5 Language neutrality — holds at the contract level, not the capability level (§6.3)

---

## 11. Code/test disagreements

**None found.** All 3 446 tests pass against current `src`/`scripts`. Where a
test and the code could have diverged, I treated the code as authoritative and
the test as corroboration; no case arose where that mattered.

Two *in-code documentation* statements disagree with the code they sit next to.
Both are doc-surface findings and are carried into Phase 3, not fixed here:

| Site | Says | Code says |
|---|---|---|
| `src/engine/multiplayerScaling.ts:20-21` | Elite HP scaling "stacks with … `ELITE_HP_MULTIPLIER`'s own base **4x**" | `ELITE_HP_MULTIPLIER = 2` (`enemies.ts:51`), lowered 4→2 on 2026-07-30 per its own comment at `:33` |
| `src/map/generation/enemies.ts:168` | cites `damageMultiplierFor` (`enemyAi.ts:220`) | the function is named `damageMultiplier` and is declared at `enemyAi.ts:219` |

---

## 12. Items I could not verify

| Item | Why | Classification |
|---|---|---|
| `run-perf-benchmark.mjs`, `diagnose-level-wedge.mjs`, `build-perf-report.mjs` flag behaviour | Require a browser session / prior capture artifacts; flags read from the parser source only | Derived, not executed |
| `fetch-online-wads.mjs --strict`, `fetch-balancing-corpus.mjs --list` | Network side effects; not run per read-only constraint | Derived, not executed |
| `generate-default-highscore.mjs` backfill flags | ~35-minute job | Derived, not executed |
| Content rendered inside `og-image.png` / `sidebar-logo.webp` | Binary; format and dimensions verified only | Not verified |
| Whether the shipped `defaultHighscore.ts` matches the current bot profiles | `profiles.test.mjs`'s `PROFILES_HASH` guard is in its documented unarmed state until the generator is next run; the tests pass either way | Cannot be confirmed by running the suite |

**STOP — Phase 2 complete. Awaiting `APPROVED`.**
