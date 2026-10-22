'use strict';
// tools/load-election-night.js: arguments, the page mix, and a short run against a local server that
// "publishes" twice mid-run, with the files written before the manifest as publishDraft does.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseArgs, pageKind, summarize, createStats, run } = require('../../tools/load-election-night');

test('parseArgs: defaults, flags, and anything odd refused', () => {
  const o = parseArgs(['https://storage.googleapis.com/b']);
  assert.deepEqual(o, { bust: true, pages: 2000, duration: 600, poll: 60, expectPublishes: 0, maxP95: 300, base: 'https://storage.googleapis.com/b/' });
  assert.equal(parseArgs(['http://x/', '--no-bust', '--pages', '5']).bust, false);
  assert.equal(parseArgs(['http://x/', '--expect-publishes', '10']).expectPublishes, 10);
  for (const [args, msg] of [
    [[], /bucket base URL/],
    [['ftp://x/'], /bucket base URL/],
    [['http://x/', '--pages', 'lots'], /--pages needs a number/],
    [['http://x/', '--pages', '0'], /must be positive/],
    [['http://x/', '--force'], /unknown argument/],
    [['http://x/', 'http://y/'], /bucket base URL/],
  ]) assert.throws(() => parseArgs(args), msg);
});

test('pageKind: an exact 70/20/10 mix of index, reporting and precincts pages', () => {
  const counts = {};
  for (let i = 0; i < 1000; i += 1) counts[pageKind(i, 1000).kind] = (counts[pageKind(i, 1000).kind] ?? 0) + 1;
  assert.deepEqual(counts, { index: 700, reporting: 200, precincts: 100 });
  assert.deepEqual(pageKind(750, 1000).files, ['summary.json', 'reporting.json']);
  assert.equal(pageKind(0, 1).kind, 'index');
});

test('summarize: errors, slow p95 and too few publishes each fail the run', () => {
  const base = () => {
    const s = createStats();
    s.manifest.push(10, 20, 30);
    s.files.push(15);
    s.versions.set('aaaaaaaaaaaa', { first: 0, last: 0, pages: 3 });
    s.versions.set('bbbbbbbbbbbb', { first: 1000, last: 5000, pages: 3 });
    return s;
  };
  const opts = { pages: 3, maxP95: 300, expectPublishes: 1, seconds: 10 };
  const ok = summarize(base(), opts);
  assert.equal(ok.ok, true);
  assert.ok(ok.lines.includes('version bbbbbbbbbbbb: on 3 of 3 pages, all within 4 s of the first'));

  const errs = base();
  errs.errors.set('manifest.json: HTTP 503', 2);
  assert.match(summarize(errs, opts).lines.at(-1), /FAIL: 2 error\(s\)/);

  const slow = base();
  slow.files.push(900, 900, 900, 900);
  assert.match(summarize(slow, opts).lines.at(-1), /p95 900 ms > 300 ms/);

  assert.match(summarize(base(), { ...opts, expectPublishes: 2 }).lines.at(-1), /1 new version\(s\) seen, expected 2/);
  assert.match(summarize(createStats(), opts).lines.at(-1), /no successful polls/);
});

test('run: every page picks up each publish, a rollback included, with cache-busted requests', async () => {
  const doc = (v) => JSON.stringify({ metadata: { dataVersion: v } });
  let version = 'aaaaaaaaaaaa';
  let at = 't0';
  const busted = [];
  const server = http.createServer((req, res) => {
    const [path, query] = req.url.split('?');
    busted.push(/^t=\w+$/.test(query ?? ''));
    const file = path.replace('/b/current/', '');
    if (file === 'manifest.json') return res.end(JSON.stringify({ dataVersion: version, updatedAt: at }));
    if (['summary.json', 'reporting.json', 'precincts.json'].includes(file)) return res.end(doc(version));
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/b/`;
  // A publish, then a rollback to the first version: two new publishes, though only two versions.
  const publishes = [setTimeout(() => { version = 'bbbbbbbbbbbb'; at = 't1'; }, 400), setTimeout(() => { version = 'aaaaaaaaaaaa'; at = 't2'; }, 900)];
  try {
    const { lines, ok } = await run({ base, bust: true, pages: 20, duration: 1.5, poll: 0.1, expectPublishes: 2, maxP95: 1000 });
    assert.equal(ok, true, lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith('version aaaaaaaaaaaa (published t2): on 20 of 20 pages')), lines.join('\n'));
    assert.ok(busted.length > 100 && busted.every(Boolean));
  } finally {
    publishes.forEach(clearTimeout);
    server.close();
  }
});

test('run: a 404 manifest is an error and the run fails', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { lines, ok } = await run({ base: `http://127.0.0.1:${server.address().port}/`, bust: false, pages: 2, duration: 0.3, poll: 0.1, expectPublishes: 0, maxP95: 300 });
    assert.equal(ok, false);
    assert.match(lines.find((l) => l.startsWith('errors:')), /manifest\.json: HTTP 404 x\d+/);
  } finally {
    server.close();
  }
});
