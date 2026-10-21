'use strict';
// tools/setup-monitoring.js: argument checks, the commands and policies it builds, and the quoting
// it needs for gcloud.cmd on Windows. Running against GCP is a manual step (docs/MONITORING.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, uptimePolicy, logPolicy, plan, shellArgs, LOG_METRICS } = require('../../tools/setup-monitoring');

const OK = ['--project', 'hcec-election-results-staging', '--bucket', 'hcec-election-results-staging-results', '--email', 'elections@example.org'];

test('parseArgs: required values, and anything odd refused', () => {
  assert.deepEqual(parseArgs(OK), { dryRun: false, project: 'hcec-election-results-staging', bucket: 'hcec-election-results-staging-results', email: 'elections@example.org' });
  assert.equal(parseArgs([...OK, '--dry-run', '--sms', '+14235551234']).sms, '+14235551234');
  for (const [args, msg] of [
    [OK.slice(2), /--project is required/],
    [['--project', 'Bad_Project', ...OK.slice(2)], /not a project id/],
    [[...OK.slice(0, 2), '--bucket', 'a"b', ...OK.slice(4)], /not a bucket name/],
    [[...OK.slice(0, 4), '--email', 'x" & del'], /not an email address/],
    [[...OK.slice(0, 4), '--email', 'a%PATH%@example.org'], /not an email address/], // cmd.exe would expand it
    [[...OK.slice(0, 4), '--email', 'a@b'], /not an email address/],
    [[...OK, '--sms', '423-555-1234'], /E\.164/],
    [[...OK, '--force'], /unknown argument/],
  ]) assert.throws(() => parseArgs(args), msg);
});

test('plan: uptime check on current/manifest.json every minute from 3 regions; every command names the project', () => {
  const p = plan(parseArgs([...OK, '--sms', '+14235551234']));
  assert.equal(p.channels.length, 2);
  assert.ok(p.uptime.includes('--path=/hcec-election-results-staging-results/current/manifest.json'));
  assert.ok(p.uptime.includes('--period=1'));
  assert.ok(p.uptime.includes('--regions=usa-oregon,usa-iowa,usa-virginia'));
  assert.ok(p.uptime.includes('--matcher-content=dataVersion'));
  for (const cmd of [...p.channels, p.uptime, p.metric('m', 'f.json'), p.policy('p.json')]) {
    assert.equal(cmd[0], 'gcloud');
    assert.equal(cmd.at(-1), '--project=hcec-election-results-staging');
  }
  assert.equal(plan(parseArgs(OK)).channels.length, 1);
});

test('log metrics match what the functions log', () => {
  const [audit, failed] = LOG_METRICS;
  assert.match(audit[2], /jsonPayload\.message="AUDIT_LIVE_MISMATCH"/); // index.js: logger.error('AUDIT_LIVE_MISMATCH', …)
  assert.match(failed[2], /jsonPayload\.message=~" failed\$"/); // index.js: logger.error(`${method} failed`, …)
  for (const [, , filter] of LOG_METRICS) assert.match(filter, /severity>=ERROR/);
});

test('policies: uptime alert needs 2+ failing regions; log alerts fire on any entry; all notify the channels', () => {
  const u = uptimePolicy('abc123', ['projects/p/notificationChannels/1']);
  const c = u.conditions[0].conditionThreshold;
  assert.match(c.filter, /check_id="abc123"/);
  assert.equal(c.aggregations[0].crossSeriesReducer, 'REDUCE_COUNT_FALSE');
  assert.equal(c.comparison, 'COMPARISON_GT');
  assert.equal(c.thresholdValue, 1);
  assert.deepEqual(u.notificationChannels, ['projects/p/notificationChannels/1']);
  const l = logPolicy('audit_live_mismatch', 'T', 'D', ['ch']);
  assert.match(l.conditions[0].conditionThreshold.filter, /logging\.googleapis\.com\/user\/audit_live_mismatch/);
  assert.equal(l.conditions[0].conditionThreshold.thresholdValue, 0);
  assert.deepEqual(l.notificationChannels, ['ch']);
});

test('shellArgs: quoted for cmd.exe on Windows, untouched elsewhere; a double quote is refused', () => {
  const cmd = ['gcloud', 'monitoring', 'uptime', 'create', 'Election results manifest', '--format=value(name)', '--a=b&c'];
  assert.deepEqual(shellArgs(cmd, 'linux'), cmd);
  assert.deepEqual(shellArgs(cmd, 'win32'), ['gcloud', 'monitoring', 'uptime', 'create', '"Election results manifest"', '"--format=value(name)"', '"--a=b&c"']);
  assert.throws(() => shellArgs(['gcloud', '--x="y"'], 'win32'), /double quote/);
  // Every command the tool builds passes on Windows (filters live in files).
  const p = plan(parseArgs([...OK, '--sms', '+14235551234']));
  for (const c of [...p.channels, p.uptime, p.metric('m', 'C:\\t\\m.json'), p.policy('C:\\t\\p.json')]) assert.doesNotThrow(() => shellArgs(c, 'win32'));
});
