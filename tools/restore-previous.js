'use strict';
/**
 * tools/staging-election.js, at the end of a run: gives the election that was active before the run
 * back its place, with the public files it had. current/ is one set per bucket, so a run that
 * published leaves the test election's files there; auditLive (every minute, the active election
 * only) would then flag a mismatch for the previous election (staging alert 2026-11-20).
 *
 * Decided from what current/manifest.json serves now, not from what the run did:
 *   - already right (its currentVersion, or the "no election" manifest for a cleared election, or
 *     nothing for an election that never published): it is only made active again;
 *   - cleared (docs/ARCHIVE.md): made active, the no-election state is put back with
 *     clearCurrentResults (never its old results), then made active again, as it was;
 *   - published: made active, and its currentVersion republished through a rollback draft;
 *   - never published, but current/ serves something: nothing of its own to put back, so the test
 *     election stays active (its files are what current/ serves), with a WARNING.
 * Every step goes through the callables the admin page uses (upsertElection, createRollbackDraft,
 * publishDraft, clearCurrentResults); no Firestore or bucket writes of its own.
 *
 * deps: call(name, data) a callable as the bot admin; getElection(id) and getDraft(eid, draftId)
 * Firestore reads; readManifest() current/manifest.json parsed, or null; log / warn / error.
 * Returns { ok, action }: ok false (with an error printed) when the previous election is not restored.
 */
async function restorePrevious({ previous, electionId, call, getElection, getDraft, readManifest, log = console.log, error = console.error }) {
  const prev = await getElection(previous);
  if (!prev) {
    error(`FAIL: ${previous} no longer exists; ${electionId} stays the active election.`);
    return { ok: false, action: 'missing' };
  }
  const manifest = await readManifest();
  const served = manifest?.dataVersion ?? null;
  const noElection = Boolean(manifest?.noElection);
  // The service's own defaults (service.js validateSettings / pageConfig) for fields an older doc lacks.
  const activate = () => call('upsertElection', {
    id: previous, name: prev.name, date: prev.date, county: prev.county ?? 'Hamilton', precinctCap: prev.precinctCap ?? 92,
    enablePrecinctResults: prev.enablePrecinctResults !== false, makeActive: true,
  });
  const back = () => log(`${previous} is the active election again.`);

  const right = prev.cleared ? noElection : prev.currentVersion ? served === prev.currentVersion : !manifest;
  if (right) {
    await activate();
    back();
    return { ok: true, action: 'activated' };
  }
  if (prev.cleared) {
    await activate();
    await call('clearCurrentResults', { electionId: previous });
    await activate(); // clearing makes it inactive; it was active (a cleared election made active again)
    back();
    log(`${previous} was cleared: current/ says "no current election" again.`);
    return { ok: true, action: 'cleared' };
  }
  if (!prev.currentVersion) {
    log(`WARNING: ${previous} has no published version to put back on the public pages, so ${electionId} stays the active election (its files are what current/ serves). Make ${previous} active in its settings when wanted.`);
    return { ok: true, action: 'left' };
  }
  await activate();
  back();
  const version = prev.currentVersion;
  const d = await call('createRollbackDraft', { electionId: previous, version });
  if (d.status !== 'ready') {
    error(`FAIL: the rollback draft to put ${previous}'s ${version} back is ${d.status}; current/ still serves ${served ?? 'nothing'}.`);
    return { ok: false, action: 'rollback' };
  }
  const doc = await getDraft(previous, d.draftId);
  const r = await call('publishDraft', {
    electionId: previous, draftId: d.draftId, acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key),
    confirmCount: doc.confirmCount, baseVersion: doc.baseVersion,
  });
  if (!r.liveCheck?.ok || r.dataVersion !== version) {
    error(`FAIL: republishing ${previous}'s ${version} gave ${r.dataVersion}, live check ${r.liveCheck?.ok ? 'ok' : 'FAILED'}.`);
    return { ok: false, action: 'rollback' };
  }
  log(`${previous}'s ${version} is back on the public pages (rollback draft ${d.draftId.slice(0, 8)}, live check ok).`);
  return { ok: true, action: 'rollback' };
}

module.exports = { restorePrevious };
