# Phase 1 — Documentation Surface Inventory

Read-only enumeration. No correctness evaluation. All paths repo-relative.
Metadata captured at commit `c0830bf` (master, clean tree), 2026-08-12.

Conventions:
- **LOC** is `wc -l`. Several docs use very long single-line paragraphs, so LOC
  and byte size diverge sharply (e.g. `doc/dev/history.md` — 1481 lines /
  612 KB). Both are given where they disagree.
- **Audience** — `user` (players), `dev` (contributors/future-self), `agent`
  (written to be read by coding agents / LLM sessions), `ops` (deployment),
  `search` (crawler/social metadata).
- Grouped rows (`I-*`, `U-*`) cover a class of in-code surface too numerous to
  list per file; the file count is given in Notes.

---

## A. Prose documentation (Markdown / plain text)

| ID | Path | Surface type | Audience | Last touched | LOC / size | Notes |
|---|---|---|---|---|---|---|
| D-01 | `README.md` | Project README | user + dev | 2026-08-04 (`5c36dc5`) | 423 / 28 KB | Top-level pitch, feature list, pipeline description, controls, quick start, project structure, browser reqs, third-party licence inventory |
| D-02 | `CHANGELOG.md` | Changelog | user | 2026-08-10 (`b06309b`) | 142 / 40 KB | `## Unreleased` + per-beta sections; prose-heavy entries with embedded measurements |
| D-03 | `LICENSE` | Licence text | all | 2026-07-04 (`e6afcd3`) | 661 / 34 KB | AGPL-3.0-or-later verbatim |
| D-04 | `notes` | Working backlog | dev + agent | 2026-08-12 (`c0830bf`) | 193 / 59 KB | Extensionless. `## Done` / `## Open` convention; open task list is the live backlog. Currently open in the user's IDE |
| D-05 | `doc/dev/README.md` | Doc index | dev | 2026-08-09 (`50a0ba4`) | 44 / 6 KB | Index + the "which file answers which question" routing table for the whole dev doc set |
| D-06 | `doc/dev/architecture.md` | Architecture reference | dev | 2026-08-04 (`5c36dc5`) | 95 / 37 KB | `fs → parser → map → engine` layering and the hard rules |
| D-07 | `doc/dev/game-design.md` | Design rationale | dev | 2026-08-09 (`dc6b433`) | 58 / 21 KB | Why code maps to a dungeon the way it does |
| D-08 | `doc/dev/decisions.md` | Decision register | dev + agent | 2026-08-11 (`fc1c4e4`) | 250 / 71 KB | "Why is the code like this", incl. *Approaches Measured and Rejected* |
| D-09 | `doc/dev/history.md` | Chronological history | dev | 2026-08-12 (`c0830bf`) | 1481 / **612 KB** | Largest doc surface in the repo by an order of magnitude |
| D-10 | `doc/dev/testing.md` | Test-harness guide | dev | 2026-08-11 (`415e212`) | 179 / 53 KB | Vitest suite, mocks, verify scripts, what the suite cannot catch |
| D-11 | `doc/dev/performance.md` | Perf tooling guide | dev | 2026-08-02 (`56d6fd8`) | 60 / 9.5 KB | `?perfDebug=1`, `perf:bench` / `perf:report` |
| D-12 | `doc/dev/perf-review-2026-08-02.md` | Dated audit snapshot | dev | 2026-08-02 (`56d6fd8`) | 416 / 48 KB | Explicitly a point-in-time snapshot per D-05 |
| D-13 | `doc/dev/review-2026-08-03.md` | Dated audit snapshot | dev | 2026-08-03 (`0646830`) | 737 / 48 KB | Explicitly a point-in-time snapshot per D-05 |
| D-14 | `doc/dev/adding-a-weapon.md` | Contributor checklist | dev + agent | 2026-08-09 (`dc6b433`) | 187 / 21 KB | Touchpoint checklist; enumerates hardcoded tables |
| D-15 | `doc/dev/adding-a-language.md` | Contributor checklist | dev + agent | 2026-08-04 (`5c36dc5`) | 138 / 7.9 KB | Grammar-ABI vetting gate; shared vocabulary tables |
| D-16 | `doc/dev/wad-texture-packs.md` | Format reference | user + dev | 2026-08-01 (`19c0eac`) | 150 / 15 KB | Lump-name tables per styleset/slot, fallback chain |
| D-17 | `doc/dev/balancing-telemetry.md` | Tooling reference | dev | 2026-08-11 (`3515c79`) | 1742 / 160 KB | Bot entry points, profiles, env vars |
| D-18 | `doc/dev/capturing-another-campaign.md` | Runbook | dev | 2026-08-09 (`036f1cd`) | 398 / 19 KB | Measuring balance on an external repo |
| D-19 | `doc/dev/multiplayer-deployment.md` | Ops runbook | ops | 2026-08-01 (`32cad86`) | 421 / 17 KB | Signaling server, client build, coturn |
| D-20 | `doc/dev/multiplayer-research.md` | Historical feasibility study | dev | 2026-08-01 (`32cad86`) | 573 / 40 KB | Self-declared superseded by D-21..D-24 where they disagree |
| D-21 | `doc/dev/multiplayer-server-spec.md` | Spec | dev | 2026-08-04 (`5c36dc5`) | 726 / 40 KB | Signaling + lobby server |
| D-22 | `doc/dev/multiplayer-netcode-spec.md` | Spec | dev | 2026-08-10 (`8c9e6f6`) | 1308 / 85 KB | Lockstep layer — **determinism/replay-critical** |
| D-23 | `doc/dev/multiplayer-game-state-spec.md` | Spec | dev | 2026-08-01 (`32cad86`) | 912 / 56 KB | `simulate()`/`render()`/`advance()` split, N-player model, elite scaling |
| D-24 | `doc/dev/multiplayer-balancing-telemetry-spec.md` | Spec | dev | 2026-07-22 (`6283499`) | 334 / 20 KB | Oldest untouched dev doc (21 days) |
| D-25 | `doc/user/README.md` | Doc index | user | 2026-08-04 (`5c36dc5`) | 15 / 1.3 KB | Player-guide index |
| D-26 | `doc/user/getting-started.md` | Player guide | user | 2026-08-04 (`5c36dc5`) | 45 / 5.4 KB | |
| D-27 | `doc/user/controls.md` | Player guide | user | 2026-08-04 (`5c36dc5`) | 62 / 2.7 KB | Keyboard, mouse, gamepad, cheat codes |
| D-28 | `doc/user/hud-and-ui.md` | Player guide | user | 2026-08-03 (`3fa86c7`) | 62 / 8.1 KB | |
| D-29 | `doc/user/mechanics.md` | Player guide | user | 2026-08-09 (`dc6b433`) | 89 / 13 KB | Code→level mapping, weapons, loot, enemies, traps, scoring |
| D-30 | `doc/user/level-design.md` | Player guide | user + agent | 2026-08-08 (`f5d703f`) | 57 / 10 KB | Explicitly addressed to "you or a coding agent" writing source that generates a level |
| D-31 | `doc/user/multiplayer.md` | Player guide | user | 2026-08-10 (`c1873ba`) | 59 / 5.2 KB | |
| D-32 | `doc/user/tips.md` | Player guide | user | 2026-08-02 (`b1fb295`) | 18 / 3.7 KB | |
| D-33 | `doc/user/troubleshooting.md` | Player guide | user | 2026-08-10 (`48ab749`) | 172 / 9.1 KB | |
| D-34 | `doc/user/privacy.md` | Privacy statement | user | 2026-08-10 (`c1873ba`) | 56 / 9.9 KB | Enumerates every remote request — a factual claim set about network behaviour |
| D-35 | `docker/README.md` | Ops runbook | ops | 2026-07-26 (`01c459f`) | 78 / 4.5 KB | Docker signaling + coturn stack |
| D-36 | `scripts/lib/lane-orchestration.md` | Module contract | dev | 2026-08-09 (`50a0ba4`) | 108 / 5.7 KB | Deliberately co-located with code, not in `doc/` |

## B. Configuration / manifest documentation

| ID | Path | Surface type | Audience | Last touched | LOC / size | Notes |
|---|---|---|---|---|---|---|
| C-01 | `package.json` | Command catalogue + engine floor | dev | 2026-08-11 (`4a9e95e`) | 89 / 4.8 KB | 48 npm scripts — the de-facto CLI surface. `version: "0.0.0"`; `engines.node: "^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0"` |
| C-02 | `tsconfig.json` | Build config | dev | 2026-07-26 (`4813104`) | 30 / 880 B | |
| C-03 | `vite.config.ts` | Build config + comments | dev | 2026-07-22 (`c5b2c2a`) | 76 / 3.7 KB | Explanatory comments on chunking/asset handling |
| C-04 | `vitest.config.ts` | Test config + comments | dev | 2026-07-26 (`188bc59`) | 112 / 5.2 KB | Coverage thresholds documented in comments |
| C-05 | `docker/.env.example` | Commented config template | ops | 2026-07-24 (`c4d123f`) | 95 / 4.2 KB | Every key carries an explanatory comment — a documentation surface in its own right |
| C-06 | `docker/docker-compose.yml` | Ops config + comments | ops | 2026-08-11 (`6c239d2`) | 135 / 6.4 KB | |
| C-07 | `ssh-hosts.env.dist` | Commented config template | dev | 2026-07-22 (`f41cfc3`) | 34 / 2.0 KB | Lane-host template for distributed captures |
| C-08 | `.github/dependabot.yml` | Dependency policy | dev | 2026-07-26 (`1412848`) | 26 / 836 B | Encodes the update policy — relevant to the no-new-deps invariant |
| C-09 | `public/site.webmanifest` | App metadata | user + search | 2026-07-17 (`e4289cc`) | 14 / 688 B | `description: "Turn any codebase into a playable Doom-like dungeon."` |
| C-10 | `public/robots.txt` | Crawler policy | search | 2026-07-17 (`8eef6dd`) | 4 / 78 B | Points at `https://codeenstein3d.mcdope.org/sitemap.xml` |
| C-11 | `public/sitemap.xml` | Crawler metadata | search | 2026-07-17 (`8eef6dd`) | 9 / 275 B | `lastmod: 2026-07-17`, hardcoded |
| C-12 | `public/browserconfig.xml` | Windows tile metadata | user | 2026-07-17 (`e4289cc`) | 12 / 375 B | |
| C-13 | `.gitignore` | Commented policy file | dev + agent | 2026-08-09 (`036f1cd`) | 64 / 2.2 KB | Comment blocks explain *why* each pattern exists (capture dirs, telemetry snapshots, dated balance reviews) — genuinely instructional |

## C. Build / run / CI documentation

| ID | Path | Surface type | Audience | Last touched | LOC / size | Notes |
|---|---|---|---|---|---|---|
| B-01 | `.github/workflows/verify.yml` | CI definition + step names | dev | 2026-08-11 (`fdac894`) | 450 / 21 KB | 7 jobs; job/step names assert what is verified (`unit tests (Vitest, 100% coverage gate)`, `verify (cross-browser determinism)`, …). The authoritative "commands that actually work" source |
| B-02 | `.github/workflows/deploy.yml` | CI definition | dev/ops | 2026-07-26 (`49ba66d`) | 69 / 2.4 KB | Pages deploy |
| B-03 | `docker/signaling/Dockerfile` | Build recipe + comments | ops | 2026-07-26 (`cf16a33`) | 28 | |
| B-04 | `docker/signaling/Dockerfile.dockerignore` | Build recipe | ops | 2026-07-26 | small | |
| B-05 | `docker/coturn/turnserver.conf.base` | Commented config | ops | 2026-07-26 (`cf16a33`) | 57 | |
| B-06 | `docker/coturn/entrypoint.sh` | Script + comments | ops | 2026-07-24 (`c4d123f`) | 109 | |
| B-07 | `docker/update.sh` | Script + comments | ops | 2026-07-26 (`01c459f`) | 72 | |

## D. In-code documentation surfaces

| ID | Path (class) | Surface type | Audience | Last touched | Size | Notes |
|---|---|---|---|---|---|---|
| I-01 | `src/**/*.ts` (non-test) file-header docblocks | Module-level docs | dev + agent | 2026-08-12 | **136 files, 136/136 carry a header comment** | Every non-test source file opens with an SPDX line pair plus a `/** … */` module doc. Uniform coverage — this is the single largest in-code doc surface |
| I-02 | `src/parser/registry.ts` | Adapter registry doc | dev + agent | 2026-07-26 (`df99121`) | 137 | Documents why C and PHP have bespoke adapters |
| I-03 | `src/parser/generic/languages.ts` | **Adapter matrix** | dev + agent | 2026-08-04 (`ca016ec`) | 45 | The literal adapter list. 13 `GenericParserAdapter` entries + the mandatory-ABI-vetting docblock |
| I-04 | `src/parser/generic/genericParser.ts` | Adapter base-class doc | dev | 2026-07-27 (`fd0faf6`) | 216 | |
| I-05 | `src/parser/generic/refinements.ts` | Per-language refinement docs | dev | 2026-08-06 (`608e3b8`) | 310 | Named refinement bundles referenced from I-03 |
| I-06 | `src/parser/c/cParser.ts` | Bespoke adapter doc | dev | 2026-08-11 (`e4039e1`) | 305 | |
| I-07 | `src/parser/php/phpParser.ts` | Bespoke adapter doc | dev | 2026-07-27 (`fd0faf6`) | 265 | |
| I-08 | `scripts/*.mjs` file-header docblocks | Script docs | dev | 2026-08-12 | 73 non-test scripts | Entry-point scripts; several also carry usage text (see U-11) |
| I-09 | `scripts/lib/*.mjs` file-header docblocks | Module docs | dev | 2026-08-12 | 30 non-test modules | |
| I-10 | `test/mocks/*.ts` file-header docblocks | Mock contract docs | dev | 2026-08-12 | 7 files | Documented in D-10 as the shared-mock set |
| I-11 | `scripts/fixtures/buildTestWad.d.mts` | Type declarations as docs | dev | 2026-07-12 (`85c18d1`) | 32 | Hand-written `.d.mts` documenting the JS fixture builder's API |
| I-12 | `src/style.css` comments | Styling rationale | dev | 2026-08-12 (`da2c28c`) | 1132 / 24 KB | |

## E. User-facing strings

| ID | Path | Surface type | Audience | Last touched | Size | Notes |
|---|---|---|---|---|---|---|
| U-01 | `index.html` | Page shell, meta tags, sidebar labels, intro panel | user + search | 2026-08-12 (`da2c28c`) | 378 / 21 KB | Contains the "New to coding? / How it works / What you'll do / Privacy" onboarding copy (lines ~281-345) and all OG/Twitter description claims (lines 11-34) |
| U-02 | `src/ui/introTour.ts` | First-run guided tour copy | user | 2026-08-12 (`7b9039f`) | 292 | Newest user-facing copy in the repo — anchored to real sidebar controls |
| U-03 | `src/ui/controlsLegend.ts` | In-game controls legend | user | 2026-08-01 | 116 | Must agree with D-27 and D-01's Controls section |
| U-04 | `src/ui/gameHud.ts` | HUD chrome text | user | 2026-07-20 | 397 | |
| U-05 | `src/engine/hud.ts` | In-canvas HUD text | user | 2026-08-10 | 630 | |
| U-06 | `src/ui/consoleSidebar.ts` | Console sidebar | user | 2026-07-19 | 150 | Mirrors log strings — subject to the no-spoilers constraint |
| U-07 | `src/ui/highscorePanel.ts`, `src/ui/fileTree.ts` | Panel labels/empty states | user | 2026-08-10 | 131 + 95 | |
| U-08 | `src/difficulty.ts` | Difficulty names/descriptions | user | 2026-08-04 | 56 | |
| U-09 | `src/map/generation/lore.ts` | Generated in-world lore text | user | 2026-08-11 | 218 | |
| U-10 | `src/wad/onlineWadCatalog.ts` | Texture-pack catalogue labels | user | 2026-08-01 | 94 | |
| U-11 | `scripts/*.mjs` usage/`--help` text | CLI usage strings | dev | 2026-08-12 | **21 scripts** | `build-perf-report`, `diagnose-level-wedge`, `multiplayer-server`, `poc-cross-browser-determinism`, `report-aim-error`, `report-balancing-ab`, `report-balancing-events`, `report-damage-model`, `report-gate-budget`, `report-profile-separation`, `report-wad-styleset-coverage`, `run-balancing-campaign`, `run-balancing-campaign-multiplayer`, `run-perf-benchmark`, `setup-ssh-lane-host`, `stage-campaign`, `verify-event-log`, `verify-multiplayer-determinism`, `verify-multiplayer-server`, `watch-bot-sessions`, `lib/multiplayerTestServers` |
| U-12 | `src/**/*.ts` `throw new Error(...)` messages | Instructional error text | user + dev | 2026-08-12 | 16 files, 27 sites | Densest: `multiplayer/chunkedTransfer.ts` (5), `fs/github.ts` (4). `fs/github.ts` messages are explicitly instructional per CHANGELOG (rate-limit / truncation guidance) |

## F. Assets and data that encode claims

| ID | Path | Surface type | Audience | Last touched | Size | Notes |
|---|---|---|---|---|---|---|
| A-01 | `public/og-image.png` | Social preview image | search | 2026-07-17 | 1200×630 PNG | Referenced by `index.html:24,34` with matching declared dimensions |
| A-02 | `public/sidebar-logo.webp` | Brand logo (alt text "Codeenstein 3D") | user | 2026-07-17 | WebP | `index.html:73` |
| A-03 | `public/favicon*.png/.ico`, `apple-touch-icon.png`, `android-chrome-*`, `mstile-*` | Icon set | user | 2026-07-17 | 13 files | Declared in C-09 / C-12 / `index.html` |
| A-04 | `perf-findings.json` | Committed measurement record | dev | 2026-08-02 | 21 KB, 15 entries | Tracked; asserts performance facts. Paired with the untracked generated `perf-report.html` |
| A-05 | `demo-campaign/*` (17 source files, 12 languages) | Fixture corpus + in-file comments | user + dev | 2026-08-10 | 17 files | The bundled campaign. Comments in these files describe the level each is meant to produce — a claim about generator behaviour |
| A-06 | `scripts/fixtures/main.c`, `stage02_hazard.c`, `pathological-repo/*.c` | Test fixture corpus | dev | — | 4 files | Pinned inputs whose comments assert what they exercise |

---

## Totals

| Class | Rows | Underlying files |
|---|---|---|
| A. Prose documentation | 36 | 36 |
| B. Configuration / manifest | 13 | 13 |
| C. Build / run / CI | 7 | 7 |
| D. In-code doc surfaces | 12 | ~253 (136 src + 73 scripts + 30 scripts/lib + 7 mocks + others) |
| E. User-facing strings | 12 | ~40 |
| F. Assets encoding claims | 6 | ~35 |
| **Total inventory rows** | **86** | **~380 files** |

Prose-documentation volume alone: **~1.85 MB** across 36 files, of which
`doc/dev/history.md` (612 KB) and `doc/dev/balancing-telemetry.md` (160 KB)
are 42%.

## Surfaces that could not be read

None of the tracked text surfaces failed to read. Two categories are readable
only as binaries and were inspected by metadata, not content:

- A-01/A-02/A-03 — image assets. Verified format and dimensions
  (`og-image.png` = 1200×630, matching its declared `og:image:width/height`),
  but the rendered text/branding inside them was not OCR'd.
- `package-lock.json` (105 KB) — treated as a build artifact, not a doc
  surface; it is authoritative for dependency versions and will be used as
  *ground truth* input in Phase 2 rather than audited as documentation.

## Generated surfaces (must be fixed at source, not in place)

| Surface | Generator | Tracked? |
|---|---|---|
| `perf-report.html` | `scripts/build-perf-report.mjs` | No — `.gitignore:38` |
| `level_maps/` (floor plans + metrics) | `scripts/render-level-maps.mjs` | No — `.gitignore:57` |
| `wedge-diagnosis/` | `scripts/diagnose-level-wedge.mjs` | No — `.gitignore:54` |
| `src/engine/defaultHighscore.ts` | `scripts/generate-default-highscore.mjs` | Yes — a *code* file whose contents (bot profile names, scores, `PROFILES_HASH`) are asserted by prose docs. Regenerate, never hand-edit |
| `coverage/`, `.verify-tmp/`, `.verify-output/` | test/verify runs | No |
| `balancing_corpus/`, `balancing_capture_*/`, `balancing_runs*/`, `lane-speed.json` | balancing tooling | No |

No Markdown file in `doc/` is machine-generated; all 36 prose surfaces are
hand-maintained and must be edited in place.

## Notable structural observations (not yet findings)

1. **No `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`, `INSTALL`, or `AGENTS.md`
   exists**, and there is no `man/`, `*.1`, `*.adoc`, or `*.rst` content. The
   contributor-facing role is carried by `doc/dev/` (D-05…D-24) instead.
2. **There is no `--version` output anywhere.** `package.json:version` is
   `"0.0.0"` while the latest git tag is `beta-6`; no script or UI surface
   prints a version. Flagged for Phase 2 item 9.
3. **`.claude/` contains no tracked files** — the agent-facing guidance an agent
   would look for first does not exist in-repo; agents currently start from
   D-01/D-05.
4. **Two dated snapshots (D-12, D-13) are declared superseded by design**, and
   D-20 self-declares as historical. These need a different drift standard than
   the evergreen docs and will be classified accordingly in Phase 3.
5. **Untracked but present in the working tree**: 40+ `balancing_*` result
   directories, `notes`-adjacent logs, `undefined/`. All gitignored; none are
   documentation surfaces, but `.gitignore:52-64` documents why several exist.

**STOP — Phase 1 complete. Awaiting `APPROVED`.**
