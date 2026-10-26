# Deploying from GitHub Actions (Phase 5)

`deploy.yml` deploys to staging, smoke-tests it, waits for a manual approval, then deploys to production and
smoke-tests that. It runs only when started from the Actions tab (**deploy → Run workflow**). Until the one-time
setup below is done, it fails at the sign-in step and changes nothing.

The manual deploy in README › Deploy still works as before.

## One-time setup
1. **GCP projects and buckets:** as in README › Setup. That means `hcec-election-results` and
   `hcec-election-results-staging`, with public buckets `…-results` and `…-staging-results`.
2. **Workload Identity Federation**, so no service-account keys are stored in GitHub. In each project:
   ```bash
   PROJECT=hcec-election-results-staging   # then again with hcec-election-results
   gcloud iam service-accounts create github-deploy --project=$PROJECT
   SA=github-deploy@$PROJECT.iam.gserviceaccount.com
   for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin roles/iam.serviceAccountUser \
               roles/storage.admin roles/firebaserules.admin roles/cloudscheduler.admin; do
     gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=$role
   done
   ```
   Create one workload identity pool and provider (in either project) for `token.actions.githubusercontent.com`,
   with the attribute condition `assertion.repository == 'hamcoec-dot/Results'`. Then let the repository
   impersonate each service account:
   ```bash
   gcloud iam service-accounts add-iam-policy-binding $SA --project=$PROJECT \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/<POOL_PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/attribute.repository/hamcoec-dot/Results"
   ```
   For **production**, bind the job's GitHub environment instead, so only an approved production job can act as
   the account (Google then enforces the approval too; `tools/setup-gcp.sh` does this):
   `--member="principal://iam.googleapis.com/projects/<POOL_PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/subject/repo:hamcoec-dot@287081868/Results@1427757406:environment:production"`
   This repository's tokens name it by immutable IDs (`<owner>@<owner id>/<repo>@<repo id>`); the plain
   `repo:hamcoec-dot/Results:…` subject never matches.
3. **GitHub → Settings:**
   - **Environments:**
     - `staging`, no rules;
     - `production`, with *Required reviewers* (this is the approval gate) and *Deployment branches* limited to `main`.
   - **Variables (repository):**
     - `GCP_WIF_PROVIDER` = `projects/<POOL_PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github`;
     - `GCP_DEPLOY_SA_STAGING` and `GCP_DEPLOY_SA_PROD` = each project's `github-deploy@…` address.
4. **First run:** deploy once with *smoke* unticked, then run **staging-election** (below) so the smoke,
   load and ZAP steps have something to check. Publishing a test election through admin.html works too.

## Staging test election (`tools/staging-election.js`, `staging-election.yml`)
Publishes the hidden election `test-staging-dryrun` to staging through the deployed callables, with the
`Web Results Samples` 00→06 files (92 precincts). Each step is what an admin does:
- create the draft (00 Zero, 01–02 Early/ABS, 03–06 Election Day);
- check it is ready and acknowledge every warning;
- publish with the precincts-reporting count;
- print the live check.

Then the workflow runs the smoke test. Start it from the Actions tab: **staging-election → Run workflow**, or
tick **test_election** when you run **deploy** (staging only; it publishes right after the staging deploy).

It signs in as the bot admin `staging-bot`. It creates the Auth user (a new random password each run) and
`admins/staging-bot`, and deletes that doc at the end. The test election is made the active election (only the active election can publish).

**It replaces the bucket's `current/` files.** Those files are shared by every election in the project, active
or not. The tool refuses `hcec-election-results` unless `--allow-production` is passed (rehearsal only).

No setup beyond the above. The web API key is the staging one in `firebase-config.js` (not a secret; pass
`--api-key` or `FIREBASE_WEB_API_KEY` to use another). The tool signs in from Node, which sends no `Referer`,
so that key must not be restricted to HTTP referrers.

By hand, with your own `gcloud auth application-default login`:
`node tools/staging-election.js [--steps 00,01] [--publish false] [--set 94]`.

The same flow runs on the emulators, with no key or IAM:
`node tools/staging-election.js --emulator`, then `node tools/smoke-public.js demo-hcec-results --emulator`.

The full rehearsal (rollback, settings, the deliberate mistakes, and every page checked against the CSVs) is
the **rehearsal** workflow: docs/REHEARSAL.md › Automated rehearsal. `tools/clear-test-election.js` removes a
test election and everything it published.

## Election night: one warm instance (around Nov 1, back to 0 after)
`createDraft`, `createSettingsDraft`, `publishDraft`, `extendDraft` and `ping` keep
`ELECTION_NIGHT_MIN_INSTANCES` instances running, so the first upload of the night doesn't wait for a cold
start (several seconds). It is 0 the rest of the year. To turn it on for production:
1. Add the line `ELECTION_NIGHT_MIN_INSTANCES=1` to `functions/.env.hcec-election-results` (a one-line PR to main).
2. Run **deploy** from main and approve the production step. Staging stays at 0.
3. Check in the Cloud console (Cloud Run › the function › Revisions) that minimum instances is 1.
Cost: roughly one to three dollars a day for the five warm functions. After the canvass, remove the line and deploy again.

## What a run does (each target)
1. Applies `cors.json` and `lifecycle.json` to the public bucket.
2. `firebase deploy --only functions,firestore:rules,storage`.
3. Grants the public invoker on every callable in `functions/src/index.js`; the scheduled `auditLive` stays private.
4. Runs `node tools/smoke-public.js <bucket>`. It fails the run unless all of these hold:
   - the served bytes match the manifest's sha256s and pass `validate.js`;
   - the manifest is 1 KB or less;
   - `Cache-Control: public, max-age=15`;
   - the JSON is stored gzip-encoded;
   - CORS allows `https://govotehamiltontn.gov`;
   - listing the bucket is denied.
5. Staging only, after the smoke test:
   - **Load:** `node tools/load-manifest.js` sends 2,000 manifest fetches, 200 at a time. It fails on any error or a p95 over 300 ms.
   - **ZAP baseline:** passive scans (spider and passive rules, no attacks) of the Pages site and the staging bucket.
     Warnings are reported in the `zap-pages` and `zap-bucket` artifacts but don't fail the run, because GitHub Pages' headers can't be changed.
     The rules marked FAIL in `.zap/rules.tsv` do fail it: a vulnerable JS library, PII disclosure, CORS misconfiguration and error disclosure.

## Monitoring and alerts
Once per project, after the first deploy: `node tools/setup-monitoring.js` (uptime check, the auditLive
mismatch alert, the failed-action alert, email and SMS). See docs/MONITORING.md, which also covers testing them.

## Checks to run by hand
```bash
node tools/smoke-public.js hcec-election-results-results        # what the public is served, right now
node tools/load-manifest.js https://storage.googleapis.com/hcec-election-results-results/current/manifest.json \
  --requests 1000 --concurrency 100                              # election-night load sanity: p95 < 300 ms, no errors
```
Before the rehearsal: the election-night load test, 2,000 simulated pages while 10 publishes are made (docs/LOAD-TEST.md).

Both tools also run against the emulators:
- `node tools/smoke-public.js demo-hcec-results --emulator` checks content only;
- the load tool takes the emulator's manifest URL.
