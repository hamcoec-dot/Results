# Election-night monitoring (Phase 5)

Three alerts tell the on-call person, by email and SMS, that the public results are not right:

| Alert | Fires when | What to do |
|---|---|---|
| **manifest.json unreachable** | The uptime check on `<bucket>/current/manifest.json` fails in 2 or more of its 3 regions for a minute. It runs every minute and the file must contain `dataVersion`. | Open a public page on a phone. If it shows "Live updates delayed", check the [Google Cloud status page](https://status.cloud.google.com/). The pages keep showing the last good results. |
| **public files differ from the published version** | `auditLive` (every minute) finds that a public file's sha256 is not the published one, or that the files disagree, in 2 runs in a row. Each run logs `AUDIT_LIVE_MISMATCH`; the alert needs 2 of them within 2 minutes. See [Why a publish never sets it off](#why-a-publish-never-sets-off-the-mismatch-alert). | admin.html shows a red banner with the details. Roll back to the last good version, or publish again (README › Election-night runbook). |
| **an admin action failed** | A callable (createDraft, publishDraft, …) failed with an unexpected error (`<method> failed` in the logs). | Read the error in the function logs (Logs Explorer, `severity>=ERROR`). Try again; a refused publish leaves the public files as they were. |

## Set up (once per project: staging first, then prod)

You need gcloud signed in with **Monitoring Admin** and **Logs Configuration Writer** on the project.

```
node tools/setup-monitoring.js --project hcec-election-results-staging --bucket hcec-election-results-staging-results --email elections@example.org --sms +14235551234 --dry-run
```

The dry run prints every gcloud command and the JSON it would send. Run it again without `--dry-run`.
It creates:

- the email and SMS notification channels;
- the uptime check;
- two log-based metrics (`audit_live_mismatch`, `callable_failed`);
- the three alert policies.

The SMS number uses the E.164 format (`+1` and ten digits). Then confirm the email channel from the
message Google sends. In the console (Monitoring › Alerting › Edit notification channels), send a
test notification to each channel.

Running the tool twice creates a second set. To list or delete what exists:

```
gcloud monitoring uptime list-configs --project=hcec-election-results-staging
gcloud alpha monitoring policies list --project=hcec-election-results-staging --format="table(name,displayName)"
gcloud logging metrics list --project=hcec-election-results-staging
gcloud beta monitoring channels list --project=hcec-election-results-staging
```

Delete one with the matching `delete` command and the name from the list.

## Test the alerts (staging, before every election)

Do this during the rehearsal (docs/REHEARSAL.md), on staging only.

1. **Mismatch alert:** publish any sample, then overwrite one public file with different bytes:

   ```
   gcloud storage cp gs://hcec-election-results-staging-results/current/reporting.json reporting.json
   echo " " >> reporting.json
   gcloud storage cp reporting.json gs://hcec-election-results-staging-results/current/reporting.json
   ```

   Within about a minute admin.html shows the red banner, and within about three minutes the email
   and SMS arrive (the alert waits for a second failing run). Fix it by
   publishing again or rolling back. The alert closes by itself once `auditLive` passes.
2. **Uptime alert:** move the manifest away for three minutes, then put it back:

   ```
   gcloud storage mv gs://hcec-election-results-staging-results/current/manifest.json gs://hcec-election-results-staging-results/current/manifest.json.bak
   gcloud storage mv gs://hcec-election-results-staging-results/current/manifest.json.bak gs://hcec-election-results-staging-results/current/manifest.json
   ```

   While it is missing, the public pages keep their last good results and show "Live updates delayed".
3. **Admin-action alert:** this one is hard to cause on purpose. Check that the policy exists, and
   leave it at that.

Write down when each alert arrived in the rehearsal sign-off.

## Why a publish never sets off the mismatch alert

A publish copies the new files into `current/` first and sets the published version last, so for a
few seconds the public files and the published version disagree. Three things keep that from
sending a false SMS:

1. `auditLive` skips its check while the publish lease (`publishLock`, 60 seconds) is held and has
   not expired. It reads the lease before and after it fetches the files, so a publish that starts or
   finishes during the check also skips it. It logs `publish in progress, audit skipped` (info) and
   writes a `skipped` entry to the audit log. The admin banner keeps its last result.
2. When it finds a mismatch, it waits 10 seconds and checks again. It reports only a mismatch that is
   still there.
3. The alert needs `AUDIT_LIVE_MISMATCH` from 2 runs in a row (2 entries within a 2-minute window).

A publish stuck past its 60-second lease is checked as normal, so a half-finished publish still alerts.

If a project was set up before the alert needed 2 runs, update its mismatch policy: run the tool with
`--dry-run`, save the second policy's JSON (`audit_live_mismatch`) to a file, find the policy's name
with `gcloud alpha monitoring policies list`, and run
`gcloud alpha monitoring policies update <name> --policy-from-file=<file>`.

## Notes

- Functions v2 run on Cloud Run, so the log metrics filter `resource.type="cloud_run_revision"`.
  `auditLive` runs only while an election is active.
- The uptime check reads the bucket through `storage.googleapis.com`, which is the same URL the pages use.
  A CDN in front would need its own check.
- The tool calls `gcloud alpha monitoring policies create`, because policies are created from a file.
  If your gcloud has moved that command to GA, drop `alpha` from `plan()` in the tool.
