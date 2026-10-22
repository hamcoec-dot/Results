#!/usr/bin/env node
'use strict';
/**
 * One-time Cloud Monitoring setup for one project (plan: Rehearsal and election-night assurance):
 *   1. email (and optionally SMS) notification channels;
 *   2. an uptime check on <bucket>/current/manifest.json every minute from 3 regions, which must
 *      contain "dataVersion";
 *   3. alert: the uptime check fails in 2 or more regions;
 *   4. a log-based metric and alert for auditLive's AUDIT_LIVE_MISMATCH (the public files differ
 *      from the published version), on 2 entries within 2 minutes, i.e. 2 runs in a row;
 *   5. a log-based metric and alert for any callable that fails ("<method> failed").
 *
 * Usage (needs gcloud signed in with Monitoring Admin and Logs Configuration Writer):
 *   node tools/setup-monitoring.js --project hcec-election-results-staging \
 *     --bucket hcec-election-results-staging-results --email elections@example.org [--sms +14235551234]
 * Add --dry-run to print the gcloud commands and files without running them. Running it twice
 * creates a second set; docs/MONITORING.md shows how to list and delete them.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (['--project', '--bucket', '--email', '--sms'].includes(a)) out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['project', 'bucket', 'email']) if (!out[k]) throw new Error(`--${k} is required`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(out.project)) throw new Error(`not a project id: ${out.project}`);
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(out.bucket)) throw new Error(`not a bucket name: ${out.bucket}`);
  // Plain address characters only: on Windows the value passes through cmd.exe, which expands %VAR% even in quotes.
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(out.email)) throw new Error(`not an email address: ${out.email}`);
  if (out.sms && !/^\+[1-9]\d{7,14}$/.test(out.sms)) throw new Error(`SMS number must be E.164, e.g. +14235551234: ${out.sms}`);
  return out;
}

/** The uptime check's alert: failing in 2+ regions for a minute (one region blipping is not an outage). */
function uptimePolicy(checkId, channels) {
  return {
    displayName: 'Election results: manifest.json unreachable',
    documentation: { mimeType: 'text/markdown', content: 'The public results manifest failed its uptime check in 2 or more regions. Open a public page; see README › Troubleshooting.' },
    combiner: 'OR',
    conditions: [{
      displayName: 'Uptime check failing in 2+ regions',
      conditionThreshold: {
        filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id="${checkId}" AND resource.type="uptime_url"`,
        aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.label.*'] }],
        comparison: 'COMPARISON_GT',
        thresholdValue: 1,
        duration: '60s',
        trigger: { count: 1 },
      },
    }],
    notificationChannels: channels,
    alertStrategy: { autoClose: '1800s' },
  };
}

/**
 * An alert on a log-based metric: by default on any entry within a minute. With minCount n, it
 * needs n entries within n minutes (a rolling window): for a once-a-minute job such as auditLive,
 * that is n runs in a row, so one odd minute never pages anyone.
 */
function logPolicy(metric, title, doc, channels, { minCount = 1 } = {}) {
  return {
    displayName: title,
    documentation: { mimeType: 'text/markdown', content: doc },
    combiner: 'OR',
    conditions: [{
      displayName: `${metric} >= ${minCount} in ${minCount} min`,
      conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${metric}" AND resource.type="cloud_run_revision"`,
        aggregations: [{ alignmentPeriod: `${60 * minCount}s`, perSeriesAligner: 'ALIGN_SUM' }],
        comparison: 'COMPARISON_GT',
        thresholdValue: minCount - 1,
        duration: '0s',
        trigger: { count: 1 },
      },
    }],
    notificationChannels: channels,
    alertStrategy: { autoClose: '1800s' },
  };
}

// Firebase's logger writes jsonPayload.message; Functions v2 run on Cloud Run.
const LOG_METRICS = [
  ['audit_live_mismatch', 'auditLive found the public files differ from the published version',
    'resource.type="cloud_run_revision" AND severity>=ERROR AND jsonPayload.message="AUDIT_LIVE_MISMATCH"'],
  ['callable_failed', 'An admin action (createDraft, publishDraft, ...) failed with an unexpected error',
    'resource.type="cloud_run_revision" AND severity>=ERROR AND jsonPayload.message=~" failed$"'],
];

/** The gcloud commands. Filters and descriptions go in files: they hold quotes and >=. */
function plan(o) {
  const g = (...args) => ['gcloud', ...args, `--project=${o.project}`];
  return {
    channels: [
      g('beta', 'monitoring', 'channels', 'create', '--display-name=Election results email', '--type=email', `--channel-labels=email_address=${o.email}`, '--format=value(name)'),
      ...(o.sms ? [g('beta', 'monitoring', 'channels', 'create', '--display-name=Election results SMS', '--type=sms', `--channel-labels=number=${o.sms}`, '--format=value(name)')] : []),
    ],
    uptime: g('monitoring', 'uptime', 'create', 'Election results manifest',
      '--resource-type=uptime-url', `--resource-labels=host=storage.googleapis.com,project_id=${o.project}`,
      `--path=/${o.bucket}/current/manifest.json`, '--protocol=https', '--validate-ssl=true', '--period=1', '--timeout=10',
      '--regions=usa-oregon,usa-iowa,usa-virginia', '--matcher-content=dataVersion', '--matcher-type=contains-string', '--format=value(name)'),
    metric: (name, file) => g('logging', 'metrics', 'create', name, `--config-from-file=${file}`),
    policy: (file) => g('alpha', 'monitoring', 'policies', 'create', `--policy-from-file=${file}`, '--format=value(name)'),
  };
}

/**
 * gcloud is gcloud.cmd on Windows, which Node runs only through cmd.exe, and Node does not quote
 * arguments for it: each one with a space or a cmd character is wrapped in "…". No argument may
 * hold a double quote (none does: the filters are in files).
 */
function shellArgs(cmd, platform = process.platform) {
  if (platform !== 'win32') return cmd;
  return cmd.map((a) => {
    if (a.includes('"')) throw new Error(`argument holds a double quote: ${a}`);
    return /[\s&|<>()^%!,;=]/.test(a) ? `"${a}"` : a;
  });
}

/**
 * The three alert policies. The mismatch alert needs 2 auditLive runs in a row: auditLive already
 * skips audits during a publish and re-checks a mismatch, and this is the last guard against a
 * false SMS on election night. A real mismatch still alerts, about a minute later.
 */
function allPolicies(checkId, channels) {
  return [
    uptimePolicy(checkId, channels),
    logPolicy('audit_live_mismatch', 'Election results: public files differ from the published version',
      'auditLive found a mismatch in 2 runs in a row. The admin page shows a red banner with the details. Roll back or republish; see README › Troubleshooting.', channels,
      { minCount: 2 }),
    logPolicy('callable_failed', 'Election results: an admin action failed',
      'A callable failed with an unexpected error. Check the function logs for "<method> failed".', channels),
  ];
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const p = plan(o);
  const run = (cmd) => {
    console.log(`$ ${shellArgs(cmd, 'win32').join(' ')}`);
    if (o.dryRun) return `projects/${o.project}/dry-run/${cmd[3] || cmd[1]}`;
    const [bin, ...args] = shellArgs(cmd);
    return execFileSync(bin, args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcec-monitoring-'));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    if (o.dryRun) console.log(fs.readFileSync(file, 'utf8'));
    return file;
  };

  const channels = p.channels.map(run);
  const checkId = run(p.uptime).split('/').pop(); // projects/<p>/uptimeCheckConfigs/<id>
  for (const [name, description, filter] of LOG_METRICS) run(p.metric(name, write(`metric-${name}.json`, { description, filter })));
  const policies = allPolicies(checkId, channels);
  policies.forEach((policy, i) => run(p.policy(write(`policy-${i}.json`, policy))));
  console.log(`\nDone: ${channels.length} channel(s), uptime check ${checkId}, ${LOG_METRICS.length} log metrics, ${policies.length} alert policies.`);
  console.log('Confirm the email (and SMS) channel, then test the alerts: docs/MONITORING.md.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { parseArgs, uptimePolicy, logPolicy, allPolicies, plan, shellArgs, LOG_METRICS };
