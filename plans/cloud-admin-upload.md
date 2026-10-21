# Plan: Cloud Admin Upload for Election Night Results

## Context
Today results publish by dropping CSVs into `Results/` on a local machine. `server_monitor.py` notices the change and runs `convert_data.py` (plus `verify.py`), which writes `data.js`, `summary.json`, `reporting.json` and `precincts.json` next to the pages. That ties publishing to one PC and a file share. It also has known defects:
- Files are classified by filename, and the "ZERO" file can win over `Early Votes.csv`.
- `lastUpdated` is hardcoded to "November 5, 2024 08:45 PM".
- County and status are read from column 4, but the 8-column exports put them in column 7.

**Goal:** an authenticated admin page where an admin picks the CSV for each stage (Zero, Early/ABS, Election Day), previews the parsed and verified result, and publishes it to the public results pages. This follows BarcodeScan's ("Multi-seal delivery") pattern:
- Static pages on GitHub Pages.
- Firebase email/password auth with an `admins/{uid}` allowlist.
- Node 22 v2 callable functions in us-east1 that do every write.
- Upload creates a frozen **draft**. A human reviews that draft in depth: numbers, diffs, and the real public pages rendered from the draft. Publishing pushes exactly the reviewed bytes, so nothing is re-parsed at publish time. See **Robust review before publish** below.

**Decisions made:**
- **Hosting:** GitHub Pages plus Firebase, as in BarcodeScan.
- **Parser:** port `convert_data.py` and `verify.py` to Node.
- **Project:** a new Firebase project on the Blaze plan. Working id is `hcec-election-results`; confirm it at setup.
- **Uploads:** the admin picks the upload type explicitly. Every upload is archived, and rollback is one click.
- **Review gate:** a single admin reviews and publishes; no second approver is required. There is no hand-typed control total. Instead, every check below must be passed or explicitly acknowledged. Drafts are served from the public bucket under unguessable links: get-only, no listing, deleted after 48 h.
- **Mobile and WCAG 2.1 AA (project-wide requirement):** every page, new and existing, must be mobile-friendly and WCAG 2.1 AA compliant. That covers the public pages, `admin.html`, `review.html`, and the draft pages. See **Mobile & accessibility requirements**. A failure is a release blocker.
- **Fast and responsive (project-wide requirement):** no page may hang, freeze, or lag noticeably, including on mid-range phones over 4G and on election-night traffic spikes. Performance budgets are release blockers. See **Performance requirements**.
- **Comprehensive testing (project-wide requirement):** layered automated testing runs in CI on every change, backed by a staging project, rehearsals, and live monitoring on election night. No layer is optional. See **Test strategy**.
- **Election parameters:** the admin page sets the per-election settings (name, date, county, max precincts, precinct-page toggle) on the same page as the uploads. Max precincts (today the constant 92) becomes an admin field with a default of 92. The pipeline reads it from the election doc.

## Architecture
```
Admin (admin.html on GitHub Pages)
  └─ Firebase Auth (email/password) ─ admins/{uid} allowlist
  └─ callable createDraft({electionId, kind, filename, csv})
        Node 22 v2 function (us-east1)
        ├─ parse.js / merge.js / outputs.js / verify.js / checks.js / review.js
        ├─ archives raw CSV → private bucket  uploads/{eid}/{uploadId}.csv
        ├─ writes draft outputs → PUBLIC bucket drafts/{draftId}/…  (draftId = 128-bit random; 48 h lifecycle)
        │    (incl. review.json + trace.json, gzipped)
        └─ Firestore elections/{eid}/drafts/{draftId} (status, checks, output sha256s)
  └─ admin reviews: review.html?draft=… + index/reporting/precincts/scrolling.html?draft=… (red DRAFT banner)
  └─ callable publishDraft({electionId, draftId, acknowledgements[], baseVersion})
        ├─ re-hashes draft objects == stored sha256s; baseVersion == election.currentVersion
        ├─ copies drafts/{draftId}/* → elections/{eid}/v/{dataVersion}/  then → current/*
        ├─ Firestore versions/*, audit/*
        └─ post-publish self-check: re-reads current/summary.json via public URL, compares sha256
Public pages (index/reporting/precincts/scrolling on GitHub Pages)
  └─ app.js polls current/manifest.json every 60 s (paused while hidden); fetches page JSON only when dataVersion changes
```
**Why a separate public bucket:** public JSON lives in its own bucket, with `allUsers` granted **`roles/storage.legacyObjectReader`** and CORS set. That role allows reading an object but not listing the bucket, so draft paths cannot be discovered. The bucket also has a lifecycle rule that deletes objects with prefix `drafts/` after 2 days. Public objects are served through the Google CDN. Raw uploads stay in the private Firebase default bucket, which only the admin SDK touches. Objects under `current/` get `Cache-Control: public, max-age=15` so the edge can't serve stale numbers. Versioned objects get `max-age=31536000, immutable`.

## Firestore schema
| Path | Fields | Rules |
|---|---|---|
| `admins/{uid}` | email, added | user reads own; no writes (Console only) |
| `elections/{eid}` | name, date, county, precinctCap (admin-set integer 1–999, default 92), active, enablePrecinctResults, selectedEarlyUploadId, selectedEdUploadId, currentVersion, updatedAt/By | admin read; no client writes |
| `elections/{eid}/uploads/{uploadId}` | kind (`zero`\|`early`\|`ed`), filename, sha256, size, storagePath, uploadedAt/By, parseSummary {title, date, contests, precinctsReporting, totalBallots}, warnings[] | admin read |
| `elections/{eid}/drafts/{draftId}` | status (`ready`\|`blocked`\|`published`\|`discarded`\|`stale`), kind, uploadId, earlyUploadId, edUploadId, baseVersion, dataVersion, outputSha256 {file: hash}, checks [{id, severity `block`\|`warn`\|`info`, title, detail, refs}], expiresAt, createdAt/By (the review payload lives in `drafts/{draftId}/review.json` and `trace.json`, not in Firestore), publishedAt/By, acknowledgements [{checkId, by, at}] | admin read |
| `elections/{eid}/versions/{dataVersion}` | draftId, earlyUploadId, edUploadId, publishedAt/By, verify {pass, fail, failures[]}, acknowledgements, publicPath, liveCheck {ok, at} | admin read |
| `audit/{autoId}` | action (`draft`, `publish`, `discard`, `rollback`, `settings`), eid, draftId/version, uid, email, at, detail | admin read |

`zero` and `early` both fill the "early" slot that `merge_parsed_data` takes, and `ed` fills the ED slot. Publishing an `early` upload keeps the currently selected ED upload, and the reverse. This replaces the filename rule.

## Cloud Functions (`functions/src/index.js`, all `onCall`, `requireAdmin` copied from BarcodeScan `functions/src/index.js:15-28`)
- **`upsertElection({id, name, date, county, precinctCap, enablePrecinctResults, makeActive})`** creates or edits the election. `makeActive` deactivates the other elections, as BarcodeScan's import does.
- **`createDraft({electionId, kind, filename, csv})`**: options `{memory:'1GiB', timeoutSeconds:120}`, CSV capped at 5,000,000 chars.
  1. Archive the CSV and write the upload doc. Every upload is kept, even ones that are never published.
  2. Parse the CSV. Merge it with the other slot's selected upload, loaded from the private bucket. Build the outputs with `outputs.js`.
  3. Run `verify.js` and `checks.js` (the full list is below). Any `block` check sets the draft status to `blocked`.
  4. Build the review payload with `review.js`: a full diff against the outputs of `currentVersion`.
  5. Write the outputs, plus `review.json` and `trace.json`, to `drafts/{draftId}/` in the public bucket. They are gzipped with `Cache-Control: no-store`, and their sha256s are stored.
  6. Return `{draftId, status}`. The draft can never be changed. A new file means a new draft.
- **`publishDraft({electionId, draftId, acknowledgements, baseVersion})`**: this is the only path to `current/`. It is serialized by the `publishLock` transaction lease described in **Test strategy**. It refuses when any of these hold:
  - the draft is not `ready`;
  - any `block` check exists;
  - any `warn` check has no acknowledgement;
  - `baseVersion` differs from `election.currentVersion`, because someone published in between. The draft is marked `stale` and must be re-created.
  - the draft is older than 2 h;
  - any re-hashed draft object differs from its stored sha256.

  When none hold, it copies the objects as they are into `elections/{eid}/v/{dataVersion}/` and then over `current/*`. The file order is fixed: `precincts`, `reporting` and `data.js` in parallel, then `summary.json`, then `manifest.json` last, because the pages poll `manifest.json` for `dataVersion`. It then writes the versions doc, the audit entry, and `election.currentVersion`. Last, it runs the **live check**: it fetches `https://storage.googleapis.com/<bucket>/current/summary.json?t=…` and compares its sha256. The result is returned and stored as `liveCheck`.
- **`extendDraft({electionId, draftId})`** re-checks the hashes and `baseVersion`, then resets the 2 h expiry. This meets WCAG 2.2.1 Timing Adjustable.
- **`discardDraft({electionId, draftId})`** sets the status to `discarded` and deletes the draft objects.
- **`createRollbackDraft({electionId, version})`** builds a draft from a stored version. It gets the same review screen and the same `publishDraft` path, and its diff shows what will revert. There is no blind rollback.
- **`upsertElection`** changes to settings that touch the outputs (max precincts, precinct-page toggle) do not change the public pages directly. The admin page offers "Create draft with new settings", which rebuilds from the selected uploads, goes to review, and is then published.

Run `setGlobalOptions({region:'us-east1', maxInstances:10})`. After the first deploy, grant each v2 service `roles/run.invoker` to `allUsers`. That is the same gotcha as BarcodeScan, and the new project needs the same org-policy override.

## Robust review before publish
Principle: **the reviewer sees exactly what the public will see, plus every number that changed, before anything goes live.** Nothing is re-derived between review and publish.

### Automated checks (`functions/src/checks.js`)
Each check returns `{id, severity, title, detail, refs}`, where `refs` points at the contests and precincts involved so the review screen can link to them.
- **Block: Publish is impossible.** The admin must fix the file and upload again.
  - Any `verify.js` FAIL. That module re-parses the totals independently and cross-checks them against the per-precinct sums.
  - The CSV is not a Custom Table Report (header row 0 is wrong), or has no contests, or the STATISTICS block is missing.
  - The election date in the CSV differs from the election settings.
  - Precincts reporting is greater than max precincts.
  - A precinct has more ballots cast than registered voters.
  - A contest's votes are greater than ballots × vote-for. This is an overvote at the contest level and means the parse or file is wrong.
  - A candidate's votes are below 0, or a value that should be a number is not.
  - `kind=zero` and any vote or ballot count is greater than 0.
- **Precinct-reporting mismatch (warn, user decision 2026-10-21):** `merge.js` lists in `diagnostics.reportingMismatches` any contest whose reported precincts (ED votes non-zero and changed vs the Early file) don't add up to the CSV's "R of T". Never seen in the real exports. The warning must be acknowledged; the CSV's count is what publishes.
- **Warn: must be acknowledged one by one.** Each warning has its own checkbox, and the acknowledgements are stored with the version.
  - The title differs from the election name. Wording often drifts, so this only warns.
  - The number of precincts in the file differs from max precincts. It warns rather than blocks until real exports confirm that the STATISTICS rows hold only real precincts.
  - Precincts reporting went down compared with current.
  - Any candidate total, any contest total, or total ballots went down compared with current.
  - A contest or candidate was added or removed compared with current.
  - The leader changed in any contest. These are listed, which matters most in close races.
  - A contest margin is under 0.5 % or under 10 votes. It is listed as close, to draw attention.
  - `kind=ed` with 0 precincts reporting, or `kind=early` with precincts reporting greater than 0.
  - The same file (sha256) was already uploaded for this election, or this draft's `dataVersion` equals the current one (no change).
  - Turnout is above 100 % or a precinct's turnout is above 95 %.
  - The status label in the CSV (e.g. "UNOFFICIAL RESULTS") changed from current.
  - The file's export time is older than the last published file. This applies when the export carries a timestamp; otherwise it uses the upload file's lastModified, which the browser sends.
- **Info:** counts of what changed, so the admin can read the size of the update at a glance.

### Review payload (`functions/src/review.js`, written to `drafts/{draftId}/review.json` and `trace.json`)
- **File identity:** filename, size, sha256, the file's lastModified from the browser, the upload time, the uploader, and the kind. Next to them, the CSV header values (title, date, county, status) beside the election settings, with each mismatch highlighted.
- **Headline:** precincts reporting N of max, registered voters, ballots cast and turnout %. Each shows **current → draft → Δ**.
- **Every contest, not a sample:** for each candidate, the current votes, draft votes, Δ, current %, draft %, and leader. Rows that went down are red, leader changes are flagged, close races are flagged, and the contest's precincts reporting is shown as current → draft.
- **Precincts:** which precincts newly reported, and which stopped reporting (red). For each changed precinct: registered, ballots and turnout as current → draft.
- **Raw-source trace:** for any contest, the actual CSV rows and line numbers the parser read for its Totals row and its precinct rows. The reviewer can match them against the tally system's printed report.
- **Untouched slot:** which upload fills the other slot (Early or ED), with its filename and time, so a stale early file can't slip by unnoticed.

### Review screen (new `review.html` + `review.js`, opened from admin.html after an upload)
1. **Status bar:** the draft id, the base version, the count of `block`, `warn` and `info` checks, and a countdown to the 2 h expiry.
2. **Checks panel:** blocks are red, and while any exist there is no Publish button. Each warning has a checkbox and a "show me" link that scrolls to the referenced contest or precinct.
3. **Headline and file identity**, laid out as in the payload above.
4. **Contest diff table:** every contest, with a filter (changed only / leader changes / decreases / close races / all) and a search box. Clicking a contest opens its raw-source trace.
5. **Precinct diff table** with the same filters.
6. **Side-by-side rendered preview:** buttons that open `index.html`, `reporting.html`, `precincts.html` and `scrolling.html` with `?draft=<id>`. Each is the real page, rendered from the draft files, with a fixed red **"DRAFT — NOT PUBLIC — <draftId>"** banner and polling turned off. There is also an inline iframe of `index.html?draft=` beside an iframe of the live `index.html`, for an at-a-glance before/after.
7. **Pages viewed:** each preview button records that it was opened, and Publish stays disabled until all four pages (or three, when the precinct page is disabled) have been opened.
8. **Publish:** enabled only when there are no blocks, every warning is acknowledged, the preview pages have been viewed, and the draft is fresh. Clicking it opens a confirm modal with the one-line summary ("Publish ED update: 47 → 63 of 92 precincts, 12 contests changed, 1 leader change"). The admin types the number of precincts reporting shown there to confirm. That is the one typed value, and it proves the admin read the summary. Then `publishDraft` runs.
9. **After publish:** the page shows the live-check result. **Green** means `current/summary.json` matches by sha256. **Red** means it does not, and the page shows instructions to roll back or retry.
10. **Discard draft** button.

### `app.js` draft mode
When `?draft=<id>` is present:
- `RESULTS_BASE_URL` becomes `…/drafts/<id>/`;
- the 60 s auto-refresh is turned off;
- the banner is injected and the tab title gets the prefix `[DRAFT] `;
- the CSV/print export filenames get the prefix `DRAFT_`.

`?draft` is accepted only as a 32-character hex value.

## Mobile & accessibility requirements (WCAG 2.1 AA, all pages)
Applies to `index.html`, `reporting.html`, `precincts.html`, `scrolling.html`, `admin.html`, `review.html`, and every `?draft` view. Build mobile-first: base CSS targets a 320 px viewport, and breakpoints add layout for wider screens. Shared tokens and components go in `styles.css` so the admin and review pages match the public pages.

**Layout and responsiveness**
- `<meta name="viewport" content="width=device-width, initial-scale=1">` and never disable zoom (1.4.4).
- No horizontal page scroll at 320 CSS px or at 400 % zoom (1.4.10).
  - Wide data tables (the contest diff, precinct diff and history tables) sit in a scroll container: `<div role="region" aria-labelledby=… tabindex="0">`, with a sticky first column. Data tables are allowed to scroll in two dimensions under 1.4.10.
  - Below 640 px, the contest diff switches to stacked cards (one per contest, with candidate rows inside), so the review can be done on a phone.
- Works in both portrait and landscape (1.3.4).
- Text spacing overrides don't clip or overlap content (1.4.12). Use no fixed heights on text containers.
- The DRAFT banner is sticky only at heights of 500 px or more. Below that it scrolls with the page, so it never covers content at high zoom or in landscape.
- The side-by-side draft and live iframes stack vertically below 900 px. Each iframe has a `title`.
- Touch targets are at least 44×44 px, with 8 px between adjacent controls. WCAG 2.1 AA doesn't require this, but it is the project standard for mobile use.

**Perceivable**
- Contrast: 4.5:1 for text and 3:1 for UI component boundaries, focus rings and chart bars (1.4.3, 1.4.11). The red, amber and green status colors are checked in both their light and dark backgrounds.
- **Colour is never the only signal (1.4.1):**
  - checks carry an icon and a text label, "BLOCKED", "WARNING" or "INFO";
  - decreases show "▼ −120 (decrease)";
  - leader changes carry a "Leader changed" text badge;
  - party is shown as text, not only as a color.
- Charts and progress bars have adjacent text values. Purely decorative SVGs get `aria-hidden="true"` (1.1.1).
- Semantics (1.3.1):
  - data tables use `<caption>` and `<th scope>`;
  - headings follow a logical h1→h2→h3 order;
  - landmarks are `header`, `nav`, `main` and `footer`;
  - the upload kind radios sit in a `fieldset` and `legend`.
- The sign-in inputs use `autocomplete="email"` and `autocomplete="current-password"` (1.3.5).

**Operable**
- Everything works by keyboard (2.1.1) with no keyboard traps (2.1.2). That includes:
  - the filters;
  - the warning checkboxes;
  - the "show me" links, which move focus to the target contest heading;
  - the raw-source trace disclosure (`<details>`/`<summary>`, or a button with `aria-expanded`);
  - the publish modal, built on a native `<dialog>` that traps focus, closes on Esc and returns focus to the trigger.
- Every page starts with a "Skip to main content" link (2.4.1). Each page has its own `<title>`, for example "Review draft a1b2… – Election Admin" (2.4.2). Focus order follows the reading order (2.4.3). A visible focus ring of at least 2 px with 3:1 contrast is drawn on every control (2.4.7).
- Links that open the draft pages in a new tab say so in their visible text or accessible name (3.2.5 is AAA, but the project follows it).
- **Timing (2.2.1):**
  - the review page warns, through a polite live region, when 10 minutes and again when 2 minutes remain on the 2 h draft expiry;
  - an **"Extend draft"** button calls the new callable `extendDraft`, which resets the expiry after re-checking the hashes and `baseVersion`;
  - the countdown text is not announced every second.
- **Auto-updating public content (2.2.2):**
  - public pages get a visible **"Pause live updates"** toggle for the 60 s refresh, and `scrolling.html` gets a pause/play control for its slideshow. Both are reachable by keyboard and remember their state for the session;
  - a re-render keeps the user's focus and scroll position and never moves focus;
  - a polite `aria-live` status says "Results updated 9:42 PM". The tables themselves are not live regions;
  - `prefers-reduced-motion` turns off slideshow transitions and animated bars.
- Nothing flashes more than 3 times a second (2.3.1).

**Understandable**
- `<html lang="en">` on every page (3.1.1).
- Form errors are identified in text next to the field, linked with `aria-describedby`, and the suggested fix is given (3.3.1, 3.3.3). Examples: "Max precincts must be a whole number from 1 to 999", and the typed-precinct mismatch on publish.
- **Error prevention (3.3.4):** the draft → review → acknowledge → typed confirmation flow is how the site meets this criterion for publishing data. The same applies to rollback and discard, which both use a confirm dialog.
- Navigation and the order of the admin and review sections are consistent from page to page (3.2.3).

**Robust**
- Use valid HTML and native controls first. ARIA is used only where no native element fits (4.1.1, 4.1.2).
- **Status messages (4.1.3):** upload progress ("Processing file…"), draft created, publish in progress, the live-check result (green or red), session sign-in errors, and "Results updated" on the public pages are all announced through `role="status"`, or `role="alert"` for failures, without moving focus.

**Existing public pages:** Phase 4 starts with a baseline audit of the current `index.html`, `reporting.html`, `precincts.html`, `scrolling.html` and `styles.css`, using axe plus a manual pass. Every AA violation is fixed in that phase, not deferred.

## Performance requirements (all pages, all devices)
Reference device: a mid-range Android (Moto G Power class), emulated in Lighthouse as **mobile, 4× CPU slowdown, Slow 4G**.

**Budgets (release blockers)**
| Metric | Public pages | admin.html / review.html |
|---|---|---|
| LCP | < 2.5 s | < 3.0 s |
| INP / any interaction (filter, tick, toggle, tab) | < 200 ms; target < 100 ms | < 200 ms |
| CLS | < 0.1 | < 0.1 |
| Total Blocking Time | < 200 ms | < 300 ms |
| Long tasks during a live auto-refresh | none > 50 ms (chunked) | n/a |
| JS shipped (gzip, excl. data) | ≤ 60 KB own code, **no Firebase SDK** | Firebase SDK + ≤ 80 KB own code |
| Data per poll when nothing changed | ≤ 1 KB (`manifest.json` only) | n/a |
| `createDraft` round trip (largest golden CSV, warm) | — | p95 < 5 s, with progress shown |
| `publishDraft` round trip | — | p95 < 3 s |

**Public pages**
- **Cheap polling:**
  - every 60 s, poll the tiny `current/manifest.json` (`{dataVersion, updatedAt}`);
  - fetch the page's own JSON (summary, reporting or precincts) only when `dataVersion` changes;
  - polling stops while the tab is hidden (`visibilitychange`) and resumes, with an immediate check, when the tab is visible again.

  This saves battery and data on phones, and cuts bucket egress on election night.
- **Small payloads:**
  - JSON is uploaded gzip-compressed (`Content-Encoding: gzip`, so GCS transcodes it for clients that can't accept gzip) and stays minified;
  - the `<script src="data.js">` tag is removed from the pages, so the full dataset no longer blocks first paint;
  - `data.js` is only the error fallback.
- **Fast first paint:**
  - the server does not render the page; it is static HTML;
  - `<link rel="preconnect">` to `storage.googleapis.com`;
  - scripts are `defer`;
  - system font stack, or `font-display: swap` with a preloaded subset;
  - skeleton placeholders with reserved heights, so numbers arriving cause no layout shift (CLS).
- **Rendering without jank:**
  - on refresh, update only the cells and bars whose values changed (keyed by contest and candidate) instead of rebuilding tables;
  - batch DOM writes in one `requestAnimationFrame`;
  - never interleave layout reads with writes;
  - build large lists (precincts × contests) with `DocumentFragment`;
  - render off-screen contest sections in chunks, yielding between chunks (`scheduler.yield()` with a `setTimeout(0)` fallback), and give them `content-visibility: auto` with `contain-intrinsic-size`;
  - search and filter inputs are debounced (150 ms) and run over precomputed lowercase indexes.
- **Animation:**
  - the slideshow and bars animate only `transform` and `opacity`;
  - no animation runs on scroll; scroll and touch listeners are `passive`;
  - `prefers-reduced-motion` turns animations off. This is also covered in the accessibility section.
- **Firebase stays off the public pages.** They make plain `fetch` calls to GCS and load no SDKs.
- **Phase 4 baseline:** before changing anything, profile the current `app.js` (1,700+ lines) on the reference profile, record its Lighthouse scores in `perf/BASELINE.md`, and fix whatever breaks the budgets.

**Admin and review pages**
- The Firebase compat SDK loads only on `admin.html` and `review.html`, with `defer`, and only the modules used (app, auth, firestore, functions).
- **Upload speed on mobile:** the CSV is gzipped in the browser with `CompressionStream`, base64-encoded and sent to `createDraft`, which gunzips it. A ~5 MB CSV becomes about 0.5 MB on the wire. Browsers without `CompressionStream` send it uncompressed. The sha256 is computed on the original text on both sides.
- **The review data is not stored in Firestore.** It is too large for Firestore's 1 MiB document limit and would be slow to read. `createDraft` writes these files to `drafts/{draftId}/`, gzipped and served from the CDN:
  - `review.json`: the headline, every contest diff and every precinct diff;
  - `trace.json`: the raw-source rows. It is fetched only the first time any trace is opened.

  The Firestore draft doc keeps only the status, the checks and the hashes. Both files are covered by the stored sha256s.
- **Review screen rendering:**
  - render the checks panel and headline first, so the reviewer can start reading at once;
  - render contest cards in chunks, yielding between them, with `content-visibility: auto`;
  - filters toggle CSS classes on rows that are already rendered, instead of re-rendering;
  - each warning tick updates only its checkbox and the Publish-enabled state;
  - the expiry countdown updates one text node once a second, using a timer that pauses while the tab is hidden.
- **Progress feedback:** every callable shows an immediate in-progress state (button disabled with a spinner and `role="status"` text) within 100 ms of the tap, so the UI never looks frozen. The default timeout of 120 s comes with a friendly retry message.
- **Cold starts:**
  - `createDraft`, `publishDraft` and `extendDraft` take `minInstances` from an environment parameter, `ELECTION_NIGHT_MIN_INSTANCES`, which is 0 normally and 1 on election night;
  - the README runbook covers turning it on and off;
  - the admin page also fires a no-op `ping` callable on sign-in to warm the instance.
- **Server-side speed:**
  - `publishDraft` uses GCS server-side `copy()` with no download or re-upload;
  - the `precincts`, `reporting` and `data.js` copies run in parallel, then `summary.json`, then `manifest.json` last. This replaces the earlier rule of `summary.json` last, because pages now poll `manifest.json`;
  - `createDraft` parses the CSV once and reuses the parsed rows for verify, checks, review and the outputs.

## Test strategy (public trust: every number shown must be provably the number in the file)
**Core guarantee:** for every published version, an automated test shows that each number rendered on each public page equals the corresponding number in the source CSV. Two other implementations confirm it independently: the Python reference and the verify re-parse. Every layer below runs in CI. Any failure blocks merging and deploying.

### Correctness changes this strategy adds to the design
- **Publishing is serialized:**
  - `publishDraft` takes a Firestore-transaction lease on `elections/{eid}.publishLock` that lasts 60 s, and checks `baseVersion` inside the transaction;
  - two simultaneous publishes give exactly one success and one `stale`.
- **Every output file carries `dataVersion`:**
  - `manifest.json` also lists the sha256 of each file;
  - the client renders only when every file it fetched shares the manifest's `dataVersion`. If they don't, for example because it read during the copy window, it waits 2 s and retries up to 3 times, and otherwise keeps showing the last good data.
- **Client-side validation (`validate.js`, shared by `app.js` and `review.js`):**
  - checks the shape and types of each JSON file and that numbers are finite and non-negative;
  - checks that candidate votes sum to the contest total, and that precincts reporting is no more than the total;
  - invalid data is never rendered. The page keeps the last good data and shows "Live updates delayed — retrying", announced through `role="status"`.
- **`dataVersion` is deterministic:** it is computed over the content with `lastUpdated` left out, so the same inputs always give the same version and the same bytes.
- **All untrusted text is rendered with `textContent`, never `innerHTML`.** Candidate, contest and precinct names come from the CSV. A meta Content-Security-Policy is added: `script-src 'self'` plus the pinned gstatic SDK on the admin and review pages only.

### Layers
| # | Layer | Tool | What it proves | Gate |
|---|---|---|---|---|
| 1 | Unit | `node:test` + `c8` | each function in parse, merge, outputs, verify, checks, review, validate and publish-logic | lines ≥ 95 %, branches ≥ 90 % on `functions/src` and `validate.js` |
| 2 | Reference parity | `tools/make_golden.py` + `parity.test.js` | Node output equals Python output on every real and sample CSV | exact match |
| 3 | Property-based / generative | `fast-check` | a **model → CSV → parse round trip**. The generator builds a random election (1–150 precincts, 1–60 contests, 1–12 candidates, vote-for 1–5, odd names with quotes, commas, unicode, `<script>`) and writes it as a Custom Table Report. Parse plus merge must reproduce the model exactly. Invariants: sums match, percentages total 100 ± 0.1, `dataVersion` is deterministic, merge(early, ed) is consistent, every check fires exactly when its condition holds. | 1,000 runs per PR, 100,000 nightly |
| 4 | Fuzz / malformed input | `fast-check` + a corpus | truncated files, BOM, CRLF and LF mixes, empty cells, a 5 MB limit, wrong export types, binary junk. The parser never throws uncaught, never hangs (per-case timeout 2 s), and either produces a `block` check or valid output. | 0 crashes |
| 5 | Mutation | **Stryker** (`@stryker-mutator/core`) on parse, merge, verify, checks and validate | the tests catch injected bugs, such as off-by-one errors, swapped candidates and a dropped precinct | mutation score ≥ 85 %, nightly and before release |
| 6 | Security rules | `@firebase/rules-unit-testing` against the emulator | non-admins can't read anything; admins can read but never write; nobody reads another user's `admins` doc; Storage denies all client access | every rule path covered |
| 7 | Function integration | `node:test` against the Auth, Firestore, Storage and Functions emulators | the full callable contract. It covers: auth and non-admin refusal; draft creation; every refusal reason in publish; **a tampered draft object in the Storage emulator gets refused**; stale baseVersion; expiry; extend; rollback; **concurrent publishes give exactly one winner**; copy order; the manifest written last; the audit trail written for every action | all pass |
| 8 | End-to-end | **Playwright** on Chromium, Firefox and WebKit, plus emulated Pixel 7 and iPhone 14, against the emulators | the full election night, 00 → 06: sign in, upload, review, acknowledge, publish, then the public pages. After every publish, the **DOM oracle** reads every contest, candidate, vote count, percentage and precincts-reporting value rendered on all four public pages and asserts each equals the number from the source CSV. It also covers: rollback; draft pages showing the banner; polling picking up a publish; the XSS candidate names rendering inert, with no dialog and no console error | all pass on all 5 profiles |
| 9 | Visual regression | Playwright `toHaveScreenshot` | public, admin and review pages at 320, 375, 768 and 1280 px with fixed fixtures and a frozen clock. Catches layout breaks, overlaps and truncated numbers. | reviewed baseline; diff ≤ 0.1 % |
| 10 | Accessibility | axe + manual checklist (see above) | WCAG 2.1 AA | 0 violations |
| 11 | Performance | Lighthouse CI + Playwright timings (see above) | the budgets | all budgets met |
| 12 | Resilience / chaos | Playwright `page.route` | the public page under offline, 404, 500, slow 10 s responses, truncated JSON, a manifest whose `dataVersion` mismatches the files, a clock skew, and the tab hidden for 2 h then shown. It never shows wrong or partial numbers, keeps the last good data, shows the "delayed" status, and recovers on its own. | all pass |
| 13 | Dependency and secret security | `npm audit --audit-level=high`, `osv-scanner`, `gitleaks`, OWASP **ZAP baseline** against staging | no known high or critical vulnerabilities, no committed secrets, no ZAP highs | 0 highs |
| 14 | Load | `k6` against the staging bucket | 2,000 virtual users polling `manifest.json` and each fetching changed data after a publish. p95 under 300 ms, 0 errors, CDN hits confirmed. Also 10 admin publishes in a row under load. | thresholds met |
| 15 | Staging smoke | Playwright subset against the **staging project** after each deploy | the real GCP: IAM, CORS, Cache-Control, gzip, lifecycle, and invoker grants are correct | must pass before the prod deploy |

### Fixtures and oracles
- Fixtures are the real sample CSVs in `Test_Files/` only (`EV test`, `ED test`, and `Web Results Samples` 00–06 in both 92 and 94 precincts; `Results/` is the live drop folder, not test data), plus generated elections from `tools/gen-fixture.js`. The generator uses a seed, so any run can be reproduced.
- There are **three independent oracles**:
  1. the Python reference (`convert_data.py`);
  2. `verify.js`, which re-parses the CSV a second way;
  3. the generator's own model, for layer 3.

  The E2E DOM oracle compares what is rendered against the CSV, not against our own JSON.
- `TESTING.md` is a traceability matrix. It maps every requirement, every block and warn check, and every WCAG and performance criterion to the test ids that cover it. CI fails if any check id in `checks.js` has no test.

### Environments and CI
- **Staging project** `hcec-election-results-staging`, a second Firebase project with an identical setup. Every deploy goes to staging first, layers 13–15 run there, and only then does the prod deploy proceed.
- **GitHub Actions** (`.github/workflows/`):
  - `ci.yml` runs on every PR and push. It does layers 1–2, 3 at the PR depth, 4, 6, 7, 8, 9, 10, 11 and 12, and the dependency and secret parts of 13. It uses Java for the emulators and Playwright browsers, and uploads reports and traces as artifacts.
  - `nightly.yml` runs layer 3 at full depth and layer 5 (mutation).
  - `deploy.yml` is triggered by hand. It deploys to staging, runs layers 13–15, then waits for a manual approval (a GitHub environment protection rule) before deploying to prod. A prod smoke test follows that uses a hidden test election and is cleaned up afterwards.
- **Branch protection on `main`:** the CI checks are required and no direct pushes are allowed.
- Firebase CLI `firebase-tools@13.35.1` and all npm dependencies are pinned, with a committed lockfile.

### Rehearsal and election-night assurance
- **Mock election rehearsal** (`docs/REHEARSAL.md`), held at least once before every election and run in production with a hidden test election:
  1. Export Zero, Early and several ED files from the tally system's test deck.
  2. Run the full runbook under time pressure.
  3. Have a second person compare every public number with the tally system's printed reports by hand.
  4. Do one deliberate rollback.
  5. Record the timings.
  6. Sign off.

  It must pass before election night.
- **Live monitoring on election night:**
  - A Cloud Monitoring **uptime check** on `current/manifest.json` every minute, from 3 regions, with email and SMS alerts.
  - A scheduled function, `auditLive`, runs every minute while the election is active. It:
    - fetches every public `current/*` file;
    - checks that the sha256s equal the manifest and the versions record;
    - checks that `dataVersion` is consistent across the files;
    - re-runs `validate.js`;
    - writes its result to `audit`, and on any mismatch sends a Cloud Monitoring alert and shows a red banner on admin.html.
- **Post-election:** export the audit log and every version's files and acknowledgements as a ZIP, kept for records retention.

## Node port (`functions/src/`)
Port it one-for-one so the behaviour stays the same, then fix the known defects behind explicit inputs.
- **`csv.js`:** a port of CPython's `_csv` reader (excel dialect, `utf-8-sig`, `errors=ignore`). *Changed in Phase 1:* csv-parse diverged from Python on malformed files and was ~50× slower; Python parity on random bytes is now a property test. csv-parse stays as an independent reader in tests.
- **`parse.js`:** `parseElectionCsv(text, isEd)`, ported from `convert_data.py:40`.
  - Fixed cells: title `rows[1][0]`, date `rows[2][0]`.
  - **Fix:** county and status are taken from the last non-empty cell of rows 2 and 0, so both the 5-column and 8-column exports work. The existing defaults stay as fallbacks.
  - Port the STATISTICS block (L74-112), contest detection on "Precincts Reporting" (L119), party prefixes, and the stats-row skip words (L89).
- **`merge.js`:** `mergeParsedData(early, ed, {precinctCap})`, ported from L244. The `precinctCap` from the election doc replaces the `MAX_PRECINCT_CAP` constant and is written into the output `config.precinctCap`. `dataVersion` is the MD5 of the merged content, first 12 hex characters, exactly as at L416.
- **`outputs.js`:** builds the `data.js` string and the minified summary, reporting and precincts objects with the shapes the pages use today. `metadata.lastUpdated` is the real publish time in America/New_York, formatted like the existing placeholder.
- **`verify.js`:** ports the `verify.py:36` checks as functions that return `{name, pass, detail}[]` instead of printing.

**Parity tests** (`functions/test/`, `node --test`, as in BarcodeScan):
- `tools/make_golden.py` runs the existing Python `convert_data` functions over each CSV pair in `Test_Files/` (including `Web Results Samples/00-06`, both 92 and 94 precincts). It writes `functions/test/golden/<case>/*.json`.
- `parity.test.js` checks that the Node output deep-equals the golden output. It ignores `lastUpdated`, plus county/status where the column fix is intended to change them, and asserts those values separately.
- `verify.test.js` checks that clean data passes, and that a tampered total fails.
- `checks.test.js` has one test per block or warn check. Each test mutates a golden CSV to trigger the check and asserts its id and severity. A clean sequence of 00 to 06 produces no block checks.
- `review.test.js` covers the diff math: Δ, leader change, close race, newly reporting and stopped reporting, and the raw-source trace line numbers.
- `publish.test.js` (pure logic): publish is refused when blocked, when a warning is unacknowledged, when baseVersion is stale, when the draft has expired, or when a hash mismatches.

## Front-end changes (repo root)
- **New `firebase-config.js`:** compat SDK 10.8.0 from gstatic, as in BarcodeScan. Region us-east1. Emulator switch on `localhost`/`127.0.0.1` with `?emulator`.
- **New `results-config.js`:** `window.RESULTS_BASE_URL`. The default is the public bucket's `current/` URL. Local dev uses `?local` (relative `./`) or `?emulator` (the Storage emulator).
- **New `admin.html` + `admin.js`**, using the BarcodeScan admin UI pattern from `index.html:1165` (sign-in) and `index.html:1361-1401` (`readFileText`, `runImport`, preview invalidation):
  1. Sign-in card. Signed-in users who are not admins see "not authorised" and a sign-out button.
  2. Election selector, plus an "Election settings" form above the upload card: name, date, county, **max precincts** (number input, default 92), precinct page toggle, set active. Saving calls `upsertElection`. A change to max precincts takes effect on the next draft. The review screen shows "N of <max> precincts" so the value can be checked before publishing.
  3. Upload card:
     - kind radio with no default, so the admin must choose (Zero / Early-ABS / Election Day);
     - `<input type=file accept=".csv">`;
     - **"Upload & create draft"** calls `createDraft` and then opens `review.html?draft=…`. There is no Publish button on this page; publishing happens only on the review screen.
  4. Open drafts list (status, kind, file, age, Review / Discard).
  5. History table of versions (time, by, early/ED filenames, verify pass count, acknowledged warnings, live-check status, and a "Roll back to this" button, which calls `createRollbackDraft` and then opens review) and of uploads (with a raw CSV link for admins).
  6. A "View public page" link and the current `dataVersion`.
- **`app.js`:**
  - `loadDataJsAndInit` (L136), the precinct fetch (L1273), the reporting fetch (L1312) and `refreshDataSilently` (L174) build URLs from `RESULTS_BASE_URL` instead of `./`.
  - The `data.js` script-injection fallback points at `RESULTS_BASE_URL + 'data.js'`.
  - The 60 s polling now reads `manifest.json` and fetches the page's data only when `dataVersion` changes. It pauses while the tab is hidden, and re-renders change only what moved, as set out in **Performance requirements**.
  - `MAX_PRECINCT_CAP` (L21) is read from the data's `config.precinctCap`, defaulting to 92.
- **The 4 public HTML pages:** replace `<script src="./data.js">` with `<script src="./results-config.js">`, because `app.js` fetches the data itself. Add an "Admin" link only in the footer, small.
- **`.gitignore`:** stop committing generated `data.js` and `*.json` outputs from the root, and keep `config.json` for the local fallback.

## Infra files (repo root)
- **`firebase.json`:**
  - firestore and storage rules;
  - `functions` with source `functions` and runtime nodejs22;
  - emulators for auth 9099, firestore 8181, storage 9199 and functions 5001, with `singleProjectMode`.
  - No hosting block.
- **`.firebaserc`:** default project `hcec-election-results`.
- **`firestore.rules`:** use the table above. `isAdmin()` checks `exists(/databases/$(database)/documents/admins/$(request.auth.uid))`.
- **`storage.rules`** (default private bucket): deny all client access. The function uses the admin SDK.
- **`lifecycle.json`:** for the public bucket, delete objects with `matchesPrefix: ["drafts/"]` once they are 2 days old.
- **`cors.json`:** for the public bucket, GET/HEAD from `https://<user>.github.io`, the custom domain if there is one, and `http://127.0.0.1:8123`.
- **`.claude/launch.json`:** `npx http-server -p 8123 -c-1`, the same as BarcodeScan.

## Legacy path
Keep `convert_data.py`, `verify.py`, `server_monitor.py` and `Run_Monitor.bat` as the documented offline fallback, used when the internet or GCP is down. In that mode the pages load with `?local`. The Python and Node outputs stay in sync because of the parity tests.

## Implementation phases (run in separate sessions)
0. **Test foundation:**
   - `functions/` package with `node:test` and `c8`;
   - `tools/make_golden.py` and the golden outputs;
   - `tools/gen-fixture.js` (seeded);
   - the fast-check harness;
   - `TESTING.md`;
   - `ci.yml` and branch protection.

   Each later phase writes its tests first or alongside its code. A phase is done only when its layers are green in CI.
1. **Node port** with the layer 1–5 tests. Pure and offline. This is the largest piece and the base for everything else.
2. **`checks.js`, `review.js`, `validate.js`, functions, rules, and an emulator run.** Covers `createDraft`, `publishDraft` (with the transaction lock), `extendDraft`, `discardDraft`, `createRollbackDraft`, `upsertElection` and `auditLive`. Layers 6 and 7.
3. **`admin.html`/`admin.js`, `review.html`/`review.js`, and `firebase-config.js`.** Build them mobile-first and to AA from the start, and add the `a11y/` test harness.
4. **Accessibility baseline audit and fixes for the existing public pages, then `app.js` and the pages switched to `RESULTS_BASE_URL`, with `results-config.js`, `?draft` mode and the live-update pause controls.**
   Layers 8, 9 and 12, the DOM oracle, and `validate.js` wired into `app.js`.
5. **README, GCP project setup for both staging and prod, `nightly.yml` and `deploy.yml`, first deploy, invoker grants, CORS, uptime checks and alerts, layers 13–15 on staging, a dry run with the `Web Results Samples` 00→06 sequence, and the first mock-election rehearsal.**

Phases 3 and 4 can run in parallel once phase 2's callable contract is fixed. Every phase that touches UI must pass `npm run a11y`, `npm run perf`, and the manual checklists below before it is done. Phase 2 must also meet the function latency budgets.

## Verification
**Test strategy** above holds the full layered suite: layers 1–15, the oracles, CI, staging, rehearsal and monitoring. The items below are the scenario checklist that layer 8 automates. Each is also run by hand once during Phase 5.
- `cd functions && npm test`: all parity, verify and checks tests pass across every golden case.
- Emulators (`npx firebase-tools@13.35.1 emulators:start --only auth,firestore,functions,storage --project hcec-election-results`), then `http://127.0.0.1:8123/admin.html?emulator`:
  - a non-admin user is refused, both in the UI and by the callable;
  - upload 00-Zero, review it, open all four draft pages and check each shows the DRAFT banner, publish, and check that `index.html?emulator` shows 0 of 92 and the live check is green;
  - step through 01→06. For each step, compare the review's contest diff by hand with a diff of the two CSVs' Totals rows, and check that the public page updates within 60 s;
  - an ED file uploaded as Zero is a **block**;
  - a file with lower totals gives a warning, and Publish stays disabled until it is acknowledged;
  - a tampered CSV (one precinct total edited) gives a verify FAIL, and the review screen has no Publish button;
  - Publish stays disabled until all the preview pages are opened, and the typed precinct count must match;
  - create draft A, publish draft B, then try to publish A: refused as stale;
  - draft objects can be fetched by direct URL, but listing the bucket (`https://storage.googleapis.com/<bucket>?prefix=drafts/`) is denied;
  - roll back to v03 through the rollback draft and check the review shows the decreases and the public page reverts;
  - toggle the precinct page off and check that `precincts.html` shows "Currently Disabled".
- **Automated accessibility (`a11y/`, `npm run a11y`):** Playwright with `@axe-core/playwright`, run against `npx http-server` using a fixture election built from the golden outputs.
  - It covers every page, plus the review page in each state (blocked, warnings, ready, published) and the open publish dialog.
  - Each runs at 320×640, 375×812 and 1280×800, tagged `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`.
  - Zero violations are allowed.
  - It also asserts that there is no horizontal scroll at 320 px or at a 1280 px viewport with 400 % zoom (`document.documentElement.scrollWidth <= innerWidth`).
- **Manual accessibility checklist** (`a11y/CHECKLIST.md`; run per UI phase and before each election):
  - keyboard only, through sign-in → upload → review → acknowledge → publish → rollback;
  - NVDA with Chrome and Firefox;
  - VoiceOver on iOS Safari and TalkBack on Android Chrome, doing the full review-and-publish flow on a phone;
  - 200 % text zoom;
  - the text-spacing bookmarklet;
  - Windows High Contrast / forced colors;
  - `prefers-reduced-motion`;
  - the live-update pause and the announcements;
  - extending a draft from the expiry warning.
- **Automated performance (`perf/`, `npm run perf`):**
  - Lighthouse CI (`@lhci/cli`) on every public page and on review.html in its fixture state, using the mobile preset (4× CPU, Slow 4G). It asserts the budget table: performance score ≥ 90, plus the LCP, TBT and CLS limits.
  - Playwright with CPU throttling at 4×, against the largest fixture (94 precincts, all contests). It measures:
    - each review filter, search keystroke and warning tick at < 100 ms;
    - a public-page auto-refresh with a changed `dataVersion` producing no long task > 50 ms (`PerformanceObserver('longtask')`);
    - an unchanged poll transferring ≤ 1 KB;
    - a hidden tab making no requests.
  - Bundle-size check against the gzip JS budgets.
  - `functions/test/bench.test.js` times parse, merge, verify, checks and review on the largest CSV: < 1.5 s locally.
- **Manual performance checklist** (`perf/CHECKLIST.md`):
  - a real mid-range Android phone and an iPhone on cellular data;
  - the full review → publish flow;
  - scrolling the review and precinct pages: no visible jank;
  - leaving a public page open for 30 minutes through several publishes: memory is stable and the page stays responsive.
- **Production load sanity:** before the first live election, fire about 1,000 concurrent `manifest.json` fetches with `npx autocannon` against the bucket URL. Confirm the p95 is under 300 ms, there are no errors, and the CDN is serving the requests (`Age` and `Cache-Control` headers present).
- After deploy: run the same 00→06 dry run on a test election in production. Fetch `current/summary.json` with curl and check the `Cache-Control` and CORS headers. Load the GitHub Pages site on a phone.

## Appendix A — README.md (to create at repo root)
```markdown
# Hamilton County Election Night Results

Public results pages (GitHub Pages) fed by an admin upload portal (Firebase).

## How it works
Admin uploads a tally-system "Custom Table Report" CSV → Cloud Function parses,
merges Early + Election Day, verifies, and publishes JSON to a public Cloud Storage
bucket → public pages poll it every 60 s.

## Election-night runbook
1. Sign in at `/admin.html`.
   Before polls close: set `ELECTION_NIGHT_MIN_INSTANCES=1` and redeploy the functions (see Performance).
2. Select (or create) the election. In Election settings, confirm the name, date, county and **max precincts**, then Save.
3. Every upload follows the same loop:
   a. Pick the kind (Zero / Early-ABS / Election Day), choose the CSV, then click **Upload & create draft**.
   b. On the Review screen:
      - Red checks mean the file can't be published. Fix the export and upload again.
      - Read each amber warning, click "show me", and tick it once you're satisfied.
      - Compare the headline numbers and any contest's raw-source rows with the tally system's printed report.
      - Open all four DRAFT pages and look at them as a member of the public would.
   c. Click **Publish**, type the precincts-reporting number shown, and confirm.
   d. Wait for the green "Live check passed".
4. Order on the night: Zero → Early/ABS → Election Day updates.
5. Wrong file published? Go to History, click "Roll back to this" on the previous version, review the draft, and publish it.
6. Final: publish the final ED file. Leave the election active until certification.

## Setup (one time)
### Google Cloud / Firebase
1. Create Firebase project `hcec-election-results`; upgrade to Blaze.
2. Auth → enable Email/Password; disable self sign-up; add admin users.
3. Firestore (Native, us-east1). Storage default bucket.
4. Public bucket:
   gcloud storage buckets create gs://hcec-election-results-results --location=us-east1 --uniform-bucket-level-access
   gcloud storage buckets add-iam-policy-binding gs://hcec-election-results-results --member=allUsers --role=roles/storage.legacyObjectReader
   gcloud storage buckets update gs://hcec-election-results-results --cors-file=cors.json
   gcloud storage buckets update gs://hcec-election-results-results --lifecycle-file=lifecycle.json   (deletes drafts/ after 2 days)
5. Grant the functions service account `roles/storage.objectAdmin` on the public bucket.

### Managing admins
Firestore → `admins/{uid}` with `{email, added}`. Remove the doc to revoke.

### Deploy
cd functions && npm install && npm test
npx firebase-tools@13.35.1 deploy --only functions,firestore:rules,storage --project hcec-election-results
Then once per new function:
gcloud run services add-iam-policy-binding <service> --region=us-east1 --member=allUsers --role=roles/run.invoker --project=hcec-election-results

### GitHub Pages
Settings → Pages → main / root. Set `RESULTS_BASE_URL` in `results-config.js`.

## Local development
npx firebase-tools@13.35.1 emulators:start --only auth,firestore,functions,storage --project hcec-election-results
npx http-server -p 8123 -c-1
Open http://127.0.0.1:8123/admin.html?emulator  (ports 9099, 8181, 9199, 5001 must be free)

## Offline fallback
No internet? Drop CSVs in `Results/`, run `Run_Monitor.bat`, open pages with `?local`.

## Data files
- Upload kinds: Zero, Early/ABS, Election Day (chosen in the UI, not by filename).
- Outputs: summary.json, reporting.json, precincts.json, data.js, manifest.json.
- Raw uploads archived privately; every published version kept under elections/{id}/v/{version}/.

## Accessibility & mobile
All pages (public, admin, review) must be mobile-friendly and conform to WCAG 2.1 AA.
- `npm run a11y` runs axe checks at 320, 375 and 1280 px and must report zero violations.
- Before each election, run the manual checklist in `a11y/CHECKLIST.md`: keyboard, NVDA, VoiceOver, TalkBack, zoom and reduced motion.
- Public pages have a "Pause live updates" control. The slideshow has pause/play.

## Testing
Public trust depends on this. Every displayed number is proven equal to the source CSV.
- `cd functions && npm test`: unit, parity, property-based, fuzz, rules and integration tests, with the emulators started automatically.
- `npm run e2e`: Playwright on Chromium, Firefox, WebKit, Pixel 7 and iPhone 14. Runs the full election night, the DOM-vs-CSV oracle, visual and resilience tests.
- `npm run a11y`, `npm run perf`: accessibility and performance budgets.
- `npm run mutation`: Stryker, run nightly.
- CI runs everything on each PR. Merges are blocked on failure.
- Deploys go to staging first, then staging smoke tests, a ZAP scan and a k6 load test, then manual approval before prod.
- Before each election, run the mock-election rehearsal in `docs/REHEARSAL.md`.
- `TESTING.md` maps each requirement to its tests.

## Election-night monitoring
- An uptime check on `current/manifest.json` sends email and SMS alerts.
- `auditLive` re-verifies the live files every minute. A red banner appears on admin.html if anything mismatches.

## Performance
Pages must stay fast and lag-free, including on mid-range phones on 4G.
- `npm run perf`: runs Lighthouse CI (mobile, 4× CPU throttle) and Playwright interaction timings. All budgets must pass.
- Public pages poll a ~200-byte `manifest.json` and download results only when they change. Polling stops while the tab is hidden.
- **Election night:** set `ELECTION_NIGHT_MIN_INSTANCES=1` and redeploy the functions so there are no cold starts. Set it back to 0 afterwards.

## Troubleshooting
- "permission-denied": user not in `admins`.
- Callable 403 / CORS error: missing run.invoker grant.
- Public page stale: check Cache-Control on current/*.json; hard refresh.
```

## Appendix B — Decisions made while building (Phases 1–2)
- **Reported precincts (D1)** are inferred per contest: ED votes not all zero **and** changed vs the Early-slot file.
  This matches every contest's "R of T" in all real exports in `Test_Files/` (user: those files are the real
  election-night format, and the per-precinct list must be exact). Write-ins are ignored. A contest where the
  inference and R disagree → `reporting-mismatch` check; **warn** (user decision 2026-10-21): it must be acknowledged before publishing.
- **`csv.js`** ports CPython's `_csv` reader instead of using csv-parse (exact parity on malformed files; ~50× faster).
- **Check severities changed by real data:** `overvote` and `ballots-over-registered` are **warn**. The real 8-column
  exports' STATISTICS ballots leave out early votes that contest rows include, so a block would stop legitimate files.
  `date-unreadable` is warn and `date-mismatch` is block. New blocks: `reporting-inconsistent` (page headers of
  one contest disagree; the parser keeps the first) and `output-invalid` (the draft's files fail `validate.js`, so the
  pages would reject them). Close races and overvotes are **one grouped warning each**, not one per contest.
- **Acknowledgements name check `key`s** (`id:n`, unique within a draft), since one id can occur more than once.
- **The typed precinct count is enforced server-side**: `publishDraft` takes `confirmCount`, compared with the draft's.
- **`metadata.lastUpdated` is the draft build time** (the reviewed bytes are published unchanged, at most 2 h later).
  **`manifest.json` is written fresh at publish** with `updatedAt` = publish time and the reviewed files' sha256s;
  pages should show the manifest time as "Results updated".
- **`extendDraft`** applies only the integrity rules (exists, ready, not stale, files unchanged), so an expired draft
  can be extended. The bucket lifecycle still deletes drafts after 2 days.
- **Publish lease:** a second publish while one runs fails with `aborted` / `busy`; once the first finishes, a retry is `stale`.
- **SDKs:** `firebase-admin@13.10.0` (12.x carries `node-forge` advisories with no patch) and `firebase-functions@6.6.0`.
  npm `overrides` pin patched `qs`, `uuid` (deps call only `v4`) and `@grpc/grpc-js`; `npm audit` reports 0.
- **Logic lives in `functions/src/service.js`** over injected db/bucket/clock interfaces; `index.js` only wires Firebase.
  `service.test.js` runs the full callable contract on in-memory fakes; `test/emulator/` re-runs it on the emulators.
- **Mutation testing** runs nightly as one shard per source file (each mutant reruns about 5 s of suites).


## Appendix C — Decisions made while building (Phase 4)
- **Local mode is lenient.** With `?local`, or by default while `PUBLIC_BASE` is null, the pages read `./` as before.
  The legacy monitor's files there fail `validate.js` (LEGACY flags can exceed a contest's total: 93 of 92), so local
  mode logs validation errors and still renders. Bucket and draft modes are strict: invalid data is never shown,
  the last good data stays, and the status reads "Live updates delayed — retrying" (retry after 15 s).
- **Files per page:** summary and slideshow pages read `summary.json`. The precinct page reads `precincts.json`.
  The reporting page reads `summary.json` + `reporting.json`, because `reporting.json` has no vote totals,
  `voteFor` or early ballots. The summary page fetches `reporting.json` only when its precinct dialog is first
  opened, and requires the same `dataVersion`. `data.js` is only the error fallback.
- **`results-config.js` runs in `<head>`** with `data-files="…"` and starts the data (and manifest) requests early.
  `app.js` takes them with `RESULTS.takeEarly(file)`. Every bucket request carries a cache-buster: the manifest is
  under 1 KB, and the data files are fetched only when `dataVersion` changes.
- **The status line uses the manifest's `updatedAt`** ("Results updated 9:42 PM"). Without a manifest (local or
  draft), it uses `metadata.lastUpdated`. The text is written only when it changes, so each update is announced once.
- **Filter buttons are toggle buttons** (`aria-pressed` in a `role="group"`), not tabs, because there are no tab panels.
  Reporting buttons use `data-contest` plus a delegated click handler. The old inline `onclick` with
  `escapeJsString` broke on titles containing `"`.
- **Precinct dialog:** focus moves to Close, Tab is trapped, and Escape returns focus to the opener. A live update
  re-points the open dialog at the same contest.
- **Dark theme:** `--primary` and `--secondary` are lighter (`#60a5fa`, `#f87171`) so text in those colours passes
  4.5:1. Filled controls use the new `--on-fill` text token (dark text in dark mode).
- **Lighthouse lives in `perf/` with its own `package.json`.** Its puppeteer download helpers carry high-severity
  advisories that would fail the root `npm audit`. It is a local tool, not run in CI. The a11y harness
  (Playwright + axe) is the root package and the CI job `pages`.
