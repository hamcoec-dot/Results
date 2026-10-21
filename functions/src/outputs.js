'use strict';
/**
 * Port of the output half of convert_data.generate_data_js (convert_data.py:518-621): builds the
 * four files the public pages read, serialized exactly as Python's json.dump does (compact
 * separators, ensure_ascii), so the legacy Python fallback and this port publish identical bytes.
 *
 * Fix d4: metadata.lastUpdated is the real time, not the "November 5, 2024 08:45 PM" placeholder.
 */
const { pyDumps } = require('./pycompat');

const DATA_JS_HEADER = '// Auto-generated Election Night Results Data\nwindow.ELECTION_DATA = ';
const LEGACY_LAST_UPDATED = 'November 5, 2024 08:45 PM';

/** "November 5, 2024 08:45 PM" for a Date, in America/New_York (the placeholder's format). */
function formatLastUpdated(date, timeZone = 'America/New_York') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()}`;
}

/**
 * @param {object} merged  mergeParsedData(...).data
 * @param {{config: object, lastUpdated: string}} opts
 *   config       the page config block, e.g. {enablePrecinctResults, precinctCap}
 *   lastUpdated  display time (formatLastUpdated(new Date()) in production)
 * @returns {{objects: object, files: {'summary.json': string, 'reporting.json': string, 'precincts.json': string, 'data.js': string}}}
 */
function buildOutputs(merged, { config, lastUpdated }) {
  const metadata = {
    electionTitle: merged.electionTitle,
    electionDate: merged.electionDate,
    county: merged.county,
    statusLabel: merged.statusLabel,
    dataVersion: merged.dataVersion,
    lastUpdated,
  };

  const bundle = { metadata, config, latest: merged };

  const summary = {
    metadata,
    config,
    latest: {
      electionTitle: merged.electionTitle,
      electionDate: merged.electionDate,
      county: merged.county,
      statusLabel: merged.statusLabel,
      totalVoters: merged.totalVoters,
      totalBallots: merged.totalBallots,
      ballotsRep: merged.ballotsRep,
      ballotsDem: merged.ballotsDem,
      ballotsGen: merged.ballotsGen,
      turnoutPercent: merged.turnoutPercent,
      overallPrecinctsReporting: merged.overallPrecinctsReporting,
      overallPrecinctsTotal: merged.overallPrecinctsTotal,
      hasEarlyUpload: merged.hasEarlyUpload,
      earlyVotingReporting: merged.earlyVotingReporting,
      earlyVotingTotal: merged.earlyVotingTotal,
      earlyBallotsCast: merged.earlyBallotsCast,
      contests: merged.contests.map((c) => ({
        title: c.title,
        voteFor: c.voteFor,
        precinctsReporting: c.precinctsReporting,
        precinctsTotal: c.precinctsTotal,
        totalVotes: c.totalVotes,
        candidates: c.candidates,
      })),
    },
  };

  const reporting = {
    metadata,
    config,
    masterPrecincts: merged.masterPrecincts,
    latest: {
      overallPrecinctsReporting: merged.overallPrecinctsReporting,
      overallPrecinctsTotal: merged.overallPrecinctsTotal,
      hasEarlyUpload: merged.hasEarlyUpload,
      earlyVotingReporting: merged.earlyVotingReporting,
      earlyVotingTotal: merged.earlyVotingTotal,
      contests: merged.contests.map((c) => ({
        title: c.title,
        precinctsReporting: c.precinctsReporting,
        precinctsTotal: c.precinctsTotal,
        precinctsStatusIndexed: c.precinctsStatusIndexed,
      })),
    },
  };

  const precincts = {
    metadata,
    config,
    masterPrecincts: merged.masterPrecincts,
    precinctStats: merged.precinctStats,
    contests: merged.contests.map(({ precinctsStatus, ...rest }) => rest),
  };

  const compact = (v) => pyDumps(v, { itemSep: ',', keySep: ':' });
  return {
    objects: { bundle, summary, reporting, precincts },
    files: {
      'summary.json': compact(summary),
      'reporting.json': compact(reporting),
      'precincts.json': compact(precincts),
      'data.js': `${DATA_JS_HEADER}${compact(bundle)};\n`,
    },
  };
}

module.exports = { buildOutputs, formatLastUpdated, LEGACY_LAST_UPDATED, DATA_JS_HEADER };
