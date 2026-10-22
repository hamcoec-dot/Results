# Load test runbook (staging)

Plan: Test strategy, layer 14. Two tools, both read only the public bucket and need no credentials.

| Tool | What it simulates | When |
|---|---|---|
| `tools/load-manifest.js` | a burst of `current/manifest.json` fetches (no cache-buster: the edge cache) | every staging deploy (`deploy-target.yml`) |
| `tools/load-election-night.js` | thousands of open public pages doing what `app.js` does, while someone publishes | once before the rehearsal, by hand, below |

Both need something published to the bucket first (the manifest is a 404 until then).

## What the election-night test does
Each simulated page is the summary page (70 %), the reporting page (20 %) or the precinct page (10 %).
Like the real pages, it polls `current/manifest.json` every 60 s with a `?t=` cache-buster, and when the
`dataVersion` changes it fetches its page files (`summary.json`, `reporting.json` or `precincts.json`) and
checks each carries the manifest's `dataVersion`, as `validate.js` does before anything is shown.
The first polls are spread over one interval, as visitors arrive over time.

It fails (exit 1) on any HTTP or network error, a p95 over 300 ms for the manifest or the data files, or
fewer new versions than `--expect-publishes`. A "version mismatch" (a page caught the files of one publish
and the manifest of another) is reported but does not fail the run: the real page keeps its last data and
retries on its next poll.

## Steps: 10 publishes in a row under load
Two people: the **operator** publishes on the staging admin page, the **runner** runs the tool.

1. Make sure the staging election has a published version (the manifest URL below answers 200).
2. The runner starts the test for 15 minutes with 2,000 pages, from any computer with Node 22 or from
   GitHub Codespaces (so the load does not share the operator's connection):
   ```bash
   node tools/load-election-night.js https://storage.googleapis.com/hcec-election-results-staging-results/ \
     --pages 2000 --duration 900 --expect-publishes 10
   ```
3. Within the 15 minutes the operator uploads and publishes 10 files in a row on the staging admin page
   (`Test_Files/Web Results Samples` 00 to 06, then rollbacks from the History table until there are 10).
   Note the time each publish was clicked.
4. When the tool finishes, check the report:
   - `OK` on the last line;
   - each `version …: on 2000 of 2000 pages, all within N s of the first` with N at most about 75 s
     (one 60 s poll interval plus the request time). That is the longest a visitor waits for new numbers;
   - `errors: 0`.
5. Paste the report into the rehearsal log (docs/REHEARSAL.md) with the publish times.

For a heavier run, start the same command on two or three computers at once: each adds 2,000 pages.

## Reading the numbers
- **Manifest polls per second** ≈ pages ÷ 60. 2,000 pages is about 33 requests a second, steady.
- **Data-file fetches** come in a burst after each publish, as every page sees the new version within one
  poll interval.
- Every request carries a cache-buster, so these numbers are Cloud Storage itself, not the edge cache.
  `--no-bust` measures the edge cache instead (what `load-manifest.js` does on each deploy).

## Production
Do not run the load test against the production bucket on election night. Once, before the rehearsal, a
short run (`--pages 200 --duration 120`) against production is enough to show the same latency there.
