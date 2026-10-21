'use strict';
/**
 * The callable functions' logic (plan: Cloud Functions), over injected I/O so the whole contract
 * is tested with in-memory fakes (test/service.test.js) and again on the emulators.
 *
 * deps:
 *   db             get(path) / set(path, data) / update(path, partial) / add(collection, data) -> id
 *                  list(collection) -> [{id, data}] / transaction(async (tx) => …) with tx.get/set/update
 *   publicBucket   write(path, data, {contentType, cacheControl, gzip}) / read(path) -> Buffer|null
 *                  copy(from, to, {cacheControl}) / deletePrefix(prefix)
 *   privateBucket  write / read
 *   fetchLive(path) -> Buffer|null   the public URL of a public-bucket object, cache-busted
 *   now() -> ms
 *
 * Every method takes the already-authorised actor {uid, email} (index.js checks admins/{uid}).
 * Failures are ServiceError(code, message, details); codes are HttpsError codes.
 */
const { readCsv, CsvError } = require('./csv');
const { ParseError } = require('./parse');
const { buildResults } = require('./pipeline');
const { formatLastUpdated } = require('./outputs');
const { runChecks, runRollbackChecks, unreadableCheck } = require('./checks');
const { buildReview } = require('./review');
const { decodeUpload, UploadError } = require('./upload');
const { auditServed } = require('./audit');
const P = require('./publish');

class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

const NO_STORE = 'no-store';
const CONTENT_TYPES = { '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const contentType = (f) => CONTENT_TYPES[f.slice(f.lastIndexOf('.'))];
const DRAFT_FILES = [...P.PAGE_FILES, P.SUMMARY_FILE, ...P.REVIEW_FILES];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const paths = {
  election: (eid) => `elections/${eid}`,
  uploads: (eid) => `elections/${eid}/uploads`,
  upload: (eid, id) => `elections/${eid}/uploads/${id}`,
  draft: (eid, id) => `elections/${eid}/drafts/${id}`,
  version: (eid, v) => `elections/${eid}/versions/${v}`,
  rawUpload: (eid, id) => `uploads/${eid}/${id}.csv`,
  draftFile: (id, f) => `drafts/${id}/${f}`,
};

const latestFromDataJs = (text) => JSON.parse(text.replace(/^[^=]*= /, '').replace(/;\n$/, '')).latest;

function createService({ db, publicBucket, privateBucket, fetchLive, now = Date.now }) {
  const iso = (ms) => new Date(ms).toISOString();
  const audit = (actor, action, eid, detail, extra = {}) => db.add('audit', { action, eid, uid: actor.uid, email: actor.email, at: iso(now()), detail, ...extra });

  async function requireElection(eid) {
    if (!P.isElectionId(eid)) throw new ServiceError('invalid-argument', 'Bad election id.');
    const e = await db.get(paths.election(eid));
    if (!e) throw new ServiceError('not-found', `No election ${eid}.`);
    return e;
  }
  async function requireDraft(eid, draftId) {
    if (!P.isDraftId(draftId)) throw new ServiceError('invalid-argument', 'Bad draft id.');
    return db.get(paths.draft(eid, draftId));
  }
  async function readText(bucket, path) {
    const b = await bucket.read(path);
    return b === null ? null : b.toString('utf8');
  }
  const publishedLatest = async (eid, version) => {
    const text = version ? await readText(publicBucket, P.versionPath(eid, version, 'data.js')) : null;
    return text ? latestFromDataJs(text) : null;
  };
  /** sha256 of each stored draft object, as it is now. */
  async function rehash(draftId, files) {
    const out = {};
    await Promise.all(files.map(async (f) => {
      const b = await publicBucket.read(paths.draftFile(draftId, f));
      out[f] = b === null ? null : P.sha256Hex(b);
    }));
    return out;
  }
  async function writeDraftFiles(draftId, files) {
    await Promise.all(Object.entries(files).map(([f, text]) => publicBucket.write(paths.draftFile(draftId, f), text,
      { contentType: contentType(f), cacheControl: NO_STORE, gzip: true })));
    return Object.fromEntries(Object.entries(files).map(([f, text]) => [f, P.sha256Hex(text)]));
  }
  const electionView = (e) => ({ name: e.name, date: e.date, county: e.county, precinctCap: e.precinctCap ?? 92 });

  /** Creates a frozen draft from one uploaded export. */
  async function createDraft(actor, data) {
    const eid = data?.electionId;
    const election = await requireElection(eid);
    let upload;
    try {
      upload = decodeUpload(data);
    } catch (e) {
      if (e instanceof UploadError) throw new ServiceError(e.code === 'too-large' ? 'invalid-argument' : e.code, e.message);
      throw e;
    }
    const t = now();
    const uploadId = P.newDraftId();
    const draftId = P.newDraftId();
    const isEd = upload.kind === 'ed';
    const history = {
      uploadSha256s: (await db.list(paths.uploads(eid))).map((u) => u.data.sha256),
      lastPublishedFileTime: election.currentFileTime ?? null,
    };

    // Every upload is archived, even ones never published.
    const storagePath = paths.rawUpload(eid, uploadId);
    await privateBucket.write(storagePath, upload.text, { contentType: contentType('.csv') });
    await db.set(paths.upload(eid, uploadId), {
      kind: upload.kind, filename: upload.filename, sha256: upload.sha256, size: upload.size, storagePath,
      lastModified: upload.lastModified, uploadedAt: iso(t), uploadedBy: actor.email, draftId,
    });

    // The other slot keeps whatever is selected now (an Early upload keeps the ED file, and back).
    const otherId = isEd ? election.selectedEarlyUploadId ?? null : election.selectedEdUploadId ?? null;
    const otherDoc = otherId ? await db.get(paths.upload(eid, otherId)) : null;
    const otherText = otherDoc ? await readText(privateBucket, otherDoc.storagePath) : null;
    const precinctCap = election.precinctCap ?? 92;
    const settings = electionView(election);
    const current = await publishedLatest(eid, election.currentVersion);

    let checks;
    let result = null;
    const lines = [];
    let rows = [];
    try {
      rows = readCsv(upload.text, lines);
      result = buildResults(isEd ? { early: otherText, ed: upload.text } : { early: upload.text, ed: otherText }, {
        precinctCap,
        config: { enablePrecinctResults: election.enablePrecinctResults !== false, precinctCap },
        lastUpdated: formatLastUpdated(new Date(t)),
      });
      checks = runChecks({ kind: upload.kind, rows, result, current, election: settings, upload, history });
    } catch (e) {
      if (!(e instanceof CsvError || e instanceof ParseError)) throw e;
      checks = [unreadableCheck(e)];
      result = null;
    }

    let outputSha256 = {};
    if (result) {
      const { review, trace } = buildReview({
        result, current, source: { rows, lines }, election: settings,
        meta: { draftId, baseVersion: election.currentVersion ?? null, kind: upload.kind, filename: upload.filename, size: upload.size,
          sha256: upload.sha256, lastModified: upload.lastModified, uploadedAt: iso(t), uploadedBy: actor.email },
        otherSlot: otherDoc ? { kind: otherDoc.kind, filename: otherDoc.filename, uploadedAt: otherDoc.uploadedAt } : null,
      });
      outputSha256 = await writeDraftFiles(draftId, { ...result.outputs.files, 'review.json': JSON.stringify(review), 'trace.json': JSON.stringify(trace) });
    }
    const status = !result || checks.some((c) => c.severity === 'block') ? 'blocked' : 'ready';
    await db.set(paths.draft(eid, draftId), {
      status, kind: upload.kind, uploadId,
      earlyUploadId: isEd ? otherId : uploadId,
      edUploadId: isEd ? uploadId : otherId,
      baseVersion: election.currentVersion ?? null,
      dataVersion: result ? result.merged.dataVersion : null,
      confirmCount: result ? result.merged.overallPrecinctsReporting : null,
      fileTime: upload.lastModified,
      outputSha256, checks, rollbackOf: null,
      expiresAt: P.expiryFrom(t), createdAt: iso(t), createdBy: actor.email,
    });
    await audit(actor, 'draft', eid, `${upload.kind} ${upload.filename} -> ${status}`, { draftId });
    return { draftId, status, counts: countBy(checks) };
  }

  /** Builds a draft that republishes a stored version (same review and publish path). */
  async function createRollbackDraft(actor, data) {
    const eid = data?.electionId;
    const election = await requireElection(eid);
    const version = data?.version;
    const vdoc = typeof version === 'string' && /^[0-9a-f]{12}$/.test(version) ? await db.get(paths.version(eid, version)) : null;
    if (!vdoc) throw new ServiceError('not-found', `No published version ${version}.`);
    const files = {};
    for (const f of [...P.PAGE_FILES, P.SUMMARY_FILE]) {
      const text = await readText(publicBucket, P.versionPath(eid, version, f));
      if (text === null) throw new ServiceError('not-found', `Version ${version} is missing ${f}.`);
      files[f] = text;
    }
    const t = now();
    const draftId = P.newDraftId();
    const latest = latestFromDataJs(files['data.js']);
    const current = await publishedLatest(eid, election.currentVersion);
    const checks = runRollbackChecks({ latest, files, current, version, publishedAt: vdoc.publishedAt });
    const { review, trace } = buildReview({
      result: { merged: latest }, current, source: { rows: [], lines: [] }, election: electionView(election),
      meta: { draftId, baseVersion: election.currentVersion ?? null, kind: 'rollback', filename: `version ${version}`, size: 0, sha256: version, uploadedAt: iso(t), uploadedBy: actor.email },
    });
    const outputSha256 = await writeDraftFiles(draftId, { ...files, 'review.json': JSON.stringify(review), 'trace.json': JSON.stringify(trace) });
    const status = checks.some((c) => c.severity === 'block') ? 'blocked' : 'ready';
    await db.set(paths.draft(eid, draftId), {
      status, kind: 'rollback', uploadId: null, earlyUploadId: vdoc.earlyUploadId ?? null, edUploadId: vdoc.edUploadId ?? null,
      baseVersion: election.currentVersion ?? null, dataVersion: version, confirmCount: latest.overallPrecinctsReporting,
      fileTime: null, outputSha256, checks, rollbackOf: version, expiresAt: P.expiryFrom(t), createdAt: iso(t), createdBy: actor.email,
    });
    await audit(actor, 'rollback', eid, `draft to republish ${version} -> ${status}`, { draftId, version });
    return { draftId, status, counts: countBy(checks) };
  }

  /** The only path to current/. */
  async function publishDraft(actor, data) {
    const eid = data?.electionId;
    const election = await requireElection(eid);
    const draftId = data?.draftId;
    const draft = await requireDraft(eid, draftId);
    const acknowledged = data?.acknowledged ?? [];
    if (!Array.isArray(acknowledged) || acknowledged.length > 1000 || !acknowledged.every((k) => typeof k === 'string' && k.length < 100)) {
      throw new ServiceError('invalid-argument', 'Bad acknowledgements.');
    }
    const rehashed = draft ? await rehash(draftId, Object.keys(draft.outputSha256)) : null;
    const refusals = P.publishRefusals({ draft, election, acknowledged, confirmCount: data?.confirmCount, now: now(), rehashed });
    if (refusals.length) {
      if (refusals.some((r) => r.code === 'stale')) await db.update(paths.draft(eid, draftId), { status: 'stale' });
      throw new ServiceError(refusals[0].code === 'not-found' ? 'not-found' : 'failed-precondition', refusals.map((r) => r.detail).join(' '), { refusals });
    }

    // Serialise publishes: the lease and the base-version check in one transaction.
    const holder = draftId;
    await db.transaction(async (tx) => {
      const e = await tx.get(paths.election(eid));
      if ((e.currentVersion ?? null) !== (draft.baseVersion ?? null)) {
        throw new ServiceError('failed-precondition', 'Someone published after this draft was made. Create a new draft.', { refusals: [{ code: 'stale' }] });
      }
      try {
        tx.update(paths.election(eid), { publishLock: P.acquireLock(e.publishLock ?? null, { holder, now: now() }) });
      } catch (err) {
        throw new ServiceError('aborted', err.message, { refusals: [{ code: 'busy' }] });
      }
    });

    const t = now();
    const version = draft.dataVersion;
    try {
      for (const stage of P.copyPlan({ electionId: eid, draftId, dataVersion: version })) {
        await Promise.all(stage.map((s) => publicBucket.copy(s.from, s.to, { cacheControl: s.cacheControl })));
      }
      const manifest = JSON.stringify({
        dataVersion: version,
        updatedAt: iso(t),
        files: Object.fromEntries([...P.PAGE_FILES, P.SUMMARY_FILE].map((f) => [f, draft.outputSha256[f]])),
      });
      await publicBucket.write(P.versionPath(eid, version, P.MANIFEST_FILE), manifest, { contentType: contentType('.json'), cacheControl: P.IMMUTABLE, gzip: true });
      await publicBucket.write(`current/${P.MANIFEST_FILE}`, manifest, { contentType: contentType('.json'), cacheControl: P.LIVE, gzip: true });

      await db.transaction(async (tx) => {
        const e = await tx.get(paths.election(eid));
        if (e.publishLock?.holder !== holder) throw new ServiceError('aborted', 'Lost the publish lock; check History before retrying.');
        tx.update(paths.election(eid), {
          currentVersion: version, publishLock: null,
          selectedEarlyUploadId: draft.earlyUploadId ?? null, selectedEdUploadId: draft.edUploadId ?? null,
          currentFileTime: draft.fileTime ?? e.currentFileTime ?? null, updatedAt: iso(t), updatedBy: actor.email,
        });
        tx.update(paths.draft(eid, draftId), {
          status: 'published', publishedAt: iso(t), publishedBy: actor.email,
          acknowledgements: acknowledged.map((key) => ({ key, by: actor.email, at: iso(t) })),
        });
        tx.set(paths.version(eid, version), {
          draftId, earlyUploadId: draft.earlyUploadId ?? null, edUploadId: draft.edUploadId ?? null, rollbackOf: draft.rollbackOf ?? null,
          publishedAt: iso(t), publishedBy: actor.email, checks: draft.checks.map((c) => ({ key: c.key, severity: c.severity, title: c.title })),
          acknowledgements: acknowledged, publicPath: P.versionPath(eid, version, ''), liveCheck: null,
        });
      });
    } catch (err) {
      await db.transaction(async (tx) => {
        const e = await tx.get(paths.election(eid));
        tx.update(paths.election(eid), { publishLock: P.releaseLock(e.publishLock ?? null, { holder }) });
      });
      throw err;
    }

    // Live check: what the public URL serves now must be the bytes that were reviewed.
    const served = await fetchLive(`current/${P.SUMMARY_FILE}`);
    const liveCheck = { ok: served !== null && P.sha256Hex(served) === draft.outputSha256[P.SUMMARY_FILE], at: iso(now()) };
    await db.update(paths.version(eid, version), { liveCheck });
    await audit(actor, 'publish', eid, `${version}${draft.rollbackOf ? ' (rollback)' : ''}; live check ${liveCheck.ok ? 'passed' : 'FAILED'}`, { draftId, version });
    return { dataVersion: version, liveCheck };
  }

  async function extendDraft(actor, data) {
    const eid = data?.electionId;
    const election = await requireElection(eid);
    const draft = await requireDraft(eid, data?.draftId);
    const rehashed = draft ? await rehash(data.draftId, Object.keys(draft.outputSha256)) : null;
    const refusals = P.extendRefusals({ draft, election, now: now(), rehashed });
    if (refusals.length) throw new ServiceError(refusals[0].code === 'not-found' ? 'not-found' : 'failed-precondition', refusals.map((r) => r.detail).join(' '), { refusals });
    const expiresAt = P.expiryFrom(now());
    await db.update(paths.draft(eid, data.draftId), { expiresAt });
    return { expiresAt };
  }

  async function discardDraft(actor, data) {
    const eid = data?.electionId;
    await requireElection(eid);
    const draft = await requireDraft(eid, data?.draftId);
    if (!draft) throw new ServiceError('not-found', 'No such draft.');
    if (!['ready', 'blocked', 'stale'].includes(draft.status)) throw new ServiceError('failed-precondition', `Draft is ${draft.status}.`);
    await publicBucket.deletePrefix(`drafts/${data.draftId}/`);
    await db.update(paths.draft(eid, data.draftId), { status: 'discarded', discardedAt: iso(now()), discardedBy: actor.email });
    await audit(actor, 'discard', eid, `discarded ${data.draftId}`, { draftId: data.draftId });
    return { ok: true };
  }

  /** Creates or edits an election's settings; never touches what is published. */
  async function upsertElection(actor, data) {
    const s = validateSettings(data);
    const path = paths.election(s.id);
    const existing = await db.get(path);
    const doc = {
      name: s.name, date: s.date, county: s.county, precinctCap: s.precinctCap, enablePrecinctResults: s.enablePrecinctResults,
      updatedAt: iso(now()), updatedBy: actor.email,
    };
    if (existing) await db.update(path, doc);
    else await db.set(path, { ...doc, active: false, currentVersion: null, selectedEarlyUploadId: null, selectedEdUploadId: null, publishLock: null, createdAt: iso(now()) });
    if (s.makeActive) {
      for (const { id, data: e } of await db.list('elections')) {
        if (id !== s.id && e.active) await db.update(paths.election(id), { active: false });
      }
      await db.update(path, { active: true });
    }
    await audit(actor, 'settings', s.id, `${existing ? 'updated' : 'created'}: ${JSON.stringify(doc)}${s.makeActive ? '; made active' : ''}`);
    return { id: s.id, created: !existing };
  }

  /** auditLive: re-verify what the public URLs serve against the published version. */
  async function auditLive(actor, data) {
    const eid = data?.electionId;
    const election = await requireElection(eid);
    const files = {};
    await Promise.all([...P.PAGE_FILES, P.SUMMARY_FILE].map(async (f) => {
      const b = await fetchLive(`current/${f}`);
      files[f] = b === null ? null : b.toString('utf8');
    }));
    const manifest = await fetchLive(`current/${P.MANIFEST_FILE}`);
    const result = election.currentVersion
      ? auditServed({ manifestText: manifest === null ? null : manifest.toString('utf8'), files, expectedVersion: election.currentVersion })
      : { ok: true, problems: [] };
    await audit(actor, 'auditLive', eid, result.ok ? 'ok' : result.problems.join('; '), { ok: result.ok });
    return result;
  }

  return { createDraft, createRollbackDraft, publishDraft, extendDraft, discardDraft, upsertElection, auditLive };
}

function countBy(checks) {
  return { block: checks.filter((c) => c.severity === 'block').length, warn: checks.filter((c) => c.severity === 'warn').length, info: checks.filter((c) => c.severity === 'info').length };
}

/** upsertElection input -> clean settings, or ServiceError('invalid-argument') naming the field and the fix. */
function validateSettings(d) {
  const bad = (field, fix) => { throw new ServiceError('invalid-argument', `${field}: ${fix}`, { field }); };
  if (!d || typeof d !== 'object') bad('settings', 'missing');
  if (!P.isElectionId(d.id)) bad('id', 'use lower-case letters, digits and dashes, e.g. 2026-11-03-general');
  const text = (k, max) => (typeof d[k] === 'string' && d[k].trim() && d[k].length <= max ? d[k].trim() : bad(k, `required, at most ${max} characters`));
  const name = text('name', 200);
  const county = text('county', 100);
  if (typeof d.date !== 'string' || !DATE_RE.test(d.date) || Number.isNaN(Date.parse(`${d.date}T00:00:00Z`))
    || new Date(`${d.date}T00:00:00Z`).toISOString().slice(0, 10) !== d.date) bad('date', 'use YYYY-MM-DD, e.g. 2026-11-03');
  const cap = d.precinctCap ?? 92;
  if (!Number.isInteger(cap) || cap < 1 || cap > 999) bad('precinctCap', 'Max precincts must be a whole number from 1 to 999');
  if (d.enablePrecinctResults !== undefined && typeof d.enablePrecinctResults !== 'boolean') bad('enablePrecinctResults', 'true or false');
  if (d.makeActive !== undefined && typeof d.makeActive !== 'boolean') bad('makeActive', 'true or false');
  return { id: d.id, name, date: d.date, county, precinctCap: cap, enablePrecinctResults: d.enablePrecinctResults !== false, makeActive: d.makeActive === true };
}

module.exports = { createService, ServiceError, validateSettings, paths };
