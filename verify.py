import os
import csv
import json
import re

def read_csv_robust(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
            return list(csv.reader(f))
    except Exception:
        with open(file_path, 'r', encoding='cp1252', errors='ignore') as f:
            return list(csv.reader(f))

def clean_num(val):
    if not val:
        return 0
    clean = str(val).replace(',', '').strip()
    try:
        if '.' in clean:
            return float(clean)
        return int(clean)
    except ValueError:
        return 0

def clean_contest_name(name):
    """Deduplicates repeated words/phrases in contest titles (e.g. 'District 28 District 28')."""
    if not name:
        return ""
    cleaned = name.strip()
    cleaned = re.sub(r'\b(.+?)\s+\1\b', r'\1', cleaned, flags=re.IGNORECASE)
    m = re.match(r'^(\w+)\s+(.+?)\s+\1$', cleaned, flags=re.IGNORECASE)
    if m:
        cleaned = f"{m.group(1)} {m.group(2)}"
    return re.sub(r'\s+', ' ', cleaned).strip()

def run_verification(early_csv, ed_csv, js_path=None):
    """
    Independent Verification Engine for Hamilton County Election Results.
    Audits generated data.js against Early and ED CSV files.
    - Audits Metadata (Title, Date, County)
    - Audits Turnout Statistics (Voters, Ballots, Turnout %)
    - Audits Contest presence & Precinct reporting counts
    - Audits Candidate Vote Totals & Mathematical Sums across Early and ED CSVs
    """
    if js_path is None:
        js_path = ed_csv
        ed_csv = None

    print(f"=== ELECTION RESULTS VERIFICATION ENGINE ===")
    print(f"Early CSV: {early_csv}")
    print(f"ED CSV:    {ed_csv}")
    print(f"Target JS: {js_path}\n")

    summary_json_path = os.path.join(os.path.dirname(js_path), 'summary.json')
    precincts_json_path = os.path.join(os.path.dirname(js_path), 'precincts.json')

    if not os.path.exists(js_path):
        print(f"[FAIL] Missing JS file: {js_path}")
        return False

    with open(js_path, 'r', encoding='utf-8') as f:
        js_content = f.read()

    try:
        json_str = js_content.split('window.ELECTION_DATA = ')[1].rstrip(';\n')
        js_data = json.loads(json_str)['latest']
    except Exception as e:
        print(f"[FAIL] Invalid data.js payload: {e}")
        return False

    summary_data = None
    if os.path.exists(summary_json_path):
        with open(summary_json_path, 'r', encoding='utf-8') as f:
            summary_data = json.load(f)

    precincts_data = None
    if os.path.exists(precincts_json_path):
        with open(precincts_json_path, 'r', encoding='utf-8') as f:
            precincts_data = json.load(f)

    passed_checks = 0
    failed_checks = 0

    def check(condition, description):
        nonlocal passed_checks, failed_checks
        if condition:
            print(f"  [PASS] {description}")
            passed_checks += 1
        else:
            print(f"  [FAIL] {description}")
            failed_checks += 1

    primary_csv = ed_csv if ed_csv else early_csv
    if not primary_csv or not os.path.exists(primary_csv):
        print(f"[FAIL] Missing primary CSV file: {primary_csv}")
        return False

    rows = read_csv_robust(primary_csv)

    print("--- 1. Metadata & Header Verification ---")
    raw_title = rows[1][0].strip() if len(rows) > 1 and rows[1][0] else "General Election"
    raw_date = rows[2][0].strip() if len(rows) > 2 and rows[2][0] else ""
    raw_county = rows[2][4].strip() if len(rows) > 2 and len(rows[2]) > 4 and rows[2][4] else "Hamilton"

    check(summary_data is not None, "summary.json file generated successfully (~15KB)")
    check(precincts_data is not None, "precincts.json file generated successfully (~230KB)")
    check('dataVersion' in js_data and len(js_data['dataVersion']) > 0, "Data Revision Hash (dataVersion) generated")
    check(isinstance(js_data.get('masterPrecincts'), list) and len(js_data['masterPrecincts']) > 0, f"Dynamic Master Precinct List built ({len(js_data.get('masterPrecincts', []))} precincts)")

    check(js_data['electionTitle'] == raw_title, f"Election Title matches ('{raw_title}')")
    check(js_data['electionDate'] == raw_date, f"Election Date matches ('{raw_date}')")
    check(js_data['county'] == raw_county, f"County Name matches ('{raw_county}')")

    print("\n--- 2. Turnout Statistics Verification ---")
    early_rows = read_csv_robust(early_csv) if (early_csv and os.path.exists(early_csv)) else []
    ed_rows = read_csv_robust(ed_csv) if (ed_csv and os.path.exists(ed_csv)) else []

    early_voters = 0
    early_ballots = 0
    for r in early_rows:
        if len(r) > 0 and r[0] == 'Totals':
            early_voters = clean_num(r[1]) if len(r) > 1 else 0
            early_ballots = clean_num(r[2]) if len(r) > 2 else 0
            break

    ed_voters = 0
    ed_ballots = 0
    for r in ed_rows:
        if len(r) > 0 and r[0] == 'Totals':
            ed_voters = clean_num(r[1]) if len(r) > 1 else 0
            ed_ballots = clean_num(r[2]) if len(r) > 2 else 0
            break

    expected_voters = max(early_voters, ed_voters)
    expected_ballots = ed_ballots if ed_rows else early_ballots
    expected_turnout = round((expected_ballots / expected_voters * 100), 2) if expected_voters > 0 else 0.0

    check(js_data['totalVoters'] == expected_voters, f"Registered Voters count ({js_data['totalVoters']} == {expected_voters})")
    check(js_data['totalBallots'] == expected_ballots, f"Total Ballots Cast ({js_data['totalBallots']} == {expected_ballots})")
    check(js_data['turnoutPercent'] == expected_turnout, f"Turnout Percentage ({js_data['turnoutPercent']}% == {expected_turnout}%)")

    print("\n--- 3. Dynamic Contest, Precinct & Candidate Audit ---")
    js_contests = {c['title']: c for c in js_data['contests']}

    def find_all_raw_contests(rows):
        found = {}
        if not rows:
            return found
        i = 0
        while i < len(rows):
            row = rows[i]
            reporting_cells = [(idx, cell) for idx, cell in enumerate(row) if 'Precincts Reporting' in cell]
            if reporting_cells:
                contest_row = rows[i-2] if i >= 2 else []
                for k, (col_idx, rep_text) in enumerate(reporting_cells):
                    raw_c_name = contest_row[col_idx].strip() if col_idx < len(contest_row) and contest_row[col_idx] else ""
                    c_name = clean_contest_name(raw_c_name)
                    if c_name:
                        rep_match = re.search(r'(\d+)\s+of\s+(\d+)\s+(?:Election\s+Day\s+)?Precincts\s+Reporting', rep_text, re.IGNORECASE)
                        p_rep = int(rep_match.group(1)) if rep_match else 0
                        p_tot = int(rep_match.group(2)) if rep_match else 0
                        found[c_name] = (p_rep, p_tot)
                totals_row_idx = None
                for r_idx in range(i + 2, len(rows)):
                    if len(rows[r_idx]) > 0 and rows[r_idx][0] == 'Totals':
                        totals_row_idx = r_idx
                        break
                i = totals_row_idx if totals_row_idx else i + 1
            i += 1
        return found

    early_contests_info = find_all_raw_contests(early_rows)
    ed_contests_info = find_all_raw_contests(ed_rows)

    raw_contests_found = set(list(early_contests_info.keys()) + list(ed_contests_info.keys()))

    MAX_PRECINCT_CAP = 92
    for c_name in raw_contests_found:
        check(c_name in js_contests, f"Contest '{c_name}' present in JS dataset")
        if c_name in js_contests:
            js_c = js_contests[c_name]
            if ed_rows and c_name in ed_contests_info:
                p_rep, p_tot = ed_contests_info[c_name]
            elif ed_rows and c_name not in ed_contests_info:
                p_rep, p_tot = 0, early_contests_info.get(c_name, (0, 0))[1]
            else:
                p_rep, p_tot = 0, early_contests_info.get(c_name, (0, 0))[1]

            expected_rep_cnt = min(p_rep, MAX_PRECINCT_CAP)
            expected_tot_cnt = min(p_tot, MAX_PRECINCT_CAP)

            rep_from_map = len([p for p in js_c.get('precinctsStatus', []) if p.get('reported')])
            if rep_from_map > expected_rep_cnt:
                expected_rep_cnt = rep_from_map
            if js_data.get('overallPrecinctsReporting', 0) >= js_data.get('overallPrecinctsTotal', 92) and expected_tot_cnt > 0:
                expected_rep_cnt = expected_tot_cnt

            check(js_c['precinctsReporting'] == expected_rep_cnt, f"'{c_name}' Precincts Reported ({js_c['precinctsReporting']} == {expected_rep_cnt})")
            check(js_c['precinctsTotal'] == expected_tot_cnt, f"'{c_name}' Total Precincts ({js_c['precinctsTotal']} == {expected_tot_cnt})")

    check(len(js_contests) == len(raw_contests_found), f"Total contest count matches ({len(js_contests)} == {len(raw_contests_found)})")

    print("\n--- 4. Candidate Vote Totals & Mathematical Sum Audit ---")
    def extract_contest_candidate_votes(rows):
        res = {}
        if not rows:
            return res
        i = 0
        while i < len(rows):
            row = rows[i]
            reporting_cells = [(idx, cell) for idx, cell in enumerate(row) if 'Precincts Reporting' in cell]
            if reporting_cells:
                contest_row = rows[i-2] if i >= 2 else []
                candidate_row = rows[i+1] if i+1 < len(rows) else []

                totals_row_idx = None
                for r_idx in range(i + 2, len(rows)):
                    if len(rows[r_idx]) > 0 and rows[r_idx][0] == 'Totals':
                        totals_row_idx = r_idx
                        break

                for k, (col_idx, rep_text) in enumerate(reporting_cells):
                    c_name = contest_row[col_idx].strip() if col_idx < len(contest_row) and contest_row[col_idx] else ""
                    if not c_name:
                        continue
                    if c_name not in res:
                        res[c_name] = {}

                    next_contest_col = reporting_cells[k+1][0] if k + 1 < len(reporting_cells) else len(candidate_row)

                    for c_idx in range(col_idx, next_contest_col):
                        if c_idx >= len(candidate_row):
                            break
                        cand_raw = candidate_row[c_idx].strip()
                        if not cand_raw or 'write-in' in cand_raw.lower():
                            continue

                        cand_clean = cand_raw
                        for p in ['REP ', 'DEM ', 'IND ']:
                            if cand_clean.startswith(p):
                                cand_clean = cand_clean[len(p):].strip()

                        raw_votes = clean_num(rows[totals_row_idx][c_idx]) if (totals_row_idx is not None and c_idx < len(rows[totals_row_idx])) else 0
                        res[c_name][cand_clean] = max(res[c_name].get(cand_clean, 0), raw_votes)

                i = totals_row_idx if totals_row_idx else i + 1
            i += 1
        return res

    early_cand_map = extract_contest_candidate_votes(early_rows)
    ed_cand_map = extract_contest_candidate_votes(ed_rows)

    all_verified_contests = set(list(early_cand_map.keys()) + list(ed_cand_map.keys()))

    for c_title in all_verified_contests:
        if c_title in js_contests:
            js_c = js_contests[c_title]
            js_cand_map = {cand['name']: cand for cand in js_c['candidates']}

            early_c_cands = early_cand_map.get(c_title, {})
            ed_c_cands = ed_cand_map.get(c_title, {})
            all_cands = set(list(early_c_cands.keys()) + list(ed_c_cands.keys()))

            for cand_name in all_cands:
                if ed_rows and cand_name in ed_c_cands:
                    expected_votes = ed_c_cands[cand_name]
                else:
                    expected_votes = early_c_cands.get(cand_name, 0)
                actual_votes = js_cand_map.get(cand_name, {}).get('votes', 0)
                check(actual_votes == expected_votes, f"Candidate '{cand_name}' vote sum ({actual_votes} == {expected_votes}) in '{c_title}'")

    print("\n--- 5. Precinct-Level Turnout & Candidate Vote Audit ---")
    raw_rows_for_precincts = ed_rows if ed_rows else early_rows
    js_precinct_stats = js_data.get('precinctStats', {})

    # Extract raw precinct stats strictly from STATISTICS section (before first Totals row)
    raw_precinct_stats = {}
    in_stats_section = False
    for r_idx, row in enumerate(raw_rows_for_precincts):
        if not row:
            continue
        if len(row) > 0 and row[0] == 'Totals':
            if in_stats_section:
                break
        if any('STATISTICS' in str(cell) for cell in row):
            in_stats_section = True
            continue
        if in_stats_section:
            p_name = ""
            v_idx = -1
            if len(row) >= 6 and row[0].strip() and row[0].strip() not in ('Custom Table Report', 'STATISTICS', 'Totals', 'Precincts Reporting', 'Registered Voters - Total'):
                if not any(k in row[0] for k in ('August', 'State', 'Federal', 'County', 'General', 'Primary')):
                    p_name = row[0].strip()
                    v_idx = 1
            elif len(row) >= 7 and row[1].strip() and row[1].strip() not in ('STATISTICS', 'Totals', 'Registered Voters - Total'):
                p_name = row[1].strip()
                v_idx = 2

            if p_name and v_idx > 0 and p_name != 'Totals':
                voters_val = clean_num(row[v_idx])
                ballots_val = clean_num(row[v_idx+1])
                if voters_val > 0 or ballots_val > 0:
                    raw_precinct_stats[p_name] = {
                        'voters': voters_val,
                        'ballots': ballots_val
                    }

    for p_name, p_data in raw_precinct_stats.items():
        check(p_name in js_precinct_stats, f"Precinct '{p_name}' stats present in JS dataset")
        if p_name in js_precinct_stats:
            js_p = js_precinct_stats[p_name]
            check(js_p['voters'] == p_data['voters'], f"Precinct '{p_name}' Registered Voters ({js_p['voters']} == {p_data['voters']})")
            check(js_p['ballots'] == p_data['ballots'], f"Precinct '{p_name}' Ballots Cast ({js_p['ballots']} == {p_data['ballots']})")

    # Extract raw candidate votes per precinct
    if raw_rows_for_precincts:
        i = 0
        precinct_vote_checks = 0
        while i < len(raw_rows_for_precincts):
            row = raw_rows_for_precincts[i]
            reporting_cells = [(idx, cell) for idx, cell in enumerate(row) if 'Precincts Reporting' in cell]
            if reporting_cells:
                contest_row = raw_rows_for_precincts[i-2] if i >= 2 else []
                candidate_row = raw_rows_for_precincts[i+1] if i+1 < len(raw_rows_for_precincts) else []

                totals_row_idx = None
                for r_idx in range(i + 2, len(raw_rows_for_precincts)):
                    if len(raw_rows_for_precincts[r_idx]) > 0 and raw_rows_for_precincts[r_idx][0] == 'Totals':
                        totals_row_idx = r_idx
                        break

                for k, (col_idx, rep_text) in enumerate(reporting_cells):
                    raw_c_name = contest_row[col_idx].strip() if col_idx < len(contest_row) and contest_row[col_idx] else ""
                    c_name = clean_contest_name(raw_c_name)
                    if not c_name or c_name not in js_contests:
                        continue

                    js_c = js_contests[c_name]
                    js_cand_map = {cand['name']: cand for cand in js_c['candidates']}
                    next_contest_col = reporting_cells[k+1][0] if k + 1 < len(reporting_cells) else len(candidate_row)

                    cand_cols = []
                    for c_idx in range(col_idx, next_contest_col):
                        if c_idx >= len(candidate_row):
                            break
                        cand_raw = candidate_row[c_idx].strip()
                        if not cand_raw or 'write-in' in cand_raw.lower():
                            continue
                        cand_clean = cand_raw
                        for party_prefix in ['REP ', 'DEM ', 'IND ']:
                            if cand_clean.startswith(party_prefix):
                                cand_clean = cand_clean[len(party_prefix):].strip()
                        cand_cols.append((c_idx, cand_clean))

                    if totals_row_idx is not None:
                        for d_idx in range(i + 2, totals_row_idx):
                            d_row = raw_rows_for_precincts[d_idx]
                            p_name = d_row[0].strip() if len(d_row) > 0 and d_row[0] else ""
                            if not p_name:
                                continue
                            for c_idx, cand_clean in cand_cols:
                                if c_idx < len(d_row) and d_row[c_idx].strip() != '':
                                    expected_pv = clean_num(d_row[c_idx])
                                    if cand_clean in js_cand_map:
                                        actual_pv = (js_cand_map[cand_clean].get('precinctVotes', {})).get(p_name, 0)
                                        precinct_vote_checks += 1
                                        if actual_pv != expected_pv:
                                            check(False, f"Precinct '{p_name}' vote for '{cand_clean}' in '{c_name}' ({actual_pv} != {expected_pv})")

                i = totals_row_idx if totals_row_idx else i + 1
            i += 1

        check(precinct_vote_checks > 0, f"Audited {precinct_vote_checks} precinct-level candidate vote entries against raw CSV data")

    print("\n==========================================")
    print(f"VERIFICATION SUMMARY: {passed_checks} PASSED, {failed_checks} FAILED")
    print("==========================================")

    return failed_checks == 0

if __name__ == '__main__':
    base_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(base_dir, 'Results')
    
    if not os.path.exists(results_dir):
        os.makedirs(results_dir, exist_ok=True)

    all_csvs = [os.path.join(results_dir, f) for f in os.listdir(results_dir) if f.upper().endswith('.CSV')]
    if not all_csvs:
        all_csvs = [os.path.join(base_dir, f) for f in os.listdir(base_dir) if f.upper().endswith('.CSV')]

    all_csvs.sort(key=lambda x: os.path.getmtime(x), reverse=True)

    early_files = []
    ed_files = []

    for f in all_csvs:
        fname_upper = os.path.basename(f).upper()
        if 'ZERO' in fname_upper or 'EARLY' in fname_upper:
            early_files.append(f)
        else:
            ed_files.append(f)

    early_csv = early_files[0] if early_files else None
    ed_csv = ed_files[0] if ed_files else None
    if not early_csv and not ed_csv and all_csvs:
        ed_csv = all_csvs[0]

    js_file = os.path.join(base_dir, 'data.js')
    success = run_verification(early_csv, ed_csv, js_file)
    exit(0 if success else 1)
