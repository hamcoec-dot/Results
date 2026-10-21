"""
Reference-oracle bridge for the Node port's parity property tests: runs legacy Python functions
over a batch of inputs in one process.

stdin:  {"op": <op>, "inputs": [...]}
stdout: [{"ok": <result>} | {"error": "<ExceptionType>"}, ...]   (one per input, same order)

ops:
  csv                 input: base64 bytes -> read_csv_robust rows (utf-8-sig, errors=ignore, universal newlines)
  clean_num           input: str          -> convert_data.clean_num
  clean_contest_name  input: str          -> convert_data.clean_contest_name
  round2              input: float        -> repr(round(x, 2))
  float_repr          input: float        -> repr(x)
  dumps               input: any JSON     -> json.dumps(x, sort_keys=True)
  parse               input: [base64 bytes, is_ed] -> convert_data.parse_election_csv
  merge               input: [early b64 | null, ed b64 | null] -> convert_data.merge_parsed_data of both
"""
import base64
import csv
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import convert_data  # noqa: E402


def read_csv_bytes(b):
    # Same as read_csv_robust(path): open(..., encoding='utf-8-sig', errors='ignore') + csv.reader.
    return list(csv.reader(io.TextIOWrapper(io.BytesIO(b), encoding='utf-8-sig', errors='ignore')))


def parse(arg, tmp):
    data, is_ed = arg
    path = os.path.join(tmp, 'in.csv')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data))
    out = convert_data.parse_election_csv(path, is_ed=is_ed)
    if out is not None:
        out.pop('file_path')
    return out


def merge(arg, tmp):
    """[early b64 | None, ed b64 | None] -> merge_parsed_data(parse(early), parse(ed))."""
    parsed = []
    for k, (data, is_ed) in enumerate(zip(arg, (False, True))):
        if data is None:
            parsed.append(None)
            continue
        path = os.path.join(tmp, f'slot{k}.csv')
        with open(path, 'wb') as f:
            f.write(base64.b64decode(data))
        parsed.append(convert_data.parse_election_csv(path, is_ed=is_ed))
    return convert_data.merge_parsed_data(*parsed)


OPS = {
    'csv': lambda x, _: read_csv_bytes(base64.b64decode(x)),
    'clean_num': lambda x, _: convert_data.clean_num(x),
    'clean_contest_name': lambda x, _: convert_data.clean_contest_name(x),
    'round2': lambda x, _: repr(round(float(x), 2)),  # JSON sends 3.0 as 3
    'float_repr': lambda x, _: repr(float(x)),
    'dumps': lambda x, _: json.dumps(x, sort_keys=True),
    'parse': parse,
    'merge': merge,
}


def main():
    req = json.loads(sys.stdin.buffer.read().decode('utf-8'))  # not the console code page
    op = OPS[req['op']]
    out = []
    with tempfile.TemporaryDirectory(prefix='pybridge-') as tmp:
        for x in req['inputs']:
            try:
                out.append({'ok': op(x, tmp)})
            except Exception as e:  # the error type is part of the contract
                out.append({'error': type(e).__name__})
    sys.stdout.reconfigure(encoding='utf-8')
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
