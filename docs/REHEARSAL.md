# Mock election rehearsal

Hold this at least once before every election, in production, with a hidden test election. It must pass before
election night. It is written for two people who are not developers: everything happens on the admin page
(govotehamiltontn.gov/Results/admin.html) and the public pages. The technical checks are in the last section,
for whoever maintains the system (Claude), and are done before and after the two of you start.

**Hold it before the public pages read the bucket** (`PUBLIC_BASE` set; docs/DEPLOY.md › Switch-over). The bucket's
`current/` files are one set for every election, active or not, so once the pages read the bucket a rehearsal
publish is what voters see. After the switch, rehearse on staging (`?staging`) instead.

## Who
- **Operator:** signs in to the admin page and does every upload and publish.
- **Checker:** has the printed tally reports and compares the numbers on the public pages with them. The checker
  says "match" out loud before the operator moves on.

## Bring
- [ ] Test files exported from the tally system's test deck: a Zero file, an Early/ABS file, and at least three
  Election Day files (some precincts, more precincts, all precincts). The sample files in
  `Test_Files\Web Results Samples` (00 to 06) work if no test deck is ready.
- [ ] A printed tally report for every file, for the checker.
- [ ] The admin sign-in (email and password).
- [ ] A clock or phone to write down how long each step takes.

## Set up (operator, about 5 minutes)
1. Sign in to the admin page.
2. Under **Election settings**, choose a new election. Give it a name with "TEST" in it, set **Max precincts** to
   the real number of precincts, tick **This is the active election**, and click **Save settings**. Only the
   active election can publish.
3. Check the election shows a ★ and "— active" in the **Election** list.

## Run (write down the time of each step)
For every file the flow is the same:
**Upload results** → pick the file and what it is (**What is this file?**) → **Upload & create draft** →
**Review** (under **Open drafts**) → open all four page previews → tick every warning once you understand it →
type the precincts-reporting number shown in the sentence → **Confirm**.

1. **Zero file** (choose "Zero report").
   - [ ] The public results page shows 0 precincts reporting.
   - [ ] Under **Published versions**, the new row's **Live check** is green.
2. **Early/ABS file** (choose "Early voting / Absentee").
   - [ ] Checker: every contest total on the public results page matches the printed report.
3. **Each Election Day file, in order** (choose "Election Day").
   - [ ] On the review page, the precincts reporting match the tally system's report exactly.
   - [ ] Every warning is understood (say out loud why it is OK) before it is ticked.
   - [ ] The public pages show the new numbers within 60 seconds of publishing.
   - [ ] Checker: every contest total, and "X of Y precincts reporting" for each contest, match the printed report.
4. **Practice a rollback.** Under **Published versions**, click **Roll back to this** on the version before the
   latest, then **Create rollback draft**.
   - [ ] The review shows the numbers going down.
   - [ ] After publishing it, the public page shows the older numbers.
   - [ ] Then upload and publish the latest Election Day file again.
5. **Practice a settings change.** In **Election settings**, untick **Show the Precinct Results page** and click
   **Create draft with these settings**. Review and publish it.
   - [ ] The Precinct Results page disappears from the public site.
   - [ ] Turn it back on the same way, and check it comes back.
6. **If a precinct ES&S counts shows as Pending.** The review warns **Reported precincts do not match the count**
   and names the contest. This happens only when a precinct reported with no new Election Day votes in a contest.
   On the admin page, under **Precincts reporting**, tick **Marked as reported** for that precinct, then
   **Save marks & create draft**. Review and publish it. The "X of Y" count always stays the one ES&S printed.
   - [ ] **Precincts reporting** on the admin page lists every precinct the public pages show as Reported.
7. **Practice mistakes on purpose:**
   - [ ] Upload an Election Day file but choose "Zero report". The draft is **BLOCKED** and cannot be published.
   - [ ] Upload an earlier file after a later one (lower totals). A warning appears and must be ticked before publishing.
   - [ ] Upload two files to make two drafts (A, then B). Publish B, then open A. It is refused as **Stale**.
8. Under **Open drafts**, click **Discard** on anything left over.

## After
- [ ] Untick **This is the active election** on the test election. Make the real election the active one before its Zero publish.
- [ ] Fill in the record below. Write down anything slow or confusing, so it can be fixed before election night.

## Record
| Date | Operator | Checker | Files | Step timings (upload → public) | Rollback OK | Numbers match | Alerts arrived | Issues | Sign-off |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## Automated rehearsal (maintainer)
The **rehearsal** workflow (GitHub › Actions › rehearsal › Run workflow) does every step of **Run** above
through the deployed system, as a bot admin, with no one at the admin page: the 00→06 sample files, the
rollback, the latest file again, the Precinct Results page off and on, and the three deliberate mistakes.
It also does the checker's job for every number: before each publish it opens the four draft previews,
and after it the four public pages (summary, reporting, precincts, lobby screen), and compares every
contest, candidate, vote count, percentage, precincts-reporting figure and precinct row with the CSV
files, as read by the old Python converter (`tools/check-live-pages.js`). It fails on any difference.

- **staging**: any time, for example after a code change. The staging data is kept.
- **production**: only before the switch-over (PUBLIC_BASE unset). It waits for the production approval in
  GitHub, and at the end it clears the test election out completely (`tools/clear-test-election.js`: the
  public `current/` files, the archive, drafts, raw uploads, Firestore records and the bot admin), then
  checks the public manifest is gone again. The log and a records ZIP are kept as the run's artifacts.

It does not replace the people's rehearsal: that one checks the printed tally reports, the admin page as
the operator sees it, and how long each step takes for a person.

## Technical checks (maintainer, not the two rehearsal people)
Before:
- The production deploy is current: run **deploy** and have it approved for production.
- `node tools/smoke-public.js hcec-election-results-results` passes. On the first rehearsal nothing is published
  yet, so it fails on the missing `current/manifest.json`; that is expected.

During and after:
- `node tools/smoke-public.js hcec-election-results-results` after the last publish.
- Alerts: trigger the mismatch and uptime alerts on staging as in docs/MONITORING.md › Test the alerts, and record
  when each email arrived.
- After the rehearsal's Zero publish, set up production monitoring (docs/MONITORING.md).
- The election-night load test with 10 publishes runs on staging (docs/LOAD-TEST.md).
- Export the audit log for the record.
