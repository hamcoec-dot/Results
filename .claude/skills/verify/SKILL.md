---
name: verify
description: The done gate. Run before calling any change done. It covers tests, build and lint this session, a real walkthrough of the user flow at phone widths, then review.
---

# Verify before "done"

No proof, no done. Do every step in this session; evidence from an earlier session does not count. Use the `tests` agent (Haiku) for the runs and report its exact output.

## 1. Tests, build and lint (all must pass)
- `cd functions && npm ci && npm run test:pr` (always: coverage gates included)
- `npm run assets:check` and `npm run lint:html`
- `npm run a11y` (public pages, Chromium)
- Changed `admin.html`, `review.html`, `admin*.js`, `review.js`, `admin.css` or anything in `functions/`? Also run `npm run a11y:admin`, and `cd functions && npm run test:emulator` for changes in `functions/`.
- A failing test: fix the cause. Never delete, skip or weaken a test to get green. A flaky test gets fixed, not rerun until green. If the same error happens twice, stop and send the error history to the Reviewer thread; no blind third try.

## 2. Real walkthrough, including phone widths
- Public page change: always run the phone projects: `npm run e2e:browsers` (Pixel 7 and iPhone 14, plus Firefox and WebKit), including `a11y/mobile-layout.spec.js`.
- Open the changed flow in Chromium at 320, 375 and 1280 px (Playwright; screenshots at deviceScaleFactor 1) and click through it the way a person would: the page loads, the change is visible, nothing overlaps or scrolls sideways, the toolbar and tables still fit. Save the screenshots as evidence (scratchpad or project files).
- Also check with the WCAG text-spacing styles when a toolbar or table changed (a11y/public-pages.spec.js does this).
- New public page or filename: it is listed in `404.html` and in the Playwright BEHAVIOUR list (a11y/playwright.config.js).

## 3. Review
- The `reviewer` agent (Opus, read-only) is an extra pre-check only. The Reviewer thread's verdict is still required: send it the diff and the test output, and wait for "VERDICT approve".
- Anything else the work needs a verdict for (plans, repeated errors, live-run previews) also goes to the Reviewer thread.

## 4. Report
State the commands run with their pass/fail counts, the walkthrough evidence (widths checked, screenshots), and the Reviewer's verdict. Without all of it, it is not done.
