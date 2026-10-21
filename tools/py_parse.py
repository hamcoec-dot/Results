"""
Reference-oracle bridge: runs the legacy Python parser on CSV files and prints JSON.

Usage:  python tools/py_parse.py <csv> <is_ed: 0|1> [<csv> <is_ed> ...]
Prints a JSON array with one convert_data.parse_election_csv result per file.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import convert_data  # noqa: E402


def main(argv):
    out = []
    for path, is_ed in zip(argv[0::2], argv[1::2]):
        out.append(convert_data.parse_election_csv(path, is_ed=is_ed == '1'))
    sys.stdout.reconfigure(encoding='utf-8')
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main(sys.argv[1:])
