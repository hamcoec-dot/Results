# Post-election records export

After the election is certified, export its records and keep the ZIP with the election's files (plan:
Rehearsal and election-night assurance › Post-election). Drafts expire from the public bucket after 2 days
and the version archive could be cleaned up later, so do this once the night is over.

```bash
gcloud auth application-default login        # an account that can read Firestore and both buckets
node tools/export-election.js 2026-11-03-general --out 2026-11-03-general-records.zip
```

- `--project hcec-election-results` is the default.
- `--private-bucket <name>` overrides the uploads bucket. The default is `<project>.appspot.com`; projects created
  since late 2024 use `<project>.firebasestorage.app`.
- Rehearsal: `node tools/export-election.js 2026-11-03-general --emulator` against the local emulators.

The tool exits 1 and prints a warning when a record names a file that storage no longer has. The archive is
still written, and its README.txt lists the gaps.

## What the ZIP holds
| Entry | Content |
|---|---|
| `README.txt` | what was exported, when, by whom; counts; anything missing |
| `election.json` | the election's settings and current version |
| `versions/<v>/record.json` | who published version `<v>` and when, its checks, the acknowledged warnings, the live check |
| `versions/<v>/summary.json` … `manifest.json`, `data.js` | the files exactly as they were served for that version |
| `drafts/<id>.json` | every draft on record, with acknowledgements (who, when) for the published ones |
| `uploads/<id>.json`, `uploads/<id>.csv` | each uploaded export's metadata and the raw file as uploaded |
| `audit.json` | the election's audit log, oldest first |
| `SHA256SUMS` | sha256 of every other entry |

Check the archive after copying it:

```bash
unzip -d records 2026-11-03-general-records.zip
cd records && sha256sum -c SHA256SUMS
```
