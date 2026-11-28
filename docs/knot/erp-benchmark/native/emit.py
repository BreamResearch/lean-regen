"""Write bounded, recoverable aggregate JSON records to a public benchmark log."""

import base64
import json
from pathlib import Path
import sys


def main():
    name, path = sys.argv[1:]
    raw = Path(path).read_bytes()
    json.loads(raw)
    if len(raw) > 192 * 1024:
        raise ValueError('Expected an aggregate report')
    for offset in range(0, len(raw), 1800):
        part = base64.b64encode(raw[offset:offset + 1800]).decode('ascii')
        print(f'KNOT_NATIVE_PART {name} {offset:06d} {part}')
    print(f'KNOT_NATIVE_END {name} {len(raw)}')


if __name__ == '__main__':
    main()
