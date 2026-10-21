# Manual accessibility checklist

Run per UI phase and before each election (plan: Verification › Manual accessibility checklist).
`npm run a11y` and `npm run a11y:admin` cover what axe and scripted checks can find. This list covers what
they can't. Record the date, browser and result of each run at the bottom.

## Setup
- Public pages: `npx http-server -p 8123 -c-1` at the repo root, then `http://127.0.0.1:8123/index.html`
  (and `reporting.html`, `precincts.html`, `scrolling.html`).
- Admin flow:
  1. Start the emulators and run `node tools/seed-emulator.js`.
  2. Run `node tools/emulator-drafts.js` (publishes a sample, prints draft links).
  3. Open `http://127.0.0.1:8123/admin.html?emulator` and sign in as `admin@example.test`.

## Keyboard only (no mouse)
- [ ] Every page: the first Tab shows "Skip to main content", and Enter moves focus into the main content.
- [ ] Every control shows a visible focus ring (amber, 3 px).
- [ ] Focus order follows the reading order.
- [ ] Summary page:
  - [ ] party filter buttons announce pressed/not pressed;
  - [ ] the jump menu moves to the contest;
  - [ ] search filters as you type.
- [ ] Precinct dialog:
  - [ ] opens from "N of M Election Day Precincts Reporting", with focus on Close;
  - [ ] Tab stays inside the dialog;
  - [ ] Escape closes it and focus returns to the button.
- [ ] Wide tables (reporting page, precinct page "By Contest") can be focused and scrolled with the arrow keys.
- [ ] Slideshow:
  - [ ] the controls come before the slide;
  - [ ] Pause/Play, Prev/Next, the speed and jump menus and Fullscreen all work from the keyboard.
- [ ] "Pause live updates": Space/Enter toggles it; it is still paused after a reload in the same tab.
- [ ] Admin: sign-in → upload → review → acknowledge → publish → rollback, all by keyboard.
  `a11y/admin-keyboard.spec.js` automates the path in Chromium: every control can be reached and focus goes into and
  out of each dialog. By hand, check what it can't: that the focus ring is visible at every step, and that the order
  makes sense. The review page's tab order is long: every contest table is a scroll region, so use the headings or the
  skip link.
  - [ ] The publish dialog traps focus and Escape closes it.

## Screen readers
- [ ] NVDA + Chrome and NVDA + Firefox, on the summary, reporting and precinct pages and the full admin flow.
- [ ] VoiceOver on iOS Safari and TalkBack on Android Chrome: the full review-and-publish flow on a phone.
- [ ] Checks for each:
  - [ ] the reporting buttons read "N of M Election Day Precincts Reporting in <contest>";
  - [ ] filter buttons read as toggle buttons with their state;
  - [ ] the dialog is announced with its title.
- [ ] Live updates:
  - [ ] "Results updated 9:42 PM" is announced once per new version, not every minute;
  - [ ] focus and reading position stay put when results change;
  - [ ] the tables themselves are not announced.
- [ ] Slideshow: slides are not announced while it plays; after Pause, the current slide is announced on change.

## Zoom, spacing, colour, motion
- [ ] 200 % text zoom (browser text-only zoom): nothing is clipped or overlapping.
- [ ] 400 % page zoom at 1280 px wide (= 320 CSS px): no horizontal page scroll. The slideshow scrolls vertically.
- [ ] Text-spacing bookmarklet (line height 1.5, letter spacing 0.12 em, word spacing 0.16 em, paragraph spacing 2 em):
      nothing is clipped. This is automated at 320 and 1280 px; spot-check at 768 px.
- [ ] Windows High Contrast / forced colors: buttons, focus rings, party pills, REPORTED/PENDING and the DRAFT banner
      stay visible and distinguishable.
- [ ] Dark Mode and High Contrast toggles on each page: text stays readable; party is shown as text, not only colour.
- [ ] `prefers-reduced-motion: reduce` (OS setting): no smooth scrolling, no animated bars or slide transitions.
- [ ] Portrait and landscape on a phone: both work. The DRAFT banner scrolls with the page in landscape (height < 500 px).

## Timing
- [ ] Review page: the 10-minute and 2-minute expiry warnings are announced politely.
- [ ] "Extend draft" from the warning keeps the review going.

## Runs
| Date | Who | Browser / AT | Result / issues |
|---|---|---|---|
| | | | |
