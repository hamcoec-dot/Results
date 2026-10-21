# Hamilton County Election Night Results

Public results pages (GitHub Pages, live at govotehamiltontn.gov/Results/) fed by an admin upload portal (Firebase).
Design: [plans/cloud-admin-upload.md](plans/cloud-admin-upload.md). Tests and traceability: [TESTING.md](TESTING.md).

## Status

| Part | State |
|---|---|
| Node port of the parser, merge, outputs and verify (`functions/src/`) | done: byte-identical to the Python pipeline, legacy defects D1–D4 fixed |
| Checks, review payload, validation, publish rules, callables (`functions/src/`) | done: tested on in-memory fakes and on the emulators |
| `admin.html` / `review.html` | not built yet (Phase 3) |
| Public pages reading the cloud bucket (`RESULTS_BASE_URL`, `?draft`, pause control) | not built yet (Phase 4) |
| GCP projects, deploy, monitoring | not done yet (Phase 5) |

Until Phases 3–5 land, results publish the legacy way (see **Offline fallback**).

## How it works
An admin uploads a tally-system "Custom Table Report" CSV and picks its kind (Zero, Early/ABS or Election Day).
`createDraft` parses it, merges it with the other slot's selected file, verifies it independently, runs the
checks, and stores a frozen **draft**. The admin reviews the draft (every number, every change, the real pages
rendered from it) and publishes it. `publishDraft` copies exactly the reviewed bytes to the public bucket, writes
`current/manifest.json` last, and confirms the public URL serves the same bytes. The pages poll the manifest.

Which precincts have reported is worked out per contest: a precinct has reported when its Election Day votes are
not all zero and differ from the Early file. In every real export this matches the file's "R of T" exactly; any
contest where it does not is flagged before publishing.

## Election-night runbook
1. Before polls close: set `ELECTION_NIGHT_MIN_INSTANCES=1` in `functions/.env.hcec-election-results` and redeploy the functions.
2. Sign in at `/admin.html`. Select the election; in Election settings confirm the name, date, county and **max precincts**, then Save.
3. For each export:
   1. Pick the kind (Zero / Early-ABS / Election Day), choose the CSV, click **Upload & create draft**.
   2. On the Review screen:
      - red (BLOCKED) checks mean the file cannot be published: fix the export and upload again;
      - read each WARNING, use "show me", and tick it when satisfied;
      - compare the headline numbers and a contest's raw-source rows with the tally system's printed report;
      - open all the DRAFT pages and look at them as the public would.
   3. Click **Publish**, type the precincts-reporting number shown, confirm.
   4. Wait for the green "Live check passed".
4. Order on the night: Zero → Early/ABS → Election Day updates.
5. Wrong file published? History → "Roll back to this" on the earlier version → review → publish.
6. After the night: set `ELECTION_NIGHT_MIN_INSTANCES=0` and redeploy.

## Setup (one time)
### Google Cloud / Firebase
1. Create Firebase project `hcec-election-results` (and `hcec-election-results-staging`); upgrade to Blaze.
2. Auth → enable Email/Password; disable self sign-up; add admin users.
3. Firestore (Native, us-east1). Storage default bucket (private: raw uploads).
4. Public bucket:
   ```bash
   gcloud storage buckets create gs://hcec-election-results-results --location=us-east1 --uniform-bucket-level-access
   gcloud storage buckets add-iam-policy-binding gs://hcec-election-results-results --member=allUsers --role=roles/storage.legacyObjectReader
   gcloud storage buckets update gs://hcec-election-results-results --cors-file=cors.json
   gcloud storage buckets update gs://hcec-election-results-results --lifecycle-file=lifecycle.json
   ```
   `legacyObjectReader` lets anyone read an object by name but not list the bucket, so draft URLs stay unguessable;
   the lifecycle rule deletes `drafts/` after 2 days.
5. Grant the functions service account `roles/storage.objectAdmin` on the public bucket.

### Managing admins
Firestore → `admins/{uid}` with `{email, added}`. Delete the doc to revoke.

### Deploy
```bash
cd functions && npm ci && npm test
npx firebase-tools@13.35.1 deploy --only functions,firestore:rules,storage --project hcec-election-results
```
Then once per new function (the org policy blocks public invokers by default):
```bash
gcloud run services add-iam-policy-binding <service> --region=us-east1 --member=allUsers --role=roles/run.invoker --project=hcec-election-results
```
Function params live in committed, secret-free files: `functions/.env` (defaults), `functions/.env.<project>`
(public bucket name per project) and `functions/.env.local` (emulators).

## Local development
```bash
cd functions && npm ci
npm test                 # unit, parity, property, fuzz, checks, review, service contract
npm run test:emulator    # rules + callables on the emulators (Java 11+)
```
Emulators by hand: `npx firebase-tools@13.35.1 emulators:start --only auth,firestore,functions,storage --project demo-hcec`
(ports 9099, 8181, 9199, 5001).

## Offline fallback
No internet? Drop CSVs in `Results/`, run `Run_Monitor.bat`, open the pages. The legacy Python pipeline
(`convert_data.py`, `verify.py`) stays byte-compatible with the Node port (`functions/test/parity.test.js`).

## Data files
- Upload kinds: Zero, Early/ABS, Election Day — chosen in the UI, not by file name.
- Published files: `summary.json`, `reporting.json`, `precincts.json`, `data.js`, and `manifest.json` (written at publish:
  `dataVersion`, publish time, sha256 of each file).
- Raw uploads are archived privately; every published version is kept under `elections/{id}/v/{version}/`.

## Testing
Public trust depends on this: every displayed number is proven equal to the source CSV. See [TESTING.md](TESTING.md).
- `npm test` and `npm run test:pr` (with coverage gates) run on every PR, with `npm audit`, gitleaks and osv-scanner.
- `npm run test:emulator` runs on every PR (CI job `emulator`).
- Nightly: property tests at 100,000 runs and Stryker mutation testing (≥ 85 %).

## Troubleshooting
- "permission-denied": the user is not in `admins`.
- Callable 403 / CORS error: missing `run.invoker` grant.
- Public page stale: check `Cache-Control` on `current/*` (15 s); hard refresh.
