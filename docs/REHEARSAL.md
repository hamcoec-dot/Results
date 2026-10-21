# Mock election rehearsal

Hold this at least once before every election, in production, with a hidden test election (plan: Rehearsal and
election-night assurance). It must pass before election night. Copy the record table at the bottom for each run.

## Before
- [ ] Export from the tally system's test deck:
  - [ ] a Zero file;
  - [ ] an Early/ABS file;
  - [ ] at least three Election Day files (partial, more, all precincts).
- [ ] Create the test election in admin.html: max precincts = the real count, and **not** the active election.
- [ ] Two people: an operator (runs the runbook) and a checker (compares numbers).
- [ ] Printed tally reports for every file, for the checker.
- [ ] `node tools/smoke-public.js hcec-election-results-results` passes before you start.

## Run (time each step)
1. **Zero:** upload → review (open all four draft pages) → acknowledge → type the count → publish.
   - The public page shows 0 of N.
   - The live check is green.
2. **Early/ABS:** same flow. The checker compares every contest total on the public summary page with the printed report.
3. **Each Election Day file, in order:**
   - [ ] The review's precinct list matches the tally system's reported precincts exactly.
   - [ ] Every reporting-mismatch warning is understood before it is acknowledged.
   - [ ] The public pages update within 60 s of the publish.
   - [ ] The checker compares every contest total and the R of T for each contest with the printed report.
4. **Deliberate rollback:** roll back to the previous version through the rollback draft.
   - The review shows the decreases.
   - The public page reverts.
   - Then publish the latest again.
5. **Settings change:** toggle the Precinct Results page, then use "Create draft with these settings", review and
   publish. Check the page hides or shows, then restore the setting the same way.
6. **Failure drills:**
   - [ ] Upload an ED file as Zero: it is a **block**.
   - [ ] Upload a file with lower totals: a warning that must be acknowledged.
   - [ ] Create draft A, publish draft B, then try to publish A: refused as stale.
7. `node tools/smoke-public.js hcec-election-results-results` after the last publish.

## After
- [ ] Discard or let expire any open drafts; clear the test election's active flag if it was set.
- [ ] Export the audit log for the record.
- [ ] Note anything slow or confusing, and fix it before election night.

## Record
| Date | Operator | Checker | Files | Step timings (upload → public) | Rollback OK | Numbers match | Issues | Sign-off |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
