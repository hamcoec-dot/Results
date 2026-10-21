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
npm run golden           # regenerate Python golden outputs (needs Python 3)
```

Replay a fast-check failure: `FC_SEED=<seed> FC_PATH=<path> npm test` (both are printed on failure).
Generate a fixture by hand: `node tools/gen-fixture.js --seed 42 --kind ed --layout wide --names wild --out x.csv`.

## Test layers — status

| # | Layer | Status | Where |
|---|---|---|---|
| 1 | Unit (`node:test` + `c8`) | harness ready (Phase 0); suites land with each module | `functions/test/*.test.js`, `functions/.c8rc.json` |
| 2 | Reference parity | golden outputs ready (Phase 0); `parity.test.js` in Phase 1 | `tools/make_golden.py`, `functions/test/golden/` |
| 3 | Property-based | harness + generator ready (Phase 0); parser round trip in Phase 1 | `tools/gen-fixture.js`, `functions/test/helpers/arbitraries.js` |
| 4 | Fuzz / malformed | Phase 1 | — |
| 5 | Mutation (Stryker) | Phase 1 | — |
| 6 | Security rules | Phase 2 | — |
| 7 | Function integration | Phase 2 | — |
| 8 | E2E + DOM oracle | Phase 4 | — |
| 9 | Visual regression | Phase 3/4 | — |
| 10 | Accessibility | Phase 3/4 | — |
| 11 | Performance | Phase 3/4 | — |
| 12 | Resilience / chaos | Phase 4 | — |
| 13 | Dependency & secret security | `npm audit` + gitleaks + osv-scanner in CI (Phase 0); ZAP in Phase 5 | `.github/workflows/ci.yml` |
| 14 | Load (k6) | Phase 5 | — |
| 15 | Staging smoke | Phase 5 | — |

## Oracles

| Oracle | Status | Proven by |
|---|---|---|
| 1. Python reference (`convert_data.py`) | goldens for 19 cases | `golden.test.js` (inputs sha256-pinned, `verify.py` passes, files consistent) |
| 2. `verify.js` re-parse | Phase 1 | — |
| 3. Generator model | ready | `gen-fixture.property.test.js` (determinism, invariants, CSV round trip with wild names), `gen-fixture-oracle.test.js` (Python parser reads back every model number) |

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

## Legacy defects — the Node port must fix these (parity tests exclude them and assert the fix separately)

| Id | Defect | Evidence | Pinned by |
|---|---|---|---|
| D1 | **Precincts-reporting overstated.** In an ED file every precinct with any cell (including `0`) is marked reported, so `03-After 5 Reporting` ("5 of 92 Precincts Reporting") publishes **92 of 92**. Port must honour the CSV's "R of T". | golden `samples-92-03-5-reporting` | `gen-fixture-oracle.test.js` "D1 legacy behaviour" |
| D2 | County and status read from column 4; the 8-column exports put them in column 7 (`convert_data.py:55-56`). | wide-layout oracle case with county "Marion" | `gen-fixture-oracle.test.js` "D2 legacy default" |
| D3 | **Precinct turnout stats empty for 5-column exports.** The STATISTICS rows are 5 cells (first page) or 3 cells (later pages); the parser needs ≥ 6/7, so `precinctStats` is `{}` for every general-election sample. | goldens `samples-*` (`precinctStats` empty) | `gen-fixture-oracle.test.js` (narrow → `{}`) |
| D4 | `lastUpdated` hardcoded to "November 5, 2024 08:45 PM" (`convert_data.py:524`). | every golden | Phase 1 parity ignores `lastUpdated` |
| D5 | Zero vs Early chosen by filename. | `generate_data_js` | replaced by explicit upload kind (Phase 2) |

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
