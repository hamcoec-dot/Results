import os
import csv
import json
import re
import hashlib
from verify import run_verification

def read_csv_robust(file_path):
    """Read CSV file supporting UTF-8 BOM and Windows-1252 encodings."""
    try:
        with open(file_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
            return list(csv.reader(f))
    except Exception:
        with open(file_path, 'r', encoding='cp1252', errors='ignore') as f:
            return list(csv.reader(f))

def clean_num(val):
    """Convert formatted string numbers to integers/floats."""
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

def parse_election_csv(file_path, is_ed=False):
    """
    Parses a single election CSV export file into a raw structured dictionary.
    is_ed: If False (Early Upload), precincts reporting count is set to 0 and all precincts are marked unreported.
           If True (ED Upload), precincts reporting count and precinct status maps are extracted from this file.
    """
    if not file_path or not os.path.exists(file_path):
        return None

    rows = read_csv_robust(file_path)
    if not rows or len(rows) < 5:
        return None

    election_title = rows[1][0].strip() if len(rows) > 1 and rows[1][0] else "General Election"
    election_date = rows[2][0].strip() if len(rows) > 2 and rows[2][0] else ""
    county_name = rows[2][4].strip() if len(rows) > 2 and len(rows[2]) > 4 and rows[2][4] else "Hamilton"
    status_label = rows[0][4].strip() if len(rows) > 0 and len(rows[0]) > 4 and rows[0][4] else "UNOFFICIAL RESULTS"

    total_voters = 0
    total_ballots = 0
    ballots_rep = 0
    ballots_dem = 0
    ballots_gen = 0

    for row in rows:
        if len(row) > 0 and row[0] == 'Totals':
            total_voters = clean_num(row[1]) if len(row) > 1 else 0
            total_ballots = clean_num(row[2]) if len(row) > 2 else 0
            ballots_rep = clean_num(row[3]) if len(row) > 3 else 0
            ballots_dem = clean_num(row[4]) if len(row) > 4 else 0
            ballots_gen = clean_num(row[5]) if len(row) > 5 else 0
            break

    # Extract per-precinct statistics table
    precinct_stats = {}
    in_stats_section = False
    for r_idx, row in enumerate(rows):
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
                    rep_b = clean_num(row[v_idx+2]) if len(row) > v_idx+2 else 0
                    dem_b = clean_num(row[v_idx+3]) if len(row) > v_idx+3 else 0
                    gen_b = clean_num(row[v_idx+4]) if len(row) > v_idx+4 else 0
                    turnout = round((ballots_val / voters_val * 100), 2) if voters_val > 0 else 0.0
                    precinct_stats[p_name] = {
                        'name': p_name,
                        'voters': voters_val,
                        'ballots': ballots_val,
                        'rep': rep_b,
                        'dem': dem_b,
                        'gen': gen_b,
                        'turnoutPercent': turnout
                    }

    contests = {}

    i = 0
    while i < len(rows):
        row = rows[i]
        reporting_cells = [(idx, cell) for idx, cell in enumerate(row) if 'Precincts Reporting' in cell]
        if reporting_cells:
            contest_row = rows[i-2] if i >= 2 else []
            votefor_row = rows[i-1] if i >= 1 else []
            candidate_row = rows[i+1] if i+1 < len(rows) else []

            totals_row_idx = None
            for r_idx in range(i + 2, len(rows)):
                if len(rows[r_idx]) > 0 and rows[r_idx][0] == 'Totals':
                    totals_row_idx = r_idx
                    break

            for k, (col_idx, rep_text) in enumerate(reporting_cells):
                raw_c_name = contest_row[col_idx].strip() if col_idx < len(contest_row) and contest_row[col_idx] else ""
                contest_name = clean_contest_name(raw_c_name)
                vote_for_text = votefor_row[col_idx].strip() if col_idx < len(votefor_row) and votefor_row[col_idx] else "VOTE FOR 1"
                
                if not contest_name:
                    continue

                rep_match = re.search(r'(\d+)\s+of\s+(\d+)\s+(?:Election\s+Day\s+)?Precincts\s+Reporting', rep_text, re.IGNORECASE)
                p_rep = int(rep_match.group(1)) if (rep_match and is_ed) else 0
                p_tot = int(rep_match.group(2)) if rep_match else 0

                next_contest_col = reporting_cells[k+1][0] if k + 1 < len(reporting_cells) else len(candidate_row)

                if contest_name not in contests:
                    contests[contest_name] = {
                        'title': contest_name,
                        'voteFor': vote_for_text,
                        'candidates': {},
                        'precinctsStatusMap': {},
                        'csvPrecinctsReporting': p_rep,
                        'csvPrecinctsTotal': p_tot
                    }

                # Process candidates
                cand_cols = []
                for c_idx in range(col_idx, next_contest_col):
                    if c_idx >= len(candidate_row):
                        break
                    cand_raw = candidate_row[c_idx].strip()
                    if not cand_raw or 'write-in' in cand_raw.lower():
                        continue

                    party = 'REP' if contest_name.upper().startswith('REP') else ('DEM' if contest_name.upper().startswith('DEM') else 'IND')
                    cand_name = cand_raw
                    if cand_raw.startswith('REP '):
                        party = 'REP'
                        cand_name = cand_raw[4:].strip()
                    elif cand_raw.startswith('DEM '):
                        party = 'DEM'
                        cand_name = cand_raw[4:].strip()
                    elif cand_raw.startswith('IND '):
                        party = 'IND'
                        cand_name = cand_raw[4:].strip()
                    elif 'NO CANDIDATE' in cand_raw.upper():
                        cand_name = "No Candidate Qualified"
                        if contest_name.upper().startswith('REP'):
                            party = 'REP'
                        elif contest_name.upper().startswith('DEM'):
                            party = 'DEM'

                    vote_count = 0
                    if totals_row_idx is not None and totals_row_idx < len(rows):
                        tot_r = rows[totals_row_idx]
                        if c_idx < len(tot_r):
                            vote_count = clean_num(tot_r[c_idx])

                    if cand_name not in contests[contest_name]['candidates']:
                        contests[contest_name]['candidates'][cand_name] = {
                            'name': cand_name,
                            'party': party,
                            'votes': vote_count,
                            'precinctVotes': {}
                        }
                    else:
                        contests[contest_name]['candidates'][cand_name]['votes'] = max(
                            contests[contest_name]['candidates'][cand_name]['votes'], vote_count
                        )

                    cand_cols.append((c_idx, cand_name))

                # Inspect raw precinct data rows for precinct status map & per-precinct candidate votes
                if totals_row_idx is not None:
                    for d_idx in range(i + 2, totals_row_idx):
                        d_row = rows[d_idx]
                        p_name = d_row[0].strip() if len(d_row) > 0 and d_row[0] else ""
                        if not p_name:
                            continue

                        has_contest_entry = False
                        for c_idx, cand_name in cand_cols:
                            if c_idx < len(d_row):
                                cell_val = d_row[c_idx].strip()
                                if cell_val != '':
                                    has_contest_entry = True
                                    pv = clean_num(cell_val)
                                    contests[contest_name]['candidates'][cand_name]['precinctVotes'][p_name] = pv

                        if has_contest_entry:
                            if p_name not in contests[contest_name]['precinctsStatusMap']:
                                contests[contest_name]['precinctsStatusMap'][p_name] = False
                            if is_ed:
                                contests[contest_name]['precinctsStatusMap'][p_name] = True

            i = totals_row_idx if totals_row_idx else i + 1
        i += 1

    return {
        'file_path': file_path,
        'is_ed': is_ed,
        'electionTitle': election_title,
        'electionDate': election_date,
        'county': county_name,
        'statusLabel': status_label,
        'totalVoters': total_voters,
        'totalBallots': total_ballots,
        'ballotsRep': ballots_rep,
        'ballotsDem': ballots_dem,
        'ballotsGen': ballots_gen,
        'precinctStats': precinct_stats,
        'contests_raw': contests
    }

def merge_parsed_data(early_parsed, ed_parsed):
    """
    Merges Early Upload data with ED Upload data.
    - Votes are added together (Early Votes + ED Votes).
    - Precincts reporting count and precinct status map are taken ONLY from the ED file (or 0 if no ED file).
    """
    if not early_parsed and not ed_parsed:
        return None
    if not early_parsed:
        primary = ed_parsed
    else:
        primary = early_parsed

    election_title = ed_parsed['electionTitle'] if ed_parsed else early_parsed['electionTitle']
    election_date = ed_parsed['electionDate'] if ed_parsed else early_parsed['electionDate']
    county_name = ed_parsed['county'] if ed_parsed else early_parsed['county']
    status_label = ed_parsed['statusLabel'] if ed_parsed else early_parsed['statusLabel']

    total_voters = max(early_parsed['totalVoters'] if early_parsed else 0, ed_parsed['totalVoters'] if ed_parsed else 0)
    total_ballots = ed_parsed['totalBallots'] if ed_parsed else (early_parsed['totalBallots'] if early_parsed else 0)

    precinct_stats = ed_parsed['precinctStats'] if (ed_parsed and ed_parsed['precinctStats']) else (early_parsed['precinctStats'] if early_parsed else {})

    # Collect all contest titles in order
    all_contest_titles = []
    if early_parsed:
        for t in early_parsed['contests_raw'].keys():
            if t not in all_contest_titles:
                all_contest_titles.append(t)
    if ed_parsed:
        for t in ed_parsed['contests_raw'].keys():
            if t not in all_contest_titles:
                all_contest_titles.append(t)

    formatted_contests = []
    MAX_PRECINCT_CAP = 92

    for c_title in all_contest_titles:
        early_c = early_parsed['contests_raw'].get(c_title) if early_parsed else None
        ed_c = ed_parsed['contests_raw'].get(c_title) if ed_parsed else None

        vote_for_text = ed_c['voteFor'] if ed_c else (early_c['voteFor'] if early_c else "VOTE FOR 1")

        # Precincts reporting come strictly from ED file
        if ed_c:
            reported_cnt = ed_c['csvPrecinctsReporting']
            total_prec_cnt = ed_c['csvPrecinctsTotal']
            precincts_status_map = ed_c['precinctsStatusMap']
        else:
            reported_cnt = 0
            total_prec_cnt = early_c['csvPrecinctsTotal'] if early_c else 0
            precincts_status_map = {p: False for p in early_c['precinctsStatusMap'].keys()} if early_c else {}

        # ED file is cumulative (includes Early Votes); do not add early + ed
        cand_dict = {}
        if ed_c:
            for cand_name, cand_info in ed_c['candidates'].items():
                cand_dict[cand_name] = {
                    'name': cand_info['name'],
                    'party': cand_info['party'],
                    'votes': cand_info['votes'],
                    'precinctVotes': cand_info.get('precinctVotes', {})
                }
            if early_c:
                for cand_name, cand_info in early_c['candidates'].items():
                    if cand_name not in cand_dict:
                        cand_dict[cand_name] = {
                            'name': cand_info['name'],
                            'party': cand_info['party'],
                            'votes': cand_info['votes'],
                            'precinctVotes': cand_info.get('precinctVotes', {})
                        }
        elif early_c:
            for cand_name, cand_info in early_c['candidates'].items():
                cand_dict[cand_name] = {
                    'name': cand_info['name'],
                    'party': cand_info['party'],
                    'votes': cand_info['votes'],
                    'precinctVotes': cand_info.get('precinctVotes', {})
                }

        cand_list = list(cand_dict.values())

        # Strip IND if no REP or DEM in contest
        has_rep_or_dem = any(c['party'] in ('REP', 'DEM') for c in cand_list)
        if not has_rep_or_dem:
            for c in cand_list:
                if c['party'] == 'IND':
                    c['party'] = ''

        total_contest_votes = sum(c['votes'] for c in cand_list)

        vf_num = 1
        vf_match = re.search(r'(?:VOTE\s+(?:FOR\s+)?(?:UP\s+TO\s+)?|SELECT\s+)(\d+)', vote_for_text, re.IGNORECASE)
        if not vf_match:
            vf_match = re.search(r'(\d+)', vote_for_text)
        if vf_match:
            try:
                vf_num = max(1, int(vf_match.group(1)))
            except ValueError:
                vf_num = 1

        sorted_votes = sorted([c['votes'] for c in cand_list], reverse=True)
        positive_votes = [v for v in sorted_votes if v > 0]

        cutoff_vote = None
        if positive_votes:
            cutoff_idx = min(vf_num, len(positive_votes)) - 1
            cutoff_vote = positive_votes[cutoff_idx]

        for c in cand_list:
            c['percentage'] = round((c['votes'] / total_contest_votes * 100), 2) if total_contest_votes > 0 else 0.0
            c['isLeading'] = (cutoff_vote is not None and c['votes'] >= cutoff_vote and c['votes'] > 0)

        # Sync reported count with actual precinct status map
        rep_from_map = len([p for p, is_rep in precincts_status_map.items() if is_rep])
        if rep_from_map > 0:
            reported_cnt = max(reported_cnt, rep_from_map)

        if ed_c and reported_cnt >= total_prec_cnt and total_prec_cnt > 0:
            reported_cnt = total_prec_cnt
            for p_name in precincts_status_map:
                precincts_status_map[p_name] = True

        precincts_status_list = [
            {'name': p_name, 'reported': is_rep}
            for p_name, is_rep in precincts_status_map.items()
        ]

        rep_final = min(reported_cnt, MAX_PRECINCT_CAP)
        tot_final = min(total_prec_cnt, MAX_PRECINCT_CAP)

        formatted_contests.append({
            'title': c_title,
            'voteFor': vote_for_text,
            'precinctsReporting': rep_final,
            'precinctsTotal': tot_final,
            'totalVotes': total_contest_votes,
            'candidates': cand_list,
            'precinctsStatus': precincts_status_list
        })

    overall_rep = min(max([c['precinctsReporting'] for c in formatted_contests], default=0), MAX_PRECINCT_CAP)
    overall_tot = min(max([c['precinctsTotal'] for c in formatted_contests], default=92), MAX_PRECINCT_CAP)

    # When overall county reporting reaches 100%, enforce 100% completion across all contests
    if ed_parsed and overall_rep >= overall_tot and overall_tot > 0:
        for c in formatted_contests:
            c['precinctsReporting'] = c['precinctsTotal']
            for p in c['precinctsStatus']:
                p['reported'] = True

    ballots_rep = ed_parsed['ballotsRep'] if ed_parsed else (early_parsed['ballotsRep'] if early_parsed else 0)
    ballots_dem = ed_parsed['ballotsDem'] if ed_parsed else (early_parsed['ballotsDem'] if early_parsed else 0)
    ballots_gen = ed_parsed['ballotsGen'] if ed_parsed else (early_parsed['ballotsGen'] if early_parsed else 0)

    # Collect dynamic master precinct list
    master_precinct_set = set(precinct_stats.keys())
    for c in formatted_contests:
        for p in c['precinctsStatus']:
            master_precinct_set.add(p['name'])
    master_precincts = sorted(list(master_precinct_set))
    precinct_idx_map = {name: idx for idx, name in enumerate(master_precincts)}

    # Attach indexed precinct status for compressed transfers
    for c in formatted_contests:
        c['precinctsStatusIndexed'] = [
            [precinct_idx_map[p['name']], 1 if p['reported'] else 0]
            for p in c['precinctsStatus']
        ]

    # Calculate Data Revision Hash (MD5)
    data_bytes = json.dumps(formatted_contests, sort_keys=True).encode('utf-8')
    data_version = hashlib.md5(data_bytes).hexdigest()[:12]

    merged_data = {
        'electionTitle': election_title,
        'electionDate': election_date,
        'county': county_name,
        'statusLabel': status_label,
        'totalVoters': total_voters,
        'totalBallots': total_ballots,
        'ballotsRep': ballots_rep,
        'ballotsDem': ballots_dem,
        'ballotsGen': ballots_gen,
        'turnoutPercent': round((total_ballots / total_voters * 100), 2) if total_voters > 0 else 0.0,
        'overallPrecinctsReporting': overall_rep,
        'overallPrecinctsTotal': overall_tot,
        'hasEarlyUpload': early_parsed is not None,
        'earlyVotingReporting': 1 if (early_parsed is not None and total_ballots > 0) else 0,
        'earlyVotingTotal': 1,
        'earlyBallotsCast': early_parsed['totalBallots'] if early_parsed else 0,
        'masterPrecincts': master_precincts,
        'precinctStats': precinct_stats,
        'contests': formatted_contests
    }
    merged_data['dataVersion'] = data_version
    return merged_data

def load_config():
    """Loads configuration settings from config.json (creates default if missing)."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(base_dir, 'config.json')
    default_config = {
        "enablePrecinctResults": True
    }
    if not os.path.exists(config_path):
        try:
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(default_config, f, indent=2)
        except Exception:
            pass
        return default_config
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else default_config
    except Exception:
        return default_config

def generate_data_js():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(base_dir, 'Results')
    output_js_path = os.path.join(base_dir, 'data.js')
    output_summary_json = os.path.join(base_dir, 'summary.json')
    output_reporting_json = os.path.join(base_dir, 'reporting.json')
    output_precincts_json = os.path.join(base_dir, 'precincts.json')

    all_csvs = []
    if os.path.exists(results_dir):
        for root, _, files in os.walk(results_dir):
            for f in files:
                if f.upper().endswith('.CSV'):
                    all_csvs.append(os.path.join(root, f))

    if not all_csvs:
        # Fallback to base_dir if Results directory is empty
        all_csvs = [os.path.join(base_dir, f) for f in os.listdir(base_dir) if f.upper().endswith('.CSV')]

    if not all_csvs:
        raise FileNotFoundError("No election results CSV file found in Results/ directory.")

    # Sort all CSVs by modification timestamp (newest first)
    all_csvs.sort(key=lambda x: os.path.getmtime(x), reverse=True)

    early_files = []
    ed_files = []

    for f in all_csvs:
        fname_upper = os.path.basename(f).upper()
        if 'ZERO' in fname_upper or 'EARLY' in fname_upper:
            early_files.append(f)
        else:
            ed_files.append(f)

    # Select the most recent Early CSV (with ZERO or EARLY in filename)
    early_csv = early_files[0] if early_files else None

    # Select the most recent ED CSV (without ZERO or EARLY in filename)
    ed_csv = ed_files[0] if ed_files else None

    # Fallback if only 1 CSV exists and doesn't contain ZERO/EARLY
    if not early_csv and not ed_csv and all_csvs:
        ed_csv = all_csvs[0]

    print(f"Parsing Early Upload CSV: {early_csv}")
    early_parsed = parse_election_csv(early_csv, is_ed=False) if early_csv else None

    print(f"Parsing ED Upload CSV:    {ed_csv}")
    ed_parsed = parse_election_csv(ed_csv, is_ed=True) if ed_csv else None

    parsed = merge_parsed_data(early_parsed, ed_parsed)
    cfg_data = load_config()

    meta_block = {
        'electionTitle': parsed['electionTitle'],
        'electionDate': parsed['electionDate'],
        'county': parsed['county'],
        'statusLabel': parsed['statusLabel'],
        'dataVersion': parsed['dataVersion'],
        'lastUpdated': 'November 5, 2024 08:45 PM'
    }

    bundle = {
        'metadata': meta_block,
        'config': cfg_data,
        'latest': parsed
    }

    # Build Lightweight Summary JSON (~17KB) for main dashboard & scrolling ticker
    summary_contests = []
    for c in parsed['contests']:
        summary_contests.append({
            'title': c['title'],
            'voteFor': c['voteFor'],
            'precinctsReporting': c['precinctsReporting'],
            'precinctsTotal': c['precinctsTotal'],
            'totalVotes': c['totalVotes'],
            'candidates': c['candidates']
        })

    summary_payload = {
        'metadata': meta_block,
        'config': cfg_data,
        'latest': {
            'electionTitle': parsed['electionTitle'],
            'electionDate': parsed['electionDate'],
            'county': parsed['county'],
            'statusLabel': parsed['statusLabel'],
            'totalVoters': parsed['totalVoters'],
            'totalBallots': parsed['totalBallots'],
            'ballotsRep': parsed['ballotsRep'],
            'ballotsDem': parsed['ballotsDem'],
            'ballotsGen': parsed['ballotsGen'],
            'turnoutPercent': parsed['turnoutPercent'],
            'overallPrecinctsReporting': parsed['overallPrecinctsReporting'],
            'overallPrecinctsTotal': parsed['overallPrecinctsTotal'],
            'hasEarlyUpload': parsed['hasEarlyUpload'],
            'earlyVotingReporting': parsed['earlyVotingReporting'],
            'earlyVotingTotal': parsed['earlyVotingTotal'],
            'earlyBallotsCast': parsed['earlyBallotsCast'],
            'contests': summary_contests
        }
    }

    # Build Reporting Progress JSON (~20KB) for reporting.html
    reporting_contests = []
    for c in parsed['contests']:
        reporting_contests.append({
            'title': c['title'],
            'precinctsReporting': c['precinctsReporting'],
            'precinctsTotal': c['precinctsTotal'],
            'precinctsStatusIndexed': c['precinctsStatusIndexed']
        })

    reporting_payload = {
        'metadata': meta_block,
        'config': cfg_data,
        'masterPrecincts': parsed['masterPrecincts'],
        'latest': {
            'overallPrecinctsReporting': parsed['overallPrecinctsReporting'],
            'overallPrecinctsTotal': parsed['overallPrecinctsTotal'],
            'hasEarlyUpload': parsed['hasEarlyUpload'],
            'earlyVotingReporting': parsed['earlyVotingReporting'],
            'earlyVotingTotal': parsed['earlyVotingTotal'],
            'contests': reporting_contests
        }
    }

    # Build Optimized Precinct Details JSON (~140KB) without redundant raw text status lists
    clean_precinct_contests = []
    for c in parsed['contests']:
        c_copy = dict(c)
        c_copy.pop('precinctsStatus', None)
        clean_precinct_contests.append(c_copy)

    precincts_payload = {
        'metadata': meta_block,
        'config': cfg_data,
        'masterPrecincts': parsed['masterPrecincts'],
        'precinctStats': parsed['precinctStats'],
        'contests': clean_precinct_contests
    }

    # Write summary.json, reporting.json, and precincts.json
    with open(output_summary_json, 'w', encoding='utf-8') as f:
        json.dump(summary_payload, f, separators=(',', ':'))

    with open(output_reporting_json, 'w', encoding='utf-8') as f:
        json.dump(reporting_payload, f, separators=(',', ':'))

    with open(output_precincts_json, 'w', encoding='utf-8') as f:
        json.dump(precincts_payload, f, separators=(',', ':'))

    # Write data.js (legacy combined fallback bundle)
    js_content = f"// Auto-generated Election Night Results Data\nwindow.ELECTION_DATA = {json.dumps(bundle, separators=(',', ':'))};\n"
    with open(output_js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print(f"Successfully compiled election data:")
    print(f"  - {output_summary_json} ({os.path.getsize(output_summary_json) // 1024} KB)")
    print(f"  - {output_reporting_json} ({os.path.getsize(output_reporting_json) // 1024} KB)")
    print(f"  - {output_precincts_json} ({os.path.getsize(output_precincts_json) // 1024} KB)")
    print(f"  - {output_js_path} ({os.path.getsize(output_js_path) // 1024} KB)\n")

    # Run Verification Engine Automatically
    run_verification(early_csv, ed_csv, output_js_path)

if __name__ == '__main__':
    generate_data_js()
