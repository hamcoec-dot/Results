"""
Golden-output generator for the Node port parity tests.

Runs the legacy Python pipeline (convert_data.generate_data_js + verify.run_verification)
over every fixture case in Test_Files/ (the project's only test CSVs) and writes the results to functions/test/golden/<case>/.

The real generate_data_js code path is used unchanged: each case gets a temp folder
holding a Results/ dir with the case's CSVs named EARLY.csv / ED.csv (so the legacy
filename rule classifies them as intended), and convert_data.__file__ is pointed at it.

Usage:  python tools/make_golden.py            (from repo root)
"""
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import convert_data  # noqa: E402

GOLDEN_DIR = os.path.join(REPO, 'functions', 'test', 'golden')
SAMPLES = os.path.join('Test_Files', 'Web Results Samples')


def sample(name, cap):
    return os.path.join(SAMPLES, f'{name} ({cap}).csv')


def build_cases():
    """Each case: (id, early_csv | None, ed_csv | None), paths relative to repo root."""
    cases = []
    for cap in (92, 94):
        ev = sample('02-After EV', cap)
        cases += [
            (f'samples-{cap}-00-zero', sample('00-Zero File', cap), None),
            (f'samples-{cap}-01-nh-abs', sample('01-After NH&ABS', cap), None),
            (f'samples-{cap}-02-ev', ev, None),
            (f'samples-{cap}-03-5-reporting', ev, sample('03-After 5 Reporting', cap)),
            (f'samples-{cap}-04-10-reporting', ev, sample('04-After 10 Reporting', cap)),
            (f'samples-{cap}-05-end-ed', ev, sample('05-End of Election Day', cap)),
            (f'samples-{cap}-06-end-provisional', ev, sample('06-End of Provisional', cap)),
            (f'samples-{cap}-06-ed-only', None, sample('06-End of Provisional', cap)),
        ]
    ev_test = os.path.join('Test_Files', 'EV test.csv')
    ed_test = os.path.join('Test_Files', 'ED test.csv')
    cases += [
        ('testfiles-ev', ev_test, None),
        ('testfiles-ev-ed', ev_test, ed_test),
        ('testfiles-ed-only', None, ed_test),
    ]
    return cases


def sha256(rel):
    with open(os.path.join(REPO, rel), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write('\n')


def parse_verify_log(log):
    checks = []
    for line in log.splitlines():
        m = re.match(r'\s*\[(PASS|FAIL)\] (.*)$', line)
        if m:
            checks.append({'pass': m.group(1) == 'PASS', 'detail': m.group(2)})
    m = re.search(r'VERIFICATION SUMMARY: (\d+) PASSED, (\d+) FAILED', log)
    return {
        'passed': int(m.group(1)) if m else None,
        'failed': int(m.group(2)) if m else None,
        'checks': checks,
    }


def run_case(case_id, early_rel, ed_rel):
    out_dir = os.path.join(GOLDEN_DIR, case_id)
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='golden-') as tmp:
        results = os.path.join(tmp, 'Results')
        os.makedirs(results)
        if early_rel:
            shutil.copyfile(os.path.join(REPO, early_rel), os.path.join(results, 'EARLY.csv'))
        if ed_rel:
            shutil.copyfile(os.path.join(REPO, ed_rel), os.path.join(results, 'ED.csv'))
        with open(os.path.join(tmp, 'config.json'), 'w', encoding='utf-8') as f:
            json.dump({'enablePrecinctResults': True}, f)

        # Point the legacy module at the temp folder and run its real entry point.
        convert_data.__file__ = os.path.join(tmp, 'convert_data.py')
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            convert_data.generate_data_js()

        # Python text mode writes CRLF on Windows; store LF so goldens are platform-independent.
        for name in ('summary.json', 'reporting.json', 'precincts.json', 'data.js'):
            with open(os.path.join(tmp, name), 'rb') as f:
                data = f.read().replace(b'\r\n', b'\n')
            with open(os.path.join(out_dir, name), 'wb') as f:
                f.write(data)

        early_parsed = convert_data.parse_election_csv(os.path.join(results, 'EARLY.csv'), is_ed=False) if early_rel else None
        ed_parsed = convert_data.parse_election_csv(os.path.join(results, 'ED.csv'), is_ed=True) if ed_rel else None

    if early_parsed is not None:
        write_json(os.path.join(out_dir, 'parsed-early.json'), early_parsed)
    if ed_parsed is not None:
        write_json(os.path.join(out_dir, 'parsed-ed.json'), ed_parsed)

    verify = parse_verify_log(log.getvalue())
    write_json(os.path.join(out_dir, 'verify.json'), verify)
    write_json(os.path.join(out_dir, 'case.json'), {
        'id': case_id,
        'early': early_rel.replace(os.sep, '/') if early_rel else None,
        'ed': ed_rel.replace(os.sep, '/') if ed_rel else None,
        'earlySha256': sha256(early_rel) if early_rel else None,
        'edSha256': sha256(ed_rel) if ed_rel else None,
        'precinctCap': 92,
    })
    return verify


def main():
    # Clear old outputs file by file. Windows (indexers, editors, shells) can hold a lock on a
    # folder, so stale case folders are removed best-effort and folders are otherwise reused.
    keep = {case_id for case_id, _, _ in build_cases()}
    os.makedirs(GOLDEN_DIR, exist_ok=True)
    for name in os.listdir(GOLDEN_DIR):
        d = os.path.join(GOLDEN_DIR, name)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        if name not in keep:
            try:
                os.rmdir(d)
            except OSError:
                print(f'warning: could not remove stale folder {name} (it is empty; delete it by hand)')

    failures = 0
    for case_id, early_rel, ed_rel in build_cases():
        try:
            v = run_case(case_id, early_rel, ed_rel)
            print(f'{case_id:40s} verify {v["passed"]} pass / {v["failed"]} fail')
        except Exception as e:  # keep going so one bad fixture doesn't hide the rest
            failures += 1
            print(f'{case_id:40s} ERROR {type(e).__name__}: {e}')
    print(f'\nGolden outputs written to {os.path.relpath(GOLDEN_DIR, REPO)} ({failures} case errors)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
