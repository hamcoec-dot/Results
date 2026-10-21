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
3. **GitHub → Settings:**
   - **Environments:**
     - `staging`, no rules;
     - `production`, with *Required reviewers* (this is the approval gate) and *Deployment branches* limited to `main`.
   - **Variables (repository):**
     - `GCP_WIF_PROVIDER` = `projects/<POOL_PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github`;
     - `GCP_DEPLOY_SA_STAGING` and `GCP_DEPLOY_SA_PROD` = each project's `github-deploy@…` address.
4. **First run:** publish a test election on staging through admin.html first, so the smoke test has
   something to check. Or run once with *smoke* unticked.

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

## Checks to run by hand
```bash
node tools/smoke-public.js hcec-election-results-results        # what the public is served, right now
node tools/load-manifest.js https://storage.googleapis.com/hcec-election-results-results/current/manifest.json \
  --requests 1000 --concurrency 100                              # election-night load sanity: p95 < 300 ms, no errors
```
Both tools also run against the emulators:
- `node tools/smoke-public.js demo-hcec-results --emulator` checks content only;
- the load tool takes the emulator's manifest URL.
