# Performance baseline — public pages

Plan: `plans/cloud-admin-upload.md` → **Performance requirements**. Reference profile: Lighthouse 12.8.2 mobile
defaults (Moto G Power class, 4× CPU slowdown, Slow 4G simulated throttling). Median of 3 runs per page.
Measured 2026-10-21 on a Windows 11 workstation with Chrome 155, against the committed root data files
(`./summary.json` etc., the "State & Federal Primary" legacy export).

Re-run: `npm run perf` (this tree), or `node perf/lighthouse.mjs <dir>` for another checkout.
`perf/lighthouse.mjs` serves the files gzip-compressed, as GitHub Pages and the GCS bucket (gzip transcoding) do.

## Budgets (release blockers)

LCP < 2.5 s · TBT < 200 ms · CLS < 0.1 · own JS ≤ 60 KB gzip, no Firebase SDK · ≤ 1 KB per poll when nothing changed.

## Before Phase 4 (commit 6ef169b: `data.js` preloaded by every page)

| Page | Score | FCP | LCP | TBT | CLS | Transfer |
|---|---|---|---|---|---|---|
| index.html | 100 | 1.13 s | 1.20 s | 0 ms | 0.038 | 57 KB |
| reporting.html | 100 | 1.09 s | 1.20 s | 0 ms | 0.043 | 56 KB |
| precincts.html | 100 | 1.13 s | 1.20 s | 0 ms | 0.025 | 56 KB |
| scrolling.html | 89 | 1.11 s | 1.20 s | 0 ms | **0.224** | 55 KB |

Own JS (gzip): 19.6 KB. Budget miss: `scrolling.html` CLS (the ticker grows when its values arrive and pushes
the slide down). Served **without** compression, LCP was 2.85 s on every page (`data.js` is 271 KB raw).

## After Phase 4 (pages fetch their own JSON; `results-config.js` starts the requests from `<head>`)

| Page | Score | FCP | LCP | TBT | CLS | Transfer |
|---|---|---|---|---|---|---|
| index.html | 100 | 0.90 s | 1.35 s | 0 ms | 0.031 | 58 KB |
| reporting.html | 100 | 0.91 s | 1.36 s | 0 ms | 0.025 | 60 KB |
| precincts.html | 100 | 1.11 s | 1.35 s | 12 ms | 0.000 | 62 KB |
| scrolling.html | 100 | 1.07 s | 1.35 s | 0 ms | 0.012 | 58 KB |

Own JS (gzip): 24.3 KB (`app.js`, `results-config.js`, `functions/src/validate.js`). All budgets met.

What changed for performance:
- `data.js` (271 KB raw) is no longer loaded; each page fetches only its file(s). It stays as the error fallback.
- `results-config.js` runs in `<head>` and starts the data requests (and `manifest.json`) before `app.js` arrives.
- CLS: the live-status line reserves its height; the slideshow ticker values keep a minimum width. On phones the
  slideshow scrolls instead of clipping (1.4.10), with its controls above the slide so slide changes never move them.
- Polling (bucket mode): `manifest.json` only, under 1 KB, every 60 s; the page's JSON is fetched only when
  `dataVersion` changes; no polling while the tab is hidden, paused, or in a draft view.
- A live update on the summary page replaces only the changed contest cards.
- `content-visibility: auto` was tried on the contest cards and removed. Its placeholder heights made "Jump to
  contest" and `#contest` links land hundreds of pixels off target, and the measurements above are the same
  without it.
- Searches are debounced 150 ms; the precinct pickers are built with a `DocumentFragment`.

LCP is now the hero heading, painted when the data arrives, so it moved from 1.20 s to 1.35 s; it stays well
inside the 2.5 s budget. Served **without** compression (a plain local server), LCP is 2.40–2.56 s, so
`reporting.html` (two files) and `precincts.html` (150 KB raw) would miss the budget there. Production serves gzip.

## admin.html / review.html (signed-out first paint, `npm run perf:admin`)

Budgets: LCP < 3.0 s, TBT < 300 ms, CLS < 0.1, own JS <= 80 KB gzip, plus the Firebase SDK.

| Page | Score | FCP | LCP | TBT | CLS | Transfer |
|---|---|---|---|---|---|---|
| admin.html | 98 | 0.90 s | 2.41 s | 0 ms | 0.000 | 171 KB |
| review.html | 98 | 0.90 s | 2.41 s | 0 ms | 0.000 | 174 KB |

Own JS (gzip, excluding the Firebase compat SDK from gstatic): 17.6 KB. All budgets met.

Most of the transfer is the Firebase SDK. The signed-in screens are not measured by Lighthouse; their
accessibility is checked by `npm run a11y:admin`.

## Not yet covered

- Long tasks during a live refresh are measured by `a11y/refresh-longtasks.spec.js`. It is timing-dependent, so it
  runs only on request:

  ```
  PERF=1 npx playwright test --config a11y/playwright.config.js --workers=1 refresh-longtasks
  ```

  Add `STRICT=1` to fail on a long task. The test sets up a full refresh where every one of 63 contests changes
  (sample 02 → 05), with 4× CPU throttling (checked: a fixed loop runs 29 ms → 125 ms) at 412 px.
  - **Result: no long task over 50 ms on the summary, reporting or precinct page**, in every run.
  - An injected 80 ms task is reported, so the observer works.
  - Correction: an earlier draft of this file reported 50–90 ms long tasks. That came from a throwaway script that
    began measuring before the first render had settled. Measured properly, the commit before the batching and
    formatter changes also shows none.
  - The summary cards, reporting rows and by-precinct cards are swapped per changed item, in batches of 8 with
    `scheduler.yield()`, using one cached `Intl.NumberFormat`.
  - A desktop CPU throttled 4× is not a real phone: run the manual checklist on devices.
- `<link rel="preconnect">` to `storage.googleapis.com`: add in Phase 5 together with `PUBLIC_BASE`.
- Lighthouse is not in CI yet (it needs Chrome and is noisy on shared runners); run it before a release.
