# Manual performance checklist

Run before each election (plan: Verification › Manual performance checklist). `npm run perf` (Lighthouse vs the
budgets) and `npm run a11y` (live-update tests: under 1 KB per unchanged poll, no requests from a hidden tab, keyed
updates) cover the automated part. Baseline and known gaps: [BASELINE.md](BASELINE.md).

## Devices
- [ ] A real mid-range Android phone (Moto G Power class) on cellular data.
- [ ] An iPhone on cellular data.

## Flows
- [ ] Public pages load in under about 2.5 s to the first numbers, with no visible jumping as the numbers arrive.
- [ ] The full review → publish flow on a phone (admin + review pages).
- [ ] Scrolling the review page and the precinct page (By Contest table): no visible jank.
- [ ] Leave each public page open for 30 minutes through several publishes, then check that:
  - [ ] it updates within about 60 s of each publish;
  - [ ] memory stays stable (Chrome Task Manager);
  - [ ] the page stays responsive;
  - [ ] the "Results updated" time moves.
- [ ] Switch to another tab for a few minutes. DevTools › Network shows no requests while hidden and one manifest
      check on return.
- [ ] "Pause live updates" on: no requests until it is turned off.

## Election-night readiness (Phase 5)
- [ ] About 1,000 concurrent `manifest.json` fetches (`npx autocannon`) against the bucket URL: p95 < 300 ms, no
      errors, `Age` and `Cache-Control` headers present.
- [ ] `curl -I` on `current/summary.json`: `Cache-Control: public, max-age=15`, `Content-Encoding: gzip`, CORS for
      the Pages origin.

## Runs
| Date | Who | Device / network | Result / issues |
|---|---|---|---|
| | | | |
