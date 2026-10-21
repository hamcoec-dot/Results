# Testing & Traceability

Public trust depends on this: every number shown on a public page must be provably the number in the source CSV.
The full strategy is in [plans/cloud-admin-upload.md](plans/cloud-admin-upload.md) → **Test strategy**. This file is the
traceability matrix: every requirement, check, and budget maps to the tests that cover it. Phases add rows as they land.

## Running

```bash
cd functions && npm ci
npm test                 # all node:test suites
npm run test:pr          # same, with c8 coverage gates (lines/statements/functions ≥ 95 %, branches ≥ 90 % on src/)
npm run test:nightly     # property tests at 100,000 runs
npm run mutation         # Stryker mutation testing (breaks below 85 %), report in functions/reports/mutation/
npm run mutation -- --mutate src/parse.js   # one shard (what nightly runs per file)
npm run test:emulator    # layers 6-7 on the Auth/Firestore/Storage/Functions emulators (Java 11+, firebase-tools 13.35.1)
npm run golden           # regenerate Python golden outputs (needs Python 3)
```

Public pages (from the repo root):

```bash
npm ci && npx playwright install chromium
npm run a11y             # axe + live-update tests on the four public pages (Playwright serves the repo on :8124)
npm run perf             # Lighthouse mobile on the four pages vs the budgets (needs Chrome); see perf/BASELINE.md
node tools/emulator-drafts.js   # emulators running + seeded: publish sample 02, draft 03, print the ?emulator&draft= links
```

Replay a fast-check failure: `FC_SEED=<seed> FC_PATH=<path> npm test` (both are printed on failure).
Generate a fixture by hand: `node tools/gen-fixture.js --seed 42 --kind ed --layout wide --names wild --out x.csv`.

## Test layers — status

| # | Layer | Status | Where |
|---|---|---|---|
| 1 | Unit (`node:test` + `c8`) | **done** for every module in `functions/src/` except `index.js` (wiring; covered by the emulator suite) | `units`, `edges`, `verify`, `checks`, `validate`, `review`, `publish`, `bench` `.test.js`; gates in `functions/.c8rc.json` |
| 2 | Reference parity | **done**: all 19 cases byte-identical (4 files each), raw parse and verify list equal; legacy merge equals Python's on random elections and on real exports with precincts removed | `parity.test.js`, `merge-parity.property.test.js`, `pycompat.property.test.js` (via `tools/py_bridge.py`) |
| 3 | Property-based | **done**: model → CSV → parse + merge round trip (1,000 runs per PR, 100,000 nightly) | `roundtrip.property.test.js`, `tools/gen-fixture.js` (`deriveEarly`, `visibleReported`) |
| 4 | Fuzz / malformed | **done**: mutated real exports (crash/hang-free, parse equals Python's), arbitrary bytes, 5 MB | `fuzz.test.js` |
| 5 | Mutation (Stryker) | configured: csv, pycompat, parse, merge, verify, checks, validate; break < 85 %; nightly, one shard per file | `functions/stryker.config.json`, `.github/workflows/nightly.yml` |
| 6 | Security rules | **done** (emulator, CI job `emulator`) | `test/emulator/rules.test.js` (`npm run test:emulator`) |
| 7 | Function integration | **done**: full contract on in-memory fakes; refusals, publish, tamper and race on the emulators | `service.test.js`; `test/emulator/integration.test.js` |
| 8 | E2E + DOM oracle | Phase 4 | — |
| 9 | Visual regression | Phase 3/4 | — |
| 10 | Accessibility | **public pages done** (Phase 4): axe WCAG 2.1 A+AA at 320/375/1280 px, dark and high-contrast themes, the precinct dialog, the by-contest table, every `?draft` view; no horizontal page scroll. admin/review: Phase 3 follow-up | `a11y/public-pages.spec.js` (`npm run a11y`, CI job `pages`) |
| 11 | Performance | **public pages measured** (Phase 4): Lighthouse mobile, budgets checked; baseline and results in `perf/BASELINE.md` | `perf/lighthouse.mjs` (`npm run perf`, local; needs Chrome) |
| 12 | Resilience / chaos | **live updates done**: manifest-only polls, invalid data kept off screen ("delayed — retrying"), pause toggle, draft never polls, lazy reporting.json | `a11y/live-updates.spec.js` (Storage emulator URLs answered from goldens, no emulator needed) |
| 13 | Dependency & secret security | `npm audit` + gitleaks + osv-scanner in CI (Phase 0); ZAP in Phase 5 | `.github/workflows/ci.yml` |
| 14 | Load (k6) | Phase 5 | — |
| 15 | Staging smoke | Phase 5 | — |

## Oracles

| Oracle | Status | Proven by |
|---|---|---|
| 1. Python reference (`convert_data.py`) | goldens for 19 cases | `golden.test.js` (inputs sha256-pinned, `verify.py` passes, files consistent) |
| 2. `verify.js` re-parse | ready | `verify.test.js` (clean data passes; every kind of tampering fails), `fixes.test.js` (fixed pipeline passes verify on all cases) |
| 3. Generator model | ready (also drives the Node round trip) | `gen-fixture.property.test.js` (determinism, invariants, CSV round trip with wild names), `gen-fixture-oracle.test.js` (Python parser reads back every model number) |

## Golden cases (`functions/test/golden/<case>/`)

Each case holds `case.json` (inputs + sha256), `summary.json`, `reporting.json`, `precincts.json`, `data.js`,
`parsed-early.json` / `parsed-ed.json` (raw `parse_election_csv` output), and `verify.json` (legacy `verify.py` result).

| Family | Cases | Early slot | ED slot |
|---|---|---|---|
| `samples-92-*`, `samples-94-*` | 00-zero, 01-nh-abs, 02-ev | that file | — |
| | 03-5-reporting … 06-end-provisional | 02-After EV | that file |
| | 06-ed-only | — | 06-End of Provisional |
| `testfiles-*` | ev, ev-ed, ed-only | EV test | ED test |

**`Test_Files/` is the project's only source of test CSVs.** `Results/` is the legacy monitor's live drop folder, not test data.
`golden.test.js` fails if any CSV in `Test_Files/` is not used by a golden case.

Goldens are produced by the unchanged legacy `generate_data_js()` path and stored with LF endings.
If a fixture CSV changes, `golden.test.js` fails until `npm run golden` is re-run; CI also fails if the committed goldens are stale.

## Legacy defects — fixed in the Node port (Phase 1)

Each fix is a flag in `functions/src/parse.js` (`FIXES`, the default). `LEGACY` turns them all off and exists only so
`parity.test.js` can prove byte-identity with Python; `fixes.test.js` asserts every fix on its own against `LEGACY`.

| Id | Defect | Fix | Proven by |
|---|---|---|---|
| D1 | **Precincts-reporting overstated.** In an ED file every precinct with any cell (including `0`) was marked reported, so `03-After 5 Reporting` ("5 of 92") published **92 of 92**. | The export has no per-precinct flag. Per contest, a precinct has reported when its ED votes are not all zero **and** differ from its votes in the Early-slot file (early votes are already spread across precincts). Counts are the CSV's "R of T" as written. When R = T every precinct is reported. A contest where the inferred precincts ≠ R is listed in `diagnostics.reportingMismatches` (a check in Phase 2). Write-ins are not results and are ignored. | `fixes.test.js` › D1 (independent csv-parse oracle; inferred count = R in **every contest of every Test_Files ED export**), `roundtrip.property.test.js` (generated Early→ED pairs) |
| D2 | County and status read from column 4; the 8-column exports put them in column 7. | Last non-empty header cell after column 0. | `fixes.test.js` › D2 |
| D3 | **Precinct turnout stats empty for 5-column exports** (rows are 5 cells, 3 on later pages; the parser needed ≥ 6/7). | Row-length thresholds lowered to 3/4; 8-column results unchanged. | `fixes.test.js` › D3 (independent read of every sample's STATISTICS block), round trip (both layouts) |
| D4 | `lastUpdated` hardcoded to "November 5, 2024 08:45 PM". | Real time, America/New_York, same format; `dataVersion` still excludes it. | `fixes.test.js` › D4, dataVersion |
| D5 | Zero vs Early chosen by filename. | Explicit upload kind. | Phase 2 |

Port notes:
- `csv.js` is a port of CPython's `_csv` state machine, not csv-parse, so malformed exports read exactly as Python reads them
  (stray text after quotes, blank lines, unterminated quotes, `utf-8-sig` + `errors=ignore`, the 131,072-char field limit).
  It is also ~50× faster (5 MB in ~0.1 s). csv-parse remains as the independent reader inside tests.
- `pycompat.js` reproduces `str.strip`, `round(x, 2)` (half-even on exact ties), `repr(float)`, `int()`/`float()` of text
  (Unicode digits, underscores), code-point ordering and `json.dumps`, so outputs and `dataVersion` match byte for byte.
- Contest titles over 1,000 characters raise `ParseError` (the legacy dedupe regex would backtrack for minutes).
- Known parity gap, by design: a decimal vote cell ("12.0") prints as `12` in Node but `12.0` in Python. Phase 2 blocks
  non-integer counts.

Data notes for Phase 2 checks: `EV test.csv` has SODDY DAISY A with 0 registered voters and 25 ballots (the
"ballots > registered" block will fire on it); the 94-precinct samples list two PROPERTY RIGHTS precincts with 0 voters
and 0 ballots (left out of `precinctStats`, as in legacy, but present in contests and `masterPrecincts`).

Fixed in Phase 0 (Python): `verify.py` referenced an undefined `actual_votes` and the candidate-total check was mis-indented,
so every Zero/Early-only run crashed after writing outputs, and ED runs never checked candidate totals. All 19 golden
cases now pass `verify.py` with 0 failures.

## Requirement → test matrix

| Requirement | Test ids |
|---|---|
| Fixture CSVs are the ones the goldens were built from | `golden.test.js` › inputs exist and are unchanged |
| Every `Test_Files/` CSV is exercised | `golden.test.js` › every CSV in Test_Files/ is covered |
| Legacy pipeline output is self-consistent | `golden.test.js` › output files are mutually consistent |
| Generator is deterministic | `gen-fixture.property.test.js` › same seed and options |
| Generator never emits an impossible election (overvote, ballots > voters, duplicate names) | `gen-fixture.property.test.js` › model invariants hold |
| Generated CSV survives quotes, commas, unicode, `<script>`, BOM, CRLF/LF, page breaks, wrapped and side-by-side contests | `gen-fixture.property.test.js` › CSV round-trips |
| Generated CSV is a real Custom Table Report (reference parser reads it) | `gen-fixture-oracle.test.js` |
| Node port reproduces the Python pipeline byte for byte (legacy mode) | `parity.test.js` |
| Python built-ins re-implemented exactly (csv reader, clean_num, clean_contest_name, round, repr, json.dumps) | `pycompat.property.test.js`, `units.test.js` |
| Parse + merge reproduce any generated election, every fix on | `roundtrip.property.test.js` |
| Exactly the reported precincts are flagged, per contest; counts are the CSV's | `fixes.test.js` › D1, `roundtrip.property.test.js` |
| Malformed input never crashes or hangs; it reads as Python reads it | `fuzz.test.js` |
| verify.js fails on any tampered number, file or label | `verify.test.js` |
| Max precincts comes from the election and is published in `config.precinctCap` | `fixes.test.js` › precinctCap |
| Parse + merge + outputs + verify of the largest export < 1.5 s | `bench.test.js` |
| Tests catch injected bugs (mutation score ≥ 85 %) | `npm run mutation` (nightly) |
| Every check fires exactly when its condition holds; every check id has a test | `checks.test.js` (last test enumerates `CHECK_IDS`) |
| The real election night 00 → 06 produces no blocking check | `checks.test.js` › real election night |
| Pages never render invalid data; files the pages would reject are never published | `validate.test.js`, `checks.test.js` › output-invalid |
| Review shows current → draft → Δ for every contest and candidate; newly / no longer reporting precincts | `review.test.js` |
| Raw-source trace rows are the physical CSV lines | `review.test.js` › trace |
| Publish refused when blocked, unacknowledged, stale, expired, wrong typed count, or a draft object changed | `publish.test.js`, `service.test.js` |
| Copy order: archive, data files, summary, manifest last (written at publish) | `publish.test.js` › copy plan, `service.test.js` › full night |
| Concurrent publishes: exactly one wins; the lease is released on failure and expires | `service.test.js`, `test/emulator/integration.test.js` |
| Rollback goes through a draft and the same publish path | `service.test.js` › rollback |
| Live check fails when the public URL serves other bytes; auditLive detects drift | `service.test.js` |
| Upload limits: 5,000,000 characters, gzip bombs refused, same hash for text and gzip | `publish.test.js` › upload |
| Election settings validated with the fix in the message (max precincts 1–999) | `service.test.js` › settings |
| Non-admins read nothing; admins never write; the private bucket denies all clients | `test/emulator/rules.test.js` |

