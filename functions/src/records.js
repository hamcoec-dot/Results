'use strict';
/**
 * Post-election records export (plan: Rehearsal and election-night assurance › Post-election): the
 * audit log and every version's files and acknowledgements, as one ZIP kept for records retention.
 * Over the same injected interfaces as service.js (db get/list, bucket read), so it is tested on the
 * in-memory fakes; tools/export-election.js wires it to Firestore and Storage.
 *
 * Layout of the archive:
 *   README.txt                   what this is, when and by whom it was made
 *   election.json                the election doc (settings, current version)
 *   versions/<v>/record.json     the version doc: publish time and user, checks, acknowledgements, live check
 *   versions/<v>/<file>          the published files, exactly as served (summary, reporting, precincts, data.js, manifest)
 *   drafts/<id>.json             every draft doc still on record (acknowledgement keys, who and when)
 *   uploads/<id>.json, .csv      every uploaded export: metadata and the raw file as uploaded
 *   audit.json                   the election's audit entries, oldest first
 *   SHA256SUMS                   sha256 of every other entry (`sha256sum -c` format)
 */
const { buildZip } = require('./zip');
const { isElectionId, sha256Hex, versionPath, PAGE_FILES, SUMMARY_FILE, MANIFEST_FILE } = require('./publish');

const VERSION_FILES = [...PAGE_FILES, SUMMARY_FILE, MANIFEST_FILE];
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * @param {object} deps  { db, publicBucket, privateBucket, now }
 * @param {string} eid
 * @param {{by?: string}} [opts]  who ran the export (for README.txt)
 * @returns {Promise<{zip: Buffer, entries: string[], missing: string[]}>} missing: objects named by a
 *   record that could not be read (reported in README.txt too, so a gap is never silent)
 */
async function exportElectionRecords({ db, publicBucket, privateBucket, now = Date.now }, eid, { by = 'unknown' } = {}) {
  if (!isElectionId(eid)) throw new TypeError(`bad election id: ${JSON.stringify(eid)}`);
  const election = await db.get(`elections/${eid}`);
  if (!election) throw new Error(`No election ${eid}.`);

  const files = [];
  const missing = [];
  const add = (name, data) => files.push({ name, data });
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  add('election.json', json({ id: eid, ...election }));

  const versions = (await db.list(`elections/${eid}/versions`)).sort((a, b) => String(a.data.publishedAt).localeCompare(String(b.data.publishedAt)) || byId(a, b));
  for (const v of versions) {
    add(`versions/${v.id}/record.json`, json({ dataVersion: v.id, ...v.data }));
    for (const f of VERSION_FILES) {
      const object = versionPath(eid, v.id, f);
      const b = await publicBucket.read(object);
      if (b === null) missing.push(object);
      else add(`versions/${v.id}/${f}`, b);
    }
  }

  for (const d of (await db.list(`elections/${eid}/drafts`)).sort(byId)) add(`drafts/${d.id}.json`, json({ draftId: d.id, ...d.data }));

  for (const u of (await db.list(`elections/${eid}/uploads`)).sort(byId)) {
    add(`uploads/${u.id}.json`, json({ uploadId: u.id, ...u.data }));
    const b = u.data.storagePath ? await privateBucket.read(u.data.storagePath) : null;
    if (b === null) missing.push(u.data.storagePath || `uploads/${u.id} (no storagePath)`);
    else add(`uploads/${u.id}.csv`, b);
  }

  const audit = (await db.list('audit')).filter((a) => a.data.eid === eid)
    .sort((a, b) => String(a.data.at).localeCompare(String(b.data.at)) || byId(a, b))
    .map((a) => ({ id: a.id, ...a.data }));
  add('audit.json', json(audit));

  const at = new Date(now());
  const readme = [
    `Election results records: ${election.name ?? eid} (${eid})`,
    `Exported ${at.toISOString()} by ${by}.`,
    '',
    `${versions.length} published version(s), ${files.filter((f) => f.name.startsWith('drafts/')).length} draft record(s), `
      + `${files.filter((f) => f.name.endsWith('.csv')).length} uploaded file(s), ${audit.length} audit entr${audit.length === 1 ? 'y' : 'ies'}.`,
    `Current version: ${election.currentVersion ?? 'none'}.`,
    '',
    'versions/<v>/ holds each published version exactly as it was served, with record.json (who published it, when,',
    'the checks and the acknowledged warnings). SHA256SUMS lists the sha256 of every entry; check with `sha256sum -c SHA256SUMS`.',
    ...(missing.length ? ['', `MISSING (named by a record but not found in storage): ${missing.length}`, ...missing.map((m) => `  ${m}`)] : []),
    '',
  ].join('\n');
  files.unshift({ name: 'README.txt', data: readme });
  const sums = files.map((f) => `${sha256Hex(f.data)}  ${f.name}`).join('\n') + '\n';
  files.push({ name: 'SHA256SUMS', data: sums });

  return { zip: buildZip(files, { date: at }), entries: files.map((f) => f.name), missing };
}

module.exports = { exportElectionRecords };
