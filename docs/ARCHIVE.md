# Official archive and "no current election"

When an election is certified, its election-night (unofficial) results are kept as an **official
archive** on the results site, with their own pages, and the live results pages are **cleared** until the
next election. Both are done from the admin page, under **After certification**. Nothing else is needed:
no code change, no deploy, no GitHub step.

## Steps

1. **Publish the certified results** as usual (upload the final export, review, publish), so what is live
   is exactly what was certified.
2. **Create the official archive.** Admin page › After certification: enter the **Certified on** date
   and click **Create official archive**, then confirm. The live pages do not change.
3. Open the archive links shown there and check them.
4. **Clear public results.** Same card, **Clear public results**, then confirm. The button is enabled
   only once the version that is live has been archived.
5. After any change to the site's pages, purge the Cloudflare cache (Caching › Configuration ›
   Purge Everything), as for any page change. Archiving and clearing themselves need no purge: they
   change data, not pages.

Also keep the records ZIP for the election ([RECORDS.md](RECORDS.md)): the archive is what the public
sees, the ZIP is the complete record (every upload, version and acknowledgement).

## What the public sees

| Address | Shows |
|---|---|
| `/Results/archive.html` | Past Election Results: every archived election, newest first, with links to its pages |
| `/Results/index.html?election=<election id>` | That election's summary, labelled OFFICIAL RESULTS, with a banner "Official results of the … certified <date>" |
| `/Results/precincts.html?election=<election id>` | Its precinct results (if the Precinct Results page was on) |
| `/Results/reporting.html?election=<election id>` | Its reporting status |
| `/Results/` (after clearing) | "There is no current election. … Please come back at a later time", with a link to past results |

For example, `https://govotehamiltontn.gov/Results/index.html?election=2026-11-03-general`. These
addresses can be linked to directly and stay the same for good. Archived pages never update by
themselves, and their links to the other pages stay in the same archive.

## What happens behind the buttons

- **Create official archive** (`archiveElection`) copies the live version's four files from
  `elections/<id>/v/<version>/` in the public results bucket to `archive/<id>/`, with the status label set
  to OFFICIAL RESULTS and the certification date added (the numbers are not touched), writes a
  `manifest.json` with their sha256, and adds the election to `archive/index.json`. Doing it again
  (after a correction is published) replaces that election's archive. It is in the audit log.
- **Clear public results** (`clearCurrentResults`) holds the publish lease, replaces
  `current/manifest.json` with `{"noElection":true,"dataVersion":null,…}` and deletes the data files in
  `current/`, and makes the election inactive. Open pages switch to the message within a minute. The
  uptime check still passes (it looks for `dataVersion`), and the minute-by-minute live check stops
  (no active election).
- **Next election:** create it, make it active, and publish its Zero report as usual. The first publish
  replaces the "no election" manifest and every open page shows the new results.
- **Undo a clear:** make the cleared election active again (Election settings), then **Create draft
  with these settings** and publish it. The live check stays quiet until that publish.

The archive is in the same bucket as the live results, so the bucket must never be emptied: only
`drafts/` expires (lifecycle.json).
